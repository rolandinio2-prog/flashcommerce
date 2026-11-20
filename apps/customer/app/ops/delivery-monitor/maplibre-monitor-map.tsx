'use client';

import {
  useEffect,
  useRef,
  useState,
} from 'react';

import {containMapGestures} from "../../../lib/map-gestures";
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type {
  DeliveryMonitorItem,
} from './delivery-monitor.types';
import styles from './maplibre-monitor-map.module.css';

// FC_G4_1_1_2_2_PROGRESSIVE_ROUTE_CONSUMPTION
type FcG41122Point = { lat: number; lng: number };

type FcG41122ProgressEntry = {
  progressMeters: number;
  updatedAtMs: number;
};

const fcG41122ProgressByRoute = new Map<string, FcG41122ProgressEntry>();

function fcG41122Radians(value: number): number {
  return (value * Math.PI) / 180;
}

function fcG41122DistanceMeters(
  a: FcG41122Point,
  b: FcG41122Point,
): number {
  const radius = 6371000;
  const dLat = fcG41122Radians(b.lat - a.lat);
  const dLng = fcG41122Radians(b.lng - a.lng);
  const lat1 = fcG41122Radians(a.lat);
  const lat2 = fcG41122Radians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);

  const h =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return (
    radius *
    2 *
    Math.atan2(
      Math.sqrt(h),
      Math.sqrt(Math.max(0, 1 - h)),
    )
  );
}

