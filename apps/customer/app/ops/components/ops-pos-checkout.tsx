"use client";
import { useEffect,useRef,useState } from 'react';
import QRCode from 'react-qr-code';
import { confirmOperationalCashPayment,type FlashCart,type CreatedOrder,type OrderPaymentResponse } from '../../../lib/flash-api';
import { posCatalog,posCurrent,posNew,posItem,posCheckout,posQr,posPayment,type PosCatalog,type PosProduct } from '../../../lib/ops-pos-api';

const money=(v:number)=>`Bs ${v.toFixed(2)}`;
const button='rounded-xl border px-4 py-3 font-bold disabled:opacity-50';
export function restorePosProductFocus(trigger:HTMLButtonElement|null,fallback:HTMLInputElement|null) {
  if(trigger?.isConnected&&!trigger.disabled)trigger.focus();
  else if(fallback?.isConnected&&!fallback.disabled)fallback.focus();
}
export default function OpsPosCheckout({onComplete}:{onComplete:()=>Promise<void>}) {
  const [catalog,setCatalog]=useState<PosCatalog|null>(null),[cart,setCart]=useState<FlashCart|null>(null),[order,setOrder]=useState<CreatedOrder|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[search,setSearch]=useState(''),[category,setCategory]=useState('');
  const [mode,setMode]=useState<'DINE_IN'|'TAKEAWAY'>('DINE_IN'),[name,setName]=useState(''),[phone,setPhone]=useState(''),[notes,setNotes]=useState('');
  const [selection,setSelection]=useState<PosProduct|null>(null),[variant,setVariant]=useState(''),[rice,setRice]=useState<''|'WHITE'|'CHAUFA'>('');
  const [review,setReview]=useState(false),[method,setMethod]=useState<'CASH'|'QR'>('CASH'),[received,setReceived]=useState(''),[cashReview,setCashReview]=useState(false);
  const [payment,setPayment]=useState<OrderPaymentResponse|null>(null),[change,setChange]=useState<number|null>(null);
  const lock=useRef(false),creationKey=useRef<string|null>(null),cashKey=useRef<string|null>(null),polling=useRef(false);
  const mounted=useRef(true),productDialog=useRef<HTMLDialogElement>(null),productTrigger=useRef<HTMLButtonElement|null>(null),productSearch=useRef<HTMLInputElement>(null);
  useEffect(()=>{const dialog=productDialog.current;if(selection&&!order&&dialog){dialog.showModal();dialog.querySelector<HTMLSelectElement>('select')?.focus();return()=>{if(dialog.open)dialog.close();};}},[selection,order]);
  useEffect(()=>{if(!selection&&!busy&&productTrigger.current){const trigger=productTrigger.current;productTrigger.current=null;restorePosProductFocus(trigger,productSearch.current);}},[selection,busy]);
  useEffect(()=>{mounted.current=true;Promise.all([posCatalog(),posCurrent()]).then(([products,current])=>{if(mounted.current){setCatalog(products);setCart(current.cart);setOrder(current.order);}}).catch(e=>{if(mounted.current)setError(e.message);});return()=>{mounted.current=false;};},[]);
  const paid=payment?.order.paymentStatus==='PAID'||order?.paymentStatus==='PAID';
  useEffect(()=>{
    if(!order||paid)return;
    const id=order.id;let active=true;
    const read=async()=>{if(polling.current)return;polling.current=true;try{const result=await posPayment(id);if(active){setPayment(result);if(result.order.paymentStatus==='PAID')await onComplete();}}catch(e){if(active)setError(e instanceof Error?e.message:'No pudimos verificar el pago.');}finally{polling.current=false;}};
    void read();const timer=setInterval(()=>void read(),5000);return()=>{active=false;clearInterval(timer);};
  },[order?.id,paid]);
  async function run(action:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:'No se pudo completar. Verifica el estado antes de intentar de nuevo.');}finally{lock.current=false;setBusy(false);}}
  async function recover(){const current=await posCurrent();setCart(current.cart);setOrder(current.order);if(current.order)setPayment(await posPayment(current.order.id));await onComplete();}
  async function newSale(){
    if(order&&!paid&&!window.confirm(`El pedido #${order.orderNumber} seguirá pendiente. ¿Comenzar otra venta?`))return;
    if(cart?.items.length&&!order&&!window.confirm('¿Dejar el borrador actual y comenzar otra venta?'))return;
    await run(async()=>{creationKey.current??=crypto.randomUUID();const next=await posNew(creationKey.current);setCart(next);setOrder(null);setPayment(null);setReview(false);setSelection(null);setCashReview(false);setReceived('');setChange(null);setName('');setPhone('');setNotes('');cashKey.current=null;creationKey.current=null;});
  }
  const products=catalog?.categories.flatMap(c=>c.products.map(p=>({...p,categoryId:c.id,categorySlug:c.slug})))??[];
  const visible=products.filter(p=>!p.presentationParentId&&!p.garnishParentId&&(!category||p.categoryId===category)&&(`${p.name} ${p.sku??''}`).toLowerCase().includes(search.toLowerCase()));
  const choices=selection?.hasPresentations?products.filter(p=>p.presentationParentId===selection.id&&!p.garnishParentId):selection?[selection]:[];
  const chosen=choices.find(p=>p.id===variant);
  const riceRequired=selection?products.find(p=>p.id===selection.id)?.categorySlug==='pollos':false;
  const cashAmount=Number(received.replace(',','.')),cashValid=/^\d+(?:[.,]\d{1,2})?$/.test(received)&&Number.isFinite(cashAmount)&&cashAmount>=(order?.totals.total??Infinity);
  async function confirmOrder(){await run(async()=>{
    if(!cart||cart.status!=='OPEN')return;
    const created=await posCheckout({cartToken:cart.token,orderType:mode,expectedTotal:cart.summary.total,expectedRevision:cart.revision,customerName:name,customerPhone:phone,customerNotes:notes});
    setOrder(created);setReview(false);cashKey.current=crypto.randomUUID();await onComplete();
  });}
  async function cash(){await run(async()=>{
    if(!order||!cashValid)return;
    if(!cashReview){setCashReview(true);return;}
    cashKey.current??=crypto.randomUUID();
    const result=await confirmOperationalCashPayment(order.id,{cashReceivedAmount:received.replace(',','.'),terminalReference:`POS-${order.orderNumber}`},cashKey.current);
    setPayment({order:result.order,payment:result.payment});setChange(result.payment.cashChangeAmount??null);setCashReview(false);await onComplete();
  });}
  return <section className="mb-6 min-w-0 rounded-2xl border bg-white p-4 sm:p-6" aria-labelledby="pos-title">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="pos-title" className="text-2xl font-black">Nueva venta</h2><p className="text-sm text-zinc-600">Selecciona los productos solicitados por el cliente.</p></div>
      <button type="button" className={button} disabled={busy||!catalog} onClick={()=>void newSale()}>Nueva venta</button></div>
    {error&&<div role="alert" className="mt-4 rounded-xl bg-red-50 p-4 text-red-800">{error}<button type="button" className={button+' mt-2 block'} disabled={busy} onClick={()=>void run(recover)}>Verificar estado</button></div>}
    {!cart&&!order&&<p className="mt-5">Pulsa Nueva venta para comenzar.</p>}
    {cart&&!order&&<div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <div className="min-w-0"><label className="block font-bold">Buscar producto<input ref={productSearch} className="mt-2 w-full rounded-xl border p-3 text-base" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Nombre o código"/></label>
        <div className="my-3 flex flex-wrap gap-2"><button type="button" className={button} aria-pressed={!category} onClick={()=>setCategory('')}>Todos</button>{catalog?.categories.map(c=><button type="button" key={c.id} className={button} aria-pressed={category===c.id} onClick={()=>setCategory(c.id)}>{c.name}</button>)}</div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">{visible.map(p=><button type="button" key={p.id} disabled={busy||review||!p.available||p.availableQuantity===0} onClick={e=>{productTrigger.current=e.currentTarget;setSelection(p);setVariant(p.hasPresentations?'':p.id);setRice('');}} className="min-w-0 rounded-xl border p-3 text-left disabled:opacity-40">
          {p.imageUrl&&<img src={p.imageUrl} alt="" className="mb-2 h-24 w-full rounded-lg object-cover"/>}<strong className="block break-words">{p.name}</strong><span className="block text-red-700">{p.hasPresentations?'Desde ':''}{money(p.price)}</span>{(!p.available||p.availableQuantity===0)&&<span className="text-sm">No disponible</span>}</button>)}</div>
      </div>
      <div className="min-w-0 rounded-xl bg-zinc-50 p-4"><h3 className="text-xl font-bold">Pedido del cliente</h3>
        {cart.items.length===0&&<p className="my-4 text-zinc-600">Agrega productos del catálogo.</p>}
        {cart.items.map(line=><div key={line.product.id+line.riceChoice} className="border-b py-3"><strong className="block break-words">{line.product.name}</strong><p className="text-sm">{line.riceChoice==='WHITE'?'Arroz blanco':line.riceChoice==='CHAUFA'?'Arroz chaufa':''}{line.includedQuantity?` · ${line.includedQuantity} incluidas`:''}</p><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span>{money(line.lineTotal)}</span><div className="flex items-center gap-2">
          <button type="button" aria-label={'Reducir '+line.product.name} className={button} disabled={busy||review} onClick={()=>void run(async()=>setCart(await posItem(cart.token,line.quantity===1?'remove':'set',{productId:line.product.id,quantity:line.quantity-1,riceChoice:line.riceChoice})))}>−</button><span>{line.quantity}</span>
          <button type="button" aria-label={'Aumentar '+line.product.name} className={button} disabled={busy||review} onClick={()=>void run(async()=>setCart(await posItem(cart.token,'set',{productId:line.product.id,quantity:line.quantity+1,riceChoice:line.riceChoice})))}>+</button></div></div></div>)}
        {Boolean(cart.summary.sauces?.missing)&&<p className="mt-3 text-amber-800">Faltan {cart.summary.sauces?.missing} salsas incluidas. Selecciónalas en el catálogo.</p>}
        <label className="mt-4 block">Modalidad<select className="mt-1 w-full rounded-lg border p-3 text-base" value={mode} disabled={review||busy} onChange={e=>setMode(e.target.value as typeof mode)}><option value="DINE_IN">Consumo en local</option><option value="TAKEAWAY">Para llevar</option></select></label>
        <label className="mt-3 block">Nombre (opcional)<input className="w-full rounded-lg border p-3 text-base" maxLength={120} value={name} disabled={review||busy} onChange={e=>setName(e.target.value)}/></label>
        <label className="mt-3 block">Indicaciones (opcional)<input className="w-full rounded-lg border p-3 text-base" maxLength={500} value={notes} disabled={review||busy} onChange={e=>setNotes(e.target.value)}/></label>
        <div className="my-4 flex justify-between text-xl font-black"><span>Total</span><span>{money(cart.summary.total)}</span></div>
        {review&&<p className="mb-3 text-sm">Confirma los productos con el cliente. Se creará un pedido pendiente de pago.</p>}
        <button type="button" className={button+' w-full bg-red-600 text-white'} disabled={busy||!cart.items.length||Boolean(cart.summary.sauces?.missing)} onClick={()=>review?void confirmOrder():setReview(true)}>{busy?'Procesando…':review?'Crear pedido y continuar al pago':'Revisar pedido'}</button>
        {review&&<button type="button" className={button+' mt-2 w-full'} disabled={busy} onClick={()=>setReview(false)}>Editar pedido</button>}
      </div>
    </div>}
    {selection&&!order&&<dialog ref={productDialog} aria-label="Opciones del producto" onCancel={e=>{if(busy)e.preventDefault();else setSelection(null);}} className="max-h-[85dvh] w-[calc(100%-2rem)] max-w-md overflow-auto rounded-2xl bg-white p-5 backdrop:bg-black/50"><div><h3 className="text-xl font-bold">{selection.name}</h3>
      <label className="mt-4 block">Presentación<select className="w-full rounded-lg border p-3 text-base" value={variant} disabled={busy} onChange={e=>setVariant(e.target.value)}><option value="">Elige una opción</option>{choices.map(p=><option key={p.id} value={p.id} disabled={!p.available||p.availableQuantity===0}>{p.presentationLabel??p.name} · {money(p.price)}</option>)}</select></label>
      {riceRequired&&<label className="mt-4 block">Arroz incluido<select className="w-full rounded-lg border p-3 text-base" value={rice} disabled={busy} onChange={e=>setRice(e.target.value as typeof rice)}><option value="">Elige el arroz</option><option value="WHITE">Blanco</option><option value="CHAUFA">Chaufa</option></select></label>}
      <button type="button" className={button+' mt-4 w-full bg-red-600 text-white'} disabled={busy||!chosen||(riceRequired&&!rice)} onClick={()=>void run(async()=>{if(chosen){setCart(await posItem(cart!.token,'add',{productId:chosen.id,quantity:1,riceChoice:rice}));setSelection(null);}})}>Agregar al pedido</button>
      <button type="button" className={button+' mt-2 w-full'} disabled={busy} onClick={()=>setSelection(null)}>Cancelar</button></div></dialog>}
    {order&&<div className="mt-5 rounded-xl border p-4"><h3 className="text-xl font-black">Pedido #{order.orderNumber} · {money(order.totals.total)}</h3><p>Productos registrados. {paid?'Pago confirmado.':'Pendiente de pago.'}</p>
      <div className="my-3 divide-y">{order.items.map((item,index)=><div key={index} className="flex flex-wrap justify-between gap-2 py-2"><span>{item.quantity} × {item.product.name}</span><strong>{money(item.lineTotal)}</strong></div>)}</div>
      {paid?<div role="status" className="mt-4 rounded-lg bg-green-50 p-4 text-green-800">Pago confirmado. {change!==null&&`Cambio: ${money(change)}`} Ya puedes iniciar otra venta.</div>:<>
        <div className="my-4 flex gap-3">{(['CASH','QR'] as const).map(v=><button type="button" key={v} className={button} disabled={busy} aria-pressed={method===v} onClick={()=>{setMethod(v);setCashReview(false);}}>{v==='CASH'?'Efectivo':'QR'}</button>)}</div>
        {method==='CASH'?<><label className="block">Efectivo recibido<input inputMode="decimal" className="mt-1 w-full max-w-sm rounded-lg border p-3 text-base" value={received} disabled={busy||cashReview} onChange={e=>setReceived(e.target.value)}/></label>{cashValid&&<p className="mt-2 font-bold">Cambio: {money(Math.round((cashAmount-order.totals.total)*100)/100)}</p>}
          {cashReview&&<p className="mt-3">Confirma únicamente después de recibir el dinero. El servidor comprobará cualquier QR pendiente antes de cobrar.</p>}
          <button type="button" className={button+' mt-4 bg-red-600 text-white'} disabled={busy||!cashValid} onClick={()=>void cash()}>{cashReview?'Confirmar efectivo':'Revisar cobro'}</button>{cashReview&&<button type="button" className={button+' ml-2'} disabled={busy} onClick={()=>setCashReview(false)}>Corregir</button>}</>:<>
          <label className="block">Teléfono para el QR, si lo exige el proveedor<input inputMode="tel" maxLength={25} className="mt-1 w-full max-w-sm rounded-lg border p-3 text-base" value={phone} onChange={e=>setPhone(e.target.value)} disabled={busy}/></label>
          <button type="button" className={button+' mt-3'} disabled={busy} onClick={()=>void run(async()=>{const result=await posQr(order.id,phone);setPayment({order:result.order,payment:result.payment});})}>Generar o consultar QR</button>
          {payment?.payment?.qrPayload&&<div className="mt-4 max-w-xs rounded-xl border bg-white p-4">{payment.payment.qrContentType==='TEXT'?<QRCode value={payment.payment.qrPayload} size={220} style={{width:'100%',height:'auto'}}/>:payment.payment.qrContentType==='IMAGE_BASE64'&&<img alt="QR del pedido" src={`data:${payment.payment.qrMimeType};base64,${payment.payment.qrPayload}`} className="w-full"/>}</div>}<p className="mt-3">La confirmación se consulta automáticamente. Una captura no acredita el pago.</p>
        </>}
      </>}
    </div>}
  </section>;
}
