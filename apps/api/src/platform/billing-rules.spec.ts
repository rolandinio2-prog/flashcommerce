import {
  addMonths,
  extendPaidUntil,
  isDate,
  monthlyAmount,
  subscriptionState,
  todayIn,
} from './billing-rules';

describe('billing rules (R4b)', () => {
  it('adds calendar months clamping the day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-15', 2)).toBe('2027-01-15');
    expect(addMonths('2026-12-31', 12)).toBe('2027-12-31');
  });

  it('classifies the subscription by days left (paid_until inclusive)', () => {
    expect(subscriptionState('2026-12-10', '2026-12-01')).toEqual({
      state: 'ACTIVE',
      daysLeft: 9,
    });
    expect(subscriptionState('2026-12-06', '2026-12-01')).toEqual({
      state: 'DUE_SOON',
      daysLeft: 5,
    });
    expect(subscriptionState('2026-12-01', '2026-12-01')).toEqual({
      state: 'DUE_SOON',
      daysLeft: 0,
    });
    expect(subscriptionState('2026-12-01', '2026-12-08')).toEqual({
      state: 'GRACE',
      daysLeft: -7,
    });
    expect(subscriptionState('2026-12-01', '2026-12-09')).toEqual({
      state: 'OVERDUE',
      daysLeft: -8,
    });
  });

  it('extends from paid_until while current, from today once expired', () => {
    expect(extendPaidUntil('2026-12-10', '2026-12-01', 1)).toBe('2027-01-10');
    expect(extendPaidUntil('2026-12-01', '2026-12-01', 3)).toBe('2027-03-01');
    expect(extendPaidUntil('2026-11-20', '2026-12-05', 1)).toBe('2027-01-04');
  });

  it('sums active product prices unless there is an override', () => {
    const prices = { COMMERCE: 150, DELIVERY: 99.5 };
    expect(monthlyAmount(prices, ['COMMERCE', 'DELIVERY'], null)).toBe(249.5);
    expect(monthlyAmount(prices, ['DELIVERY'], null)).toBe(99.5);
    expect(monthlyAmount(prices, ['COMMERCE'], 0)).toBe(0);
  });

  it('validates dates and computes the Bolivian business date', () => {
    expect(isDate('2026-02-29')).toBe(false);
    expect(isDate('2028-02-29')).toBe(true);
    expect(isDate('2026-1-01')).toBe(false);
    // 03:00 UTC is still the previous day in La Paz (UTC-4).
    expect(todayIn('America/La_Paz', new Date('2026-12-02T03:00:00Z'))).toBe(
      '2026-12-01',
    );
  });
});
