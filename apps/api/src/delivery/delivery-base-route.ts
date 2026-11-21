import { createHash } from 'node:crypto';
import type { GeoPoint, GeoRouteResult } from './geo.types';
import { decodeRoute, validPoint } from './driver-journey';

export type DeliveryBaseRoute = {
  identity: string | null;
  status: 'READY' | 'UNAVAILABLE' | 'MISSING_ORIGIN' | 'HIDDEN';
  route: GeoRouteResult | null;
  path: GeoPoint[];
};
type Entry = {
  result: DeliveryBaseRoute;
  lastSeen: number;
  retryAt: number;
  pending?: Promise<void>;
};

// Only configured branch coordinates seed a planned route, never a fabricated GPS fix.
export class DeliveryBaseRouteCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}
  async get(
    owner: string,
    origin: GeoPoint | null,
    destination: GeoPoint,
    calculate: (
      origin: GeoPoint,
      destination: GeoPoint,
    ) => Promise<GeoRouteResult>,
  ): Promise<DeliveryBaseRoute> {
    if (!origin || !validPoint(origin))
      return {
        identity: null,
        status: 'MISSING_ORIGIN',
        route: null,
        path: [],
      };
    if (!validPoint(destination))
      return { identity: null, status: 'UNAVAILABLE', route: null, path: [] };
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          owner,
          origin.latitude,
          origin.longitude,
          destination.latitude,
          destination.longitude,
        ]),
      )
      .digest('hex');
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      // Active polling keeps a delivery's geometry stable. Idle entries expire after 24 hours.
      for (const [id, value] of this.entries)
        if (!value.pending && now - value.lastSeen > 86400000)
          this.entries.delete(id);
      if (this.entries.size >= 250) {
        const victim = [...this.entries]
          .filter(([, v]) => !v.pending)
          .sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
        if (victim) this.entries.delete(victim[0]);
      }
      if (this.entries.size >= 250)
        return { identity: key, status: 'UNAVAILABLE', route: null, path: [] };
      entry = {
        result: { identity: key, status: 'UNAVAILABLE', route: null, path: [] },
        lastSeen: now,
        retryAt: 0,
      };
      this.entries.set(key, entry);
    }
    entry.lastSeen = now;
    if (!entry.pending && !entry.result.route && now >= entry.retryAt) {
      const target = entry;
      target.retryAt = now + 60000;
      target.pending = (async () => {
        try {
          const route = await calculate(origin, destination);
          if (
            !Number.isFinite(route.distanceMeters) ||
            route.distanceMeters < 0 ||
            !Number.isFinite(route.durationSeconds) ||
            route.durationSeconds < 0 ||
            typeof route.encodedPolyline !== 'string' ||
            route.encodedPolyline.length > 100000
          )
            throw new Error('INVALID_BASE_ROUTE');
          const path = decodeRoute(route.encodedPolyline);
          target.result = { identity: key, status: 'READY', route, path };
        } catch {
          target.result = {
            identity: key,
            status: 'UNAVAILABLE',
            route: null,
            path: [],
          };
        }
      })();
      try {
        await target.pending;
      } finally {
        target.pending = undefined;
      }
    } else if (entry.pending) {
      await entry.pending;
    }
    return entry.result;
  }
}
