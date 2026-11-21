import { BadRequestException } from '@nestjs/common';

export function scope(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value))
    throw new BadRequestException('Comercio o sucursal inválidos.');
  return value;
}
export function secret(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new BadRequestException('Enlace de recuperación inválido.');
  return value;
}
export function cartToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw new BadRequestException('Carrito inválido.');
  return value;
}
function field(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max)
    throw new BadRequestException('Revisa los datos del borrador.');
  return value;
}
export function draftForm(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Borrador inválido.');
  const f = value as Record<string, unknown>;
  if (
    ![null, 'DINE_IN', 'TAKEAWAY', 'PICKUP', 'DELIVERY'].includes(
      f.orderType as string | null,
    )
  )
    throw new BadRequestException('Modalidad inválida.');
  let selected = null;
  if (f.selectedDeliveryAddress !== null) {
    const a = f.selectedDeliveryAddress as {
      formattedAddress: unknown;
      placeId: unknown;
      location?: { latitude: number; longitude: number };
      selectedOnMap: unknown;
      requiresMapConfirmation: unknown;
    };
    if (
      !a ||
      !a.location ||
      !Number.isFinite(a.location.latitude) ||
      Math.abs(a.location.latitude) > 90 ||
      !Number.isFinite(a.location.longitude) ||
      Math.abs(a.location.longitude) > 180
    )
      throw new BadRequestException('Punto de entrega inválido.');
    selected = {
      formattedAddress: field(a.formattedAddress, 512),
      placeId: field(a.placeId, 300),
      location: {
        latitude: a.location.latitude,
        longitude: a.location.longitude,
      },
      selectedOnMap: a.selectedOnMap === true,
      requiresMapConfirmation: a.requiresMapConfirmation === true,
    };
  }
  // Explicit allowlist; no PIN, quote, table/session, tracking, or payment data.
  return {
    orderType: f.orderType as string | null,
    customerName: field(f.customerName, 200),
    customerPhone: field(f.customerPhone, 40),
    deliveryAddress: field(f.deliveryAddress, 512),
    selectedDeliveryAddress: selected,
    customerNotes: field(f.customerNotes, 2000),
    scheduledFor: field(f.scheduledFor, 80),
  };
}
