import { apiRequest,type FlashCart,type CreatedOrder,type OrderPaymentResponse,type CreateQrPaymentResponse } from './flash-api';
export interface PosProduct {id:string;name:string;sku:string|null;price:number;currency:string;imageUrl:string|null;available:boolean;availableQuantity:number|null;hasPresentations:boolean;presentationParentId:string|null;presentationLabel:string|null;garnishParentId:string|null;}
export interface PosCatalog {categories:{id:string;name:string;slug:string;products:PosProduct[]}[];}
const base='/api/v1/ops/pos';
export const posCatalog=()=>apiRequest<PosCatalog>(base+'/catalog',{cache:'no-store'});
export const posCurrent=()=>apiRequest<{cart:FlashCart|null;order:CreatedOrder|null}>(base+'/current',{cache:'no-store'});
export const posNew=(requestId:string)=>apiRequest<FlashCart>(base+'/drafts',{method:'POST',body:JSON.stringify({requestId})});
export const posItem=(token:string,action:'add'|'set'|'remove',item:{productId:string;quantity:number;riceChoice?:string})=>apiRequest<FlashCart>(base+'/drafts/'+encodeURIComponent(token)+'/items/'+action,{method:'POST',body:JSON.stringify(item)});
export const posCheckout=(input:{cartToken:string;orderType:'DINE_IN'|'TAKEAWAY';expectedTotal:number;expectedRevision:string;customerName:string;customerPhone:string;customerNotes:string})=>apiRequest<CreatedOrder>(base+'/checkout',{method:'POST',body:JSON.stringify(input)});
export const posQr=(id:string,phone:string)=>apiRequest<CreateQrPaymentResponse>(base+'/orders/'+encodeURIComponent(id)+'/qr',{method:'POST',body:JSON.stringify({phone})});
export const posPayment=(id:string)=>apiRequest<OrderPaymentResponse>(base+'/orders/'+encodeURIComponent(id)+'/payment',{cache:'no-store'});
