/**
 * R4b subscription rules (pure). Dates are YYYY-MM-DD business dates in America/La_Paz.
 * paid_until is inclusive: the business has paid through the end of that day.
 */
export const WARN_DAYS = 5;
export const GRACE_DAYS = 7;
export const BILLING_TIMEZONE = 'America/La_Paz';

export type SubscriptionState = 'ACTIVE' | 'DUE_SOON' | 'GRACE' | 'OVERDUE';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function todayIn(timeZone = BILLING_TIMEZONE, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

const toUtc = (date: string) =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * 86_400_000);
}

/** Days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

/** Calendar months, clamping the day: 2026-01-31 + 1 month = 2026-02-28. */
export function addMonths(date: string, months: number): string {
  const y = +date.slice(0, 4);
  const m = +date.slice(5, 7) - 1 + months;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(+date.slice(8, 10), lastDay);
  return fromUtc(Date.UTC(year, month, day));
}

export function subscriptionState(
  paidUntil: string,
  today: string,
): { state: SubscriptionState; daysLeft: number } {
  const daysLeft = daysBetween(today, paidUntil);
  if (daysLeft > WARN_DAYS) return { state: 'ACTIVE', daysLeft };
  if (daysLeft >= 0) return { state: 'DUE_SOON', daysLeft };
  if (daysLeft >= -GRACE_DAYS) return { state: 'GRACE', daysLeft };
  return { state: 'OVERDUE', daysLeft };
}

/** Monthly amount: the override when set, else the sum of the active products' prices. */
export function monthlyAmount(
  prices: Record<string, number>,
  activeProducts: string[],
  override: number | null,
): number {
  if (override !== null) return override;
  return (
    Math.round(activeProducts.reduce((s, p) => s + (prices[p] ?? 0), 0) * 100) /
    100
  );
}

/**
 * New paid_until after paying `months`. A business still within its paid period extends from
 * paid_until; one that already expired starts over from today (unpaid days are not charged).
 */
export function extendPaidUntil(
  paidUntil: string,
  today: string,
  months: number,
): string {
  if (paidUntil >= today) return addMonths(paidUntil, months);
  return addDays(addMonths(today, months), -1);
}
