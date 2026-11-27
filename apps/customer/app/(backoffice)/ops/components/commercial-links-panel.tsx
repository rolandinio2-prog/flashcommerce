"use client";
import { useRef, useState } from 'react';
import QRCode from 'react-qr-code';
import { downloadCommercialAsset, qrPng, qrSvgDocument } from '../../../../lib/commercial-qr-export';
import styles from './commercial-links.module.css';

type Links = { tenant:{code:string;name:string}; branch:{code:string;name:string}; commerceUrl:string; branchUrl:string };
export default function CommercialLinksPanel() {
  const [open,setOpen]=useState(false),[data,setData]=useState<Links|null>(null),[mode,setMode]=useState<'branch'|'commerce'>('branch');
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const qrRef=useRef<HTMLDivElement>(null),inputRef=useRef<HTMLInputElement>(null),busyRef=useRef(false);
  async function load() {
    setOpen(true);setLoading(true);setError('');setMessage('');setData(null);
    try {
      const response=await fetch('/api/v1/staff/commercial-links',{credentials:'same-origin',cache:'no-store'});
      if(!response.ok) throw new Error(response.status===401||response.status===403?'Tu sesión no permite acceder a este panel. Vuelve a iniciar sesión con un administrador o encargado.':'No se pudieron obtener los enlaces. Revisa la configuración del comercio con el administrador.');
      const value=await response.json() as Links;
      for(const link of [value.commerceUrl,value.branchUrl]) { const url=new URL(link); if(url.protocol!=='https:'||url.search||url.hash||url.username||url.password)throw new Error('La dirección pública no es válida.'); }
      setData(value);
    } catch(e){setError(e instanceof Error?e.message:'No se pudieron obtener los enlaces.');}
    finally{setLoading(false);}
  }
  const url=data?(mode==='branch'?data.branchUrl:data.commerceUrl):'';
  const title=data?`${data.tenant.name}${mode==='branch'?' · '+data.branch.name:''}`:'';
  async function action(kind:'copy'|'share'|'svg'|'png') {
    if(!data||busyRef.current)return;
    busyRef.current=true;setBusy(true);setMessage('');setError('');
    try {
      if(kind==='copy'){
        if(!navigator.clipboard)throw new Error('Selecciona y copia el enlace del campo.');
        await navigator.clipboard.writeText(url);setMessage('Enlace copiado.');
      } else if(kind==='share') {
        if(!navigator.share){setMessage('Este navegador no ofrece compartir. Usa Copiar enlace o descarga el QR.');return;}
        await navigator.share({title,text:`Haz tu pedido en ${title}`,url});
        setMessage('La solicitud se abrió en el sistema de compartir.');
      } else {
        const svg = qrRef.current?.querySelector('svg');
        if(!svg)throw new Error('Espera a que el QR esté disponible.');
        const text=qrSvgDocument(svg);
        const filename=`pedido-${data.tenant.code}-${mode==='branch'?data.branch.code:'comercio'}`;
        const blob=kind==='svg'?new Blob([text],{type:'image/svg+xml;charset=utf-8'}):await qrPng(text);
        downloadCommercialAsset(blob,`${filename}.${kind}`);setMessage('Descarga solicitada. Conserva el margen blanco del QR.');
      }
    }catch(e){
      if(e instanceof DOMException&&e.name==='AbortError'){setMessage('Compartir cancelado.');}
      else {setError(kind==='copy'?'No se pudo copiar automáticamente. Selecciona y copia el enlace del campo.':e instanceof Error?e.message:'No se pudo completar la acción.');if(kind==='copy'){inputRef.current?.focus();inputRef.current?.select();}}
    }finally{busyRef.current=false;setBusy(false);}
  }
  return <section className={styles.panel} aria-labelledby="commercial-title">
    <div className={styles.heading}><div><h2 id="commercial-title">Enlaces y QR para pedidos</h2><p>Comparte el acceso al menú de tu negocio.</p></div>
      <button type="button" aria-expanded={open} aria-controls="commercial-content" disabled={loading||busy} onClick={()=>{if(open){setOpen(false);setData(null);}else void load();}}>{open?'Cerrar panel':'Crear enlace y QR'}</button>
    </div>
    {open&&<div id="commercial-content">
      {loading&&<p role="status">Cargando accesos de tu comercio…</p>}
      {error&&<p role="alert" className={styles.error}>{error}</p>}
      {!data&&!loading&&<button type="button" onClick={()=>void load()}>Volver a cargar</button>}
      {data&&<>
        <fieldset disabled={busy} className={styles.choices}><legend>¿A dónde quieres llevar a tus clientes?</legend>
          <label><input type="radio" name="commercial-target" checked={mode==='branch'} onChange={()=>{setMode('branch');setMessage('');setError('');}}/> Esta sucursal · {data.branch.name}</label>
          <label><input type="radio" name="commercial-target" checked={mode==='commerce'} onChange={()=>{setMode('commerce');setMessage('');setError('');}}/> Mi comercio · el cliente elige sucursal</label>
        </fieldset>
        <div className={styles.content}>
          <div ref={qrRef} className={styles.qr}><QRCode value={url} size={256} level="M" bgColor="#ffffff" fgColor="#000000" title={`QR para pedir en ${title}`} style={{width:'100%',height:'auto',display:'block'}}/></div>
          <div className={styles.details}><h3>{title}</h3><p>{mode==='branch'?'Abre directamente los productos de esta sucursal.':'Permite elegir entre las sucursales activas de tu comercio.'}</p>
            <label>Enlace para hacer pedidos<input ref={inputRef} readOnly value={url} onFocus={e=>e.currentTarget.select()}/></label>
            <div className={styles.actions}>
              <button type="button" disabled={busy} onClick={()=>void action('copy')}>Copiar enlace</button>
              <button type="button" disabled={busy} onClick={()=>void action('share')}>Compartir enlace</button>
              <a href={url} target="_blank" rel="noopener noreferrer">Abrir menú</a>
              <button type="button" disabled={busy} onClick={()=>void action('png')}>Descargar QR PNG</button>
              <button type="button" disabled={busy} onClick={()=>void action('svg')}>Descargar QR SVG</button>
            </div>
            <p className={styles.hint}>En WhatsApp y redes envía el enlace junto al QR: así pueden pedir desde el mismo teléfono. Para imprimir, utiliza SVG y conserva el margen blanco.</p>
          </div>
        </div>
      </>}
      <p role="status" className={styles.status}>{busy?'Preparando…':message}</p>
    </div>}
  </section>;
}
