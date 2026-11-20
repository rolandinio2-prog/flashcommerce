"use client";

import { useId, type ReactNode } from 'react';
import styles from './order-design.module.css';

export function CatalogSection({ title, children, summary }: {
  title: string; children: ReactNode; summary?: ReactNode; revealRequest?: number;
}) {
  const id = useId();
  return <section className={styles.catalogSection} aria-labelledby={id}>
    <h2 id={id} className={styles.catalogSectionTitle}>{title}</h2>
    <div className={styles.catalogSectionPanel}>
    {summary && <div className={styles.catalogSectionSummary}>{summary}</div>}
    <div className={styles.catalogSectionBody}>{children}</div>
    </div>
  </section>;
}
