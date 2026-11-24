import type { AuctionRulesV1, FrozenAuctionRulesV1, AwardV1, CommerceScopeV1 } from './auction-commerce.js';
/** DEV-only lifecycle. Authorization and clock are injected server dependencies. */
export type AuctionActionV1 = 'START' | 'BID' | 'CLOSE' | 'READ';
export interface AuctionCommandV1 { readonly scope: CommerceScopeV1; readonly operationId: string }
export interface StartAuctionV1 extends AuctionCommandV1 {
  readonly auctionId: string; readonly sessionId: string; readonly productId: string;
  readonly quantity: number; readonly endsAt: number; readonly rules: AuctionRulesV1;
}
export interface BidAuctionV1 extends AuctionCommandV1 { readonly auctionId: string; readonly amountMinor: number }
export interface CloseAuctionV1 extends AuctionCommandV1 { readonly auctionId: string }
export interface AcceptedBidV1 { readonly actorId: string; readonly amountMinor: number; readonly occurredAt: number; readonly operationId: string }
export interface AuctionSnapshotV1 {
  readonly tenantId: string; readonly branchId: string; readonly sellerId: string;
  readonly auctionId: string; readonly sessionId: string; readonly productId: string;
  readonly quantity: number; readonly startedAt: number; readonly endsAt: number;
  readonly rules: FrozenAuctionRulesV1; readonly revision: number;
  readonly status: 'ACTIVE' | 'AWARDED' | 'CLOSED_NO_BIDS';
  readonly highestBid: AcceptedBidV1 | null; readonly award: AwardV1 | null;
}
export interface LifecycleEvidenceV1 {
  readonly version: '1'; readonly eventId: string; readonly sequence: number;
  readonly auctionId: string; readonly scope: CommerceScopeV1; readonly operationId: string;
  readonly occurredAt: number;
  readonly kind: 'STARTED' | 'BID_ACCEPTED' | 'BID_REJECTED' | 'CLOSED';
  readonly code: string; readonly amountMinor: number | null;
  readonly snapshot: AuctionSnapshotV1;
}
export interface AuctionMutationV1 {
  readonly accepted: boolean; readonly code: string; readonly snapshot: AuctionSnapshotV1;
}
export interface AuctionLifecyclePortsV1 {
  readonly now: () => number;
  readonly authorize: (scope: CommerceScopeV1, action: AuctionActionV1, auctionId: string) => boolean;
  /** Test-only failure injection before atomic publication; not a durable audit sink. */
  readonly beforeCommit?: () => void;
}
