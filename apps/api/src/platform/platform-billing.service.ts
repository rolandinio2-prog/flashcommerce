import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import type { PoolClient } from 'pg';

import { DatabaseService } from '../core/database/database.service';
import {
  GRACE_DAYS,
  WARN_DAYS,
  addDays,
  extendPaidUntil,
  isDate,
  monthlyAmount,
  subscriptionState,
  todayIn,
} from './billing-rules';
import type { PlatformPrincipal } from './platform-auth.service';

const PRODUCTS = ['COMMERCE', 'DELIVERY'] as const;
const METHODS = ['CASH', 'TRANSFER', 'QR', 'OTHER'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cents = (n: number) => Math.round(n * 100) / 100;
type Query = { query: (text: string, values?: unknown[]) => Promise<unknown> };

function money(
  value: unknown,
  field: string,
  allowNull = false,
): number | null {
  if (allowNull && (value === null || value === '' || value === undefined))
    return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1_000_000)
    throw new BadRequestException(`${field} no es válido.`);
  return cents(n);
}
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/**
 * R4b: manual subscription billing. Prices per product, a paid_until date per business, payments
 * recorded by a platform operator, and the automatic suspension once the grace period ends.
 */
@Injectable()
export class PlatformBillingService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PlatformBillingService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = false;

  constructor(private readonly db: DatabaseService) {}

  onApplicationBootstrap(): void {
    if (process.env.PLATFORM_BILLING_SCHEDULER === 'off') return;
    // Hourly, so a suspension happens within an hour of the grace period ending.
    this.timer = setInterval(() => void this.runOnce(), 60 * 60_000);
    this.timer.unref();
    setTimeout(() => void this.runOnce(), 30_000).unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  runOnce() {
    if (this.stopped) return Promise.resolve(0);
    if (this.running) return this.running;
    const work = this.suspendOverdue()
      .catch((e: unknown) => {
        this.logger.error(
          `PLATFORM_BILLING_SUSPEND_FAILED: ${e instanceof Error ? e.message : 'unknown'}`,
        );
        return 0;
      })
      .finally(() => (this.running = undefined));
    this.running = work;
    return work;
  }

  private audit(
    client: Query,
    actor: PlatformPrincipal | null,
    action: string,
    tenantId: string,
    details: object,
  ) {
    return client.query(
      'insert into public.platform_audit_events (actor_user_id, action, tenant_id, details) values ($1::uuid,$2,$3::uuid,$4::jsonb)',
      [actor?.userId ?? null, action, tenantId, JSON.stringify(details)],
    );
  }

  private id(value: string) {
    if (!UUID.test(value)) throw new BadRequestException('id no es válido.');
    return value;
  }

  // ---------------------------------------------------------------- prices

  async getPrices() {
    const r = await this.db.query<{
      product: string;
      monthly_price: string;
      currency: string;
    }>(
      'select product, monthly_price::text, currency from public.platform_product_prices order by product',
    );
    return {
      currency: r.rows[0]?.currency ?? 'BOB',
      prices: Object.fromEntries(
        r.rows.map((p) => [p.product, Number(p.monthly_price)]),
      ) as Record<string, number>,
    };
  }

  async setPrices(
    actor: PlatformPrincipal,
    input: { prices?: Record<string, unknown> },
  ) {
    const prices = input?.prices ?? {};
    const entries = PRODUCTS.filter((p) => p in prices).map(
      (p) => [p, money(prices[p], `Precio de ${p}`)] as const,
    );
    if (!entries.length)
      throw new BadRequestException('Indica al menos un precio.');
    await this.db.withTransaction(async (client) => {
      for (const [p, v] of entries)
        await client.query(
          'update public.platform_product_prices set monthly_price=$2, updated_at=now() where product=$1',
          [p, v],
        );
      await client.query(
        "insert into public.platform_audit_events (actor_user_id, action, details) values ($1::uuid, 'PRICES_CHANGED', $2::jsonb)",
        [actor.userId, JSON.stringify(Object.fromEntries(entries))],
      );
    });
    return this.getPrices();
  }

  // ---------------------------------------------------------- subscription

  async subscription(tenantIdInput: string) {
    const tenantId = this.id(tenantIdInput);
    const [sub, products, prices, payments] = await Promise.all([
      this.db.query<{
        paid_until: string;
        monthly_price_override: string | null;
        notes: string | null;
      }>(
        'select paid_until::text, monthly_price_override::text, notes from public.tenant_subscriptions where tenant_id=$1::uuid',
        [tenantId],
      ),
      this.db.query<{ product: string }>(
        "select product from public.tenant_products where tenant_id=$1::uuid and status='ACTIVE'",
        [tenantId],
      ),
      this.getPrices(),
      this.db.query<{
        id: string;
        amount: string;
        months: number;
        method: string;
        reference: string | null;
        paid_until_before: string;
        paid_until_after: string;
        created_at: string;
        voided_at: string | null;
        void_reason: string | null;
        operator: string | null;
      }>(
        `select p.id::text, p.amount::text, p.months, p.method, p.reference, p.paid_until_before::text, p.paid_until_after::text,
                p.created_at::text, p.voided_at::text, p.void_reason, u.display_name as operator
           from public.tenant_subscription_payments p left join public.platform_users u on u.id=p.created_by_platform_user_id
          where p.tenant_id=$1::uuid order by p.created_at desc limit 50`,
        [tenantId],
      ),
    ]);
    const override = sub.rows[0]?.monthly_price_override;
    const monthly = monthlyAmount(
      prices.prices,
      products.rows.map((p) => p.product),
      override == null ? null : Number(override),
    );
    const today = todayIn();
    const base = {
      currency: prices.currency,
      monthlyAmount: monthly,
      monthlyPriceOverride: override == null ? null : Number(override),
      graceDays: GRACE_DAYS,
      warnDays: WARN_DAYS,
      payments: payments.rows.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        months: p.months,
        method: p.method,
        reference: p.reference,
        paidUntilBefore: p.paid_until_before,
        paidUntilAfter: p.paid_until_after,
        createdAt: p.created_at,
        voidedAt: p.voided_at,
        voidReason: p.void_reason,
        operator: p.operator,
      })),
    };
    if (!sub.rowCount)
      return {
        ...base,
        exempt: true as const,
        paidUntil: null,
        state: null,
        daysLeft: null,
        notes: null,
      };
    const paidUntil = sub.rows[0].paid_until;
    return {
      ...base,
      exempt: false as const,
      paidUntil,
      suspendsOn: addDays(paidUntil, GRACE_DAYS + 1),
      notes: sub.rows[0].notes,
      ...subscriptionState(paidUntil, today),
    };
  }

  /** Starts (or edits) billing for a business: the date it is paid through and an optional price. */
  async assign(
    actor: PlatformPrincipal,
    tenantIdInput: string,
    input: {
      paidUntil?: unknown;
      monthlyPriceOverride?: unknown;
      notes?: unknown;
    },
  ) {
    const tenantId = this.id(tenantIdInput);
    if (!isDate(input?.paidUntil))
      throw new BadRequestException('Fecha de vencimiento no válida.');
    const override = money(
      input?.monthlyPriceOverride,
      'Precio especial',
      true,
    );
    const notes = text(input?.notes, 500);
    await this.db.withTransaction(async (client) => {
      const t = await client.query(
        'select 1 from public.tenants where id=$1::uuid for update',
        [tenantId],
      );
      if (!t.rowCount) throw new NotFoundException('Negocio no encontrado.');
      await client.query(
        `insert into public.tenant_subscriptions (tenant_id, paid_until, monthly_price_override, notes) values ($1::uuid,$2::date,$3,$4)
         on conflict (tenant_id) do update set paid_until=excluded.paid_until, monthly_price_override=excluded.monthly_price_override,
           notes=excluded.notes, updated_at=now()`,
        [tenantId, input.paidUntil, override, notes],
      );
      await this.audit(client, actor, 'SUBSCRIPTION_ASSIGNED', tenantId, {
        paidUntil: input.paidUntil,
        monthlyPriceOverride: override,
      });
    });
    return this.subscription(tenantId);
  }

  /** Back to exempt: the business is no longer billed nor auto-suspended. */
  async exempt(actor: PlatformPrincipal, tenantIdInput: string) {
    const tenantId = this.id(tenantIdInput);
    await this.db.withTransaction(async (client) => {
      const r = await client.query(
        'delete from public.tenant_subscriptions where tenant_id=$1::uuid',
        [tenantId],
      );
      if (r.rowCount)
        await this.audit(client, actor, 'SUBSCRIPTION_EXEMPTED', tenantId, {});
    });
    return this.subscription(tenantId);
  }

  async recordPayment(
    actor: PlatformPrincipal,
    tenantIdInput: string,
    input: {
      months?: unknown;
      amount?: unknown;
      method?: unknown;
      reference?: unknown;
    },
  ) {
    const tenantId = this.id(tenantIdInput);
    const months =
      typeof input?.months === 'string' ? Number(input.months) : input?.months;
    if (
      typeof months !== 'number' ||
      !Number.isInteger(months) ||
      months < 1 ||
      months > 24
    )
      throw new BadRequestException('Meses: de 1 a 24.');
    const amount = money(input?.amount, 'Monto')!;
    if (!(METHODS as readonly unknown[]).includes(input?.method))
      throw new BadRequestException('Forma de pago no válida.');
    const reference = text(input?.reference, 120);
    const today = todayIn();
    await this.db.withTransaction(async (client) => {
      const s = await client.query<{ paid_until: string }>(
        'select paid_until::text from public.tenant_subscriptions where tenant_id=$1::uuid for update',
        [tenantId],
      );
      if (!s.rowCount)
        throw new ConflictException(
          'Asigna primero la suscripción (fecha de vencimiento) a este negocio.',
        );
      const before = s.rows[0].paid_until;
      const after = extendPaidUntil(before, today, months);
      await client.query(
        `insert into public.tenant_subscription_payments
           (tenant_id, amount, months, method, reference, paid_until_before, paid_until_after, created_by_platform_user_id)
         values ($1::uuid,$2,$3,$4,$5,$6::date,$7::date,$8::uuid)`,
        [
          tenantId,
          amount,
          months,
          input.method,
          reference,
          before,
          after,
          actor.userId,
        ],
      );
      await client.query(
        'update public.tenant_subscriptions set paid_until=$2::date, updated_at=now() where tenant_id=$1::uuid',
        [tenantId, after],
      );
      await this.audit(client, actor, 'PAYMENT_RECORDED', tenantId, {
        amount,
        months,
        method: input.method,
        paidUntil: after,
      });
      await this.reactivateIfAutoSuspended(client, actor, tenantId);
    });
    return this.subscription(tenantId);
  }

  /** Only the latest payment can be voided, and it restores the previous paid_until. */
  async voidPayment(
    actor: PlatformPrincipal,
    tenantIdInput: string,
    paymentIdInput: string,
    input: { reason?: unknown },
  ) {
    const tenantId = this.id(tenantIdInput);
    const paymentId = this.id(paymentIdInput);
    const reason = text(input?.reason, 300);
    if (!reason)
      throw new BadRequestException('Indica el motivo de la anulación.');
    await this.db.withTransaction(async (client) => {
      const s = await client.query<{ paid_until: string }>(
        'select paid_until::text from public.tenant_subscriptions where tenant_id=$1::uuid for update',
        [tenantId],
      );
      const latest = await client.query<{
        id: string;
        paid_until_before: string;
        paid_until_after: string;
      }>(
        `select id::text, paid_until_before::text, paid_until_after::text from public.tenant_subscription_payments
          where tenant_id=$1::uuid and voided_at is null order by created_at desc limit 1`,
        [tenantId],
      );
      const p = latest.rows[0];
      if (!s.rowCount || !p || p.id !== paymentId)
        throw new ConflictException(
          'Solo se puede anular el último pago registrado.',
        );
      if (s.rows[0].paid_until !== p.paid_until_after)
        throw new ConflictException(
          'La fecha de vencimiento cambió después de este pago; corrígela a mano.',
        );
      await client.query(
        'update public.tenant_subscription_payments set voided_at=now(), void_reason=$2 where id=$1::uuid',
        [paymentId, reason],
      );
      await client.query(
        'update public.tenant_subscriptions set paid_until=$2::date, updated_at=now() where tenant_id=$1::uuid',
        [tenantId, p.paid_until_before],
      );
      await this.audit(client, actor, 'PAYMENT_VOIDED', tenantId, {
        reason,
        paidUntil: p.paid_until_before,
      });
    });
    return this.subscription(tenantId);
  }

  private async reactivateIfAutoSuspended(
    client: PoolClient,
    actor: PlatformPrincipal,
    tenantId: string,
  ) {
    const r = await client.query<{ status: string; last: string | null }>(
      `select t.status, (select e.action from public.platform_audit_events e
                          where e.tenant_id=t.id and e.action in ('TENANT_STATUS_CHANGED','TENANT_AUTO_SUSPENDED')
                          order by e.created_at desc limit 1) as last
         from public.tenants t where t.id=$1::uuid for update of t`,
      [tenantId],
    );
    const row = r.rows[0];
    // A suspension decided by an operator is not lifted by a payment; only the automatic one.
    if (row?.status !== 'SUSPENDED' || row.last !== 'TENANT_AUTO_SUSPENDED')
      return;
    const s = await client.query<{ paid_until: string }>(
      'select paid_until::text from public.tenant_subscriptions where tenant_id=$1::uuid',
      [tenantId],
    );
    if (subscriptionState(s.rows[0].paid_until, todayIn()).state === 'OVERDUE')
      return;
    await client.query(
      "update public.tenants set status='ACTIVE', updated_at=now() where id=$1::uuid",
      [tenantId],
    );
    await this.audit(client, actor, 'TENANT_AUTO_REACTIVATED', tenantId, {
      reason: 'Pago registrado',
    });
  }

  /** Suspends every billed, active business whose grace period has ended. Idempotent. */
  async suspendOverdue(): Promise<number> {
    return this.db.withTransaction(async (client) => {
      await client.query("set local lock_timeout='2s'");
      const lock = await client.query<{ ok: boolean }>(
        "select pg_try_advisory_xact_lock(hashtext('platform_billing_suspend_v1')) as ok",
      );
      if (!lock.rows[0]?.ok || this.stopped) return 0;
      const due = await client.query<{ id: string; paid_until: string }>(
        `select t.id::text, s.paid_until::text from public.tenants t join public.tenant_subscriptions s on s.tenant_id=t.id
          where t.status='ACTIVE' and s.paid_until < $1::date for update of t`,
        [addDays(todayIn(), -GRACE_DAYS)],
      );
      for (const t of due.rows) {
        await client.query(
          "update public.tenants set status='SUSPENDED', updated_at=now() where id=$1::uuid",
          [t.id],
        );
        await client.query(
          'update public.staff_sessions set revoked_at=now() where tenant_id=$1::uuid and revoked_at is null',
          [t.id],
        );
        await this.audit(client, null, 'TENANT_AUTO_SUSPENDED', t.id, {
          reason: `Suscripción vencida el ${t.paid_until} (${GRACE_DAYS} días de gracia)`,
          paidUntil: t.paid_until,
        });
      }
      if (due.rowCount)
        this.logger.log(`PLATFORM_AUTO_SUSPENDED tenants=${due.rowCount}`);
      return due.rowCount ?? 0;
    });
  }
}
