"use client";
import { useResetOnChange } from '../../lib/use-reset-on-change';
import { isCartActionPending, type PendingCartAction } from "./cart-action-queue";

import { useEffect, useId, useState, type ReactNode, type ButtonHTMLAttributes } from "react";
import styles from "./order-design.module.css";


// Called only by horizontal scrolling, never by initial rendering or vertical page scroll.
export function revealVisibleProduct(rail: HTMLElement, reveal: (id: string) => void) {
  if (rail.scrollWidth <= rail.clientWidth + 1) return;
  const cards = Array.from(rail.children).filter((child): child is HTMLElement => child instanceof HTMLElement && Boolean(child.dataset.productId));
  if (!cards.length) return;
  const bounds = rail.getBoundingClientRect();
  const center = bounds.left + rail.clientLeft + rail.clientWidth / 2;
  const closest = cards.reduce((best, card) => {
    const a = card.getBoundingClientRect(), b = best.getBoundingClientRect();
    return Math.abs(a.left+a.width/2-center) < Math.abs(b.left+b.width/2-center) ? card : best;
  });
  const id = closest.dataset.productId!;
  const previous = rail.dataset.visibleProductId ?? cards[0].dataset.productId;
  rail.dataset.visibleProductId = id;
  if (id !== previous) reveal(id);
}

