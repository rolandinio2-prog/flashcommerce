"use client";
import OpsCashClosing from './ops-cash-closing';

import { useEffect, useRef, useState } from 'react';
import { getCashSummary, reconcileCashSummaryOrder, type CashSummary } from '../../../lib/flash-api';

const categoryNames: Record<string, string> = {
  LOCAL_CASH: 'Efectivo en local', QR: 'QR confirmado', REVIEW_REQUIRED: 'Revisar inconsistencias',
  REFUND_PENDING: 'Devolución pendiente', REFUNDED: 'Devuelto', EXCLUDED_LEGACY: 'Otros medios / histórico excluido',
};
function today() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)?.value).join('-');
}
export default function OpsCashPanel({canReconcile}: {canReconcile: boolean}) {
  const [date, setDate] = useState(today);
  const [data, setData] = useState<CashSummary | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const actionLock = useRef(false);
  useEffect(() => {
    let ignore = false;
    if (!date) {setData(null); setLoading(false); return;}
    setLoading(true); setError(''); setData(null); setSelected(null);
    getCashSummary(date).then(value => { if (!ignore) setData(value); }).catch(() => {
      if (!ignore) setError('No se pudo consultar caja. Verifica tu sesión e intenta actualizar.');
    }).finally(() => {if (!ignore) setLoading(false);});
    return () => {ignore = true;};
  }, [date, revision]);
  async function reconcile() {
    if (!selected || !canReconcile || actionLock.current) return;
    actionLock.current = true; setBusy(true); setError(''); setMessage('');
    try {
      await reconcileCashSummaryOrder(selected);
      setMessage('Consulta al proveedor completada. Revisa el estado actualizado; consultar no garantiza que el pago esté confirmado.');
      setSelected(null); setRevision(value => value + 1);
    } catch {
      setMessage('No se pudo completar la conciliación. Revisa el resumen actualizado antes de decidir un nuevo intento.');
      setSelected(null); setRevision(value => value + 1);
    } finally {actionLock.current = false; setBusy(false);}
  }
  return <section aria-label="Caja y conciliación" className="space-y-5">
    <div className="rounded-2xl border bg-white p-5">
      <h2 className="text-xl font-bold">Caja y conciliación</h2>
      <p className="mt-2 text-sm text-zinc-600">Consulta los cobros de la fecha en horario de Bolivia. Este resumen no cierra la caja.</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm font-semibold">Fecha de cobro<input aria-label="Fecha de cobro" type="date" value={date} disabled={busy} onChange={e => {setDate(e.target.value);setMessage('');}} className="mt-1 block rounded-lg border p-3" /></label>
        <button type="button" disabled={busy || loading || !date} onClick={() => setRevision(value => value + 1)} className="rounded-lg border px-4 py-3 font-bold disabled:opacity-50">Actualizar resumen</button>
      </div>
    </div>
    {loading && <p role="status">Consultando caja…</p>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-800">{error}</p>}
    {message && <p role="status" className="rounded-xl bg-blue-50 p-4">{message}</p>}
    {data && <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.totals.length === 0 && <p>No hay cobros registrados para esta fecha.</p>}
        {data.totals.map(row => <article key={row.currency + row.category} className="rounded-xl border bg-white p-5">
          <h3 className="font-semibold">{categoryNames[row.category] ?? row.category}</h3>
          <p className="mt-2 text-2xl font-bold">{row.currency} {row.amount}</p><p className="text-sm text-zinc-600">{row.count} registros</p>
        </article>)}
      </div>
      <div className="rounded-2xl border bg-white p-5">
        <h3 className="font-bold">Pagos pendientes de revisión · {data.reviewRequiredCount}</h3>
        <p className="mt-1 text-sm text-zinc-600">Incluye pedidos de otras fechas. Mostramos hasta {data.limit}; no se marcan como pagados manualmente.</p>
        {data.reviewRequired.map(row => <div key={row.orderNumber} className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <span>Pedido #{row.orderNumber} · {row.currency} {row.total}</span>
          {canReconcile && <button type="button" disabled={busy || loading} onClick={() => setSelected(row.orderNumber)} className="rounded-lg border px-3 py-2 font-semibold disabled:opacity-50">Revisar pedido #{row.orderNumber}</button>}
        </div>)}
        {data.reviewRequired.length === 0 && <p className="mt-3">Sin pedidos en revisión.</p>}
      </div>
    </>}
    <OpsCashClosing date={date} summaryRevision={revision}/>
    {selected && <div role="dialog" aria-modal="false" aria-labelledby="reconcile-title" className="rounded-xl border border-red-200 bg-white p-5">
      <h3 id="reconcile-title" className="font-bold">Consultar pago del pedido #{selected}</h3>
      <p className="mt-2">La respuesta del proveedor puede actualizar el estado del pago. No se realizará un nuevo cobro.</p>
      <div className="mt-4 flex gap-3">
        <button type="button" disabled={busy} onClick={() => setSelected(null)} className="rounded-lg border px-4 py-3">Cancelar</button>
        <button type="button" disabled={busy} onClick={() => void reconcile()} className="rounded-lg bg-red-600 px-4 py-3 font-bold text-white disabled:opacity-50">{busy ? 'Consultando…' : 'Consultar al proveedor'}</button>
      </div>
    </div>}
  </section>;
}
