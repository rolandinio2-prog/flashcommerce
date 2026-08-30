import { Injectable } from '@nestjs/common';

import type {
  GeoCapabilities,
  GeoProviderId,
  GeoRouteInput,
  RouteResult,
} from './geo.types';

import type {
  RoutingProvider,
} from './routing-provider';

import {
  GoogleGeoProvider,
} from './google-geo.provider';

@Injectable()
export class GoogleRoutingProvider
  implements RoutingProvider {
  readonly name:
    GeoProviderId =
      'GOOGLE';

  constructor(
    private readonly googleGeoProvider:
      GoogleGeoProvider,
  ) {}

  getCapabilities():
    GeoCapabilities {
    return {
      routing: {
        route: true,
        matrix: false,
        mapMatch: false,
        trafficAware: true,
      },

      geocoding: {
        search: false,
        resolve: false,
        forward: false,
        reverse: false,
      },
    };
  }

  async computeRoute(
    input: GeoRouteInput,
  ): Promise<RouteResult> {
    const route =
      await this.googleGeoProvider
        .calculateRoute(
          input,
        );

    return {
      provider:
        this.name,

      distanceMeters:
        route.distanceMeters,

      durationSeconds:
        route.durationSeconds,

      trafficDurationSeconds:
        null,

      geometry:
        route.encodedPolyline,

      geometryFormat:
        'GOOGLE_ENCODED_POLYLINE',

      mapCompatibility:
        'GOOGLE_MAPS_ONLY',

      calculatedAt:
        new Date().toISOString(),

      expiresAt:
        null,

      metadata: {
        source:
          'GOOGLE_ROUTES',

        trafficAware:
          true,
      },
    };
  }
}
