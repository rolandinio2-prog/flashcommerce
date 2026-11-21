import { Injectable } from '@nestjs/common';

import type {
  GeoCandidate,
  GeoCapabilities,
  GeoForwardGeocodeInput,
  GeoLocation,
  GeoProviderId,
  GeoResolveInput,
  GeoSearchInput,
} from './geo.types';

import type { GeocodingProvider } from './geocoding-provider';

import { GoogleGeoProvider } from './google-geo.provider';

@Injectable()
export class GoogleGeocodingProvider implements GeocodingProvider {
  readonly name: GeoProviderId = 'GOOGLE';

  constructor(private readonly googleGeoProvider: GoogleGeoProvider) {}

  getCapabilities(): GeoCapabilities {
    return {
      routing: {
        route: false,
        matrix: false,
        mapMatch: false,
        trafficAware: false,
      },

      geocoding: {
        search: true,
        resolve: true,
        forward: true,
        reverse: false,
      },
    };
  }

  async search(input: GeoSearchInput): Promise<GeoCandidate[]> {
    const suggestions = await this.googleGeoProvider.autocomplete({
      input: input.query,

      languageCode: input.languageCode,

      regionCode: input.regionCode,

      countryCode: input.countryCode,

      locationBias: input.locationBias,
    });

    return suggestions.map((suggestion) => ({
      provider: this.name,

      candidateId: suggestion.placeId,

      text: suggestion.text,

      mainText: suggestion.mainText,

      secondaryText: suggestion.secondaryText,
    }));
  }

  async resolve(input: GeoResolveInput): Promise<GeoLocation> {
    const resolved = await this.googleGeoProvider.resolvePlace({
      placeId: input.candidateId,

      languageCode: input.languageCode,

      regionCode: input.regionCode,
    });

    return {
      provider: this.name,

      candidateId: resolved.placeId,

      formattedAddress: resolved.formattedAddress,

      location: resolved.location,
    };
  }

  async geocode(input: GeoForwardGeocodeInput): Promise<GeoLocation | null> {
    const resolved = await this.googleGeoProvider.geocodeAddress({
      address: input.address,

      languageCode: input.languageCode,

      regionCode: input.regionCode,
    });

    if (!resolved) {
      return null;
    }

    return {
      provider: this.name,

      candidateId: resolved.placeId,

      formattedAddress: resolved.formattedAddress,

      location: resolved.location,
    };
  }
}
