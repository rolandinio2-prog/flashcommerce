import type { CloudEventV1, Entitlements, UsageMeter, TenantContext, UsageRequest, UsageConsumption, EntitlementConsumption } from './index.js';
export interface Versioned<T> { readonly revision: number; readonly value: T }
export interface TenantConfiguration {
  readonly tenantId: string;
  readonly manifestCatalogVersion: string;
  readonly enabledModuleIds: readonly string[];
  readonly entitlements: Entitlements;
  readonly meters: readonly UsageMeter[];
}
export interface TenantConfigurationRepository {
  get(context: TenantContext): Promise<Versioned<TenantConfiguration> | null>;
  put(context: TenantContext, command: { readonly expectedRevision: number | null; readonly value: TenantConfiguration }): Promise<Versioned<TenantConfiguration>>;
}
export interface UsageReceipt {
  readonly tenantId: string;
  readonly request: UsageRequest;
  readonly configurationRevision: number;
  readonly result: UsageConsumption;
}
export interface AtomicQuotaRepository {
  getReceipt(context: TenantContext, idempotencyKey: string): Promise<UsageReceipt | null>;
  getUsed(context: TenantContext, limitKey: string): Promise<number>;
  consumeAtRevision(context: TenantContext, command: UsageRequest & { readonly expectedConfigurationRevision: number }): Promise<EntitlementConsumption>;
}
export type JournalState = 'processing' | 'completed' | 'failed' | 'interrupted';
export type DeliveryState = 'pending' | 'running' | 'completed' | 'failed';
export interface DeliveryPlanItem { readonly subscriberId: string; readonly handlerVersion: string; readonly ordinal: number }
export interface EventJournalSnapshot {
  readonly event: CloudEventV1;
  readonly state: JournalState;
  readonly plan: readonly DeliveryPlanItem[];
  readonly deliveries: readonly { readonly subscriberId: string; readonly state: DeliveryState }[];
  readonly delivered: number;
}
export type EventClaim =
  | { readonly outcome: 'new'; readonly snapshot: Versioned<EventJournalSnapshot> }
  | { readonly outcome: 'duplicate'; readonly snapshot: Versioned<EventJournalSnapshot> }
  | { readonly outcome: 'blocked'; readonly snapshot: Versioned<EventJournalSnapshot> };
export interface EventJournalRepository {
  get(context: TenantContext, eventId: string): Promise<Versioned<EventJournalSnapshot> | null>;
  reserve(context: TenantContext, command: { readonly event: CloudEventV1; readonly plan: readonly DeliveryPlanItem[] }): Promise<EventClaim>;
  transitionDelivery(context: TenantContext, command: { readonly eventId: string; readonly expectedRevision: number; readonly subscriberId: string; readonly next: 'running' | 'completed' | 'failed' }): Promise<Versioned<EventJournalSnapshot>>;
  /** Administrative operation; caller must verify the previous executor has stopped. */
  markInterrupted(context: TenantContext, command: { readonly eventId: string; readonly expectedRevision: number }): Promise<Versioned<EventJournalSnapshot>>;
}
export type RepositoryErrorCode = 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'INVALID_RECORD' | 'STORAGE_UNAVAILABLE' | 'OPERATION_INTERRUPTED' | 'NOT_FOUND';
export class RepositoryError extends Error {
  readonly name = 'RepositoryError';
  constructor(readonly code: RepositoryErrorCode, message: string) { super(message); }
}
