import type {
  GeoAutocompleteSuggestion,
  GeoResolvedLocation,
} from './geo.types';

export interface DeliveryAddressAutocompleteInput {
  tenantCode?: unknown;
  branchCode?: unknown;
  input?: unknown;
}

export interface DeliveryAddressResolveInput {
  tenantCode?: unknown;
  branchCode?: unknown;
  placeId?: unknown;
}

export interface DeliveryAddressGeocodeInput {
  tenantCode?: unknown;
  branchCode?: unknown;
  address?: unknown;
}

export interface DeliveryAddressAutocompleteResponse {
  tenant: string;
  branch: string;
  suggestions: GeoAutocompleteSuggestion[];
}

export interface DeliveryAddressResolveResponse {
  tenant: string;
  branch: string;
  location: GeoResolvedLocation;
}

export interface DeliveryAddressGeocodeResponse {
  tenant: string;
  branch: string;
  location: GeoResolvedLocation | null;
}