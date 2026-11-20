import type { DriverActiveDelivery, DriverMapRoute, DriverSession } from "./flash-api";

type DriverPosition = {
  deliveryId: string;
  latitude: number;
  longitude: number;
  capturedAt: string;
};

// A route response is a snapshot, not the live position of the driver.
export function resolveDriverLocation(
  deliveryId: string | null,
  live: DriverPosition | null,
  route: DriverMapRoute | null,
) {
  const current = live?.deliveryId === deliveryId ? live : null;
  const snapshot = route?.delivery.id === deliveryId ? route.location : null;
  if (!current) return snapshot;
  if (!snapshot) return current;
  return Date.parse(snapshot.capturedAt) > Date.parse(current.capturedAt)
    ? snapshot : current;
}

// Persist only the opt-in and its scope, never coordinates or credentials.
export function readTrackingIntent(
  raw: string | null,
  session: DriverSession,
  deliveries: DriverActiveDelivery[],
): string | null {
  if (!raw || session.driver.passwordChangeRequired || session.driver.status !== "ACTIVE") return null;
  try {
    const intent = JSON.parse(raw);
    if (!intent || intent.tenantCode !== session.tenant.code || intent.driverCode !== session.driver.code) return null;
    return deliveries.some(item =>
      item.delivery.id === intent.deliveryId &&
      item.assignment.status === "ACCEPTED" &&
      ["ACCEPTED", "PICKED_UP", "EN_ROUTE"].includes(item.delivery.status)
    ) ? intent.deliveryId : null;
  } catch {
    return null;
  }
}
