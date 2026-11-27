"use client";
import { isCartActionPending, type PendingCartAction } from "./cart-action-queue";

import { useEffect, useRef, useState } from "react";
import { OrderButton, ProductPhoto, QuantityStepper, cannotIncrease, orderMoney, type OrderProduct } from "./order-product-card";
import { type SauceSummary } from './sauce-selector';
import styles from "./order-design.module.css";

export function OrderCart({ items, busy, ready, pendingActions = [], onRefresh, refreshing = false, total, currency, error, onClose, onAdd, onDecrease, onRemove, onContinue, sauceSummary, onChooseSauces }: {
  pendingActions?: readonly PendingCartAction[]; onRefresh?: () => void; refreshing?: boolean;
  sauceSummary?: SauceSummary; onChooseSauces?: () => void;
  items: { product: OrderProduct; quantity: number; lineTotal?: number; includedQuantity?: number }[];
  busy: boolean; ready: boolean; total: number; currency: string; error: string | null;
  onClose: () => void; onAdd: (product: OrderProduct) => void; onDecrease: (id: string) => void;
  onRemove: (id: string) => void; onContinue: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [compact, setCompact] = useState(false);
  const movement = useRef({ last: 0, distance: 0, until: 0 });
  const touch = useRef<{ x: number; y: number } | null>(null);
  function changeChrome(next: boolean) {
    if (next === compact || !window.matchMedia("(max-width: 639px)").matches) return;
    movement.current.until = performance.now() + 300;
    movement.current.distance = 0;
    setCompact(next);
  }
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const blocked = !ready;
  return <dialog ref={ref} className={`${styles.scope} ${styles.dialog}`} aria-labelledby="order-cart-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className={`${styles.cartShell} ${compact ? styles.cartCompact : ""}`}>
      <header className={styles.cartHeader}>
        <div><p className={styles.eyebrow}>Tu selección</p><h2 id="order-cart-title">Tu pedido</h2></div>
        <button autoFocus type="button" className={styles.iconButton} aria-label="Cerrar carrito" onClick={onClose}>×</button>
      </header>
      <div className={styles.cartBody} aria-busy={busy} onScroll={(event) => {
        const body = event.currentTarget;
        const y = Math.max(0, Math.min(body.scrollTop, body.scrollHeight - body.clientHeight));
        const state = movement.current;
        const delta = y - state.last;
        state.last = y;
        // Resizing our own bars must not be mistaken for another user gesture.
        if (performance.now() < state.until) return;
        if (y <= 8 && delta < 0) { changeChrome(true); return; }
        state.distance = Math.sign(delta) === Math.sign(state.distance) ? state.distance + delta : delta;
        if (state.distance > 24 && y > 36) changeChrome(true);
        else if (state.distance < -24) changeChrome(true);
      }} onTouchStart={(event) => {
        if (event.touches.length !== 1 || (event.target instanceof Element && event.target.closest("button, input, select, textarea, a"))) { touch.current = null; return; }
        touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }} onTouchMove={(event) => {
        if (!touch.current || event.touches.length !== 1) return;
        const dx = event.touches[0].clientX - touch.current.x;
        const dy = event.touches[0].clientY - touch.current.y;
        if (Math.abs(dy) > 28 && Math.abs(dy) > Math.abs(dx) * 1.5) {
          // A short order may not overflow; it should still react to a vertical swipe.
          changeChrome(true);
          touch.current = null;
        }
      }} onTouchEnd={() => { touch.current = null; }} onTouchCancel={() => { touch.current = null; }}
      onWheel={(event) => {
        if (event.ctrlKey || Math.abs(event.deltaY) <= 16 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
        changeChrome(true);
      }}>
        {error && <div className={styles.error} role="alert">{error}{onRefresh && <button type="button" className={styles.secondary} disabled={refreshing} onClick={onRefresh}>Actualizar pedido</button>}</div>}
        {items.length === 0 ? <div className={styles.empty}><h3>Tu pedido empieza aquí</h3><p>Elige tus favoritos del menú para agregarlos.</p></div> :
          items.map(({ product, quantity, lineTotal, includedQuantity = 0 }) => <article className={styles.cartItem} key={product.id}>
            <div className={styles.cartItemTop}><ProductPhoto compact product={product} /><div className={styles.cartItemText}>
              <h3>{product.name}</h3><p className={styles.caption}>{includedQuantity > 0
                ? quantity === includedQuantity ? 'Incluida sin costo' : <>{includedQuantity} incluidas · {quantity - includedQuantity} con costo</>
                : <>{orderMoney(product.price, product.currency)} por unidad</>}</p>
              <p className={styles.itemPrice}>{orderMoney(lineTotal ?? product.price * quantity, product.currency)}</p>
            </div></div>
            <div className={styles.cartItemActions}>
              <QuantityStepper name={product.name} quantity={quantity} adding={isCartActionPending(pendingActions, product.id, "add")} decreasing={isCartActionPending(pendingActions, product.id, "decrease")} disabled={blocked} increaseDisabled={cannotIncrease(product, quantity)} onDecrease={() => onDecrease(product.id)} onIncrease={() => onAdd(product)} />
              <button type="button" className={styles.remove} aria-busy={isCartActionPending(pendingActions, product.id, "remove")} disabled={blocked || isCartActionPending(pendingActions, product.id, "remove")} aria-label={`Eliminar ${product.name} del pedido`} onClick={() => onRemove(product.id)}>{isCartActionPending(pendingActions, product.id, "remove") ? "Eliminando…" : "Eliminar"}</button>
            </div>
          </article>)}
        <button type="button" className={styles.secondary} onClick={onClose}>{items.length ? "+ Agregar más productos" : "Explorar el menú"}</button>
      </div>
      <footer className={styles.cartFooter}>
        <p className={styles.saveStatus} role="status">{busy ? <span className="sr-only">Actualizando el pedido</span> : ""}</p>
        {Boolean(sauceSummary?.missing) && <button type="button" className={styles.secondary} onClick={onChooseSauces}>Elegir mis {sauceSummary?.missing} salsas incluidas pendientes</button>}
        <div className={styles.summary}><span>Subtotal de productos</span><strong>{orderMoney(total, currency)}</strong></div>
        <p className={styles.caption}>La modalidad y los cargos de entrega se revisan al continuar.</p>
        <OrderButton disabled={items.length === 0 || blocked || Boolean(sauceSummary?.missing)} aria-disabled={busy || blocked || items.length === 0 || Boolean(sauceSummary?.missing)} onClick={() => { if (!busy && !blocked) onContinue(); }}>Continuar pedido</OrderButton>
      </footer>
    </div>
  </dialog>;
}
