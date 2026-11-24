import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { type GeoPoint } from './geo.types';
import {
  type DeliveryCheckoutRouteSnapshot,
  type DeliveryQuoteResponse,
} from './delivery.types';
import { DeliveryBranchRow, DeliveryZoneRow } from './delivery-internal.types';

export function trackingBranchOrigin(row: {
  branch_name: string;
  branch_latitude: string | null;
  branch_longitude: string | null;
}) {
  if (
    row.branch_latitude == null ||
    row.branch_longitude == null ||
    row.branch_latitude.trim() === '' ||
    row.branch_longitude.trim() === ''
  )
    return null;
  const latitude = Number(row.branch_latitude),
    longitude = Number(row.branch_longitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  return { name: row.branch_name, latitude, longitude };
}

export function requireDeliveryBranchOrigin(
  branch: DeliveryBranchRow,
): GeoPoint {
  const latitudeValue = branch.delivery_origin_latitude;

  const longitudeValue = branch.delivery_origin_longitude;

  if (latitudeValue === null || longitudeValue === null) {
    throw new ServiceUnavailableException(
      'Delivery branch origin coordinates are not configured',
    );
  }

  const latitude = Number(latitudeValue);

  const longitude = Number(longitudeValue);

  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new ServiceUnavailableException(
      'Delivery branch origin coordinates are invalid',
    );
  }

  return {
    latitude,
    longitude,
  };
}

export function validateDeliveryRouteMetrics(
  distanceMeters: number,
  durationSeconds: number,
): void {
  if (
    !Number.isSafeInteger(distanceMeters) ||
    distanceMeters < 0 ||
    distanceMeters > 2147483647
  ) {
    throw new ServiceUnavailableException('Delivery route distance is invalid');
  }

  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0) {
    throw new ServiceUnavailableException('Delivery route duration is invalid');
  }
}

export function requireCurrentDeliveryRouteSnapshot(
  snapshot: DeliveryCheckoutRouteSnapshot,
  branch: DeliveryBranchRow,
  latitude: number,
  longitude: number,
): DeliveryCheckoutRouteSnapshot {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new ConflictException('Delivery route snapshot is missing');
  }

  if (
    snapshot.tenantId !== branch.tenant_id ||
    snapshot.branchId !== branch.branch_id
  ) {
    throw new ConflictException(
      'Delivery route snapshot belongs to another branch',
    );
  }

  const origin = requireDeliveryBranchOrigin(branch);

  if (
    snapshot.origin.latitude !== origin.latitude ||
    snapshot.origin.longitude !== origin.longitude
  ) {
    throw new ConflictException(
      'Delivery route snapshot is stale; branch origin changed',
    );
  }

  if (
    snapshot.destination.latitude !== latitude ||
    snapshot.destination.longitude !== longitude
  ) {
    throw new ConflictException('Delivery route snapshot destination changed');
  }

  validateDeliveryRouteMetrics(
    snapshot.distanceMeters,
    snapshot.durationSeconds,
  );

  return snapshot;
}
export function buildRouteAwareEta(
  branch: DeliveryBranchRow,
  zone: DeliveryZoneRow,
  durationSeconds: number,
): {
  minMinutes: number;
  maxMinutes: number;
} {
  const prepMinutes = branch.delivery_default_prep_minutes;

  if (
    !Number.isSafeInteger(prepMinutes) ||
    prepMinutes < 0 ||
    prepMinutes > 480
  ) {
    throw new ServiceUnavailableException(
      'Delivery branch preparation time is invalid',
    );
  }

  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0) {
    throw new ServiceUnavailableException('Delivery route duration is invalid');
  }

  if (
    !Number.isSafeInteger(zone.eta_min_minutes) ||
    !Number.isSafeInteger(zone.eta_max_minutes) ||
    zone.eta_min_minutes < 1 ||
    zone.eta_max_minutes < zone.eta_min_minutes ||
    zone.eta_max_minutes > 480
  ) {
    throw new ServiceUnavailableException(
      'Delivery zone ETA configuration is invalid',
    );
  }

  const travelMinutes = Math.max(1, Math.ceil(durationSeconds / 60));

  const routeReadyMinutes = prepMinutes + travelMinutes;

  const minMinutes = Math.max(zone.eta_min_minutes, routeReadyMinutes);

  const maxMinutes = Math.max(zone.eta_max_minutes, minMinutes);

  if (
    !Number.isSafeInteger(minMinutes) ||
    !Number.isSafeInteger(maxMinutes) ||
    minMinutes > 480 ||
    maxMinutes > 480
  ) {
    throw new ServiceUnavailableException(
      'Calculated delivery ETA exceeds supported range',
    );
  }

  return {
    minMinutes,
    maxMinutes,
  };
}
export function buildUnavailableResponse(
  branch: DeliveryBranchRow,
  reason: 'DELIVERY_DISABLED' | 'OUTSIDE_DELIVERY_AREA',
): DeliveryQuoteResponse {
  return {
    available: false,
    reason,

    branch: {
      code: branch.branch_code,
      name: branch.branch_name,
    },

    zone: null,

    deliveryFee: null,
    minimumOrder: null,
    minimumOrderMissing: null,

    eta: null,
    route: null,
  };
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} is required`);
  }

  const normalized = value.trim().toLowerCase();

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      normalized,
    )
  ) {
    throw new BadRequestException(`${field} is invalid`);
  }

  return normalized;
}

export function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return requireUuid(value, field);
}
export function requireCode(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} is required`);
  }

  const normalized = value.trim();

  if (
    normalized.length < 2 ||
    normalized.length > 40 ||
    !/^[A-Za-z0-9_-]+$/.test(normalized)
  ) {
    throw new BadRequestException(`${field} is invalid`);
  }

  return normalized;
}

export function requireCoordinate(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new BadRequestException(`${field} is invalid`);
  }

  return value;
}

export function requireSubtotal(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 999_999_999.99
  ) {
    throw new BadRequestException('subtotal is invalid');
  }

  return roundMoney(value);
}

export function databaseMoneyToNumber(value: string, field: string): number {
  const normalized = Number(value);

  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid ${field} stored in database`);
  }

  return roundMoney(normalized);
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
