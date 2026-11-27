"use client";
import { isCartActionPending, type PendingCartAction } from "./cart-action-queue";

import { cannotIncrease, orderMoney, type OrderProduct } from './order-product-card';
import styles from './order-design.module.css';

export interface SauceSummary {
  selected: number;
  includedLimit: number;
  included: number;
  extra: number;
  extraTotal: number;
  missing: number;
  discountTotal: number;
}

export function SauceCounter({ summary }: { summary: SauceSummary }) {
  return <div className={styles.sauceCompactCounter} role="status" aria-live="polite" aria-atomic="true">
    <div className={styles.sauceIncludedChip}><span>Gratis</span><strong>{summary.included}/{summary.includedLimit}</strong></div>
    <div className={styles.sauceExtraChip}><span>Adicionales <strong>{summary.extra}</strong></span><small>{orderMoney(summary.extraTotal, 'BOB')}</small></div>
  </div>;
}

export function SauceSelector({ products, quantities, includedQuantities, summary, ready, busy, pendingActions = [], onAdd, onDecrease }: {
  products: OrderProduct[]; quantities: Record<string, number>; includedQuantities: Record<string, number>; summary: SauceSummary;
  pendingActions?: readonly PendingCartAction[];
  ready: boolean; busy: boolean; onAdd: (product: OrderProduct) => void; onDecrease: (id: string) => void;
}) {
  // Each row uses the server allocation; adding another flavor cannot move existing free portions.
  return <div>
    <p className={styles.sauceCompactHelp}>{summary.includedLimit > 0
      ? '2 porciones gratis. Cada adicional cuesta Bs 7.'
      : 'Cada porción cuesta Bs 7.'}</p>
    {summary.missing > 0 && <p className={styles.saucePending}>Te falta elegir {summary.missing} {summary.missing === 1 ? 'salsa incluida' : 'salsas incluidas'}.</p>}
    <ul className={styles.sauceCompactList} aria-label="Salsas gratis y adicionales">
      {products.map(product => {
        const adding = isCartActionPending(pendingActions, product.id, "add");
        const decreasing = isCartActionPending(pendingActions, product.id, "decrease");
        const quantity = quantities[product.id] ?? 0;
        const free = Math.min(quantity, Math.max(0, includedQuantities[product.id] ?? 0));
        const extra = quantity - free;
        return <li key={product.id} className={styles.sauceCompactRow}>
          <div className={styles.sauceCompactName}><strong>{product.name.replace(/^Salsa\s+/i, '')}</strong>
            {quantity>0 && <div className={styles.sauceAllocation}>
              {free>0 && <span className={styles.sauceIncludedBadge} aria-label={`${product.name}: ${free} gratis`}>{free} gratis</span>}
              {extra>0 && <span className={styles.sauceExtraBadge} aria-label={`${product.name}: ${extra} adicionales`}>{extra} {extra===1?'extra':'extras'} · {orderMoney(extra * product.price, product.currency)}</span>}
            </div>}
          </div>
        <div className={styles.stepper} role="group" aria-label={`Cantidad de ${product.name}`}>
          <button type="button" aria-busy={decreasing} disabled={!ready || busy || decreasing || !quantities[product.id]} onClick={() => onDecrease(product.id)} aria-label={`Quitar una unidad de ${product.name}`}>{decreasing ? "…" : "−"}</button>
          <output aria-live="polite" aria-atomic="true">{quantities[product.id] ?? 0}</output>
          <button type="button" aria-busy={adding} disabled={!ready || busy || adding || cannotIncrease(product, quantities[product.id] ?? 0)} onClick={() => onAdd(product)} aria-label={`Agregar una unidad de ${product.name}`}>{adding ? "…" : "+"}</button>
        </div>
        </li>;})}
    </ul>
  </div>;
}
