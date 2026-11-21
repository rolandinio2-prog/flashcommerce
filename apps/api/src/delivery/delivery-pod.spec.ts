import { deriveDeliveryPod, verifyDeliveryPod } from './delivery-pod';

describe('delivery proof-of-delivery (POD) codes', () => {
  const input = {
    tenantId: 't-1',
    branchId: 'b-1',
    deliveryId: 'd-1',
    deliveryTrackingToken: 'track-1',
  };
  const original = process.env.FLASH_DELIVERY_POD_SECRET;

  beforeEach(() => {
    process.env.FLASH_DELIVERY_POD_SECRET =
      'unit-test-secret-with-at-least-32-chars';
  });
  afterAll(() => {
    if (original === undefined) delete process.env.FLASH_DELIVERY_POD_SECRET;
    else process.env.FLASH_DELIVERY_POD_SECRET = original;
  });

  it('derives a deterministic 4-digit code', () => {
    const pod = deriveDeliveryPod(input);
    expect(pod).toMatch(/^\d{4}$/);
    expect(deriveDeliveryPod(input)).toBe(pod);
  });

  it('binds the code to every input field', () => {
    const pod = deriveDeliveryPod(input);
    const variants = Object.keys(input).map((key) =>
      deriveDeliveryPod({ ...input, [key]: 'other' }),
    );
    // With 10 000 possible codes, all four variants colliding would be a bug.
    expect(variants.filter((v) => v === pod).length).toBeLessThan(4);
  });

  it('depends on the server secret', () => {
    const pod = deriveDeliveryPod(input);
    process.env.FLASH_DELIVERY_POD_SECRET =
      'a-completely-different-secret-value-xx';
    const others = ['d-1', 'd-2', 'd-3'].map((deliveryId) =>
      deriveDeliveryPod({ ...input, deliveryId }),
    );
    expect(others.filter((v) => v === pod).length).toBeLessThan(3);
  });

  it('verifies only the exact code', () => {
    const pod = deriveDeliveryPod(input);
    expect(verifyDeliveryPod(input, pod)).toBe(true);
    const wrong = String((Number(pod) + 1) % 10000).padStart(4, '0');
    expect(verifyDeliveryPod(input, wrong)).toBe(false);
  });

  it.each(['', '123', '12345', 'abcd', '12 3', '１２３４'])(
    'rejects malformed submission %j',
    (submitted) => {
      expect(verifyDeliveryPod(input, submitted)).toBe(false);
    },
  );

  it('fails closed without a strong secret', () => {
    delete process.env.FLASH_DELIVERY_POD_SECRET;
    expect(() => deriveDeliveryPod(input)).toThrow('is required');
    process.env.FLASH_DELIVERY_POD_SECRET = 'too-short';
    expect(() => deriveDeliveryPod(input)).toThrow('at least 32');
  });

  it('spreads codes roughly uniformly (no modulo bias)', () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 2000; i++) {
      const pod = deriveDeliveryPod({ ...input, deliveryId: `d-${i}` });
      buckets[Number(pod[0])]++;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(120);
      expect(count).toBeLessThan(280);
    }
  });
});
