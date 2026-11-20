import type { DeliveryCheckoutPreview } from './flash-api';

export function usableDeliveryQuote(quote: DeliveryCheckoutPreview | null, issuedKey: string | undefined, currentKey: string, now = Date.now()) {
  return Boolean(quote && issuedKey === currentKey && quote.coverage === true &&
    Number.isFinite(Date.parse(quote.expiresAt)) && Date.parse(quote.expiresAt) > now);
}

export function deliveryCheckoutError(message: string) {
  if (/outside the delivery area/.test(message)) return 'Esta dirección está fuera de la cobertura de la sucursal. Prueba otra dirección o elige recoger el pedido.';
  const missing = /Minimum delivery order not met: ([\d.]+) BOB missing/.exec(message);
  if (missing) return `Agrega Bs ${Number(missing[1]).toFixed(2)} en productos para alcanzar el mínimo de envío de esta zona.`;
  if (/Delivery is (disabled|not enabled)|Branch not found for delivery/.test(message)) return 'El envío no está disponible en esta sucursal. Puedes elegir otra modalidad.';
  if (/Cart has expired|Cart is not open|Cart not found/.test(message)) return 'El carrito ya no está disponible. Revisa tus pedidos antes de iniciar uno nuevo.';
  if (/no longer available|units are available|different currency/.test(message)) return 'Cambió la disponibilidad o el precio de algún producto. Actualiza el carrito y calcula nuevamente.';
  if (/Additional delivery source/.test(message)) return 'El pedido anterior ya no permite este envío adicional. Revisa su estado antes de continuar.';
  if (/cálculo de envío|Contexto no válido/.test(message)) return message;
  if (/Google|route.*unavailable|geocod/i.test(message)) return 'Guardamos el punto elegido, pero el servicio de mapas no pudo calcular el envío. Intenta más tarde o elige retirar en el local.';
  return 'No pudimos calcular el envío. Revisa los datos o modifica la dirección para actualizarlo.';
}
