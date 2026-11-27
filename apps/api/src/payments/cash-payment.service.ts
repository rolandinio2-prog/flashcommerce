import { assertLocalCashAllowed } from './delivery-payment-policy';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../core/database/database.service';
import { BcpQrProvider } from './bcp-qr.provider';
import { MockQrProvider } from './mock-qr.provider';
import {
  type OrderStatus,
  type OrderPaymentStatus,
  type PaymentAttemptStatus,
  type PaymentOrderRow,
  type PaymentAttemptRow,
  type ConfirmCashPaymentInput,
  requireSettlementUuid,
  requireCashCode,
  requireAuditReference,
  requireIdempotencyToken,
  requireCashAmount,
  insertPaymentEvent,
  mapOrder,
  mapPayment,
  providerByName,
} from './payment-shared';

/** Cash payment confirmed by a cashier at the counter. */
@Injectable()
export class CashPaymentService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly mockQrProvider: MockQrProvider,
    private readonly bcpQrProvider: BcpQrProvider,
  ) {}

  async confirmCashPayment(orderId: string, input: ConfirmCashPaymentInput) {
    const tenantCode = requireCashCode(input.tenantCode, 'tenantCode');

    const branchCode = requireCashCode(input.branchCode, 'branchCode');

    const cashReceivedAmount = requireCashAmount(input.cashReceivedAmount);

    const operatorUserId = requireSettlementUuid(
      input.operatorUserId,
      'operatorUserId',
    );

    const operatorCode = requireAuditReference(
      input.operatorCode,
      'operatorCode',
    );

    const operatorDisplayName = requireAuditReference(
      input.operatorDisplayName,
      'operatorDisplayName',
    );

    const terminalReference = requireAuditReference(
      input.terminalReference,
      'terminalReference',
    );

    const idempotencyToken = requireIdempotencyToken(input.idempotencyKey);

    const cashResult = await this.databaseService.withTransaction(
      async (client) => {
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
                o.order_type,
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

        assertLocalCashAllowed(order.order_type ?? '');
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
            order: mapOrder(order),
            payment: mapPayment(existingPayment),
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

        const activeDriverCod = blockingResult.rows.find(
          (payment) =>
            payment.method === 'CASH' &&
            payment.provider.trim().toUpperCase() === 'DRIVER_COD' &&
            payment.status === 'AWAITING_CONFIRMATION',
        );

        if (activeDriverCod) {
          const deliveryResult = await client.query<{
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
            [order.tenant_id, order.branch_id, order.id],
          );

          const delivery = deliveryResult.rows[0] ?? null;

          if (!delivery) {
            throw new ConflictException(
              'Cash on delivery state is inconsistent',
            );
          }

          if (delivery.status !== 'CREATED') {
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

          await insertPaymentEvent(client, {
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
              operatorUserId,
              operatorCode,
              operatorDisplayName,
              terminalReference,
            },
            errorMessage: message.slice(0, 500),
          });

          return {
            reconciliationRequired: true as const,
          };
        };

        for (const activePayment of blockingResult.rows) {
          const normalizedProvider = activePayment.provider
            .trim()
            .toUpperCase();

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
              const provider = providerByName(
                this.mockQrProvider,
                this.bcpQrProvider,
                activePayment.provider,
              );

              const cancellation = await provider.cancelQrPayment({
                providerPaymentId: activePayment.provider_payment_id,
                reason: 'CASH_PAYMENT_REPLACED_ACTIVE_ATTEMPT',
              });

              if (
                cancellation.status !== 'CANCELLED' ||
                cancellation.providerPaymentId !==
                  activePayment.provider_payment_id
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

          await insertPaymentEvent(client, {
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
                activePayment.method === 'QR' &&
                normalizedProvider === 'BCP_QR',

              operatorUserId,

              operatorCode,

              operatorDisplayName,

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
                $11::uuid,
                $12::numeric,
                $12::numeric - $5::numeric
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
            operatorUserId,
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

        await insertPaymentEvent(client, {
          tenantId: payment.tenant_id,

          branchId: payment.branch_id,

          paymentId: payment.id,

          eventType: 'CASH_PAYMENT_CONFIRMED',

          providerEventId: transactionId,

          source: 'CASHIER',

          processingStatus: 'PROCESSED',

          payload: {
            operatorUserId,

            operatorCode,

            operatorDisplayName,

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

          order: mapOrder({
            ...order,

            status: updatedOrder.status,

            payment_status: updatedOrder.payment_status,
          }),

          payment: mapPayment(payment),
        };
      },
    );

    if ('reconciliationRequired' in cashResult) {
      throw new ServiceUnavailableException(
        'QR cancellation requires reconciliation before cash payment',
      );
    }

    return cashResult;
  }
}
