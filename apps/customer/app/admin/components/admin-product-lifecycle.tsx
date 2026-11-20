'use client';
import {useEffect,useRef,useState} from 'react';
import {createBranchProduct,deleteBranchProduct,getProductCreationOptions,getProductDeletion,type ProductDeletion,type ProductCategoryOption,type BranchCatalogProduct,type ProductCreation} from '../../../lib/flash-api';
const button='rounded-xl border border-zinc-300 px-4 py-3 text-sm font-bold disabled:opacity-40';
const field='mt-1 w-full rounded-xl border border-zinc-300 bg-white p-3 text-base';
type Props={product:BranchCatalogProduct|null;onClose:()=>void;onSaved:(message:string)=>void};
export default function AdminProductLifecycle({product,onClose,onSaved}:Props){
 const [categories,setCategories]=useState<ProductCategoryOption[]>([]),[check,setCheck]=useState<ProductDeletion|null>(null);
 const [name,setName]=useState(''),[description,setDescription]=useState(''),[categoryId,setCategoryId]=useState(''),[price,setPrice]=useState(''),[available,setAvailable]=useState(false);
 const [presentations,setPresentations]=useState<{label:string;price:string}[]>([]),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [retryCommand,setRetryCommand]=useState<{kind:'create';body:ProductCreation}|{kind:'delete';body:{requestId:string;revision:string;reason:string}}|null>(null);
 const flight=useRef(false),heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{const controller=new AbortController();heading.current?.focus();
  const load=async()=>{try{if(product)setCheck(await getProductDeletion(product.id,controller.signal));else{const r=await getProductCreationOptions(controller.signal);setCategories(r.categories);}}
   catch{if(!controller.signal.aborted)setError('No pudimos revisar los datos. Cierra esta ficha y vuelve a abrirla.');}
   finally{if(!controller.signal.aborted)setLoading(false);}};
  void load();return()=>controller.abort();
 },[product]);
 useEffect(()=>{if(!busy&&!retryCommand&&!name&&!reason)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[busy,retryCommand,name,reason]);
 function close(){if(busy)return;if((retryCommand||name||reason)&&!window.confirm('¿Cerrar esta ficha? Si enviaste una solicitud, revisa el catálogo antes de crear otra.'))return;onClose();}
 function chooseCategory(id:string){setCategoryId(id);const slug=categories.find(c=>c.id===id)?.slug;setPrice(slug==='salsas'?'7.00':'');setPresentations(slug==='pollos'?[{label:'Económico',price:'21.00'},{label:'Cuarto',price:'30.00'},{label:'Medio',price:'55.00'},{label:'Entero',price:'110.00'}]:[]);}
 const category=categories.find(c=>c.id===categoryId);
 async function submit(){
  if(flight.current||loading)return;
  const command=retryCommand??(product?{kind:'delete' as const,body:{requestId:crypto.randomUUID(),revision:check!.revision,reason}}:{kind:'create' as const,body:{requestId:crypto.randomUUID(),name,description,categoryId,price:presentations.length?presentations[0].price:price,available,presentations,reason}});
  flight.current=true;setBusy(true);setError('');setRetryCommand(command);
  try{
   if(command.kind==='create')await createBranchProduct(command.body);else await deleteBranchProduct(product!.id,command.body);
   onSaved(command.kind==='create'?'Producto creado. Revisa su disponibilidad antes de ofrecerlo.':'Producto eliminado. Se conservó el registro de auditoría.');
  }catch(cause){setError((cause instanceof Error?cause.message:'No pudimos confirmar el resultado.')+' Puedes consultar el catálogo o repetir esta misma solicitud; no se duplicará.');}
  finally{flight.current=false;setBusy(false);}
 }
 return <section className="my-4 rounded-2xl border border-red-200 bg-white p-5" aria-labelledby="product-lifecycle-title">
  <div className="flex items-start justify-between gap-3"><h3 ref={heading} tabIndex={-1} id="product-lifecycle-title" className="text-lg font-black">{product?'Eliminar '+product.name:'Nuevo producto'}</h3><button type="button" disabled={busy} className={button} onClick={close}>Cerrar</button></div>
  {loading&&<p role="status" className="mt-3">Revisando datos…</p>}{error&&<p role="alert" className="my-3 rounded-xl bg-red-50 p-3 text-red-800">{error}</p>}
  {!loading&&(!product||check)&&<form className="mt-4" onSubmit={e=>{e.preventDefault();void submit();}}>
   <fieldset disabled={busy||!!retryCommand}>
    {product&&check?<><p className="mb-3">{check.count} registro(s) en este conjunto. También se revisan pedidos cancelados, carritos y otras sucursales.</p><ul className="max-h-48 list-disc overflow-auto pl-5">{check.products.map(p=><li key={p.id}>{p.name}</li>)}</ul>
     {!check.canDelete?<div role="status" className="my-3 rounded-xl bg-amber-50 p-3"><strong>No se puede eliminar</strong><ul className="list-disc pl-5">{check.reasons.map(r=><li key={r}>{r}</li>)}</ul></div>:<label className="my-4 flex items-start gap-2"><input required type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Confirmo eliminar definitivamente el producto y los registros indicados.</label>}
    </>:<div className="grid gap-4 sm:grid-cols-2">
     <label className="sm:col-span-2">Nombre<input required maxLength={85} className={field} value={name} onChange={e=>setName(e.target.value)}/></label>
     <label>Categoría<select required className={field} value={categoryId} onChange={e=>chooseCategory(e.target.value)}><option value="">Selecciona una categoría</option>{categories.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
     {!presentations.length&&<label>Precio (BOB)<input required inputMode="decimal" readOnly={category?.slug==='salsas'} className={field} value={price} onChange={e=>setPrice(e.target.value.replace(',','.'))}/></label>}
     <label className="sm:col-span-2">Descripción (opcional)<textarea maxLength={1000} rows={2} className={field} value={description} onChange={e=>setDescription(e.target.value.replace(/[\r\n]+/g,' '))}/></label>
     <div className="sm:col-span-2"><h4 className="font-bold">Presentaciones y precios</h4>{category?.slug==='pollos'&&<p className="text-sm text-zinc-600">Revisa los tamaños y precios sugeridos. El cliente seguirá eligiendo su arroz.</p>}
      {presentations.map((p,i)=><div className="my-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2" key={i}><label>Tamaño o presentación<input required maxLength={60} className={field} value={p.label} onChange={e=>setPresentations(list=>list.map((x,n)=>n===i?{...x,label:e.target.value}:x))}/></label><label>Precio (BOB)<input required inputMode="decimal" className={field} value={p.price} onChange={e=>setPresentations(list=>list.map((x,n)=>n===i?{...x,price:e.target.value.replace(',','.')}:x))}/></label><button type="button" aria-label={'Quitar presentación '+(i+1)} className={button} disabled={category?.slug==='pollos'&&presentations.length===1} onClick={()=>setPresentations(list=>list.filter((_,n)=>n!==i))}>Quitar</button></div>)}
      {categoryId&&category?.slug!=='salsas'&&<button className={button+' mt-2'} type="button" disabled={presentations.length>=12} onClick={()=>setPresentations(list=>[...list,{label:'',price:''}])}>Agregar presentación</button>}
      {category?.slug==='salsas'&&<p className="mt-2 text-sm">Se mantiene la regla de dos salsas incluidas y Bs 7 por adicional.</p>}
     </div>
     <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={available} onChange={e=>setAvailable(e.target.checked)}/>Disponible para nuevos pedidos</label>
     <p className="text-sm text-zinc-600 sm:col-span-2">El código interno se genera automáticamente. Se crea sin fotografía; los productos con presentaciones se guardan juntos.</p>
    </div>}
    {(!product||check?.canDelete)&&<label className="mt-4 block">Motivo<input required minLength={5} maxLength={200} className={field} value={reason} onChange={e=>setReason(e.target.value)}/><small>No incluyas datos personales.</small></label>}
   </fieldset>
   {(!product||check?.canDelete)&&<button className={button+' mt-4 bg-red-600 text-white'} type="submit" disabled={busy||(!retryCommand&&(reason.trim().length<5||(product?!confirmed:!categoryId||!name.trim())))}>{busy?'Procesando…':retryCommand?'Repetir la misma solicitud':product?'Eliminar definitivamente':'Crear producto'}</button>}
  </form>}
 </section>;
}
