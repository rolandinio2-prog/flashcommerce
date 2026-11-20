'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {draftKey,parseDraft,type CheckoutDraft,type DraftForm} from '../../lib/checkout-draft';
import {accessKey,continuityUrl,draftRequest,fragmentSecret,newSecret,privateLink,readAccess,resolveAutomaticDraft,type DraftAccess,type RemoteDraft,type DraftCandidate} from '../../lib/remote-draft';

type Props={compactNotice?:boolean;tenant:string;branch:string;cartToken:string|null;ready:boolean;busy:boolean;completed:boolean;form:DraftForm;
 items:{name:string;quantity:number}[];authenticated:boolean;onPendingChange:(pending:boolean)=>void;
 onRestore:(draft:RemoteDraft,isCurrent:()=>boolean)=>Promise<void>;onViewOrders:()=>void;};
export default function RemoteDraftCard(props:Props) {
 const {tenant,branch,cartToken,ready,busy,completed,form,items,authenticated,onPendingChange,onRestore,onViewOrders}=props;
 const [loaded,setLoaded]=useState(false),[phase,setPhase]=useState<'loading'|'active'|'choice'|'error'>('loading');
 const [message,setMessage]=useState('Buscando tu pedido…'),[working,setWorking]=useState(false),[saved,setSaved]=useState('');
 const [link,setLink]=useState(''),[choices,setChoices]=useState<DraftCandidate[]>([]),[blocked,setBlocked]=useState(false);
 const [retryVersion,setRetryVersion]=useState(0);
 const access=useRef<DraftAccess|null>(null),local=useRef<CheckoutDraft|null>(null),incoming=useRef<string|null>(null);
 const mounted=useRef(false),flight=useRef(false),boot=useRef(false),lastAuthenticated=useRef(authenticated),latest=useRef(props);
 latest.current=props;
 const scopeKey=accessKey(tenant,branch),localKey=draftKey(tenant,branch);
 const snapshot=JSON.stringify({cartToken,form,items,authenticated});
 const currentSnapshot=useRef(snapshot);currentSnapshot.current=snapshot;
 function updateContinuity(secret:string|null){
   try{const next=continuityUrl(location.href,tenant,branch,secret);if(next!==null)history.replaceState(history.state,'',next);}catch{/* Browser may prohibit history updates; saving still works. */}
 }
 useEffect(()=>{if(loaded&&(completed||!cartToken||!items.length))updateContinuity(null);},[loaded,completed,cartToken,items.length,tenant,branch]);
 function remember(value:DraftAccess){access.current=value;try{localStorage.setItem(scopeKey,JSON.stringify(value));}catch{/* Cookie/link remains a fallback. */}}
 useEffect(()=>{
   mounted.current=true;
   try{access.current=readAccess(localStorage,scopeKey);local.current=parseDraft(localStorage.getItem(localKey),tenant,branch);}catch{/* Storage is optional. */}
   const token=fragmentSecret(location.hash);if(token){incoming.current=token;updateContinuity(null);}
   setLoaded(true);
   const changed=(event:StorageEvent)=>{if(event.key===scopeKey||event.key===localKey){setBlocked(true);setMessage('Tu pedido cambió en otra ventana. Recarga para revisar la versión más reciente.');}};
   window.addEventListener('storage',changed);
   return()=>{mounted.current=false;window.removeEventListener('storage',changed);};
 },[scopeKey,localKey,tenant,branch]);
 useEffect(()=>{onPendingChange(phase==='loading'||phase==='choice');},[phase,onPendingChange]);
 async function apply(candidate:DraftCandidate){
   if(!mounted.current||latest.current.completed)return;
   await onRestore(candidate.draft,()=>mounted.current&&!latest.current.completed);
   if(!mounted.current||latest.current.completed)return;
   remember(candidate.access);incoming.current=null;local.current=null;
   setChoices([]);setBlocked(false);setSaved('');setLink('');setPhase('active');
   setMessage('Retomamos tu pedido automáticamente. Revisa el total y calcula nuevamente el envío.');
 }
 useEffect(()=>{
   if(!loaded||!ready||busy||flight.current)return;
   if(completed){setPhase('active');return;}
   // A login may discover an account draft only while there is no active cart.
   if(authenticated!==lastAuthenticated.current){lastAuthenticated.current=authenticated;if(authenticated&&!cartToken)boot.current=false;}
   if(boot.current)return;
   boot.current=true;flight.current=true;setPhase('loading');setWorking(true);
   void resolveAutomaticDraft({tenant,branch,cartToken,incoming:incoming.current,access:access.current,local:local.current}).then(async result=>{
     if(!mounted.current||latest.current.completed)return;
     const candidates=result.candidates;
     if(candidates.length===1&&(!latest.current.cartToken||latest.current.cartToken===candidates[0].draft.cartToken))await apply(candidates[0]);
     else if(candidates.length){setChoices(candidates);setPhase('choice');setMessage('Hay más de un carrito posible. Elige cuál continuar para no reemplazar otro pedido.');}
     else {setBlocked(false);setPhase('active');setMessage('Tu pedido se guardará automáticamente mientras lo preparas.');}
   }).catch(error=>{if(mounted.current){setPhase('error');setBlocked(true);setMessage(error.message);}})
     .finally(()=>{flight.current=false;if(mounted.current)setWorking(false);});
 },[loaded,ready,busy,completed,tenant,branch,cartToken,authenticated,retryVersion]);
 useLayoutEffect(()=>{
   if(phase!=='active'||blocked||busy||completed||!cartToken||!items.length)return;
   const draft:CheckoutDraft={version:1,tenant,branch,cartToken,updatedAt:Date.now(),form,items};
   const raw=JSON.stringify(draft);if(!parseDraft(raw,tenant,branch))return;
   try{localStorage.setItem(localKey,raw);}catch{/* Server status is independent of local storage. */}
   // Object identity changes must not cause repeated storage writes.
   // eslint-disable-next-line react-hooks/exhaustive-deps
 },[snapshot,phase,blocked,busy,completed,localKey]);
 useEffect(()=>{
   if(phase!=='active'||blocked||working||!ready||busy||completed||!cartToken||!items.length||saved===snapshot)return;
   const timer=setTimeout(()=>{
     if(flight.current)return;
     flight.current=true;setWorking(true);setMessage('Guardando tu pedido…');
     const value=access.current?.cartToken===cartToken?access.current:{cartToken,secret:newSecret(),revision:0};
     remember(value);
     void draftRequest<{revision:number;expiresAt:string;linkedToRecovery:boolean}>('save',{tenant,branch,...value,form}).then(result=>{
       if(!mounted.current||latest.current.completed||latest.current.cartToken!==value.cartToken)return;
       if(latest.current.items.length)updateContinuity(value.secret);
       remember({...value,revision:result.revision});setSaved(snapshot);
       setLink(privateLink(location.origin,tenant,branch,value.secret));
       setMessage(currentSnapshot.current===snapshot?'Tu pedido se guardó automáticamente.':'Guardando los últimos cambios…');
     }).catch(error=>{if(mounted.current){setBlocked(true);setMessage(error.message);}})
       .finally(()=>{flight.current=false;if(mounted.current)setWorking(false);});
   },2000);
   return()=>clearTimeout(timer);
 },[phase,blocked,working,ready,busy,completed,cartToken,items.length,snapshot,saved,tenant,branch,form]);
 if(completed)return null;
 // Keep all save/restore effects mounted. Conflicts and failures remain actionable.
 if(props.compactNotice && phase!=='choice' && phase!=='error' && !blocked) return <p>Conserva tu enlace privado o usa tu acceso de recuperación. El guardado y la recuperación actuales se mantienen.</p>;
 const canShare=Boolean(link)&&saved===snapshot&&!working&&!busy&&!blocked;
 const button='min-h-12 rounded-xl border px-4 py-3 text-sm font-semibold disabled:opacity-50';
 return <section aria-label="Guardado automático del pedido" className="mx-auto my-3 max-w-5xl rounded-2xl border border-zinc-200 bg-white p-4">
   <p className="text-sm" role="status">{message}</p>
   {choices.map((candidate,index)=><button key={candidate.draft.cartToken} className={button+' mt-2'} disabled={working||busy} onClick={async()=>{
     if(flight.current)return;flight.current=true;setWorking(true);
     try{await apply(candidate);}catch(error){setPhase('error');setBlocked(true);setMessage(error instanceof Error?error.message:'No se pudo recuperar el pedido.');}
     finally{flight.current=false;setWorking(false);}
   }}>Continuar carrito {index+1}</button>)}
   {phase==='choice'&&<button className={button+' mt-2'} disabled={working} onClick={()=>{setChoices([]);setPhase('active');setMessage('Puedes continuar con el carrito actual.');}}>Mantener el carrito actual</button>}
   <details className="mt-2 text-sm">
     <summary className="min-h-11 cursor-pointer py-3 font-semibold">Si cambias de navegador o usas un lector temporal</summary>
     <p className="my-2 text-zinc-600">Después de que aparezca «Tu pedido se guardó automáticamente», usa la opción del lector «Abrir en el navegador». Prepararemos la dirección para continuar tu pedido allí, si el lector conserva el enlace completo. Si el lector borra la sesión al cerrar, escanear otra vez el QR comercial no recupera tu identidad. También puedes usar tu enlace privado o tu acceso de recuperación.</p>
     <div className="flex flex-wrap gap-2">
       <button className={button} disabled={!canShare} onClick={async()=>{try{await navigator.clipboard.writeText(link);setMessage('Enlace privado copiado.');}catch{setMessage('Mantén pulsado el enlace privado para copiarlo.');}}}>Copiar enlace privado</button>
       <button className={button} disabled={!canShare} onClick={async()=>{try{if(navigator.share)await navigator.share({title:'Continuar mi pedido',url:link});else setMessage('Puedes copiar el enlace privado.');}catch{/* User may cancel sharing. */}}}>Compartir enlace</button>
       <button className={button} onClick={onViewOrders}>Mi acceso de recuperación</button>
     </div>
     {canShare&&<a className="mt-2 block underline" href={link} referrerPolicy="no-referrer">Enlace privado de este pedido</a>}
     <p className="mt-2 text-xs text-zinc-600">Quien tenga el enlace puede acceder al borrador mientras el carrito esté vigente.</p>
     {blocked&&<button className={button+' mt-2'} disabled={working||busy} onClick={()=>{boot.current=false;setPhase('loading');setRetryVersion(value=>value+1);}}>Revisar la última versión guardada</button>}
   </details>
 </section>;
}
