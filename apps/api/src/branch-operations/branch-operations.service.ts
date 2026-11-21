import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { StaffSessionPrincipal } from '../staff/staff.types';
import {
  defaultStates,
  parseStates,
  SERVICE_KEYS,
  SERVICE_LABELS,
  validateTransition,
  type ServiceKey,
  type ServiceStates,
} from './service-policy';
const AUTH_BRANCH = `select b.id::text,b.delivery_enabled from public.branches b join public.tenants t on t.id=b.tenant_id
 join public.staff_user_branches sb on sb.tenant_id=b.tenant_id and sb.branch_id=b.id and sb.user_id=$3::uuid
 join public.staff_users u on u.tenant_id=sb.tenant_id and u.id=sb.user_id
 join public.staff_sessions s on s.tenant_id=sb.tenant_id and s.branch_id=sb.branch_id and s.user_id=sb.user_id and s.id=$4::uuid
 where b.tenant_id=$1::uuid and b.id=$2::uuid and b.status='ACTIVE' and t.status='ACTIVE'
 and sb.status='ACTIVE' and sb.role='ADMIN' and u.status='ACTIVE' and u.password_change_required=false
 and s.revoked_at is null and s.expires_at>now()`;
const PRODUCTS = `select bp.product_id::text,p.name,c.name as category,c.slug as category_slug,
 bp.price::text,bp.currency,bp.is_available,bp.updated_at::text as updated
 from public.branch_products bp join public.products p on p.tenant_id=bp.tenant_id and p.id=bp.product_id
 join public.product_categories c on c.tenant_id=p.tenant_id and c.id=p.category_id
 where bp.tenant_id=$1::uuid and bp.branch_id=$2::uuid and p.active=true and c.active=true`;
