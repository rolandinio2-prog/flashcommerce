'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {loadTrackingMapLibraries} from '../../../lib/google-maps';
import {containMapGestures} from '../../../lib/map-gestures';
import styles from './admin-branch-location.module.css';
export type BranchPoint={latitude:number;longitude:number};
export default function AdminBranchMap({point,onChange,disabled,tenantCode}:{tenantCode:string;point:BranchPoint|null;onChange:(p:BranchPoint)=>void;disabled:boolean}) {
  const container=useRef<HTMLDivElement>(null),map=useRef<google.maps.Map|null>(null),alive=useRef(false),manual=useRef(0);
  const onChangeRef=useRef(onChange),disabledRef=useRef(disabled);
  const initial=useRef(point),gpsBusy=useRef(false);
  const latestPoint=useRef(point);
  // Keep the latest props for map listeners/GPS callbacks (synced before any other effect or event).
  useLayoutEffect(()=>{onChangeRef.current=onChange;disabledRef.current=disabled;latestPoint.current=point;});
  const [ready,setReady]=useState(false),[locating,setLocating]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    let disposed=false;alive.current=true;const listeners:google.maps.MapsEventListener[]=[];let release:(()=>void)|undefined,keyMove:((e:KeyboardEvent)=>void)|undefined;
    void loadTrackingMapLibraries(process.env.NEXT_PUBLIC_FLASH_GOOGLE_MAPS_API_KEY??'').then(({maps})=>{
      if(disposed||!container.current)return;
      const m=new maps.Map(container.current,{center:initial.current?{lat:initial.current.latitude,lng:initial.current.longitude}:{lat:0,lng:0},zoom:initial.current?17:2,minZoom:2,maxZoom:20,gestureHandling:'greedy',streetViewControl:false,mapTypeControl:false,fullscreenControl:false,clickableIcons:false});
      map.current=m;release=containMapGestures(container.current);
      const chooseCenter=()=>{const c=m.getCenter();if(c&&!disabledRef.current){manual.current++;onChangeRef.current({latitude:c.lat(),longitude:c.lng()});}};
      listeners.push(m.addListener('dragend',chooseCenter));
      listeners.push(m.addListener('click',(e:google.maps.MapMouseEvent)=>{if(e.latLng&&!disabledRef.current){m.setCenter(e.latLng);chooseCenter();}}));
      keyMove=(e:KeyboardEvent)=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))chooseCenter();};
      container.current.addEventListener('keyup',keyMove);
      setReady(true);
    }).catch(()=>{if(!disposed)setError('No se pudo cargar el mapa. Puedes ingresar las coordenadas manualmente o volver a abrirlo.');});
    return()=>{disposed=true;alive.current=false;release?.();if(keyMove)container.current?.removeEventListener('keyup',keyMove);listeners.forEach(l=>l.remove());map.current?.unbindAll();map.current=null;};
  },[]);
  useEffect(()=>{if(ready&&point){const c=map.current?.getCenter();if(!c||Math.abs(c.lat()-point.latitude)>0.0000005||Math.abs(c.lng()-point.longitude)>0.0000005)map.current?.setCenter({lat:point.latitude,lng:point.longitude});}},[point?.latitude,point?.longitude,ready]);
  function locate(){
    if(disabled||gpsBusy.current)return;
    if(!navigator.geolocation){setError('Este navegador no permite obtener la ubicación. Selecciónala en el mapa.');return;}
    gpsBusy.current=true;setLocating(true);setError('');const version=manual.current,startedAtPoint=JSON.stringify(latestPoint.current);
    navigator.geolocation.getCurrentPosition(position=>{
      if(!alive.current)return;gpsBusy.current=false;setLocating(false);
      if(disabledRef.current||version!==manual.current||startedAtPoint!==JSON.stringify(latestPoint.current))return;
      const p={latitude:position.coords.latitude,longitude:position.coords.longitude};
      if(!Number.isFinite(p.latitude)||!Number.isFinite(p.longitude))return;
      onChangeRef.current(p);map.current?.setCenter({lat:p.latitude,lng:p.longitude});map.current?.setZoom(18);
    },()=>{if(alive.current){gpsBusy.current=false;setLocating(false);setError('No pudimos obtener tu ubicación. Puedes elegirla en el mapa o ingresar las coordenadas.');}}, {enableHighAccuracy:true,timeout:10000,maximumAge:0});
  }
  return <><div className={styles.mapShell}><div className={styles.mapArea}><div ref={container} className={styles.map} aria-label="Mapa de ubicación de la sucursal"/>{ready&&(tenantCode==='POLLO001'?<span aria-hidden="true" className={styles.pin} style={{width:64,height:64,marginTop:3}}><img src="/images/maps/mr-pollo-branch-pin-v1.png" width={64} height={64} alt="" draggable={false} style={{display:'block'}}/></span>:<span aria-hidden="true" className={styles.pin}>📍</span>)}{disabled&&<div className={styles.mapBlock}>Edición deshabilitada</div>}</div>
    <div className={styles.mapBar}><span className={styles.hint}>{ready?'Toca el mapa o muévelo hasta la puerta del local.':error?'Mapa no disponible':'Cargando mapa…'}</span><button type="button" className={styles.secondary} onClick={locate} disabled={!ready||disabled||locating}>{locating?'Ubicando…':'Usar mi ubicación'}</button></div></div>
    {error&&<p role="status" className={`${styles.notice} ${styles.error}`}>{error}</p>}<p className={styles.hint}>Usa tu ubicación solo si estás en la sucursal. Revisa el punto antes de guardar.</p></>;
}
