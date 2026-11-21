'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CreatedOrder, PublicDeliveryLocation } from '../../lib/flash-api';
import { orderConfirmationCopy } from '../../lib/checkout-presentation';
import styles from './order-confirmation.module.css';

export function confirmationPresentation(order: CreatedOrder, delivery: PublicDeliveryLocation | null, now: number) {
  const location = delivery?.order.number === order.orderNumber ? delivery : null;
  const isDelivery = order.orderType === 'DELIVERY';
  const cancelled = order.status === 'CANCELLED';
  const delivered = !cancelled && (order.status === 'COMPLETED' || (isDelivery && location?.delivery.status === 'DELIVERED'));
  const arrived = !cancelled && !delivered && isDelivery && location?.delivery.status === 'ARRIVED';
  const enRoute = !cancelled && !delivered && isDelivery && location?.delivery.status === 'EN_ROUTE';
  const deliveryCancelled = !cancelled && !delivered && isDelivery && location?.delivery.status === 'CANCELLED';
  const copy = orderConfirmationCopy(order.status, order.paymentStatus);
  const display = delivered && isDelivery ? {title:'¡Pedido entregado!',description:'Gracias por elegirnos. Tu pedido figura como entregado.',tone:'success'}
    : arrived ? {title:'Tu pedido llegó',description:'El repartidor está en el lugar de entrega.',tone:'success'}
    : enRoute ? {title:'¡Tu pedido está en camino!',description:'El repartidor lleva tu pedido a la dirección elegida.',tone:'success'}
    : deliveryCancelled ? {title:'Entrega pendiente de coordinación',description:'La entrega fue cancelada. Consulta con el comercio para coordinar tu pedido.',tone:'neutral'}
    : copy;
  const labels = isDelivery ? ['Recibido','Confirmado',order.status === 'READY' ? 'Listo para salir' : 'Preparando',arrived ? 'En el lugar de entrega' : 'En camino','Entregado']
    : ['Recibido','Confirmado','Preparando',order.orderType === 'DINE_IN' ? 'Listo para servir' : 'Listo para retirar','Completado'];
  const current = cancelled || deliveryCancelled ? -1 : delivered ? 4 : enRoute || arrived ? 3 : order.status === 'READY' ? (isDelivery ? 2 : 3) : order.status === 'PREPARING' ? 2 : order.status === 'CONFIRMED' ? 1 : 0;
  const captured = location?.location?.capturedAt ? Date.parse(location.location.capturedAt) : NaN;
  const seconds = location?.route?.durationSeconds;
  const fresh = Number.isFinite(captured) && now - captured >= -30000 && now - captured <= 120000;
  let estimate: string | null = null;
  if (isDelivery && !cancelled && !delivered && !deliveryCancelled) {
    estimate = arrived ? 'El repartidor está en tu dirección' : enRoute && fresh && typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
      ? `Aproximadamente ${Math.max(1,Math.ceil(seconds / 60))} min de trayecto`
      : enRoute ? 'Actualizando la estimación del trayecto' : 'Disponible cuando el repartidor salga';
  }
  return {display, labels, current, estimate, terminal:cancelled || delivered, cancelled, location};
}

function Icon({name}: {name:'check'|'clock'|'route'|'receipt'|'share'|'home'|'back'|'info'}) {
  const paths = {check:'m5 12 4 4L19 6',clock:'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',route:'M4 6h5l2 12h9M4 6v12m0-6h13l3 6M8 20h.01M18 20h.01',receipt:'M6 3h12v18l-3-2-3 2-3-2-3 2V3m3 5h6m-6 4h6',share:'M12 16V3m-4 4 4-4 4 4M5 12v8h14v-8',home:'m3 11 9-8 9 8M5 10v11h5v-6h4v6h5V10',back:'m14 6-6 6 6 6M8 12h12',info:'M12 10v6m0-10h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'};
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]}/></svg>;
}

