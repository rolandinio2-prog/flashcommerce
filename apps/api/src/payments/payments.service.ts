import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';
import { BcpQrProvider } from './bcp-qr.provider';
import { MockQrProvider } from './mock-qr.provider';
import type {
  PaymentProvider,
  ProviderQrContentType,
  ProviderQrMimeType,
} from './payment-provider';

type OrderStatus =
  'PENDING' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED';

type OrderPaymentStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'AWAITING_CONFIRMATION'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'REVIEW_REQUIRED';

type OrderOrigin =
  | 'LEGACY'
  | 'PUBLIC_MENU'
  | 'TABLE_QR'
  | 'BRANCH_QR'
  | 'OPS_STAFF'
  | 'RESERVATION_PREORDER'
  | 'RESERVATION_CHECKIN';

type PaymentAttemptStatus =
  | 'CREATED'
  | 'AWAITING_CONFIRMATION'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'REVIEW_REQUIRED';

interface PaymentOrderRow {
  id: string;
  order_number: string;
  tracking_token: string;
  tenant_id: string;
  branch_id: string;
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  order_origin: OrderOrigin;
  total: string;
  currency: string;
  reservation_id: string | null;
  reservation_status: string | null;
}

interface PaymentAttemptRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  order_id: string;
  attempt_number: number;
  method: 'QR' | 'CASH';
  provider: string;
  status: PaymentAttemptStatus;
  amount: string;
  currency: string;
  external_reference: string | null;
  provider_payment_id: string | null;
  provider_transaction_id: string | null;
  qr_payload: string | null;
  qr_content_type: ProviderQrContentType | null;
  qr_mime_type: ProviderQrMimeType | null;
  expires_at: string | Date | null;
  paid_at: string | Date | null;
  verified_at: string | Date | null;
  cash_received_amount?: string | null;
  cash_change_amount?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface PaymentTrackingRow extends PaymentOrderRow {
  payment_id: string | null;
  payment_attempt_number: number | null;
  payment_method: 'QR' | 'CASH' | null;
  payment_provider: string | null;
  payment_attempt_status: PaymentAttemptStatus | null;
  payment_amount: string | null;
  payment_currency: string | null;
  payment_external_reference: string | null;
  payment_provider_payment_id: string | null;
  payment_provider_transaction_id: string | null;
  payment_qr_payload: string | null;
  payment_qr_content_type: ProviderQrContentType | null;
  payment_qr_mime_type: ProviderQrMimeType | null;
  payment_expires_at: string | Date | null;
  payment_paid_at: string | Date | null;
  payment_verified_at: string | Date | null;
  payment_created_at: string | Date | null;
  payment_updated_at: string | Date | null;
}

