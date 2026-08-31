export type GeoShadowEtaProviderId = 'GOOGLE' | 'VALHALLA';

export type GeoShadowEtaSampleStatus = 'SUCCESS' | 'FAILED';

export type GeoShadowEtaComparisonStatus =
  | 'COMPARABLE'
  | 'REFERENCE_FAILED'
  | 'SHADOW_FAILED'
  | 'BOTH_FAILED';

export interface GeoShadowEtaSuccessSample {
  provider: GeoShadowEtaProviderId;
  status: 'SUCCESS';
  distanceMeters: number;
  durationSeconds: number;
  latencyMs: number | null;
}

export interface GeoShadowEtaFailedSample {
  provider: GeoShadowEtaProviderId;
  status: 'FAILED';
  distanceMeters: null;
  durationSeconds: null;
  latencyMs: number | null;
  errorCode: string | null;
}

export type GeoShadowEtaSample =
  | GeoShadowEtaSuccessSample
  | GeoShadowEtaFailedSample;

export interface GeoShadowEtaComparisonInput {
  reference: GeoShadowEtaSample;
  shadow: GeoShadowEtaSample;
}

export interface GeoShadowEtaComparisonResult {
  referenceProvider: GeoShadowEtaProviderId;
  shadowProvider: GeoShadowEtaProviderId;
  referenceStatus: GeoShadowEtaSampleStatus;
  shadowStatus: GeoShadowEtaSampleStatus;
  comparisonStatus: GeoShadowEtaComparisonStatus;
  referenceDistanceMeters: number | null;
  shadowDistanceMeters: number | null;
  distanceDeltaMeters: number | null;
  distanceDeltaPercent: number | null;
  referenceDurationSeconds: number | null;
  shadowDurationSeconds: number | null;
  durationDeltaSeconds: number | null;
  durationDeltaPercent: number | null;
  referenceLatencyMs: number | null;
  shadowLatencyMs: number | null;
  latencyDeltaMs: number | null;
  calculatedAt: string;
}