type ProductRow = {
  product_id: string;
  name: string;
  category: string;
  category_slug: string;
  price: string;
  currency: string;
  is_available: boolean;
  updated: string;
};
export function objectInput(input: unknown, keys: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Datos inválidos.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((k) => !keys.includes(k)))
    throw new BadRequestException('Campos no permitidos.');
  return value;
}
export function changeReason(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.trim().length < 5 ||
    value.trim().length > 200 ||
    // eslint-disable-next-line no-control-regex -- intentionally rejects control characters in user/provider input
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new BadRequestException(
      'Escribe un motivo de 5 a 200 caracteres, sin datos personales.',
    );
  return value.trim();
}
export function priceInput(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,5})(\.\d{1,2})?$/.test(value) ||
    Number(value) <= 0
  )
    throw new BadRequestException(
      'Indica un precio mayor que cero con hasta dos decimales.',
    );
  return Number(value).toFixed(2);
}
export function productRevision(row: ProductRow) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.product_id,
        row.price,
        row.currency,
        row.is_available,
        row.updated,
      ]),
    )
    .digest('hex');
}
@Injectable()
export class BranchOperationsService {
  constructor(private readonly db: DatabaseService) {}
  async authorize(c: PoolClient, p: StaffSessionPrincipal, write = false) {
    if (p.role !== 'ADMIN' || p.passwordChangeRequired)
      throw new ForbiddenException(
        'Solo un administrador puede configurar la sucursal.',
      );
    const r = await c.query<{ id: string; delivery_enabled: boolean }>(
      AUTH_BRANCH +
        (write
          ? ' FOR UPDATE OF b FOR SHARE OF t,sb,u,s'
          : ' FOR SHARE OF b,t,sb,u,s'),
      [p.tenantId, p.branchId, p.userId, p.sessionId],
    );
    if (!r.rows[0])
      throw new ForbiddenException('Sesión administrativa no disponible.');
    return r.rows[0];
  }
  private async settings(c: PoolClient, tenant: string, branch: string) {
    const r = await c.query<{ revision: string; states: ServiceStates }>(
      'select revision::text,states from public.branch_service_settings where tenant_id=$1::uuid and branch_id=$2::uuid',
      [tenant, branch],
    );
    return r.rows[0]
      ? { revision: r.rows[0].revision, states: parseStates(r.rows[0].states) }
      : { revision: '0', states: defaultStates() };
  }
  private async active(c: PoolClient, tenant: string, branch: string) {
    const orders = await c.query<{ order_type: string; count: string }>(
      `select order_type,count(*)::text as count from public.orders where tenant_id=$1::uuid and branch_id=$2::uuid and status not in ('COMPLETED','CANCELLED') group by order_type`,
      [tenant, branch],
    );
    const reservations = await c.query<{ count: string }>(
      `select count(*)::text as count from public.table_reservations where tenant_id=$1::uuid and branch_id=$2::uuid and status in ('PENDING','CONFIRMED','SEATED')`,
      [tenant, branch],
    );
    const sessions = await c.query<{ count: string }>(
      `select count(*)::text as count from public.table_sessions where tenant_id=$1::uuid and branch_id=$2::uuid and status='OPEN'`,
      [tenant, branch],
    );
    const counts = Object.fromEntries(
      SERVICE_KEYS.map((k) => [k, 0]),
    ) as Record<ServiceKey, number>;
    for (const r of orders.rows) {
      counts.ORDERING += Number(r.count);
      if (SERVICE_KEYS.includes(r.order_type as ServiceKey))
        counts[r.order_type as ServiceKey] += Number(r.count);
    }
    counts.RESERVATIONS = Number(reservations.rows[0]?.count ?? 0);
    counts.DINE_IN +=
      counts.RESERVATIONS + Number(sessions.rows[0]?.count ?? 0);
    return counts;
  }
  async getServices(p: StaffSessionPrincipal) {
    return this.db.withTransaction(async (c) => {
      const branch = await this.authorize(c, p),
        settings = await this.settings(c, p.tenantId, p.branchId);
      return {
        tenantCode: p.tenantCode,
        branchCode: p.branchCode,
        ...settings,
        labels: SERVICE_LABELS,
        active: await this.active(c, p.tenantId, p.branchId),
        deliveryConfigured: branch.delivery_enabled,
      };
    });
  }
  async saveServices(p: StaffSessionPrincipal, input: unknown) {
    const data = objectInput(input, ['revision', 'states', 'reason']),
      states = parseStates(data.states),
      reason = changeReason(data.reason);
    if (typeof data.revision !== 'string' || !/^\d{1,19}$/.test(data.revision))
      throw new BadRequestException('Recarga la configuración.');
    return this.db.withTransaction(async (c) => {
      const branch = await this.authorize(c, p, true),
        before = await this.settings(c, p.tenantId, p.branchId);
      if (before.revision !== data.revision)
        throw new ConflictException(
          'La configuración cambió en otra sesión. Recarga y revisa antes de guardar.',
        );
      validateTransition(
        before.states,
        states,
        await this.active(c, p.tenantId, p.branchId),
      );
      if (
        states.DELIVERY === 'ENABLED' &&
        before.states.DELIVERY !== 'ENABLED' &&
        !branch.delivery_enabled
      )
        throw new ConflictException(
          'Delivery requiere configuración operativa de la sucursal.',
        );
      const result = await c.query<{ revision: string }>(
        `insert into public.branch_service_settings(tenant_id,branch_id,states) values($1::uuid,$2::uuid,$3::jsonb)
    on conflict(tenant_id,branch_id) do update set states=excluded.states,revision=branch_service_settings.revision+1,updated_at=clock_timestamp() returning revision::text`,
        [p.tenantId, p.branchId, JSON.stringify(states)],
      );
      await this.audit(c, p, 'SERVICES_UPDATED', null, reason, before, {
        revision: result.rows[0].revision,
        states,
      });
      return { revision: result.rows[0].revision, states };
    });
  }
  async publicServices(tenant: string | undefined, branch: string | undefined) {
    if (
      !tenant ||
      !branch ||
      ![tenant, branch].every((v) => /^[A-Za-z0-9_-]{1,80}$/.test(v))
    )
      throw new BadRequestException('Sucursal inválida.');
    const r = await this.db.query<{
      delivery_enabled: boolean;
      states: ServiceStates | null;
    }>(
      `select b.delivery_enabled,s.states from public.branches b join public.tenants t on t.id=b.tenant_id
   left join public.branch_service_settings s on s.tenant_id=b.tenant_id and s.branch_id=b.id
   where t.code=$1 and b.code=$2 and t.status='ACTIVE' and b.status='ACTIVE'`,
      [tenant, branch],
    );
    if (!r.rows[0]) throw new NotFoundException('Sucursal no disponible.');
    const row = r.rows[0],
      states = row.states ? parseStates(row.states) : defaultStates();
    return {
      available: Object.fromEntries(
        SERVICE_KEYS.map((k) => [
          k,
          states[k] === 'ENABLED' && (k !== 'DELIVERY' || row.delivery_enabled),
        ]),
      ) as Record<ServiceKey, boolean>,
    };
  }
  async getProducts(p: StaffSessionPrincipal) {
    return this.db.withTransaction(async (c) => {
      await this.authorize(c, p);
      const r = await c.query<ProductRow>(
        PRODUCTS + ' order by c.sort_order,p.name',
        [p.tenantId, p.branchId],
      );
      return {
        products: r.rows.map((row) => ({
          id: row.product_id,
          name: row.name,
          category: row.category,
          price: row.price,
          currency: row.currency,
          available: row.is_available,
          priceLocked: row.category_slug === 'salsas',
          revision: productRevision(row),
        })),
      };
    });
  }
  async saveProduct(p: StaffSessionPrincipal, id: string, input: unknown) {
    const data = objectInput(input, [
        'revision',
        'price',
        'available',
        'reason',
      ]),
      price = priceInput(data.price),
      reason = changeReason(data.reason);
    if (
      typeof data.available !== 'boolean' ||
      typeof data.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.revision)
    )
      throw new BadRequestException('Datos de producto inválidos.');
    return this.db.withTransaction(async (c) => {
      await this.authorize(c, p, true);
      const r = await c.query<ProductRow>(
          PRODUCTS + ' and bp.product_id=$3::uuid for update of bp',
          [p.tenantId, p.branchId, id],
        ),
        row = r.rows[0];
      if (!row)
        throw new NotFoundException('Producto no disponible en esta sucursal.');
      if (productRevision(row) !== data.revision)
        throw new ConflictException(
          'El producto cambió. Recarga el catálogo antes de guardar.',
        );
      if (row.category_slug === 'salsas' && Number(price) !== Number(row.price))
        throw new ConflictException(
          'El precio adicional de salsas pertenece a la regla de dos incluidas y Bs 7 por adicional.',
        );
      await c.query(
        'update public.branch_products set price=$4::numeric,is_available=$5,updated_at=clock_timestamp() where tenant_id=$1::uuid and branch_id=$2::uuid and product_id=$3::uuid',
        [p.tenantId, p.branchId, id, price, data.available],
      );
      await this.audit(
        c,
        p,
        'PRODUCT_UPDATED',
        id,
        reason,
        {
          price: row.price,
          available: row.is_available,
          revision: data.revision,
        },
        { price, available: data.available },
      );
      return { saved: true };
    });
  }
  audit(
    c: PoolClient,
    p: StaffSessionPrincipal,
    action: string,
    target: string | null,
    reason: string,
    before: unknown,
    after: unknown,
  ) {
    return c.query(
      `insert into public.branch_operations_audit(tenant_id,branch_id,actor_id,action,target_id,reason,before_value,after_value)
   values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7::jsonb,$8::jsonb)`,
      [
        p.tenantId,
        p.branchId,
        p.userId,
        action,
        target,
        reason,
        JSON.stringify(before),
        JSON.stringify(after),
      ],
    );
  }
}
