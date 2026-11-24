import { Inject, Injectable } from '@nestjs/common';
import { GEO_PROVIDER, type GeoProvider } from './geo-provider';
import { GeoUsageMeterService } from './geo-usage-meter.service';
import { type GeoPoint, type GeoRouteResult } from './geo.types';
import { DeliveryBaseRouteCache } from './delivery-base-route';
import {
  DeliveryBranchRow,
  DeliveryMapRouteCacheEntry,
  DELIVERY_MAP_ROUTE_CACHE_TTL_MS,
  DELIVERY_MAP_ROUTE_CACHE_MAX_ENTRIES,
} from './delivery-internal.types';
import { requireDeliveryBranchOrigin } from './delivery-helpers';

@Injectable()
export class DeliveryRoutingService {
  private readonly deliveryBaseRoutes = new DeliveryBaseRouteCache();
  private readonly deliveryMapRouteCache = new Map<
    string,
    DeliveryMapRouteCacheEntry
  >();

  constructor(
    private readonly geoUsageMeter: GeoUsageMeterService,
    @Inject(GEO_PROVIDER) private readonly geoProvider: GeoProvider,
  ) {}

  getDeliveryBaseRoute(
    tenantId: string,
    deliveryId: string,
    origin: GeoPoint | null,
    destination: GeoPoint,
  ) {
    return this.deliveryBaseRoutes.get(
      JSON.stringify([tenantId, deliveryId]),
      origin,
      destination,
      (from, to) =>
        this.geoUsageMeter.measure(
          { tenantId, provider: 'GOOGLE', operation: 'ROUTE', cacheHit: false },
          () =>
            this.geoProvider.calculateRoute({ origin: from, destination: to }),
        ),
    );
  }
  async calculatePublicDeliveryRoute(
    branch: DeliveryBranchRow,
    destination: GeoPoint,
  ): Promise<GeoRouteResult> {
    const origin = requireDeliveryBranchOrigin(branch);

    return this.geoUsageMeter.measure(
      {
        tenantId: branch.tenant_id,
        provider: 'GOOGLE',
        operation: 'ROUTE',
        cacheHit: false,
      },
      () =>
        this.geoProvider.calculateRoute({
          origin,
          destination,
        }),
    );
  }
  async getCachedDeliveryMapRouteForMonitor(
    tenantId: string,
    origin: GeoPoint,
    destination: GeoPoint,
  ): Promise<GeoRouteResult> {
    return this.getCachedDeliveryMapRoute(tenantId, origin, destination);
  }

  private async getCachedDeliveryMapRoute(
    tenantId: string,
    origin: GeoPoint,
    destination: GeoPoint,
    routeIdentity?: string,
  ): Promise<GeoRouteResult> {
    const now = Date.now();
    const cacheKey = routeIdentity
      ? [
          tenantId,
          'FC_G4114_STABLE_DELIVERY_ROUTE_IDENTITY',
          routeIdentity,
          destination.latitude,
          destination.longitude,
        ].join(':')
      : [
          tenantId,
          origin.latitude,
          origin.longitude,
          destination.latitude,
          destination.longitude,
        ].join(':');

    const cached = this.deliveryMapRouteCache.get(cacheKey);
    if (cached && (Boolean(routeIdentity) || cached.expiresAt > now)) {
      return cached.route;
    }
    if (cached) {
      this.deliveryMapRouteCache.delete(cacheKey);
    }

    const route = await this.geoUsageMeter.measure(
      {
        tenantId,
        provider: 'GOOGLE',
        operation: 'ROUTE',
        cacheHit: false,
      },
      () =>
        this.geoProvider.calculateRoute({
          origin,
          destination,
        }),
    );

    if (
      this.deliveryMapRouteCache.size >= DELIVERY_MAP_ROUTE_CACHE_MAX_ENTRIES
    ) {
      const oldestKey = this.deliveryMapRouteCache.keys().next().value as
        string | undefined;
      if (oldestKey) {
        this.deliveryMapRouteCache.delete(oldestKey);
      }
    }

    this.deliveryMapRouteCache.set(cacheKey, {
      expiresAt: routeIdentity
        ? Number.MAX_SAFE_INTEGER
        : now + DELIVERY_MAP_ROUTE_CACHE_TTL_MS,
      route,
    });
    return route;
  }
}
