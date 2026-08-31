import { Injectable } from '@nestjs/common';
import type { GeoRoutingProviderId } from './geo-profile.types';
import { GoogleRoutingProvider } from './google-routing.provider';
import type { RoutingProvider } from './routing-provider';
import { ValhallaRoutingProvider } from './valhalla-routing.provider';

@Injectable()
export class RoutingProviderSelector {
  constructor(
    private readonly googleRoutingProvider:
      GoogleRoutingProvider,
    private readonly valhallaRoutingProvider:
      ValhallaRoutingProvider,
  ) {}

  select(
    providerId: GeoRoutingProviderId,
  ): RoutingProvider {
    switch (providerId) {
      case 'GOOGLE':
        return this.googleRoutingProvider;

      case 'VALHALLA':
        return this.valhallaRoutingProvider;

      default: {
        const unsupportedProvider:
          never =
            providerId;

        throw new Error(
          `UNSUPPORTED_ROUTING_PROVIDER_${String(
            unsupportedProvider,
          )}`,
        );
      }
    }
  }
}
