/** Public contracts V1. No infrastructure or commercial service implementation. */
export const CONTRACT_VERSION = '1.0' as const;
export type ContractVersion = typeof CONTRACT_VERSION;
export type TenantId = string;
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly requestId: string;
  readonly correlationId: string;
}
export interface Identity {
  readonly subjectId: string;
  readonly tenantId: TenantId;
  readonly kind: 'user' | 'service';
  readonly roles: readonly string[];
}
export interface AuthorizationRequest {
  readonly context: TenantContext;
  readonly identity: Identity;
  readonly action: string;
  readonly resource: string;
}
export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };
export interface AuthorizationPort {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}
export interface Entitlements {
  readonly tenantId: TenantId;
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
}
export interface EntitlementsPort {
  get(context: TenantContext): Promise<Entitlements>;
}
export interface ModuleManifest {
  readonly contractVersion: ContractVersion;
  readonly moduleId: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly requires: readonly string[];
}
export interface Product {
  readonly productId: string;
  readonly tenantId: TenantId;
  readonly title: string;
  readonly status: 'active' | 'inactive';
}
export interface ProductCatalogPort {
  getProduct(context: TenantContext, productId: string): Promise<Product>;
}
export interface LiveSession {
  readonly sessionId: string;
  readonly tenantId: TenantId;
  readonly title: string;
  readonly status: 'scheduled' | 'live' | 'ended';
  readonly productIds: readonly string[];
}
export interface FlashLivePort {
  getSession(context: TenantContext, sessionId: string): Promise<LiveSession>;
}
export type CloudErrorCode = 'INVALID_ARGUMENT' | 'TENANT_MISMATCH' | 'NOT_FOUND' | 'FORBIDDEN' | 'ENTITLEMENT_REQUIRED';
export class CloudError extends Error {
  readonly name = 'CloudError';
  constructor(readonly code: CloudErrorCode, message: string, readonly requestId?: string) {
    super(message);
  }
}
export interface CloudEvent<TType extends string, TData> {
  readonly contractVersion: ContractVersion;
  readonly eventVersion: 1;
  readonly eventId: string;
  readonly type: TType;
  /** ISO 8601 UTC timestamp. */
  readonly occurredAt: string;
  readonly context: TenantContext;
  readonly data: TData;
}
export type LiveSessionStartedV1 = CloudEvent<'flashlive.session.started.v1', { readonly sessionId: string }>;
export type ProductUpdatedV1 = CloudEvent<'catalog.product.updated.v1', { readonly productId: string }>;
export type CloudEventV1 = LiveSessionStartedV1 | ProductUpdatedV1;

/** Validate tenant context at adapter boundaries; never accepts blank identifiers. */
export function assertTenantContext(context: TenantContext): void {
  if (!context || [context.tenantId, context.requestId, context.correlationId].some(value => typeof value !== 'string' || !value.trim())) {
    throw new CloudError('INVALID_ARGUMENT', 'Tenant context requires nonempty identifiers');
  }
}
export function assertSameTenant(context: TenantContext, tenantId: TenantId): void {
  assertTenantContext(context);
  if (context.tenantId !== tenantId) throw new CloudError('TENANT_MISMATCH', 'Tenant boundary violation', context.requestId);
}

export { ModuleRegistryError } from './module-registry.js';
export type { ModuleRegistryErrorCode, ModuleRegistryPort, TenantModulesPort } from './module-registry.js';
export type { LiveCommerceView, LiveCommerceReaderPort } from './live-commerce.js';
export { AccessError } from './access.js';
export type { AccessErrorCode, AccessRequest, IdentitySession, IdentitySessionPort, ResolvedAccess, IdentityVerificationPort, AccessPolicy } from './access.js';
export { EntitlementError } from './entitlement-usage.js';
export type { EntitlementErrorCode, FeatureDecision, UsageSnapshot, UsageMeter, UsageRequest, UsageConsumption, EntitlementConsumption, UsageCounterPort, MeteredEntitlementsPort } from './entitlement-usage.js';
export { EventError } from './event-bus.js';
export type { EventErrorCode, CloudEventTypeV1, CloudEventHandler, EventSubscription, EventPublication, EventBusPort } from './event-bus.js';
export { AdapterError } from './source-ports.js';
export type { AdapterErrorCode, CatalogSourcePort, LiveSessionSourcePort } from './source-ports.js';
export { RepositoryError } from './repositories.js';
export type { RepositoryErrorCode, Versioned, TenantConfiguration, TenantConfigurationRepository, UsageReceipt, AtomicQuotaRepository, JournalState, DeliveryState, DeliveryPlanItem, EventJournalSnapshot, EventClaim, EventJournalRepository } from './repositories.js';
export * as repositoryValidation from './repository-validation.js';
export { SELLER_DRAFT_ID, SELLER_DRAFT_RESOURCE, SellerDraftValidationError, sellerDraftObject, validateSellerDraftContent, validateSellerDraftKey, validateSellerDraftSave, validateSellerDraftRecord } from './seller-drafts.js';
export type { SellerDraftContentV1, SellerDraftKey, SellerDraftV1, SellerDraftPut, SellerDraftRepository, SellerDraftSave, SellerDraftAvailabilityIssue, SellerDraftLoadResultV1, SellerDraftPort, SellerDraftValidationErrorCode } from './seller-drafts.js';

export * from './auction-commerce.js';
export type { AuctionActionV1, AuctionCommandV1, StartAuctionV1, BidAuctionV1, CloseAuctionV1, AcceptedBidV1, AuctionSnapshotV1, LifecycleEvidenceV1, AuctionMutationV1, AuctionLifecyclePortsV1 } from './auction-lifecycle.js';
export { validateCommercialResponse, CommercialResponseError } from './commercial-responses.js';
export type { CommercialResponseValuesV1, CommercialResponseKindV1, CommercialResponseBindingV1, CommercialResponseExpectationV1 } from './commercial-responses.js';
export type { AuctionViewerV1, AuctionViewV1, AuctionViewPortsV1 } from './auction-views.js';
