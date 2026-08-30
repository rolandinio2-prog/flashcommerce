'use client';

import MapLibreMonitorMap from './maplibre-monitor-map';
import styles from './maplibre-monitor-map.module.css';

export default function DeliveryMonitorClient() {
  return (
    <main className={styles.shell}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>FastDelivery · GEO-4</p>
          <h1 className={styles.title}>Delivery Monitor</h1>
          <p className={styles.subtitle}>
            Piloto de mapa abierto con MapLibre GL JS. Esta etapa valida únicamente
            el renderer y el mapa base; todavía no consume entregas, posiciones de
            conductores, rutas, Realtime ni motores de riesgo.
          </p>
        </div>
        <div className={styles.badge}>OPEN_STANDARD · PILOT</div>
      </section>

      <section className={styles.mapCard} aria-label="Mapa piloto de Delivery Monitor">
        <div className={styles.mapHeader}>
          <div>
            <h2 className={styles.mapTitle}>Mapa operativo · Basemap pilot</h2>
            <p className={styles.mapCaption}>
              MapLibre GL JS + tiles abiertos de demostración. El proveedor de tiles
              de producción se definirá en una etapa posterior.
            </p>
          </div>
          <span className={styles.scopePill}>Sin datos operativos</span>
        </div>

        <MapLibreMonitorMap />
      </section>

      <section className={styles.boundaryCard}>
        <h2 className={styles.boundaryTitle}>Alcance congelado de GEO-4</h2>
        <div className={styles.boundaryGrid}>
          <div>
            <strong>Incluido</strong>
            <p>Renderer MapLibre, navegación del mapa y basemap abierto de prueba.</p>
          </div>
          <div>
            <strong>Diferido</strong>
            <p>Entregas activas, drivers, Realtime, SLA/riesgo, FCM y Valhalla.</p>
          </div>
          <div>
            <strong>Protegido</strong>
            <p>Customer Tracking y Driver Tracking continúan usando Google Maps.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
