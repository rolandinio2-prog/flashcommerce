import type {DeliveryMonitorItem, DeliveryMonitorRoute, DeliveryMonitorSnapshot} from './delivery-monitor.types';
const statuses = new Set(['CREATED','WAITING_ASSIGNMENT','ASSIGNED','ACCEPTED','PICKED_UP','EN_ROUTE','ARRIVED']);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function date(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function point(value: unknown): boolean { return record(value) && typeof value.latitude === 'number' && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 && typeof value.longitude === 'number' && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180; }
function location(value: unknown): boolean { return point(value) && record(value) && date(value.capturedAt) && (value.accuracyM === null || (typeof value.accuracyM === 'number' && Number.isFinite(value.accuracyM) && value.accuracyM >= 0)); }
function metric(value: unknown): boolean { return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0); }
export function parseMonitorRoute(value: unknown): DeliveryMonitorRoute | null {
  if (value === null) return null;
  if (!record(value) || !['AVAILABLE','UNAVAILABLE'].includes(String(value.status)) || ![null,'GOOGLE','VALHALLA'].includes(value.provider as null | string) || !metric(value.distanceM) || !metric(value.durationS) || (value.etaAt !== null && !date(value.etaAt)) || (value.calculatedAt !== null && !date(value.calculatedAt))) throw new Error('Contrato de ruta inválido');
  if (value.geoJson !== null) {
    const feature = value.geoJson;
    if (!record(feature) || feature.type !== 'Feature' || !record(feature.geometry) || feature.geometry.type !== 'LineString' || !Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length < 2 || !feature.geometry.coordinates.every(p => Array.isArray(p) && point({latitude:p[1],longitude:p[0]}))) throw new Error('Geometría de ruta inválida');
  }
  if (value.status === 'AVAILABLE' && value.geoJson === null) throw new Error('Ruta disponible sin geometría');
  return value as unknown as DeliveryMonitorRoute;
}
export function parseMonitorSnapshot(value: unknown): DeliveryMonitorSnapshot {
  if (!record(value) || value.snapshotVersion !== 'delivery-monitor.snapshot.v1' || !date(value.generatedAt) || !Array.isArray(value.items)) throw new Error('Contrato del monitor inválido');
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!record(item) || !text(item.deliveryId) || ids.has(item.deliveryId) || !text(item.orderId) || !text(item.orderNumber) || !statuses.has(String(item.deliveryStatus)) || !(item.driverId === null || text(item.driverId)) || !(item.driverCode === null || text(item.driverCode)) || !point(item.destinationLocation) || !(item.latestLocation === null || location(item.latestLocation)) || !Array.isArray(item.trail) || item.trail.length > 500 || !item.trail.every(location) || !(item.assignmentKey === undefined || item.assignmentKey === null || text(item.assignmentKey)) || !(item.assignedAt === undefined || item.assignedAt === null || date(item.assignedAt))) throw new Error('Entrega del monitor inválida');
    parseMonitorRoute(item.route); ids.add(item.deliveryId);
  }
  return value as unknown as DeliveryMonitorSnapshot;
}
export function monitorItemIdentity(item: DeliveryMonitorItem): string {
  return JSON.stringify([item.assignmentKey ?? null,item.driverId,item.destinationLocation.latitude,item.destinationLocation.longitude]);
}
