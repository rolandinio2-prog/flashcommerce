import { saucePricing, priceSauceLines } from './sauce-pricing';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { riceChoice, validateRice, riceName } from './rice-choice';

interface CreatedCartRow {
  id: string;
  cart_token: string;
  status: string;
  currency: string;
  expires_at: string | Date;
}

@Injectable()
export class CartService {
  constructor(private readonly databaseService: DatabaseService) {}

  async createCart(
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ) {
    if (!tenantCode?.trim()) {
      throw new BadRequestException('tenantCode is required');
    }

    if (!branchCode?.trim()) {
      throw new BadRequestException('branchCode is required');
    }

    const result =
      await this.databaseService.query<CreatedCartRow>(
        `
          insert into public.carts (
            tenant_id,
            branch_id,
            currency
          )
          select
            t.id,
            b.id,
            'BOB'
          from public.tenants t
          inner join public.branches b
            on b.tenant_id = t.id
          where t.code = $1
            and b.code = $2
            and t.status = 'ACTIVE'
            and b.status = 'ACTIVE'
          returning
            id::text,
            cart_token::text,
            status,
            currency,
            expires_at
        `,
        [tenantCode.trim(), branchCode.trim()],
      );

    const cart = result.rows[0];

    if (!cart) {
      throw new NotFoundException(
        `Active tenant or branch not found: ${tenantCode}/${branchCode}`,
      );
    }

    return {
      id: cart.id,
      token: cart.cart_token,
      status: cart.status,
      currency: cart.currency,
      expiresAt: cart.expires_at,
      tenant: tenantCode,
      branch: branchCode,
    };
  }

  async addItem(cartToken: string, productId: string | undefined, quantity: number | undefined, choice?: unknown) {
    return this.mutateItem(cartToken, productId, quantity ?? 1, choice, 'add');
  }

  private async mutateItem(cartToken: string, productId: string | undefined, quantity: number, choice: unknown, operation: 'add' | 'set' | 'remove') {
    const rice = riceChoice(choice);
    if (!cartToken?.trim() || !productId?.trim()) throw new BadRequestException('Cart and product are required');
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive integer');
    return this.databaseService.withTransaction(async client => {
      // Serialize all changes to this cart with checkout, including distinct rice lines.
      const carts = await client.query<{id: string; tenant_id: string; branch_id: string}>(
        "select id::text,tenant_id::text,branch_id::text from public.carts where cart_token=$1::uuid and status='OPEN' and expires_at>now() for update", [cartToken]);
      const cart = carts.rows[0];
      if (!cart) throw new NotFoundException('Open cart not found');
      // Freeze the current allowance before changing grouped quantities. The cart lock serializes this with checkout.
      await this.persistSauceAllocations(cartToken, client, cart);
      if (operation === 'remove') {
        const removed = await client.query('delete from public.cart_items where tenant_id=$1::uuid and cart_id=$2::uuid and product_id=$3::uuid and rice_choice=$4 returning id', [cart.tenant_id,cart.id,productId,rice]);
        if (!removed.rows.length) throw new NotFoundException('Cart item not found');
        await this.persistSauceAllocations(cartToken, client, cart);
        return {removed:true,productId,riceChoice:rice};
      }
      const products = await client.query<{name:string;sku:string|null;price:string;currency:string;available_quantity:number|null;selection_required:boolean;legacy_combination:boolean;requires_rice:boolean}>(`
        select p.name,p.sku,bp.price::text,bp.currency,bp.available_quantity,
          (p.garnish_parent_id is not null) as legacy_combination,
          exists(select 1 from public.products child join public.branch_products cb on cb.tenant_id=child.tenant_id and cb.product_id=child.id and cb.branch_id=bp.branch_id where child.tenant_id=p.tenant_id and child.presentation_parent_id=p.id) as selection_required,
          exists(select 1 from public.product_categories rc where rc.tenant_id=p.tenant_id and rc.id=p.category_id and rc.slug='pollos') as requires_rice
        from public.products p join public.branch_products bp on bp.tenant_id=p.tenant_id and bp.product_id=p.id
        where p.tenant_id=$1::uuid and bp.branch_id=$2::uuid and p.id=$3::uuid and p.active and bp.is_available
      `, [cart.tenant_id,cart.branch_id,productId]);
      const product = products.rows[0];
      if (!product) throw new NotFoundException('Available product not found');
      if (product.legacy_combination) throw new BadRequestException('Esta combinación ya no se ofrece. Elige el tamaño y el arroz del pollo.');
      if (product.selection_required) throw new BadRequestException('Selecciona el tamaño antes de agregar el producto.');
      const lines = await client.query<{quantity:number;rice_choice:string}>('select quantity,rice_choice from public.cart_items where tenant_id=$1::uuid and cart_id=$2::uuid and product_id=$3::uuid', [cart.tenant_id,cart.id,productId]);
      const current = lines.rows.find(line => line.rice_choice === rice);
      if (operation === 'set' && !current) throw new NotFoundException('Cart item not found');
      // Older carts may be reduced or removed; increasing requires an explicit rice choice.
      if (!(operation === 'set' && current && quantity < current.quantity && !rice)) validateRice(product.requires_rice,rice);
      const newQuantity = operation === 'add' ? (current?.quantity ?? 0) + quantity : quantity;
      const totalQuantity = lines.rows.reduce((sum,line) => sum + line.quantity,0) - (current?.quantity ?? 0) + newQuantity;
      if (!Number.isSafeInteger(newQuantity) || newQuantity > 2147483647) throw new BadRequestException('Invalid quantity');
      if (product.available_quantity !== null && totalQuantity > product.available_quantity) throw new BadRequestException(`Only ${product.available_quantity} units are available`);
      await client.query(`insert into public.cart_items (tenant_id,cart_id,product_id,quantity,unit_price,currency,rice_choice)
        values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7)
        on conflict (cart_id,product_id,rice_choice) do update set quantity=excluded.quantity,sauce_included_quantity=case when public.cart_items.sauce_included_quantity is null then null else least(public.cart_items.sauce_included_quantity,excluded.quantity) end,unit_price=excluded.unit_price,currency=excluded.currency,updated_at=now()`,
        [cart.tenant_id,cart.id,productId,newQuantity,product.price,product.currency,rice]);
      const updated = await this.persistSauceAllocations(cartToken, client, cart);
      const item = updated.items.find(line => line.product.id === productId && line.riceChoice === rice);
      if (!item) throw new Error('Updated cart line missing');
      return {product:item.product,productId,riceChoice:rice,quantity:item.quantity,unitPrice:item.unitPrice,currency:item.currency,lineTotal:item.lineTotal,includedQuantity:item.includedQuantity};
    });
  }