export default function OrderConfirmation({order,delivery,paymentPaid,payment,summary,attention,accessMessage,onShare,onClose}: {
  order:CreatedOrder; delivery:PublicDeliveryLocation|null; paymentPaid:boolean;
  payment:ReactNode; summary:ReactNode; tracking:ReactNode; attention:ReactNode;
  accessMessage:string|null; onShare:()=>void; onClose:()=>void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const progress = useRef<HTMLOListElement>(null);
  // Clock as state (pure render); ticking also lets a location become stale without new data.
  const [now, setNow] = useState(() => Date.now());
  useEffect(()=>{ const timer=setInterval(()=>setNow(Date.now()),15000); return ()=>clearInterval(timer); },[]);
  const view = confirmationPresentation(order,delivery,now);
  useEffect(()=>{
    const element=dialog.current, previous=document.activeElement, overflow=document.body.style.overflow;
    if(element && !element.open)element.showModal();
    heading.current?.focus({preventScroll:true});
    document.body.style.overflow='hidden';
    return ()=>{element?.close();document.body.style.overflow=overflow;if(previous instanceof HTMLElement && previous.isConnected)previous.focus();};
  },[]);
  const canTrack = order.orderType==='DELIVERY' && Boolean(order.trackingToken) && !view.cancelled;
  const paid = paymentPaid || order.paymentStatus==='PAID';
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="order-confirmation-title" onCancel={e=>{e.preventDefault();onClose();}}>
    <header className={styles.hero} style={{paddingTop:16}}>
      <div className={`${styles.celebration} ${view.display.tone==='success'?styles.success:styles.neutral}`} aria-hidden="true">
        {view.display.tone==='success' && <span className={styles.confetti}><i/><i/><i/><i/><i/><i/></span>}
        <span className={styles.seal}><Icon name={view.display.tone==='success'?'check':'info'}/></span>
      </div>
      <div aria-live="polite" aria-atomic="true"><h2 ref={heading} tabIndex={-1} style={{outline:"none"}} id="order-confirmation-title">{view.display.title}</h2><p className={styles.orderNumber}>Pedido #{order.orderNumber}</p><p className={styles.description}>{view.display.description}</p></div>
    </header>
    {view.estimate && <section className={styles.estimate} aria-label="Estimación de entrega"><Icon name="clock"/><div><span>{view.location?.delivery.status==='EN_ROUTE'?'Llegada estimada':'Entrega'}</span><strong>{view.estimate}</strong></div></section>}
    {attention && <div className={styles.attention}>{attention}</div>}
    {!paid && order.paymentStatus!=='NOT_REQUIRED' && <section className={styles.payment} aria-label="Pago del pedido">{payment}</section>}
    {paid && <p className={styles.paid}><Icon name="check"/>Pago verificado</p>}
    {!view.cancelled && view.current>=0 && <ol ref={progress} tabIndex={-1} className={styles.progress} aria-label="Progreso del pedido">
      {view.labels.map((label,index)=><li key={index} data-reached={index<=view.current} aria-current={index===view.current?'step':undefined}>
        <span className={styles.dot} aria-hidden="true">{index<view.current || (index===view.current && view.terminal)?<Icon name="check"/>:index===view.current?'•':''}</span>
        <span>{label}{index===view.current && !view.terminal && <small>Estado actual</small>}</span>
      </li>)}
    </ol>}
    {!view.terminal && <p className={styles.live}>El estado se actualiza automáticamente</p>}
    <div className={styles.actions}>
      {canTrack ? <a className={styles.primary} href={`/track/${encodeURIComponent(order.trackingToken)}`}><Icon name="route"/>Seguir mi pedido</a>
        : !view.terminal && <button type="button" className={styles.primary} onClick={()=>{progress.current?.scrollIntoView({block:'center'});progress.current?.focus();}}><Icon name="clock"/>Ver estado del pedido</button>}
      <details className={styles.details}><summary><Icon name="receipt"/>Ver resumen<span aria-hidden="true">⌄</span></summary><div className={styles.detailBody}>{summary}</div></details>
      {paid && order.paymentStatus!=='NOT_REQUIRED' && <details className={styles.details}><summary><Icon name="check"/>Detalles del pago<span aria-hidden="true">⌄</span></summary><div className={styles.payment}>{payment}</div></details>}
    </div>
    <section className={styles.access}><Icon name="share"/><div><h3>Ten tu pedido a mano</h3><p>Guarda el enlace para volver a tu pedido aunque cierres el lector QR.</p><button type="button" onClick={onShare}>Guardar / compartir acceso</button>{accessMessage && <p role="status">{accessMessage}</p>}</div></section>
    <button type="button" className={styles.home} onClick={onClose}><Icon name="home"/>{view.terminal?'Finalizar seguimiento':'Volver al menú'}</button>
  </dialog>;
}
