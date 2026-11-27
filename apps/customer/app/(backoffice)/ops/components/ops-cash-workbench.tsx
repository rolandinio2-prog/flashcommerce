"use client";
import { useState } from 'react';
import type { OperationalOrder } from '../../../../lib/flash-api';
import { canReceiveCashPayment } from './ops-cash-eligibility';
import OpsCashProducts from './ops-cash-products';
const mode = (order: OperationalOrder) => ({DINE_IN:'En el local',TAKEAWAY:'Para llevar',PICKUP:'Retiro programado',DELIVERY:'Delivery'}[order.orderType] ?? order.orderType);
export default function OpsCashWorkbench({orders, canCollect, busy, onCollect}: {
  orders: OperationalOrder[];canCollect:boolean;busy:boolean;onCollect:(order:OperationalOrder)=>void;
}) {
  const [selected,setSelected]=useState<string|null>(null);
  const pending=orders.filter(order=>order.orderType !== 'DELIVERY' && !['PAID','NOT_REQUIRED','REFUNDED'].includes(order.paymentStatus) && !['CANCELLED','COMPLETED'].includes(order.status));
  const order=pending.find(row=>row.id===selected) ?? null;
  return <section aria-labelledby="cash-workbench-title" className="mb-6 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-6">
    <h2 id="cash-workbench-title" className="text-2xl font-black">Cobrar un pedido</h2>
    <p className="mt-1 text-sm text-zinc-600">Selecciona el pedido del cliente y revisa sus productos antes de cobrar.</p>
    <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
      <div><h3 className="mb-3 font-bold">Pedidos pendientes · {pending.length}</h3>
        {pending.length===0&&<p className="text-sm text-zinc-600">No hay pedidos pendientes de pago.</p>}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">{pending.map(row=><button key={row.id} type="button" disabled={busy} aria-pressed={order?.id===row.id}
          onClick={()=>setSelected(row.id)} className={`rounded-xl border p-4 text-left disabled:opacity-50 ${order?.id===row.id?'border-red-600 bg-red-50':'border-zinc-200 bg-white'}`}>
          <span className="block font-bold">Pedido #{row.orderNumber}</span>
          <span className="block break-words text-sm text-zinc-600">{mode(row)}{row.fulfillment?.customerName ? ` · ${row.fulfillment.customerName}`:''}</span>
          <span className="mt-2 flex flex-wrap justify-between gap-2"><strong>{row.currency} {row.total.toFixed(2)}</strong><span className="text-xs">{row.orderType==='DELIVERY'?'Solo QR':row.paymentStatus==='REVIEW_REQUIRED'?'Revisión requerida':'Por cobrar'}</span></span>
        </button>)}</div>
      </div>
      {order ? <div className="min-w-0" key={order.id}>
        <h3 className="text-xl font-bold">Pedido #{order.orderNumber}</h3><p className="text-sm text-zinc-600">{mode(order)}</p>
        <OpsCashProducts order={order}/>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4"><span>Total del pedido</span><strong className="text-2xl tabular-nums">{order.currency} {order.total.toFixed(2)}</strong></div>
        {order.orderType==='DELIVERY' ? <p className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Delivery solo admite QR confirmado antes del despacho. No se cobra en efectivo.</p> :
          canCollect&&canReceiveCashPayment(order) ? <>
            {order.paymentStatus==='AWAITING_CONFIRMATION'&&<p className="mt-4 text-sm text-amber-800">Hay un QR pendiente. El cobro exige que el servidor confirme su cancelación.</p>}
            <button type="button" disabled={busy||order.items.length===0} onClick={()=>onCollect(order)} className="mt-5 w-full rounded-xl bg-red-600 px-5 py-4 font-bold text-white disabled:opacity-50">Continuar al cobro en efectivo</button>
          </> : <p className="mt-4 text-sm text-zinc-600">Este pedido no admite cobro en efectivo con su estado actual o tus permisos. Revisa el resumen de conciliación.</p>}
      </div> : <div className="rounded-xl bg-zinc-50 p-8 text-center text-zinc-600" role="status">{selected?'El pedido ya no está pendiente. Selecciona otro pedido.':'Selecciona un pedido para ver productos, cantidades y total.'}</div>}
    </div>
  </section>;
}
