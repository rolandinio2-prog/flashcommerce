'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {draftKey,parseDraft,type CheckoutDraft,type DraftForm} from '../../lib/checkout-draft';

export default function CheckoutDraftCard({tenant,branch,cartToken,ready,busy,completed,form,items,onResume,onViewOrders,onPendingChange}: {
  tenant:string;branch:string;cartToken:string|null;ready:boolean;busy:boolean;completed:boolean;
  form:DraftForm;items:{name:string;quantity:number}[];onResume:(form:DraftForm)=>void;onViewOrders:()=>void;onPendingChange:(pending:boolean)=>void;
}) {
  const key=draftKey(tenant,branch);
  const [loaded,setLoaded]=useState(false),[pending,setPending]=useState<CheckoutDraft|null>(null);
  const [status,setStatus]=useState(''),[conflict,setConflict]=useState(false);
  const last=useRef<string|null>(null), blocked=useRef(false);
  const data=JSON.stringify({form,items,cartToken});
  useEffect(()=>{
    try {setPending(parseDraft(window.localStorage.getItem(key),tenant,branch));}catch{setStatus('Este navegador no permite guardar el borrador.');}
    setLoaded(true);
    const changed=(event:StorageEvent)=>{if(event.key===key){blocked.current=true;setConflict(true);setStatus('El borrador cambió en otra ventana. Recarga para recuperar la versión más reciente.');}};
    window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);
  },[key,tenant,branch]);
  useEffect(()=>{onPendingChange(!loaded||Boolean(pending)||conflict);},[loaded,pending,conflict,onPendingChange]);
  useLayoutEffect(()=>{
    if(!loaded||pending||blocked.current||!ready||busy||completed||!cartToken||items.length===0){last.current=null;return;}
    const draft:CheckoutDraft={version:1,tenant,branch,cartToken,updatedAt:Date.now(),form,items};
    const raw=JSON.stringify(draft);
    if(!parseDraft(raw,tenant,branch)){setStatus('Revisa los datos: no se pudo guardar el borrador.');return;}
    try {window.localStorage.setItem(key,raw);last.current=raw;setStatus('Borrador guardado en este navegador');}
    catch{last.current=null;setStatus('No se pudo guardar en este navegador. Mantén esta ventana abierta.');}
  // The serialized value tracks actual edits, not new object identities on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[data,key,loaded,pending,ready,busy,completed,tenant,branch]);
  if(completed)return null;
  if(!pending&&!status)return null;
  return <section className="mx-auto my-4 max-w-5xl rounded-2xl border border-red-100 bg-white p-4" aria-label="Borrador de tu pedido">
    {pending&&<>
      <h2 className="font-bold">Tienes un pedido por terminar</h2>
      <p className="mt-1 text-sm text-zinc-600">{pending.items.map(i=>`${i.quantity} × ${i.name}`).join(' · ')}</p>
      <p className="mt-2 text-sm">{cartToken===pending.cartToken ? 'Recupera tus datos y revisa el pedido antes de confirmar.' : 'El carrito guardado no está disponible. Revisa Mis pedidos antes de iniciar otro; conservamos tus datos durante siete días.'}</p>
      <button type="button" disabled={!ready||busy||conflict||cartToken!==pending.cartToken} className="mt-3 min-h-12 rounded-xl bg-red-700 px-4 py-3 font-semibold text-white disabled:opacity-50"
        onClick={()=>{const saved=pending;setPending(null);setStatus('Borrador recuperado. Revisa precios y vuelve a calcular el envío.');onResume(saved.form);}}>Continuar mi pedido</button>
      <button type="button" className="ml-3 min-h-12 px-3 py-2 underline" onClick={onViewOrders}>Mis pedidos</button>
      <button type="button" disabled={conflict} className="ml-3 min-h-12 px-3 py-2 text-sm underline" onClick={()=>{
        try {window.localStorage.removeItem(key);setPending(null);setStatus('Borrador descartado. El carrito actual no se modifica.');}
        catch{setStatus('No se pudo descartar el borrador.');}
      }}>Descartar borrador</button>
    </>}
    <p className="mt-2 text-sm text-zinc-600" role="status">{status || 'Guardado solo en este navegador; no es un pedido confirmado.'}</p>
  </section>;
}