interface ConfirmCashPaymentInput {
  tenantCode?: string;
  branchCode?: string;
  cashReceivedAmount?: string | number;
  cashierReference?: string;
  terminalReference?: string;
  idempotencyKey?: string;
  cashierAccessKey?: string;
}
interface PreparedQrPayment {
  order: PaymentOrderRow;
  payment: PaymentAttemptRow;
  shouldGenerate: boolean;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    private readonly mockQrProvider: MockQrProvider,
    private readonly bcpQrProvider: BcpQrProvider,
  ) {}

  // =====================================================
  // CREAR O REUTILIZAR INTENTO QR
  // =====================================================

  async createQrPayment(trackingToken: string) {
    const configuredProvider = this.getPaymentProvider();

    const expiresAt = new Date(Date.now() + this.getQrTtlSeconds() * 1000);

    const prepared = await this.databaseService.withTransaction(
      async (client): Promise<PreparedQrPayment> => {
        const order = await this.loadOrderForPayment(client, trackingToken);

        this.assertOrderCanReceivePayment(order);

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

        let activePayment: PaymentAttemptRow | null =
          activeResult.rows[0] ?? null;

        if (
          activePayment &&
          activePayment.status !== 'REVIEW_REQUIRED' &&
          activePayment.expires_at &&
          new Date(activePayment.expires_at).getTime() <= Date.now()
        ) {
          await client.query(
            `
                update public.order_payments
                set status = 'EXPIRED'
                where id = $1::uuid
              `,
            [activePayment.id],
          );

          await this.insertPaymentEvent(client, {
            tenantId: activePayment.tenant_id,
            branchId: activePayment.branch_id,
            paymentId: activePayment.id,
            eventType: 'PAYMENT_EXPIRED',
            source: 'SYSTEM',
            processingStatus: 'PROCESSED',
            payload: {
              reason: 'QR_TTL_ELAPSED',
            },
          });

          activePayment = null;
        }

        if (activePayment && activePayment.method !== 'QR') {
          throw new ConflictException(
            'Order already has a non-QR payment selection',
          );
        }

        if (activePayment) {
          return {
            order,
            payment: activePayment,
            shouldGenerate:
              activePayment.status === 'CREATED' &&
              !activePayment.provider_payment_id,
          };
        }

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

        const externalReference = `FC-${order.order_number}-${attemptNumber}`;

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
                  expires_at
                )
                values (
                  $1::uuid,
                  $2::uuid,
                  $3::uuid,
                  $4,
                  'QR',
                  $5,
                  'CREATED',
                  $6::numeric,
                  $7,
                  $8,
                  $9::timestamptz
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
                  created_at,
                  updated_at
              `,
          [
            order.tenant_id,
            order.branch_id,
            order.id,
            attemptNumber,
            configuredProvider.name,
            order.total,
            order.currency,
            externalReference,
            expiresAt.toISOString(),
          ],
        );

        await client.query(
          `
              update public.orders
              set payment_status = 'PENDING'
              where id = $1::uuid
            `,
          [order.id],
        );

        return {
          order: {
            ...order,
            payment_status: 'PENDING',
          },
          payment: paymentResult.rows[0],
          shouldGenerate: true,
        };
      },
    );

    if (!prepared.shouldGenerate) {
      return this.mapPaymentResponse(prepared.order, prepared.payment, true);
    }

    try {
      const provider = this.getProviderByName(prepared.payment.provider);

      const providerResult = await provider.createQrPayment({
        paymentId: prepared.payment.id,
        orderId: prepared.order.id,
        externalReference: prepared.payment.external_reference!,
        amount: prepared.payment.amount,
        currency: prepared.payment.currency,
        expiresAt: new Date(prepared.payment.expires_at!),
      });

      const completed = await this.databaseService.withTransaction(
        async (client) => {
          const paymentResult = await client.query<PaymentAttemptRow>(
            `
                  update public.order_payments
                  set
                    status =
                      'AWAITING_CONFIRMATION',
                    provider_payment_id = $2,
                    qr_payload = $3,
                    qr_content_type = $4,
                    qr_mime_type = $5,
                    expires_at =
                      $6::timestamptz
                  where id = $1::uuid
                    and status = 'CREATED'
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
                    created_at,
                    updated_at
                `,
            [
              prepared.payment.id,
              providerResult.providerPaymentId,
              providerResult.qrPayload,
              providerResult.qrContentType,
              providerResult.qrMimeType,
              providerResult.expiresAt.toISOString(),
            ],
          );

          const payment = paymentResult.rows[0];

          if (!payment) {
            throw new ConflictException(
              'Payment attempt is no longer available',
            );
          }

          await client.query(
            `
                update public.orders
                set payment_status =
                  'AWAITING_CONFIRMATION'
                where id = $1::uuid
              `,
            [prepared.order.id],
          );

          await this.insertPaymentEvent(client, {
            tenantId: payment.tenant_id,
            branchId: payment.branch_id,
            paymentId: payment.id,
            eventType: 'QR_CREATED',
            source: 'SYSTEM',
            processingStatus: 'PROCESSED',
            payload: {
              provider: payment.provider,
              providerPaymentId: payment.provider_payment_id,
              externalReference: payment.external_reference,
              expiresAt: payment.expires_at,
            },
          });

          return payment;
        },
      );

      return this.mapPaymentResponse(
        {
          ...prepared.order,
          payment_status: 'AWAITING_CONFIRMATION',
        },
        completed,
        false,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 500)
          : 'Unknown payment provider error';

      const outcomeUnknown =
        prepared.payment.provider === 'BCP_QR' &&
        error instanceof GatewayTimeoutException;

      const failureStatus: PaymentAttemptStatus = outcomeUnknown
        ? 'REVIEW_REQUIRED'
        : 'FAILED';

      const orderFailureStatus: OrderPaymentStatus = outcomeUnknown
        ? 'REVIEW_REQUIRED'
        : 'FAILED';

      await this.databaseService.withTransaction(async (client) => {
        await client.query(
          `
              update public.order_payments
              set status = $2
              where id = $1::uuid
                and status = 'CREATED'
            `,
          [prepared.payment.id, failureStatus],
        );

        await client.query(
          `
              update public.orders
              set payment_status = $2
              where id = $1::uuid
                and payment_status <> 'PAID'
            `,
          [prepared.order.id, orderFailureStatus],
        );

        await this.insertPaymentEvent(client, {
          tenantId: prepared.payment.tenant_id,
          branchId: prepared.payment.branch_id,
          paymentId: prepared.payment.id,
          eventType: outcomeUnknown
            ? 'QR_CREATION_OUTCOME_UNKNOWN'
            : 'QR_CREATION_FAILED',
          source: 'SYSTEM',
          processingStatus: 'FAILED',
          payload: {
            provider: prepared.payment.provider,
            outcomeUnknown,
          },
          errorMessage: message,
        });
      });

      if (error instanceof ConflictException) {
        throw error;
      }

      if (outcomeUnknown) {
        throw new ServiceUnavailableException(
          'QR payment creation requires reconciliation',
        );
      }

      throw new ServiceUnavailableException(
        'QR payment provider is not available',
      );
    }
  }

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
    const idempotencyToken =
      this.requireIdempotencyToken(idempotencyKeyInput);

    return this.databaseService.withTransaction(
      async (client) => {
        const order =
          await this.loadOrderForPayment(
            client,
            trackingToken,
          );

        const idempotencyKey =
          `cod:${order.id}:${idempotencyToken}`;

        // -------------------------------------------------
        // Idempotencia fuerte:
        // una repeticion de la misma operacion puede
        // recuperar el intento aun si el flujo avanzo
        // posteriormente.
        // -------------------------------------------------

        const replayResult =
          await client.query<PaymentAttemptRow>(
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
            [
              idempotencyKey,
            ],
          );

        const existingPayment =
          replayResult.rows[0] ?? null;

        if (existingPayment) {
          const sameOperation =
            existingPayment.tenant_id ===
              order.tenant_id &&
            existingPayment.branch_id ===
              order.branch_id &&
            existingPayment.order_id ===
              order.id &&
            existingPayment.method === 'CASH' &&
            existingPayment.provider ===
              'DRIVER_COD';

          if (!sameOperation) {
            throw new ConflictException(
              'Idempotency key was already used by another payment operation',
            );
          }

          if (
            existingPayment.status !==
              'AWAITING_CONFIRMATION' &&
            existingPayment.status !== 'PAID'
          ) {
            throw new ConflictException(
              `Cash on delivery cannot be replayed from ${existingPayment.status}`,
            );
          }

          return this.mapPaymentResponse(
            order,
            existingPayment,
            true,
          );
        }

        this.assertOrderCanReceivePayment(order);

        // -------------------------------------------------
        // COD solamente pertenece a un pedido DELIVERY que
        // aun no entro al flujo de dispatch.
        // -------------------------------------------------

        const deliveryResult =
          await client.query<{
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
            [
              order.tenant_id,
              order.branch_id,
              order.id,
            ],
          );

        const delivery =
          deliveryResult.rows[0] ?? null;

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

        const activeResult =
          await client.query<PaymentAttemptRow>(
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
            [
              order.tenant_id,
              order.branch_id,
              order.id,
            ],
          );

        const activePayment =
          activeResult.rows[0] ?? null;

        if (activePayment) {
          const reusableCod =
            activePayment.method === 'CASH' &&
            activePayment.provider === 'DRIVER_COD' &&
            activePayment.status ===
              'AWAITING_CONFIRMATION';

          if (!reusableCod) {
            throw new ConflictException(
              'Order already has another active payment selection',
            );
          }

          if (
            order.payment_status !==
            'AWAITING_CONFIRMATION'
          ) {
            throw new ConflictException(
              'Cash on delivery payment state is inconsistent',
            );
          }

          return this.mapPaymentResponse(
            order,
            activePayment,
            true,
          );
        }

        // -------------------------------------------------
        // Siguiente numero de intento.
        // El lock del Order serializa creaciones de pago
        // concurrentes para este pedido.
        // -------------------------------------------------

        const attemptResult =
          await client.query<{
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
            [
              order.tenant_id,
              order.id,
            ],
          );

        const attemptNumber =
          attemptResult.rows[0].attempt_number;

        const externalReference =
          `COD-${order.order_number}-${attemptNumber}`;

        // -------------------------------------------------
        // Importante:
        // cash_received_amount y cash_change_amount quedan
        // NULL hasta el cobro autenticado por el driver.
        //
        // expires_at tambien queda NULL por contrato COD.
        // -------------------------------------------------

        const paymentResult =
          await client.query<PaymentAttemptRow>(
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

        const payment =
          paymentResult.rows[0];

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
          [
            order.id,
          ],
        );

        await this.insertPaymentEvent(
          client,
          {
            tenantId: payment.tenant_id,
            branchId: payment.branch_id,
            paymentId: payment.id,
            eventType:
              'DRIVER_COD_SELECTED',
            source: 'SYSTEM',
            processingStatus:
              'PROCESSED',
            payload: {
              provider:
                payment.provider,
              externalReference:
                payment.external_reference,
              amount:
                payment.amount,
              currency:
                payment.currency,
            },
          },
        );

        return this.mapPaymentResponse(
          {
            ...order,
            payment_status:
              'AWAITING_CONFIRMATION',
          },
          payment,
          false,
        );
      },
    );
  }

  async getOrderPayment(trackingToken: string) {
    await this.expirePaymentIfNeeded(trackingToken);

    const result = await this.databaseService.query<PaymentTrackingRow>(
      `
          select
            o.id::text,
            o.order_number::text,
            o.tracking_token::text,
            o.tenant_id::text,
            o.branch_id::text,
            o.status,
            o.payment_status,
            o.order_origin,
            o.total::text,
            o.currency,
            o.reservation_id::text,
            r.status
              as reservation_status,

            p.id::text
              as payment_id,
            p.attempt_number
              as payment_attempt_number,
            p.method
              as payment_method,
            p.provider
              as payment_provider,
            p.status
              as payment_attempt_status,
            p.amount::text
              as payment_amount,
            p.currency
              as payment_currency,
            p.external_reference
              as payment_external_reference,
            p.provider_payment_id
              as payment_provider_payment_id,
            p.provider_transaction_id
              as payment_provider_transaction_id,
            p.qr_payload
              as payment_qr_payload,
            p.qr_content_type
              as payment_qr_content_type,
            p.qr_mime_type
              as payment_qr_mime_type,
            p.expires_at
              as payment_expires_at,
            p.paid_at
              as payment_paid_at,
            p.verified_at
              as payment_verified_at,
            p.created_at
              as payment_created_at,
            p.updated_at
              as payment_updated_at

          from public.orders o

          left join
            public.table_reservations r
            on r.tenant_id =
              o.tenant_id
           and r.branch_id =
              o.branch_id
           and r.id =
              o.reservation_id

          left join lateral (
            select op.*

            from public.order_payments op

            where op.tenant_id =
                o.tenant_id
              and op.branch_id =
                o.branch_id
              and op.order_id =
                o.id

            order by
              op.attempt_number desc

            limit 1
          ) p on true

          where o.tracking_token =
            $1::uuid

          limit 1
        `,
      [trackingToken],
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException('Order not found');
    }

    return {
      order: this.mapOrder(row),

      payment: row.payment_id
        ? this.mapPayment({
            id: row.payment_id,
            tenant_id: row.tenant_id,
            branch_id: row.branch_id,
            order_id: row.id,

            attempt_number: row.payment_attempt_number!,

            method: row.payment_method!,

            provider: row.payment_provider!,

            status: row.payment_attempt_status!,

            amount: row.payment_amount!,

            currency: row.payment_currency!,

            external_reference: row.payment_external_reference,

            provider_payment_id: row.payment_provider_payment_id,

            provider_transaction_id: row.payment_provider_transaction_id,

            qr_payload: row.payment_qr_payload,

            qr_content_type: row.payment_qr_content_type,

            qr_mime_type: row.payment_qr_mime_type,

            expires_at: row.payment_expires_at,

            paid_at: row.payment_paid_at,

            verified_at: row.payment_verified_at,

            created_at: row.payment_created_at!,

            updated_at: row.payment_updated_at!,
          })
        : null,
    };
  }

  // =====================================================
  // CONFIRMACIÃ“N DE EFECTIVO - SOLO CAJA PRESENCIAL
  // =====================================================

  async confirmCashPayment(orderId: string, input: ConfirmCashPaymentInput) {
    this.assertCashierAccessKey(input.cashierAccessKey);

    const tenantCode = this.requireCashCode(input.tenantCode, 'tenantCode');

    const branchCode = this.requireCashCode(input.branchCode, 'branchCode');

    const cashReceivedAmount = this.requireCashAmount(input.cashReceivedAmount);

    const cashierReference = this.requireAuditReference(
      input.cashierReference,
      'cashierReference',
    );

    const terminalReference = this.requireAuditReference(
      input.terminalReference,
      'terminalReference',
    );

    const idempotencyToken = this.requireIdempotencyToken(input.idempotencyKey);

    const cashResult = await this.databaseService.withTransaction(async (client) => {
      const orderResult = await client.query<PaymentOrderRow>(
        `
              select
                o.id::text,
                o.order_number::text,
                o.tracking_token::text,
                o.tenant_id::text,
                o.branch_id::text,
                o.status,
                o.payment_status,
                o.order_origin,
                o.total::text,
                o.currency,
                o.reservation_id::text,
                r.status as reservation_status

              from public.orders o

              inner join public.tenants t
                on t.id = o.tenant_id

              inner join public.branches b
                on b.tenant_id = o.tenant_id
               and b.id = o.branch_id

              left join public.table_reservations r
                on r.tenant_id = o.tenant_id
               and r.branch_id = o.branch_id
               and r.id = o.reservation_id

              where o.id = $1::uuid
                and upper(t.code) = $2
                and upper(b.code) = $3

              for update of o
            `,
        [orderId, tenantCode, branchCode],
      );

      const order = orderResult.rows[0];

      if (!order) {
        throw new NotFoundException('Order not found in cashier branch');
      }

      const idempotencyKey = `cash:${order.id}:${idempotencyToken}`;

      const existingResult = await client.query<
        PaymentAttemptRow & {
          received_amount_matches: boolean;
        }
      >(
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
              updated_at,
              cash_received_amount =
                $2::numeric as received_amount_matches

            from public.order_payments

            where idempotency_key = $1

            limit 1

            for update
          `,
        [idempotencyKey, cashReceivedAmount],
      );

      const existingPayment = existingResult.rows[0];

      if (existingPayment) {
        const sameOperation =
          existingPayment.tenant_id === order.tenant_id &&
          existingPayment.branch_id === order.branch_id &&
          existingPayment.order_id === order.id &&
          existingPayment.method === 'CASH' &&
          existingPayment.provider === 'CASHIER' &&
          existingPayment.received_amount_matches;

        if (!sameOperation) {
          throw new ConflictException(
            'Idempotency key was already used by another cash operation',
          );
        }

        if (existingPayment.status !== 'PAID') {
          throw new ConflictException(
            `Cash payment cannot be replayed from ${existingPayment.status}`,
          );
        }

        return {
          changed: false,
          order: this.mapOrder(order),
          payment: this.mapPayment(existingPayment),
        };
      }

      if (order.payment_status === 'NOT_REQUIRED') {
        throw new ConflictException(
          'Legacy order does not require a cash payment',
        );
      }

      if (order.payment_status === 'PAID') {
        throw new ConflictException('Order is already paid');
      }

      if (
        order.payment_status === 'REFUND_PENDING' ||
        order.payment_status === 'REFUNDED' ||
        order.payment_status === 'REVIEW_REQUIRED'
      ) {
        throw new ConflictException(
          `Order cannot receive cash from ${order.payment_status}`,
        );
      }

      if (order.status !== 'PENDING' && order.status !== 'CONFIRMED') {
        throw new ConflictException(
          `Order cannot receive cash from ${order.status}`,
        );
      }

      if (Number(order.total) <= 0) {
        throw new ConflictException('Order total must be greater than zero');
      }

      const coverageResult = await client.query<{
        sufficient: boolean;
      }>(
        `
              select
                $1::numeric >=
                  $2::numeric as sufficient
            `,
        [cashReceivedAmount, order.total],
      );

      if (!coverageResult.rows[0]?.sufficient) {
        throw new BadRequestException(
          'Cash received amount is lower than the order total',
        );
      }

      const blockingResult = await client.query<{
        id: string;
        tenant_id: string;
        branch_id: string;
        method: 'QR' | 'CASH';
        provider: string;
        provider_payment_id: string | null;
        status: PaymentAttemptStatus;
      }>(
        `
              select
                id::text,
                tenant_id::text,
                branch_id::text,
                method,
                provider,
                provider_payment_id,
                status

              from public.order_payments

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and order_id = $3::uuid
                and status in (
                  'CREATED',
                  'AWAITING_CONFIRMATION',
                  'PAID',
                  'REFUND_PENDING',
                  'REVIEW_REQUIRED'
                )

              order by attempt_number

              for update
            `,
        [order.tenant_id, order.branch_id, order.id],
      );

      const protectedPayment = blockingResult.rows.find(
        (payment) =>
          payment.status === 'PAID' ||
          payment.status === 'REFUND_PENDING' ||
          payment.status === 'REVIEW_REQUIRED',
      );

      if (protectedPayment) {
        throw new ConflictException(
          `Order has a protected payment in ${protectedPayment.status}`,
        );
      }

      const bcpCreationInProgress = blockingResult.rows.find(
        (payment) =>
          payment.method === 'QR' &&
          payment.provider.trim().toUpperCase() === 'BCP_QR' &&
          payment.status === 'CREATED',
      );

      if (bcpCreationInProgress) {
        throw new ConflictException(
          'BCP QR creation is still in progress; cash payment is blocked',
        );
      }

      const markCancellationReviewRequired = async (
        activePayment: (typeof blockingResult.rows)[number],
        message: string,
      ) => {
        await client.query(
          `
              update public.order_payments
              set status = 'REVIEW_REQUIRED'
              where id = $1::uuid
                and status in (
                  'CREATED',
                  'AWAITING_CONFIRMATION'
                )
            `,
          [activePayment.id],
        );

        await client.query(
          `
              update public.orders
              set payment_status = 'REVIEW_REQUIRED'
              where id = $1::uuid
                and payment_status <> 'PAID'
            `,
          [order.id],
        );

        await this.insertPaymentEvent(client, {
          tenantId: activePayment.tenant_id,
          branchId: activePayment.branch_id,
          paymentId: activePayment.id,
          eventType: 'QR_CANCELLATION_OUTCOME_UNKNOWN',
          source: 'CASHIER',
          processingStatus: 'FAILED',
          payload: {
            reason: 'CASH_PAYMENT_REQUIRES_QR_CANCELLATION',
            provider: activePayment.provider,
            providerPaymentId: activePayment.provider_payment_id,
            cashierReference,
            terminalReference,
          },
          errorMessage: message.slice(0, 500),
        });

        return {
          reconciliationRequired: true as const,
        };
      };

      for (const activePayment of blockingResult.rows) {
        const normalizedProvider = activePayment.provider.trim().toUpperCase();

        if (
          activePayment.method === 'QR' &&
          normalizedProvider === 'BCP_QR' &&
          activePayment.status === 'AWAITING_CONFIRMATION'
        ) {
          if (!activePayment.provider_payment_id) {
            return markCancellationReviewRequired(
              activePayment,
              'BCP QR provider payment identifier is missing',
            );
          }

          try {
            const provider = this.getProviderByName(activePayment.provider);

            const cancellation = await provider.cancelQrPayment({
              providerPaymentId: activePayment.provider_payment_id,
              reason: 'CASH_PAYMENT_REPLACED_ACTIVE_ATTEMPT',
            });

            if (
              cancellation.status !== 'CANCELLED' ||
              cancellation.providerPaymentId !== activePayment.provider_payment_id
            ) {
              return markCancellationReviewRequired(
                activePayment,
                'BCP QR cancellation confirmation was inconsistent',
              );
            }
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : 'BCP QR cancellation outcome is unknown';

            return markCancellationReviewRequired(activePayment, message);
          }
        }

        if (
          activePayment.method === 'QR' &&
          normalizedProvider !== 'MOCK' &&
          normalizedProvider !== 'BCP_QR'
        ) {
          return markCancellationReviewRequired(
            activePayment,
            'Stored QR payment provider cannot be cancelled safely',
          );
        }

        await client.query(
          `
              update public.order_payments
              set status = 'CANCELLED'
              where id = $1::uuid
                and status in (
                  'CREATED',
                  'AWAITING_CONFIRMATION'
                )
            `,
          [activePayment.id],
        );

        await this.insertPaymentEvent(client, {
          tenantId: activePayment.tenant_id,

          branchId: activePayment.branch_id,

          paymentId: activePayment.id,

          eventType: 'PAYMENT_CANCELLED',

          source: 'CASHIER',

          processingStatus: 'PROCESSED',

          payload: {
            reason: 'CASH_PAYMENT_REPLACED_ACTIVE_ATTEMPT',

            previousMethod: activePayment.method,

            previousProvider: activePayment.provider,

            remoteCancellationConfirmed:
              activePayment.method === 'QR' && normalizedProvider === 'BCP_QR',

            cashierReference,

            terminalReference,
          },
        });
      }

      const attemptResult = await client.query<{
        attempt_number: number;
      }>(
        `
              select
                coalesce(
                  max(attempt_number),
                  0
                )::int + 1 as attempt_number

              from public.order_payments

              where tenant_id = $1::uuid
                and order_id = $2::uuid
            `,
        [order.tenant_id, order.id],
      );

      const attemptNumber = attemptResult.rows[0].attempt_number;

      const externalReference = `CASH-${order.order_number}-${attemptNumber}`;

      const transactionId = `CASH-TX-${randomUUID()}`;

      const paidAt = new Date();

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
                provider_payment_id,
                provider_transaction_id,
                idempotency_key,
                qr_payload,
                expires_at,
                paid_at,
                verified_at,
                confirmed_by_user_id,
                cash_received_amount,
                cash_change_amount
              )
              values (
                $1::uuid,
                $2::uuid,
                $3::uuid,
                $4,
                'CASH',
                'CASHIER',
                'PAID',
                $5::numeric,
                $6,
                $7,
                null,
                $8,
                $9,
                null,
                null,
                $10::timestamptz,
                $10::timestamptz,
                null,
                $11::numeric,
                $11::numeric - $5::numeric
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
          transactionId,
          idempotencyKey,
          paidAt.toISOString(),
          cashReceivedAmount,
        ],
      );

      const payment = paymentResult.rows[0];

      const reservationAllowsConfirmation =
        !order.reservation_id ||
        order.reservation_status === 'CONFIRMED' ||
        order.reservation_status === 'SEATED';

      const updatedOrderResult = await client.query<{
        status: OrderStatus;
        payment_status: OrderPaymentStatus;
      }>(
        `
              update public.orders
              set
                payment_status = 'PAID',
                status = case
                  when status = 'PENDING'
                    and $2::boolean
                    then 'CONFIRMED'
                  else status
                end
              where id = $1::uuid
              returning
                status,
                payment_status
            `,
        [order.id, reservationAllowsConfirmation],
      );

      const updatedOrder = updatedOrderResult.rows[0];

      await this.insertPaymentEvent(client, {
        tenantId: payment.tenant_id,

        branchId: payment.branch_id,

        paymentId: payment.id,

        eventType: 'CASH_PAYMENT_CONFIRMED',

        providerEventId: transactionId,

        source: 'CASHIER',

        processingStatus: 'PROCESSED',

        payload: {
          cashierReference,

          terminalReference,

          externalReference: payment.external_reference,

          amount: payment.amount,

          currency: payment.currency,

          cashReceivedAmount: payment.cash_received_amount,

          cashChangeAmount: payment.cash_change_amount,
        },
      });

      return {
        changed: true,

        order: this.mapOrder({
          ...order,

          status: updatedOrder.status,

          payment_status: updatedOrder.payment_status,
        }),

        payment: this.mapPayment(payment),
      };
    });

    if ('reconciliationRequired' in cashResult) {
      throw new ServiceUnavailableException(
        'QR cancellation requires reconciliation before cash payment',
      );
    }

    return cashResult;
  }
  // =====================================================
  // CONFIRMACIÃ“N MOCK - SOLO LABORATORIO
  // =====================================================

  async confirmMockPayment(paymentId: string, labAccessKey?: string) {
    this.assertMockConfirmationAllowed(labAccessKey);
    this.getMockProvider();

    return this.databaseService.withTransaction(async (client) => {
      const result = await client.query<PaymentTrackingRow>(
        `
              select
                o.id::text,
                o.order_number::text,
                o.tracking_token::text,
                o.tenant_id::text,
                o.branch_id::text,
                o.status,
                o.payment_status,
                o.order_origin,
                o.total::text,
                o.currency,
                o.reservation_id::text,
                r.status
                  as reservation_status,

                p.id::text
                  as payment_id,
                p.attempt_number
                  as payment_attempt_number,
                p.method
                  as payment_method,
                p.provider
                  as payment_provider,
                p.status
                  as payment_attempt_status,
                p.amount::text
                  as payment_amount,
                p.currency
                  as payment_currency,
                p.external_reference
                  as payment_external_reference,
                p.provider_payment_id
                  as payment_provider_payment_id,
                p.provider_transaction_id
                  as payment_provider_transaction_id,
                p.qr_payload
                  as payment_qr_payload,
                p.qr_content_type
                  as payment_qr_content_type,
                p.qr_mime_type
                  as payment_qr_mime_type,
                p.expires_at
                  as payment_expires_at,
                p.paid_at
                  as payment_paid_at,
                p.verified_at
                  as payment_verified_at,
                p.created_at
                  as payment_created_at,
                p.updated_at
                  as payment_updated_at

              from public.order_payments p

              inner join public.orders o
                on o.tenant_id =
                  p.tenant_id
               and o.branch_id =
                  p.branch_id
               and o.id =
                  p.order_id

              left join
                public.table_reservations r
                on r.tenant_id =
                  o.tenant_id
               and r.branch_id =
                  o.branch_id
               and r.id =
                  o.reservation_id

              where p.id = $1::uuid

              for update of p, o
            `,
        [paymentId],
      );

      const row = result.rows[0];

      if (!row || !row.payment_id) {
        throw new NotFoundException('Payment not found');
      }

      if (row.payment_provider !== 'MOCK' || row.payment_method !== 'QR') {
        throw new ConflictException('Payment is not a mock QR payment');
      }

      if (row.payment_attempt_status === 'PAID') {
        return {
          changed: false,
          order: this.mapOrder(row),
          payment: this.mapPaymentFromTracking(row),
        };
      }

      if (row.payment_attempt_status !== 'AWAITING_CONFIRMATION') {
        throw new ConflictException(
          `Payment cannot be confirmed from ${row.payment_attempt_status}`,
        );
      }

      if (
        row.payment_expires_at &&
        new Date(row.payment_expires_at).getTime() <= Date.now()
      ) {
        throw new ConflictException('Payment QR has expired');
      }

      if (row.status !== 'PENDING' && row.status !== 'CONFIRMED') {
        throw new ConflictException(
          `Order cannot receive payment from ${row.status}`,
        );
      }

      if (
        row.payment_amount !== row.total ||
        row.payment_currency !== row.currency
      ) {
        throw new ConflictException(
          'Payment amount or currency does not match the order',
        );
      }

      const paidAt = new Date();

      const providerTransactionId = `MOCK-TX-${randomUUID()}`;

      const paymentResult = await client.query<PaymentAttemptRow>(
        `
              update public.order_payments
              set
                status = 'PAID',
                provider_transaction_id =
                  $2,
                paid_at =
                  $3::timestamptz,
                verified_at =
                  $3::timestamptz
              where id = $1::uuid
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
                created_at,
                updated_at
            `,
        [paymentId, providerTransactionId, paidAt.toISOString()],
      );

      const payment = paymentResult.rows[0];

      if (!payment) {
        throw new ConflictException('Payment changed concurrently');
      }

      const reservationAllowsConfirmation =
        !row.reservation_id ||
        row.reservation_status === 'CONFIRMED' ||
        row.reservation_status === 'SEATED';

      const orderResult = await client.query<{
        status: OrderStatus;
        payment_status: OrderPaymentStatus;
      }>(
        `
              update public.orders
              set
                payment_status = 'PAID',
                status = case
                  when status = 'PENDING'
                    and $2::boolean
                    then 'CONFIRMED'
                  else status
                end
              where id = $1::uuid
              returning
                status,
                payment_status
            `,
        [row.id, reservationAllowsConfirmation],
      );

      const updatedOrder = orderResult.rows[0];

      await this.insertPaymentEvent(client, {
        tenantId: payment.tenant_id,

        branchId: payment.branch_id,

        paymentId: payment.id,

        eventType: 'PAYMENT_CONFIRMED',

        providerEventId: providerTransactionId,

        source: 'PROVIDER_QUERY',

        processingStatus: 'PROCESSED',

        payload: {
          provider: payment.provider,

          providerPaymentId: payment.provider_payment_id,

          providerTransactionId,

          amount: payment.amount,

          currency: payment.currency,
        },
      });

      return {
        changed: true,

        order: this.mapOrder({
          ...row,

          status: updatedOrder.status,

          payment_status: updatedOrder.payment_status,
        }),

        payment: this.mapPayment(payment),
      };
    });
  }

  // =====================================================
  // HELPERS
  // =====================================================

  private assertMockConfirmationAllowed(providedKey?: string): void {
    const nodeEnvironment = (this.configService.get<string>('NODE_ENV') || '')
      .trim()
      .toLowerCase();

    const configuredProvider = (
      this.configService.get<string>('PAYMENT_PROVIDER') || ''
    )
      .trim()
      .toUpperCase();

    const mockConfirmationEnabled =
      (this.configService.get<string>('ENABLE_MOCK_PAYMENT_CONFIRMATION') || '')
        .trim()
        .toLowerCase() === 'true';

    const laboratoryEnvironment =
      nodeEnvironment === 'development' || nodeEnvironment === 'test';

    if (
      !laboratoryEnvironment ||
      configuredProvider !== 'MOCK' ||
      !mockConfirmationEnabled
    ) {
      throw new NotFoundException('Resource not found');
    }

    const configuredKey =
      this.configService.get<string>('PAYMENT_LAB_KEY')?.trim() || '';

    if (configuredKey.length < 48) {
      throw new ServiceUnavailableException(
        'Payment laboratory access is not configured',
      );
    }

    const receivedKey = providedKey?.trim() || '';
    const configuredBuffer = Buffer.from(configuredKey, 'utf8');
    const receivedBuffer = Buffer.from(receivedKey, 'utf8');

    const validKey =
      configuredBuffer.length === receivedBuffer.length &&
      timingSafeEqual(configuredBuffer, receivedBuffer);

    if (!validKey) {
      throw new UnauthorizedException('Invalid payment laboratory credentials');
    }
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

  private requireCashCode(value: string | undefined, field: string): string {
    const normalized = value?.trim().toUpperCase() || '';

    if (!/^[A-Z0-9_-]{2,30}$/.test(normalized)) {
      throw new BadRequestException(`${field} is invalid`);
    }

    return normalized;
  }

  private requireAuditReference(
    value: string | undefined,
    field: string,
  ): string {
    const normalized = value?.trim() || '';

    if (
      normalized.length < 2 ||
      normalized.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(normalized)
    ) {
      throw new BadRequestException(`${field} is invalid`);
    }

    return normalized;
  }

  private requireIdempotencyToken(value?: string): string {
    const normalized = value?.trim().toLowerCase() || '';

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        normalized,
      )
    ) {
      throw new BadRequestException('Idempotency-Key must be a valid UUID');
    }

    return normalized;
  }

  private requireCashAmount(value: string | number | undefined): string {
    const normalized = String(value ?? '').trim();

    if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(normalized)) {
      throw new BadRequestException('cashReceivedAmount is invalid');
    }

    if (Number(normalized) <= 0) {
      throw new BadRequestException(
        'cashReceivedAmount must be greater than zero',
      );
    }

    return normalized;
  }
  private getPaymentProvider(): PaymentProvider {
    const configuredProvider = (
      this.configService.get<string>('PAYMENT_PROVIDER') || ''
    )
      .trim()
      .toUpperCase();

    switch (configuredProvider) {
      case 'MOCK':
        return this.mockQrProvider;

      case 'BCP_QR':
        return this.bcpQrProvider;

      default:
        throw new ServiceUnavailableException(
          'PAYMENT_PROVIDER must be MOCK or BCP_QR',
        );
    }
  }

  private getProviderByName(providerName: string): PaymentProvider {
    const normalizedProvider = providerName.trim().toUpperCase();

    switch (normalizedProvider) {
      case 'MOCK':
        return this.mockQrProvider;

      case 'BCP_QR':
        return this.bcpQrProvider;

      default:
        throw new ServiceUnavailableException(
          'Stored payment provider is not supported',
        );
    }
  }

  private getMockProvider(): MockQrProvider {
    const provider = this.getPaymentProvider();

    if (provider.name !== 'MOCK') {
      throw new ServiceUnavailableException(
        'MOCK payment provider is not active',
      );
    }

    return this.mockQrProvider;
  }

  private getQrTtlSeconds(): number {
    const configured = Number(
      this.configService.get<string>('PAYMENT_QR_TTL_SECONDS') || '600',
    );

    if (!Number.isInteger(configured)) {
      return 600;
    }

    return Math.min(Math.max(configured, 60), 3600);
  }

  private async loadOrderForPayment(
    client: PoolClient,
    trackingToken: string,
  ): Promise<PaymentOrderRow> {
    const result = await client.query<PaymentOrderRow>(
      `
          select
            o.id::text,
            o.order_number::text,
            o.tracking_token::text,
            o.tenant_id::text,
            o.branch_id::text,
            o.status,
            o.payment_status,
            o.order_origin,
            o.total::text,
            o.currency,
            o.reservation_id::text,
            r.status
              as reservation_status

          from public.orders o

          left join
            public.table_reservations r
            on r.tenant_id =
              o.tenant_id
           and r.branch_id =
              o.branch_id
           and r.id =
              o.reservation_id

          where o.tracking_token =
            $1::uuid

          for update of o
        `,
      [trackingToken],
    );

    const order = result.rows[0];

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  private assertOrderCanReceivePayment(order: PaymentOrderRow): void {
    if (order.payment_status === 'NOT_REQUIRED') {
      throw new ConflictException(
        'Legacy order does not require a payment attempt',
      );
    }

    if (order.payment_status === 'PAID') {
      throw new ConflictException('Order is already paid');
    }

    if (order.status !== 'PENDING') {
      throw new ConflictException(
        `Order cannot create a payment from ${order.status}`,
      );
    }

    if (Number(order.total) <= 0) {
      throw new ConflictException('Order total must be greater than zero');
    }
  }

  private async expirePaymentIfNeeded(trackingToken: string): Promise<void> {
    await this.databaseService.withTransaction(async (client) => {
      const result = await client.query<
        PaymentAttemptRow & {
          order_payment_status: OrderPaymentStatus;
        }
      >(
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
                p.created_at,
                p.updated_at,
                o.payment_status
                  as order_payment_status

              from public.orders o

              inner join
                public.order_payments p
                on p.tenant_id =
                  o.tenant_id
               and p.branch_id =
                  o.branch_id
               and p.order_id =
                  o.id

              where o.tracking_token =
                  $1::uuid
                and p.status in (
                  'CREATED',
                  'AWAITING_CONFIRMATION'
                )

              order by
                p.attempt_number desc

              limit 1

              for update of p, o
            `,
        [trackingToken],
      );

      const payment = result.rows[0];

      if (
        !payment?.expires_at ||
        new Date(payment.expires_at).getTime() > Date.now()
      ) {
        return;
      }

      await client.query(
        `
            update public.order_payments
            set status = 'EXPIRED'
            where id = $1::uuid
          `,
        [payment.id],
      );

      await client.query(
        `
            update public.orders
            set payment_status = 'EXPIRED'
            where id = $1::uuid
              and payment_status in (
                'PENDING',
                'AWAITING_CONFIRMATION'
              )
          `,
        [payment.order_id],
      );

      await this.insertPaymentEvent(client, {
        tenantId: payment.tenant_id,

        branchId: payment.branch_id,

        paymentId: payment.id,

        eventType: 'PAYMENT_EXPIRED',

        source: 'SYSTEM',

        processingStatus: 'PROCESSED',

        payload: {
          reason: 'QR_TTL_ELAPSED',
        },
      });
    });
  }

  private async insertPaymentEvent(
    client: PoolClient,

    input: {
      tenantId: string;
      branchId: string;
      paymentId: string;
      eventType: string;
      providerEventId?: string;

      source:
        | 'SYSTEM'
        | 'PROVIDER_QUERY'
        | 'PROVIDER_WEBHOOK'
        | 'CASHIER'
        | 'RECONCILIATION';

      processingStatus: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';

      payload: Record<string, unknown>;

      errorMessage?: string;
    },
  ): Promise<void> {
    await client.query(
      `
        insert into public.payment_events (
          tenant_id,
          branch_id,
          payment_id,
          event_type,
          provider_event_id,
          source,
          processing_status,
          payload,
          error_message,
          processed_at
        )
        values (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4,
          $5,
          $6,
          $7::varchar,
          $8::jsonb,
          $9,
          case
            when $7::varchar = 'RECEIVED'
              then null
            else now()
          end
        )
      `,
      [
        input.tenantId,
        input.branchId,
        input.paymentId,
        input.eventType,
        input.providerEventId ?? null,
        input.source,
        input.processingStatus,
        JSON.stringify(input.payload),
        input.errorMessage ?? null,
      ],
    );
  }

  private mapPaymentResponse(
    order: PaymentOrderRow,
    payment: PaymentAttemptRow,
    reused: boolean,
  ) {
    return {
      reused,

      order: this.mapOrder(order),

      payment: this.mapPayment(payment),
    };
  }

  private mapOrder(order: PaymentOrderRow) {
    return {
      id: order.id,

      orderNumber: order.order_number,

      trackingToken: order.tracking_token,

      status: order.status,

      paymentStatus: order.payment_status,

      orderOrigin: order.order_origin,

      total: Number(order.total),

      currency: order.currency,

      reservationId: order.reservation_id,

      reservationStatus: order.reservation_status,
    };
  }

  private mapPayment(payment: PaymentAttemptRow) {
    return {
      id: payment.id,

      attemptNumber: payment.attempt_number,

      method: payment.method,

      provider: payment.provider,

      status: payment.status,

      amount: Number(payment.amount),

      currency: payment.currency,

      externalReference: payment.external_reference,

      providerPaymentId: payment.provider_payment_id,

      providerTransactionId: payment.provider_transaction_id,

      qrPayload: payment.qr_payload,

      qrContentType: payment.qr_content_type,

      qrMimeType: payment.qr_mime_type,

      expiresAt: payment.expires_at,

      paidAt: payment.paid_at,

      verifiedAt: payment.verified_at,
      cashReceivedAmount:
        payment.cash_received_amount == null
          ? null
          : Number(payment.cash_received_amount),
      cashChangeAmount:
        payment.cash_change_amount == null
          ? null
          : Number(payment.cash_change_amount),

      createdAt: payment.created_at,

      updatedAt: payment.updated_at,
    };
  }

  private mapPaymentFromTracking(row: PaymentTrackingRow) {
    return this.mapPayment({
      id: row.payment_id!,

      tenant_id: row.tenant_id,

      branch_id: row.branch_id,

      order_id: row.id,

      attempt_number: row.payment_attempt_number!,

      method: row.payment_method!,

      provider: row.payment_provider!,

      status: row.payment_attempt_status!,

      amount: row.payment_amount!,

      currency: row.payment_currency!,

      external_reference: row.payment_external_reference,

      provider_payment_id: row.payment_provider_payment_id,

      provider_transaction_id: row.payment_provider_transaction_id,

      qr_payload: row.payment_qr_payload,

      qr_content_type: row.payment_qr_content_type,

      qr_mime_type: row.payment_qr_mime_type,

      expires_at: row.payment_expires_at,

      paid_at: row.payment_paid_at,

      verified_at: row.payment_verified_at,

      created_at: row.payment_created_at!,

      updated_at: row.payment_updated_at!,
    });
  }
}
