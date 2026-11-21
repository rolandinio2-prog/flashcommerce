import type { GeoRouteInput, RouteResult } from './geo.types';
import type { GeoShadowEtaComparisonResult } from './geo-shadow-eta.types';

export interface GeoShadowEtaOrchestratorInput {
  route: GeoRouteInput;
  tenantId?: string;
  tenantCode?: string;
}

export interface GeoShadowEtaOrchestratorResult {
  referenceRoute: RouteResult;
  comparison: GeoShadowEtaComparisonResult;
}
