import type { OperationalOrder } from '../../../../lib/flash-api';
export default function OpsCashProducts({order}: {order: OperationalOrder}) {
  return <section aria-label="Productos del pedido" className="mt-4 space-y-3">
    <h3 className="font-bold">Productos del pedido</h3>
    {order.items.length === 0 ? <p role="alert">No se pudo obtener el detalle. Actualiza el pedido antes de cobrar.</p> :
      <ul className="divide-y divide-zinc-200">{order.items.map((item,index) =>
        <li key={`${item.productId ?? 'historical'}-${index}`} className="flex flex-wrap items-start justify-between gap-2 py-3">
          <div className="min-w-0 flex-1 break-words"><p className="font-semibold">{item.name}</p>
            <p className="text-sm text-zinc-600">{item.quantity} × {order.currency} {item.unitPrice.toFixed(2)}</p></div>
          <strong className="tabular-nums">{order.currency} {item.lineTotal.toFixed(2)}</strong>
        </li>)}</ul>}
    <p className="text-xs text-zinc-500">Cantidades y precios registrados en el pedido del cliente.</p>
  </section>;
}
