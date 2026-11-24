import type { TenantContext } from './index.js';
/** Untrusted decoded payloads, never internal FlashCommerce imports. null means absent. */
export interface CatalogSourcePort {
  fetchProduct(context: TenantContext, productId: string): Promise<unknown | null>;
}
export interface LiveSessionSourcePort {
  fetchSession(context: TenantContext, sessionId: string): Promise<unknown | null>;
}
export type AdapterErrorCode = 'INVALID_SOURCE_PAYLOAD' | 'UNSUPPORTED_SOURCE_VERSION' | 'SOURCE_UNAVAILABLE' | 'DUPLICATE_FIXTURE';
export class AdapterError extends Error {
  readonly name = 'AdapterError';
  constructor(readonly code: AdapterErrorCode, message: string) { super(message); }
}
