'use client';

import { useEffect, useState } from 'react';
import { getPublicBranchServices, type FlashOrderType, type BranchServiceKey } from '../../lib/flash-api';
import styles from './order-design.module.css';

const modes: { value: FlashOrderType; title: string; description: string }[] = [
  { value: 'DELIVERY', title: 'Delivery', description: 'Recibir en una dirección' },
  { value: 'TAKEAWAY', title: 'Retirar en el local', description: 'Pedir ahora y recoger para llevar' },
  { value: 'PICKUP', title: 'Programar retiro', description: 'Elegir fecha y hora para recoger' },
  { value: 'DINE_IN', title: 'Estoy en el local', description: 'Consumir aquí y elegir mesa si corresponde' },
];

export default function CheckoutModeSelector({ tenant, branch, value, locked, busy, onChange }: {
  tenant: string; branch: string;
  value: FlashOrderType | null; locked: boolean; busy: boolean;
  onChange: (value: FlashOrderType) => void;
}) {
  const [available,setAvailable]=useState<Record<BranchServiceKey,boolean>|null>(null);
  useEffect(()=>{
    let stopped=false,timer:ReturnType<typeof setTimeout>;const controller=new AbortController();
    setAvailable(null);
    const refresh=async()=>{try{const r=await getPublicBranchServices(tenant,branch,controller.signal);if(!stopped)setAvailable(r.available);}catch{if(!stopped)setAvailable(null);}finally{if(!stopped)timer=setTimeout(refresh,30000);}};
    void refresh();return()=>{stopped=true;controller.abort();clearTimeout(timer);};
  },[tenant,branch]);
  // A verified table or reservation already determines the fulfillment mode.
  if (locked) return null;
  return <fieldset disabled={busy} className={styles.checkoutModes}>
    <legend>¿Cómo quieres recibirlo?</legend>
    {!available&&<p role="status">Verificando servicios disponibles…</p>}
    {available&&!available.ORDERING&&<p role="status">La sucursal no recibe nuevos pedidos por el momento. Tus pedidos existentes se conservan.</p>}
    <div className={styles.checkoutModeGrid}>
      {modes.map(mode => <label key={mode.value}
        className={`${styles.checkoutMode} ${value === mode.value ? styles.checkoutModeSelected : ''}`}>
        <input type="radio" name="checkout-mode" value={mode.value} checked={value === mode.value}
          disabled={!available?.ORDERING || !available?.[mode.value]} onChange={() => onChange(mode.value)} />
        <span><strong>{mode.title}</strong><small>{available && (!available.ORDERING || !available[mode.value]) ? "No disponible para nuevos pedidos" : mode.description}</small></span>
      </label>)}
    </div>
  </fieldset>;
}
