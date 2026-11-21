import type {
  GeoCandidate,
  GeoCapabilities,
  GeoForwardGeocodeInput,
  GeoLocation,
  GeoProviderId,
  GeoResolveInput,
  GeoReverseGeocodeInput,
  GeoSearchInput,
} from './geo.types';

export const GEOCODING_PROVIDER = Symbol('GEOCODING_PROVIDER');

export interface GeocodingProvider {
  readonly name: GeoProviderId;

  getCapabilities(): GeoCapabilities;

  search(input: GeoSearchInput): Promise<GeoCandidate[]>;

  resolve(input: GeoResolveInput): Promise<GeoLocation>;

  geocode(input: GeoForwardGeocodeInput): Promise<GeoLocation | null>;

  reverse?(input: GeoReverseGeocodeInput): Promise<GeoLocation | null>;
}
