import type {
  GeoShadowEtaComparisonInput,
  GeoShadowEtaComparisonResult,
  GeoShadowEtaComparisonStatus,
  GeoShadowEtaProviderId,
  GeoShadowEtaSample,
} from './geo-shadow-eta.types';

const INVALID_INPUT_ERROR = 'GEO_SHADOW_ETA_INVALID_INPUT';

export class GeoShadowEtaCalibrationService {
  compare(input: GeoShadowEtaComparisonInput): GeoShadowEtaComparisonResult {
    this.validateInput(input);

    const reference = input.reference;
    const shadow = input.shadow;
    const bothSucceeded =
      reference.status === 'SUCCESS' && shadow.status === 'SUCCESS';

    const referenceDistanceMeters =
      reference.status === 'SUCCESS' ? reference.distanceMeters : null;
    const shadowDistanceMeters =
      shadow.status === 'SUCCESS' ? shadow.distanceMeters : null;
    const referenceDurationSeconds =
      reference.status === 'SUCCESS' ? reference.durationSeconds : null;
    const shadowDurationSeconds =
      shadow.status === 'SUCCESS' ? shadow.durationSeconds : null;

    const distanceDeltaMeters = bothSucceeded
      ? shadow.distanceMeters - reference.distanceMeters
      : null;
    const durationDeltaSeconds = bothSucceeded
      ? shadow.durationSeconds - reference.durationSeconds
      : null;

    const distanceDeltaPercent =
      bothSucceeded && reference.distanceMeters !== 0
        ? (distanceDeltaMeters! / reference.distanceMeters) * 100
        : null;
    const durationDeltaPercent =
      bothSucceeded && reference.durationSeconds !== 0
        ? (durationDeltaSeconds! / reference.durationSeconds) * 100
        : null;

    const latencyDeltaMs =
      reference.latencyMs !== null && shadow.latencyMs !== null
        ? shadow.latencyMs - reference.latencyMs
        : null;

    return {
      referenceProvider: reference.provider,
      shadowProvider: shadow.provider,
      referenceStatus: reference.status,
      shadowStatus: shadow.status,
      comparisonStatus: this.resolveComparisonStatus(reference, shadow),
      referenceDistanceMeters,
      shadowDistanceMeters,
      distanceDeltaMeters,
      distanceDeltaPercent,
      referenceDurationSeconds,
      shadowDurationSeconds,
      durationDeltaSeconds,
      durationDeltaPercent,
      referenceLatencyMs: reference.latencyMs,
      shadowLatencyMs: shadow.latencyMs,
      latencyDeltaMs,
      calculatedAt: new Date().toISOString(),
    };
  }

  private validateInput(input: GeoShadowEtaComparisonInput): void {
    if (!input || typeof input !== 'object') {
      this.throwInvalidInput();
    }

    this.validateSample(input.reference, 'GOOGLE');
    this.validateSample(input.shadow, 'VALHALLA');
  }

  private validateSample(
    sample: GeoShadowEtaSample,
    expectedProvider: GeoShadowEtaProviderId,
  ): void {
    if (!sample || typeof sample !== 'object') {
      this.throwInvalidInput();
    }

    if (sample.provider !== expectedProvider) {
      this.throwInvalidInput();
    }

    if (!this.isValidLatency(sample.latencyMs)) {
      this.throwInvalidInput();
    }

    if (sample.status === 'SUCCESS') {
      if (
        !this.isFiniteNonNegative(sample.distanceMeters) ||
        !this.isFiniteNonNegative(sample.durationSeconds)
      ) {
        this.throwInvalidInput();
      }

      return;
    }

    if (sample.status === 'FAILED') {
      if (sample.distanceMeters !== null || sample.durationSeconds !== null) {
        this.throwInvalidInput();
      }

      if (sample.errorCode !== null && typeof sample.errorCode !== 'string') {
        this.throwInvalidInput();
      }

      return;
    }

    this.throwInvalidInput();
  }

  private resolveComparisonStatus(
    reference: GeoShadowEtaSample,
    shadow: GeoShadowEtaSample,
  ): GeoShadowEtaComparisonStatus {
    if (reference.status === 'SUCCESS' && shadow.status === 'SUCCESS') {
      return 'COMPARABLE';
    }

    if (reference.status === 'FAILED' && shadow.status === 'FAILED') {
      return 'BOTH_FAILED';
    }

    if (reference.status === 'FAILED') {
      return 'REFERENCE_FAILED';
    }

    return 'SHADOW_FAILED';
  }

  private isFiniteNonNegative(value: unknown): value is number {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0
    );
  }

  private isValidLatency(value: unknown): value is number | null {
    return value === null || this.isFiniteNonNegative(value);
  }

  private throwInvalidInput(): never {
    throw new Error(INVALID_INPUT_ERROR);
  }
}
