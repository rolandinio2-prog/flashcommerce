"use client";

import {useEffect, useRef, useState} from "react";
import {loadDriverMapLibraries} from "../../lib/google-maps";
import type {DriverJourney, DriverNavigation, DriverMapRoute, JourneyPoint} from "@/lib/flash-api";

import {containMapGestures} from "../../lib/map-gestures";

type Props = {
  tenantCode: string;
  deliveryId: string;
  currentLocation: JourneyPoint | null;
  branchOrigin?: (JourneyPoint & {name:string}) | null;
  destination: JourneyPoint;
  journey: DriverJourney | null;
  navigation: DriverNavigation | null;
  baseRoute?: DriverMapRoute["baseRoute"] | null;
};
const latLng = (point: JourneyPoint) => ({lat:point.latitude,lng:point.longitude});

export default function DriverTrackingMap({tenantCode,deliveryId,currentLocation,destination,branchOrigin,journey,navigation,baseRoute}: Props) {
  const containerRef=useRef<HTMLDivElement|null>(null);
  const currentMarkerRef=useRef<google.maps.Marker|null>(null);
  const destinationMarkerRef=useRef<google.maps.Marker|null>(null);
  const branchMarkerRef=useRef<google.maps.Marker|null>(null);
  const fittedRef=useRef(false);
  useEffect(()=>{fittedRef.current=false;},[branchOrigin?.latitude,branchOrigin?.longitude,baseRoute?.identity,baseRoute?.route?.encodedPolyline]);
  const [map,setMap]=useState<google.maps.Map|null>(null);
  const [loadError,setLoadError]=useState<string|null>(null);

  useEffect(()=>{
    let cancelled=false;
    let instance: google.maps.Map|null=null;
    setMap(null); fittedRef.current=false;
    const releaseGestures=containerRef.current ? containMapGestures(containerRef.current) : () => {};
    void loadDriverMapLibraries(process.env.NEXT_PUBLIC_FLASH_GOOGLE_MAPS_API_KEY ?? "").then(({maps})=>{
      if(cancelled || !containerRef.current) return;
      instance=new maps.Map(containerRef.current,{zoom:15,center:latLng(currentLocation ?? branchOrigin ?? destination),gestureHandling:"greedy",zoomControl:true,minZoom:3,maxZoom:20,fullscreenControl:false,mapTypeControl:false,streetViewControl:false,clickableIcons:false});
      currentMarkerRef.current=new google.maps.Marker({map:instance,label:"YO",title:"Tu ubicacion"});
      destinationMarkerRef.current=new google.maps.Marker({map:instance,label:"D",title:"Punto de entrega"});
      branchMarkerRef.current=new google.maps.Marker({map:instance,label:tenantCode === 'POLLO001' ? undefined : "S",title:"Sucursal",icon:tenantCode === 'POLLO001' ? {url: "/images/maps/mr-pollo-branch-pin-v1.png", scaledSize: new google.maps.Size(64,64), anchor: new google.maps.Point(32,61)} : {path:google.maps.SymbolPath.CIRCLE,scale:14,fillColor:"#60a5fa",fillOpacity:1,strokeColor:"#1e40af",strokeWeight:2},zIndex:3});
      setLoadError(null); setMap(instance);
    }).catch(()=>{if(!cancelled) setLoadError("No se pudo cargar el mapa del reparto.");});
    return ()=>{
      cancelled=true; releaseGestures();
      currentMarkerRef.current?.setMap(null); destinationMarkerRef.current?.setMap(null);
      branchMarkerRef.current?.setMap(null); branchMarkerRef.current=null;
      currentMarkerRef.current=null; destinationMarkerRef.current=null;
      if(instance) google.maps.event.clearInstanceListeners(instance);
    };
  },[deliveryId,tenantCode]);

  useEffect(()=>{
    if(!map) return;
    currentMarkerRef.current?.setVisible(Boolean(currentLocation));
    if(currentLocation) currentMarkerRef.current?.setPosition(latLng(currentLocation));
    branchMarkerRef.current?.setVisible(Boolean(branchOrigin));
    if(branchOrigin) { branchMarkerRef.current?.setPosition(latLng(branchOrigin)); branchMarkerRef.current?.setTitle("Sucursal: "+branchOrigin.name); }
    destinationMarkerRef.current?.setPosition(latLng(destination));
    if(!fittedRef.current) {
      const bounds=new google.maps.LatLngBounds(); if(currentLocation) bounds.extend(latLng(currentLocation)); if(branchOrigin) bounds.extend(latLng(branchOrigin)); bounds.extend(latLng(destination)); for(const p of baseRoute?.path??[])bounds.extend(latLng(p));
      map.fitBounds(bounds,{top:76,bottom:44,left:44,right:44}); fittedRef.current=true;
    }
  },[map,currentLocation?.latitude,currentLocation?.longitude,destination.latitude,destination.longitude,branchOrigin?.latitude,branchOrigin?.longitude,branchOrigin?.name,baseRoute?.identity,baseRoute?.route?.encodedPolyline]);

  useEffect(()=>{
    if(!map) return;
    const objects: Array<{setMap(map:google.maps.Map|null):void}>=[];
    if(!((navigation?.revision??0)>0)&&(baseRoute?.path.length??0)>=2){
      objects.push(new google.maps.Polyline({map,path:baseRoute!.path.map(latLng),strokeColor:'#2563eb',strokeWeight:6,strokeOpacity:0.85,zIndex:0}));
    }
    for(const segment of journey?.segments ?? []) {
      if(segment.length<2) continue;
      objects.push(new google.maps.Polyline({map,path:segment.map(latLng),strokeColor:"#2563eb",strokeWeight:5,strokeOpacity:0.85,zIndex:2}));
    }
    if((navigation?.remainingPath.length ?? 0)>=2) {
      objects.push(new google.maps.Polyline({map,path:navigation!.remainingPath.map(latLng),strokeColor:"#16a34a",strokeWeight:6,strokeOpacity:navigation?.status==="READY" ? 0.95 : 0.45,zIndex:1}));
    }
    console.info("JOURNEY_VALIDATED_APPLIED",{complete:journey?.complete ?? false});
    console.info("REMAINING_ROUTE_APPLIED",{revision:navigation?.revision ?? 0,status:navigation?.status ?? "UNAVAILABLE"});
    return ()=>{for(const object of objects) object.setMap(null);};
  },[map,journey,navigation,baseRoute]);

  return <>
    <div data-driver-interactive-map="true" ref={containerRef} style={{height:"min(360px, 65svh)",minHeight:240,width:"100%",maxWidth:"100%",minWidth:0,borderRadius:20,overflow:"hidden",touchAction:"none",overscrollBehavior:"contain"}} aria-label="Mapa de recorrido y ruta restante" />
    <p>{branchOrigin ? (tenantCode === 'POLLO001' ? "Mr. Pollo · " : "S: ")+branchOrigin.name+" · " : ""}D: Punto de entrega{currentLocation ? " · YO: Tu ubicación" : " · Esperando GPS del repartidor"}</p>
    <p><span style={{color:"#2563eb"}}>{!((navigation?.revision??0)>0)&&baseRoute?.route?'Azul: ruta inicial sucursal → cliente':'Azul: recorrido GPS validado'}</span> · <span style={{color:"#15803d"}}>Verde: ruta restante</span></p>
    <p>Recorrido validado: {journey?.distanceMeters != null ? `${Math.floor(journey.distanceMeters)} m` : "pendiente"}</p>
    {journey && !journey.complete ? <p role="status">Historial demasiado extenso para validarlo completo. Distancia no disponible.</p> : null}
    {journey && journey.gaps>0 ? <p>Hay intervalos sin GPS validado. Esos tramos no se suman a la distancia.</p> : null}
    {navigation && navigation.status!=="READY" ? <p role="status">{navigation.status==="OFF_ROUTE" ? "Desvio detectado. Recalculando cuando se confirme el recorrido." : navigation.status==="STALE_ROUTE" ? "No se pudo recalcular. Se conserva la ultima ruta disponible." : navigation.status==="STALE_LOCATION" ? "Esperando una posicion GPS reciente y precisa." : "Ruta no disponible. El recorrido GPS se conserva."}</p> : null}
    {baseRoute?.status==='MISSING_ORIGIN'&&<p role="status">La sucursal no tiene ubicación configurada para calcular la ruta.</p>}
    {baseRoute?.status==='UNAVAILABLE'&&<p role="status">No se pudo cargar la ruta por calles. Se volverá a consultar.</p>}
    {loadError ? <p role="alert">{loadError}</p> : null}
  </>;
}
