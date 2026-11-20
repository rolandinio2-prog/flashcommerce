import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';

// Current release policy: local CASH/QR, delivery prepaid bank QR only.
// Keep this boundary shared by all dispatch paths; never infer payment from UI.
export function assertLocalCashAllowed(orderType: string): void {
  if (!['DINE_IN', 'TAKEAWAY', 'PICKUP'].includes(orderType)) {
    throw new ConflictException('Delivery solo admite QR pagado; efectivo disponible unicamente en el local.');
  }
}
export function rejectCashOnDelivery(): never {
  throw new ConflictException('Pago contraentrega no habilitado. Delivery requiere QR pagado antes del despacho.');
}
export async function assertDeliveryQrPaid(client: PoolClient, scope: {tenant_id: string; branch_id: string; order_id: string}): Promise<void> {
  // Serialize with payment/order writers before examining the confirmed attempt.
  const order = await client.query<{payment_status: string; order_type: string; total: string; currency: string}>(
    'select payment_status, order_type, total::text, currency from public.orders where tenant_id=$1::uuid and branch_id=$2::uuid and id=$3::uuid for update',
    [scope.tenant_id, scope.branch_id, scope.order_id],
  );
  const row = order.rows[0];
  if (!row || row.order_type !== 'DELIVERY' || row.payment_status !== 'PAID') {
    throw new ConflictException('Delivery requiere pago QR confirmado antes del despacho.');
  }
  const payment = await client.query<{eligible: boolean}>(
    "select exists (select 1 from public.order_payments where tenant_id=$1::uuid and branch_id=$2::uuid and order_id=$3::uuid and method='QR' and provider='BCP_QR' and status='PAID' and amount=$4::numeric and currency=$5 and paid_at is not null and verified_at is not null) as eligible",
    [scope.tenant_id, scope.branch_id, scope.order_id, row.total, row.currency],
  );
  if (payment.rows[0]?.eligible !== true) {
    throw new ConflictException('No existe un pago QR confirmado por el importe completo del pedido.');
  }
}
