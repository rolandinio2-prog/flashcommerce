import type { Identity, TenantContext } from './index.js';
/** DEV session reference is a fixture label, never a production credential. */
export interface AccessRequest extends TenantContext { readonly sessionRef: string }
export interface IdentitySession {
  readonly identity: Identity;
  /** Epoch milliseconds; clock must be injected for deterministic tests. */
  readonly expiresAt: number;
}
export interface IdentitySessionPort {
  getSession(sessionRef: string): Promise<IdentitySession | null>;
}
export interface ResolvedAccess {
  readonly context: TenantContext;
  readonly identity: Identity;
}
/** Server-side boundary: implementations must reject caller-created identities. */
export interface IdentityVerificationPort {
  verify(identity: Identity): Promise<Identity | null>;
}
export interface AccessPolicy {
  readonly ruleId: string;
  readonly tenantId: string;
  readonly role: string;
  readonly action: string;
  /** Exact identifier, or '*' for all resources of the exact action and tenant. */
  readonly resource: string;
  readonly effect: 'allow' | 'deny';
}
export type AccessErrorCode = 'UNAUTHENTICATED' | 'INVALID_SESSION' | 'INVALID_POLICY';
export class AccessError extends Error {
  readonly name = 'AccessError';
  constructor(readonly code: AccessErrorCode, message: string) { super(message); }
}
