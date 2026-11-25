import { driverPay, parsePeriod } from './courier-settlement';

describe('driverPay', () => {
  it('pays a fixed amount per delivery', () => {
    expect(driverPay('FIXED_PER_DELIVERY', 6, [10, 15, 9])).toEqual({
      items: [6, 6, 6],
      amount: 18,
    });
  });

  it('pays a percentage of each fee, rounded per delivery', () => {
    expect(driverPay('PERCENT_OF_FEE', 33.33, [10, 15])).toEqual({
      items: [3.33, 5],
      amount: 8.33,
    });
  });

  it('pays the salary once, whatever the number of deliveries', () => {
    expect(driverPay('SALARY', 2500, [10, 15])).toEqual({
      items: [0, 0],
      amount: 2500,
    });
    expect(driverPay('SALARY', 2500, []).amount).toBe(2500);
  });

  it('pays nothing without a rule', () => {
    expect(driverPay('NONE', 99, [10])).toEqual({ items: [0], amount: 0 });
  });
});

describe('parsePeriod', () => {
  it('accepts a valid range', () => {
    expect(parsePeriod('2026-11-01', '2026-11-30')).toEqual({
      from: '2026-11-01',
      to: '2026-11-30',
    });
  });

  it('rejects reversed, malformed, impossible or too long ranges', () => {
    expect(parsePeriod('2026-11-30', '2026-11-01')).toBeNull();
    expect(parsePeriod('2026-11-1', '2026-11-30')).toBeNull();
    expect(parsePeriod('2026-02-30', '2026-03-01')).toBeNull();
    expect(parsePeriod('2026-01-01', '2026-12-31')).toBeNull();
    expect(parsePeriod(undefined, '2026-11-01')).toBeNull();
  });
});
