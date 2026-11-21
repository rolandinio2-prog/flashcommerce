import {
  buildJourney,
  meters,
  validPoint,
  type JourneySample,
} from './driver-journey';

// ~0.001 deg latitude ≈ 111 m
const base = { latitude: -17.78, longitude: -63.18 };
const t0 = Date.parse('2026-11-21T15:00:00Z');
const sample = (
  secondsOffset: number,
  dLat: number,
  accuracy: number | null = 10,
  receivedDelaySeconds = 1,
): JourneySample => ({
  latitude: base.latitude + dLat,
  longitude: base.longitude,
  accuracyMeters: accuracy,
  capturedAt: new Date(t0 + secondsOffset * 1000).toISOString(),
  receivedAt: new Date(
    t0 + (secondsOffset + receivedDelaySeconds) * 1000,
  ).toISOString(),
});

describe('driver journey reconstruction', () => {
  it('measures great-circle distance', () => {
    const d = meters(base, { ...base, latitude: base.latitude + 0.001 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
    expect(meters(base, base)).toBe(0);
  });

  it('validates coordinates', () => {
    expect(validPoint(base)).toBe(true);
    expect(validPoint({ latitude: 91, longitude: 0 })).toBe(false);
    expect(validPoint({ latitude: 0, longitude: NaN })).toBe(false);
  });

  it('accumulates travelled distance along accepted fixes', () => {
    const journey = buildJourney([
      sample(0, 0),
      sample(20, 0.001),
      sample(40, 0.002),
    ]);
    expect(journey.complete).toBe(true);
    expect(journey.rejected).toBe(0);
    expect(journey.segments).toHaveLength(1);
    expect(journey.segments[0]).toHaveLength(3);
    expect(journey.distanceMeters).toBeGreaterThan(220);
    expect(journey.distanceMeters).toBeLessThan(224);
  });

  it('ignores stationary jitter within GPS accuracy', () => {
    const journey = buildJourney([
      sample(0, 0, 10),
      sample(10, 0.00003, 10), // ~3 m
      sample(20, 0.00005, 10), // ~5.5 m from anchor, below the 10 m noise floor
    ]);
    expect(journey.distanceMeters).toBe(0);
    expect(journey.segments[0]).toHaveLength(1);
    expect(journey.latest?.capturedAt).toBe(sample(20, 0).capturedAt);
  });

  it('rejects inaccurate, implausibly fast, out-of-order and late fixes', () => {
    const journey = buildJourney([
      sample(0, 0),
      sample(10, 0.001, 50), // accuracy worse than 35 m
      sample(11, 0.01), // ~1.1 km in 11 s (>40 m/s)
      sample(5, 0.0005), // older than the last accepted fix
      sample(30, 0.0005, 10, 120), // received 2 min after capture
      sample(40, 0.0005, null), // no accuracy
    ]);
    expect(journey.rejected).toBe(5);
    expect(journey.distanceMeters).toBe(0);
  });

  it('starts a new segment after a gap longer than a minute', () => {
    const journey = buildJourney([
      sample(0, 0),
      sample(20, 0.001),
      sample(200, 0.002),
      sample(220, 0.003),
    ]);
    expect(journey.gaps).toBe(1);
    expect(journey.segments).toHaveLength(2);
  });

  it('marks oversized histories as incomplete instead of trusting a partial distance', () => {
    const many = Array.from({ length: 20001 }, (_, i) => sample(i * 2, 0));
    const journey = buildJourney(many);
    expect(journey.complete).toBe(false);
    expect(journey.distanceMeters).toBeNull();
    expect(journey.latest).toBeNull();
  });
});
