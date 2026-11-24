/** Proposed CommerceCloud V1 ports, not verified FlashCommerce HTTP contracts.
 * Context, clock and commercial outcomes must come from trusted server adapters.
 */
export interface CommerceScopeV1 {
  readonly tenantId: string;
  readonly branchId: string;
  readonly sellerId: string;
  readonly actorId: string;
  readonly correlationId: string;
}
export interface MoneyBOB { readonly currency: 'BOB'; readonly minorUnits: number }
export interface AuctionRulesV1 {
  readonly version: '1';
  readonly policyRevision: string;
  readonly paymentWindowMinutes: number;
  readonly startingPrice: MoneyBOB;
  readonly increment: MoneyBOB;
  readonly extension: 'NONE';
}
export interface FrozenAuctionRulesV1 extends AuctionRulesV1 { readonly frozenAt: number }
export interface AwardV1 {
  readonly scope: CommerceScopeV1;
  readonly auctionId: string;
  readonly sessionId: string;
  readonly awardId: string;
  readonly winnerId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly price: MoneyBOB;
  readonly awardedAt: number;
  readonly paymentDeadline: number;
  readonly rules: FrozenAuctionRulesV1;
}
export type OperationResultV1<T> =
  | { readonly state: 'CONFIRMED'; readonly value: T }
  | { readonly state: 'PENDING' | 'UNKNOWN'; readonly operationId: string }
  | { readonly state: 'REJECTED'; readonly code: 'UNAUTHORIZED' | 'UNAVAILABLE' | 'CONFLICT' | 'INVALID' };
export interface CommercialCommandV1 {
  readonly scope: CommerceScopeV1;
  readonly operationId: string;
  readonly idempotencyKey: string;
}
export interface StockReservationPortV1 {
  reserve(command: CommercialCommandV1 & { readonly award: AwardV1 }): Promise<OperationResultV1<{ readonly reservationId: string }>>;
  release(command: CommercialCommandV1 & { readonly reservationId: string }): Promise<OperationResultV1<{ readonly released: true }>>;
  recover(scope: CommerceScopeV1, operationId: string): Promise<OperationResultV1<{ readonly reservationId: string; readonly state: 'HELD' | 'COMMITTED' | 'RELEASED' }>>;
}
export interface AwardOrderPortV1 {
  create(command: CommercialCommandV1 & { readonly award: AwardV1; readonly reservationId: string }): Promise<OperationResultV1<{ readonly orderId: string }>>;
  recover(scope: CommerceScopeV1, operationId: string): Promise<OperationResultV1<{ readonly orderId: string }>>;
}
export type VerifiedPaymentStateV1 = 'PAID' | 'UNPAID_FINAL' | 'PENDING' | 'UNKNOWN';
export interface QrPaymentPortV1 {
  create(command: CommercialCommandV1 & { readonly orderId: string }): Promise<OperationResultV1<{ readonly paymentId: string; readonly qrPayload: string; readonly expiresAt: number }>>;
  /** May reconcile/write externally. Never classify this as a read-only probe. */
  reconcile(scope: CommerceScopeV1, operationId: string): Promise<OperationResultV1<{ readonly paymentId: string; readonly status: VerifiedPaymentStateV1 }>>;
}
export interface DeliveryPortV1 {
  quote(scope: CommerceScopeV1, orderId: string): Promise<OperationResultV1<{ readonly quoteId: string; readonly price: MoneyBOB; readonly expiresAt: number }>>;
  request(command: CommercialCommandV1 & { readonly orderId: string; readonly quoteId: string }): Promise<OperationResultV1<{ readonly deliveryId: string }>>;
}
export interface DeliveryMonitorPortV1 {
  getSnapshot(scope: CommerceScopeV1, deliveryId: string): Promise<OperationResultV1<{
    readonly deliveryId: string;
    readonly revision: string;
    readonly observedAt: number;
    readonly status: 'PENDING' | 'ASSIGNED' | 'IN_TRANSIT' | 'DELIVERED' | 'INCIDENT' | 'CANCELLED';
  }>>;
}
export interface AuctionEvidenceV1 {
  readonly version: '1';
  readonly eventId: string;
  readonly auctionId: string;
  readonly sequence: number;
  readonly scope: CommerceScopeV1;
  readonly occurredAt: number;
  readonly kind: 'RULES_FROZEN' | 'STARTED' | 'BID_ACCEPTED' | 'BID_REJECTED' | 'AWARDED' | 'PAYMENT_OBSERVED' | 'RELEASED' | 'CORRECTION';
  readonly outcomeCode: string;
  readonly correctionOf: string | null;
}
/** State and evidence must commit atomically; durable implementation pending.
 * No update/delete API. This interface alone does not make storage immutable.
 */
