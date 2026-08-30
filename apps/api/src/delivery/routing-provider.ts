import type {
  GeoCapabilities,
  GeoMapMatchInput,
  GeoMapMatchResult,
  GeoProviderId,
  GeoRouteInput,
  GeoRouteMatrixInput,
  GeoRouteMatrixResult,
  RouteResult,
} from './geo.types';

export const ROUTING_PROVIDER =
  Symbol('ROUTING_PROVIDER');

export interface RoutingProvider {
  readonly name: GeoProviderId;

  getCapabilities():
    GeoCapabilities;

  computeRoute(
    input: GeoRouteInput,
  ): Promise<RouteResult>;

  computeMatrix?(
    input: GeoRouteMatrixInput,
  ): Promise<GeoRouteMatrixResult>;

  matchTrace?(
    input: GeoMapMatchInput,
  ): Promise<GeoMapMatchResult>;
}
