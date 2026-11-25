export type DriverPayMode =
  'NONE' | 'FIXED_PER_DELIVERY' | 'PERCENT_OF_FEE' | 'SALARY';

export const DRIVER_PAY_MODES: readonly DriverPayMode[] = [
  'NONE',
  'FIXED_PER_DELIVERY',
  'PERCENT_OF_FEE',
  'SALARY',
];

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Driver pay for a set of completed deliveries (one payout).
 * - FIXED_PER_DELIVERY: pay_value for each delivery.
 * - PERCENT_OF_FEE: pay_value % of each delivery fee (rounded per delivery).
 * - SALARY: pay_value once per payout (the period's salary); deliveries carry 0.
 * - NONE: nothing.
 */
export function driverPay(
  mode: DriverPayMode,
  value: number,
  fees: readonly number[],
): { items: number[]; amount: number } {
  let items: number[];
  switch (mode) {
    case 'FIXED_PER_DELIVERY':
      items = fees.map(() => cents(value));
      break;
    case 'PERCENT_OF_FEE':
      items = fees.map((fee) => cents((fee * value) / 100));
      break;
    default:
      items = fees.map(() => 0);
  }
  const perDelivery = cents(items.reduce((sum, x) => sum + x, 0));
  return { items, amount: mode === 'SALARY' ? cents(value) : perDelivery };
}

/** Validates a YYYY-MM-DD period; returns null when invalid or longer than maxDays. */
export function parsePeriod(
  from: unknown,
  to: unknown,
  maxDays = 92,
): { from: string; to: string } | null {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  if (!re.test(from) || !re.test(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  if (new Date(a).toISOString().slice(0, 10) !== from) return null;
  if (new Date(b).toISOString().slice(0, 10) !== to) return null;
  if ((b - a) / 86_400_000 + 1 > maxDays) return null;
  return { from, to };
}