export interface AuctionCommitPortV1 {
  append(command: CommercialCommandV1 & {
    readonly auctionId: string;
    readonly expectedRevision: number;
    readonly nextState: 'ACTIVE' | 'AWARDED' | 'RECONCILING' | 'PAID' | 'ELIGIBLE_FOR_REAUCTION' | 'CLOSED';
    readonly evidence: readonly AuctionEvidenceV1[];
  }): Promise<OperationResultV1<{ readonly revision: number }>>;
}
export class AuctionRuleError extends Error {
  constructor(readonly code: 'INVALID_RULES' | 'INVALID_TIME' | 'INVALID_AMOUNT') { super(code); }
}
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function timestamp(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
export function validateMoneyBOB(value: MoneyBOB): void {
  if (!value || value.currency !== 'BOB' || !positive(value.minorUnits)) throw new AuctionRuleError('INVALID_AMOUNT');
}
/** Technical bounds only; commercial min/max duration remains undecided. */
export function freezeAuctionRules(rules: AuctionRulesV1, frozenAt: number): FrozenAuctionRulesV1 {
  if (!rules || rules.version !== '1' || rules.extension !== 'NONE' ||
      typeof rules.policyRevision !== 'string' || !rules.policyRevision.trim() ||
      !positive(rules.paymentWindowMinutes) || !Number.isSafeInteger(rules.paymentWindowMinutes * 60_000)) {
    throw new AuctionRuleError('INVALID_RULES');
  }
  if (!timestamp(frozenAt)) throw new AuctionRuleError('INVALID_TIME');
  validateMoneyBOB(rules.startingPrice); validateMoneyBOB(rules.increment);
  return Object.freeze({ version: '1', policyRevision: rules.policyRevision,
    paymentWindowMinutes: rules.paymentWindowMinutes, extension: 'NONE', frozenAt,
    startingPrice: Object.freeze({ currency: 'BOB', minorUnits: rules.startingPrice.minorUnits }),
    increment: Object.freeze({ currency: 'BOB', minorUnits: rules.increment.minorUnits }) });
}
export function awardPaymentDeadline(rules: FrozenAuctionRulesV1, awardedAt: number): number {
  const checked = freezeAuctionRules(rules, rules.frozenAt);
  const deadline = awardedAt + checked.paymentWindowMinutes * 60_000;
  if (!timestamp(awardedAt) || awardedAt < checked.frozenAt || !timestamp(deadline)) throw new AuctionRuleError('INVALID_TIME');
  return deadline;
}
/** Eligibility is not an instruction to start a new auction or award a second bidder.
 * At the exact deadline, await reconciliation; provider boundary rules remain pending.
 */
export function decideAwardSettlement(input: {
  readonly now: number; readonly deadline: number;
  readonly payment: VerifiedPaymentStateV1; readonly release: 'CONFIRMED' | 'PENDING' | 'UNKNOWN';
}): 'PAID' | 'WAITING' | 'RECONCILE' | 'RELEASE_REQUIRED' | 'ELIGIBLE_FOR_REAUCTION' {
  if (!timestamp(input.now) || !timestamp(input.deadline)) throw new AuctionRuleError('INVALID_TIME');
  if (input.payment === 'PAID') return 'PAID';
  if (input.payment === 'UNKNOWN') return 'RECONCILE';
  if (input.now < input.deadline) return 'WAITING';
  if (input.now === input.deadline || input.payment !== 'UNPAID_FINAL') return 'RECONCILE';
  return input.release === 'CONFIRMED' ? 'ELIGIBLE_FOR_REAUCTION' : 'RELEASE_REQUIRED';
}
