import { courierFee, pickCourierRate } from './courier-pricing';

describe('courier pricing', () => {
  it('uses the zone fee without a rate or in ZONE mode', () => {
    expect(courierFee(null, 12, 5000)).toBe(12);
    expect(
      courierFee(
        { pricingMode: 'ZONE', baseFee: 5, perKmFee: 3, minFee: 10 },
        12,
        5000,
      ),
    ).toBe(12);
  });

  it('charges base + per km with a minimum in DISTANCE mode', () => {
    const rate = {
      pricingMode: 'DISTANCE' as const,
      baseFee: 5,
      perKmFee: 2.5,
      minFee: 10,
    };
    expect(courierFee(rate, 12, 1000)).toBe(10);
    expect(courierFee(rate, 12, 4300)).toBe(15.75);
  });

  it('prefers the client rate over the tenant default', () => {
    const rates = [
      { courierClientId: null, id: 'default' },
      { courierClientId: 'c1', id: 'client' },
    ];
    expect(pickCourierRate(rates, 'c1')?.id).toBe('client');
    expect(pickCourierRate(rates, 'c2')?.id).toBe('default');
    expect(pickCourierRate(rates, null)?.id).toBe('default');
    expect(pickCourierRate([], 'c1')).toBeNull();
  });
});
