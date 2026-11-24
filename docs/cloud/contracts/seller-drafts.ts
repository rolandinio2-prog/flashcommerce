import { RepositoryError, assertSameTenant, repositoryValidation as v } from './index.js';
import type { Identity, TenantContext, Versioned } from './index.js';
export const SELLER_DRAFT_ID = 'commerce-live' as const;
export const SELLER_DRAFT_RESOURCE = 'seller-draft:commerce-live' as const;
export interface SellerDraftContentV1 {
  readonly contractVersion: '1.0';
  readonly title: string;
  readonly selectedProductIds: readonly string[];
  readonly featuredProductId: string | null;
}
export interface SellerDraftKey { readonly ownerSubjectId: string; readonly draftId: string }
export interface SellerDraftV1 extends SellerDraftKey { readonly tenantId: string; readonly content: SellerDraftContentV1 }
export interface SellerDraftPut extends SellerDraftKey { readonly expectedRevision: number | null; readonly content: SellerDraftContentV1 }
/** Internal repository. Callers must enforce verified ownership before constructing a key. */
export interface SellerDraftRepository {
  get(context: TenantContext, key: SellerDraftKey): Promise<Versioned<SellerDraftV1> | null>;
  put(context: TenantContext, command: SellerDraftPut): Promise<Versioned<SellerDraftV1>>;
}
export interface SellerDraftSave { readonly expectedRevision: number | null; readonly content: SellerDraftContentV1 }
export interface SellerDraftAvailabilityIssue { readonly productId: string; readonly reason: 'missing' | 'inactive' | 'unavailable' }
export interface SellerDraftLoadResultV1 {
  readonly draft: Versioned<SellerDraftV1> | null;
  readonly availabilityCheck: 'complete' | 'unavailable';
  readonly unavailableReferences: readonly SellerDraftAvailabilityIssue[];
  readonly canApply: boolean;
}
export interface SellerDraftPort {
  load(context: TenantContext, identity: Identity): Promise<SellerDraftLoadResultV1>;
  save(context: TenantContext, identity: Identity, command: SellerDraftSave): Promise<Versioned<SellerDraftV1>>;
}
export type SellerDraftValidationErrorCode = 'PRODUCTS_UNAVAILABLE' | 'CATALOG_UNAVAILABLE';
export class SellerDraftValidationError extends Error {
  readonly name = 'SellerDraftValidationError';
  readonly issues: readonly SellerDraftAvailabilityIssue[];
  constructor(readonly code: SellerDraftValidationErrorCode, issues: readonly SellerDraftAvailabilityIssue[]) {
    super('Draft product references require review');
    this.issues = Object.freeze(issues.map(issue => Object.freeze({ productId: issue.productId, reason: issue.reason })));
  }
}
function invalid(): never { throw new RepositoryError('INVALID_RECORD', 'Invalid seller draft record'); }
export function sellerDraftObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) invalid();
  return record;
}
/** Pure validator: owns the returned array and normalizes only user-entered title. */
export function validateSellerDraftContent(value: unknown): SellerDraftContentV1 {
  const row = sellerDraftObject(value, ['contractVersion', 'title', 'selectedProductIds', 'featuredProductId']);
  if (row.contractVersion !== '1.0' || typeof row.title !== 'string') invalid();
  const title = row.title.trim(); if (!title.length || title.length > 100) invalid();
  if (!Array.isArray(row.selectedProductIds) || row.selectedProductIds.length > 50) invalid();
  const selection = row.selectedProductIds;
  const selectedProductIds = Array.from({ length: selection.length }, (_, index) => v.text(selection[index]));
  if (new Set(selectedProductIds).size !== selectedProductIds.length) invalid();
  const featuredProductId = row.featuredProductId === null ? null : v.text(row.featuredProductId);
  if (featuredProductId !== null && !selectedProductIds.includes(featuredProductId)) invalid();
  return { contractVersion: '1.0', title, selectedProductIds, featuredProductId };
}
export function validateSellerDraftKey(value: unknown): SellerDraftKey {
  const row = sellerDraftObject(value, ['ownerSubjectId', 'draftId']);
  return { ownerSubjectId: v.text(row.ownerSubjectId), draftId: v.text(row.draftId) };
}
export function validateSellerDraftSave(value: unknown): SellerDraftSave {
  const row = sellerDraftObject(value, ['expectedRevision', 'content']);
  const expectedRevision = row.expectedRevision === null ? null : v.integer(row.expectedRevision, 1);
  if (expectedRevision !== null) v.nextRevision(expectedRevision);
  return { expectedRevision, content: validateSellerDraftContent(row.content) };
}
export function validateSellerDraftRecord(value: unknown, context: TenantContext, key: SellerDraftKey): Versioned<SellerDraftV1> {
  const envelope = sellerDraftObject(value, ['revision', 'value']);
  const row = sellerDraftObject(envelope.value, ['tenantId', 'ownerSubjectId', 'draftId', 'content']);
  const tenantId = v.text(row.tenantId); assertSameTenant(context, tenantId);
  const ownerSubjectId = v.text(row.ownerSubjectId), draftId = v.text(row.draftId);
  if (ownerSubjectId !== key.ownerSubjectId || draftId !== key.draftId) invalid();
  const content = validateSellerDraftContent(row.content);
  if ((row.content as Record<string, unknown>).title !== content.title) invalid();
  return { revision: v.integer(envelope.revision, 1), value: { tenantId, ownerSubjectId, draftId, content } };
}
