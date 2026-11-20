'use client';
import {takeB11Capture} from './b11-capture-binding';
import {monitorItemIdentity} from './delivery-monitor-contract';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { getStaffSession, type StaffSessionUser } from '../../../lib/flash-api';
import {watchStaffSession} from '../../../lib/staff-session-lifecycle';

import {
  getDeliveryMonitorRoute,
  MonitorAccessError,
  getDeliveryMonitorSnapshot,
} from './delivery-monitor-api';
import type {
  DeliveryMonitorMovementEvent,
  DeliveryMonitorSnapshot,
  DeliveryMonitorTrailPoint,
} from './delivery-monitor.types';
import {
  isNewerMovementEvent,
} from './delivery-monitor-realtime';
import {
  createDeliveryMonitorSupabaseRealtimeTransport,
} from './delivery-monitor-realtime-supabase';
import {createMonitorSnapshotSync} from './delivery-monitor-snapshot-sync';
import MapLibreMonitorMap from './maplibre-monitor-map';
import styles from './maplibre-monitor-map.module.css';

const DELIVERY_ROUTE_REFRESH_MIN_INTERVAL_MS =
  15_000;

const DELIVERY_ROUTE_REFRESH_GLOBAL_CONCURRENCY_MAX =
  2;

const DELIVERY_TRAIL_MAX_POINTS =
  500;

