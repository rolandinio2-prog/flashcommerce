import { type GeoRouteResult } from './geo.types';

export interface DeliveryBranchRow {
  tenant_id: string;
  branch_id: string;
  branch_code: string;
  branch_name: string;
  delivery_enabled: boolean;
  delivery_origin_latitude: string | null;
  delivery_origin_longitude: string | null;
  delivery_default_prep_minutes: number;
}

export interface DeliveryZoneRow {
  id: string;
  code: string;
  name: string;
  delivery_fee: string;
  minimum_order: string;
  eta_min_minutes: number;
  eta_max_minutes: number;
}

export interface DeliveryMapRouteCacheEntry {
  expiresAt: number;
  route: GeoRouteResult;
}

export const DELIVERY_MAP_ROUTE_CACHE_TTL_MS = 15_000;
export const DELIVERY_MAP_ROUTE_CACHE_MAX_ENTRIES = 250;