export type RiceChoice = 'WHITE' | 'CHAUFA';
export type OrderProduct = {
  baseProductId?: string;
  riceChoice?: RiceChoice | '';
  hasPresentations?: boolean;
  hasGarnishes?: boolean;
  id: string; name: string; description?: string | null; imageUrl?: string | null;
  price: number; currency: string; available: boolean; availableQuantity: number | null; preparationMinutes: number;
};
export function orderMoney(amount: number, currency: string) {
  return `${currency === "BOB" ? "Bs" : currency} ${amount.toFixed(2)}`;
}
function beverageMoney(amount: number, currency: string) {
  return `${currency === "BOB" ? "Bs" : currency} ${amount.toFixed(Number.isInteger(amount) ? 0 : 2)}`;
}
export function OrderButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={`${styles.primary} ${className}`} />;
}
export function ProductPhoto({ product, compact = false }: { product: Pick<OrderProduct, "name" | "imageUrl">; compact?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <div className={compact ? styles.thumbnail : styles.image}>
    {product.imageUrl && product.imageUrl !== failed ? (
      // Tenant media hosts are supplied by the catalog.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={product.imageUrl} alt={product.name} loading="lazy" decoding="async" onError={() => setFailed(product.imageUrl ?? null)} />
    ) : <span>{compact ? "Sin foto" : "Imagen no disponible"}</span>}
  </div>;
}
export function QuantityStepper({ quantity, disabled, increaseDisabled = false, adding = false, decreasing = false, name, onDecrease, onIncrease }: {
  quantity: number; disabled: boolean; increaseDisabled?: boolean; adding?: boolean; decreasing?: boolean; name: string; onDecrease: () => void; onIncrease: () => void;
}) {
  return <div className={styles.stepper} role="group" aria-label={`Cantidad de ${name}`}>
    <button type="button" disabled={disabled || decreasing} aria-busy={decreasing} onClick={onDecrease} aria-label={`Quitar una unidad de ${name}`}>{decreasing ? "…" : "−"}</button>
    <output aria-live="polite" aria-atomic="true">{quantity}</output>
    <button type="button" disabled={disabled || increaseDisabled || adding} aria-busy={adding} onClick={onIncrease} aria-label={`Agregar una unidad de ${name}`}>{adding ? "…" : "+"}</button>
  </div>;
}
export function cannotIncrease(product: OrderProduct, quantity: number) {
  return !product.available || (product.availableQuantity !== null && quantity >= product.availableQuantity);
}
export function OrderProductCard({ product, quantity, ready, busy, pendingActions = [], onAdd, onDecrease, presentations = [], compact = false, onAddPresentation, onDecreasePresentation, belowPhoto, requiresRice = false, riceQuantities = {}, totalQuantities = {}, expandSizesRequest = 0 }: {
  pendingActions?: readonly PendingCartAction[];
  expandSizesRequest?: number;
  requiresRice?: boolean;
  riceQuantities?: Record<string, number>;
  totalQuantities?: Record<string, number>;
  compact?: boolean;
  belowPhoto?: ReactNode;
  presentations?: {product: OrderProduct; label: string; quantity: number}[];
  onAddPresentation?: (id:string, rice?:RiceChoice)=>void; onDecreasePresentation?: (id:string, rice?:RiceChoice)=>void;
  product: OrderProduct; quantity: number; ready: boolean; busy: boolean; onAdd: () => void; onDecrease: () => void;
}) {
  const groupId=useId();
  const [sizesExpanded,setSizesExpanded]=useState(true);
  useResetOnChange([expandSizesRequest], () => { if (expandSizesRequest > 0) setSizesExpanded(true); });
  const [rice,setRice]=useState<RiceChoice | null>(null);
  const [selectedId,setSelectedId]=useState<string|null>(() => compact ? presentations.find(option => option.product.available)?.product.id ?? null : null);
  const selected=presentations.find(p=>p.product.id===selectedId);
  const configurable=Boolean(product.hasPresentations)||presentations.length>0;
  const jarBeverage = compact && /·\s*Jarra$/iu.test(product.name);
  const inlineBeverage = compact && (configurable || jarBeverage);
  const displayName = jarBeverage ? product.name.replace(/\s*·\s*Jarra$/iu, "").replace(/^Jugo\s+(?:de\s+)?/iu, "").replace(/^./u, first => first.toLocaleUpperCase("es")) : product.name;
  const formatPrice = compact ? beverageMoney : orderMoney;
  const chosen=selected?.product ?? product;
  const chosenQuantity=requiresRice ? (rice ? riceQuantities[`${chosen.id}:${rice}`] ?? 0 : 0) : configurable?(selected?.quantity ?? 0):quantity;
  const pendingKey = requiresRice && rice ? `${chosen.id}:${rice}` : chosen.id;
  const adding = isCartActionPending(pendingActions, pendingKey, 'add');
  const decreasing = isCartActionPending(pendingActions, pendingKey, 'decrease');
  const stockQuantity=totalQuantities[chosen.id] ?? chosenQuantity;
  const selectionBlocked=(requiresRice&&!rice) || (configurable&&(!selected||!onAddPresentation||!onDecreasePresentation));
  const increase=()=>{if(configurable&&!compact)setSizesExpanded(true);if(selectionBlocked)return;if(configurable){onAddPresentation?.(chosen.id, rice ?? undefined);}else onAdd();};
  const decrease=()=>{if(configurable&&!compact)setSizesExpanded(true);if(selectionBlocked)return;if(configurable){onDecreasePresentation?.(chosen.id, rice ?? undefined);}else onDecrease();};
  return <article className={`${styles.card} ${compact ? styles.compactProduct : ""} ${inlineBeverage ? styles.beverageProduct : ""}`} data-product-id={product.id}>
    <ProductPhoto product={product} />
    {belowPhoto}
    <div className={styles.content}>
      <div className={styles.productHeading}>
        <h3>{displayName}</h3>
        <p className={styles.headingPrice} aria-live="polite" aria-label={configurable&&!selected?'Precio mínimo; elige un tamaño':'Precio del producto'}>{formatPrice(configurable&&!selected&&presentations.length>0?Math.min(...presentations.map(p=>p.product.price)):chosen.price,chosen.currency)}</p>
      </div>
      {jarBeverage && <p className={styles.caption}>Jarra</p>}
      {!compact && product.description && <p className={styles.description}>{product.description}</p>}
      {configurable && compact && <fieldset className={styles.compactSizes} disabled={!ready || busy}>
        <legend>Presentación</legend>
        {presentations.map(option => <label key={option.product.id} className={selectedId === option.product.id ? styles.compactSizeSelected : styles.compactSizeOption}>
          <input type="radio" name={groupId} value={option.product.id} checked={selectedId === option.product.id} disabled={cannotIncrease(option.product, 0)} onChange={() => setSelectedId(option.product.id)} />
          <span><span>{option.label.replace(/^2 litros$/i, "2 Litros")}</span><strong>{beverageMoney(option.product.price, option.product.currency)}</strong>{!option.product.available && <small>No disponible</small>}</span>
        </label>)}
      </fieldset>}
      {configurable&&!compact&&<fieldset className={styles.sizeCard}>
        <legend className={styles.sizeLegend}>
        <button type="button" className={styles.sizeToggle} aria-expanded={sizesExpanded} aria-controls={`${groupId}-sizes`} onClick={()=>setSizesExpanded(open=>!open)} disabled={!ready||busy}>
          <span>Tamaño del pollo: {selected ? selected.label : "Elige una opción"}</span>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={sizesExpanded ? styles.chevronOpen : undefined}><path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        </legend>
        <div id={`${groupId}-sizes`} hidden={!sizesExpanded}>
        <fieldset className={styles.sizes} aria-label="Tamaño del pollo (Obligatorio)" disabled={!ready||busy}>
        {presentations.map(option=><label key={option.product.id} className={selectedId===option.product.id?styles.sizeSelected:styles.sizeOption}>
          <input type="radio" name={groupId} value={option.product.id} checked={selectedId===option.product.id} disabled={cannotIncrease(option.product,0)} onChange={()=>setSelectedId(option.product.id)}/>
          <span>{option.label}{!option.product.available?' · No disponible':''}</span><strong>{orderMoney(option.product.price,option.product.currency)}</strong>
        </label>)}
        </fieldset>
        </div>
      </fieldset>}
      {requiresRice && selected && sizesExpanded && <fieldset className={styles.riceChoices} disabled={!ready || busy}>
        <legend>Elige tu arroz <span>(Obligatorio)</span></legend>
        <p className={styles.caption}>Incluido en tu pollo · Sin costo adicional</p>
        <div className={styles.riceOptions}>
          {([['WHITE','Blanco'],['CHAUFA','Chaufa']] as const).map(([value,label]) => <label key={value} className={rice === value ? styles.riceOptionSelected : styles.riceOption}>
            <input type="radio" name={groupId+'-rice'} value={value} aria-label={value === 'WHITE' ? 'Arroz blanco' : 'Arroz chaufa'} checked={rice===value} onChange={()=>setRice(value)} />
            <span>{label}</span>
          </label>)}
        </div>
      </fieldset>}
      {!compact && selected && <p className={styles.selectedConfiguration} aria-live="polite">
        <strong>Seleccionado: {selected.label}</strong>
        {requiresRice && <span>{rice === 'WHITE' ? 'Arroz blanco' : rice === 'CHAUFA' ? 'Arroz chaufa' : 'Elige tu arroz'}</span>}
      </p>}
      {(!configurable || selected) && <div className={styles.action}>
        {chosenQuantity > 0 ? <QuantityStepper name={`${chosen.name}${requiresRice && rice ? rice === "WHITE" ? " · Arroz blanco" : " · Arroz chaufa" : ""}`} quantity={chosenQuantity} adding={adding} decreasing={decreasing} disabled={!ready || busy || selectionBlocked} increaseDisabled={cannotIncrease(chosen, stockQuantity)} onDecrease={decrease} onIncrease={increase} /> :
          <OrderButton aria-label={`Agregar ${chosen.name} al pedido`} disabled={selectionBlocked || cannotIncrease(chosen, stockQuantity) || !ready || busy || adding} aria-busy={adding} onClick={increase}>{adding ? "Guardando…" : !(configurable?presentations.some(p=>!cannotIncrease(p.product,0)):!cannotIncrease(product,0)) ? "No disponible" : selectionBlocked ? (requiresRice && selected ? "Elige tu arroz" : "Elige un tamaño") : compact ? "Agregar" : selected ? `Agregar ${selected.label} al pedido` : "Agregar al pedido"}</OrderButton>}
      </div>}
    </div>
  </article>;
}
