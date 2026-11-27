import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { BcpQrProvider } from './bcp-qr.provider';
import type { MockQrProvider } from './mock-qr.provider';
import type {
  PaymentProvider,
  ProviderQrContentType,
  ProviderQrMimeType,
} from './payment-provider';

/** Types and stateless helpers shared by the payment services (R2 split of payments.service.ts). */
export type OrderStatus =
  'PENDING' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED';

export type OrderPaymentStatus =
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

export type OrderOrigin =
  | 'LEGACY'
  | 'PUBLIC_MENU'
  | 'TABLE_QR'
  | 'BRANCH_QR'
  | 'OPS_STAFF'
  | 'RESERVATION_PREORDER'
  | 'RESERVATION_CHECKIN';

export type PaymentAttemptStatus =
  | 'CREATED'
  | 'AWAITING_CONFIRMATION'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'REVIEW_REQUIRED';

export interface PaymentOrderRow {
  id: string;
  order_number: string;
  tracking_token: string;
  tenant_id: string;
  branch_id: string;
  customer_phone: string | null;
  branch_name: string | null;
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  order_origin: OrderOrigin;
  order_type?: string;
  total: string;
  currency: string;
  reservation_id: string | null;
  reservation_status: string | null;
}

export interface PaymentAttemptRow {
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

export interface PaymentTrackingRow extends PaymentOrderRow {
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

export interface ConfirmCashPaymentInput {
  tenantCode?: string;
  branchCode?: string;
  cashReceivedAmount?: string | number;
  terminalReference?: string;
  idempotencyKey?: string;
  operatorUserId: string;
  operatorCode: string;
  operatorDisplayName: string;
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
export interface OpenDriverCodCashSettlementInput {
  tenantCode?: string;
  branchCode?: string;
  driverId?: string;
  currency?: string;
  cashierReference?: string;
  notes?: string;
  idempotencyKey?: string;
  cashierAccessKey?: string;
}

export interface SettleDriverCodCashSettlementInput {
  tenantCode?: string;
  branchCode?: string;
  receivedAmount?: string | number;
  cashierReference?: string;
  idempotencyKey?: string;
  cashierAccessKey?: string;
}

export interface CancelDriverCodCashSettlementInput {
  tenantCode?: string;
  branchCode?: string;
  cashierReference?: string;
  idempotencyKey?: string;
  cashierAccessKey?: string;
}

export type DriverCodCashSettlementStatus = 'OPEN' | 'SETTLED' | 'CANCELLED';

export interface DriverCodCashSettlementRow {
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

export interface DriverCodCashSettlementItemPaymentRow {
  id: string;
  collection_id: string;
  payment_id: string;
  amount: string;
  currency: string;
}
export interface PreparedQrPayment {
  order: PaymentOrderRow;
  payment: PaymentAttemptRow;
  shouldGenerate: boolean;
}

export interface BcpQrCallbackInput {
  IdCorrelation?: unknown;
  Id?: unknown;
  ServiceCode?: unknown;
  BusinessCode?: unknown;
  IdQr?: unknown;
  Eif?: unknown;
  Account?: unknown;
  Amount?: unknown;
  Currency?: unknown;
  Gloss?: unknown;
  ReceiverAccount?: unknown;
  ReceiverName?: unknown;
  ReceiverDocument?: unknown;
  ReceiverBank?: unknown;
  ExpirationDate?: unknown;
  ResponseCode?: unknown;
  Status?: unknown;
  Request?: unknown;
  RequestDate?: unknown;
  Response?: unknown;
  ResponseDate?: unknown;
  ResponseAch?: unknown;
  ResponseAchDate?: unknown;
  State?: unknown;
  CorrelationId?: unknown;
  Description?: unknown;
  GenerateType?: unknown;
  Version?: unknown;
  SingleUse?: unknown;
  OperationNumber?: unknown;
  EnableBank?: unknown;
  City?: unknown;
  BranchOffice?: unknown;
  Teller?: unknown;
  PhoneNumber?: unknown;
  Collectors?: unknown;
}
// Accept only scalar input as text; objects/arrays become empty (same validation outcome, no [object Object]).
export function scalarText(value: unknown): string {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
    ? String(value)
    : '';
}

export function requireSettlementUuid(
  value: string | undefined,
  field: string,
): string {
  const normalized = value?.trim().toLowerCase() || '';

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      normalized,
    )
  ) {
    throw new BadRequestException(`${field} must be a valid UUID`);
  }

