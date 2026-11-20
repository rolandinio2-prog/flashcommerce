import type { DeliveryCheckoutPreview } from '../../lib/flash-api';
import { orderMoney } from './order-product-card';

export default function DeliveryQuoteSummary({ quote, busy, waiting }: {
  quote: DeliveryCheckoutPreview | null; busy: boolean; waiting: boolean;
}) {
  return <section aria-label="Envío y total" className="mb-4 rounded-2xl border border-zinc-200 bg-white p-4" aria-busy={busy}>
    <h3 className="text-base font-bold">Envío y total</h3>
    <div aria-live="polite" aria-atomic="true">
      {quote ? <>
        <p className="mt-2 text-sm font-semibold text-emerald-800">✓ Entregamos en esta dirección</p>
        <p className="mt-1 break-words text-sm text-zinc-600">{quote.zone.name}</p>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between gap-3"><dt>Productos</dt><dd className="font-semibold">{orderMoney(quote.subtotal, quote.currency)}</dd></div>
          {quote.discountTotal > 0 && <div className="flex justify-between gap-3"><dt>Descuento</dt><dd className="font-semibold">−{orderMoney(quote.discountTotal, quote.currency)}</dd></div>}
          <div className="flex justify-between gap-3"><dt>Envío</dt><dd className="font-semibold">{orderMoney(quote.deliveryFee, quote.currency)}</dd></div>
          <div className="flex justify-between gap-3 border-t pt-3 text-lg font-bold"><dt>Total general</dt><dd>{orderMoney(quote.total, quote.currency)}</dd></div>
        </dl>
        <p className="mt-3 text-sm text-zinc-600">Mínimo de productos: {orderMoney(quote.minimumOrder, quote.currency)}.</p>
        {quote.deliveryMode === 'JOINED_EXISTING'
          ? <p className="mt-2 text-sm text-emerald-800">Se suma al envío anterior sin otro cargo. La salida depende de que todos los productos estén listos.</p>
          : <p className="mt-2 text-sm text-zinc-600">Entrega estimada: {quote.eta.minMinutes}–{quote.eta.maxMinutes} min desde la confirmación del pago.</p>}
        <p className="mt-2 text-xs text-zinc-500">El total se actualiza automáticamente si cambia el pedido o la dirección.</p>
      </> : <p className="mt-2 text-sm text-zinc-600" role="status">{busy ? 'Calculando envío…' : waiting ? 'Completa el contacto y elige la dirección para conocer el envío y total.' : 'Envío pendiente de cálculo. El total se consulta automáticamente antes de confirmar.'}</p>}
    </div>
  </section>;
}