let cacheInstanceSerial = 0;
function geometryKey(path: readonly FcG41122Point[]): string {
  let hash = 2166136261;
  for (const point of path) for (const char of `${point.lat},${point.lng};`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${path.length}:${hash >>> 0}`;
}
function releaseMapCache(prefix: string, activeOwners?: Set<string>) {
  for (const cache of [fcG41122ProgressByRoute, fcG4114GuardStateByRoute, fcG4114FrozenPathByRoute]) {
    for (const key of cache.keys()) if (key.startsWith(prefix) && (!activeOwners || ![...activeOwners].some(owner => key.startsWith(owner + '|')))) cache.delete(key);
  }
}

function fcG41122RouteKey(
  ownerKey: string,
  path: readonly FcG41122Point[],
): string {
  const destination =
    path.length > 0 ? path[path.length - 1] : null;
  return destination
    ? [
        ownerKey, geometryKey(path),
        destination.lat.toFixed(6),
        destination.lng.toFixed(6),
      ].join("|")
    : ownerKey;
}

function fcG41122TotalRouteMeters(
  pathPoints: readonly FcG41122Point[],
): number {
  let total = 0;

  for (let index = 1; index < pathPoints.length; index += 1) {
    total += fcG41122DistanceMeters(
      pathPoints[index - 1],
      pathPoints[index],
    );
  }

  return total;
}

function fcG41122ApplyMonotonicProgress(
  ownerKey: string,
  pathPoints: readonly FcG41122Point[],
  rawProgressMeters: number,
): number {
  const routeKey = fcG41122RouteKey(ownerKey, pathPoints);
  const totalMeters = fcG41122TotalRouteMeters(pathPoints);
  const now = Date.now();
  const previous = fcG41122ProgressByRoute.get(routeKey);

  const clampedRaw = Math.max(
    0,
    Math.min(
      totalMeters,
      Number.isFinite(rawProgressMeters)
        ? rawProgressMeters
        : 0,
    ),
  );

  const shouldReset =
    !!previous &&
    now - previous.updatedAtMs > 30 * 60 * 1000 &&
    clampedRaw < 100;

  const previousProgress =
    shouldReset
      ? 0
      : previous?.progressMeters ?? 0;

  const applied = Math.max(
    previousProgress,
    clampedRaw,
  );

  fcG41122ProgressByRoute.set(routeKey, {
    progressMeters: applied,
    updatedAtMs: now,
  });

  console.info("ROUTE_PROGRESS_PROJECTED", {
    progressMeters: Math.round(clampedRaw),
  });

  console.info("ROUTE_PROGRESS_MONOTONIC_APPLIED", {
    progressMeters: Math.round(applied),
  });

  return applied;
}

function fcG41122SliceRemainingPath(
  pathPoints: readonly FcG41122Point[],
  progressMeters: number,
): FcG41122Point[] {
  if (pathPoints.length < 2) {
    return [...pathPoints];
  }

  if (progressMeters <= 0) {
    return [...pathPoints];
  }

  let cumulative = 0;

  for (
    let index = 0;
    index < pathPoints.length - 1;
    index += 1
  ) {
    const start = pathPoints[index];
    const end = pathPoints[index + 1];
    const segmentMeters =
      fcG41122DistanceMeters(start, end);
    const segmentEnd = cumulative + segmentMeters;

    if (progressMeters <= segmentEnd) {
      const ratio =
        segmentMeters > 0
          ? Math.max(
              0,
              Math.min(
                1,
                (progressMeters - cumulative) /
                  segmentMeters,
              ),
            )
          : 0;

      const projected = {
        lat:
          start.lat +
          (end.lat - start.lat) * ratio,
        lng:
          start.lng +
          (end.lng - start.lng) * ratio,
      };

      const remaining = [
        projected,
        ...pathPoints.slice(index + 1),
      ];

      console.info("REMAINING_ROUTE_SLICED", {
        remainingPointCount: remaining.length,
      });

      return remaining;
    }

    cumulative = segmentEnd;
  }

  const destination =
    pathPoints[pathPoints.length - 1];

  console.info("REMAINING_ROUTE_SLICED", {
    remainingPointCount: 2,
  });

  return [destination, destination];
}


function fcG41122ApplyRemainingPathToGeoJsonResult<T>(
  originalResult: readonly T[],
  remainingPath: readonly FcG41122Point[],
): T[] {
  const coordinates = remainingPath.map(
    (point) => [point.lng, point.lat],
  );

  return originalResult.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }

    const feature =
      entry as Record<string, unknown>;

    if (
      feature.type === "Feature" &&
      feature.geometry &&
      typeof feature.geometry === "object"
    ) {
      const geometry =
        feature.geometry as Record<string, unknown>;

      if (geometry.type === "LineString") {
        return {
          ...feature,
          geometry: {
            ...geometry,
            coordinates,
          },
        } as T;
      }
    }

    if (feature.type === "LineString") {
      return {
        ...feature,
        coordinates,
      } as T;
    }

    return entry;
  });
}

function fcG41122LogApplied(
  ownerKey: string,
  pathPoints: readonly FcG41122Point[],
  progressMeters: number,
): void {
  const totalMeters =
    fcG41122TotalRouteMeters(pathPoints);

  const remainingMeters = Math.max(
    0,
    totalMeters - progressMeters,
  );

  const progressPercent =
    totalMeters > 0
      ? Math.max(
          0,
          Math.min(
            100,
            (progressMeters / totalMeters) * 100,
          ),
        )
      : 0;

  console.info("REMAINING_ROUTE_APPLIED", {
    progressMeters: Math.round(progressMeters),
    remainingMeters: Math.round(remainingMeters),
    progressPercent: Math.round(progressPercent),
  });
}
// FC_G4_1_1_2_2_PROGRESSIVE_ROUTE_CONSUMPTION_END


// Route geometry and guarded progress (distance markers removed in R1.3.8).
type FcG4102Point = { lat: number; lng: number };

function fcG4102DistanceMeters(a: FcG4102Point, b: FcG4102Point): number {
  const radius = 6371000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}



type FcG4114ProjectionCandidate = {
  progressMeters: number;
  distanceMeters: number;
};

type FcG4114GuardState = {
  progressMeters: number;
  position: FcG4102Point;
};

const fcG4114GuardStateByRoute = new Map<string, FcG4114GuardState>();
const fcG4114FrozenPathByRoute = new Map<string, FcG4102Point[]>();

function fcG4114FreezePath(
  ownerKey: string,
  path: readonly FcG4102Point[],
): FcG4102Point[] {
  if (path.length < 2) {
    return path.map((point) => ({ ...point }));
  }
  const routeKey = fcG41122RouteKey(ownerKey, path);
  const existing = fcG4114FrozenPathByRoute.get(routeKey);
  if (existing) {
    return existing;
  }
  const frozen = path.map((point) => ({ ...point }));
  fcG4114FrozenPathByRoute.set(routeKey, frozen);
  return frozen;
}

function fcG4114ProjectionCandidates(
  path: readonly FcG4102Point[],
  current: FcG4102Point,
): FcG4114ProjectionCandidate[] {
  const candidates: FcG4114ProjectionCandidate[] = [];
  let cumulativeMeters = 0;
  const metersPerLatitudeDegree = 110_540;
  const metersPerLongitudeDegree =
    111_320 * Math.max(
      0.01,
      Math.cos((current.lat * Math.PI) / 180),
    );

  for (let index = 0; index < path.length - 1; index += 1) {
    const start = path[index];
    const end = path[index + 1];
    const segmentMeters = fcG4102DistanceMeters(start, end);
    if (!(segmentMeters > 0)) {
      continue;
    }

    const ax = (start.lng - current.lng) * metersPerLongitudeDegree;
    const ay = (start.lat - current.lat) * metersPerLatitudeDegree;
    const bx = (end.lng - current.lng) * metersPerLongitudeDegree;
    const by = (end.lat - current.lat) * metersPerLatitudeDegree;
    const dx = bx - ax;
    const dy = by - ay;
    const denominator = dx * dx + dy * dy;
    const rawT = denominator > 0
      ? -(ax * dx + ay * dy) / denominator
      : 0;
    const t = Math.max(0, Math.min(1, rawT));
    const projected = {
      lat: start.lat + (end.lat - start.lat) * t,
      lng: start.lng + (end.lng - start.lng) * t,
    };

    candidates.push({
      progressMeters: cumulativeMeters + segmentMeters * t,
      distanceMeters: fcG4102DistanceMeters(current, projected),
    });
    cumulativeMeters += segmentMeters;
  }

  return candidates;
}

function fcG4114GuardProgress(
  ownerKey: string,
  path: readonly FcG4102Point[],
  current: FcG4102Point | null,
  projectedProgressMeters: number,
): number {
  if (!current || path.length < 2) {
    return 0;
  }

  const routeKey = fcG41122RouteKey(ownerKey, path);
  const candidates = fcG4114ProjectionCandidates(path, current);
  if (candidates.length === 0) {
    return 0;
  }

  const previous = fcG4114GuardStateByRoute.get(routeKey);
  if (!previous) {
    const minDistance = Math.min(...candidates.map((candidate) => candidate.distanceMeters));
    const nearEquivalent = candidates
      .filter((candidate) => candidate.distanceMeters <= minDistance + 25)
      .sort((left, right) =>
        left.progressMeters - right.progressMeters ||
        left.distanceMeters - right.distanceMeters,
      );
    const selected = nearEquivalent[0];
    const initialProgress = Math.max(
      0,
      Math.min(selected.progressMeters, projectedProgressMeters),
    );
    fcG4114GuardStateByRoute.set(routeKey, {
      progressMeters: initialProgress,
      position: current,
    });
    return initialProgress;
  }

  const gpsDisplacementMeters =
    fcG4102DistanceMeters(previous.position, current);
  const allowedForwardAdvanceMeters = Math.max(
    250,
    gpsDisplacementMeters * 2 + 100,
  );
  const maxAllowedProgressMeters =
    previous.progressMeters + allowedForwardAdvanceMeters;

  const eligible = candidates
    .filter((candidate) =>
      candidate.progressMeters <= maxAllowedProgressMeters + 0.001,
    )
    .sort((left, right) =>
      left.distanceMeters - right.distanceMeters ||
      left.progressMeters - right.progressMeters,
    );

  if (eligible.length === 0) {
    fcG4114GuardStateByRoute.set(routeKey, {
      progressMeters: previous.progressMeters,
      position: current,
    });
    return previous.progressMeters;
  }

  const selected = eligible[0];
  const appliedProgress = Math.max(
    previous.progressMeters,
    selected.progressMeters,
  );
  fcG4114GuardStateByRoute.set(routeKey, {
    progressMeters: appliedProgress,
    position: current,
  });
  return appliedProgress;
}
// FC_G4114_CROSS_SEGMENT_FALSE_JUMP_GUARD


function fcG4102ProgressMeters(
  pathPoints: FcG4102Point[],
  current: FcG4102Point | null,
): number {
  if (!current || pathPoints.length < 2) {
    return 0;
  }

  const referenceLat = (current.lat * Math.PI) / 180;
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLng = 111320 * Math.cos(referenceLat);

  let cumulativeMeters = 0;
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let bestProgressMeters = 0;

  for (let index = 1; index < pathPoints.length; index += 1) {
    const start = pathPoints[index - 1];
    const end = pathPoints[index];
    const segmentMeters = fcG4102DistanceMeters(start, end);

    const ax = (start.lng - current.lng) * metersPerDegreeLng;
    const ay = (start.lat - current.lat) * metersPerDegreeLat;
    const bx = (end.lng - current.lng) * metersPerDegreeLng;
    const by = (end.lat - current.lat) * metersPerDegreeLat;

    const vx = bx - ax;
    const vy = by - ay;
    const denominator = vx * vx + vy * vy;
    const rawT = denominator > 0 ? -(ax * vx + ay * vy) / denominator : 0;
    const t = Math.max(0, Math.min(1, rawT));

    const px = ax + vx * t;
    const py = ay + vy * t;
    const distanceSquared = px * px + py * py;

    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestProgressMeters = cumulativeMeters + segmentMeters * t;
    }

    cumulativeMeters += segmentMeters;
  }

  return bestProgressMeters;
}

function fcG4102SvgIcon(distanceMeters: number, completed: boolean): string {
  const fill = completed ? "#16a34a" : "#facc15";
  const stroke = completed ? "#14532d" : "#713f12";
  const text = distanceMeters >= 1000
    ? (distanceMeters / 1000).toFixed(1) + "k"
    : String(distanceMeters);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 42 42">' +
    '<circle cx="21" cy="21" r="18" fill="' + fill + '" stroke="' + stroke + '" stroke-width="3"/>' +
    '<text x="21" y="25" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="#111827">' +
    text +
    '</text></svg>';
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}


const OPEN_STANDARD_STYLE_URL =
  process.env.NEXT_PUBLIC_FLASH_OPEN_STANDARD_MAP_STYLE_URL?.trim() ||
  'https://tiles.openfreemap.org/styles/liberty';

const FALLBACK_CENTER: [
  number,
  number,
] =
  [
    -63.1807,
    -17.7833,
  ];

const ROUTE_SOURCE_ID =
  'delivery-monitor-routes';

const ROUTE_LAYER_ID =
  'delivery-monitor-routes-line';

const TRAIL_SOURCE_ID =
  'delivery-monitor-gps-trails';

const TRAIL_LAYER_ID =
  'delivery-monitor-gps-trails-line';

interface MapLibreMonitorMapProps {
  items: DeliveryMonitorItem[];
}

function markerElement(
  label: string,
  className: string,
) {
  const element =
    document.createElement('div');

  element.className =
    className;

  element.setAttribute(
    'aria-label',
    label,
  );

  return element;
}

export default function MapLibreMonitorMap({
  items,
}: MapLibreMonitorMapProps) {
  const containerRef =
    useRef<HTMLDivElement | null>(
      null,
    );

  const fittedRef = useRef(false);
  const cachePrefix = useRef(`ops-map-${++cacheInstanceSerial}:`);
  const itemOwner = (item: DeliveryMonitorItem) => cachePrefix.current + JSON.stringify([item.deliveryId,item.assignmentKey ?? null,item.driverId]);
  useEffect(() => { releaseMapCache(cachePrefix.current, new Set(items.map(itemOwner))); }, [items]);
  useEffect(() => { const prefix = cachePrefix.current; return () => releaseMapCache(prefix); }, []);

  const mapRef =
    useRef<maplibregl.Map | null>(
      null,
    );

  const markerRefs =
    useRef<
      Map<
        string,
        maplibregl.Marker
      >
    >(
      new Map(),
    );

  const [
    ready,
    setReady,
  ] =
    useState(false);

  useEffect(() => {
    const container =
      containerRef.current;

    if (!container) {
      return;
    }

    const releaseGestures = containMapGestures(container);
    fittedRef.current = false;
    const map =
      new maplibregl.Map({
        container,
        style: OPEN_STANDARD_STYLE_URL,
        center: FALLBACK_CENTER,
        zoom: 11,
        minZoom: 3,
        maxZoom: 20,
        cooperativeGestures: false,
        touchZoomRotate: true,
      });

    map.touchZoomRotate.disableRotation();
    map.addControl(
      new maplibregl.NavigationControl(),
      'top-right',
    );

    map.on(
      'load',
      () => {
        setReady(true);
      },
    );

    mapRef.current =
      map;

    return () => {
      releaseGestures();
      markerRefs.current.forEach(
        (marker) =>
          marker.remove(),
      );

      markerRefs.current.clear();
      mapRef.current = null;
      setReady(false);
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map =
      mapRef.current;

    if (
      !map ||
      !ready
    ) {
      return;
    }

    const activeMarkerKeys =
      new Set<string>();

    const visiblePoints:
      Array<[number, number]> =
        [];

    for (const item of items) {
      const destinationKey =
        `destination:${item.deliveryId}`;

      activeMarkerKeys.add(
        destinationKey,
      );

      let destinationMarker =
        markerRefs.current.get(
          destinationKey,
        );

      if (!destinationMarker) {
        destinationMarker =
          new maplibregl.Marker({
            element:
              markerElement(
                `Destino pedido ${item.orderNumber}`,
                styles.destinationMarker,
              ),
          }).setLngLat([
            item.destinationLocation.longitude,
            item.destinationLocation.latitude,
          ]).addTo(map);

        markerRefs.current.set(
          destinationKey,
          destinationMarker,
        );
      }

      const destinationPosition:
        [number, number] =
          [
            item.destinationLocation.longitude,
            item.destinationLocation.latitude,
          ];

      destinationMarker.setLngLat(
        destinationPosition,
      );

      visiblePoints.push(
        destinationPosition,
      );

      if (item.latestLocation) {
        const driverKey =
          `driver:${item.deliveryId}`;

        activeMarkerKeys.add(
          driverKey,
        );

        let driverMarker =
          markerRefs.current.get(
            driverKey,
          );

        if (!driverMarker) {
          driverMarker =
            new maplibregl.Marker({
              element:
                markerElement(
                  `Conductor pedido ${item.orderNumber}`,
                  styles.driverMarker,
                ),
            }).setLngLat([
              item.latestLocation.longitude,
              item.latestLocation.latitude,
            ]).addTo(map);

          markerRefs.current.set(
            driverKey,
            driverMarker,
          );
        }

        const driverPosition:
          [number, number] =
            [
              item.latestLocation.longitude,
              item.latestLocation.latitude,
            ];

        driverMarker.setLngLat(
          driverPosition,
        );

        console.info(
          '[DM_TRACE] MAP_MARKER_APPLIED',
        );

        visiblePoints.push(
          driverPosition,
        );
      }
    }

    markerRefs.current.forEach(
      (marker, key) => {
        if (
          !activeMarkerKeys.has(
            key,
          )
        ) {
          marker.remove();
          markerRefs.current.delete(
            key,
          );
        }
      },
    );

    const trailFeatures =
      items.flatMap(
        (item) =>
          item.trail.length >= 2
            ? [
                {
                  type:
                    'Feature' as const,

                  geometry: {
                    type:
                      'LineString' as const,

                    coordinates:
                      item.trail.map(
                        (point) => [
                          point.longitude,
                          point.latitude,
                        ],
                      ),
                  },

                  properties: {
                    deliveryId:
                      item.deliveryId,

                    orderNumber:
                      item.orderNumber,
                  },
                },
              ]
            : [],
      );

    if (trailFeatures.length > 0) {
      const trailData = {
        type:
          'FeatureCollection' as const,

        features:
          trailFeatures,
      };

      const existingTrailSource =
        map.getSource(
          TRAIL_SOURCE_ID,
        );

      if (!existingTrailSource) {
        map.addSource(
          TRAIL_SOURCE_ID,
          {
            type:
              'geojson',

            data:
              trailData,
          },
        );
      } else {
        (
          existingTrailSource as
            maplibregl.GeoJSONSource
        ).setData(
          trailData as Parameters<
            maplibregl.GeoJSONSource['setData']
          >[0],
        );
      }

      if (
        !map.getLayer(
          TRAIL_LAYER_ID,
        )
      ) {
        map.addLayer({
          id:
            TRAIL_LAYER_ID,

          type:
            'line',

          source:
            TRAIL_SOURCE_ID,

          paint: {
            'line-width':
              5,

            'line-opacity':
              0.85,

            'line-dasharray':
              [
                1.5,
                1,
              ],
          },
        });
      }

      console.info(
        '[DM_TRACE] MAP_TRAIL_APPLIED',
      );
    } else {
      if (
        map.getLayer(
          TRAIL_LAYER_ID,
        )
      ) {
        map.removeLayer(
          TRAIL_LAYER_ID,
        );
      }

      if (
        map.getSource(
          TRAIL_SOURCE_ID,
        )
      ) {
        map.removeSource(
          TRAIL_SOURCE_ID,
        );
      }
    }

    const routeFeatures =
      items.flatMap(
        (item) =>
          {
        const fcG4102OriginalCallbackResult = (item.route?.geoJson
            ? [item.route.geoJson]
            : []);

        let fcG41122RemainingCallbackResult =
          fcG4102OriginalCallbackResult;


      {
        const fcG4102GeoJson = item.route?.geoJson;
        const fcG4102Coordinates: unknown[] =
          fcG4102GeoJson &&
          fcG4102GeoJson.geometry &&
          fcG4102GeoJson.geometry.type === "LineString" &&
          Array.isArray(fcG4102GeoJson.geometry.coordinates)
            ? fcG4102GeoJson.geometry.coordinates
            : [];

        const fcG4114OwnerKey = itemOwner(item);
const fcG4114IncomingPath = fcG4102Coordinates
          .map(
            (coordinate: unknown): FcG4102Point | null => {
              if (!Array.isArray(coordinate) || coordinate.length < 2) {
                return null;
              }

              const lng = Number(coordinate[0]);
              const lat = Number(coordinate[1]);

              if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                return null;
              }

              return { lat, lng };
            },
          )
          .filter(
            (
              point: FcG4102Point | null,
            ): point is FcG4102Point => point !== null,
          );
const fcG4102Path = fcG4114FreezePath(
  fcG4114OwnerKey,
  fcG4114IncomingPath,
);

        const fcG4102Latest = item.latestLocation;
        const fcG4114ProjectedProgress = fcG4102ProgressMeters(
          fcG4102Path,
          fcG4102Latest
            ? {
                lat: Number(fcG4102Latest.latitude),
                lng: Number(fcG4102Latest.longitude),
              }
            : null,
        );
const fcG4102Progress = fcG4114GuardProgress(
  fcG4114OwnerKey,
  fcG4102Path,
  fcG4102Latest
            ? {
                lat: Number(fcG4102Latest.latitude),
                lng: Number(fcG4102Latest.longitude),
              }
            : null,
  fcG4114ProjectedProgress,
);

        const fcG41122Progress =
          fcG41122ApplyMonotonicProgress(
            fcG4114OwnerKey,
            fcG4102Path,
            fcG4102Progress,
          );


        const fcG41122RemainingPath =
          fcG41122SliceRemainingPath(
            fcG4102Path,
            fcG41122Progress,
          );

        fcG41122RemainingCallbackResult =
          fcG41122ApplyRemainingPathToGeoJsonResult(
            fcG4102OriginalCallbackResult,
            fcG41122RemainingPath,
          );

        fcG41122LogApplied(
          fcG4114OwnerKey,
          fcG4102Path,
          fcG41122Progress,
        );


        }

        return fcG41122RemainingCallbackResult;
      },
      );

    if (routeFeatures.length > 0) {
      const routeData = {
        type: 'FeatureCollection' as const,
        features:
          routeFeatures,
      };

      const existingSource =
        map.getSource(
          ROUTE_SOURCE_ID,
        );

      if (!existingSource) {
        map.addSource(
          ROUTE_SOURCE_ID,
          {
            type: 'geojson',
            data: routeData,
          },
        );
      } else {
        (
          existingSource as
            maplibregl.GeoJSONSource
        ).setData(
          routeData as Parameters<
            maplibregl.GeoJSONSource['setData']
          >[0],
        );
      }

      if (
        !map.getLayer(
          ROUTE_LAYER_ID,
        )
      ) {
        map.addLayer({
          id: ROUTE_LAYER_ID,
          type: 'line',
          source: ROUTE_SOURCE_ID,
          paint: {
            'line-width': 4,
            'line-opacity': 0.75,
          },
        });
      }
    } else {
      if (
        map.getLayer(
          ROUTE_LAYER_ID,
        )
      ) {
        map.removeLayer(
          ROUTE_LAYER_ID,
        );
      }

      if (
        map.getSource(
          ROUTE_SOURCE_ID,
        )
      ) {
        map.removeSource(
          ROUTE_SOURCE_ID,
        );
      }
    }

    if (!fittedRef.current && visiblePoints.length === 1) {
      fittedRef.current = true;
      map.easeTo({
        center:
          visiblePoints[0],
        zoom:
          Math.max(
            map.getZoom(),
            14,
          ),
        duration: 0,
      });
    }

    if (!fittedRef.current && visiblePoints.length > 1) {
      fittedRef.current = true;
      const bounds =
        new maplibregl.LngLatBounds(
          visiblePoints[0],
          visiblePoints[0],
        );

      for (
        const point
        of visiblePoints.slice(1)
      ) {
        bounds.extend(point);
      }

      map.fitBounds(
        bounds,
        {
          padding: 64,
          maxZoom: 15,
          duration: 0,
        },
      );
    }
  }, [
    items,
    ready,
  ]);

  return (
    <div className={styles.mapViewport} style={{minWidth:0,maxWidth:"100%",overflow:"hidden"}}>
      <div
        ref={containerRef}
        className={styles.mapCanvas}
        style={{minWidth:0,maxWidth:"100%",touchAction:"none",overscrollBehavior:"contain"}}
      />

      {!ready && (
        <div className={styles.mapLoading}>
          Inicializando MapLibre…
        </div>
      )}
    </div>
  );
}