function formatTimestamp(
  value: string,
): string {
  const date =
    new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

interface ActiveMonitorAccess {
  tenantCode: string;
  branchCode: string;
}

type RealtimeStatus =
  | 'OFF'
  | 'CONNECTING'
  | 'LIVE'
  | 'ERROR';

function timestampMs(
  value: string,
): number {
  return new Date(
    value,
  ).getTime();
}

function trailPointKey(
  point: DeliveryMonitorTrailPoint,
): string {
  return [
    timestampMs(point.capturedAt),
    point.latitude.toFixed(7),
    point.longitude.toFixed(7),
  ].join('|');
}

function mergeTrailPoints(
  ...collections: DeliveryMonitorTrailPoint[][]
): DeliveryMonitorTrailPoint[] {
  const byKey =
    new Map<
      string,
      DeliveryMonitorTrailPoint
    >();

  for (const collection of collections) {
    for (const point of collection) {
      byKey.set(
        trailPointKey(point),
        point,
      );
    }
  }

  return Array.from(
    byKey.values(),
  )
    .sort(
      (left, right) =>
        timestampMs(
          left.capturedAt,
        ) -
        timestampMs(
          right.capturedAt,
        ),
    )
    .slice(
      -DELIVERY_TRAIL_MAX_POINTS,
    );
}

function appendTrailPoint(
  trail: DeliveryMonitorTrailPoint[],
  point: DeliveryMonitorTrailPoint,
): DeliveryMonitorTrailPoint[] {
  return mergeTrailPoints(
    trail,
    [point],
  );
}

function mergeSnapshotPreservingNewerLocations(
  current: DeliveryMonitorSnapshot | null,
  incoming: DeliveryMonitorSnapshot,
): DeliveryMonitorSnapshot {
  if (!current) {
    return incoming;
  }

  const currentByDelivery =
    new Map(
      current.items.map(
        (item) => [
          item.deliveryId,
          item,
        ],
      ),
    );

  return {
    ...incoming,

    items:
      incoming.items.map(
        (item) => {
          const existing =
            currentByDelivery.get(
              item.deliveryId,
            );

          if (!existing || existing.driverId !== item.driverId || (existing.assignmentKey ?? null) !== (item.assignmentKey ?? null)) {
            return item;
          }

          const sameDestination = existing.destinationLocation.latitude === item.destinationLocation.latitude &&
            existing.destinationLocation.longitude === item.destinationLocation.longitude;
          item = {...item, route: item.route ?? (sameDestination ? existing.route : null)};
          const trail =
            mergeTrailPoints(
              item.trail,
              existing.trail,
            );

          if (
            !existing
              .latestLocation
          ) {
            return {
              ...item,
              trail,
            };
          }

          if (
            !item.latestLocation ||
            timestampMs(
              existing
                .latestLocation
                .capturedAt,
            ) >
              timestampMs(
                item
                  .latestLocation
                  .capturedAt,
              )
          ) {
            return {
              ...item,

              latestLocation:
                existing
                  .latestLocation,

              trail,
            };
          }

          return {
            ...item,
            trail,
          };
        },
      ),
  };
}
export default function DeliveryMonitorClient() {
  const [user, setUser] = useState<StaffSessionUser | null>(null);
  const [message, setMessage] = useState('Verificando acceso al seguimiento...');
  const deny = useCallback(() => { setUser(null); setMessage('Tu sesión no permite continuar. Ingresa a Operaciones.'); }, []);
  useEffect(() => watchStaffSession(getStaffSession, session => {
    if (session.user.passwordChangeRequired || !['ADMIN', 'MANAGER', 'CASHIER'].includes(session.user.role)) return false;
    setUser(session.user);
    return true;
  }, deny, {onTransient: () => {
    setUser(null);
    setMessage('Conexion interrumpida. Verificando acceso para reconectar...');
  }}), [deny]);
  if (!user) return <main className={styles.shell}><p role="status">{message}</p><a href="/ops">Ingresar a Operaciones</a></main>;
  return <AuthenticatedDeliveryMonitor key={user.sessionId + ':' + user.branchId} user={user} onDenied={deny} />;
}

function AuthenticatedDeliveryMonitor({ user, onDenied }: { user: StaffSessionUser; onDenied: () => void }) {
  const tenantCode = user.tenantCode;
  const branchCode = user.branchCode;
  const [
    snapshot,
    setSnapshot,
  ] =
    useState<DeliveryMonitorSnapshot | null>(
      null,
    );

  const [
    loading,
    setLoading,
  ] =
    useState(false);

  const [
    error,
    setError,
  ] =
    useState<string | null>(
      null,
    );

  const [
    activeAccess,
    setActiveAccess,
  ] =
    useState<ActiveMonitorAccess | null>(
      null,
    );

  const [
    realtimeStatus,
    setRealtimeStatus,
  ] =
    useState<RealtimeStatus>(
      'OFF',
    );

  const lastMovementByDelivery =
    useRef<
      Map<
        string,
        DeliveryMonitorMovementEvent
      >
    >(
      new Map(),
    );

  const snapshotSyncRef = useRef<ReturnType<typeof createMonitorSnapshotSync<DeliveryMonitorSnapshot>> | null>(null);
  const discoverRouteRef = useRef<((deliveryId: string) => void) | null>(null);
  const routeOwnerRef = useRef(new Map<string, string>());
  const routeAvailableRef = useRef(new Set<string>());
  const pruneRoutesRef = useRef<(() => void) | null>(null);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const loadSnapshot = useCallback(async () => { await snapshotSyncRef.current?.request(); }, []);

  useEffect(() => {
    setActiveAccess({tenantCode: tenantCode.trim(), branchCode: branchCode.trim()});
    const sync = createMonitorSnapshotSync<DeliveryMonitorSnapshot>({
      fetchSnapshot: (signal) => getDeliveryMonitorSnapshot({tenantCode, branchCode}, {stateOnly: true, signal}),
      onSnapshot: (incoming) => {
        setError(null);
        routeOwnerRef.current = new Map(incoming.items.map((item) => [item.deliveryId,
          monitorItemIdentity(item)]));
        routeAvailableRef.current = new Set(incoming.items.filter(item => item.driverId && item.latestLocation).map(item => item.deliveryId));
        for (const id of lastMovementByDelivery.current.keys()) if (!routeOwnerRef.current.has(id)) lastMovementByDelivery.current.delete(id);
        pruneRoutesRef.current?.();
        setSnapshot((current) => {
          for (const item of incoming.items) {
            if (!current?.items.some((previous) => previous.deliveryId === item.deliveryId && monitorItemIdentity(previous) === monitorItemIdentity(item))) {
              lastMovementByDelivery.current.delete(item.deliveryId);
            }
          }
          return mergeSnapshotPreservingNewerLocations(current, incoming);
        });
      },
      onError: (loadError) => {
        if (loadError instanceof MonitorAccessError) { sync.dispose(); onDenied(); return; }
        setError(loadError instanceof Error ? loadError.message : 'No se pudo actualizar el monitor');
      },
      onLoading: setLoading,
      isVisible: () => document.visibilityState !== 'hidden',
    });
    snapshotSyncRef.current = sync;
    const wake = () => { void sync.request(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    void sync.request();
    return () => {
      sync.dispose();
      snapshotSyncRef.current = null;
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [tenantCode, branchCode, onDenied]);

  useEffect(() => {
    for (const item of snapshot?.items ?? []) {
      if (!item.route && item.driverId && item.latestLocation) discoverRouteRef.current?.(item.deliveryId);
    }
  }, [snapshot]);

  useEffect(
    () => {
      if (!activeAccess) {
        setRealtimeStatus(
          'OFF',
        );

        return;
      }

      let disposed =
        false;

      const routeAccess =
        activeAccess;

      const routeControllers = new Map<string, AbortController>();
      const queuedOwners = new Map<string, string | undefined>();
      const eligible = (id: string) => routeAvailableRef.current.has(id) && queuedOwners.get(id) === routeOwnerRef.current.get(id);
      function pruneRoutes() {
        for (const [id, controller] of routeControllers) if (!eligible(id)) controller.abort();
        for (const [id, timer] of routeRefreshTimers) if (!eligible(id)) { window.clearTimeout(timer); routeRefreshTimers.delete(id); routeRefreshPending.delete(id); }
        for (let index = routeRefreshQueue.length - 1; index >= 0; index--) if (!eligible(routeRefreshQueue[index])) { routeRefreshQueued.delete(routeRefreshQueue[index]); routeRefreshPending.delete(routeRefreshQueue[index]); routeRefreshQueue.splice(index, 1); }
      }
      const pruneState = pruneRoutes;
      pruneRoutesRef.current = () => {
        pruneState();
        for (const id of queuedOwners.keys()) if (!routeOwnerRef.current.has(id)) { queuedOwners.delete(id); routeRefreshLastStartedAt.delete(id); routeRefreshPending.delete(id); }
      };

      const routeRefreshLastStartedAt =
        new Map<string, number>();

      const routeRefreshInFlight =
        new Set<string>();

      const routeRefreshPending =
        new Set<string>();

      const routeRefreshQueued =
        new Set<string>();

      const routeRefreshTimers =
        new Map<
          string,
          number
        >();

      const routeRefreshQueue: string[] =
        [];

      let routeRefreshGlobalInFlight =
        0;

      function patchDeliveryRoute(
        deliveryId: string,
        route: DeliveryMonitorSnapshot['items'][number]['route'],
        owner: string | undefined,
      ): void {
        if (!route || disposed) {
          return;
        }

        setSnapshot(
          (current) => {
            if (!current) {
              return current;
            }

            return {
              ...current,
              items:
                current.items.map(
                  (item) =>
                    item.deliveryId ===
                    deliveryId && monitorItemIdentity(item) === owner
                      ? {
                          ...item,
                          route,
                        }
                      : item,
                ),
            };
          },
        );
      }

      async function runRouteRefresh(
        deliveryId: string,
      ): Promise<void> {
        if (disposed || !eligible(deliveryId)) {
          return;
        }

        const routeController = new AbortController();
        routeControllers.set(deliveryId, routeController);
        const routeOwner = routeOwnerRef.current.get(deliveryId);
        routeRefreshInFlight.add(
          deliveryId,
        );
        routeRefreshGlobalInFlight += 1;
        routeRefreshLastStartedAt.set(
          deliveryId,
          Date.now(),
        );
        routeRefreshPending.delete(
          deliveryId,
        );

        try {
          const route =
            await getDeliveryMonitorRoute({
              tenantCode:
                routeAccess.tenantCode,
              branchCode:
                routeAccess.branchCode,
              deliveryId, signal: routeController.signal,
            });

          if (disposed || routeController.signal.aborted || routeOwnerRef.current.get(deliveryId) !== routeOwner) return;
          patchDeliveryRoute(
            deliveryId,
            route, routeOwner,
          );
        } catch (routeError) {
          if (routeError instanceof MonitorAccessError) { onDenied(); return; }
          // Fail-open: keep the Realtime location and existing route/null.
        } finally {
          routeControllers.delete(deliveryId);
          routeRefreshInFlight.delete(
            deliveryId,
          );
          routeRefreshGlobalInFlight =
            Math.max(
              0,
              routeRefreshGlobalInFlight -
                1,
            );

          if (
            !disposed &&
            routeRefreshPending.has(
              deliveryId,
            )
          ) {
            scheduleRouteRefresh(
              deliveryId,
            );
          }

          pumpRouteRefreshQueue();
        }
      }

      function pumpRouteRefreshQueue(): void {
        while (
          !disposed &&
          routeRefreshGlobalInFlight <
            DELIVERY_ROUTE_REFRESH_GLOBAL_CONCURRENCY_MAX &&
          routeRefreshQueue.length > 0
        ) {
          const deliveryId =
            routeRefreshQueue.shift();

          if (!deliveryId) {
            continue;
          }

          routeRefreshQueued.delete(
            deliveryId,
          );

          if (
            routeRefreshInFlight.has(
              deliveryId,
            )
          ) {
            routeRefreshPending.add(
              deliveryId,
            );
            continue;
          }

          void runRouteRefresh(
            deliveryId,
          );
        }
      }

      function enqueueRouteRefresh(
        deliveryId: string,
      ): void {
        if (
          disposed ||
          routeRefreshQueued.has(
            deliveryId,
          ) ||
          routeRefreshInFlight.has(
            deliveryId,
          )
        ) {
          return;
        }

        routeRefreshQueued.add(
          deliveryId,
        );
        routeRefreshQueue.push(
          deliveryId,
        );
        pumpRouteRefreshQueue();
      }

      function scheduleRouteRefresh(
        deliveryId: string,
      ): void {
        if (disposed || !routeAvailableRef.current.has(deliveryId)) {
          return;
        }

        queuedOwners.set(deliveryId, routeOwnerRef.current.get(deliveryId));
        routeRefreshPending.add(
          deliveryId,
        );

        if (
          routeRefreshInFlight.has(
            deliveryId,
          ) ||
          routeRefreshQueued.has(
            deliveryId,
          ) ||
          routeRefreshTimers.has(
            deliveryId,
          )
        ) {
          return;
        }

        const lastStartedAt =
          routeRefreshLastStartedAt.get(
            deliveryId,
          ) ?? 0;

        const delayMs = Math.max(
          0,
          DELIVERY_ROUTE_REFRESH_MIN_INTERVAL_MS -
            (Date.now() - lastStartedAt),
        );

        if (delayMs > 0) {
          const timerId =
            window.setTimeout(
              () => {
                routeRefreshTimers.delete(
                  deliveryId,
                );

                if (!disposed) {
                  enqueueRouteRefresh(
                    deliveryId,
                  );
                }
              },
              delayMs,
            );

          routeRefreshTimers.set(
            deliveryId,
            timerId,
          );
          return;
        }

        enqueueRouteRefresh(
          deliveryId,
        );
      }

      discoverRouteRef.current = scheduleRouteRefresh;
      setRealtimeStatus(
        'CONNECTING',
      );

      lastMovementByDelivery
        .current
        .clear();

      let subscription: {close(): void} = {close() {}};
      try {
      const b11Capture = takeB11Capture();
      const transport =
        createDeliveryMonitorSupabaseRealtimeTransport(
          b11Capture?.observe, b11Capture?.Transport,
        );

      subscription =
        transport.subscribe(
          {
            tenantCode:
              activeAccess
                .tenantCode,

            branchCode:
              activeAccess
                .branchCode,
          },
          {
            onMovement(
              movement,
            ) {
              if (disposed) {
                return;
              }

              setSnapshot(
                (
                  current,
                ) => {
                  if (!current) {
                    return current;
                  }

                  let accepted =
                    false;

                  const previousMovement =
                    lastMovementByDelivery
                      .current
                      .get(
                        movement
                          .deliveryId,
                      ) ??
                    null;

                  if (
                    !isNewerMovementEvent(
                      movement,
                      previousMovement,
                    )
                  ) {
                    console.info(
                      '[DM_TRACE] NEWER_EVENT_REJECTED',
                    );

                    return current;
                  }

                  console.info(
                    '[DM_TRACE] NEWER_EVENT_ACCEPTED',
                  );

                  const items =
                    current.items.map(
                      (
                        item,
                      ) => {
                        if (
                          item.deliveryId !==
                            movement.deliveryId ||
                          item.driverId !==
                            movement.driverId ||
                          (item.assignedAt && Date.parse(movement.capturedAt) < Date.parse(item.assignedAt))
                        ) {
                          console.info(
                            '[DM_TRACE] TARGET_REJECTED',
                          );

                          return item;
                        }

                        console.info(
                          '[DM_TRACE] TARGET_MATCH',
                        );

                        if (
                          item.latestLocation
                        ) {
                          const incomingMs =
                            timestampMs(
                              movement
                                .capturedAt,
                            );

                          const currentMs =
                            timestampMs(
                              item
                                .latestLocation
                                .capturedAt,
                            );

                          if (
                            !Number.isFinite(
                              incomingMs,
                            ) ||
                            !Number.isFinite(
                              currentMs,
                            ) ||
                            incomingMs <=
                              currentMs
                          ) {
                            console.info(
                              '[DM_TRACE] TIMESTAMP_REJECTED',
                            );

                            return item;
                          }
                        }

                        console.info(
                          '[DM_TRACE] TIMESTAMP_ACCEPTED',
                        );

                        accepted =
                          true;

                        const nextPoint = {
                          latitude:
                            movement
                              .latitude,

                          longitude:
                            movement
                              .longitude,

                          accuracyM:
                            movement
                              .accuracyM,

                          capturedAt:
                            movement
                              .capturedAt,
                        };

                        console.info(
                          '[DM_TRACE] TRAIL_POINT_APPENDED',
                        );

                        return {
                          ...item,

                          latestLocation:
                            nextPoint,

                          trail:
                            appendTrailPoint(
                              item.trail,
                              nextPoint,
                            ),
                        };
                      },
                    );

                  if (!accepted) {
                    return current;
                  }

                  lastMovementByDelivery
                    .current
                    .set(
                      movement
                        .deliveryId,
                      movement,
                    );

                  console.info('[FC_G4114] OPS_MOVEMENT_ROUTE_REFRESH_SKIPPED_FROZEN_GEOMETRY');

                  console.info(
                    '[DM_TRACE] STATE_APPLIED',
                  );

                  return {
                    ...current,
                    items,
                  };
                },
              );
            },

            onReconnect() {
              if (disposed) {
                return;
              }

              setRealtimeError(null);
              setRealtimeStatus(
                'LIVE',
              );

              void loadSnapshot();
            },

            onError(
              realtimeError,
            ) {
              if (disposed) {
                return;
              }

              if (realtimeError instanceof MonitorAccessError) { onDenied(); return; }
              setRealtimeStatus(
                'ERROR',
              );

              setRealtimeError(
                realtimeError instanceof
                  Error
                  ? realtimeError
                      .message
                  : 'Error de Realtime en Delivery Monitor',
              );
            },
          },
        );
      } catch { setRealtimeStatus("ERROR"); setRealtimeError("No se pudo iniciar el canal de ubicación. Las consultas de estado continúan."); }

      return () => {
        discoverRouteRef.current = null;
        pruneRoutesRef.current = null;
        for (const controller of routeControllers.values()) controller.abort();
        routeControllers.clear();
        disposed =
          true;

        routeRefreshTimers.forEach(
          (timerId) => {
            window.clearTimeout(
              timerId,
            );
          },
        );
        routeRefreshTimers.clear();
        routeRefreshQueue.length = 0;
        routeRefreshQueued.clear();
        routeRefreshPending.clear();
        routeRefreshInFlight.clear();

        subscription.close();

        lastMovementByDelivery
          .current
          .clear();
      };
    },
    [
      activeAccess, onDenied,
    ],
  );

  const items =
    snapshot?.items ?? [];

  return (
    <main className={styles.shell}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>
            FastPay · Seguimiento
          </p>

          <h1 className={styles.title}>
            Delivery Monitor
          </h1>

          <p className={styles.subtitle}>
            Entregas activas de tu sucursal, ubicación del repartidor y ruta al cliente.
          </p>
        </div>

        <div className={styles.badge}>
          {realtimeStatus === 'LIVE' ? 'CONECTADO' : realtimeStatus === 'CONNECTING' ? 'CONECTANDO' : 'SIN CONEXIÓN'}
        </div>
      </section>

      <section className={styles.accessCard}>
        <p>{user.displayName} · {tenantCode} · {branchCode}</p>
        <a href="/ops">Volver a Operaciones</a>
      </section>

      {realtimeError && <p role="status">Ubicación en tiempo real interrumpida. {realtimeError}</p>}
      {snapshot && clock - Date.parse(snapshot.generatedAt) > 20000 && <p role="status">La información puede estar desactualizada. Última consulta: {formatTimestamp(snapshot.generatedAt)}.</p>}
      {error && (
        <div
          className={styles.errorBox}
          role="alert"
        >
          {error}
        </div>
      )}

      <section className={styles.summaryRow}>
        <div className={styles.summaryCard}>
          <span>Entregas activas</span>
          <strong>
            {snapshot
              ? items.length
              : '—'}
          </strong>
        </div>

        <div className={styles.summaryCard}>
          <span>Último snapshot</span>
          <strong>
            {snapshot
              ? formatTimestamp(
                  snapshot.generatedAt,
                )
              : 'Sin cargar'}
          </strong>
        </div>

        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() =>
            void loadSnapshot()
          }
          disabled={
            loading
          }
        >
          Refrescar
        </button>
      </section>

      <section
        className={styles.mapCard}
        aria-label="Mapa operativo de Delivery Monitor"
      >
        <div className={styles.mapHeader}>
          <div>
            <h2 className={styles.mapTitle}>
              Mapa operativo
            </h2>
            <p className={styles.mapCaption}>
              Marcador de conductor, destino y recorrido GPS
              histórico para cada entrega activa.
            </p>
          </div>

          <span className={styles.scopePill}>
            MapLibre · snapshot
          </span>
        </div>

        <MapLibreMonitorMap
          items={items}
        />
      </section>

      <section className={styles.deliveryList}>
        {snapshot &&
          items.length === 0 && (
            <div className={styles.emptyState}>
              No hay entregas activas para este tenant y sucursal.
            </div>
          )}

        {items.map((item) => (
          <article
            className={styles.deliveryCard}
            key={item.deliveryId}
          >

            {item.latestLocation && clock - Date.parse(item.latestLocation.capturedAt) > 30000 && <p role="status">GPS sin actualización reciente.</p>}
            {/* R6.13.2.4 ROUTE_ETA_PRESENTATION */}
            <div
              data-r6-route-eta={item.deliveryId}
              className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Ruta / ETA
              </p>
              {item.route ? (
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div>
                    <p className="text-xs text-zinc-500">ETA calculada</p>
                    <p data-r6-eta="true" className="text-sm font-semibold text-zinc-900">
                      {item.route.etaAt
                        ? new Date(item.route.etaAt).toLocaleTimeString(
                            'es-BO',
                            {
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false,
                              timeZone: 'America/La_Paz',
                            },
                          )
                        : 'No disponible'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-zinc-500">Duracion</p>
                    <p data-r6-duration="true" className="text-sm font-semibold text-zinc-900">
                      {item.route.durationS !== null
                        ? `${Math.max(
                            0,
                            Math.ceil(item.route.durationS / 60),
                          )} min`
                        : 'No disponible'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-zinc-500">Distancia</p>
                    <p data-r6-distance="true" className="text-sm font-semibold text-zinc-900">
                      {item.route.distanceM !== null
                        ? item.route.distanceM >= 1000
                          ? `${(item.route.distanceM / 1000).toFixed(1)} km`
                          : `${Math.round(item.route.distanceM)} m`
                        : 'No disponible'}
                    </p>
                  </div>
                </div>
              ) : (
                <p
                  data-r6-route-unavailable="true"
                  className="mt-2 text-sm text-zinc-500"
                >
                  Ruta / ETA no disponible
                </p>
              )}
            </div>
            <div>
              <span className={styles.cardLabel}>
                Pedido
              </span>
              <strong>
                #{item.orderNumber}
              </strong>
            </div>

            <div>
              <span className={styles.cardLabel}>
                Estado
              </span>
              <strong>
                {item.deliveryStatus}
              </strong>
            </div>

            <div>
              <span className={styles.cardLabel}>
                Conductor
              </span>
              <strong>
                {item.driverCode ?? 'Sin asignar'}
              </strong>
            </div>

            <div>
              <span className={styles.cardLabel}>
                Última posición
              </span>
              <strong>
                {item.latestLocation
                  ? formatTimestamp(
                      item.latestLocation.capturedAt,
                    )
                  : 'Sin GPS'}
              </strong>
            </div>

            <div>
              <span className={styles.cardLabel}>
                Recorrido GPS
              </span>
              <strong
                data-dm-trail-point-count={item.trail.length}
              >
                {item.trail.length} puntos
              </strong>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
