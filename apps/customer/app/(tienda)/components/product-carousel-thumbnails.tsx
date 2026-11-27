"use client";

import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { ProductPhoto, type OrderProduct } from "./order-product-card";
import styles from "./order-design.module.css";

export function ProductCarouselThumbnails({ products, currentId }: {
  products: Pick<OrderProduct, "id" | "name" | "imageUrl">[];
  currentId: string;
}) {
  const navRef = useRef<HTMLElement>(null);
  const productIds = products.map(product => product.id).join('|');
  const ownsRail = products[0]?.id === currentId;
  useEffect(() => {
    if (!ownsRail) return;
    const rail = navRef.current?.closest<HTMLElement>('[data-product-carousel]');
    if (!rail) return;
    const cards = Array.from(rail.children).filter((child): child is HTMLElement => child instanceof HTMLElement && Boolean(child.dataset.productId));
    const media = window.matchMedia('(max-width: 639px)');
    let frame = 0;
    function measure() {
      frame = 0;
      if (!rail || !cards.length) return;
      if (!media.matches) { rail.style.removeProperty('height'); return; }
      const bounds = rail.getBoundingClientRect();
      const center = bounds.left + rail.clientLeft + rail.clientWidth / 2;
      const active = cards.reduce((best, card) => {
        const a = card.getBoundingClientRect(), b = best.getBoundingClientRect();
        return Math.abs(a.left + a.width / 2 - center) < Math.abs(b.left + b.width / 2 - center) ? card : best;
      });
      const css = getComputedStyle(rail);
      const spacing = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom) + rail.offsetHeight - rail.clientHeight;
      const height = `${Math.ceil(active.getBoundingClientRect().height + spacing)}px`;
      if (rail.style.height !== height) rail.style.height = height;
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(measure); }
    const observer = new ResizeObserver(schedule);
    cards.forEach(card => observer.observe(card));
    rail.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    media.addEventListener('change', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      rail.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      media.removeEventListener('change', schedule);
      rail.style.removeProperty('height');
    };
  }, [ownsRail, productIds]);
  if (products.length < 2) return null;
  function navigate(button: HTMLButtonElement, index: number) {
    const rail = button.closest<HTMLElement>('[data-product-carousel]');
    if (!rail || rail.scrollWidth <= rail.clientWidth + 1) return;
    const target = Array.from(rail.children).find(child => (child as HTMLElement).dataset.productId === products[index]?.id) as HTMLElement | undefined;
    if (!target) return;
    const left = rail.scrollLeft + target.getBoundingClientRect().left - rail.getBoundingClientRect().left - rail.clientLeft;
    rail.scrollTo({ left, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target.querySelector<HTMLButtonElement>('button[aria-current="true"]')?.focus({ preventScroll: true });
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? Math.min(index + 1, products.length - 1) : event.key === 'ArrowLeft' ? Math.max(index - 1, 0) : event.key === 'Home' ? 0 : event.key === 'End' ? products.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    navigate(event.currentTarget, next);
  }
  function onClick(event: MouseEvent<HTMLButtonElement>, index: number) {
    event.stopPropagation();
    navigate(event.currentTarget, index);
  }
  return <nav ref={navRef} className={styles.carouselThumbnails} aria-label="Explorar productos">
    <div className={styles.carouselThumbnailList}>
      {products.map((product, index) => <button key={product.id} type="button" className={styles.carouselThumbnailButton}
        aria-label={`Ver ${product.name}`} aria-current={product.id === currentId ? "true" : undefined}
        title={product.name} onClick={event => onClick(event, index)} onKeyDown={event => onKeyDown(event, index)}>
        <span aria-hidden="true"><ProductPhoto product={product} compact /></span>
      </button>)}
    </div>
  </nav>;
}
