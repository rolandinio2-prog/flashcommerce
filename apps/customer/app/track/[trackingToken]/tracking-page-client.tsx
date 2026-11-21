"use client";
import { useResetOnChange } from '../../../lib/use-reset-on-change';
import {createMonitorSnapshotSync} from '../../ops/delivery-monitor/delivery-monitor-snapshot-sync';


import Link from "next/link";
import styles from './tracking-design.module.css';
import TrackingMapClient from "../../components/tracking-map-client";
import {
  getOrderDeliveryLocation,
  type PublicDeliveryLocation,
} from "../../../lib/flash-api";
import { useEffect, useRef, useState } from "react";

import {
  getOrderTracking,
  type CreatedOrder,
  type FlashOrderStatus,
  type OrderPaymentStatus,
} from "../../../lib/flash-api";

const ORDER_PROGRESS: Array<{
  status: FlashOrderStatus;
  label: string;
  description: string;
}> = [
  {
    status: "PENDING",
    label: "Recibido",
    description: "Recibimos tu pedido.",
  },
  {
    status: "CONFIRMED",
    label: "Confirmado",
    description: "El comercio confirmó tu pedido.",
  },
  {
    status: "PREPARING",
    label: "En preparación",
    description: "Estamos preparando tu pedido.",
  },
  {
    status: "READY",
    label: "Listo",
    description: "Tu pedido está listo.",
  },
  {
    status: "COMPLETED",
    label: "Completado",
    description: "El pedido fue completado.",
  },
];

const ORDER_TYPE_LABELS: Record<CreatedOrder["orderType"], string> = {
  DINE_IN: "Consumo en local",
  TAKEAWAY: "Para llevar",
  PICKUP: "Recoger en sucursal",
  DELIVERY: "Delivery",
};

const PAYMENT_LABELS: Record<OrderPaymentStatus, string> = {
  NOT_REQUIRED: "No requerido",
  PENDING: "Pendiente",
  AWAITING_CONFIRMATION: "Esperando confirmación",
  PAID: "Pagado",
  FAILED: "Fallido",
  EXPIRED: "Expirado",
  CANCELLED: "Cancelado",
  REFUND_PENDING: "Reembolso pendiente",
  REFUNDED: "Reembolsado",
  REVIEW_REQUIRED: "Revisión requerida",
};

const STATUS_LABELS: Record<FlashOrderStatus, string> = {
  PENDING: "Recibido",
  CONFIRMED: "Confirmado",
  PREPARING: "En preparación",
  READY: "Listo",
  COMPLETED: "Completado",
  CANCELLED: "Cancelado",
};

const STATUS_MESSAGES: Record<FlashOrderStatus, string> = {
  PENDING: "Tu pedido fue recibido y está pendiente de confirmación.",
  CONFIRMED: "Todo está confirmado. El pedido puede pasar a preparación.",
  PREPARING: "La cocina está preparando tu pedido.",
  READY: "Tu pedido ya está listo.",
  COMPLETED: "Gracias. El pedido fue completado correctamente.",
  CANCELLED: "Este pedido fue cancelado.",
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-BO", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function trackingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";

  if (/404|not found|no encontrado/i.test(message)) {
    return "No encontramos un pedido para este enlace.";
  }

  return "No pudimos actualizar el pedido. Intenta nuevamente en unos segundos.";
}

function paymentBadgeClasses(status: OrderPaymentStatus): string {
  if (status === "PAID" || status === "NOT_REQUIRED") {
    return "bg-emerald-100 text-emerald-800";
  }

  if (
    status === "PENDING" ||
    status === "AWAITING_CONFIRMATION" ||
    status === "REFUND_PENDING" ||
    status === "REVIEW_REQUIRED"
  ) {
    return "bg-amber-100 text-amber-800";
  }

  return "bg-rose-100 text-rose-800";
}

function statusBadgeClasses(status: FlashOrderStatus): string {
  if (status === "COMPLETED") {
    return "bg-emerald-100 text-emerald-800";
  }

  if (status === "CANCELLED") {
    return "bg-rose-100 text-rose-800";
  }

  if (status === "READY") {
    return "bg-sky-100 text-sky-800";
  }

  return "bg-zinc-100 text-zinc-800";
}

function BackIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m10 6-6 6 6 6M4 12h16"/></svg>; }
function Chevron() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>; }
export function confirmationHref(order: CreatedOrder, token: string) {
  return '/menu/'+encodeURIComponent(order.tenant.code)+'/'+encodeURIComponent(order.branch.code)+'#order='+encodeURIComponent(token);
}
export default function TrackingPageClient({trackingToken}:{trackingToken:string}) {
  const [mapExpanded,setMapExpanded]=useState(false);
  const expandButton=useRef<HTMLButtonElement>(null);
  const scrollBeforeExpand=useRef(0);
  useResetOnChange([trackingToken],()=>setMapExpanded(false));
  useEffect(()=>{
    if(!mapExpanded)return;
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setMapExpanded(false);expandButton.current?.focus({preventScroll:true});}};
    window.addEventListener('keydown',onKey);
    return ()=>{document.body.style.overflow=previousOverflow;window.removeEventListener('keydown',onKey);window.scrollTo({top:scrollBeforeExpand.current,behavior:'instant'});};
  },[mapExpanded]);
  const [order,setOrder]=useState<CreatedOrder|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const [openPanel,setOpenPanel]=useState<'order'|'preparation'|null>(null);
  const [fcG4114DeliveryLocation,setFcG4114DeliveryLocation]=useState<PublicDeliveryLocation|null>(null);
  const [fcG4114DeliveryLocationError,setFcG4114DeliveryLocationError]=useState<string|null>(null);


  useResetOnChange([trackingToken], () => {
    setOrder(null); setOpenPanel(null); setFcG4114DeliveryLocation(null); setFcG4114DeliveryLocationError(null);
    if (isUuid(trackingToken)) { setLoading(true); setError(null); } else { setError('El enlace de seguimiento no es válido.'); setLoading(false); }
  });
  useEffect(() => {
    if (!isUuid(trackingToken)) return;
    const sync = createMonitorSnapshotSync<CreatedOrder>({
      fetchSnapshot: signal => getOrderTracking(trackingToken,signal),
      onSnapshot: next => { setOrder(next); setError(null); setLoading(false); if (next.status === 'COMPLETED' || next.status === 'CANCELLED') sync.dispose(); },
      onError: error => { setError(trackingErrorMessage(error)); setLoading(false); },
      onLoading: () => {}, isVisible: () => document.visibilityState !== 'hidden',
    });
    const wake = () => { void sync.request(); };
    document.addEventListener('visibilitychange',wake); window.addEventListener('online',wake); wake();
    return () => { sync.dispose(); document.removeEventListener('visibilitychange',wake); window.removeEventListener('online',wake); };
  }, [trackingToken]);
  useEffect(() => {
    if (!isUuid(trackingToken) || order?.orderType !== 'DELIVERY' || order.status === 'COMPLETED' || order.status === 'CANCELLED') return;
    const sync = createMonitorSnapshotSync<PublicDeliveryLocation>({
      fetchSnapshot: signal => getOrderDeliveryLocation(trackingToken,signal),
      onSnapshot: value => { setFcG4114DeliveryLocation(value); setFcG4114DeliveryLocationError(null); },
      onError: error => setFcG4114DeliveryLocationError(error instanceof Error ? error.message : 'No se pudo actualizar la ubicación.'),
      onLoading: () => {}, isVisible: () => document.visibilityState !== 'hidden', intervalMs:10000,
    });
    const wake = () => { void sync.request(); };
    document.addEventListener('visibilitychange',wake); window.addEventListener('online',wake); wake();
    return () => { sync.dispose(); document.removeEventListener('visibilitychange',wake); window.removeEventListener('online',wake); };
  }, [trackingToken,order?.orderType,order?.status]);
  if(loading || (order && order.trackingToken!==trackingToken))return <main className={styles.page}><div className={styles.shell}><p role="status" className={styles.notice}>Cargando tu pedido…</p></div></main>;
  if(!order)return <main className={styles.page}><div className={styles.shell}><header className={styles.header}><h1>Seguimiento del pedido</h1></header><div className={styles.notice} role="status"><h2>No pudimos mostrar el pedido</h2><p>{error}</p>{isUuid(trackingToken)&&<p>Volveremos a intentarlo automáticamente.</p>}</div><Link className={styles.back} href="/">Ir al inicio</Link></div></main>;
  const statusIndex=ORDER_PROGRESS.findIndex(step=>step.status===order.status);
  const lastEvent=order.tracking?.[order.tracking.length-1];
  const terminal=order.status==='COMPLETED'||order.status==='CANCELLED';
  const itemCount=order.items.reduce((count,item)=>count+item.quantity,0);
  const backHref=confirmationHref(order,trackingToken);
  return <main className={`${styles.page} ${mapExpanded ? styles.mapExpanded : ""}`}><div className={styles.shell}>
    <header className={styles.header}>
      <p className={styles.eyebrow}>FLASHCOMMERCE</p>
      <h1>Seguimiento de tu pedido</h1>
      <p className={styles.orderIdentity}><strong>Pedido #{order.orderNumber}</strong><span aria-hidden="true">·</span><span>{order.branch.name||order.branch.code}</span></p>
      <p className={styles.live} data-final={terminal}>{terminal?'Pedido finalizado':'Seguimiento automático'}</p>
    </header>
    <div className={styles.summaryRow} aria-label="Resumen del seguimiento" hidden={mapExpanded}>

      <section className={styles.summaryTile}>
        <h2 className={styles.cardHeading}><button id="order-panel-toggle" type="button" className={styles.summaryToggle} aria-expanded={openPanel==='order'} aria-controls="order-panel" onClick={()=>setOpenPanel(current=>current==='order'?null:'order')}>
          <span className={styles.inlineTop}><span className={styles.inlineTitle}>Pedido</span><strong className={styles.inlineAmount}>{formatMoney(order.totals.total,order.currency)}</strong><Chevron/></span>
          <span className={styles.inlineMeta}><small>{itemCount} {itemCount===1?'producto':'productos'}</small><small>{order.orderType==='DELIVERY'?'Incluye envío':ORDER_TYPE_LABELS[order.orderType]}</small></span>
        </button></h2>
      </section>
      <section className={styles.summaryTile}>
        <h2 className={styles.cardHeading}><button id="preparation-panel-toggle" type="button" className={styles.summaryToggle} aria-expanded={openPanel==='preparation'} aria-controls="preparation-panel" onClick={()=>setOpenPanel(current=>current==='preparation'?null:'preparation')}>
          <span className={styles.inlineTop}><span className={styles.inlineTitle}>Estado de preparación</span><strong className={styles.inlineStatus} aria-live="polite" aria-atomic="true">{STATUS_LABELS[order.status]}</strong><Chevron/></span>
        </button></h2>
      </section>
    </div>
    {error && <p role="status" className={styles.warning}>No pudimos actualizar. Conservamos la última información y volveremos a intentarlo.</p>}
      <div id="order-panel" role="region" aria-labelledby="order-panel-toggle" hidden={mapExpanded || openPanel!=='order'} className={`${styles.panel} ${styles.detailPanel}`}>
        <div className={styles.line}><span>Pago</span><strong className={`${styles.badge} ${paymentBadgeClasses(order.paymentStatus)}`}>{PAYMENT_LABELS[order.paymentStatus]}</strong></div>
        {order.fulfillment.customerName&&<div className={styles.line}><span>Cliente</span><strong>{order.fulfillment.customerName}</strong></div>}
        {order.fulfillment.customerPhone&&<div className={styles.line}><span>Teléfono</span><strong>{order.fulfillment.customerPhone}</strong></div>}
        {order.fulfillment.tableCode&&<div className={styles.line}><span>Mesa</span><strong>{order.fulfillment.tableCode}</strong></div>}
        {order.fulfillment.deliveryAddress&&<div className={styles.address}><span>Dirección</span><strong>{order.fulfillment.deliveryAddress}</strong></div>}
        {order.fulfillment.scheduledFor&&<div className={styles.line}><span>Retiro programado</span><strong>{new Date(order.fulfillment.scheduledFor).toLocaleString('es-BO')}</strong></div>}
        {order.reservation&&<div className={styles.line}><span>Reserva {order.reservation.reservationCode}</span><strong>{new Date(order.reservation.reservedFor).toLocaleString('es-BO')}</strong></div>}
        {order.fulfillment.customerNotes&&<div className={styles.address}><span>Nota</span><strong>{order.fulfillment.customerNotes}</strong></div>}
        <ul className={styles.items} aria-label="Productos del pedido">{order.items.map((item,index)=><li key={index}><span>{item.quantity} × {item.product.name}</span><strong>{formatMoney(item.lineTotal,order.currency)}</strong></li>)}</ul>
        <div className={styles.line}><span>Subtotal</span><strong>{formatMoney(order.totals.subtotal,order.currency)}</strong></div>
        {order.totals.discountTotal>0&&<div className={styles.line}><span>Descuento</span><strong>−{formatMoney(order.totals.discountTotal,order.currency)}</strong></div>}
        {order.orderType==='DELIVERY'&&<div className={styles.line}><span>Envío</span><strong>{formatMoney(order.totals.deliveryFee,order.currency)}</strong></div>}
      </div>
      <div id="preparation-panel" role="region" aria-labelledby="preparation-panel-toggle" hidden={mapExpanded || openPanel!=='preparation'} className={`${styles.panel} ${styles.detailPanel}`}>
        <p className={styles.message}>{STATUS_MESSAGES[order.status]}</p>
        {order.status==='CANCELLED'?<p className={styles.warning}>Este pedido ya no continuará por las etapas de preparación.</p>:<ol className={styles.timeline} aria-label="Progreso de preparación">{ORDER_PROGRESS.map((step,index)=><li key={step.status} data-reached={index<=statusIndex} aria-current={index===statusIndex?'step':undefined}><span className={styles.dot} aria-hidden="true">{index<statusIndex||terminal?'✓':index===statusIndex?'•':''}</span><div><strong>{step.label}</strong><p>{step.description}</p></div></li>)}</ol>}
        {lastEvent?.changedAt&&<p className={styles.lastChange}>Último cambio: {new Date(lastEvent.changedAt).toLocaleString('es-BO')}</p>}
      </div>
    <div className={styles.mapArea}>
      {order.orderType==='DELIVERY' && (fcG4114DeliveryLocation?.destination || fcG4114DeliveryLocation?.branchOrigin) && <div className={styles.mapToolbar}>
        <span>Mapa de seguimiento</span><button ref={expandButton} type="button" className={styles.expandMap} aria-expanded={mapExpanded} aria-controls="tracking-map-region" onClick={()=>{if(!mapExpanded)scrollBeforeExpand.current=window.scrollY;setMapExpanded(value=>!value);}}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d={mapExpanded?'M8 3v5H3m13-5v5h5M8 21v-5H3m13 5v-5h5':'M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5'}/></svg>{mapExpanded?'Reducir mapa':'Ampliar mapa'}
        </button>
      </div>}
            {order.orderType === "DELIVERY" && (fcG4114DeliveryLocation?.destination || fcG4114DeliveryLocation?.branchOrigin) ? (
        <section id="tracking-map-region" data-fc-g4114-public-customer-map="true" className="mx-auto mb-6 max-w-2xl">
          <TrackingMapClient
            tenantCode={order.tenant.code}
            key={trackingToken+':'+(fcG4114DeliveryLocation.routeIdentity??'legacy')}
            trackingToken={trackingToken+':'+(fcG4114DeliveryLocation.routeIdentity??'legacy')}
            driverPosition={
              fcG4114DeliveryLocation.location
                ? {
                    latitude: fcG4114DeliveryLocation.location.latitude,
                    longitude: fcG4114DeliveryLocation.location.longitude,
                  }
                : null
            }
            branchOrigin={fcG4114DeliveryLocation.branchOrigin ?? null}
            destination={fcG4114DeliveryLocation.destination}
            encodedPolyline={fcG4114DeliveryLocation.route?.encodedPolyline ?? null}
          />
          {fcG4114DeliveryLocation.routeStatus==='MISSING_ORIGIN'&&<p role="status">La sucursal no tiene ubicación configurada para calcular la ruta.</p>}
          {fcG4114DeliveryLocation.routeStatus==='UNAVAILABLE'&&<p role="status">No se pudo cargar la ruta por calles. El seguimiento continuará actualizándose.</p>}
          {fcG4114DeliveryLocationError ? (
            <p className="mt-2 text-sm font-medium text-amber-700">
              {fcG4114DeliveryLocationError}
            </p>
          ) : null}
        </section>
      ) : null}

    </div>
    <footer className={styles.footer} hidden={mapExpanded}><a className={styles.back} href={backHref}><BackIcon/>Volver al pedido</a></footer>
  </div></main>;
}
