import type { GeoCapabilities } from './geo.types';

export const GEO_PROFILE_CODES = [
  'OPEN_STANDARD',
  'OPEN_ENTERPRISE',
  'GOOGLE_PREMIUM',
] as const;

export type GeoProfileCode =
  (typeof GEO_PROFILE_CODES)[number];

export type GeoRendererId =
  | 'MAPLIBRE'
  | 'GOOGLE_MAPS';

export type GeoRoutingProviderId =
  | 'VALHALLA'
  | 'GOOGLE';

export type GeoGeocodingProviderId =
  | 'OPEN'
  | 'GOOGLE';

export type GeoTrafficProviderId =
  | 'NONE'
  | 'GOOGLE';

export type GeoProfileSource =
  | 'BRANCH_OVERRIDE'
  | 'TENANT_DEFAULT'
  | 'LEGACY_DEFAULT';

export interface EffectiveGeoProfile {
  code: GeoProfileCode;
  renderer: GeoRendererId;
  routingProvider: GeoRoutingProviderId;
  geocodingProvider: GeoGeocodingProviderId;
  trafficProvider: GeoTrafficProviderId;
  capabilities: GeoCapabilities;
  source: GeoProfileSource;
}