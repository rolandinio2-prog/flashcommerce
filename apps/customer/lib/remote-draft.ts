import type { CheckoutDraft, DraftForm } from './checkout-draft';
export type RemoteDraft = {cartToken:string;form:DraftForm;revision:number;expiresAt:string;updatedAt:string};
export type DraftAccess = {cartToken:string;secret:string;revision:number};
export const accessKey=(tenant:string,branch:string)=>`flashcommerce.draftAccess:v1:${tenant}:${branch}`;
export function newSecret(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');}
export function privateLink(origin:string,tenant:string,branch:string,secret:string){return `${origin}/menu/${encodeURIComponent(tenant)}/${encodeURIComponent(branch)}#draft=${secret}`;}
export function fragmentSecret(hash:string){const value=new URLSearchParams(hash.replace(/^#/, '')).get('draft');return value&&/^[a-f0-9]{64}$/.test(value)?value:null;}
export function readAccess(storage:Pick<Storage,'getItem'>,key:string):DraftAccess|null {
  try {const a=JSON.parse(storage.getItem(key)||'null');return a&&/^[a-f0-9-]{36}$/i.test(a.cartToken)&&/^[a-f0-9]{64}$/.test(a.secret)&&Number.isInteger(a.revision)&&a.revision>=0?a:null;}catch{return null;}
}
export class DraftRequestError extends Error {constructor(public readonly status:number,message:string){super(message);}}
export async function draftRequest<T>(action:'save'|'restore'|'mine'|'session',body:unknown):Promise<T>{
  const response=await fetch(`/api/v1/checkout-drafts/${action}`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new DraftRequestError(response.status,response.status===409?'Tu pedido cambió en otra ventana. Recarga para revisar la versión más reciente.':response.status===401?'Inicia tu acceso de recuperación en Mis pedidos.':response.status===404?'El borrador no está disponible o el carrito venció.':'No se pudo sincronizar tu pedido. Mantén esta ventana abierta.');
  return response.json() as Promise<T>;
}
export type DraftCandidate={draft:RemoteDraft;access:DraftAccess;localOnly?:boolean};
export type ResumeResult={candidates:DraftCandidate[];explicit:boolean};
type ReadRequest=<T>(action:'restore'|'session'|'mine',body:unknown)=>Promise<T>;
export async function resolveAutomaticDraft(input:{tenant:string;branch:string;cartToken:string|null;incoming:string|null;access:DraftAccess|null;local:CheckoutDraft|null},request:ReadRequest=draftRequest):Promise<ResumeResult>{
  const {tenant,branch,cartToken,incoming,access,local}=input,scope={tenant,branch};
  const candidate=(draft:RemoteDraft,token:string):DraftCandidate=>({draft,access:{cartToken:draft.cartToken,secret:token,revision:draft.revision}});
  const optional=async<T>(action:'restore'|'session'|'mine',body:unknown):Promise<T|null>=>{try{return await request<T>(action,body);}catch(e){if(e instanceof DraftRequestError&&(e.status===404||e.status===401))return null;throw e;}};
  if(incoming){const draft=await request<RemoteDraft>('restore',{...scope,secret:incoming});return {candidates:[candidate(draft,incoming)],explicit:true};}
  let restored:DraftCandidate|null=null;
  if(access&&(!cartToken||access.cartToken===cartToken)){
    const draft=await optional<RemoteDraft>('restore',{...scope,secret:access.secret});if(draft)restored=candidate(draft,access.secret);
  }
  if(!restored){const remembered=await optional<{draft:RemoteDraft;secret:string}>('session',scope);if(remembered&&(!cartToken||remembered.draft.cartToken===cartToken))restored=candidate(remembered.draft,remembered.secret);}
  // Keep unsent local edits only if the known server revision still matches.
  if(restored){if(local&&local.cartToken===restored.draft.cartToken&&access?.cartToken===local.cartToken&&access.revision===restored.draft.revision)restored.draft={...restored.draft,form:local.form};return {candidates:[restored],explicit:false};}
  if(local&&local.cartToken===cartToken)return {candidates:[{draft:{cartToken,form:local.form,revision:access?.cartToken===cartToken?access.revision:0,expiresAt:'',updatedAt:new Date(local.updatedAt).toISOString()},access:access?.cartToken===cartToken?access:{cartToken,secret:newSecret(),revision:0},localOnly:true}],explicit:false};
  if(cartToken)return {candidates:[],explicit:false}; // Never replace a different active cart from account history.
  const account=await optional<{drafts:RemoteDraft[]}>('mine',scope);
  return {candidates:(account?.drafts??[]).map(draft=>candidate(draft,newSecret())),explicit:false};
}

// Keep the handoff capability in the fragment, never in a query or server path.
export function continuityUrl(current:string,tenant:string,branch:string,secret:string|null):string|null {
 const url=new URL(current);
 const expected='/menu/'+encodeURIComponent(tenant)+'/'+encodeURIComponent(branch);
 if(url.protocol!=='https:'||url.pathname.replace(/\/$/,'')!==expected)return null;
 if(secret!==null&&!/^[a-f0-9]{64}$/.test(secret))return null;
 const fragment=new URLSearchParams(url.hash.slice(1));
 if(secret===null)fragment.delete('draft');else fragment.set('draft',secret);
 url.hash=fragment.toString();return url.pathname+url.search+url.hash;
}
