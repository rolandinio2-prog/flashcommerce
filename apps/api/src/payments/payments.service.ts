import type { StaffSessionPrincipal } from '../core/staff/staff.types';
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
import { DatabaseService } from '../core/database/database.service';
import { BcpQrProvider } from './bcp-qr.provider';
import { MockQrProvider } from './mock-qr.provider';
import type { PaymentProvider } from './payment-provider';
import {
  type OrderStatus,
  type OrderPaymentStatus,
  type PaymentAttemptStatus,
  type PaymentAttemptRow,
  type PaymentTrackingRow,
  type PreparedQrPayment,
  loadOrderForPayment,
  assertOrderCanReceivePayment,
  insertPaymentEvent,
  mapPaymentResponse,
  mapOrder,
  mapPayment,
  mapPaymentFromTracking,
  providerByName,
} from './payment-shared';
import { DriverCodCashService } from './driver-cod-cash.service';
import { BcpQrCallbackService } from './bcp-qr-callback.service';
import { CashPaymentService } from './cash-payment.service';

export type {
  BcpQrCallbackInput,
  DriverCodCashCollectionInput,
} from './payment-shared';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    private readonly mockQrProvider: MockQrProvider,
    private readonly bcpQrProvider: BcpQrProvider,
    private readonly driverCodCash: DriverCodCashService,
    private readonly bcpQrCallback: BcpQrCallbackService,
    private readonly cashPayment: CashPaymentService,
  ) {}

  // ---- moved to domain services (R2); kept here so callers keep one entry point
  createDriverCodPayment(
    ...args: Parameters<DriverCodCashService['createDriverCodPayment']>
  ) {
    return this.driverCodCash.createDriverCodPayment(...args);
  }

  collectDriverCodCash(
    ...args: Parameters<DriverCodCashService['collectDriverCodCash']>
  ) {
    return this.driverCodCash.collectDriverCodCash(...args);
  }

  openDriverCodCashSettlement(
    ...args: Parameters<DriverCodCashService['openDriverCodCashSettlement']>
  ) {
    return this.driverCodCash.openDriverCodCashSettlement(...args);
  }

  settleDriverCodCashSettlement(
    ...args: Parameters<DriverCodCashService['settleDriverCodCashSettlement']>
  ) {
    return this.driverCodCash.settleDriverCodCashSettlement(...args);
  }

  cancelDriverCodCashSettlement(
    ...args: Parameters<DriverCodCashService['cancelDriverCodCashSettlement']>
  ) {
    return this.driverCodCash.cancelDriverCodCashSettlement(...args);
  }

  reconcileReviewRequiredByOrderNumber(
    ...args: Parameters<
      BcpQrCallbackService['reconcileReviewRequiredByOrderNumber']
    >
  ) {
    return this.bcpQrCallback.reconcileReviewRequiredByOrderNumber(...args);
  }

  handleBcpQrCallback(
    ...args: Parameters<BcpQrCallbackService['handleBcpQrCallback']>
  ) {
    return this.bcpQrCallback.handleBcpQrCallback(...args);
  }

  confirmCashPayment(
    ...args: Parameters<CashPaymentService['confirmCashPayment']>
  ) {
    return this.cashPayment.confirmCashPayment(...args);
  }

  async createQrPayment(trackingToken: string, customerPhoneInput?: unknown) {
    const configuredProvider = this.getPaymentProvider();

    const expiresAt = new Date(Date.now() + this.getQrTtlSeconds() * 1000);

    const prepared = await this.databaseService.withTransaction(
      async (client): Promise<PreparedQrPayment> => {
        const order = await loadOrderForPayment(client, trackingToken);

        assertOrderCanReceivePayment(order);

        // Validate before reserving an attempt; the order row is already locked.
        const prepareContact = async (providerName: string): Promise<void> => {
          if (providerName !== 'BCP_QR') return;
          const existingPhone = order.customer_phone?.trim() || '';
          const phone =
            existingPhone ||
            (typeof customerPhoneInput === 'string'
              ? customerPhoneInput.trim()
              : '');
          if (
            !/^\+?[0-9 ()-]{7,25}$/.test(phone) ||
            !/^[0-9]{7,15}$/.test(phone.replace(/\D/g, ''))
          ) {
            throw new BadRequestException(
              'Ingresa un telefono valido de 7 a 15 digitos para generar el QR.',
            );
          }
          if (!order.branch_name?.trim()) {
            throw new ServiceUnavailableException(
              'La sucursal debe completar sus datos para habilitar el pago QR.',
            );
          }
          if (!existingPhone) {
            await client.query(
              'update public.orders set customer_phone = $4 where id = $1::uuid and tenant_id = $2::uuid and branch_id = $3::uuid',
              [order.id, order.tenant_id, order.branch_id, phone],
            );
            order.customer_phone = phone;
          }
        };

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

          await insertPaymentEvent(client, {
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
          if (
            activePayment.status === 'CREATED' &&
            !activePayment.provider_payment_id
          ) {
            await prepareContact(activePayment.provider);
          }
          return {
            order,
            payment: activePayment,
            shouldGenerate:
              activePayment.status === 'CREATED' &&
              !activePayment.provider_payment_id,
          };
        }

        await prepareContact(configuredProvider.name);

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
      return mapPaymentResponse(prepared.order, prepared.payment, true);
    }

    try {
      const provider = providerByName(
        this.mockQrProvider,
        this.bcpQrProvider,
        prepared.payment.provider,
      );

      const providerResult = await provider.createQrPayment({
        paymentId: prepared.payment.id,
        orderId: prepared.order.id,
        externalReference: prepared.payment.external_reference!,
        amount: prepared.payment.amount,
        currency: prepared.payment.currency,
        customerPhone: prepared.order.customer_phone,
        branchOffice: prepared.order.branch_name,
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

          await insertPaymentEvent(client, {
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

      return mapPaymentResponse(
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

        await insertPaymentEvent(client, {
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
      order: mapOrder(row),

      payment: row.payment_id
        ? mapPayment({
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
  // CONFIRMACIÃ“N MOCK - SOLO LABORATORIO
  // =====================================================

  async confirmMockPayment(
    paymentId: string,
    labAccessKey: string | undefined,
    principal: Pick<StaffSessionPrincipal, 'tenantId' | 'branchId'>,
  ) {
    this.assertMockConfirmationAllowed(labAccessKey);
    return this.markMockPaymentPaid(paymentId, principal);
  }

  /**
   * Admin dev-tools entry (QR payment simulator). Access is guarded by
   * AdminDevQrPaymentService (ADMIN + PAYMENT_DEV_TOOLS_ENABLED + sandbox);
   * only available when this environment is configured with the MOCK provider.
   */
  async confirmMockPaymentForDevTools(
    paymentId: string,
    principal: Pick<StaffSessionPrincipal, 'tenantId' | 'branchId'>,
  ) {
    const configuredProvider = (
      this.configService.get<string>('PAYMENT_PROVIDER') || ''
    )
      .trim()
      .toUpperCase();
    if (configuredProvider !== 'MOCK') {
      throw new NotFoundException('Resource not found');
    }
    return this.markMockPaymentPaid(paymentId, principal);
  }

  private async markMockPaymentPaid(
    paymentId: string,
    principal: Pick<StaffSessionPrincipal, 'tenantId' | 'branchId'>,
  ) {
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
                and p.tenant_id = $2::uuid and p.branch_id = $3::uuid

              for update of p, o
            `,
        [paymentId, principal.tenantId, principal.branchId],
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
          order: mapOrder(row),
          payment: mapPaymentFromTracking(row),
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

      await insertPaymentEvent(client, {
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

        order: mapOrder({
          ...row,

          status: updatedOrder.status,

          payment_status: updatedOrder.payment_status,
        }),

        payment: mapPayment(payment),
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

      await insertPaymentEvent(client, {
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
}
