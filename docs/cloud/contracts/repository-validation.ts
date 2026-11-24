import { RepositoryError, assertTenantContext, assertSameTenant } from './index.js';
import type { TenantContext, TenantConfiguration, ModuleRegistryPort, UsageRequest, DeliveryPlanItem } from './index.js';
export function invalid(): never { throw new RepositoryError('INVALID_RECORD', 'Invalid repository record'); }
export function text(value: unknown): string { if (typeof value !== 'string' || !value.length || value.trim() !== value) invalid(); return value; }
export function integer(value: unknown, minimum = 0): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(); return value as number; }
export function nextRevision(value: number): number {
  integer(value, 1);
  if (value === Number.MAX_SAFE_INTEGER) throw new RepositoryError('REVISION_CONFLICT', 'Repository revision exhausted');
  return value + 1;
}
export function expectRevision(expected: number | null, current: number | null): void {
  if (expected !== null) integer(expected, 1);
  if (expected !== current) throw new RepositoryError('REVISION_CONFLICT', 'Repository revision changed');
}
export function scope(context: TenantContext): TenantContext {
  assertTenantContext(context);
  return Object.freeze({ tenantId: context.tenantId, requestId: context.requestId, correlationId: context.correlationId });
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) invalid();
  return result;
}
function identifiers(value: unknown): string[] {
  if (!Array.isArray(value)) invalid();
  const result = value.map(text);
  if (new Set(result).size !== result.length) invalid();
  return result;
}
export function configuration(value: unknown, context: TenantContext, catalogVersion: string, registry: ModuleRegistryPort): TenantConfiguration {
  const row = record(value, ['tenantId', 'manifestCatalogVersion', 'enabledModuleIds', 'entitlements', 'meters']);
  const tenantId = text(row.tenantId); assertSameTenant(context, tenantId);
  if (text(row.manifestCatalogVersion) !== catalogVersion) invalid();
  const enabledModuleIds = identifiers(row.enabledModuleIds);
  try { registry.resolve(enabledModuleIds); } catch { invalid(); }
  const e = record(row.entitlements, ['tenantId', 'features', 'limits']);
  assertSameTenant(context, text(e.tenantId));
  const features = identifiers(e.features);
  if (typeof e.limits !== 'object' || e.limits === null || Array.isArray(e.limits)) invalid();
  const limits = Object.fromEntries(Object.entries(e.limits).map(([key, value]) => [text(key), integer(value)]));
  if (!Array.isArray(row.meters)) invalid();
  const seen = new Set<string>();
  const meters = row.meters.map(value => {
    const meter = record(value, ['limitKey', 'feature']);
    const limitKey = text(meter.limitKey), feature = text(meter.feature);
    if (!Object.hasOwn(limits, limitKey) || seen.has(limitKey)) invalid();
    seen.add(limitKey); return { limitKey, feature };
  });
  return { tenantId, manifestCatalogVersion: catalogVersion, enabledModuleIds, entitlements: { tenantId, features, limits }, meters };
}
export function usage(value: UsageRequest): UsageRequest {
  if (!value) invalid();
  return { feature: text(value.feature), limitKey: text(value.limitKey), amount: integer(value.amount, 1), idempotencyKey: text(value.idempotencyKey) };
}
export function deliveryPlan(value: readonly DeliveryPlanItem[]): DeliveryPlanItem[] {
  if (!Array.isArray(value)) invalid();
  const seen = new Set<string>();
  return value.map((item, index) => {
    const row = record(item, ['subscriberId', 'handlerVersion', 'ordinal']);
    const subscriberId = text(row.subscriberId);
    if (integer(row.ordinal) !== index || seen.has(subscriberId)) invalid();
    seen.add(subscriberId); return { subscriberId, handlerVersion: text(row.handlerVersion), ordinal: index };
  });
}
