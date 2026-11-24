import type { MoneyBOB, OperationResultV1, VerifiedPaymentStateV1 } from './auction-commerce.js';
/** Normalized adapter protocol, not the wire format of FlashCommerce or BCP. */
export interface CommercialResponseValuesV1 {
  reservation: { readonly reservationId: string };
  release: { readonly released: true };
  reservationRecovery: { readonly reservationId: string; readonly state: 'HELD' | 'COMMITTED' | 'RELEASED' };
  order: { readonly orderId: string };
  qr: { readonly paymentId: string; readonly qrPayload: string; readonly expiresAt: number };
  payment: { readonly paymentId: string; readonly status: VerifiedPaymentStateV1 };
  deliveryQuote: { readonly quoteId: string; readonly price: MoneyBOB; readonly expiresAt: number };
  delivery: { readonly deliveryId: string };
  monitor: { readonly deliveryId: string; readonly revision: string; readonly observedAt: number; readonly status: 'PENDING' | 'ASSIGNED' | 'IN_TRANSIT' | 'DELIVERED' | 'INCIDENT' | 'CANCELLED' };
}
export type CommercialResponseKindV1 = keyof CommercialResponseValuesV1;
export interface CommercialResponseBindingV1 {
  readonly tenantId: string; readonly branchId: string; readonly sellerId: string;
  readonly operationId: string; readonly resourceId: string;
}
export interface CommercialResponseExpectationV1<K extends CommercialResponseKindV1> {
  readonly kind: K; readonly binding: CommercialResponseBindingV1;
  /** Server-side requested delivery ID, required for a monitor response. */
  readonly deliveryId?: string;
}
export class CommercialResponseError extends Error {
  constructor(readonly code: 'INVALID_RESPONSE' | 'RESPONSE_MISMATCH') { super(code); }
}
function invalid(): never { throw new CommercialResponseError('INVALID_RESPONSE'); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).length!==keys.length || keys.some(k=>!Object.hasOwn(descriptors,k))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for(const k of keys) { const d=descriptors[k]; if(!d || !('value' in d) || !d.enumerable) invalid(); result[k]=d.value; }
  return result;
}
function string(value: unknown, max=256): string {
  if(typeof value!=='string' || value.length===0 || value.length>max || value.trim()!==value || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function integer(value: unknown, min=0): number { if(typeof value!=='number' || !Number.isSafeInteger(value) || value<min) invalid(); return value; }
function member<T extends string>(value: unknown, values: readonly T[]): T {
  if(typeof value!=='string' || !values.includes(value as T)) invalid(); return value as T;
}
const bindingKeys=['tenantId','branchId','sellerId','operationId','resourceId'] as const;
function binding(value: unknown): CommercialResponseBindingV1 {
  const b=exact(value,bindingKeys);
  return {tenantId:string(b.tenantId),branchId:string(b.branchId),sellerId:string(b.sellerId),operationId:string(b.operationId),resourceId:string(b.resourceId)};
}
function confirmed(kind: CommercialResponseKindV1, value: unknown, expectedDelivery: string | undefined): CommercialResponseValuesV1[CommercialResponseKindV1] {
  switch(kind) {
    case 'reservation': {const v=exact(value,['reservationId']);return {reservationId:string(v.reservationId)};}
    case 'release': {const v=exact(value,['released']);if(v.released!==true) invalid();return {released:true};}
    case 'reservationRecovery': {const v=exact(value,['reservationId','state']);return {reservationId:string(v.reservationId),state:member(v.state,['HELD','COMMITTED','RELEASED'])};}
    case 'order': {const v=exact(value,['orderId']);return {orderId:string(v.orderId)};}
    case 'qr': {const v=exact(value,['paymentId','qrPayload','expiresAt']);return {paymentId:string(v.paymentId),qrPayload:string(v.qrPayload,8192),expiresAt:integer(v.expiresAt)};}
    case 'payment': {const v=exact(value,['paymentId','status']);return {paymentId:string(v.paymentId),status:member(v.status,['PAID','UNPAID_FINAL','PENDING','UNKNOWN'])};}
    case 'deliveryQuote': {const v=exact(value,['quoteId','price','expiresAt']);const p=exact(v.price,['currency','minorUnits']);if(p.currency!=='BOB') invalid();return {quoteId:string(v.quoteId),price:{currency:'BOB',minorUnits:integer(p.minorUnits)},expiresAt:integer(v.expiresAt)};}
    case 'delivery': {const v=exact(value,['deliveryId']);return {deliveryId:string(v.deliveryId)};}
    case 'monitor': {const v=exact(value,['deliveryId','revision','observedAt','status']);const deliveryId=string(v.deliveryId);
      if(deliveryId!==expectedDelivery) throw new CommercialResponseError('RESPONSE_MISMATCH');
      return {deliveryId,revision:string(v.revision),observedAt:integer(v.observedAt),status:member(v.status,['PENDING','ASSIGNED','IN_TRANSIT','DELIVERED','INCIDENT','CANCELLED'])};}
  }
}
/** Reject unknown fields, invalid discriminants and mismatched server bindings.
 * This validates structure/correlation, NOT authenticity, freshness or payment finality.
 * Only parsed JSON/plain data is supported; do not pass executable proxy objects.
 */
export function validateCommercialResponse<K extends CommercialResponseKindV1>(input: unknown, expected: CommercialResponseExpectationV1<K>): OperationResultV1<CommercialResponseValuesV1[K]> {
  const kind=member(expected.kind,['reservation','release','reservationRecovery','order','qr','payment','deliveryQuote','delivery','monitor']);
  const eb=binding(expected.binding);
  if(kind==='monitor') string(expected.deliveryId);
  const outer=exact(input,['version','kind','binding','result']);
  if(outer.version!=='1') invalid();
  if(outer.kind!==kind) throw new CommercialResponseError('RESPONSE_MISMATCH');
  const actual=binding(outer.binding);
  if(bindingKeys.some(k=>actual[k]!==eb[k])) throw new CommercialResponseError('RESPONSE_MISMATCH');
  // Inspect the discriminant without invoking getters.
  if(!outer.result || typeof outer.result!=='object') invalid();
  const descriptor=Object.getOwnPropertyDescriptor(outer.result,'state');
  if(!descriptor || !('value' in descriptor)) invalid();
  const state=member(descriptor.value,['CONFIRMED','PENDING','UNKNOWN','REJECTED']);
  if(state==='CONFIRMED') {
    const r=exact(outer.result,['state','value']);
    return {state,value:confirmed(kind,r.value,expected.deliveryId) as CommercialResponseValuesV1[K]};
  }
  if(state==='REJECTED') {const r=exact(outer.result,['state','code']);return {state,code:member(r.code,['UNAUTHORIZED','UNAVAILABLE','CONFLICT','INVALID'])};}
  const r=exact(outer.result,['state','operationId']);
  if(string(r.operationId)!==eb.operationId) throw new CommercialResponseError('RESPONSE_MISMATCH');
  return {state,operationId:eb.operationId};
}
