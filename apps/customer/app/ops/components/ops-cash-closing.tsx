"use client";
import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../../lib/flash-api';
type Closing={expectedCash:string;countedCash:string;difference:string;note:string;actorCode:string;closedAt:string; snapshot:{totals:{currency:string;category:string;amount:string;count:string}[]}};
type Preview={date:string;expectedCash:string;snapshotHash:string;canClose:boolean;blocked:boolean;future:boolean;closing:Closing|null;changedAfterClosing:boolean;cashChangeAfterClosing:string};
const endpoint='/api/v1/ops/payments/closing';
export default function OpsCashClosing({date,summaryRevision}:{date:string;summaryRevision:number}){
  const [data,setData]=useState<Preview|null>(null),[counted,setCounted]=useState(''),[note,setNote]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false);
  const [confirm,setConfirm]=useState(false),[revision,setRevision]=useState(0);
  const lock=useRef(false);
  useEffect(()=>{
    let active=true;setData(null);setConfirm(false);setError('');setCounted('');setNote('');
    if(!date)return;
    setLoading(true);
    apiRequest<Preview>(endpoint+'?date='+encodeURIComponent(date),{cache:'no-store'}).then(value=>{if(active)setData(value);})
      .catch(()=>{if(active)setError('No se pudo consultar el cierre. Actualiza antes de continuar.');})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[date,summaryRevision,revision]);
  async function close(){
    if(lock.current||!data?.canClose||!confirm)return;
    lock.current=true;setBusy(true);setError('');
    try{
      await apiRequest(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:data.date,
        snapshotHash:data.snapshotHash,requestId:crypto.randomUUID(),countedCash:counted,note})});
      setRevision(r=>r+1);
    }catch{
      // Never automatically repeat a financial action after an uncertain response.
      setData(null);setError('No se pudo confirmar el cierre. Consulta su estado antes de decidir un nuevo intento.');
    }finally{lock.current=false;setBusy(false);setConfirm(false);}
  }
  const valid=/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(counted);
  const different=valid&&data&&Number(counted)!==Number(data.expectedCash);
  return <section aria-labelledby="daily-closing-title" className="rounded-2xl border bg-white p-4 sm:p-5">
    <h3 id="daily-closing-title" className="text-xl font-bold">Cierre diario de caja</h3>
    <p className="mt-2 text-sm text-zinc-600">Un cierre por sucursal y día · horario de Bolivia. Compara el efectivo de ventas con el dinero contado, descontando el fondo de cambio. QR se informa por separado.</p>
    <button type="button" disabled={busy||loading||!date} onClick={()=>setRevision(r=>r+1)} className="mt-3 rounded-lg border px-4 py-3 font-semibold disabled:opacity-50">Consultar cierre</button>
    {loading&&<p role="status" className="mt-3">Consultando cierre…</p>}
    {error&&<p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
    {data?.closing?<div className="mt-4 space-y-3 rounded-xl bg-green-50 p-4">
      <h4 className="font-bold">Caja cerrada · {data.date}</h4>
      <dl className="grid grid-cols-2 gap-2 break-words text-sm">
        <dt>Efectivo esperado</dt><dd>Bs {data.closing.expectedCash}</dd><dt>Efectivo contado</dt><dd>Bs {data.closing.countedCash}</dd>
        <dt>Diferencia</dt><dd>Bs {data.closing.difference}</dd><dt>Responsable</dt><dd>{data.closing.actorCode}</dd>
        <dt>Fecha de cierre</dt><dd>{new Date(data.closing.closedAt).toLocaleString('es-BO',{timeZone:'America/La_Paz'})}</dd>
      </dl>
      <p className="break-words">{data.closing.note||'Sin observaciones.'}</p>
      <h4 className="font-semibold">Cobros registrados al cerrar</h4>
      {data.closing.snapshot.totals.map(r=><p key={r.currency+r.category} className="break-words">{r.category==='QR'?'QR confirmado':r.category==='LOCAL_CASH'?'Efectivo local':r.category} · {r.currency} {r.amount} · {r.count} registros</p>)}
      {data.changedAfterClosing&&<p role="status" className="rounded-lg bg-amber-50 p-3 text-amber-900">Se registraron cambios después del cierre. Variación del efectivo: Bs {data.cashChangeAfterClosing}. El cierre original permanece intacto; compara el resumen actualizado.</p>}
    </div>:data&&<div className="mt-4 space-y-4">
      <p className="font-bold">Efectivo esperado de ventas · Bs {data.expectedCash}</p>
      {data.blocked&&<p role="alert">Hay inconsistencias o devoluciones que requieren revisión antes de cerrar.</p>}
      {data.future&&<p>No se puede cerrar una fecha futura.</p>}
      {data.canClose&&<>
        <label className="block font-semibold">Efectivo contado de ventas<input value={counted} disabled={busy} inputMode="decimal" placeholder="0.00" onChange={e=>{setCounted(e.target.value.replace(',','.'));setConfirm(false);}} className="mt-1 w-full min-w-0 rounded-lg border p-3 text-base"/></label>
        <label className="block font-semibold">Observación {different?'(obligatoria por diferencia)':'(opcional)'}<textarea value={note} disabled={busy} maxLength={500} onChange={e=>{setNote(e.target.value);setConfirm(false);}} className="mt-1 w-full min-w-0 rounded-lg border p-3 text-base"/></label>
        {confirm?<div role="group" aria-label="Confirmación del cierre" className="space-y-3 rounded-xl border border-red-200 p-4">
          <p>Registrar cierre del {data.date}: esperado Bs {data.expectedCash}, contado Bs {counted}. Este registro no se puede editar y no realiza cobros.</p>
          <div className="flex flex-wrap gap-3"><button type="button" disabled={busy} onClick={()=>setConfirm(false)} className="rounded-lg border px-4 py-3">Volver</button>
          <button type="button" disabled={busy} onClick={()=>void close()} className="rounded-lg bg-red-600 px-4 py-3 font-bold text-white disabled:opacity-50">{busy?'Registrando…':'Confirmar cierre'}</button></div>
        </div>:<button type="button" disabled={busy||!valid||!!different&&note.trim().length<5} onClick={()=>setConfirm(true)} className="w-full rounded-lg bg-zinc-950 px-4 py-3 font-bold text-white disabled:opacity-50">Revisar cierre diario</button>}
      </>}
    </div>}
  </section>;
}
