import { createHash } from 'node:crypto';
export function posCartRevision(items:{product_id:string;rice_choice:string;quantity:number;currency:string|null;unit_price?:string;price?:string|null;sauce_included_quantity:number|null}[]) {
  const lines=items.map(i=>[i.product_id,i.rice_choice,i.quantity,Number(i.unit_price??i.price).toFixed(2),i.currency,i.sauce_included_quantity]);
  lines.sort((a,b)=>String(a[0]).localeCompare(String(b[0]))||String(a[1]).localeCompare(String(b[1])));
  return createHash('sha256').update(JSON.stringify(lines)).digest('hex');
}
