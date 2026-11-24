import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { StaffSessionPrincipal } from '../staff/staff.types';
import {
  BranchOperationsService,
  changeReason,
  objectInput,
  priceInput,
} from './branch-operations.service';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function text(value: unknown, max: number, required = true) {
  if (
    typeof value !== 'string' ||
    value.trim().length > max ||
    (required && !value.trim()) ||
    // eslint-disable-next-line no-control-regex -- intentionally rejects control characters in user/provider input
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new BadRequestException('Revisa los textos del producto.');
  return value.trim();
}
export function creationInput(input: unknown) {
  const v = objectInput(input, [
    'requestId',
    'name',
    'description',
    'categoryId',
    'price',
    'available',
    'presentations',
    'reason',
  ]);
  if (
    typeof v.requestId !== 'string' ||
    !UUID.test(v.requestId) ||
    typeof v.categoryId !== 'string' ||
    !UUID.test(v.categoryId) ||
    typeof v.available !== 'boolean' ||
    !Array.isArray(v.presentations) ||
    v.presentations.length > 12
  )
    throw new BadRequestException('Datos de alta inválidos.');
  const name = text(v.name, 85),
    description = text(v.description ?? '', 1000, false),
    reason = changeReason(v.reason),
    price = priceInput(v.price);
  const presentations = v.presentations.map((item) => {
    const p = objectInput(item, ['label', 'price']);
    return { label: text(p.label, 60), price: priceInput(p.price) };
  });
  if (
    new Set(
      presentations.map((p) =>
        p.label.normalize('NFKC').toLocaleLowerCase('es'),
      ),
    ).size !== presentations.length
  )
    throw new BadRequestException('Las presentaciones no pueden repetirse.');
  return {
    requestId: v.requestId,
    categoryId: v.categoryId,
    name,
    description,
    price,
    available: v.available,
    presentations,
    reason,
  };
}
type FamilyRow = {
  id: string;
  name: string;
  parent: string | null;
  garnish_parent: string | null;
  updated: string;
  active: boolean;
};
@Injectable()
export class ProductLifecycleService {
  constructor(
    private readonly db: DatabaseService,
    private readonly operations: BranchOperationsService,
  ) {}
  async options(p: StaffSessionPrincipal) {
    return this.db.withTransaction(async (c) => {
      await this.operations.authorize(c, p);
      const r = await c.query(
        'select id::text,name,slug from public.product_categories where tenant_id=$1::uuid and active order by sort_order,name',
        [p.tenantId],
      );
      return { categories: r.rows };
    });
  }
  private async previous(
    c: PoolClient,
    p: StaffSessionPrincipal,
    requestId: string,
    fingerprint: string,
  ) {
    const r = await c.query<{
      actor_id: string;
      branch_id: string;
      payload_hash: string;
      result: Record<string, unknown>;
    }>(
      'select actor_id::text,branch_id::text,payload_hash,result from public.branch_product_commands where tenant_id=$1::uuid and request_id=$2::uuid',
      [p.tenantId, requestId],
    );
    const row = r.rows[0];
    if (!row) return null;
    if (
      row.actor_id !== p.userId ||
      row.branch_id !== p.branchId ||
      row.payload_hash !== fingerprint
    )
      throw new ConflictException(
        'La solicitud ya fue utilizada con otros datos. Recarga antes de continuar.',
      );
    return row.result;
  }
  private remember(
    c: PoolClient,
    p: StaffSessionPrincipal,
    requestId: string,
    fingerprint: string,
    result: unknown,
  ) {
    return c.query(
      'insert into public.branch_product_commands(tenant_id,branch_id,actor_id,request_id,payload_hash,result) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb)',
      [
        p.tenantId,
        p.branchId,
        p.userId,
        requestId,
        fingerprint,
        JSON.stringify(result),
      ],
    );
  }
  async create(p: StaffSessionPrincipal, input: unknown) {
    const v = creationInput(input),
      fingerprint = digest(['create', v]);
    return this.db.withTransaction(async (c) => {
      await this.operations.authorize(c, p, true);
      const prior = await this.previous(c, p, v.requestId, fingerprint);
      if (prior) return prior;
      const categories = await c.query<{ slug: string }>(
        'select slug from public.product_categories where tenant_id=$1::uuid and id=$2::uuid and active for share',
        [p.tenantId, v.categoryId],
      );
      const category = categories.rows[0];
      if (!category) throw new BadRequestException('Categoría no disponible.');
      if (category.slug === 'pollos' && !v.presentations.length)
        throw new BadRequestException(
          'Un pollo debe tener al menos un tamaño con su precio.',
        );
      if (
        category.slug === 'salsas' &&
        (v.presentations.length || v.price !== '7.00')
      )
        throw new BadRequestException(
          'Las salsas conservan Bs 7 por adicional y no usan presentaciones.',
        );
      const id = randomUUID(),
        sku =
          (category.slug === 'salsas' ? 'SALSA-' : 'PRD-') +
          id.replace(/-/g, '').toUpperCase();
      const createOne = async (
        productId: string,
        productName: string,
        productSku: string,
        price: string,
        parent: string | null,
        label: string | null,
        ordinal: number,
      ) => {
        await c.query(
          'insert into public.products(id,tenant_id,category_id,sku,name,description,active,presentation_parent_id,presentation_label,presentation_sort_order) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,true,$7::uuid,$8,$9)',
          [
            productId,
            p.tenantId,
            v.categoryId,
            productSku,
            productName,
            v.description || null,
            parent,
            label,
            ordinal,
          ],
        );
        await c.query(
          "insert into public.branch_products(tenant_id,branch_id,product_id,price,currency,is_available) values($1::uuid,$2::uuid,$3::uuid,$4::numeric,'BOB',$5)",
          [p.tenantId, p.branchId, productId, price, v.available],
        );
      };
      const basePrice = v.presentations.length
        ? Math.min(...v.presentations.map((x) => Number(x.price))).toFixed(2)
        : v.price;
      await createOne(id, v.name, sku, basePrice, null, null, 0);
      for (const [index, option] of v.presentations.entries())
        await createOne(
          randomUUID(),
          v.name + ' · ' + option.label,
          sku + '-' + (index + 1),
          option.price,
          id,
          option.label,
          index + 1,
        );
      const result = {
        created: true,
        id,
        name: v.name,
        productsCreated: 1 + v.presentations.length,
      };
      await this.operations.audit(
        c,
        p,
        'PRODUCT_CREATED',
        id,
        v.reason,
        {},
        { ...v, requestId: undefined, id, sku },
      );
      await this.remember(c, p, v.requestId, fingerprint, result);
      return result;
    });
  }
  private async inspect(
    c: PoolClient,
    p: StaffSessionPrincipal,
    id: string,
    lock = false,
  ) {
    const root = await c.query(
      'select p.id from public.products p join public.branch_products bp on bp.tenant_id=p.tenant_id and bp.product_id=p.id where p.tenant_id=$1::uuid and p.id=$2::uuid and bp.branch_id=$3::uuid' +
        (lock ? ' for update of p' : ''),
      [p.tenantId, id, p.branchId],
    );
    if (!root.rows.length)
      throw new NotFoundException('Producto no disponible en esta sucursal.');
    const family = await c.query<FamilyRow>(
      `with recursive family as (
   select id from public.products where tenant_id=$1::uuid and id=$2::uuid
   union select child.id from public.products child join family f on child.presentation_parent_id=f.id or child.garnish_parent_id=f.id where child.tenant_id=$1::uuid
  ) select p.id::text,p.name,p.presentation_parent_id::text as parent,p.garnish_parent_id::text as garnish_parent,p.updated_at::text as updated,p.active
  from public.products p join family f on f.id=p.id where p.tenant_id=$1::uuid order by p.id` +
        (lock ? ' for update of p' : ''),
      [p.tenantId, id],
    );
    if (family.rows.length > 200)
      throw new ConflictException(
        'Este conjunto requiere revisión administrativa.',
      );
    const ids = family.rows.map((x) => x.id);
    const refs = await c.query<{
      orders: number;
      carts: number;
      other_branches: boolean;
    }>(
      `select
   (select count(distinct order_id)::int from public.order_items where tenant_id=$1::uuid and product_id=any($2::uuid[])) as orders,
   (select count(distinct cart_id)::int from public.cart_items where tenant_id=$1::uuid and product_id=any($2::uuid[])) as carts,
   exists(select 1 from public.branch_products where tenant_id=$1::uuid and product_id=any($2::uuid[]) and branch_id<>$3::uuid) as other_branches`,
      [p.tenantId, ids, p.branchId],
    );
    const references = refs.rows[0],
      reasons: string[] = [];
    if (references.orders)
      reasons.push(
        'Tiene pedidos vinculados, incluidos cancelados o pendientes. Puedes marcarlo como no disponible.',
      );
    if (references.carts)
      reasons.push(
        'Está vinculado a carritos. No se eliminarán sus líneas automáticamente.',
      );
    if (references.other_branches)
      reasons.push(
        'Está compartido con otras sucursales y no se puede eliminar desde este alcance.',
      );
    const selected = family.rows.find((x) => x.id === id);
    if (selected?.parent) {
      const siblings = await c.query(
        'select 1 from public.products where tenant_id=$1::uuid and presentation_parent_id=$2::uuid and not(id=any($3::uuid[])) limit 1',
        [p.tenantId, selected.parent, ids],
      );
      if (!siblings.rows.length)
        reasons.push(
          'Es la última presentación. Revisa la eliminación del producto principal para no dejar una ficha incompleta.',
        );
    }
    const assignments = await c.query(
      'select product_id::text,price::text,is_available,updated_at::text from public.branch_products where tenant_id=$1::uuid and branch_id=$2::uuid and product_id=any($3::uuid[]) order by product_id',
      [p.tenantId, p.branchId, ids],
    );
    return {
      family: family.rows,
      canDelete: reasons.length === 0,
      reasons,
      revision: digest([family.rows, assignments.rows]),
    };
  }
  async eligibility(p: StaffSessionPrincipal, id: string) {
    return this.db.withTransaction(async (c) => {
      await this.operations.authorize(c, p);
      const { family, ...result } = await this.inspect(c, p, id);
      return {
        ...result,
        products: family.map((x) => ({ id: x.id, name: x.name })),
        count: family.length,
      };
    });
  }
  async remove(p: StaffSessionPrincipal, id: string, input: unknown) {
    const data = objectInput(input, ['requestId', 'revision', 'reason']),
      reason = changeReason(data.reason);
    if (
      typeof data.requestId !== 'string' ||
      !UUID.test(data.requestId) ||
      typeof data.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.revision)
    )
      throw new BadRequestException('Recarga la ficha antes de eliminar.');
    const fingerprint = digest(['delete', id, data.revision, reason]);
    try {
      return await this.db.withTransaction(async (c) => {
        await this.operations.authorize(c, p, true);
        const prior = await this.previous(
          c,
          p,
          data.requestId as string,
          fingerprint,
        );
        if (prior) return prior;
        const check = await this.inspect(c, p, id, true);
        if (check.revision !== data.revision)
          throw new ConflictException(
            'El producto cambió. Recarga y revisa antes de eliminar.',
          );
        if (!check.canDelete)
          throw new ConflictException(check.reasons.join(' '));
        const ids = check.family.map((x) => x.id);
        // Restrictive foreign keys also protect against references committed after the check.
        await c.query(
          'delete from public.branch_products where tenant_id=$1::uuid and branch_id=$2::uuid and product_id=any($3::uuid[])',
          [p.tenantId, p.branchId, ids],
        );
        await c.query(
          'delete from public.products where tenant_id=$1::uuid and id=any($2::uuid[])',
          [p.tenantId, ids],
        );
        await this.operations.audit(
          c,
          p,
          'PRODUCT_DELETED',
          id,
          reason,
          { products: check.family.map((x) => ({ id: x.id, name: x.name })) },
          {},
        );
        const result = { deleted: true, count: ids.length };
        await this.remember(
          c,
          p,
          data.requestId as string,
          fingerprint,
          result,
        );
        return result;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23503')
        throw new ConflictException(
          'El producto recibió una nueva referencia y no se eliminó. Recarga para revisar.',
        );
      throw error;
    }
  }
}
