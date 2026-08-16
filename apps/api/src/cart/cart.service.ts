import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

interface CreatedCartRow {
  id: string;
  cart_token: string;
  status: string;
  currency: string;
  expires_at: string | Date;
}

interface ProductContextRow {
  tenant_id: string;
  cart_id: string;
  product_id: string;
  sku: string | null;
  name: string;
  price: string;
  currency: string;
  available_quantity: number | null;
}

interface CartItemRow {
  product_id: string;
  quantity: number;
  unit_price: string;
  currency: string;
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

  async addItem(
    cartToken: string,
    productId: string | undefined,
    quantity: number | undefined,
  ) {
    if (!cartToken?.trim()) {
      throw new BadRequestException('cartToken is required');
    }

    if (!productId?.trim()) {
      throw new BadRequestException('productId is required');
    }

    const requestedQuantity = quantity ?? 1;

    if (
      !Number.isInteger(requestedQuantity) ||
      requestedQuantity <= 0
    ) {
      throw new BadRequestException(
        'quantity must be a positive integer',
      );
    }

    const productResult =
      await this.databaseService.query<ProductContextRow>(
        `
          select
            c.tenant_id::text,
            c.id::text as cart_id,

            p.id::text as product_id,
            p.sku,
            p.name,

            bp.price::text as price,
            bp.currency,
            bp.available_quantity

          from public.carts c

          inner join public.products p
            on p.tenant_id = c.tenant_id
           and p.id = $2::uuid
           and p.active = true

          inner join public.branch_products bp
            on bp.tenant_id = c.tenant_id
           and bp.branch_id = c.branch_id
           and bp.product_id = p.id
           and bp.is_available = true

          where c.cart_token = $1::uuid
            and c.status = 'OPEN'
            and c.expires_at > now()

          limit 1
        `,
        [
          cartToken.trim(),
          productId.trim(),
        ],
      );

    const product = productResult.rows[0];

    if (!product) {
      throw new NotFoundException(
        'Open cart or available product not found',
      );
    }

    const currentItemResult =
      await this.databaseService.query<{
        quantity: number;
      }>(
        `
          select quantity
          from public.cart_items
          where tenant_id = $1::uuid
            and cart_id = $2::uuid
            and product_id = $3::uuid
          limit 1
        `,
        [
          product.tenant_id,
          product.cart_id,
          product.product_id,
        ],
      );

    const currentQuantity =
      currentItemResult.rows[0]?.quantity ?? 0;

    const newQuantity =
      currentQuantity + requestedQuantity;

    if (
      product.available_quantity !== null &&
      newQuantity > product.available_quantity
    ) {
      throw new BadRequestException(
        `Only ${product.available_quantity} units are available`,
      );
    }

    const itemResult =
      await this.databaseService.query<CartItemRow>(
        `
          insert into public.cart_items (
            tenant_id,
            cart_id,
            product_id,
            quantity,
            unit_price,
            currency
          )
          values (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6
          )

          on conflict (cart_id, product_id)
          do update set
            quantity = excluded.quantity,
            unit_price = excluded.unit_price,
            currency = excluded.currency,
            updated_at = now()

          returning
            product_id::text,
            quantity,
            unit_price::text,
            currency
        `,
        [
          product.tenant_id,
          product.cart_id,
          product.product_id,
          newQuantity,
          product.price,
          product.currency,
        ],
      );

    const item = itemResult.rows[0];

    return {
      product: {
        id: item.product_id,
        sku: product.sku,
        name: product.name,
      },
      quantity: item.quantity,
      unitPrice: Number(item.unit_price),
      currency: item.currency,
      lineTotal:
        Number(item.unit_price) * item.quantity,
    };
  }

