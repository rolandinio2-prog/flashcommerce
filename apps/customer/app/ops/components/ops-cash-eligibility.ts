import type { OperationalOrder } from '../../../lib/flash-api';
export function canReceiveCashPayment(order: OperationalOrder): boolean {
  return ['DINE_IN', 'TAKEAWAY', 'PICKUP'].includes(order.orderType) &&
    ['PENDING', 'CONFIRMED'].includes(order.status) &&
    !['NOT_REQUIRED', 'PAID', 'REFUND_PENDING', 'REFUNDED', 'REVIEW_REQUIRED'].includes(order.paymentStatus);
}
export function cashOrderFingerprint(order: OperationalOrder): string {
  return JSON.stringify([order.id, order.total, order.currency, order.paymentStatus, order.status,
    order.items.map(item => [item.productId, item.name, item.quantity, item.unitPrice, item.lineTotal])]);
}
