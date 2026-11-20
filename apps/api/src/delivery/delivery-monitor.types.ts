export type DeliveryMonitorDeliveryStatus =
  | 'CREATED'
  | 'WAITING_ASSIGNMENT'
  | 'ASSIGNED'
  | 'ACCEPTED'
  | 'PICKED_UP'
  | 'EN_ROUTE'
  | 'ARRIVED';

export interface DeliveryMonitorPoint {
  latitude: number;
  longitude: number;
}

export interface DeliveryMonitorLatestLocation
  extends DeliveryMonitorPoint {
  accuracyM: number | null;
  capturedAt: string;
}

export interface DeliveryMonitorTrailPoint
  extends DeliveryMonitorLatestLocation {}

export interface DeliveryMonitorRouteFeature {
  type: 'Feature';
  geometry: {
    type: 'LineString';
    coordinates: number[][];
  };
  properties: Record<string, unknown>;
}

export interface DeliveryMonitorRoute {
  status: 'AVAILABLE' | 'UNAVAILABLE';
  provider: 'GOOGLE' | 'VALHALLA' | null;
  geoJson: DeliveryMonitorRouteFeature | null;
  distanceM: number | null;
  durationS: number | null;
  etaAt: string | null;
  calculatedAt: string | null;
}

export interface DeliveryMonitorItem {
  deliveryId: string;
  orderId: string;
  orderNumber: string;
  deliveryStatus: DeliveryMonitorDeliveryStatus;
  driverId: string | null;
  driverCode: string | null;
  latestLocation: DeliveryMonitorLatestLocation | null;
  trail: DeliveryMonitorTrailPoint[];
  destinationLocation: DeliveryMonitorPoint;
  route: DeliveryMonitorRoute | null;
}

export interface DeliveryMonitorSnapshot {
  snapshotVersion: 'delivery-monitor.snapshot.v1';
  generatedAt: string;
  items: DeliveryMonitorItem[];
}