'use client';
import { useResetOnChange } from '../../../../lib/use-reset-on-change';
import AdminProductLifecycle from './admin-product-lifecycle';
import {useEffect,useRef,useState} from 'react';
import {getBranchServices,saveBranchServices,getBranchCatalog,saveBranchCatalogProduct,
 type BranchServices,type BranchServiceKey,type BranchServiceState,type BranchCatalogProduct} from '../../../../lib/flash-api';

const states:Record<BranchServiceState,string>={ENABLED:'Habilitado',DRAINING:'Pausado · terminar pendientes',DISABLED:'Deshabilitado'};
const button='rounded-xl border border-zinc-300 px-4 py-3 text-sm font-bold disabled:opacity-40';
const field='w-full rounded-xl border border-zinc-300 bg-white p-3 text-base';
export default function AdminBranchOperationsPanel(){
 const [services,setServices]=useState<BranchServices|null>(null),[draft,setDraft]=useState<BranchServices['states']|null>(null);
 const [products,setProducts]=useState<BranchCatalogProduct[]>([]),[selected,setSelected]=useState<BranchCatalogProduct|null>(null);
 const [price,setPrice]=useState(''),[available,setAvailable]=useState(true),[reason,setReason]=useState('');
 const [lifecycle,setLifecycle]=useState<{product:BranchCatalogProduct|null}|null>(null);
 const [filter,setFilter]=useState(''),[tab,setTab]=useState<'services'|'products'>('services');
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[uncertain,setUncertain]=useState(false);
 const [reload,setReload]=useState(0),flight=useRef(false),generation=useRef(0);
 const dirty=reason.length>0||!!selected||!!services&&JSON.stringify(services.states)!==JSON.stringify(draft);
 useResetOnChange([reload],()=>{setLoading(true);setError('');setServices(null);setDraft(null);setProducts([]);setSelected(null);setReason('');});
 useEffect(()=>{
  const id=++generation.current,controller=new AbortController();
  Promise.all([getBranchServices(controller.signal),getBranchCatalog(controller.signal)]).then(([s,p])=>{
   if(id!==generation.current)return;setServices(s);setDraft({...s.states});setProducts(p.products);setUncertain(false);
  }).catch(()=>{if(id===generation.current&&!controller.signal.aborted)setError('No pudimos cargar la configuración. Verifica tu sesión de administrador.');})
   .finally(()=>{if(id===generation.current)setLoading(false);});
  return()=>{generation.current++;controller.abort();};
 },[reload]);
 useEffect(()=>{if(!dirty||busy)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty,busy]);
 function reloadData(){if(busy||lifecycle)return;if(dirty&&!window.confirm('¿Recargar y descartar los cambios sin guardar?'))return;setNotice('');setReload(v=>v+1);}
 async function save(){
  if(flight.current||loading||uncertain||!services||!draft||reason.trim().length<5)return;
  if(tab==='products'&&!selected)return;
  flight.current=true;setBusy(true);setError('');setNotice('');const id=generation.current;
  try{
   if(tab==='services')await saveBranchServices({revision:services.revision,states:draft,reason});
   else await saveBranchCatalogProduct(selected!.id,{revision:selected!.revision,price,available,reason});
   if(id!==generation.current)return;
   setNotice('Cambio guardado. Los pedidos anteriores conservan sus datos.');setSelected(null);setReason('');setReload(v=>v+1);
  }catch(cause){if(id===generation.current){setError((cause instanceof Error?cause.message:'No pudimos confirmar el guardado.')+' Recarga y verifica el resultado antes de volver a guardar.');setUncertain(true);}}
  finally{flight.current=false;if(id===generation.current)setBusy(false);}
 }
 function changeTab(value:'services'|'products'){if(busy||lifecycle)return;if(dirty&&!window.confirm('¿Cambiar de sección y descartar lo que editaste?'))return;setTab(value);setSelected(null);setReason('');if(services)setDraft({...services.states});setNotice('');}
 const filtered=products.filter(p=>(p.name+' '+p.category).toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
 return <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm" aria-labelledby="branch-operations-title">
  <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="branch-operations-title" className="text-xl font-black">Operación de la sucursal</h2><p className="mt-1 text-sm text-zinc-600">Precios, disponibilidad y recepción de nuevas solicitudes.</p></div><button type="button" className={button} disabled={busy} onClick={reloadData}>Recargar datos</button></div>
  <div className="my-4 flex gap-2" role="group" aria-label="Configuración de sucursal"><button type="button" className={button} aria-pressed={tab==='services'} disabled={busy} onClick={()=>changeTab('services')}>Servicios</button><button type="button" className={button} aria-pressed={tab==='products'} disabled={busy} onClick={()=>changeTab('products')}>Catálogo y precios</button></div>
  {error&&<p role="alert" className="my-3 rounded-xl bg-red-50 p-3 text-red-800">{error}</p>}{notice&&<p role="status" className="my-3 rounded-xl bg-green-50 p-3 text-green-800">{notice}</p>}
  {tab==='products'&&!loading&&!lifecycle&&<button type="button" className={button+' mb-4 bg-red-600 text-white'} disabled={busy||uncertain||!!selected} onClick={()=>setLifecycle({product:null})}>Nuevo producto</button>}
  {lifecycle&&<AdminProductLifecycle product={lifecycle.product} onClose={()=>setLifecycle(null)} onSaved={message=>{setLifecycle(null);setSelected(null);setReason('');setNotice(message);setReload(v=>v+1);}}/>}
  {!lifecycle&&(loading?<p role="status">Cargando configuración…</p>:services&&draft&&<form onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={busy||uncertain}>
   {tab==='services'?<><p className="mb-4 text-sm text-zinc-600">Pausar bloquea nuevas solicitudes y permite terminar las existentes. Deshabilita después de resolver los pendientes; el histórico se conserva.</p>
    <div className="grid gap-3 md:grid-cols-2">{(Object.keys(draft) as BranchServiceKey[]).map(key=><label key={key} className="rounded-xl border border-zinc-200 p-4"><strong>{services.labels[key]}</strong><select aria-label={services.labels[key]} className={field+' mt-2'} value={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.value as BranchServiceState})}>{(Object.keys(states) as BranchServiceState[]).map(state=><option key={state} value={state} disabled={state==='DISABLED'&&(services.states[key]==='ENABLED'||services.active[key]>0)}>{states[state]}</option>)}</select><small className="mt-2 block text-zinc-500">{services.active[key]} referencias pendientes{key==='DINE_IN'?' (pedidos, reservas y mesas)':''}</small></label>)}</div>
    {!services.deliveryConfigured&&<p className="mt-3 text-sm text-amber-800">Delivery requiere completar su configuración operativa antes de recibir solicitudes.</p>}
   </>:<><label className="block text-sm font-semibold">Buscar producto<input className={field+' mt-1 mb-4'} value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Nombre o categoría"/></label>
    {selected?<div className="rounded-xl border border-red-200 p-4"><h3 className="font-bold">{selected.name}</h3><p className="text-sm text-zinc-500">{selected.category}</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><label>Precio ({selected.currency})<input required className={field} inputMode="decimal" value={price} readOnly={selected.priceLocked} onChange={e=>setPrice(e.target.value.replace(',','.'))}/></label><label className="flex items-center gap-2"><input type="checkbox" checked={available} onChange={e=>setAvailable(e.target.checked)}/>Disponible para nuevos pedidos</label></div>{selected.priceLocked&&<p className="mt-2 text-sm text-zinc-600">Salsas: se mantiene la regla de dos incluidas y Bs 7 por adicional.</p>}<button type="button" className={button+' mt-3'} onClick={()=>{setSelected(null);setReason('');}}>Cancelar edición</button></div>:<div className="max-h-96 overflow-y-auto rounded-xl border border-zinc-200"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-zinc-100"><tr><th className="p-3">Producto</th><th>Precio</th><th>Disponibilidad</th><th><span className="sr-only">Acción</span></th></tr></thead><tbody>{filtered.map(p=><tr className="border-t border-zinc-100" key={p.id}><td className="p-3"><strong>{p.name}</strong><small className="block text-zinc-500">{p.category}</small></td><td>{p.currency} {Number(p.price).toFixed(2)}</td><td>{p.available?'Disponible':'No disponible'}</td><td className="p-2"><button type="button" className={button} aria-label={'Editar '+p.name} onClick={()=>{setSelected(p);setPrice(p.price);setAvailable(p.available);setReason('');setNotice('');}}>Editar</button><button type="button" className={button+' ml-2 text-red-700'} aria-label={'Revisar eliminación de '+p.name} onClick={()=>setLifecycle({product:p})}>Eliminar</button></td></tr>)}</tbody></table>{!filtered.length&&<p className="p-4">No hay productos para esta búsqueda.</p>}</div>}
   </>}
   {(tab==='services'||selected)&&<div className="mt-4"><label className="block text-sm font-semibold">Motivo del cambio<input className={field+' mt-1'} required minLength={5} maxLength={200} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Ej.: cierre temporal de cocina"/></label><p className="my-2 text-xs text-zinc-500">No incluyas datos personales. El cambio se registra para esta sucursal.</p><button type="submit" className={button+' bg-red-600 text-white'} disabled={busy||reason.trim().length<5||uncertain}>{busy?'Guardando…':'Guardar cambios'}</button></div>}
  </fieldset></form>)}
 </section>;
}
