import { ConflictException, Injectable, NotFoundException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { cartToken, draftForm, scope, secret } from './draft-validation';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unavailable = () => new NotFoundException('El borrador no está disponible o el carrito venció.');
const active = `c.status='OPEN' and c.expires_at>now() and t.status='ACTIVE' and b.status='ACTIVE'`;
const joins = `join public.carts c on c.id=d.cart_id and c.tenant_id=d.tenant_id
 join public.tenants t on t.id=c.tenant_id join public.branches b on b.id=c.branch_id and b.tenant_id=c.tenant_id`;
const fields = `c.cart_token::text as "cartToken", d.form, d.revision, c.expires_at as "expiresAt", d.updated_at as "updatedAt"`;
@Injectable()
export class DraftService {
  constructor(private readonly db: DatabaseService) {}
  private sessionHash(cookie?: string) {
    const pair = cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('flash_customer_session='));
    if (!pair) return null;
    try {const token=decodeURIComponent(pair.slice('flash_customer_session='.length));return token && token.length<=512 ? hash(token) : null;} catch {return null;}
  }
  async save(body: Record<string, unknown>, cookie?: string) {
    const tenant=scope(body?.tenant),branch=scope(body?.branch),token=cartToken(body?.cartToken),link=secret(body?.secret),form=draftForm(body?.form);
    const revision=body?.revision;
    if (!Number.isInteger(revision) || Number(revision)<0 || Number(revision)>2147483646) throw new BadRequestException('Versión de borrador inválida.');
    return this.db.withTransaction(async client=>{
      // Serialize saves and order conversion on the same cart; never extend expiry.
      const found=await client.query(`select c.id,c.tenant_id,c.branch_id,c.expires_at from public.carts c
        join public.tenants t on t.id=c.tenant_id join public.branches b on b.id=c.branch_id and b.tenant_id=c.tenant_id
        where c.cart_token=$1::uuid and t.code=$2 and b.code=$3 and ${active} for update of c`,[token,tenant,branch]);
      const cart=found.rows[0];if(!cart)throw unavailable();
      const account=await client.query(`select s.customer_account_id from public.customer_sessions s
        join public.customer_accounts a on a.id=s.customer_account_id and a.tenant_id=s.tenant_id
        where s.token_hash=$1 and s.tenant_id=$2 and s.revoked_at is null and s.expires_at>now() and a.status='ACTIVE'`,[this.sessionHash(cookie),cart.tenant_id]);
      const current=await client.query(`select revision,customer_account_id from public.checkout_drafts where cart_id=$1`,[cart.id]);
      if ((current.rows[0]?.revision??0)!==revision) throw new ConflictException('El borrador cambió en otra ventana. Ábrelo de nuevo antes de guardar.');
      const owner=current.rows[0]?.customer_account_id??account.rows[0]?.customer_account_id??null;
      const saved=await client.query(`insert into public.checkout_drafts(cart_id,tenant_id,branch_id,secret_hash,form,revision,customer_account_id)
        values($1,$2,$3,$4,$5::jsonb,$6,$7)
        on conflict(cart_id) do update set secret_hash=excluded.secret_hash,form=excluded.form,revision=excluded.revision,
        customer_account_id=excluded.customer_account_id,updated_at=now() returning revision`,[cart.id,cart.tenant_id,cart.branch_id,hash(link),JSON.stringify(form),Number(revision)+1,owner]);
      return {revision:saved.rows[0].revision,expiresAt:cart.expires_at,linkedToRecovery:Boolean(owner)};
    });
  }
  async restore(body: Record<string,unknown>) {
    const result=await this.db.query(`select ${fields} from public.checkout_drafts d ${joins}
      where d.secret_hash=$1 and t.code=$2 and b.code=$3 and ${active}`,[hash(secret(body?.secret)),scope(body?.tenant),scope(body?.branch)]);
    if(!result.rows[0])throw unavailable();return result.rows[0];
  }
  async list(body: Record<string,unknown>, cookie?:string) {
    const tenant=scope(body?.tenant),branch=scope(body?.branch),session=this.sessionHash(cookie);
    if(!session)throw new UnauthorizedException('Inicia tu acceso de recuperación en Mis pedidos.');
    const valid=await this.db.query(`select s.customer_account_id,s.tenant_id from public.customer_sessions s
      join public.customer_accounts a on a.id=s.customer_account_id and a.tenant_id=s.tenant_id
      join public.tenants t on t.id=s.tenant_id where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now()
      and a.status='ACTIVE' and t.status='ACTIVE' and t.code=$2`,[session,tenant]);
    if(!valid.rows[0])throw new UnauthorizedException('Inicia tu acceso de recuperación en Mis pedidos.');
    const result=await this.db.query(`select ${fields} from public.checkout_drafts d ${joins}
      where d.customer_account_id=$1 and d.tenant_id=$2 and t.code=$3 and b.code=$4 and ${active}
      order by d.updated_at desc limit 10`,[valid.rows[0].customer_account_id,valid.rows[0].tenant_id,tenant,branch]);
    return {drafts:result.rows};
  }
}
