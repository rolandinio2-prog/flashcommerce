'use client';

import { useResetOnChange } from '../../../lib/use-reset-on-change';
import { useEffect, useRef, useState } from 'react';
import { loadTrackingMapLibraries } from '../../../lib/google-maps';
import { containMapGestures } from '../../../lib/map-gestures';
import { getDeliveryMapContext, reverseDeliveryAddress, type DeliveryAddressLocation } from '../../../lib/flash-api';
import { pinAddress, validDeliveryPoint, type DeliveryPoint } from '../../../lib/address-map-selection';
import styles from './delivery-address-map.module.css';

export default function DeliveryAddressMap({ tenantCode, branchCode, initial, onClose, onSelect }: {
  tenantCode: string; branchCode: string; initial: DeliveryAddressLocation | null;
  onClose: () => void; onSelect: (address: DeliveryAddressLocation) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const alive = useRef(false);
  const version = useRef(0);
  const request = useRef<AbortController | null>(null);
  const requestBusy = useRef(false);
  const completed = useRef(false);
  const interacted = useRef(false);
  // Share the one-shot request across React's effect setup/cleanup replay.
  const gpsRequest = useRef<Promise<DeliveryPoint | null> | null>(null);
  const [ready, setReady] = useState(false);
  const [point, setPoint] = useState<DeliveryPoint | null>(null);
  const [chosen, setChosen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Buscando tu ubicación… Puedes mover el mapa para elegir otro punto.');
  const [hintVisible, setHintVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal(); document.body.style.overflow = 'hidden';
    return () => { dialog.close(); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);

  useResetOnChange([tenantCode, branchCode, initial], () => { setReady(false); setChosen(false); setError(null); });
  useEffect(() => {
    alive.current = true; completed.current = false; interacted.current = false;
    let disposed = false;
    const controller = new AbortController();
    const listeners: google.maps.MapsEventListener[] = [];
    let releaseGestures: (() => void) | undefined;
    if (!gpsRequest.current) gpsRequest.current = new Promise(resolve => {
      if (!navigator.geolocation) { resolve(null); return; }
      try {
        navigator.geolocation.getCurrentPosition(position => {
          const location = { latitude: position.coords.latitude, longitude: position.coords.longitude };
          resolve(validDeliveryPoint(location) ? location : null);
        }, () => resolve(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
      } catch { resolve(null); }
    });
    const syncPoint = () => {
      const center = mapRef.current?.getCenter();
      if (!center || disposed) return;
      version.current += 1; request.current?.abort(); requestBusy.current = false;
      setBusy(false); setError(null);
      setPoint({ latitude: center.lat(), longitude: center.lng() });
    };
    const markManual = () => {
      interacted.current = true; setChosen(true); syncPoint();
      setMessage('Coloca la marca en la puerta de entrega.');
    };
    const keyboardMove = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) markManual();
    };
    void (async () => {
      try {
        const [{ maps }, context] = await Promise.all([
          loadTrackingMapLibraries(process.env.NEXT_PUBLIC_FLASH_GOOGLE_MAPS_API_KEY ?? ''),
          getDeliveryMapContext(tenantCode, branchCode, controller.signal),
        ]);
        if (disposed || !containerRef.current) return;
        if (context.tenant !== tenantCode || context.branch !== branchCode) throw new Error('Scope mismatch');
        const center = validDeliveryPoint(initial?.location) ? initial.location : context.center;
        if (!validDeliveryPoint(center)) throw new Error('Missing branch center');
        const map = new maps.Map(containerRef.current, {
          center: { lat: center.latitude, lng: center.longitude }, zoom: initial ? 17 : 14,
          minZoom: 3, maxZoom: 20, gestureHandling: 'greedy',
          disableDefaultUI: true, fullscreenControl: false, mapTypeControl: false,
          streetViewControl: false, zoomControl: false, clickableIcons: false, keyboardShortcuts: true,
        });
        mapRef.current = map; releaseGestures = containMapGestures(containerRef.current);
        listeners.push(map.addListener('center_changed', syncPoint));
        listeners.push(map.addListener('dragstart', markManual));
        listeners.push(map.addListener('click', (event: google.maps.MapMouseEvent) => {
          if (event.latLng) { markManual(); map.setCenter(event.latLng); }
        }));
        containerRef.current.addEventListener('keydown', keyboardMove);
        setPoint(center); setReady(true);
        setChosen(Boolean(initial?.selectedOnMap && validDeliveryPoint(initial.location)));
        const location = await gpsRequest.current;
        if (disposed || interacted.current || completed.current) return;
        if (location) {
          map.setCenter({ lat: location.latitude, lng: location.longitude }); map.setZoom(18);
          setPoint(location); setChosen(true);
          setMessage('Esta es tu ubicación aproximada. Ajusta la marca hasta la puerta de entrega.');
        } else {
          setMessage('No pudimos acceder a tu ubicación. Mueve el mapa o toca el lugar de entrega.');
        }
      } catch {
        if (!disposed) setError('No pudimos abrir el mapa. Cierra y vuelve a intentarlo.');
      }
    })();
    return () => {
      disposed = true; alive.current = false; version.current += 1;
      controller.abort(); request.current?.abort(); releaseGestures?.();
      containerRef.current?.removeEventListener('keydown', keyboardMove);
      listeners.forEach(listener => listener.remove());
      mapRef.current?.unbindAll(); mapRef.current = null;
    };
  }, [tenantCode, branchCode, initial]);

  useResetOnChange([message, ready], () => setHintVisible(true));
  useEffect(() => {
    const timer = setTimeout(() => setHintVisible(false), 5000);
    return () => clearTimeout(timer);
  }, [message, ready]);

  async function selectAddress() {
    if (!ready || !chosen || !validDeliveryPoint(point) || requestBusy.current || completed.current) return;
    interacted.current = true; // A late GPS result must never replace an explicitly selected point.
    const center = mapRef.current?.getCenter();
    const selectedPoint = center ? { latitude: center.lat(), longitude: center.lng() } : { ...point };
    if (!validDeliveryPoint(selectedPoint)) { setError('Mueve el mapa y selecciona un punto válido.'); return; }
    const captured = ++version.current;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    requestBusy.current = true; setBusy(true); setError(null);
    let nearby: DeliveryAddressLocation | null = null;
    try {
      const response = await reverseDeliveryAddress(tenantCode, branchCode, selectedPoint, controller.signal);
      if (!alive.current || version.current !== captured || controller.signal.aborted) return;
      if (response.tenant !== tenantCode || response.branch !== branchCode) {
        setError('No pudimos confirmar esta dirección. Vuelve a seleccionarla.'); return;
      }
      nearby = response.location;
    } catch {
      // A missing street name does not invalidate the customer's exact destination.
    } finally {
      if (version.current === captured) { requestBusy.current = false; setBusy(false); }
    }
    if (!alive.current || version.current !== captured || controller.signal.aborted) return;
    const description = nearby?.formattedAddress?.trim();
    completed.current = true;
    onSelect(pinAddress(selectedPoint, description && description.length >= 5 ? description : 'Punto seleccionado en el mapa', nearby));
  }

  return <dialog ref={dialogRef} className={styles.dialog} aria-label="Seleccionar dirección de entrega"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className={styles.shell}>
      <div className={styles.mapFrame}>
        <div ref={containerRef} className={styles.map} data-customer-interactive-map="true" aria-label="Mapa para elegir la dirección" />
        {ready && <div className={styles.pin} aria-hidden="true"><span>●</span></div>}
        {!ready && !error && <p className={styles.loading} role="status">Cargando mapa…</p>}
        <header className={styles.header}>
          <button type="button" autoFocus aria-label="Volver al pedido" title="Volver al pedido" onClick={onClose}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5m7-7-7 7 7 7" /></svg>
          </button>
          {hintVisible && !error && <div className={styles.hint} role="status"><span>Volver al pedido</span><p>{message}</p></div>}
          {error && <p role="alert" className={styles.error}>{error}</p>}
        </header>
      </div>
      <footer className={styles.footer}>
        <button type="button" className={styles.primary} disabled={!ready || !chosen || !point || busy}
          onClick={() => void selectAddress()}>{busy ? 'Seleccionando…' : 'Seleccionar dirección'}</button>
      </footer>
    </div>
  </dialog>;
}
