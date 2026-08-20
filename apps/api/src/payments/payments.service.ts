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
export interface DriverCodCashCollectionInput {
  tenantId: string;
  branchId: string;
  orderId: string;
  deliveryId: string;
  assignmentId: string;
  driverId: string;
  cashReceivedAmount: unknown;
  idempotencyKey?: string;
}
interface OpenDriverCodCashSettlementInput {
  tenantCode?: string;
  branchCode?: string;
  driverId?: string;
  currency?: string;
  cashierReference?: string;
  notes?: string;
  idempotencyKey?: string;
  cashierAccessKey?: string;
}

interface SettleDriverCodCashSettlementInput {
  tenantCode?: string;
  branchCode?: string;
  receivedAmount?: string | number;
  cashierReference?: string;
  idempotencyKey?: string;
  cashierAccessKey?: string;
}

interface CancelDriverCodCashSettlementInput {
  tenantCode?: string;
  branchCode?: string;
  cashierReference?: string;
  idempotencyKey?: string;
  cashierAccessKey?: string;
}

type DriverCodCashSettlementStatus =
  | 'OPEN'
  | 'SETTLED'
  | 'CANCELLED';

interface DriverCodCashSettlementRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  driver_id: string;
  status: DriverCodCashSettlementStatus;
  currency: string;
  expected_amount: string;
  received_amount: string | null;
  difference_amount: string | null;
  idempotency_key: string;
  opened_at: string | Date;
  settled_at: string | Date | null;
  cancelled_at: string | Date | null;
  notes: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface DriverCodCashSettlementItemPaymentRow {
  id: string;
  collection_id: string;
  payment_id: string;
  amount: string;
  currency: string;
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

  async collectDriverCodCash(
    client: PoolClient,
    input: DriverCodCashCollectionInput,
  ) {
    const cashReceivedAmount = this.requireCashAmount(input.cashReceivedAmount);

    const idempotencyToken = this.requireIdempotencyToken(input.idempotencyKey);

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

        payment: this.mapPayment(payment),

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

    await this.insertPaymentEvent(client, {
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

      payment: this.mapPayment(paidPayment),

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

  async openDriverCodCashSettlement(
    input: OpenDriverCodCashSettlementInput,
  ) {
    this.assertCashierAccessKey(input.cashierAccessKey);

    const tenantCode =
      this.requireCashCode(input.tenantCode, 'tenantCode');

    const branchCode =
      this.requireCashCode(input.branchCode, 'branchCode');

    const driverId =
      this.requireSettlementUuid(input.driverId, 'driverId');

    const currency =
      this.requireSettlementCurrency(input.currency);

    const cashierReference =
      this.requireAuditReference(
        input.cashierReference,
        'cashierReference',
      );

    const notes =
      this.requireOptionalSettlementNotes(input.notes);

    const idempotencyToken =
      this.requireIdempotencyToken(input.idempotencyKey);

    const storedIdempotencyKey =
      `driver-cod-settlement-open:${idempotencyToken}`;

    return this.databaseService.withTransaction(
      async (client) => {
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
          throw new NotFoundException(
            'Tenant/branch payment scope not found',
          );
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
          [
            scope.tenant_id,
            scope.branch_id,
            driverId,
          ],
        );

        if (!driverBranchResult.rows[0]) {
          throw new NotFoundException(
            'Driver is not assigned to this branch',
          );
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

        const existingByKey =
          existingByKeyResult.rows[0];

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

          const eventKey =
            `driver-cod-settlement-open:${existingByKey.id}:${idempotencyToken}`;

          const replayEventResult =
            await client.query<{
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

          const replayEvent =
            replayEventResult.rows[0];

          const eventCount =
            Number(replayEvent?.event_count ?? 0);

          const referenceCount =
            Number(replayEvent?.reference_count ?? 0);

          if (
            eventCount <= 0 ||
            referenceCount !== eventCount
          ) {
            throw new ConflictException(
              'Stored cash settlement idempotency state is inconsistent',
            );
          }

          const currentItems =
            await this.loadDriverCodCashSettlementItems(
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

            settlement:
              this.mapDriverCodCashSettlement(
                existingByKey,
                currentItems.length,
                eventCount,
              ),
          };
        }

        const openResult =
          await client.query<{
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
            [
              scope.tenant_id,
              scope.branch_id,
              driverId,
              currency,
            ],
          );

        if (openResult.rows[0]) {
          throw new ConflictException(
            'Driver already has an open cash settlement for this currency',
          );
        }

        const collectionsResult =
          await client.query<{
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
            [
              scope.tenant_id,
              scope.branch_id,
              driverId,
              currency,
            ],
          );

        const collections =
          collectionsResult.rows;

        if (collections.length === 0) {
          throw new ConflictException(
            'Driver has no unsettled COD cash collections for this currency',
          );
        }

        const collectionIds =
          collections.map(
            (collection) => collection.id,
          );

        const totalResult =
          await client.query<{
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
            [
              scope.tenant_id,
              scope.branch_id,
              collectionIds,
            ],
          );

        const expectedAmount =
          totalResult.rows[0]?.expected_amount;

        if (
          !expectedAmount ||
          Number(expectedAmount) <= 0
        ) {
          throw new ConflictException(
            'Cash settlement expected amount is invalid',
          );
        }

        const settlementResult =
          await client.query<DriverCodCashSettlementRow>(
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

        const settlement =
          settlementResult.rows[0];

        if (!settlement) {
          throw new ConflictException(
            'Cash settlement was not created',
          );
        }

        const itemsResult =
          await client.query(
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
            [
              scope.tenant_id,
              scope.branch_id,
              settlement.id,
              collectionIds,
            ],
          );

        if (
          (itemsResult.rowCount ?? 0) !==
          collections.length
        ) {
          throw new ConflictException(
            'Cash settlement snapshot was not created completely',
          );
        }

        const eventKey =
          `driver-cod-settlement-open:${settlement.id}:${idempotencyToken}`;

        for (const collection of collections) {
          await this.insertPaymentEvent(client, {
            tenantId: scope.tenant_id,
            branchId: scope.branch_id,
            paymentId: collection.payment_id,
            eventType:
              'DRIVER_COD_CASH_SETTLEMENT_OPENED',
            providerEventId: eventKey,
            source: 'RECONCILIATION',
            processingStatus: 'PROCESSED',
            payload: {
              settlementId: settlement.id,
              driverId,
              collectionId: collection.id,
              amount: Number(collection.amount),
              currency,
              expectedAmount:
                Number(expectedAmount),
              cashierReference,
              snapshotItemCount:
                collections.length,
            },
          });
        }

        return {
          changed: true,
          action: 'SETTLEMENT_OPENED' as const,

          settlement:
            this.mapDriverCodCashSettlement(
              settlement,
              collections.length,
              collections.length,
            ),
        };
      },
    );
  }

  // =====================================================
  // FLASHDELIVERY COD - CERRAR LIQUIDACION
  // =====================================================

  async settleDriverCodCashSettlement(
    settlementId: string,
    input: SettleDriverCodCashSettlementInput,
  ) {
    this.assertCashierAccessKey(input.cashierAccessKey);

    const tenantCode =
      this.requireCashCode(input.tenantCode, 'tenantCode');

    const branchCode =
      this.requireCashCode(input.branchCode, 'branchCode');

    const receivedAmount =
      this.requireSettlementReceivedAmount(
        input.receivedAmount,
      );

    const cashierReference =
      this.requireAuditReference(
        input.cashierReference,
        'cashierReference',
      );

    const idempotencyToken =
      this.requireIdempotencyToken(input.idempotencyKey);

    const eventKey =
      `driver-cod-settlement-settle:${settlementId}:${idempotencyToken}`;

    return this.databaseService.withTransaction(
      async (client) => {
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
          throw new NotFoundException(
            'Tenant/branch payment scope not found',
          );
        }

        const settlementResult =
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

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid

              for update
            `,
            [
              scope.tenant_id,
              scope.branch_id,
              settlementId,
            ],
          );

        const settlement =
          settlementResult.rows[0];

        if (!settlement) {
          throw new NotFoundException(
            'Cash settlement not found',
          );
        }

        const items =
          await this.loadDriverCodCashSettlementItems(
            client,
            settlement.id,
          );

        if (settlement.status === 'SETTLED') {
          const replayEventResult =
            await client.query<{
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

          const replayEvent =
            replayEventResult.rows[0];

          const eventCount =
            Number(replayEvent?.event_count ?? 0);

          const referenceCount =
            Number(replayEvent?.reference_count ?? 0);

          const sameAmount =
            settlement.received_amount !== null &&
            Number(settlement.received_amount) ===
              Number(receivedAmount);

          if (
            sameAmount &&
            items.length > 0 &&
            eventCount === items.length &&
            referenceCount === eventCount
          ) {
            return {
              changed: false,
              action: 'UNCHANGED' as const,

              settlement:
                this.mapDriverCodCashSettlement(
                  settlement,
                  items.length,
                  items.length,
                ),
            };
          }

          throw new ConflictException(
            'Cash settlement has already been settled',
          );
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

        const itemTotalResult =
          await client.query<{
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
            [
              scope.tenant_id,
              scope.branch_id,
              settlement.id,
            ],
          );

        const itemTotal =
          itemTotalResult.rows[0]?.item_total ?? '0';

        if (
          Number(itemTotal) !==
          Number(settlement.expected_amount)
        ) {
          throw new ConflictException(
            'Cash settlement expected amount does not match its snapshot',
          );
        }

        const updatedResult =
          await client.query<DriverCodCashSettlementRow>(
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
            [
              scope.tenant_id,
              scope.branch_id,
              settlement.id,
              receivedAmount,
            ],
          );

        const updated =
          updatedResult.rows[0];

        if (!updated) {
          throw new ConflictException(
            'Cash settlement could not be settled',
          );
        }

        for (const item of items) {
          await this.insertPaymentEvent(client, {
            tenantId: scope.tenant_id,
            branchId: scope.branch_id,
            paymentId: item.payment_id,
            eventType:
              'DRIVER_COD_CASH_SETTLEMENT_SETTLED',
            providerEventId: eventKey,
            source: 'RECONCILIATION',
            processingStatus: 'PROCESSED',
            payload: {
              settlementId: updated.id,
              driverId: updated.driver_id,
              collectionId: item.collection_id,
              amount: Number(item.amount),
              currency: updated.currency,
              expectedAmount:
                Number(updated.expected_amount),
              receivedAmount:
                Number(updated.received_amount),
              differenceAmount:
                Number(updated.difference_amount),
              cashierReference,
            },
          });
        }

        return {
          changed: true,
          action: 'SETTLEMENT_SETTLED' as const,

          settlement:
            this.mapDriverCodCashSettlement(
              updated,
              items.length,
              items.length,
            ),
        };
      },
    );
  }

  // =====================================================
  // FLASHDELIVERY COD - CANCELAR LIQUIDACION ABIERTA
  // =====================================================

  async cancelDriverCodCashSettlement(
    settlementId: string,
    input: CancelDriverCodCashSettlementInput,
  ) {
    this.assertCashierAccessKey(input.cashierAccessKey);

    const tenantCode =
      this.requireCashCode(input.tenantCode, 'tenantCode');

    const branchCode =
      this.requireCashCode(input.branchCode, 'branchCode');

    const cashierReference =
      this.requireAuditReference(
        input.cashierReference,
        'cashierReference',
      );

    const idempotencyToken =
      this.requireIdempotencyToken(input.idempotencyKey);

    const eventKey =
      `driver-cod-settlement-cancel:${settlementId}:${idempotencyToken}`;

    return this.databaseService.withTransaction(
      async (client) => {
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
          throw new NotFoundException(
            'Tenant/branch payment scope not found',
          );
        }

        const settlementResult =
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

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid

              for update
            `,
            [
              scope.tenant_id,
              scope.branch_id,
              settlementId,
            ],
          );

        const settlement =
          settlementResult.rows[0];

        if (!settlement) {
          throw new NotFoundException(
            'Cash settlement not found',
          );
        }

        if (settlement.status === 'CANCELLED') {
          const replayEventResult =
            await client.query<{
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

          const replayEvent =
            replayEventResult.rows[0];

          const eventCount =
            Number(replayEvent?.event_count ?? 0);

          const referenceCount =
            Number(replayEvent?.reference_count ?? 0);

          if (
            eventCount > 0 &&
            referenceCount === eventCount
          ) {
            return {
              changed: false,
              action: 'UNCHANGED' as const,
              releasedItemCount: eventCount,

              settlement:
                this.mapDriverCodCashSettlement(
                  settlement,
                  0,
                  eventCount,
                ),
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

        const items =
          await this.loadDriverCodCashSettlementItems(
            client,
            settlement.id,
          );

        if (items.length === 0) {
          throw new ConflictException(
            'Open cash settlement has no snapshot items',
          );
        }

        for (const item of items) {
          await this.insertPaymentEvent(client, {
            tenantId: scope.tenant_id,
            branchId: scope.branch_id,
            paymentId: item.payment_id,
            eventType:
              'DRIVER_COD_CASH_SETTLEMENT_CANCELLED',
            providerEventId: eventKey,
            source: 'RECONCILIATION',
            processingStatus: 'PROCESSED',
            payload: {
              settlementId: settlement.id,
              driverId: settlement.driver_id,
              collectionId: item.collection_id,
              amount: Number(item.amount),
              currency: settlement.currency,
              expectedAmount:
                Number(settlement.expected_amount),
              cashierReference,
            },
          });
        }

        const deleteItemsResult =
          await client.query(
            `
              delete from public.delivery_cash_settlement_items

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and settlement_id = $3::uuid
            `,
            [
              scope.tenant_id,
              scope.branch_id,
              settlement.id,
            ],
          );

        if (
          (deleteItemsResult.rowCount ?? 0) !==
          items.length
        ) {
          throw new ConflictException(
            'Cash settlement items were not released completely',
          );
        }

        const updatedResult =
          await client.query<DriverCodCashSettlementRow>(
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
            [
              scope.tenant_id,
              scope.branch_id,
              settlement.id,
            ],
          );

        const updated =
          updatedResult.rows[0];

        if (!updated) {
          throw new ConflictException(
            'Cash settlement could not be cancelled',
          );
        }

        return {
          changed: true,
          action: 'SETTLEMENT_CANCELLED' as const,
          releasedItemCount: items.length,

          settlement:
            this.mapDriverCodCashSettlement(
              updated,
              0,
              items.length,
            ),
        };
      },
    );
  }
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

      const activeDriverCod =
        blockingResult.rows.find(
          (payment) =>
            payment.method === 'CASH' &&
            payment.provider
              .trim()
              .toUpperCase() ===
              'DRIVER_COD' &&
            payment.status ===
              'AWAITING_CONFIRMATION',
        );

      if (activeDriverCod) {
        const deliveryResult =
          await client.query<{
            status: string;
          }>(
            `
              select
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
          deliveryResult.rows[0] ??
          null;

        if (!delivery) {
          throw new ConflictException(
            'Cash on delivery state is inconsistent',
          );
        }

        if (
          delivery.status !== 'CREATED'
        ) {
          throw new ConflictException(
            'Payment method is locked after delivery dispatch',
          );
        }
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

  private requireSettlementUuid(
    value: string | undefined,
    field: string,
  ): string {
    const normalized =
      value?.trim().toLowerCase() || '';

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        normalized,
      )
    ) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }

    return normalized;
  }

  private requireSettlementCurrency(
    value: string | undefined,
  ): string {
    const normalized =
      value?.trim().toUpperCase() || '';

    if (!/^[A-Z]{3}$/.test(normalized)) {
      throw new BadRequestException(
        'currency must be a three-letter ISO code',
      );
    }

    return normalized;
  }

  private requireSettlementReceivedAmount(
    value: unknown,
  ): string {
    const normalized =
      String(value ?? '').trim();

    if (
      !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(
        normalized,
      )
    ) {
      throw new BadRequestException(
        'receivedAmount is invalid',
      );
    }

    return normalized;
  }

  private requireOptionalSettlementNotes(
    value: string | undefined,
  ): string | null {
    const normalized =
      value?.trim() || '';

    if (!normalized) {
      return null;
    }

    if (
      normalized.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(
        normalized,
      )
    ) {
      throw new BadRequestException(
        'notes is invalid',
      );
    }

    return normalized;
  }

  private async loadDriverCodCashSettlementItems(
    client: PoolClient,
    settlementId: string,
  ): Promise<
    DriverCodCashSettlementItemPaymentRow[]
  > {
    const result =
      await client.query<DriverCodCashSettlementItemPaymentRow>(
        `
          select
            si.id::text,
            si.collection_id::text,
            c.payment_id::text,
            si.amount::text,
            si.currency

          from public.delivery_cash_settlement_items si

          inner join public.delivery_cash_collections c
            on c.tenant_id = si.tenant_id
           and c.branch_id = si.branch_id
           and c.id = si.collection_id

          where si.settlement_id = $1::uuid

          order by
            si.created_at,
            si.id
        `,
        [settlementId],
      );

    return result.rows;
  }

  private mapDriverCodCashSettlement(
    settlement: DriverCodCashSettlementRow,
    itemCount: number,
    snapshotItemCount: number = itemCount,
  ) {
    return {
      id: settlement.id,
      status: settlement.status,

      driverId:
        settlement.driver_id,

      currency:
        settlement.currency,

      expectedAmount:
        Number(settlement.expected_amount),

      receivedAmount:
        settlement.received_amount === null
          ? null
          : Number(
              settlement.received_amount,
            ),

      differenceAmount:
        settlement.difference_amount === null
          ? null
          : Number(
              settlement.difference_amount,
            ),

      itemCount,
      snapshotItemCount,

      openedAt:
        settlement.opened_at,

      settledAt:
        settlement.settled_at,

      cancelledAt:
        settlement.cancelled_at,

      notes:
        settlement.notes,

      updatedAt:
        settlement.updated_at,
    };
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

  private requireCashAmount(value: unknown): string {
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
        | 'DRIVER'
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
