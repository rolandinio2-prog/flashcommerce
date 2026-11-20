import type { DeliveryAddressLocation } from './flash-api';
export type DeliveryPoint = { latitude: number; longitude: number };
export function validDeliveryPoint(point: DeliveryPoint | null | undefined): point is DeliveryPoint {
  return Boolean(point && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180);
}
export function pinAddress(point: DeliveryPoint, description: string, nearby: DeliveryAddressLocation | null): DeliveryAddressLocation {
  if (!validDeliveryPoint(point) || description.trim().length < 5) throw new Error('Revisa el punto y completa la dirección.');
  // A geocoder names the vicinity; it must never snap the chosen entrance elsewhere.
  return { placeId: nearby?.placeId ?? '', formattedAddress: description.trim(), location: { ...point },
    requiresMapConfirmation: false, selectedOnMap: true };
}
