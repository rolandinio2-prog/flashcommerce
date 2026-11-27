'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import styles from './orders-history.module.css';

export default function OrdersDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return <dialog ref={ref} className={styles.dialog} aria-labelledby="orders-history-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className={styles.shell}>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>Tus compras</p><h2 id="orders-history-title">Mis pedidos</h2></div>
        <button autoFocus type="button" aria-label="Cerrar Mis pedidos" className={styles.close} onClick={onClose}>×</button>
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  </dialog>;
}
