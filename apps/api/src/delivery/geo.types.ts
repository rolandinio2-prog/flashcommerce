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

// ============================================================
// GEO-1 PROVIDER-NEUTRAL CONTRACTS
// ============================================================

export type GeoProviderId =
  | 'GOOGLE'
  | 'VALHALLA'
  | 'OPEN_GEOCODING';

export type GeoRouteGeometryFormat =
  | 'GOOGLE_ENCODED_POLYLINE'
  | 'POLYLINE6'
  | 'GEOJSON_LINESTRING';

export type GeoMapCompatibility =
  | 'GOOGLE_MAPS_ONLY'
  | 'OPEN_STANDARD_ONLY';

export interface GeoJsonLineString {
  type: 'LineString';

  coordinates: ReadonlyArray<
    readonly [number, number]
  >;
}

export interface GeoCapabilities {
  routing: {
    route: boolean;
    matrix: boolean;
    mapMatch: boolean;
    trafficAware: boolean;
  };

  geocoding: {
    search: boolean;
    resolve: boolean;
    forward: boolean;
    reverse: boolean;
  };
}

export type GeoMetadataValue =
  | string
  | number
  | boolean
  | null;

export interface RouteResult {
  provider: GeoProviderId;

  distanceMeters: number;
  durationSeconds: number;

  trafficDurationSeconds:
    | number
    | null;

  geometry:
    | string
    | GeoJsonLineString;

  geometryFormat:
    GeoRouteGeometryFormat;

  mapCompatibility:
    GeoMapCompatibility;

  calculatedAt: string;

  expiresAt:
    | string
    | null;

  metadata: Readonly<
    Record<
      string,
      GeoMetadataValue
    >
  >;
}

export interface GeoRouteMatrixInput {
  origins: ReadonlyArray<GeoPoint>;
  destinations: ReadonlyArray<GeoPoint>;
}

export interface GeoRouteMatrixEntry {
  originIndex: number;
  destinationIndex: number;

  distanceMeters: number;
  durationSeconds: number;
}

export interface GeoRouteMatrixResult {
  provider: GeoProviderId;

  entries: ReadonlyArray<
    GeoRouteMatrixEntry
  >;

  calculatedAt: string;

  expiresAt:
    | string
    | null;

  metadata: Readonly<
    Record<
      string,
      GeoMetadataValue
    >
  >;
}

export interface GeoMapMatchInput {
  trace: ReadonlyArray<GeoPoint>;
}

export interface GeoMapMatchResult {
  provider: GeoProviderId;

  geometry:
    | string
    | GeoJsonLineString;

  geometryFormat:
    GeoRouteGeometryFormat;

  mapCompatibility:
    GeoMapCompatibility;

  calculatedAt: string;

  metadata: Readonly<
    Record<
      string,
      GeoMetadataValue
    >
  >;
}

export interface GeoSearchInput {
  query: string;

  languageCode?: string;
  regionCode?: string;
  countryCode?: string;

  locationBias?: {
    center: GeoPoint;
    radiusMeters: number;
  };
}

export interface GeoCandidate {
  provider: GeoProviderId;

  candidateId: string;

  text: string;

  mainText:
    | string
    | null;

  secondaryText:
    | string
    | null;
}

export interface GeoResolveInput {
  candidateId: string;

  languageCode?: string;
  regionCode?: string;
}

export interface GeoForwardGeocodeInput {
  address: string;

  languageCode?: string;
  regionCode?: string;
}

export interface GeoReverseGeocodeInput {
  location: GeoPoint;

  languageCode?: string;
  regionCode?: string;
}

export interface GeoLocation {
  provider: GeoProviderId;

  candidateId: string;

  formattedAddress: string;

  location: GeoPoint;
}
