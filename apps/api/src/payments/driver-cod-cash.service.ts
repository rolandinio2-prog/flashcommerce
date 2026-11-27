import { rejectCashOnDelivery } from './delivery-payment-policy';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../core/database/database.service';
import {
  type OrderPaymentStatus,
  type PaymentAttemptRow,
  type DriverCodCashCollectionInput,
  type OpenDriverCodCashSettlementInput,
  type SettleDriverCodCashSettlementInput,
  type CancelDriverCodCashSettlementInput,
  type DriverCodCashSettlementRow,
  requireSettlementUuid,
  requireSettlementCurrency,
  requireSettlementReceivedAmount,
  requireOptionalSettlementNotes,
  loadDriverCodCashSettlementItems,
  mapDriverCodCashSettlement,
  requireCashCode,
  requireAuditReference,
  requireIdempotencyToken,
  requireCashAmount,
  loadOrderForPayment,
  assertOrderCanReceivePayment,
  insertPaymentEvent,
  mapPaymentResponse,
  mapPayment,
} from './payment-shared';

/** Driver cash on delivery: the driver collects cash at the door and later hands it in to the cashier (settlements). */
@Injectable()
export class DriverCodCashService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
  ) {}

  // =====================================================
  // CONSULTA PÃšBLICA POR TRACKING TOKEN
  // =====================================================

  // =====================================================
  // SELECCIONAR EFECTIVO CONTRA ENTREGA - CLIENTE
  //
  // V1:
  // - solo para pedidos con Delivery en estado CREATED
  // - crea CASH / DRIVER_COD / AWAITING_CONFIRMATION
  // - no confirma el pedido
  // - no despacha el Delivery
  // - no registra efectivo cobrado
  // - no utiliza CASHIER_ACCESS_KEY
  // =====================================================

  async createDriverCodPayment(
    trackingToken: string,
    idempotencyKeyInput?: string,
  ) {
    rejectCashOnDelivery();
    const idempotencyToken = requireIdempotencyToken(idempotencyKeyInput);

    return this.databaseService.withTransaction(async (client) => {
      const order = await loadOrderForPayment(client, trackingToken);

      const idempotencyKey = `cod:${order.id}:${idempotencyToken}`;

      // -------------------------------------------------
      // Idempotencia fuerte:
      // una repeticion de la misma operacion puede
      // recuperar el intento aun si el flujo avanzo
      // posteriormente.
      // -------------------------------------------------

      const replayResult = await client.query<PaymentAttemptRow>(
        `
              select
                id::text,
                tenant_id::text,
                branch_id::text,
                order_id::text,
                attempt_number,
                method,
                provider,
                status,
                amount::text,
                currency,
                external_reference,
                provider_payment_id,
                provider_transaction_id,
                qr_payload,
                qr_content_type,
                qr_mime_type,
                expires_at,
                paid_at,
                verified_at,
                cash_received_amount::text,
                cash_change_amount::text,
                created_at,
                updated_at

              from public.order_payments

              where idempotency_key = $1

              limit 1

              for update
            `,
        [idempotencyKey],
      );

      const existingPayment = replayResult.rows[0] ?? null;

      if (existingPayment) {
        const sameOperation =
          existingPayment.tenant_id === order.tenant_id &&
          existingPayment.branch_id === order.branch_id &&
          existingPayment.order_id === order.id &&
          existingPayment.method === 'CASH' &&
          existingPayment.provider === 'DRIVER_COD';

        if (!sameOperation) {
          throw new ConflictException(
            'Idempotency key was already used by another payment operation',
          );
        }

        if (
          existingPayment.status !== 'AWAITING_CONFIRMATION' &&
          existingPayment.status !== 'PAID'
        ) {
          throw new ConflictException(
            `Cash on delivery cannot be replayed from ${existingPayment.status}`,
          );
        }

        return mapPaymentResponse(order, existingPayment, true);
      }

      assertOrderCanReceivePayment(order);

      // -------------------------------------------------
      // COD solamente pertenece a un pedido DELIVERY que
      // aun no entro al flujo de dispatch.
      // -------------------------------------------------

      const deliveryResult = await client.query<{
        id: string;
        status: string;
      }>(
        `
              select
                d.id::text,
                d.status

              from public.deliveries d

              where d.tenant_id = $1::uuid
                and d.branch_id = $2::uuid
                and d.order_id = $3::uuid

              limit 1

              for update of d
            `,
        [order.tenant_id, order.branch_id, order.id],
      );

      const delivery = deliveryResult.rows[0] ?? null;

      if (!delivery) {
        throw new ConflictException(
          'Cash on delivery is only available for DELIVERY orders',
        );
      }

      if (delivery.status !== 'CREATED') {
        throw new ConflictException(
          'Payment method is locked after delivery dispatch',
        );
      }

      // -------------------------------------------------
      // No hacemos switching automatico desde QR,
      // REVIEW_REQUIRED u otro intento activo.
      // Un DRIVER_COD ya activo puede reutilizarse.
      // -------------------------------------------------

      const activeResult = await client.query<PaymentAttemptRow>(
        `
              select
                id::text,
                tenant_id::text,
                branch_id::text,
                order_id::text,
                attempt_number,
                method,
                provider,
                status,
                amount::text,
                currency,
                external_reference,
                provider_payment_id,
                provider_transaction_id,
                qr_payload,
                qr_content_type,
                qr_mime_type,
                expires_at,
                paid_at,
                verified_at,
                cash_received_amount::text,
                cash_change_amount::text,
                created_at,
                updated_at

              from public.order_payments

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and order_id = $3::uuid
                and status in (
                  'CREATED',
                  'AWAITING_CONFIRMATION',
                  'REVIEW_REQUIRED'
                )

              order by attempt_number desc

              limit 1

              for update
            `,
        [order.tenant_id, order.branch_id, order.id],
      );

      const activePayment = activeResult.rows[0] ?? null;

      if (activePayment) {
        const reusableCod =
          activePayment.method === 'CASH' &&
          activePayment.provider === 'DRIVER_COD' &&
          activePayment.status === 'AWAITING_CONFIRMATION';

        if (!reusableCod) {
          throw new ConflictException(
            'Order already has another active payment selection',
          );
        }

        if (order.payment_status !== 'AWAITING_CONFIRMATION') {
          throw new ConflictException(
            'Cash on delivery payment state is inconsistent',
          );
        }

        return mapPaymentResponse(order, activePayment, true);
      }

      // -------------------------------------------------
      // Siguiente numero de intento.
      // El lock del Order serializa creaciones de pago
      // concurrentes para este pedido.
      // -------------------------------------------------

      const attemptResult = await client.query<{
        attempt_number: number;
      }>(
        `
              select
                coalesce(
                  max(attempt_number),
                  0
                )::int + 1
                  as attempt_number

              from public.order_payments

              where tenant_id = $1::uuid
                and order_id = $2::uuid
            `,
        [order.tenant_id, order.id],
      );

      const attemptNumber = attemptResult.rows[0].attempt_number;

      const externalReference = `COD-${order.order_number}-${attemptNumber}`;

      // -------------------------------------------------
      // Importante:
      // cash_received_amount y cash_change_amount quedan
      // NULL hasta el cobro autenticado por el driver.
      //
      // expires_at tambien queda NULL por contrato COD.
      // -------------------------------------------------

      const paymentResult = await client.query<PaymentAttemptRow>(
        `
              insert into public.order_payments (
                tenant_id,
                branch_id,
                order_id,
                attempt_number,
                method,
                provider,
                status,
                amount,
                currency,
                external_reference,
                idempotency_key,
                expires_at,
                paid_at,
                verified_at,
                cash_received_amount,
                cash_change_amount
              )
              values (
                $1::uuid,
                $2::uuid,
                $3::uuid,
                $4,
                'CASH',
                'DRIVER_COD',
                'AWAITING_CONFIRMATION',
                $5::numeric,
                $6,
                $7,
                $8,
                null,
                null,
                null,
                null,
                null
              )
              returning
                id::text,
                tenant_id::text,
                branch_id::text,
                order_id::text,
                attempt_number,
                method,
                provider,
                status,
                amount::text,
                currency,
                external_reference,
                provider_payment_id,
                provider_transaction_id,
                qr_payload,
                qr_content_type,
                qr_mime_type,
                expires_at,
                paid_at,
                verified_at,
                cash_received_amount::text,
                cash_change_amount::text,
                created_at,
                updated_at
            `,
        [
          order.tenant_id,
          order.branch_id,
          order.id,
          attemptNumber,
          order.total,
          order.currency,
          externalReference,
          idempotencyKey,
        ],
      );

      const payment = paymentResult.rows[0];

      if (!payment) {
        throw new ConflictException(
          'Cash on delivery payment attempt was not created',
        );
      }

      await client.query(
        `
            update public.orders

            set
              payment_status =
                'AWAITING_CONFIRMATION'

            where id = $1::uuid
              and payment_status <> 'PAID'
          `,
        [order.id],
      );

      await insertPaymentEvent(client, {
        tenantId: payment.tenant_id,
        branchId: payment.branch_id,
        paymentId: payment.id,
        eventType: 'DRIVER_COD_SELECTED',
        source: 'SYSTEM',
        processingStatus: 'PROCESSED',
        payload: {
          provider: payment.provider,
          externalReference: payment.external_reference,
          amount: payment.amount,
          currency: payment.currency,
        },
      });

      return mapPaymentResponse(
        {
          ...order,
          payment_status: 'AWAITING_CONFIRMATION',
        },
        payment,
        false,
      );
    });
  }

  // =====================================================
  // CONFIRMACIÃ“N DE EFECTIVO - SOLO CAJA PRESENCIAL
  // =====================================================

  async collectDriverCodCash(
    client: PoolClient,
    input: DriverCodCashCollectionInput,
  ) {
    // Cash on delivery is enabled only for courier requests (FlashCommerce Delivery);
    // store delivery orders stay prepaid-QR only.
    const origin = await client.query<{ order_origin: string }>(
      'select order_origin from public.orders where tenant_id=$1::uuid and branch_id=$2::uuid and id=$3::uuid',
      [input.tenantId, input.branchId, input.orderId],
    );
    if (origin.rows[0]?.order_origin !== 'COURIER_REQUEST')
      rejectCashOnDelivery();
    const cashReceivedAmount = requireCashAmount(input.cashReceivedAmount);

    const idempotencyToken = requireIdempotencyToken(input.idempotencyKey);

    const idempotencyKey = `driver-cod-collection:${input.deliveryId}:${idempotencyToken}`;

    const orderResult = await client.query<{
      payment_status: OrderPaymentStatus;
      total: string;
      currency: string;
    }>(
      `
          select
            o.payment_status,
            o.total::text,
            o.currency

          from public.orders o

          where o.tenant_id = $1::uuid
            and o.branch_id = $2::uuid
            and o.id = $3::uuid

          for update of o
        `,
      [input.tenantId, input.branchId, input.orderId],
    );

    const order = orderResult.rows[0];

    if (!order) {
      throw new NotFoundException('Order not found for driver cash collection');
    }

    const replayResult = await client.query<{
      id: string;
      tenant_id: string;
      branch_id: string;
      order_id: string;
      delivery_id: string;
      assignment_id: string;
      driver_id: string;
      payment_id: string;
      amount: string;
      currency: string;
      cash_received_amount: string;
      cash_change_amount: string;
      idempotency_key: string;
      collected_at: string | Date;
      received_amount_matches: boolean;
    }>(
      `
          select
            c.id::text,
            c.tenant_id::text,
            c.branch_id::text,
            c.order_id::text,
            c.delivery_id::text,
            c.assignment_id::text,
            c.driver_id::text,
            c.payment_id::text,
            c.amount::text,
            c.currency,
            c.cash_received_amount::text,
            c.cash_change_amount::text,
            c.idempotency_key,
            c.collected_at,

            c.cash_received_amount =
              $2::numeric
              as received_amount_matches

          from public.delivery_cash_collections c

          where c.idempotency_key = $1

          limit 1

          for update of c
        `,
      [idempotencyKey, cashReceivedAmount],
    );

    const replay = replayResult.rows[0] ?? null;

    if (replay) {
      const sameOperation =
        replay.tenant_id === input.tenantId &&
        replay.branch_id === input.branchId &&
        replay.order_id === input.orderId &&
        replay.delivery_id === input.deliveryId &&
        replay.assignment_id === input.assignmentId &&
        replay.driver_id === input.driverId &&
        replay.received_amount_matches;

      if (!sameOperation) {
        throw new ConflictException(
          'Idempotency key was already used by another driver cash collection',
        );
      }

      const paymentReplayResult = await client.query<PaymentAttemptRow>(
        `
            select
              p.id::text,
              p.tenant_id::text,
              p.branch_id::text,
              p.order_id::text,
              p.attempt_number,
              p.method,
              p.provider,
              p.status,
              p.amount::text,
              p.currency,
              p.external_reference,
              p.provider_payment_id,
              p.provider_transaction_id,
              p.qr_payload,
              p.qr_content_type,
              p.qr_mime_type,
              p.expires_at,
              p.paid_at,
              p.verified_at,
              p.cash_received_amount::text,
              p.cash_change_amount::text,
              p.created_at,
              p.updated_at

            from public.order_payments p

            where p.tenant_id = $1::uuid
              and p.branch_id = $2::uuid
              and p.id = $3::uuid
              and p.order_id = $4::uuid

            limit 1

            for update of p
          `,
        [input.tenantId, input.branchId, replay.payment_id, input.orderId],
      );

      const payment = paymentReplayResult.rows[0];

      if (
        !payment ||
        payment.method !== 'CASH' ||
        payment.provider !== 'DRIVER_COD' ||
        payment.status !== 'PAID' ||
        payment.cash_received_amount !== replay.cash_received_amount ||
        payment.cash_change_amount !== replay.cash_change_amount ||
        payment.amount !== replay.amount ||
        payment.currency !== replay.currency ||
        order.payment_status !== 'PAID'
      ) {
        throw new ConflictException(
          'Driver cash collection replay state is inconsistent',
        );
      }

      return {
        changed: false,

        payment: mapPayment(payment),

        collection: {
          id: replay.id,

          amount: Number(replay.amount),

          currency: replay.currency,

          cashReceivedAmount: Number(replay.cash_received_amount),

          cashChangeAmount: Number(replay.cash_change_amount),

          collectedAt: replay.collected_at,
        },
      };
    }

    const paymentResult = await client.query<PaymentAttemptRow>(
      `
          select
            p.id::text,
            p.tenant_id::text,
            p.branch_id::text,
            p.order_id::text,
            p.attempt_number,
            p.method,
            p.provider,
            p.status,
            p.amount::text,
            p.currency,
            p.external_reference,
            p.provider_payment_id,
            p.provider_transaction_id,
            p.qr_payload,
            p.qr_content_type,
            p.qr_mime_type,
            p.expires_at,
            p.paid_at,
            p.verified_at,
            p.cash_received_amount::text,
            p.cash_change_amount::text,
            p.created_at,
            p.updated_at

          from public.order_payments p

          where p.tenant_id = $1::uuid
            and p.branch_id = $2::uuid
            and p.order_id = $3::uuid
            and p.method = 'CASH'
            and p.provider = 'DRIVER_COD'
            and p.status in (
              'AWAITING_CONFIRMATION',
              'PAID'
            )

          order by
            case
              when p.status =
                'AWAITING_CONFIRMATION'
                then 0
              else 1
            end,
            p.attempt_number desc

          limit 1

          for update of p
        `,
      [input.tenantId, input.branchId, input.orderId],
    );

    const payment = paymentResult.rows[0];

    if (!payment) {
      throw new ConflictException(
        'Explicit cash-on-delivery payment is not available',
      );
    }

    if (payment.amount !== order.total || payment.currency !== order.currency) {
      throw new ConflictException(
        'Cash-on-delivery amount or currency does not match the order',
      );
    }

    const existingCollectionResult = await client.query<{
      id: string;
      idempotency_key: string;
    }>(
      `
          select
            c.id::text,
            c.idempotency_key

          from public.delivery_cash_collections c

          where c.tenant_id = $1::uuid
            and c.branch_id = $2::uuid
            and (
              c.delivery_id = $3::uuid
              or c.payment_id = $4::uuid
            )

          limit 1

          for update of c
        `,
      [input.tenantId, input.branchId, input.deliveryId, payment.id],
    );

    const existingCollection = existingCollectionResult.rows[0] ?? null;

    if (existingCollection) {
      throw new ConflictException(
        'Cash has already been collected using another idempotency key',
      );
    }

    if (payment.status === 'PAID') {
      throw new ConflictException(
        'Paid DRIVER_COD has no matching cash collection',
      );
    }

    if (order.payment_status !== 'AWAITING_CONFIRMATION') {
      throw new ConflictException(
        `Order cannot collect driver cash from ${order.payment_status}`,
      );
    }

    const coverageResult = await client.query<{
      sufficient: boolean;
    }>(
      `
          select
            $1::numeric >=
            $2::numeric
              as sufficient
        `,
      [cashReceivedAmount, payment.amount],
    );

    if (!coverageResult.rows[0]?.sufficient) {
      throw new BadRequestException(
        'Cash received amount is lower than the order total',
      );
    }

    const paidPaymentResult = await client.query<PaymentAttemptRow>(
      `
          update public.order_payments

          set
            status = 'PAID',
            paid_at = now(),
            verified_at = now(),
            cash_received_amount =
              $5::numeric,
            cash_change_amount =
              $5::numeric - amount,
            updated_at = now()

          where tenant_id = $1::uuid
            and branch_id = $2::uuid
            and id = $3::uuid
            and order_id = $4::uuid
            and method = 'CASH'
            and provider = 'DRIVER_COD'
            and status =
              'AWAITING_CONFIRMATION'

          returning
            id::text,
            tenant_id::text,
            branch_id::text,
            order_id::text,
            attempt_number,
            method,
            provider,
            status,
            amount::text,
            currency,
            external_reference,
            provider_payment_id,
            provider_transaction_id,
            qr_payload,
            qr_content_type,
            qr_mime_type,
            expires_at,
            paid_at,
            verified_at,
            cash_received_amount::text,
            cash_change_amount::text,
            created_at,
            updated_at
        `,
      [
        input.tenantId,
        input.branchId,
        payment.id,
        input.orderId,
        cashReceivedAmount,
      ],
    );

    const paidPayment = paidPaymentResult.rows[0];

    if (!paidPayment) {
      throw new ConflictException(
        'Cash-on-delivery payment changed concurrently',
      );
    }

    const orderUpdate = await client.query<{
      payment_status: OrderPaymentStatus;
    }>(
      `
          update public.orders

          set
            payment_status = 'PAID',
            updated_at = now()

          where tenant_id = $1::uuid
            and branch_id = $2::uuid
            and id = $3::uuid
            and payment_status =
              'AWAITING_CONFIRMATION'

          returning
            payment_status
        `,
      [input.tenantId, input.branchId, input.orderId],
    );

    if (!orderUpdate.rows[0]) {
      throw new ConflictException('Order payment state changed concurrently');
    }

    const collectionResult = await client.query<{
      id: string;
      amount: string;
      currency: string;
      cash_received_amount: string;
      cash_change_amount: string;
      collected_at: string | Date;
    }>(
      `
          insert into public.delivery_cash_collections (
            tenant_id,
            branch_id,
            order_id,
            delivery_id,
            assignment_id,
            driver_id,
            payment_id,
            amount,
            currency,
            cash_received_amount,
            cash_change_amount,
            idempotency_key
          )
          values (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5::uuid,
            $6::uuid,
            $7::uuid,
            $8::numeric,
            $9,
            $10::numeric,
            $10::numeric -
              $8::numeric,
            $11
          )
          returning
            id::text,
            amount::text,
            currency,
            cash_received_amount::text,
            cash_change_amount::text,
            collected_at
        `,
      [
        input.tenantId,
        input.branchId,
        input.orderId,
        input.deliveryId,
        input.assignmentId,
        input.driverId,
        paidPayment.id,
        paidPayment.amount,
        paidPayment.currency,
        cashReceivedAmount,
        idempotencyKey,
      ],
    );

    const collection = collectionResult.rows[0];

    if (!collection) {
      throw new ConflictException('Driver cash collection was not created');
    }

    await insertPaymentEvent(client, {
      tenantId: paidPayment.tenant_id,

      branchId: paidPayment.branch_id,

      paymentId: paidPayment.id,

      eventType: 'DRIVER_COD_CASH_COLLECTED',

      providerEventId: collection.id,

      source: 'DRIVER',

      processingStatus: 'PROCESSED',

      payload: {
        deliveryId: input.deliveryId,

        assignmentId: input.assignmentId,

        driverId: input.driverId,

        amount: paidPayment.amount,

        currency: paidPayment.currency,

        cashReceivedAmount: paidPayment.cash_received_amount,

        cashChangeAmount: paidPayment.cash_change_amount,

        collectionId: collection.id,
      },
    });

    return {
      changed: true,

      payment: mapPayment(paidPayment),

      collection: {
        id: collection.id,

        amount: Number(collection.amount),

        currency: collection.currency,

        cashReceivedAmount: Number(collection.cash_received_amount),

        cashChangeAmount: Number(collection.cash_change_amount),

        collectedAt: collection.collected_at,
      },
    };
  }

  // =====================================================
  // FLASHDELIVERY COD - ABRIR LIQUIDACION DE EFECTIVO
  // =====================================================

  async openDriverCodCashSettlement(input: OpenDriverCodCashSettlementInput) {
    this.assertCashierAccessKey(input.cashierAccessKey);

    const tenantCode = requireCashCode(input.tenantCode, 'tenantCode');

    const branchCode = requireCashCode(input.branchCode, 'branchCode');

    const driverId = requireSettlementUuid(input.driverId, 'driverId');

    const currency = requireSettlementCurrency(input.currency);

    const cashierReference = requireAuditReference(
      input.cashierReference,
      'cashierReference',
    );

    const notes = requireOptionalSettlementNotes(input.notes);

    const idempotencyToken = requireIdempotencyToken(input.idempotencyKey);

    const storedIdempotencyKey = `driver-cod-settlement-open:${idempotencyToken}`;

    return this.databaseService.withTransaction(async (client) => {
      await client.query(
        `
            select pg_advisory_xact_lock(
              hashtextextended($1, 0)
            )
          `,
        [storedIdempotencyKey],
      );

      const scopeResult = await client.query<{
        tenant_id: string;
        branch_id: string;
      }>(
        `
            select
              t.id::text as tenant_id,
              b.id::text as branch_id

            from public.tenants t

            inner join public.branches b
              on b.tenant_id = t.id

            where t.code = $1
              and b.code = $2

            limit 1
          `,
        [tenantCode, branchCode],
      );

      const scope = scopeResult.rows[0];

      if (!scope) {
        throw new NotFoundException('Tenant/branch payment scope not found');
      }

      const driverBranchResult = await client.query<{
        driver_id: string;
        status: string;
      }>(
        `
            select
              db.driver_id::text,
              db.status

            from public.delivery_driver_branches db

            where db.tenant_id = $1::uuid
              and db.branch_id = $2::uuid
              and db.driver_id = $3::uuid

            for update
          `,
        [scope.tenant_id, scope.branch_id, driverId],
      );

      if (!driverBranchResult.rows[0]) {
        throw new NotFoundException('Driver is not assigned to this branch');
      }

      const existingByKeyResult =
        await client.query<DriverCodCashSettlementRow>(
          `
              select
                id::text,
                tenant_id::text,
                branch_id::text,
                driver_id::text,
                status,
                currency,
                expected_amount::text,
                received_amount::text,
                difference_amount::text,
                idempotency_key,
                opened_at,
                settled_at,
                cancelled_at,
                notes,
                created_at,
                updated_at

              from public.delivery_cash_settlements

              where idempotency_key = $1

              for update
            `,
          [storedIdempotencyKey],
        );

      const existingByKey = existingByKeyResult.rows[0];

      if (existingByKey) {
        const sameRequest =
          existingByKey.tenant_id === scope.tenant_id &&
          existingByKey.branch_id === scope.branch_id &&
          existingByKey.driver_id === driverId &&
          existingByKey.currency === currency &&
          (existingByKey.notes ?? '') === (notes ?? '');

        if (!sameRequest) {
          throw new ConflictException(
            'Idempotency-Key was already used for another cash settlement request',
          );
        }

        const eventKey = `driver-cod-settlement-open:${existingByKey.id}:${idempotencyToken}`;

        const replayEventResult = await client.query<{
          event_count: string;
          reference_count: string;
        }>(
          `
                select
                  count(*)::text as event_count,

                  count(*) filter (
                    where pe.payload ->> 'cashierReference' = $5
                  )::text as reference_count

                from public.payment_events pe

                where pe.tenant_id = $1::uuid
                  and pe.branch_id = $2::uuid
                  and pe.provider_event_id = $3
                  and pe.event_type =
                    'DRIVER_COD_CASH_SETTLEMENT_OPENED'
                  and pe.source = 'RECONCILIATION'
                  and pe.processing_status = 'PROCESSED'
                  and pe.payload ->> 'settlementId' = $4
              `,
          [
            scope.tenant_id,
            scope.branch_id,
            eventKey,
            existingByKey.id,
            cashierReference,
          ],
        );

        const replayEvent = replayEventResult.rows[0];

        const eventCount = Number(replayEvent?.event_count ?? 0);

        const referenceCount = Number(replayEvent?.reference_count ?? 0);

        if (eventCount <= 0 || referenceCount !== eventCount) {
          throw new ConflictException(
            'Stored cash settlement idempotency state is inconsistent',
          );
        }

        const currentItems = await loadDriverCodCashSettlementItems(
          client,
          existingByKey.id,
        );

        if (
          existingByKey.status !== 'CANCELLED' &&
          currentItems.length !== eventCount
        ) {
          throw new ConflictException(
            'Stored cash settlement snapshot is inconsistent',
          );
        }

        return {
          changed: false,
          action: 'UNCHANGED' as const,

          settlement: mapDriverCodCashSettlement(
            existingByKey,
            currentItems.length,
            eventCount,
          ),
        };
      }

      const openResult = await client.query<{
        id: string;
      }>(
        `
              select
                id::text

              from public.delivery_cash_settlements

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and driver_id = $3::uuid
                and currency = $4
                and status = 'OPEN'

              limit 1

              for update
            `,
        [scope.tenant_id, scope.branch_id, driverId, currency],
      );

      if (openResult.rows[0]) {
        throw new ConflictException(
          'Driver already has an open cash settlement for this currency',
        );
      }

      const collectionsResult = await client.query<{
        id: string;
        payment_id: string;
        amount: string;
        currency: string;
        collected_at: string | Date;
      }>(
        `
              select
                c.id::text,
                c.payment_id::text,
                c.amount::text,
                c.currency,
                c.collected_at

              from public.delivery_cash_collections c

              inner join public.order_payments p
                on p.tenant_id = c.tenant_id
               and p.branch_id = c.branch_id
               and p.id = c.payment_id

              left join public.delivery_cash_settlement_items si
                on si.tenant_id = c.tenant_id
               and si.branch_id = c.branch_id
               and si.collection_id = c.id

              where c.tenant_id = $1::uuid
                and c.branch_id = $2::uuid
                and c.driver_id = $3::uuid
                and c.currency = $4
                and si.id is null

                and p.method = 'CASH'
                and p.provider = 'DRIVER_COD'
                and p.status = 'PAID'

              order by
                c.collected_at,
                c.id

              for update of c
            `,
        [scope.tenant_id, scope.branch_id, driverId, currency],
      );

      const collections = collectionsResult.rows;

      if (collections.length === 0) {
        throw new ConflictException(
          'Driver has no unsettled COD cash collections for this currency',
        );
      }

      const collectionIds = collections.map((collection) => collection.id);

      const totalResult = await client.query<{
        expected_amount: string;
      }>(
        `
              select
                coalesce(
                  sum(c.amount),
                  0
                )::text as expected_amount

              from public.delivery_cash_collections c

              where c.tenant_id = $1::uuid
                and c.branch_id = $2::uuid
                and c.id = any($3::uuid[])
            `,
        [scope.tenant_id, scope.branch_id, collectionIds],
      );

      const expectedAmount = totalResult.rows[0]?.expected_amount;

      if (!expectedAmount || Number(expectedAmount) <= 0) {
        throw new ConflictException(
          'Cash settlement expected amount is invalid',
        );
      }

      const settlementResult = await client.query<DriverCodCashSettlementRow>(
        `
              insert into public.delivery_cash_settlements (
                tenant_id,
                branch_id,
                driver_id,
                status,
                currency,
                expected_amount,
                idempotency_key,
                notes
              )
              values (
                $1::uuid,
                $2::uuid,
                $3::uuid,
                'OPEN',
                $4,
                $5::numeric,
                $6,
                $7
              )
              returning
                id::text,
                tenant_id::text,
                branch_id::text,
                driver_id::text,
                status,
                currency,
                expected_amount::text,
                received_amount::text,
                difference_amount::text,
                idempotency_key,
                opened_at,
                settled_at,
                cancelled_at,
                notes,
                created_at,
                updated_at
            `,
        [
          scope.tenant_id,
          scope.branch_id,
          driverId,
          currency,
          expectedAmount,
          storedIdempotencyKey,
          notes,
        ],
      );

      const settlement = settlementResult.rows[0];

      if (!settlement) {
        throw new ConflictException('Cash settlement was not created');
      }

      const itemsResult = await client.query(
        `
              insert into public.delivery_cash_settlement_items (
                tenant_id,
                branch_id,
                settlement_id,
                collection_id,
                driver_id,
                amount,
                currency
              )

              select
                c.tenant_id,
                c.branch_id,
                $3::uuid,
                c.id,
                c.driver_id,
                c.amount,
                c.currency

              from public.delivery_cash_collections c

              where c.tenant_id = $1::uuid
                and c.branch_id = $2::uuid
                and c.id = any($4::uuid[])
            `,
        [scope.tenant_id, scope.branch_id, settlement.id, collectionIds],
      );

      if ((itemsResult.rowCount ?? 0) !== collections.length) {
        throw new ConflictException(
          'Cash settlement snapshot was not created completely',
        );
      }

      const eventKey = `driver-cod-settlement-open:${settlement.id}:${idempotencyToken}`;

      for (const collection of collections) {
        await insertPaymentEvent(client, {
          tenantId: scope.tenant_id,
          branchId: scope.branch_id,
          paymentId: collection.payment_id,
          eventType: 'DRIVER_COD_CASH_SETTLEMENT_OPENED',
          providerEventId: eventKey,
          source: 'RECONCILIATION',
          processingStatus: 'PROCESSED',
          payload: {
            settlementId: settlement.id,
            driverId,
            collectionId: collection.id,
            amount: Number(collection.amount),
            currency,
            expectedAmount: Number(expectedAmount),
            cashierReference,
            snapshotItemCount: collections.length,
          },
        });
      }

      return {
        changed: true,
        action: 'SETTLEMENT_OPENED' as const,

        settlement: mapDriverCodCashSettlement(
          settlement,
          collections.length,
          collections.length,
        ),
      };
    });
  }

  // =====================================================
  // FLASHDELIVERY COD - CERRAR LIQUIDACION
  // =====================================================

  async settleDriverCodCashSettlement(
    settlementId: string,
    input: SettleDriverCodCashSettlementInput,
  ) {
    this.assertCashierAccessKey(input.cashierAccessKey);

    const tenantCode = requireCashCode(input.tenantCode, 'tenantCode');

    const branchCode = requireCashCode(input.branchCode, 'branchCode');

    const receivedAmount = requireSettlementReceivedAmount(
      input.receivedAmount,
    );

    const cashierReference = requireAuditReference(
      input.cashierReference,
      'cashierReference',
    );

    const idempotencyToken = requireIdempotencyToken(input.idempotencyKey);

    const eventKey = `driver-cod-settlement-settle:${settlementId}:${idempotencyToken}`;

    return this.databaseService.withTransaction(async (client) => {
      await client.query(
        `
            select pg_advisory_xact_lock(
              hashtextextended($1, 0)
            )
          `,
        [eventKey],
      );

      const scopeResult = await client.query<{
        tenant_id: string;
        branch_id: string;
      }>(
        `
            select
              t.id::text as tenant_id,
              b.id::text as branch_id

            from public.tenants t

            inner join public.branches b
              on b.tenant_id = t.id

            where t.code = $1
              and b.code = $2

            limit 1
          `,
        [tenantCode, branchCode],
      );

      const scope = scopeResult.rows[0];

      if (!scope) {
        throw new NotFoundException('Tenant/branch payment scope not found');
      }

      const settlementResult = await client.query<DriverCodCashSettlementRow>(
        `
              select
                id::text,
                tenant_id::text,
                branch_id::text,
                driver_id::text,
                status,
                currency,
                expected_amount::text,
                received_amount::text,
                difference_amount::text,
                idempotency_key,
                opened_at,
                settled_at,
                cancelled_at,
                notes,
                created_at,
                updated_at

              from public.delivery_cash_settlements

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid

              for update
            `,
        [scope.tenant_id, scope.branch_id, settlementId],
      );

      const settlement = settlementResult.rows[0];

      if (!settlement) {
        throw new NotFoundException('Cash settlement not found');
      }

      const items = await loadDriverCodCashSettlementItems(
        client,
        settlement.id,
      );

      if (settlement.status === 'SETTLED') {
        const replayEventResult = await client.query<{
          event_count: string;
          reference_count: string;
        }>(
          `
                select
                  count(*)::text as event_count,

                  count(*) filter (
                    where pe.payload ->> 'cashierReference' = $5
                  )::text as reference_count

                from public.payment_events pe

                where pe.tenant_id = $1::uuid
                  and pe.branch_id = $2::uuid
                  and pe.provider_event_id = $3
                  and pe.event_type =
                    'DRIVER_COD_CASH_SETTLEMENT_SETTLED'
                  and pe.source = 'RECONCILIATION'
                  and pe.processing_status = 'PROCESSED'
                  and pe.payload ->> 'settlementId' = $4
              `,
          [
            scope.tenant_id,
            scope.branch_id,
            eventKey,
            settlement.id,
            cashierReference,
          ],
        );

        const replayEvent = replayEventResult.rows[0];

        const eventCount = Number(replayEvent?.event_count ?? 0);

        const referenceCount = Number(replayEvent?.reference_count ?? 0);

        const sameAmount =
          settlement.received_amount !== null &&
          Number(settlement.received_amount) === Number(receivedAmount);

        if (
          sameAmount &&
          items.length > 0 &&
          eventCount === items.length &&
          referenceCount === eventCount
        ) {
          return {
            changed: false,
            action: 'UNCHANGED' as const,

            settlement: mapDriverCodCashSettlement(
              settlement,
              items.length,
              items.length,
            ),
          };
        }

        throw new ConflictException('Cash settlement has already been settled');
      }

      if (settlement.status === 'CANCELLED') {
        throw new ConflictException(
          'Cancelled cash settlement cannot be settled',
        );
      }

      if (items.length === 0) {
        throw new ConflictException(
          'Open cash settlement has no snapshot items',
        );
      }

      const itemTotalResult = await client.query<{
        item_total: string;
      }>(
        `
              select
                coalesce(
                  sum(si.amount),
                  0
                )::text as item_total

              from public.delivery_cash_settlement_items si

              where si.tenant_id = $1::uuid
                and si.branch_id = $2::uuid
                and si.settlement_id = $3::uuid
            `,
        [scope.tenant_id, scope.branch_id, settlement.id],
      );

      const itemTotal = itemTotalResult.rows[0]?.item_total ?? '0';

      if (Number(itemTotal) !== Number(settlement.expected_amount)) {
        throw new ConflictException(
          'Cash settlement expected amount does not match its snapshot',
        );
      }

      const updatedResult = await client.query<DriverCodCashSettlementRow>(
        `
              update public.delivery_cash_settlements

              set
                status = 'SETTLED',
                received_amount = $4::numeric,
                difference_amount =
                  $4::numeric - expected_amount,
                settled_at = now(),
                cancelled_at = null,
                updated_at = now()

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid
                and status = 'OPEN'

              returning
                id::text,
                tenant_id::text,
                branch_id::text,
                driver_id::text,
                status,
                currency,
                expected_amount::text,
                received_amount::text,
                difference_amount::text,
                idempotency_key,
                opened_at,
                settled_at,
                cancelled_at,
                notes,
                created_at,
                updated_at
            `,
        [scope.tenant_id, scope.branch_id, settlement.id, receivedAmount],
      );

      const updated = updatedResult.rows[0];

      if (!updated) {
        throw new ConflictException('Cash settlement could not be settled');
      }

      for (const item of items) {
        await insertPaymentEvent(client, {
          tenantId: scope.tenant_id,
          branchId: scope.branch_id,
          paymentId: item.payment_id,
          eventType: 'DRIVER_COD_CASH_SETTLEMENT_SETTLED',
          providerEventId: eventKey,
          source: 'RECONCILIATION',
          processingStatus: 'PROCESSED',
          payload: {
            settlementId: updated.id,
            driverId: updated.driver_id,
            collectionId: item.collection_id,
            amount: Number(item.amount),
            currency: updated.currency,
            expectedAmount: Number(updated.expected_amount),
            receivedAmount: Number(updated.received_amount),
            differenceAmount: Number(updated.difference_amount),
            cashierReference,
          },
        });
      }

      return {
        changed: true,
        action: 'SETTLEMENT_SETTLED' as const,

        settlement: mapDriverCodCashSettlement(
          updated,
          items.length,
          items.length,
        ),
      };
    });
  }

  // =====================================================
  // FLASHDELIVERY COD - CANCELAR LIQUIDACION ABIERTA
  // =====================================================

  async cancelDriverCodCashSettlement(
    settlementId: string,
    input: CancelDriverCodCashSettlementInput,
  ) {
    this.assertCashierAccessKey(input.cashierAccessKey);

    const tenantCode = requireCashCode(input.tenantCode, 'tenantCode');

    const branchCode = requireCashCode(input.branchCode, 'branchCode');

    const cashierReference = requireAuditReference(
      input.cashierReference,
      'cashierReference',
    );

    const idempotencyToken = requireIdempotencyToken(input.idempotencyKey);

    const eventKey = `driver-cod-settlement-cancel:${settlementId}:${idempotencyToken}`;

    return this.databaseService.withTransaction(async (client) => {
      await client.query(
        `
            select pg_advisory_xact_lock(
              hashtextextended($1, 0)
            )
          `,
        [eventKey],
      );

      const scopeResult = await client.query<{
        tenant_id: string;
        branch_id: string;
      }>(
        `
            select
              t.id::text as tenant_id,
              b.id::text as branch_id

            from public.tenants t

            inner join public.branches b
              on b.tenant_id = t.id

            where t.code = $1
              and b.code = $2

            limit 1
          `,
        [tenantCode, branchCode],
      );

      const scope = scopeResult.rows[0];

      if (!scope) {
        throw new NotFoundException('Tenant/branch payment scope not found');
      }

      const settlementResult = await client.query<DriverCodCashSettlementRow>(
        `
              select
                id::text,
                tenant_id::text,
                branch_id::text,
                driver_id::text,
                status,
                currency,
                expected_amount::text,
                received_amount::text,
                difference_amount::text,
                idempotency_key,
                opened_at,
                settled_at,
                cancelled_at,
                notes,
                created_at,
                updated_at

              from public.delivery_cash_settlements

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid

              for update
            `,
        [scope.tenant_id, scope.branch_id, settlementId],
      );

      const settlement = settlementResult.rows[0];

      if (!settlement) {
        throw new NotFoundException('Cash settlement not found');
      }

      if (settlement.status === 'CANCELLED') {
        const replayEventResult = await client.query<{
          event_count: string;
          reference_count: string;
        }>(
          `
                select
                  count(*)::text as event_count,

                  count(*) filter (
                    where pe.payload ->> 'cashierReference' = $5
                  )::text as reference_count

                from public.payment_events pe

                where pe.tenant_id = $1::uuid
                  and pe.branch_id = $2::uuid
                  and pe.provider_event_id = $3
                  and pe.event_type =
                    'DRIVER_COD_CASH_SETTLEMENT_CANCELLED'
                  and pe.source = 'RECONCILIATION'
                  and pe.processing_status = 'PROCESSED'
                  and pe.payload ->> 'settlementId' = $4
              `,
          [
            scope.tenant_id,
            scope.branch_id,
            eventKey,
            settlement.id,
            cashierReference,
          ],
        );

        const replayEvent = replayEventResult.rows[0];

        const eventCount = Number(replayEvent?.event_count ?? 0);

        const referenceCount = Number(replayEvent?.reference_count ?? 0);

        if (eventCount > 0 && referenceCount === eventCount) {
          return {
            changed: false,
            action: 'UNCHANGED' as const,
            releasedItemCount: eventCount,

            settlement: mapDriverCodCashSettlement(settlement, 0, eventCount),
          };
        }

        throw new ConflictException(
          'Cash settlement has already been cancelled',
        );
      }

      if (settlement.status === 'SETTLED') {
        throw new ConflictException(
          'Settled cash settlement cannot be cancelled',
        );
      }

      const items = await loadDriverCodCashSettlementItems(
        client,
        settlement.id,
      );

      if (items.length === 0) {
        throw new ConflictException(
          'Open cash settlement has no snapshot items',
        );
      }

      for (const item of items) {
        await insertPaymentEvent(client, {
          tenantId: scope.tenant_id,
          branchId: scope.branch_id,
          paymentId: item.payment_id,
          eventType: 'DRIVER_COD_CASH_SETTLEMENT_CANCELLED',
          providerEventId: eventKey,
          source: 'RECONCILIATION',
          processingStatus: 'PROCESSED',
          payload: {
            settlementId: settlement.id,
            driverId: settlement.driver_id,
            collectionId: item.collection_id,
            amount: Number(item.amount),
            currency: settlement.currency,
            expectedAmount: Number(settlement.expected_amount),
            cashierReference,
          },
        });
      }

      const deleteItemsResult = await client.query(
        `
              delete from public.delivery_cash_settlement_items

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and settlement_id = $3::uuid
            `,
        [scope.tenant_id, scope.branch_id, settlement.id],
      );

      if ((deleteItemsResult.rowCount ?? 0) !== items.length) {
        throw new ConflictException(
          'Cash settlement items were not released completely',
        );
      }

      const updatedResult = await client.query<DriverCodCashSettlementRow>(
        `
              update public.delivery_cash_settlements

              set
                status = 'CANCELLED',
                received_amount = null,
                difference_amount = null,
                settled_at = null,
                cancelled_at = now(),
                updated_at = now()

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid
                and status = 'OPEN'

              returning
                id::text,
                tenant_id::text,
                branch_id::text,
                driver_id::text,
                status,
                currency,
                expected_amount::text,
                received_amount::text,
                difference_amount::text,
                idempotency_key,
                opened_at,
                settled_at,
                cancelled_at,
                notes,
                created_at,
                updated_at
            `,
        [scope.tenant_id, scope.branch_id, settlement.id],
      );

      const updated = updatedResult.rows[0];

      if (!updated) {
        throw new ConflictException('Cash settlement could not be cancelled');
      }

      return {
        changed: true,
        action: 'SETTLEMENT_CANCELLED' as const,
        releasedItemCount: items.length,

        settlement: mapDriverCodCashSettlement(updated, 0, items.length),
      };
    });
  }

  private assertCashierAccessKey(providedKey?: string): void {
    const configuredKey =
      this.configService.get<string>('CASHIER_ACCESS_KEY')?.trim() || '';

    if (configuredKey.length < 48) {
      throw new ServiceUnavailableException(
        'Cashier payment access is not configured',
      );
    }

    const receivedKey = providedKey?.trim() || '';
    const configuredBuffer = Buffer.from(configuredKey, 'utf8');
    const receivedBuffer = Buffer.from(receivedKey, 'utf8');

    const validKey =
      configuredBuffer.length === receivedBuffer.length &&
      timingSafeEqual(configuredBuffer, receivedBuffer);

    if (!validKey) {
      throw new UnauthorizedException('Invalid cashier credentials');
    }
  }
}
