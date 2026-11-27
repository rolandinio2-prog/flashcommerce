"use client";
import { useId } from 'react';
import RecoveryCodeInput from './recovery-code-input';
import styles from './order-design.module.css';

export default function CheckoutContact({ name, phone, onName, onPhone, disabled, pin, onPin, saved, samePhone, saving, error, onRetry, retryDisabled, pending, message, savedHint = "Recuperación activada · Delivery, Retiro y Retiro programado.", namePlaceholder = "¿Quién recibirá el pedido?", mode="register", onMode, editing=false, onEdit, onCancelEdit, onSaveEdit }: {
  mode?: 'recover'|'register'; onMode?: (mode:'recover'|'register')=>void;
  editing?: boolean; onEdit?: ()=>void; onCancelEdit?: ()=>void; onSaveEdit?: ()=>void;
  pin: string; onPin: (value: string) => void; saved: boolean; samePhone: boolean;
  saving: boolean; error: string | null; onRetry: () => void; retryDisabled: boolean; pending: boolean; message: string; savedHint?: string; namePlaceholder?: string;
  name: string; phone: string; onName: (value: string) => void; onPhone: (value: string) => void; disabled: boolean;
}) {
  const id = useId();
  return <section className={styles.checkoutContact} aria-label="Tus datos y recuperación" aria-busy={saving}>
    <h3>Tus datos y recuperación</h3>
    {!samePhone && onMode && <div className={styles.contactModes} role="group" aria-label="Acceso a tus datos">
      <button type="button" aria-pressed={mode==='recover'} disabled={disabled} onClick={()=>onMode('recover')}>Ya soy cliente</button>
      <button type="button" aria-pressed={mode==='register'} disabled={disabled} onClick={()=>onMode('register')}>Primera vez</button>
    </div>}
    {(samePhone || mode==='register') && <label className={styles.contactField} htmlFor={`${id}-name`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3Z"/></svg>
      <span><span>Nombre completo</span><input id={`${id}-name`} value={name} onChange={e=>onName(e.target.value)} autoComplete="name" placeholder={namePlaceholder} disabled={disabled} readOnly={samePhone && !editing} required maxLength={120}/></span>
    </label>}
    <div className={`${styles.contactPair} ${samePhone && !editing ? styles.contactPairVerified : ""}`}>
    <label className={styles.contactField} htmlFor={`${id}-phone`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 3 4 4-2 3a16 16 0 0 0 7 7l3-2 4 4-2 3C10 23 1 14 2 5Z"/></svg>
      <span><span>Nro. de teléfono / WhatsApp</span><input id={`${id}-phone`} type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e=>onPhone(e.target.value)} placeholder="Ej.: 70000000" disabled={disabled} readOnly={editing} required maxLength={25}/></span>
    </label>
    {(!samePhone || editing) && <div className={`${styles.contactField} ${styles.contactCodeField}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/></svg>
      <span><label htmlFor={`${id}-code`}>Código de recuperación</label><RecoveryCodeInput id={`${id}-code`} value={pin} onChange={onPin} disabled={disabled} describedBy={`${id}-help`}/></span>
    </div>}
    </div>
    <p id={`${id}-help`} className={styles.registrationHelp}>{editing ? 'Para cambiar tu nombre, confirma tu código actual y pulsa Guardar nombre.' : samePhone ? 'Tu código ya está verificado. No necesitas escribirlo otra vez.' : mode==='recover' ? 'Ingresa tu teléfono y código de 6 dígitos. Validaremos el acceso antes de mostrar tus datos.' : 'Completa los tres campos. Se guardarán automáticamente. Si ya tienes cuenta, usa tu código actual.'}</p>
    <div className={`${styles.contactAutoStatus} ${saved ? styles.contactAutoSaved : error ? styles.contactAutoError : ''}`} role="status" aria-live="polite" aria-atomic="true">
      <span aria-hidden="true">{saved ? '✓' : saving ? '◌' : error ? '!' : '○'}</span>
      <span>{saving ? 'Verificando tus datos…' : error ? 'No pudimos verificar el acceso' : saved ? 'Datos verificados' : pending ? 'Preparando la verificación…' : message}</span>
    </div>
    {samePhone && !editing && onEdit && <button type="button" className={styles.contactEdit} disabled={disabled} onClick={onEdit}>Editar nombre</button>}
    {samePhone && editing && <div className={styles.contactModes}><button type="button" disabled={disabled || retryDisabled} onClick={onSaveEdit}>Guardar nombre</button><button type="button" disabled={disabled} onClick={onCancelEdit}>Cancelar</button></div>}
    {saved && <p className={styles.contactAutoHint}>{savedHint}</p>}
    {error && <div className={styles.contactAutoFailure}><p role="alert">{error}</p><button type="button" disabled={disabled || retryDisabled} onClick={onRetry}>Reintentar</button></div>}
  </section>;
}
