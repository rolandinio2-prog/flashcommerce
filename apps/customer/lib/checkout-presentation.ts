import type { FlashOrderStatus, OrderPaymentStatus } from './flash-api';

export function orderConfirmationCopy(status: FlashOrderStatus, payment: OrderPaymentStatus) {
  if (status === 'CANCELLED') return { title: 'Pedido cancelado', description: 'Este pedido fue cancelado. Consulta el estado del pago en el resumen.', tone: 'neutral' } as const;
  if (status === 'COMPLETED') return { title: 'Pedido completado', description: 'Tu pedido figura como completado.', tone: 'success' } as const;
  if (status === 'PREPARING') return { title: 'En preparación', description: 'El comercio está preparando tu pedido.', tone: 'success' } as const;
  if (status === 'READY') return { title: 'Pedido listo', description: 'El comercio marcó tu pedido como listo. Consulta el seguimiento según tu modalidad.', tone: 'success' } as const;
  if (status === 'CONFIRMED') return { title: 'Pedido confirmado', description: 'Tu pedido está confirmado por el comercio.', tone: 'success' } as const;
  if (payment === 'PAID') return { title: 'Pago confirmado', description: 'Tu pago está verificado. El pedido sigue pendiente de confirmación.', tone: 'success' } as const;
  if (payment === 'REVIEW_REQUIRED') return { title: 'Pago en revisión', description: 'La sucursal debe revisar el pago antes de que el pedido avance.', tone: 'neutral' } as const;
  if (payment === 'FAILED' || payment === 'EXPIRED' || payment === 'CANCELLED') return { title: 'Pago pendiente', description: 'Tu pedido está guardado. Revisa la información del pago para continuar.', tone: 'neutral' } as const;
  if (payment === 'NOT_REQUIRED') return { title: 'Pedido recibido', description: 'Tu pedido fue registrado. Consulta su estado en el seguimiento.', tone: 'neutral' } as const;
  return { title: 'Pedido recibido', description: 'Tu pedido fue registrado. Consulta el estado del pago para continuar.', tone: 'neutral' } as const;
}
