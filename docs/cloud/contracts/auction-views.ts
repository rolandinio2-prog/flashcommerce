import type { CommerceScopeV1 } from './auction-commerce.js';
import type { AuctionSnapshotV1 } from './auction-lifecycle.js';
export interface AuctionViewerV1 { readonly scope: CommerceScopeV1; readonly role: 'SELLER' | 'BUYER' }
export interface AuctionViewV1 {
  readonly version: '1'; readonly perspective: 'SELLER' | 'BUYER';
  readonly auctionId: string; readonly sessionId: string; readonly productId: string;
  readonly quantity: number; readonly revision: number; readonly status: AuctionSnapshotV1['status'];
  readonly endsAt: number; readonly currency: 'BOB'; readonly startingPriceMinor: number;
  readonly incrementMinor: number; readonly highestAmountMinor: number | null;
  readonly outcome: 'OPEN' | 'AWARDED' | 'WON' | 'NOT_WON' | 'NO_BIDS';
  readonly paymentDeadline: number | null;
}
export interface AuctionViewPortsV1 {
  /** Trusted server identity resolver. A browser cannot supply this object. */
  readonly resolve: (sessionReference: string) => AuctionViewerV1 | null;
  readonly authorize: (viewer: AuctionViewerV1, auctionId: string) => boolean;
  /** Privileged internal read: never forward raw snapshots or evidence to clients. */
  readonly readSnapshot: (scope: CommerceScopeV1, auctionId: string) => AuctionSnapshotV1;
}
