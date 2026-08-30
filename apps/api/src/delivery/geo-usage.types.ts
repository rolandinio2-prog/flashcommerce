export type GeoUsageProvider =
  | 'GOOGLE'
  | 'VALHALLA'
  | 'OPEN';

export type GeoUsageOperation =
  | 'ROUTE'
  | 'GEOCODE_SEARCH'
  | 'GEOCODE_RESOLVE'
  | 'GEOCODE_FORWARD'
  | 'GEOCODE_REVERSE'
  | 'MATRIX'
  | 'MAP_MATCH';

export interface GeoUsageRecordInput {
  tenantId?: string;
  tenantCode?: string;
  provider: GeoUsageProvider;
  operation: GeoUsageOperation;
  latencyMs: number;
  cacheHit?: boolean;
}

export type GeoUsageMeasureInput =
  Omit<GeoUsageRecordInput, 'latencyMs'>;