import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { DatabaseService } from '../core/database/database.service';
import { StaffService } from '../core/staff/staff.service';
import { subscriptionState, todayIn } from './billing-rules';
import type { PlatformPrincipal } from './platform-auth.service';

const PRODUCTS = ['COMMERCE', 'DELIVERY'] as const;
type Product = (typeof PRODUCTS)[number];
const STATUSES = ['ACTIVE', 'SUSPENDED', 'INACTIVE'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;

export interface AdminPersonInput {
  firstName?: unknown;
  lastName?: unknown;
  identityDocument?: unknown;
  phone?: unknown;
  email?: unknown;
}
export interface CreateTenantInput {
  code?: unknown;
  name?: unknown;
  branchCode?: unknown;
  branchName?: unknown;
  timezone?: unknown;
  products?: unknown;
  admin?: AdminPersonInput;
}

const str = (v: unknown) =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** Businesses (tenants) as seen by the FlashCommerce Cloud platform console. */
@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly staff: StaffService,
  ) {}

  private code(value: unknown, field: string) {
    const c = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!CODE.test(c))
      throw new BadRequestException(
        `${field}: 2 a 30 letras, números, guion o guion bajo.`,
      );
    return c;
  }
  private name(value: unknown, field: string) {
    const n = str(value);
    if (!n || n.length > 150)
      throw new BadRequestException(`${field} es obligatorio (máx. 150).`);
    return n;
  }
  private products(value: unknown): Product[] {
    if (!Array.isArray(value) || !value.length)
      throw new BadRequestException('Elige al menos un producto.');
    const set = [...new Set(value)];
    if (!set.every((p) => (PRODUCTS as readonly unknown[]).includes(p)))
      throw new BadRequestException('Producto no válido.');
    return set as Product[];
  }
  private id(value: string) {
    if (!UUID.test(value)) throw new BadRequestException('id no es válido.');
    return value;
  }
  private audit(
    client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
    actor: PlatformPrincipal,
    action: string,
    tenantId: string | null,
    details: object,
  ) {
    return client.query(
      'insert into public.platform_audit_events (actor_user_id, action, tenant_id, details) values ($1::uuid,$2,$3::uuid,$4::jsonb)',
      [actor.userId, action, tenantId, JSON.stringify(details)],
    );
  }

  async list() {
    const r = await this.db.query<{
      id: string;
      code: string;
      name: string;
      status: string;
      created_at: string;
      branches: number;
      products: string[] | null;
      staff: number;
      paid_until: string | null;
    }>(
      `select t.id::text, t.code, t.name, t.status, t.created_at::text,
              (select count(*)::int from public.branches b where b.tenant_id=t.id) as branches,
              (select array_agg(p.product order by p.product) from public.tenant_products p where p.tenant_id=t.id and p.status='ACTIVE') as products,
              (select count(*)::int from public.staff_users u where u.tenant_id=t.id) as staff,
              (select s.paid_until::text from public.tenant_subscriptions s where s.tenant_id=t.id) as paid_until
         from public.tenants t order by t.created_at desc`,
    );
    const today = todayIn();
    return {
      tenants: r.rows.map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        status: t.status,
        createdAt: t.created_at,
        branchCount: t.branches,
        products: t.products ?? [],
        staffCount: t.staff,
        paidUntil: t.paid_until,
        subscription: t.paid_until
          ? subscriptionState(t.paid_until, today)
          : null,
      })),
    };
  }

  async get(idInput: string) {
    const id = this.id(idInput);
    const t = await this.db.query<{
      id: string;
      code: string;
      name: string;
      status: string;
      created_at: string;
    }>(
      'select id::text, code, name, status, created_at::text from public.tenants where id=$1::uuid',
      [id],
    );
    if (!t.rowCount) throw new NotFoundException('Negocio no encontrado.');
    const [branches, products, audit] = await Promise.all([
      this.db.query<{
        id: string;
        code: string;
        name: string;
        status: string;
        timezone: string;
        staff: number;
      }>(
        `select b.id::text, b.code, b.name, b.status, b.timezone,
                (select count(*)::int from public.staff_user_branches ub where ub.tenant_id=b.tenant_id and ub.branch_id=b.id) as staff
           from public.branches b where b.tenant_id=$1::uuid order by b.created_at`,
        [id],
      ),
      this.db.query<{ product: string; status: string }>(
        'select product, status from public.tenant_products where tenant_id=$1::uuid',
        [id],
      ),
      this.db.query<{
        action: string;
        details: unknown;
        created_at: string;
        actor: string | null;
      }>(
        `select e.action, e.details, e.created_at::text, u.display_name as actor
           from public.platform_audit_events e left join public.platform_users u on u.id=e.actor_user_id
          where e.tenant_id=$1::uuid order by e.created_at desc limit 50`,
        [id],
      ),
    ]);
    const row = t.rows[0];
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      products: Object.fromEntries(
        PRODUCTS.map((p) => [
          p,
          products.rows.find((x) => x.product === p)?.status === 'ACTIVE',
        ]),
      ),
      branches: branches.rows.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        status: b.status,
        timezone: b.timezone,
        staffCount: b.staff,
      })),
      audit: audit.rows.map((e) => ({
        action: e.action,
        details: e.details,
        at: e.created_at,
        actor: e.actor,
      })),
    };
  }

  /**
   * Creates the business, its first branch and the contracted products in one transaction, then
   * its first ADMIN. If the admin step fails the business stays and the admin can be created later.
   */
  async create(actor: PlatformPrincipal, input: CreateTenantInput) {
    const code = this.code(input?.code, 'Código del negocio');
    const name = this.name(input?.name, 'Nombre del negocio');
    const branchCode = this.code(
      input?.branchCode ?? 'CENTRAL',
      'Código de la sucursal',
    );
    const branchName = this.name(
      input?.branchName ?? 'Sucursal Central',
      'Nombre de la sucursal',
    );
    const timezone = str(input?.timezone) ?? 'America/La_Paz';
    if (!/^[A-Za-z_]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$/.test(timezone))
      throw new BadRequestException('Zona horaria no válida.');
    const products = this.products(input?.products);
    // Validate the admin before writing anything, so a typo does not leave a business without admin.
    if (!str(input?.admin?.firstName) || !str(input?.admin?.lastName))
      throw new BadRequestException(
        'Nombre y apellido del administrador son obligatorios.',
      );

    const tenantId = await this.db.withTransaction(async (client) => {
      const exists = await client.query(
        'select 1 from public.tenants where upper(code)=$1 or slug=$2',
        [code, code.toLowerCase()],
      );
      if (exists.rowCount)
        throw new ConflictException('Ya existe un negocio con ese código.');
      const t = await client.query<{ id: string }>(
        'insert into public.tenants (code, name, slug) values ($1,$2,$3) returning id::text',
        [code, name, code.toLowerCase()],
      );
      const id = t.rows[0].id;
      await client.query(
        'insert into public.branches (tenant_id, code, name, slug, timezone) values ($1::uuid,$2,$3,$4,$5)',
        [id, branchCode, branchName, branchCode.toLowerCase(), timezone],
      );
      for (const p of PRODUCTS)
        await client.query(
          'insert into public.tenant_products (tenant_id, product, status) values ($1::uuid,$2,$3)',
          [id, p, products.includes(p) ? 'ACTIVE' : 'INACTIVE'],
        );
      await this.audit(client, actor, 'TENANT_CREATED', id, {
        code,
        name,
        branchCode,
        products,
      });
      return id;
    });
    const admin = await this.createInitialAdmin(
      actor,
      tenantId,
      input.admin ?? {},
    );
    return { ...(await this.get(tenantId)), initialAdmin: admin };
  }

  /** First ADMIN of the business's first branch; the temporary password is shown once. */
  async createInitialAdmin(
    actor: PlatformPrincipal,
    tenantIdInput: string,
    person: AdminPersonInput,
  ) {
    const tenantId = this.id(tenantIdInput);
    const r = await this.db.query<{ tenant_code: string; branch_code: string }>(
      `select t.code as tenant_code, b.code as branch_code from public.tenants t
         join public.branches b on b.tenant_id=t.id where t.id=$1::uuid order by b.created_at limit 1`,
      [tenantId],
    );
    if (!r.rowCount) throw new NotFoundException('Negocio sin sucursal.');
    const created = await this.staff.createInitialAdminForPlatform({
      tenantCode: r.rows[0].tenant_code,
      branchCode: r.rows[0].branch_code,
      firstName: str(person.firstName),
      lastName: str(person.lastName),
      identityDocument: str(person.identityDocument),
      phone: str(person.phone),
      email: str(person.email),
    });
    await this.audit(this.db, actor, 'INITIAL_ADMIN_CREATED', tenantId, {
      userCode: created.credentials.userCode,
    });
    return {
      tenantCode: r.rows[0].tenant_code,
      branchCode: r.rows[0].branch_code,
      userCode: created.credentials.userCode,
      temporaryPassword: created.credentials.temporaryPassword,
      displayName: created.user.displayName,
    };
  }

  async setStatus(
    actor: PlatformPrincipal,
    idInput: string,
    input: { status?: unknown; reason?: unknown },
  ) {
    const id = this.id(idInput);
    const status = input?.status;
    if (!(STATUSES as readonly unknown[]).includes(status))
      throw new BadRequestException('Estado no válido.');
    const reason = str(input?.reason)?.slice(0, 300) ?? null;
    if (status !== 'ACTIVE' && !reason)
      throw new BadRequestException('Indica el motivo.');
    await this.db.withTransaction(async (client) => {
      const r = await client.query<{ status: string }>(
        'select status from public.tenants where id=$1::uuid for update',
        [id],
      );
      if (!r.rowCount) throw new NotFoundException('Negocio no encontrado.');
      if (r.rows[0].status === status) return;
      await client.query(
        'update public.tenants set status=$2, updated_at=now() where id=$1::uuid',
        [id, status],
      );
      if (status !== 'ACTIVE')
        await client.query(
          'update public.staff_sessions set revoked_at=now() where tenant_id=$1::uuid and revoked_at is null',
          [id],
        );
      await this.audit(client, actor, 'TENANT_STATUS_CHANGED', id, {
        from: r.rows[0].status,
        to: status,
        reason,
      });
    });
    return this.get(id);
  }

  async setProducts(
    actor: PlatformPrincipal,
    idInput: string,
    input: { products?: unknown },
  ) {
    const id = this.id(idInput);
    const products = this.products(input?.products);
    await this.db.withTransaction(async (client) => {
      const r = await client.query(
        'select 1 from public.tenants where id=$1::uuid for update',
        [id],
      );
      if (!r.rowCount) throw new NotFoundException('Negocio no encontrado.');
      for (const p of PRODUCTS)
        await client.query(
          `insert into public.tenant_products (tenant_id, product, status) values ($1::uuid,$2,$3)
           on conflict (tenant_id, product) do update set status=excluded.status, updated_at=now()`,
          [id, p, products.includes(p) ? 'ACTIVE' : 'INACTIVE'],
        );
      await this.audit(client, actor, 'TENANT_PRODUCTS_CHANGED', id, {
        products,
      });
    });
    return this.get(id);
  }
}
