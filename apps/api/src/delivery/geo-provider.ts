import type {
  GeoAutocompleteInput,
  GeoPoint,
  GeoAutocompleteSuggestion,
  GeoGeocodeAddressInput,
  GeoResolvedLocation,
  GeoResolvePlaceInput,
  GeoRouteInput,
  GeoRouteResult,
} from './geo.types';

export const GEO_PROVIDER = Symbol('GEO_PROVIDER');

export interface GeoProvider {
  readonly name: string;

  autocomplete(
    input: GeoAutocompleteInput,
  ): Promise<GeoAutocompleteSuggestion[]>;

  resolvePlace(
    input: GeoResolvePlaceInput,
  ): Promise<GeoResolvedLocation>;

  geocodeAddress(
    input: GeoGeocodeAddressInput,
  ): Promise<GeoResolvedLocation | null>;

  reverseGeocode(input: { location: GeoPoint; languageCode?: string; regionCode?: string }): Promise<GeoResolvedLocation | null>;

  calculateRoute(
    input: GeoRouteInput,
  ): Promise<GeoRouteResult>;
}