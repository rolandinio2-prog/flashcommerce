export type CourierPricingMode = 'ZONE' | 'DISTANCE';

export interface CourierRate {
  pricingMode: CourierPricingMode;
  baseFee: number;
  perKmFee: number;
  minFee: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Fee for one courier delivery. ZONE (or no configured rate) uses the coverage
 * zone fee; DISTANCE = greatest(minFee, baseFee + perKmFee * km).
 */
export function courierFee(
  rate: CourierRate | null,
  zoneFee: number,
  distanceMeters: number,
): number {
  if (!rate || rate.pricingMode === 'ZONE') return round2(zoneFee);
  const km = Math.max(0, distanceMeters) / 1000;
  return round2(Math.max(rate.minFee, rate.baseFee + rate.perKmFee * km));
}

/** Client-specific rate wins over the tenant default; null when none is set. */
export function pickCourierRate<T extends { courierClientId: string | null }>(
  rates: readonly T[],
  courierClientId: string | null,
): T | null {
  return (
    (courierClientId
      ? rates.find((r) => r.courierClientId === courierClientId)
      : undefined) ??
    rates.find((r) => r.courierClientId === null) ??
    null
  );
}
