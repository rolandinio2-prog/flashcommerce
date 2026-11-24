import type { Identity, LiveSession, Product, TenantContext } from './index.js';
/** A presentation snapshot, not a media transport or checkout service. */
export interface LiveCommerceView {
  readonly session: LiveSession;
  readonly products: readonly Product[];
}
export interface LiveCommerceReaderPort {
  getLiveSession(context: TenantContext, identity: Identity, sessionId: string): Promise<LiveSession>;
  getProduct(context: TenantContext, identity: Identity, productId: string): Promise<Product>;
}
