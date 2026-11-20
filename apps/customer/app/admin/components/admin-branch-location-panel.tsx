'use client';
import {useEffect,useRef,useState} from 'react';
import {FlashApiError,getStaffBranchLocation,saveStaffBranchLocation,type StaffBranchLocation} from '../../../lib/flash-api';
import AdminBranchMap from './admin-branch-map';
import styles from './admin-branch-location.module.css';

function parsePoint(latitude:string,longitude:string){
  if(!latitude.trim()||!longitude.trim())return null;
  const lat=Number(latitude),lng=Number(longitude);
  return Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180?{latitude:lat,longitude:lng}:null;
}
export default function AdminBranchLocationPanel({tenantCode,branchCode}:{tenantCode:string;branchCode:string}){
  const [saved,setSaved]=useState<StaffBranchLocation|null>(null),[address,setAddress]=useState(''),[latitude,setLatitude]=useState(''),[longitude,setLongitude]=useState('');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[mapOpen,setMapOpen]=useState(false),[reloadRequired,setReloadRequired]=useState(false),[loadVersion,setLoadVersion]=useState(0);
  const oneFlight=useRef(false),alive=useRef(false),generation=useRef(0);
  const point=parsePoint(latitude,longitude),cleanAddress=address.trim().replace(/\s+/g,' ');
  const dirty=!!saved&&(cleanAddress!==saved.address||(point?.latitude??null)!==saved.latitude||(point?.longitude??null)!==saved.longitude);
  const valid=cleanAddress.length>=8&&cleanAddress.length<=400&&!!point;
  function populate(value:StaffBranchLocation){setSaved(value);setAddress(value.address);setLatitude(value.latitude===null?'':String(value.latitude));setLongitude(value.longitude===null?'':String(value.longitude));}
  useEffect(()=>{
    alive.current=true;const id=++generation.current;const controller=new AbortController();
    setLoading(true);setSaved(null);setError('');setNotice('');setMapOpen(false);setReloadRequired(false);
    getStaffBranchLocation(controller.signal).then(value=>{if(!alive.current||generation.current!==id)return;if(value.tenantCode!==tenantCode||value.branchCode!==branchCode)throw Error('scope');populate(value);}).catch(()=>{if(alive.current&&generation.current===id&&!controller.signal.aborted)setError('No pudimos cargar la sucursal. Verifica tu sesión de administrador y vuelve a cargar.');}).finally(()=>{if(alive.current&&generation.current===id)setLoading(false);});
    return()=>{alive.current=false;generation.current++;controller.abort();};
  },[tenantCode,branchCode,loadVersion]);
  useEffect(()=>{if(!dirty||busy)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty,busy]);
  async function save(){
    if(oneFlight.current||loading||reloadRequired||!saved||!valid||!point||!dirty)return;
    oneFlight.current=true;setBusy(true);setError('');setNotice('');const id=generation.current;
    try{const value=await saveStaffBranchLocation({address:cleanAddress,...point,revision:saved.revision});
      if(!alive.current||generation.current!==id)return;
      if(value.tenantCode!==tenantCode||value.branchCode!==branchCode)throw Error('scope');
      populate(value);setNotice('Dirección y ubicación guardadas correctamente.');
    }catch(cause){if(alive.current&&generation.current===id){setReloadRequired(true);setError(cause instanceof FlashApiError&&cause.status===409?'La sucursal cambió en otra sesión. Recarga los datos y revisa los cambios.':cause instanceof FlashApiError&&[401,403].includes(cause.status)?'La sesión venció o no tienes permiso. Inicia sesión como administrador y recarga los datos.':'No pudimos confirmar el guardado. Recarga los datos para comprobar el resultado antes de volver a guardar.');}}
    finally{oneFlight.current=false;if(alive.current&&generation.current===id)setBusy(false);}
  }
  function reload(){if(busy)return;if(dirty&&!window.confirm('¿Recargar los datos guardados y descartar lo que editaste aquí?'))return;setLoadVersion(v=>v+1);}
  function changed(){setNotice('');}
  return <section className={styles.panel} aria-labelledby="branch-location-title"><header className={styles.header}><div><p className={styles.eyebrow}>Configuración del local</p><h2 id="branch-location-title" className={styles.title}>Datos de la sucursal</h2><p className={styles.hint}>Configura la dirección y el punto de salida para calcular los envíos.</p></div><span className={styles.badge}>{saved?.branchName??branchCode}</span></header>
    {loading?<div className={styles.body}><p role="status">Cargando datos de la sucursal…</p></div>:!saved?<div className={styles.body}><div><p role="alert" className={`${styles.notice} ${styles.error}`}>{error}</p><button className={styles.secondary} type="button" onClick={reload}>Volver a cargar</button></div></div>:<form onSubmit={e=>{e.preventDefault();void save();}}>
    <div className={styles.body}><div><div className={styles.field}><label htmlFor="branch-full-address" className={styles.label}>Dirección completa</label><textarea id="branch-full-address" className={styles.input} rows={3} required minLength={8} maxLength={400} disabled={busy||reloadRequired} placeholder="Calle o avenida, número, zona y ciudad" value={address} onChange={e=>{setAddress(e.target.value);changed();}}/></div>
    <div className={styles.coordinates}><div className={styles.field}><label className={styles.label} htmlFor="branch-latitude">Latitud</label><input className={styles.input} id="branch-latitude" type="number" step="any" min="-90" max="90" required disabled={busy||reloadRequired} value={latitude} onChange={e=>{setLatitude(e.target.value);changed();}}/></div><div className={styles.field}><label className={styles.label} htmlFor="branch-longitude">Longitud</label><input className={styles.input} id="branch-longitude" type="number" step="any" min="-180" max="180" required disabled={busy||reloadRequired} value={longitude} onChange={e=>{setLongitude(e.target.value);changed();}}/></div></div>
    <p className={styles.hint}>Puedes elegir el punto en el mapa o ingresar sus coordenadas. Debe corresponder a la puerta de salida del local.</p>
    {!saved.deliveryEnabled&&<p className={styles.notice}>El servicio de delivery está deshabilitado para esta sucursal. Guardar la ubicación no lo activa.</p>}
    {error&&<p role="alert" className={`${styles.notice} ${styles.error}`}>{error}</p>}{notice&&<p role="status" className={`${styles.notice} ${styles.success}`}>{notice}</p>}
    <div className={styles.notice}>Esta ubicación se usa en nuevas cotizaciones. Los clientes con una cotización anterior tendrán que recalcular el envío si cambias el punto de salida.</div>
    <div className={styles.actions}><button className={styles.primary} type="submit" disabled={!valid||!dirty||busy||reloadRequired}>{busy?'Guardando…':'Guardar datos de sucursal'}</button><button className={styles.secondary} type="button" disabled={busy} onClick={reload}>Recargar datos</button></div>{dirty&&!busy&&!notice&&<p className={styles.hint}>Tienes cambios sin guardar.</p>}</div>
    <div><label className={styles.label}>Ubicación de la sucursal</label>{mapOpen?<><AdminBranchMap tenantCode={tenantCode} point={point} onChange={p=>{if(!busy&&!reloadRequired){setLatitude(p.latitude.toFixed(6));setLongitude(p.longitude.toFixed(6));changed();}}} disabled={busy||reloadRequired}/><button type="button" className={styles.secondary} disabled={busy} onClick={()=>setMapOpen(false)}>Cerrar mapa</button></>:<div className={styles.mapShell}><div className={styles.mapPlaceholder}><span aria-hidden="true">{tenantCode==='POLLO001'?<img src="/images/maps/mr-pollo-branch-pin-v1.png" width={64} height={64} alt="" draggable={false}/>:<span style={{fontSize:34}}>📍</span>}</span><strong>{point?'Ubicación registrada':'Selecciona el punto de salida'}</strong><p className={styles.hint}>Revisa el lugar exacto de la sucursal antes de guardar.</p><button className={styles.secondary} type="button" disabled={busy||reloadRequired} onClick={()=>setMapOpen(true)}>Elegir ubicación en el mapa</button></div></div>}</div></div>
    <div className={styles.foot}><p className={styles.hint}>Solo un administrador puede modificar estos datos. El avance y la entrega seguirán dependiendo del GPS real del repartidor.</p></div></form>}
  </section>;
}
