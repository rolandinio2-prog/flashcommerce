import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

// Current release policy: local CASH/QR, delivery prepaid bank QR only.
// Keep this boundary shared by all dispatch paths; never infer payment from UI.
export function assertLocalCashAllowed(orderType: string): void {
  if (!['DINE_IN', 'TAKEAWAY', 'PICKUP'].includes(orderType)) {
    throw new ConflictException(
      'Delivery solo admite QR pagado; efectivo disponible unicamente en el local.',
    );
  }
}
export function rejectCashOnDelivery(): never {
  throw new ConflictException(
    'Pago contraentrega no habilitado. Delivery requiere QR pagado antes del despacho.',
  );
}
/**
 * QR provider whose confirmed payments may release a delivery: the environment's
 * configured provider. Production (BCP_QR) accepts only bank QR payments; a MOCK
 * environment (staging/lab, no bank) accepts its MOCK confirmations.
 */
export function deliveryQrProvider(
  configured: string | undefined = process.env.PAYMENT_PROVIDER,
): 'BCP_QR' | 'MOCK' {
  return (configured ?? '').trim().toUpperCase() === 'MOCK' ? 'MOCK' : 'BCP_QR';
}
export async function assertDeliveryQrPaid(
  client: PoolClient,
  scope: { tenant_id: string; branch_id: string; order_id: string },
): Promise<void> {
  // Serialize with payment/order writers before examining the confirmed attempt.
  const order = await client.query<{
    payment_status: string;
    order_type: string;
    total: string;
    currency: string;
    order_origin: string;
  }>(
    'select payment_status, order_type, total::text, currency, order_origin from public.orders where tenant_id=$1::uuid and branch_id=$2::uuid and id=$3::uuid for update',
    [scope.tenant_id, scope.branch_id, scope.order_id],
  );
  const row = order.rows[0];
  // Courier request with nothing to collect: no customer payment exists by design.
  if (
    row?.order_type === 'DELIVERY' &&
    row.order_origin === 'COURIER_REQUEST' &&
    row.payment_status === 'NOT_REQUIRED' &&
    Number(row.total) === 0
  )
    return;
  // Courier request with cash to collect (FlashCommerce Delivery COD): dispatchable
  // while the driver's cash collection is pending, and after it was collected.
  if (
    row?.order_type === 'DELIVERY' &&
    row.order_origin === 'COURIER_REQUEST' &&
    (row.payment_status === 'AWAITING_CONFIRMATION' ||
      row.payment_status === 'PAID')
  ) {
    const cod = await client.query<{ eligible: boolean }>(
      "select exists (select 1 from public.order_payments where tenant_id=$1::uuid and branch_id=$2::uuid and order_id=$3::uuid and method='CASH' and provider='DRIVER_COD' and status=$6 and amount=$4::numeric and currency=$5) as eligible",
      [
        scope.tenant_id,
        scope.branch_id,
        scope.order_id,
        row.total,
        row.currency,
        row.payment_status,
      ],
    );
    if (cod.rows[0]?.eligible !== true)
      throw new ConflictException(
        'El envío no tiene un cobro contra entrega válido por el monto completo.',
      );
    return;
  }
  if (!row || row.order_type !== 'DELIVERY' || row.payment_status !== 'PAID') {
    throw new ConflictException(
      'Delivery requiere pago QR confirmado antes del despacho.',
    );
  }
  const payment = await client.query<{ eligible: boolean }>(
    "select exists (select 1 from public.order_payments where tenant_id=$1::uuid and branch_id=$2::uuid and order_id=$3::uuid and method='QR' and provider=$6 and status='PAID' and amount=$4::numeric and currency=$5 and paid_at is not null and verified_at is not null) as eligible",
    [
      scope.tenant_id,
      scope.branch_id,
      scope.order_id,
      row.total,
      row.currency,
      deliveryQrProvider(),
    ],
  );
  if (payment.rows[0]?.eligible !== true) {
    throw new ConflictException(
      'No existe un pago QR confirmado por el importe completo del pedido.',
    );
  }
}
