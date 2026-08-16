import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';
import { MockQrProvider } from './mock-qr.provider';

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
  expires_at: string | Date | null;
  paid_at: string | Date | null;
  verified_at: string | Date | null;
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
  payment_expires_at: string | Date | null;
  payment_paid_at: string | Date | null;
  payment_verified_at: string | Date | null;
  payment_created_at: string | Date | null;
  payment_updated_at: string | Date | null;
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
  ) {}

  // =====================================================
  // CREAR O REUTILIZAR INTENTO QR
  // =====================================================

  async createQrPayment(trackingToken: string) {
    const provider = this.getMockProvider();

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
                    'AWAITING_CONFIRMATION'
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
          activePayment?.expires_at &&
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
            provider.name,
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
                    expires_at =
                      $4::timestamptz
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
          : 'Unknown mock provider error';

      await this.databaseService.withTransaction(async (client) => {
        await client.query(
          `
              update public.order_payments
              set status = 'FAILED'
              where id = $1::uuid
                and status = 'CREATED'
            `,
          [prepared.payment.id],
        );

        await client.query(
          `
              update public.orders
              set payment_status = 'FAILED'
              where id = $1::uuid
                and payment_status <> 'PAID'
            `,
          [prepared.order.id],
        );

        await this.insertPaymentEvent(client, {
          tenantId: prepared.payment.tenant_id,
          branchId: prepared.payment.branch_id,
          paymentId: prepared.payment.id,
          eventType: 'QR_CREATION_FAILED',
          source: 'SYSTEM',
          processingStatus: 'FAILED',
          payload: {
            provider: provider.name,
          },
          errorMessage: message,
        });
      });

      if (error instanceof ConflictException) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'QR payment provider is not available',
      );
    }
  }

  // =====================================================
  // CONSULTA PÚBLICA POR TRACKING TOKEN
  // =====================================================

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
  // CONFIRMACIÓN MOCK - SOLO LABORATORIO
  // =====================================================

  async confirmMockPayment(paymentId: string) {
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

  private getMockProvider(): MockQrProvider {
    const configuredProvider = (
      this.configService.get<string>('PAYMENT_PROVIDER') || 'MOCK'
    )
      .trim()
      .toUpperCase();

    if (configuredProvider !== 'MOCK') {
      throw new ServiceUnavailableException(
        `Payment provider ${configuredProvider} is not implemented`,
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

      expiresAt: payment.expires_at,

      paidAt: payment.paid_at,

      verifiedAt: payment.verified_at,

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

      expires_at: row.payment_expires_at,

      paid_at: row.payment_paid_at,

      verified_at: row.payment_verified_at,

      created_at: row.payment_created_at!,

      updated_at: row.payment_updated_at!,
    });
  }
}
