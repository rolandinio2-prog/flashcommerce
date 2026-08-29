export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface GeoLocationBiasCircle {
  center: GeoPoint;
  radiusMeters: number;
}

export interface GeoAutocompleteInput {
  input: string;

  languageCode?: string;
  regionCode?: string;
  countryCode?: string;

  locationBias?: GeoLocationBiasCircle;
}

export interface GeoAutocompleteSuggestion {
  placeId: string;
  text: string;

  mainText: string | null;
  secondaryText: string | null;
}

export interface GeoResolvePlaceInput {
  placeId: string;

  languageCode?: string;
  regionCode?: string;
}

export interface GeoGeocodeAddressInput {
  address: string;

  languageCode?: string;
  regionCode?: string;
}

export interface GeoResolvedLocation {
  placeId: string;
  formattedAddress: string;
  location: GeoPoint;
}

export interface GeoRouteInput {
  origin: GeoPoint;
  destination: GeoPoint;
}

export interface GeoRouteResult {
  distanceMeters: number;
  durationSeconds: number;
  encodedPolyline: string;
}
