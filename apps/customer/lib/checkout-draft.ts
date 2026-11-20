import type { DeliveryAddressLocation, FlashOrderType } from './flash-api';
export const DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
const PREFIX = 'flashcommerce.checkoutDraft:v1:';
export type DraftForm = {
  orderType: FlashOrderType | null; customerName: string; customerPhone: string;
  deliveryAddress: string; selectedDeliveryAddress: DeliveryAddressLocation | null;
  customerNotes: string; scheduledFor: string;
};
export type CheckoutDraft = { version: 1; tenant: string; branch: string; cartToken: string;
  updatedAt: number; form: DraftForm; items: { name: string; quantity: number }[] };
export const draftKey = (tenant: string, branch: string) => PREFIX + tenant + ':' + branch;
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
export function parseDraft(raw: string | null, tenant: string, branch: string, now = Date.now()): CheckoutDraft | null {
  if (!raw || raw.length > 60000) return null;
  try {
    const d = JSON.parse(raw), f = d.form;
    if (d.version !== 1 || d.tenant !== tenant || d.branch !== branch || !text(d.cartToken, 100) || !/^[0-9a-f-]{36}$/i.test(d.cartToken) ||
      !Number.isFinite(d.updatedAt) || d.updatedAt > now + 60000 || now - d.updatedAt > DRAFT_TTL || !f ||
      ![null, 'DINE_IN', 'TAKEAWAY', 'PICKUP', 'DELIVERY'].includes(f.orderType) ||
      !text(f.customerName, 200) || !text(f.customerPhone, 40) || !text(f.deliveryAddress, 512) ||
      !text(f.customerNotes, 2000) || !text(f.scheduledFor, 80) || !Array.isArray(d.items) || d.items.length > 100 ||
      !d.items.every((i: { name: unknown; quantity: number }) => i && text(i.name, 200) && Number.isInteger(i.quantity) && i.quantity > 0 && i.quantity <= 999)) return null;
    const selected = f.selectedDeliveryAddress;
    if (selected !== null && (!selected || !text(selected.formattedAddress, 512) || !text(selected.placeId, 300) ||
      !selected.location || !Number.isFinite(selected.location.latitude) || Math.abs(selected.location.latitude) > 90 ||
      !Number.isFinite(selected.location.longitude) || Math.abs(selected.location.longitude) > 180)) return null;
    // Whitelist fields: no payment, quote, recovery PIN or access credentials in the draft.
    return {version:1,tenant,branch,cartToken:d.cartToken,updatedAt:d.updatedAt,items:d.items.map((i: {name:string;quantity:number})=>({name:i.name,quantity:i.quantity})),form:{
      orderType:f.orderType,customerName:f.customerName,customerPhone:f.customerPhone,deliveryAddress:f.deliveryAddress,
      customerNotes:f.customerNotes,scheduledFor:f.scheduledFor,
      selectedDeliveryAddress:selected ? {placeId:selected.placeId,formattedAddress:selected.formattedAddress,location:{latitude:selected.location.latitude,longitude:selected.location.longitude},selectedOnMap:selected.selectedOnMap===true,requiresMapConfirmation:selected.requiresMapConfirmation===true} : null,
    }};
  } catch { return null; }
}
export function clearCheckoutDraft(storage: Pick<Storage,'removeItem'>, tenant: string, branch: string) {
  try { storage.removeItem(draftKey(tenant,branch)); } catch { /* A completed order must not become a failed submission. */ }
}
export function listDrafts(storage: Pick<Storage,'length'|'key'|'getItem'>): CheckoutDraft[] {
  const drafts: CheckoutDraft[]=[];
  try { for(let i=0;i<storage.length;i++){const key=storage.key(i);const match=key?.match(/^flashcommerce\.checkoutDraft:v1:([A-Za-z0-9_-]{1,80}):([A-Za-z0-9_-]{1,80})$/);if(!key||!match)continue;const draft=parseDraft(storage.getItem(key),match[1],match[2]);if(draft)drafts.push(draft);} } catch { return []; }
  return drafts.sort((a,b)=>b.updatedAt-a.updatedAt);
}