  async getCart(cartToken: string) {
  if (!cartToken?.trim()) {
    throw new BadRequestException('cartToken is required');
  }

  const cartResult = await this.databaseService.query<{
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

  const itemsResult = await this.databaseService.query<{
    product_id: string;
    sku: string | null;
    name: string;
    quantity: number;
    unit_price: string;
    currency: string;
    line_total: string;
  }>(
    `
      select
        ci.product_id::text,
        p.sku,
        p.name,

        ci.quantity,
        ci.unit_price::text,
        ci.currency,

        (ci.quantity * ci.unit_price)::text
          as line_total

      from public.cart_items ci

      inner join public.products p
        on p.tenant_id = ci.tenant_id
       and p.id = ci.product_id

      where ci.cart_id = $1::uuid

      order by ci.created_at
    `,
    [cart.id],
  );

  const items = itemsResult.rows.map((item) => ({
    product: {
      id: item.product_id,
      sku: item.sku,
      name: item.name,
    },

    quantity: item.quantity,
    unitPrice: Number(item.unit_price),
    currency: item.currency,
    lineTotal: Number(item.line_total),
  }));

  const totalItems = items.reduce(
    (total, item) => total + item.quantity,
    0,
  );

  const total = items.reduce(
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
      total,
    },
  };
}

async updateItem(
  cartToken: string,
  productId: string,
  quantity: number | undefined,
) {
  if (
    !Number.isInteger(quantity) ||
    quantity === undefined ||
    quantity <= 0
  ) {
    throw new BadRequestException(
      'quantity must be a positive integer',
    );
  }

  const contextResult =
    await this.databaseService.query<{
      tenant_id: string;
      cart_id: string;
      price: string;
      currency: string;
      available_quantity: number | null;
    }>(
      `
        select
          c.tenant_id::text,
          c.id::text as cart_id,
          bp.price::text,
          bp.currency,
          bp.available_quantity

        from public.carts c

        inner join public.branch_products bp
          on bp.tenant_id = c.tenant_id
         and bp.branch_id = c.branch_id
         and bp.product_id = $2::uuid
         and bp.is_available = true

        where c.cart_token = $1::uuid
          and c.status = 'OPEN'
          and c.expires_at > now()

        limit 1
      `,
      [cartToken, productId],
    );

  const context = contextResult.rows[0];

  if (!context) {
    throw new NotFoundException(
      'Open cart or available product not found',
    );
  }

  if (
    context.available_quantity !== null &&
    quantity > context.available_quantity
  ) {
    throw new BadRequestException(
      `Only ${context.available_quantity} units are available`,
    );
  }

  const result =
    await this.databaseService.query<{
      product_id: string;
      quantity: number;
      unit_price: string;
      currency: string;
    }>(
      `
        update public.cart_items
        set
          quantity = $4,
          unit_price = $5,
          currency = $6,
          updated_at = now()

        where tenant_id = $1::uuid
          and cart_id = $2::uuid
          and product_id = $3::uuid

        returning
          product_id::text,
          quantity,
          unit_price::text,
          currency
      `,
      [
        context.tenant_id,
        context.cart_id,
        productId,
        quantity,
        context.price,
        context.currency,
      ],
    );

  const item = result.rows[0];

  if (!item) {
    throw new NotFoundException(
      'Product is not in the cart',
    );
  }

  return {
    productId: item.product_id,
    quantity: item.quantity,
    unitPrice: Number(item.unit_price),
    currency: item.currency,
    lineTotal:
      Number(item.unit_price) * item.quantity,
  };
}

async removeItem(
  cartToken: string,
  productId: string,
) {
  const result =
    await this.databaseService.query<{
      product_id: string;
    }>(
      `
        delete from public.cart_items ci

        using public.carts c

        where c.id = ci.cart_id
          and c.tenant_id = ci.tenant_id
          and c.cart_token = $1::uuid
          and c.status = 'OPEN'
          and ci.product_id = $2::uuid

        returning ci.product_id::text
      `,
      [cartToken, productId],
    );

  if (!result.rows[0]) {
    throw new NotFoundException(
      'Cart item not found',
    );
  }

  return {
    removed: true,
    productId: result.rows[0].product_id,
  };
}

}