  return normalized;
}

export function requireSettlementCurrency(value: string | undefined): string {
  const normalized = value?.trim().toUpperCase() || '';

  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new BadRequestException('currency must be a three-letter ISO code');
  }

  return normalized;
}

export function requireSettlementReceivedAmount(value: unknown): string {
  const normalized = scalarText(value).trim();

  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(normalized)) {
    throw new BadRequestException('receivedAmount is invalid');
  }

  return normalized;
}

export function requireOptionalSettlementNotes(
  value: string | undefined,
): string | null {
  const normalized = value?.trim() || '';

  if (!normalized) {
    return null;
  }

  // eslint-disable-next-line no-control-regex -- intentionally rejects control characters in user/provider input
  if (normalized.length > 500 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new BadRequestException('notes is invalid');
  }

  return normalized;
}

export async function loadDriverCodCashSettlementItems(
  client: PoolClient,
  settlementId: string,
): Promise<DriverCodCashSettlementItemPaymentRow[]> {
  const result = await client.query<DriverCodCashSettlementItemPaymentRow>(
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

export function mapDriverCodCashSettlement(
  settlement: DriverCodCashSettlementRow,
  itemCount: number,
  snapshotItemCount: number = itemCount,
) {
  return {
    id: settlement.id,
    status: settlement.status,

    driverId: settlement.driver_id,

    currency: settlement.currency,

    expectedAmount: Number(settlement.expected_amount),

    receivedAmount:
      settlement.received_amount === null
        ? null
        : Number(settlement.received_amount),

    differenceAmount:
      settlement.difference_amount === null
        ? null
        : Number(settlement.difference_amount),

    itemCount,
    snapshotItemCount,

    openedAt: settlement.opened_at,

    settledAt: settlement.settled_at,

    cancelledAt: settlement.cancelled_at,

    notes: settlement.notes,

    updatedAt: settlement.updated_at,
  };
}

export function requireCashCode(
  value: string | undefined,
  field: string,
): string {
  const normalized = value?.trim().toUpperCase() || '';

  if (!/^[A-Z0-9_-]{2,30}$/.test(normalized)) {
    throw new BadRequestException(`${field} is invalid`);
  }

  return normalized;
}

export function requireAuditReference(
  value: string | undefined,
  field: string,
): string {
  const normalized = value?.trim() || '';

  if (
    normalized.length < 2 ||
    normalized.length > 80 ||
    // eslint-disable-next-line no-control-regex -- intentionally rejects control characters in user/provider input
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new BadRequestException(`${field} is invalid`);
  }

  return normalized;
}

export function requireIdempotencyToken(value?: string): string {
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

export function requireCashAmount(value: unknown): string {
  const normalized = scalarText(value).trim();

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

export async function loadOrderForPayment(
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
          o.customer_phone,
          (
            select b.name
            from public.branches b
            where b.tenant_id = o.tenant_id
              and b.id = o.branch_id
            limit 1
          ) as branch_name,
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

export function assertOrderCanReceivePayment(order: PaymentOrderRow): void {
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

export async function insertPaymentEvent(
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

export function mapPaymentResponse(
  order: PaymentOrderRow,
  payment: PaymentAttemptRow,
  reused: boolean,
) {
  return {
    reused,

    order: mapOrder(order),

    payment: mapPayment(payment),
  };
}

export function mapOrder(order: PaymentOrderRow) {
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

export function mapPayment(payment: PaymentAttemptRow) {
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

export function mapPaymentFromTracking(row: PaymentTrackingRow) {
  return mapPayment({
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

export function providerByName(
  mockQrProvider: MockQrProvider,
  bcpQrProvider: BcpQrProvider,
  providerName: string,
): PaymentProvider {
  const normalizedProvider = providerName.trim().toUpperCase();

  switch (normalizedProvider) {
    case 'MOCK':
      return mockQrProvider;

    case 'BCP_QR':
      return bcpQrProvider;

    default:
      throw new ServiceUnavailableException(
        'Stored payment provider is not supported',
      );
  }
}
