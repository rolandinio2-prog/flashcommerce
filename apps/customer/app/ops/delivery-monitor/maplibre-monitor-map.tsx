'use client';

import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import styles from './maplibre-monitor-map.module.css';

const PILOT_STYLE_URL = 'https://demotiles.maplibre.org/style.json';

type MapState = 'loading' | 'ready' | 'unavailable';

export default function MapLibreMonitorMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mapState, setMapState] = useState<MapState>('loading');

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    let disposed = false;
    let loaded = false;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: PILOT_STYLE_URL,
      center: [0, 0],
      zoom: 1.5,
    });

    map.addControl(
      new maplibregl.NavigationControl({
        showCompass: true,
        showZoom: true,
      }),
      'top-right',
    );

    map.once('load', () => {
      loaded = true;

      if (!disposed) {
        setMapState('ready');
      }
    });

    map.on('error', () => {
      if (!disposed && !loaded) {
        setMapState('unavailable');
      }
    });

    return () => {
      disposed = true;
      map.remove();
    };
  }, []);

  const statusLabel =
    mapState === 'ready'
      ? 'MapLibre activo'
      : mapState === 'unavailable'
        ? 'Mapa no disponible'
        : 'Cargando mapa';

  return (
    <div className={styles.mapFrame}>
      <div className={styles.mapStatus} data-map-state={mapState}>
        <span className={styles.statusDot} aria-hidden="true" />
        {statusLabel}
      </div>
      <div ref={containerRef} className={styles.mapCanvas} />
    </div>
  );
}
