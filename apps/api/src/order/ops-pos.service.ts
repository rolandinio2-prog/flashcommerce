import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CartService } from '../cart/cart.service';
import { CatalogService } from '../catalog/catalog.service';
import { PaymentsService } from '../payments/payments.service';
import { OrderService } from './order.service';
import type { StaffSessionPrincipal } from '../staff/staff.types';
import type { PosCheckoutInput } from './pos-checkout';

@Injectable()
export class OpsPosService {
  constructor(private readonly db:DatabaseService,private readonly carts:CartService,private readonly catalog:CatalogService,private readonly orders:OrderService,private readonly payments:PaymentsService) {}
  catalogFor(staff:StaffSessionPrincipal){ return this.catalog.getCatalog(staff.tenantCode,staff.branchCode); }
  async createDraft(staff:StaffSessionPrincipal,requestId:unknown){
    if(typeof requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))throw new BadRequestException('Identificador inválido.');
    const token=await this.db.withTransaction(async client=>{
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`${staff.tenantId}:${staff.branchId}:${staff.userId}:${requestId}`]);
      const existing=await client.query<{cart_token:string}>('select c.cart_token::text from public.pos_drafts d join public.carts c on c.id=d.cart_id where d.tenant_id=$1::uuid and d.branch_id=$2::uuid and d.staff_user_id=$3::uuid and d.request_id=$4::uuid',[staff.tenantId,staff.branchId,staff.userId,requestId]);
      if(existing.rows[0])return existing.rows[0].cart_token;
      const created=await client.query<{id:string;cart_token:string}>(`insert into public.carts(tenant_id,branch_id,currency) select t.id,b.id,'BOB' from public.tenants t join public.branches b on b.tenant_id=t.id where t.id=$1::uuid and b.id=$2::uuid and t.status='ACTIVE' and b.status='ACTIVE' returning id::text,cart_token::text`,[staff.tenantId,staff.branchId]);
      const cart=created.rows[0];if(!cart)throw new NotFoundException('Sucursal no disponible.');
      await client.query('insert into public.pos_drafts(cart_id,tenant_id,branch_id,staff_user_id,request_id) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid)',[cart.id,staff.tenantId,staff.branchId,staff.userId,requestId]);
      return cart.cart_token;
    });
    return this.carts.getCart(token,undefined,staff);
  }
  async current(staff:StaffSessionPrincipal){
    const row=await this.db.query<{cart_token:string;order_id:string|null}>(`select c.cart_token::text,d.order_id::text from public.pos_drafts d join public.carts c on c.id=d.cart_id where d.tenant_id=$1::uuid and d.branch_id=$2::uuid and d.staff_user_id=$3::uuid and (c.expires_at>now() or d.order_id is not null) order by d.created_at desc limit 1`,[staff.tenantId,staff.branchId,staff.userId]);
    if(!row.rows[0])return {cart:null,order:null};
    const draft=row.rows[0];
    return {cart:await this.carts.getCart(draft.cart_token,undefined,staff),order:draft.order_id?await this.orderSnapshot(staff,draft.order_id):null};
  }
  async mutate(staff:StaffSessionPrincipal,token:string,body:{productId?:string;quantity?:number;riceChoice?:string},action:'add'|'set'|'remove'){
    await this.carts.getCart(token,undefined,staff);
    if(!body?.productId)throw new BadRequestException('Producto requerido.');
    if(action==='add')await this.carts.addItem(token,body.productId,body.quantity,body.riceChoice,staff);
    else if(action==='set')await this.carts.updateItem(token,body.productId,body.quantity,body.riceChoice,staff);
    else await this.carts.removeItem(token,body.productId,body.riceChoice,staff);
    return this.carts.getCart(token,undefined,staff);
  }
  checkout(staff:StaffSessionPrincipal,input:PosCheckoutInput){return this.orders.createPosOrder(input,staff);}
  private async orderToken(staff:StaffSessionPrincipal,id:string){
    const row=await this.db.query<{tracking_token:string}>(`select o.tracking_token::text from public.pos_drafts d join public.orders o on o.id=d.order_id where d.tenant_id=$1::uuid and d.branch_id=$2::uuid and d.staff_user_id=$3::uuid and o.tenant_id=d.tenant_id and o.branch_id=d.branch_id and o.id=$4::uuid`,[staff.tenantId,staff.branchId,staff.userId,id]);
    if(!row.rows[0])throw new NotFoundException('Pedido no encontrado.');return row.rows[0].tracking_token;
  }
  async orderSnapshot(staff:StaffSessionPrincipal,id:string){return {...await this.orders.getOrderTracking(await this.orderToken(staff,id)),id};}
  async qr(staff:StaffSessionPrincipal,id:string,phone?:unknown){return this.payments.createQrPayment(await this.orderToken(staff,id),phone);}
  async payment(staff:StaffSessionPrincipal,id:string){return this.payments.getOrderPayment(await this.orderToken(staff,id));}
}