  private async persistSauceAllocations(cartToken: string, client: Pick<DatabaseService, 'query'>, cart: { id: string; tenant_id: string }) {
    const snapshot = await this.getCart(cartToken, client);
    if (snapshot.tenant.code === 'POLLO001' && snapshot.branch.code === 'SUC001') {
      for (const item of snapshot.items) {
        if (!item.product.sku?.startsWith('SALSA-')) continue;
        await client.query(
          'update public.cart_items set sauce_included_quantity=$5 where tenant_id=$1::uuid and cart_id=$2::uuid and product_id=$3::uuid and rice_choice=$4 and sauce_included_quantity is distinct from $5',
          [cart.tenant_id, cart.id, item.product.id, item.riceChoice, item.includedQuantity],
        );
      }
    }
    return snapshot;
  }

  async getCart(cartToken: string, queryClient: Pick<DatabaseService, 'query'> = this.databaseService) {
  if (!cartToken?.trim()) {
    throw new BadRequestException('cartToken is required');
  }

  const cartResult = await queryClient.query<{
    id: string;
    token: string;
    status: string;
    currency: string;
    expires_at: string | Date;
    tenant_code: string;
    tenant_name: string;
    branch_code: string;
    branch_name: string;
  }>(
    `
      select
        c.id::text,
        c.cart_token::text as token,
        c.status,
        c.currency,
        c.expires_at,

        t.code as tenant_code,
        t.name as tenant_name,

        b.code as branch_code,
        b.name as branch_name

      from public.carts c

      inner join public.tenants t
        on t.id = c.tenant_id

      inner join public.branches b
        on b.tenant_id = c.tenant_id
       and b.id = c.branch_id

      where c.cart_token::text = $1
      limit 1
    `,
    [cartToken.trim()],
  );

  const cart = cartResult.rows[0];

  if (!cart) {
    throw new NotFoundException('Cart not found');
  }

  const itemsResult = await queryClient.query<{
    sauce_included_quantity: number | null;
    requires_rice: boolean;
    product_id: string;
    sku: string | null;
    name: string;
    quantity: number;
    unit_price: string;
    currency: string;
    line_total: string;
    rice_choice: string;
  }>(
    `
      select
        exists(select 1 from public.product_categories rc where rc.tenant_id=p.tenant_id and rc.id=p.category_id and rc.slug='pollos') as requires_rice,
        ci.product_id::text,
        ci.rice_choice,
        p.sku,
        p.name,

        ci.quantity,
        ci.sauce_included_quantity,
        ci.unit_price::text,
        ci.currency,

        (ci.quantity * ci.unit_price)::text
          as line_total

      from public.cart_items ci

      inner join public.products p
        on p.tenant_id = ci.tenant_id
       and p.id = ci.product_id

      where ci.cart_id = $1::uuid

      order by ci.created_at, ci.id
    `,
    [cart.id],
  );

  const pricedRows = priceSauceLines(cart.tenant_code, cart.branch_code, itemsResult.rows.map(item => ({ ...item, price: item.unit_price })));
  const items = pricedRows.map((item) => ({
    riceChoice: item.rice_choice,
    product: {
      id: item.product_id,
      sku: item.sku,
      name: riceName(item.name, riceChoice(item.rice_choice)),
    },

    quantity: item.quantity,
    unitPrice: Number(item.unit_price),
    currency: item.currency,
    lineTotal: item.lineTotal,
    includedQuantity: item.includedQuantity,
  }));

  const totalItems = items.reduce(
    (total, item) => total + item.quantity,
    0,
  );

  const sauces = saucePricing(cart.tenant_code, cart.branch_code, itemsResult.rows.map(item => ({ ...item, price: item.unit_price })));
  const subtotal = items.reduce(
    (sum, item) => sum + item.lineTotal,
    0,
  );

  return {
    id: cart.id,
    token: cart.token,
    status: cart.status,
    currency: cart.currency,
    expiresAt: cart.expires_at,

    tenant: {
      code: cart.tenant_code,
      name: cart.tenant_name,
    },

    branch: {
      code: cart.branch_code,
      name: cart.branch_name,
    },

    items,

    summary: {
      totalItems,
      subtotal,
      discountTotal: sauces.discountTotal,
      total: subtotal,
      sauces,
    },
  };
}

async updateItem(cartToken: string, productId: string, quantity: number | undefined, choice?: unknown) {
  return this.mutateItem(cartToken, productId, quantity as number, choice, 'set');
}
async removeItem(cartToken: string, productId: string, choice?: unknown) {
  return this.mutateItem(cartToken, productId, 1, choice, 'remove');
}
}
