"use client";

import {
  useEffect,
  useRef,
  useState,
} from "react";

import {containMapGestures} from "../../lib/map-gestures";
import { loadTrackingMapLibraries } from "../../lib/google-maps";

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

function fcG41122RouteKey(
  ownerKey: string,
  path: readonly FcG41122Point[],
): string {
  const destination =
    path.length > 0 ? path[path.length - 1] : null;
  return destination
    ? [
        ownerKey,
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
    owner: ownerKey,
    progressMeters: Math.round(clampedRaw),
  });

  console.info("ROUTE_PROGRESS_MONOTONIC_APPLIED", {
    owner: ownerKey,
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
    owner: ownerKey,
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


type MapPoint = {
  latitude: number;
  longitude: number;
};

type TrackingMapClientProps = {
  tenantCode: string;
  trackingToken: string;
  driverPosition: MapPoint | null;
  destination: MapPoint | null;
  branchOrigin?: (MapPoint & {name: string}) | null;
  encodedPolyline: string | null;
};

export default function TrackingMapClient({
  tenantCode, trackingToken, driverPosition, branchOrigin,
  destination,
  encodedPolyline,
}: TrackingMapClientProps) {
  const containerRef =
    useRef<HTMLDivElement | null>(null);

  const mapRef = useRef<google.maps.Map | null>(null);
  const fittedRef = useRef(false);
  useEffect(() => { fittedRef.current = false; }, [branchOrigin?.latitude, branchOrigin?.longitude]);
  useEffect(() => {
    const container = containerRef.current;
    const release = container ? containMapGestures(container) : () => {};
    return () => {
      release();
      if (mapRef.current) google.maps.event.clearInstanceListeners(mapRef.current);
      mapRef.current = null;
      fittedRef.current = false;
    };
  }, [trackingToken]);

  const [loadError, setLoadError] =
    useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const mapObjects: Array<{
      setMap(map: google.maps.Map | null): void;
    }> = [];

    async function renderMap() {
      const container =
        containerRef.current;

      if (!container) {
        return;
      }

      try {
        setLoadError(null);

        const apiKey =
          process.env.NEXT_PUBLIC_FLASH_GOOGLE_MAPS_API_KEY ?? "";

        const { maps, geometry } =
          await loadTrackingMapLibraries(
            apiKey,
          );

        if (cancelled) {
          return;
        }

        const destinationLatLng = destination ? {
          lat: destination.latitude,
          lng: destination.longitude,
        } : null;
        const branchLatLng = branchOrigin ? {lat: branchOrigin.latitude, lng: branchOrigin.longitude} : null;
        if (!destinationLatLng && !branchLatLng && !driverPosition) return;

        const map =
          mapRef.current ?? new maps.Map(
            container,
            {
              center:
                driverPosition
                  ? {
                      lat:
                        driverPosition.latitude,

                      lng:
                        driverPosition.longitude,
                    }
                  : branchLatLng ?? destinationLatLng!,

              zoom:
                driverPosition ? 14 : 16,

              gestureHandling: "greedy",
              zoomControl: true,
              minZoom: 3,
              maxZoom: 20,
              fullscreenControl: false,
              mapTypeControl: false,
              streetViewControl: false,
              clickableIcons: false,
            },
          );

        mapRef.current = map;

        if (destinationLatLng) {
        const destinationMarker =
          new google.maps.Marker({
            map,
            position: destinationLatLng,
            label: "D",
            title: "Punto de entrega",
          });

        mapObjects.push(
          destinationMarker,
        );

        }

        const bounds =
          new google.maps.LatLngBounds();

        if (destinationLatLng) bounds.extend(destinationLatLng);
        if (branchLatLng) {
          mapObjects.push(new google.maps.Marker({map, position: branchLatLng,
            label: tenantCode === 'POLLO001' ? undefined : "S", title: "Sucursal: " + branchOrigin!.name,
            icon: tenantCode === 'POLLO001' ? {url: "/images/maps/mr-pollo-branch-pin-v1.png", scaledSize: new google.maps.Size(64,64), anchor: new google.maps.Point(32,61)} : {path: google.maps.SymbolPath.CIRCLE, scale: 14, fillColor: "#60a5fa", fillOpacity: 1, strokeColor: "#1e40af", strokeWeight: 2}, zIndex: 3}));
          bounds.extend(branchLatLng);
        }

        if (driverPosition) {
          const driverLatLng = {
            lat:
              driverPosition.latitude,

            lng:
              driverPosition.longitude,
          };

          const driverMarker =
            new google.maps.Marker({
              map,
              position: driverLatLng,
              label: "R",
              title: "Repartidor",
            });

          mapObjects.push(
            driverMarker,
          );

          bounds.extend(
            driverLatLng,
          );
        }

        if (encodedPolyline) {
          const routePath =
            geometry.encoding.decodePath(
              encodedPolyline,
            );
      const fcG4114OwnerKey = "CUSTOMER:" + trackingToken;
const fcG4114IncomingPath = routePath.map((point) => ({
        lat: point.lat(),
        lng: point.lng(),
      }));
const fcG4102Path = fcG4114FreezePath(
  fcG4114OwnerKey,
  fcG4114IncomingPath,
);
      const fcG4114ProjectedProgress = fcG4102ProgressMeters(
        fcG4102Path,
        driverPosition
          ? { lat: driverPosition.latitude, lng: driverPosition.longitude }
          : null,
      );
const fcG4102Progress = fcG4114GuardProgress(
  fcG4114OwnerKey,
  fcG4102Path,
  driverPosition
          ? { lat: driverPosition.latitude, lng: driverPosition.longitude }
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

    fcG41122LogApplied(
      fcG4114OwnerKey,
      fcG4102Path,
      fcG41122Progress,
    );



          const routeLine =
            new maps.Polyline({
              map,
              path: fcG41122RemainingPath,
              strokeColor: "#2563eb",
              strokeOpacity: 0.9,
              strokeWeight: 6,
            });

          mapObjects.push(
            routeLine,
          );

          for (const point of routePath) {
            bounds.extend(point);
          }
        }

        if (
          !fittedRef.current && (branchOrigin || driverPosition ||
          encodedPolyline)
        ) {
          map.fitBounds(
            bounds,
            {top:76,bottom:44,left:44,right:44},
          );
          fittedRef.current = true;
        }
      } catch {
        if (!cancelled) {
          setLoadError(
            "No se pudo cargar el mapa en este dispositivo.",
          );
        }
      }
    }

    void renderMap();

    return () => {
      cancelled = true;

      for (const mapObject of mapObjects) {
        mapObject.setMap(null);
      }
    };
  }, [
    tenantCode, trackingToken,
    destination?.latitude,
    destination?.longitude,
    branchOrigin?.latitude,
    branchOrigin?.longitude,
    branchOrigin?.name,
    driverPosition?.latitude,
    driverPosition?.longitude,
    encodedPolyline,
  ]);

  return (
    <>
    <div
      ref={containerRef}
      className="min-h-72 w-full min-w-0 max-w-full overflow-hidden rounded-3xl bg-slate-100"
      style={{touchAction:"none",overscrollBehavior:"contain"}}
      aria-label="Mapa del seguimiento del delivery"
    />
    <p style={{fontSize:12,margin:"6px 0",color:"#475569"}}>{branchOrigin ? (tenantCode === 'POLLO001' ? "Mr. Pollo · " : "S: ") + branchOrigin.name + " · " : ""}{destination ? "D: Punto de entrega" : ""}{driverPosition ? " · R: Repartidor" : ""}</p>
    {loadError ? <p role="alert">{loadError}</p> : null}
    </>
  );
}
