import type { EntitlementsPort, TenantContext } from './index.js';
export type FeatureDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: 'FEATURE_DISABLED' };
export interface UsageSnapshot {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}
export interface UsageMeter { readonly limitKey: string; readonly feature: string }
export interface UsageRequest {
  readonly feature: string;
  readonly limitKey: string;
  readonly amount: number;
  readonly idempotencyKey: string;
}
export type UsageConsumption =
  | { readonly allowed: true; readonly usage: UsageSnapshot; readonly replayed: boolean }
  | { readonly allowed: false; readonly reason: 'LIMIT_EXCEEDED'; readonly usage: UsageSnapshot; readonly replayed: boolean };
export type EntitlementConsumption = UsageConsumption | { readonly allowed: false; readonly reason: 'FEATURE_DISABLED' | 'LIMIT_UNDEFINED' | 'METER_UNDEFINED' | 'FEATURE_MISMATCH' };
/** Internal trusted port: limit is supplied by the evaluator, not by a UI. */
export interface UsageCounterPort {
  getUsed(context: TenantContext, limitKey: string): Promise<number>;
  consume(context: TenantContext, command: UsageRequest & { readonly limit: number }): Promise<UsageConsumption>;
}
export interface MeteredEntitlementsPort extends EntitlementsPort {
  checkFeature(context: TenantContext, feature: string): Promise<FeatureDecision>;
  getUsage(context: TenantContext, limitKey: string): Promise<UsageSnapshot>;
  consume(context: TenantContext, request: UsageRequest): Promise<EntitlementConsumption>;
}
export type EntitlementErrorCode = 'INVALID_ENTITLEMENTS' | 'INVALID_METER' | 'INVALID_USAGE' | 'LIMIT_UNDEFINED' | 'IDEMPOTENCY_CONFLICT';
export class EntitlementError extends Error {
  readonly name = 'EntitlementError';
  constructor(readonly code: EntitlementErrorCode, message: string) { super(message); }
}
