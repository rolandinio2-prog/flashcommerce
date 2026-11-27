'use client';

import { useResetOnChange } from '../../../lib/use-reset-on-change';
import { useEffect, useState } from 'react';
import styles from './order-design.module.css';

export default function RecoveryCodeInput({ id, value, onChange, disabled = false, describedBy, boxed = false }: {
  id: string; value: string; onChange: (value: string) => void;
  disabled?: boolean; describedBy?: string; boxed?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  useResetOnChange([value], () => { if (!value) setVisible(false); });
  return <span className={`${styles.recoveryCodeInput} ${boxed ? styles.recoveryCodeBox : ''}`}>
    <input id={id} type={visible ? 'text' : 'password'} inputMode="numeric" autoComplete="off"
      spellCheck={false} maxLength={6} value={value} disabled={disabled} placeholder="6 dígitos"
      aria-describedby={describedBy} onChange={event => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}/>
    <button type="button" className={styles.recoveryEye} disabled={disabled}
      aria-label={visible ? 'Ocultar código' : 'Mostrar código'} aria-pressed={visible} aria-controls={id}
      onClick={() => setVisible(current => !current)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>{visible && <path d="m3 3 18 18"/>}</svg>
    </button>
  </span>;
}
