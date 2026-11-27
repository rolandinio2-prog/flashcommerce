import type { StaffSessionPrincipal } from '../core/staff/staff.types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../core/database/database.service';
import { BcpQrProvider } from './bcp-qr.provider';
import {
  type OrderStatus,
  type OrderPaymentStatus,
  type PaymentAttemptStatus,
  type PaymentAttemptRow,
  type BcpQrCallbackInput,
  insertPaymentEvent,
} from './payment-shared';

/** BCP QR: the bank payment callback and the Ops REVIEW_REQUIRED reconciliation against the provider. */
@Injectable()
export class BcpQrCallbackService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    private readonly bcpQrProvider: BcpQrProvider,
  ) {}

  // =====================================================
  // CREAR O REUTILIZAR INTENTO QR
  // =====================================================

  // =====================================================
  // OPS REVIEW_REQUIRED RECONCILIATION - PROVIDER TRUTH
  // R6.13.4.8.3
  // =====================================================
  async reconcileReviewRequiredByOrderNumber(
    orderNumber: string,
    principal: Pick<StaffSessionPrincipal, 'tenantId' | 'branchId'>,
  ) {
    const normalizedOrderNumber = String(orderNumber ?? '').trim();

    if (!normalizedOrderNumber || normalizedOrderNumber.length > 64) {
      throw new BadRequestException('orderNumber is invalid');
    }

    const snapshot = await this.databaseService.withTransaction(
      async (client) => {
        const orderResult = await client.query<{
          id: string;
          order_number: string;
          status: OrderStatus;
          payment_status: OrderPaymentStatus;
          reservation_id: string | null;
          reservation_status: string | null;
        }>(
          `
            select
              o.id::text,
              o.order_number::text,
              o.status,
              o.payment_status,
              o.reservation_id::text,
              r.status as reservation_status
            from public.orders o
            left join public.table_reservations r
              on r.id = o.reservation_id
            where o.order_number::text = $1
            and o.tenant_id = $2::uuid and o.branch_id = $3::uuid
            order by o.created_at desc
            limit 2
          `,
          [normalizedOrderNumber, principal.tenantId, principal.branchId],
        );

        if (orderResult.rows.length === 0) {
          throw new NotFoundException('Order was not found');
        }

        if (orderResult.rows.length !== 1) {
          throw new ConflictException('Order number is ambiguous');
        }

        const order = orderResult.rows[0];

        const paymentResult = await client.query<{
          id: string;
          tenant_id: string;
          branch_id: string;
          order_id: string;
          provider: string;
          status: PaymentAttemptStatus;
          provider_payment_id: string | null;
          provider_transaction_id: string | null;
          paid_at: string | Date | null;
          verified_at: string | Date | null;
        }>(
          `
            select
              id::text,
              tenant_id::text,
              branch_id::text,
              order_id::text,
              provider,
              status,
              provider_payment_id,
              provider_transaction_id,
              paid_at,
              verified_at
            from public.order_payments
            where order_id = $1::uuid
              and method = 'QR'
              and provider = 'BCP_QR'
            order by attempt_number desc
            limit 1
          `,
          [order.id],
        );

        const payment = paymentResult.rows[0];

        if (!payment) {
          throw new ConflictException('BCP QR payment was not found');
        }

        if (order.payment_status === 'PAID' && payment.status === 'PAID') {
          return {
            action: 'ALREADY_PAID' as const,
            orderNumber: order.order_number,
            orderStatus: order.status,
            paymentStatus: order.payment_status,
            providerPaymentId: null as string | null,
          };
        }

        if (
          order.payment_status !== 'REVIEW_REQUIRED' ||
          payment.status !== 'REVIEW_REQUIRED'
        ) {
          throw new ConflictException(
            'Payment is not eligible for reconciliation',
          );
        }

        if (!payment.provider_payment_id) {
          throw new ConflictException('BCP provider reference is unavailable');
        }

        return {
          action: 'QUERY_PROVIDER' as const,
          orderNumber: order.order_number,
          orderStatus: order.status,
          paymentStatus: order.payment_status,
          providerPaymentId: payment.provider_payment_id,
        };
      },
    );

    if (snapshot.action === 'ALREADY_PAID') {
      return {
        changed: false,
        action: 'UNCHANGED' as const,
        orderNumber: snapshot.orderNumber,
        orderStatus: snapshot.orderStatus,
        paymentStatus: 'PAID' as const,
        providerStatus: 'PAID' as const,
      };
    }

    let providerTruth;

    try {
      providerTruth = await this.bcpQrProvider.getPaymentStatus(
        snapshot.providerPaymentId,
      );
    } catch {
      return {
        changed: false,
        action: 'REVIEW_REQUIRED' as const,
        orderNumber: snapshot.orderNumber,
        orderStatus: snapshot.orderStatus,
        paymentStatus: 'REVIEW_REQUIRED' as const,
        providerStatus: 'UNKNOWN' as const,
      };
    }

    const providerStatus = String(providerTruth.status ?? '')
      .trim()
      .toUpperCase();

    if (providerStatus === 'EXPIRED' || providerStatus === 'CANCELLED') {
      return this.applyBcpTerminalReconciliationByOrderNumber(
        String(orderNumber),
        providerStatus,
        principal,
      );
    }
    if (providerStatus !== 'PAID') {
      return {
        changed: false,
        action: 'REVIEW_REQUIRED' as const,
        orderNumber: snapshot.orderNumber,
        orderStatus: snapshot.orderStatus,
        paymentStatus: 'REVIEW_REQUIRED' as const,
        providerStatus,
      };
    }

    const providerTransactionId =
      providerTruth.providerTransactionId?.trim() || '';

    const paidAt = providerTruth.paidAt ? new Date(providerTruth.paidAt) : null;

    if (!providerTransactionId || !paidAt || Number.isNaN(paidAt.getTime())) {
      return {
        changed: false,
        action: 'REVIEW_REQUIRED' as const,
        orderNumber: snapshot.orderNumber,
        orderStatus: snapshot.orderStatus,
        paymentStatus: 'REVIEW_REQUIRED' as const,
        providerStatus: 'UNKNOWN' as const,
      };
    }

    return this.databaseService.withTransaction(async (client) => {
      const orderResult = await client.query<{
        id: string;
        order_number: string;
        status: OrderStatus;
        payment_status: OrderPaymentStatus;
        reservation_id: string | null;
        reservation_status: string | null;
      }>(
        `
          select
            o.id::text,
            o.order_number::text,
            o.status,
            o.payment_status,
            o.reservation_id::text,
            r.status as reservation_status
          from public.orders o
          left join public.table_reservations r
            on r.id = o.reservation_id
          where o.order_number::text = $1
            and o.tenant_id = $2::uuid and o.branch_id = $3::uuid
          limit 1
          for update of o
        `,
        [snapshot.orderNumber, principal.tenantId, principal.branchId],
      );

      const order = orderResult.rows[0];

      if (!order) {
        throw new ConflictException('Order changed during reconciliation');
      }

      const paymentResult = await client.query<{
        id: string;
        tenant_id: string;
        branch_id: string;
        order_id: string;
        provider: string;
        status: PaymentAttemptStatus;
        provider_payment_id: string | null;
      }>(
        `
          select
            id::text,
            tenant_id::text,
            branch_id::text,
            order_id::text,
            provider,
            status,
            provider_payment_id
          from public.order_payments
          where order_id = $1::uuid
            and method = 'QR'
            and provider = 'BCP_QR'
          order by attempt_number desc
          limit 1
          for update
        `,
        [order.id],
      );

      const payment = paymentResult.rows[0];

      if (!payment) {
        throw new ConflictException('Payment changed during reconciliation');
      }

      if (order.payment_status === 'PAID' && payment.status === 'PAID') {
        return {
          changed: false,
          action: 'UNCHANGED' as const,
          orderNumber: order.order_number,
          orderStatus: order.status,
          paymentStatus: 'PAID' as const,
          providerStatus: 'PAID' as const,
        };
      }

      if (
        order.payment_status !== 'REVIEW_REQUIRED' ||
        payment.status !== 'REVIEW_REQUIRED'
      ) {
        throw new ConflictException(
          'Payment state changed during reconciliation',
        );
      }

      if (payment.provider_payment_id !== snapshot.providerPaymentId) {
        throw new ConflictException(
          'Provider reference changed during reconciliation',
        );
      }

      const paidPaymentResult = await client.query<{
        status: PaymentAttemptStatus;
      }>(
        `
          update public.order_payments
          set
            status = 'PAID',
            provider_transaction_id = $2,
            paid_at = $3::timestamptz,
            verified_at = now(),
            updated_at = now()
          where id = $1::uuid
            and status = 'REVIEW_REQUIRED'
          returning status
        `,
        [payment.id, providerTransactionId, paidAt.toISOString()],
      );

      if (paidPaymentResult.rows.length !== 1) {
        throw new ConflictException('Payment changed concurrently');
      }

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
          returning status, payment_status
        `,
        [order.id, reservationAllowsConfirmation],
      );

      const updatedOrder = updatedOrderResult.rows[0];

      if (!updatedOrder) {
        throw new ConflictException('Order changed concurrently');
      }

      await insertPaymentEvent(client, {
        tenantId: payment.tenant_id,
        branchId: payment.branch_id,
        paymentId: payment.id,
        eventType: 'RECONCILIATION',
        source: 'RECONCILIATION',
        processingStatus: 'PROCESSED',
        payload: {
          reason: 'OPS_PROVIDER_TRUTH_RECONCILIATION',
          provider: 'BCP_QR',
          providerStatus: 'PAID',
          orderNumber: order.order_number,
        },
      });

      return {
        changed: true,
        action: 'RECONCILED' as const,
        orderNumber: order.order_number,
        orderStatus: updatedOrder.status,
        paymentStatus: updatedOrder.payment_status,
        providerStatus: 'PAID' as const,
      };
    });
  }

  async handleBcpQrCallback(
    authorization: string | undefined,
    input: BcpQrCallbackInput,
  ) {
    const expectedUsername =
      this.requireBcpCallbackConfigurationValue('BCP_QR_USERNAME');

    const expectedPublicToken = this.requireBcpCallbackConfigurationValue(
      'BCP_QR_PUBLIC_TOKEN',
    );

    if (
      !this.isBcpCallbackAuthorizationValid(
        authorization,
        expectedUsername,
        expectedPublicToken,
      )
    ) {
      return this.buildBcpCallbackErrorResponse(
        '003',
        'Credenciales incorrectas',
      );
    }

    const callbackId = this.normalizeBcpCallbackId(input?.Id);

    const serviceCode = this.normalizeBcpCallbackText(input?.ServiceCode, 32);

    const businessCode = this.normalizeBcpCallbackText(input?.BusinessCode, 64);

    const idCorrelation = this.normalizeBcpCallbackText(
      input?.IdCorrelation,
      160,
    );

    const amount = this.normalizeBcpCallbackAmount(input?.Amount);

    const currency =
      this.normalizeBcpCallbackText(input?.Currency, 3)?.toUpperCase() ?? null;

    const responseCode = this.normalizeBcpCallbackText(input?.ResponseCode, 16);

    const status =
      this.normalizeBcpCallbackText(input?.Status, 16)?.toUpperCase() ?? null;

    const operationNumber = this.normalizeBcpCallbackText(
      input?.OperationNumber,
      160,
    );

    const expectedServiceCode = this.requireBcpCallbackConfigurationValue(
      'BCP_QR_SERVICE_CODE',
    );

    const expectedBusinessCode = this.requireBcpCallbackConfigurationValue(
      'BCP_QR_BUSINESS_CODE',
    );

    if (
      callbackId === null ||
      serviceCode === null ||
      businessCode === null ||
      idCorrelation === null ||
      amount === null ||
      currency === null ||
      responseCode !== '000' ||
      status !== 'P' ||
      operationNumber === null
    ) {
      return this.buildBcpCallbackErrorResponse('101', 'Notificacion invalida');
    }

    if (
      serviceCode !== expectedServiceCode ||
      businessCode !== expectedBusinessCode
    ) {
      return this.buildBcpCallbackErrorResponse(
        '102',
        'Notificacion no correlacionada',
      );
    }

    return this.databaseService.withTransaction(async (client) => {
      const paymentResult = await client.query<{
        id: string;
        tenant_id: string;
        branch_id: string;
        order_id: string;
        attempt_number: number;
        max_attempt_number: number;
        method: string;
        provider: string;
        status: PaymentAttemptStatus;
        amount: string;
        currency: string;
        external_reference: string | null;
        provider_payment_id: string | null;
        provider_transaction_id: string | null;
        paid_at: string | Date | null;
        verified_at: string | Date | null;
        order_status: OrderStatus;
        order_payment_status: OrderPaymentStatus;
        order_total: string;
        order_currency: string;
        reservation_id: string | null;
        reservation_status: string | null;
      }>(
        `
              select
                p.id::text,
                p.tenant_id::text,
                p.branch_id::text,
                p.order_id::text,
                p.attempt_number,
                (
                  select
                    max(p2.attempt_number)::int
                  from public.order_payments p2
                  where p2.tenant_id = p.tenant_id
                    and p2.branch_id = p.branch_id
                    and p2.order_id = p.order_id
                ) as max_attempt_number,
                p.method,
                p.provider,
                p.status,
                p.amount::text,
                p.currency,
                p.external_reference,
                p.provider_payment_id,
                p.provider_transaction_id,
                p.paid_at,
                p.verified_at,
                o.status as order_status,
                o.payment_status as order_payment_status,
                o.total::text as order_total,
                o.currency as order_currency,
                o.reservation_id::text,
                r.status as reservation_status
              from public.order_payments p
              inner join public.orders o
                on o.tenant_id = p.tenant_id
               and o.branch_id = p.branch_id
               and o.id = p.order_id
              left join public.table_reservations r
                on r.tenant_id = o.tenant_id
               and r.branch_id = o.branch_id
               and r.id = o.reservation_id
              where p.method = 'QR'
                and upper(p.provider) = 'BCP_QR'
                and p.provider_payment_id = $1
              for update of p, o
            `,
        [String(callbackId)],
      );

      if (paymentResult.rows.length !== 1) {
        return this.buildBcpCallbackErrorResponse(
          '102',
          'Notificacion no correlacionada',
        );
      }

      const payment = paymentResult.rows[0];

      const storedAmount = this.normalizeBcpCallbackAmount(payment.amount);

      const orderAmount = this.normalizeBcpCallbackAmount(payment.order_total);

      if (
        payment.external_reference !== idCorrelation ||
        storedAmount === null ||
        orderAmount === null ||
        storedAmount !== amount ||
        orderAmount !== amount ||
        payment.currency.toUpperCase() !== currency ||
        payment.order_currency.toUpperCase() !== currency ||
        payment.attempt_number !== payment.max_attempt_number
      ) {
        return this.buildBcpCallbackErrorResponse(
          '102',
          'Notificacion no correlacionada',
        );
      }

      if (
        payment.order_status === 'CANCELLED' ||
        payment.order_status === 'COMPLETED' ||
        payment.order_payment_status === 'NOT_REQUIRED' ||
        payment.order_payment_status === 'REFUND_PENDING' ||
        payment.order_payment_status === 'REFUNDED'
      ) {
        return this.buildBcpCallbackErrorResponse(
          '103',
          'Pago requiere conciliacion',
        );
      }

      const existingEventResult = await client.query<{
        event_type: string;
        source: string;
        processing_status: string;
      }>(
        `
              select
                event_type,
                source,
                processing_status
              from public.payment_events
              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and payment_id = $3::uuid
                and provider_event_id = $4
              limit 1
            `,
        [payment.tenant_id, payment.branch_id, payment.id, operationNumber],
      );

      const existingEvent = existingEventResult.rows[0] ?? null;

      if (payment.status === 'PAID') {
        if (
          payment.provider_transaction_id === operationNumber &&
          payment.paid_at !== null &&
          payment.verified_at !== null &&
          payment.order_payment_status === 'PAID'
        ) {
          if (
            existingEvent &&
            (existingEvent.event_type !== 'PAYMENT_CONFIRMED' ||
              existingEvent.processing_status !== 'PROCESSED')
          ) {
            return this.buildBcpCallbackErrorResponse(
              '103',
              'Pago requiere conciliacion',
            );
          }

          if (!existingEvent) {
            await insertPaymentEvent(client, {
              tenantId: payment.tenant_id,
              branchId: payment.branch_id,
              paymentId: payment.id,
              eventType: 'PAYMENT_CONFIRMED',
              providerEventId: operationNumber,
              source: 'PROVIDER_WEBHOOK',
              processingStatus: 'PROCESSED',
              payload: {
                provider: payment.provider,
                providerPaymentId: payment.provider_payment_id,
                providerTransactionId: operationNumber,
                callbackId,
                idCorrelation,
                amount: payment.amount,
                currency: payment.currency,
                responseCode,
                status,
              },
            });
          }

          return this.buildBcpCallbackSuccessResponse(callbackId);
        }

        return this.buildBcpCallbackErrorResponse(
          '103',
          'Pago requiere conciliacion',
        );
      }

      if (existingEvent) {
        return this.buildBcpCallbackErrorResponse(
          '103',
          'Pago requiere conciliacion',
        );
      }

      const transactionOwnerResult = await client.query<{
        id: string;
      }>(
        `
              select
                id::text
              from public.order_payments
              where tenant_id = $1::uuid
                and upper(provider) = 'BCP_QR'
                and provider_transaction_id = $2
                and id <> $3::uuid
              limit 1
            `,
        [payment.tenant_id, operationNumber, payment.id],
      );

      if (transactionOwnerResult.rows[0]) {
        return this.buildBcpCallbackErrorResponse(
          '103',
          'Pago requiere conciliacion',
        );
      }

      if (
        payment.provider_transaction_id !== null &&
        payment.provider_transaction_id !== operationNumber
      ) {
        return this.buildBcpCallbackErrorResponse(
          '103',
          'Pago requiere conciliacion',
        );
      }

      if (
        payment.status !== 'AWAITING_CONFIRMATION' &&
        payment.status !== 'REVIEW_REQUIRED' &&
        payment.status !== 'EXPIRED'
      ) {
        return this.buildBcpCallbackErrorResponse(
          '103',
          'Pago requiere conciliacion',
        );
      }

      const paidAt = new Date();

      const paidPaymentResult = await client.query<PaymentAttemptRow>(
        `
              update public.order_payments
              set
                status = 'PAID',
                provider_transaction_id = $2,
                paid_at = coalesce(
                  paid_at,
                  $3::timestamptz
                ),
                verified_at = $3::timestamptz,
                updated_at = now()
              where id = $1::uuid
                and status in (
                  'AWAITING_CONFIRMATION',
                  'REVIEW_REQUIRED',
                  'EXPIRED'
                )
                and (
                  provider_transaction_id is null
                  or provider_transaction_id = $2
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
        [payment.id, operationNumber, paidAt.toISOString()],
      );

      const paidPayment = paidPaymentResult.rows[0];

      if (!paidPayment) {
        return this.buildBcpCallbackErrorResponse(
          '103',
          'Pago requiere conciliacion',
        );
      }

      const reservationAllowsConfirmation =
        !payment.reservation_id ||
        payment.reservation_status === 'CONFIRMED' ||
        payment.reservation_status === 'SEATED';

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
                end,
                updated_at = now()
              where id = $1::uuid
                and status not in (
                  'CANCELLED',
                  'COMPLETED'
                )
                and payment_status not in (
                  'NOT_REQUIRED',
                  'REFUND_PENDING',
                  'REFUNDED'
                )
              returning
                status,
                payment_status
            `,
        [payment.order_id, reservationAllowsConfirmation],
      );

      const updatedOrder = orderResult.rows[0];

      if (!updatedOrder) {
        throw new ConflictException('Order payment state changed concurrently');
      }

      await insertPaymentEvent(client, {
        tenantId: paidPayment.tenant_id,
        branchId: paidPayment.branch_id,
        paymentId: paidPayment.id,
        eventType: 'PAYMENT_CONFIRMED',
        providerEventId: operationNumber,
        source: 'PROVIDER_WEBHOOK',
        processingStatus: 'PROCESSED',
        payload: {
          provider: paidPayment.provider,
          providerPaymentId: paidPayment.provider_payment_id,
          providerTransactionId: operationNumber,
          callbackId,
          idCorrelation,
          amount: paidPayment.amount,
          currency: paidPayment.currency,
          responseCode,
          status,
        },
      });

      return this.buildBcpCallbackSuccessResponse(callbackId);
    });
  }

  private requireBcpCallbackConfigurationValue(key: string): string {
    const value = (this.configService.get<string>(key) || '').trim();

    if (!value) {
      throw new ServiceUnavailableException(
        'BCP callback configuration is incomplete',
      );
    }

    return value;
  }

  private isBcpCallbackAuthorizationValid(
    authorization: string | undefined,
    expectedUsername: string,
    expectedPublicToken: string,
  ): boolean {
    const normalized = authorization?.trim() || '';

    const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(normalized);

    if (!match) {
      return false;
    }

    const encoded = match[1];

    if (encoded.length === 0 || encoded.length % 4 !== 0) {
      return false;
    }

    let decoded: string;

    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return false;
    }

    const separatorIndex = decoded.indexOf(':');

    if (separatorIndex <= 0) {
      return false;
    }

    const username = decoded.slice(0, separatorIndex);

    const publicToken = decoded.slice(separatorIndex + 1);

    return (
      this.secureBcpCallbackEquals(username, expectedUsername) &&
      this.secureBcpCallbackEquals(publicToken, expectedPublicToken)
    );
  }

  private secureBcpCallbackEquals(received: string, expected: string): boolean {
    const receivedBuffer = Buffer.from(received, 'utf8');

    const expectedBuffer = Buffer.from(expected, 'utf8');

    if (receivedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(receivedBuffer, expectedBuffer);
  }

  private normalizeBcpCallbackId(value: unknown): number | null {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return value;
    }

    if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value.trim())) {
      const parsed = Number(value.trim());

      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  }

  private normalizeBcpCallbackText(
    value: unknown,
    maxLength: number,
  ): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();

    if (
      normalized.length === 0 ||
      normalized.length > maxLength ||
      // eslint-disable-next-line no-control-regex -- intentionally rejects control characters in user/provider input
      /[\u0000-\u001F\u007F]/.test(normalized)
    ) {
      return null;
    }

    return normalized;
  }

  private normalizeBcpCallbackAmount(value: unknown): string | null {
    const text =
      typeof value === 'number'
        ? String(value)
        : typeof value === 'string'
          ? value.trim()
          : '';

    if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(text)) {
      return null;
    }

    const parts = text.split('.');

    const whole = parts[0];

    const fraction = (parts[1] || '').padEnd(2, '0');

    return `${whole}.${fraction}`;
  }

  private buildBcpCallbackSuccessResponse(callbackId: number) {
    return {
      State: '000',
      Message: 'Correcto',
      Data: {
        id: callbackId,
      },
    };
  }

  private buildBcpCallbackErrorResponse(
    state: '003' | '101' | '102' | '103',
    message: string,
  ) {
    return {
      State: state,
      Message: message,
      Data: {
        id: `E-${randomUUID()}`,
      },
    };
  }

  private async applyBcpTerminalReconciliationByOrderNumber(
    orderNumber: string,
    terminalStatus: 'EXPIRED' | 'CANCELLED',
    principal: Pick<StaffSessionPrincipal, 'tenantId' | 'branchId'>,
  ) {
    return this.databaseService.withTransaction(async (client) => {
      const lockedResult = await client.query<{
        tenant_id: string;
        branch_id: string;
        payment_id: string;
        payment_status: PaymentAttemptStatus;
        payment_provider: string;
        order_id: string;
        order_status: OrderStatus;
        order_payment_status: OrderPaymentStatus;
      }>(
        `
          select
            p.tenant_id::text as tenant_id,
            p.branch_id::text as branch_id,
            p.id::text as payment_id,
            p.status as payment_status,
            p.provider as payment_provider,
            o.id::text as order_id,
            o.status as order_status,
            o.payment_status as order_payment_status
          from public.orders o
          inner join public.order_payments p
            on p.tenant_id = o.tenant_id
           and p.branch_id = o.branch_id
           and p.order_id = o.id
          where o.order_number::text = $1
            and o.tenant_id = $2::uuid and o.branch_id = $3::uuid
            and p.method = 'QR'
            and upper(p.provider) = 'BCP_QR'
          order by p.attempt_number desc
          limit 1
          for update of o, p
        `,
        [orderNumber, principal.tenantId, principal.branchId],
      );

      const row = lockedResult.rows[0];

      if (!row) {
        throw new NotFoundException(
          'Order payment not found for reconciliation',
        );
      }

      if (String(row.payment_provider).trim().toUpperCase() !== 'BCP_QR') {
        throw new ConflictException(
          'Payment provider changed during reconciliation',
        );
      }

      if (
        row.payment_status === terminalStatus &&
        row.order_payment_status === terminalStatus
      ) {
        return {
          reconciled: true as const,
          providerStatus: terminalStatus,
          paymentStatus: row.payment_status,
          orderStatus: row.order_status,
          orderPaymentStatus: row.order_payment_status,
        };
      }

      if (row.payment_status !== 'REVIEW_REQUIRED') {
        throw new ConflictException(
          'Payment status changed during reconciliation',
        );
      }

      if (row.order_payment_status !== 'REVIEW_REQUIRED') {
        throw new ConflictException(
          'Order payment status changed during reconciliation',
        );
      }

      const paymentUpdate = await client.query(
        `
          update public.order_payments
          set
            status = $2,
            updated_at = now()
          where id = $1::uuid
            and status = 'REVIEW_REQUIRED'
          returning id::text
        `,
        [row.payment_id, terminalStatus],
      );

      if (paymentUpdate.rowCount !== 1) {
        throw new ConflictException(
          'Payment terminal reconciliation write was not applied',
        );
      }

      const orderUpdate = await client.query<{
        status: OrderStatus;
        payment_status: OrderPaymentStatus;
      }>(
        `
          update public.orders
          set
            payment_status = $2,
            updated_at = now()
          where id = $1::uuid
            and payment_status = 'REVIEW_REQUIRED'
          returning status, payment_status
        `,
        [row.order_id, terminalStatus],
      );

      if (orderUpdate.rowCount !== 1) {
        throw new ConflictException(
          'Order terminal payment reconciliation write was not applied',
        );
      }

      const updatedOrder = orderUpdate.rows[0];

      await insertPaymentEvent(client, {
        tenantId: row.tenant_id,
        branchId: row.branch_id,
        paymentId: row.payment_id,
        eventType:
          terminalStatus === 'EXPIRED'
            ? 'PAYMENT_EXPIRED'
            : 'PAYMENT_CANCELLED',
        source: 'RECONCILIATION',
        processingStatus: 'PROCESSED',
        payload: {
          reason: 'BCP_PROVIDER_TERMINAL_STATUS_CONFIRMED',
          provider: 'BCP_QR',
          providerStatus: terminalStatus,
        },
      });

      return {
        reconciled: true as const,
        providerStatus: terminalStatus,
        paymentStatus: terminalStatus,
        orderStatus: updatedOrder.status,
        orderPaymentStatus: updatedOrder.payment_status,
      };
    });
  }
}
