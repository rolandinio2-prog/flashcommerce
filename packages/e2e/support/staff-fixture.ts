import { createHash, randomBytes } from 'node:crypto';

import pg from 'pg';

import { assertLocalDatabase, env } from './env';

/** Must match apps/api/src/core/staff/staff.service.ts. */
export const STAFF_SESSION_COOKIE = 'flash_staff_session';

export interface StaffSessionHandle {
  label: string;
  userId: string;
  sessionId: string;
  /** Raw cookie value. Only lives in memory for the duration of the test. */
  token: string;
}

/**
 * Creates temporary staff users with an active session directly in the
 * database, mirroring the API's own token hashing (sha256 hex). This avoids
 * consuming real login attempts and keeps each test deterministic.
 *
 * All rows are tagged with a per-run user_code prefix and removed in dispose().
 */
export class StaffFixture {
  private readonly client: pg.Client;
  private readonly runTag = randomBytes(2).toString('hex').toUpperCase();
  private readonly created: string[] = [];
  private tenantId = '';
  private branchId = '';

  private constructor() {
    this.client = new pg.Client({ connectionString: env.databaseUrl });
  }

  static async open(): Promise<StaffFixture> {
    assertLocalDatabase();
    const fixture = new StaffFixture();
    await fixture.client.connect();
    const scope = await fixture.client.query<{ tenant_id: string; branch_id: string }>(
      `select t.id::text as tenant_id, b.id::text as branch_id
         from public.tenants t
         join public.branches b on b.tenant_id = t.id
        where upper(t.code) = $1 and upper(b.code) = $2`,
      [env.tenantCode, env.branchCode],
    );
    if (!scope.rows[0]) {
      await fixture.client.end();
      throw new Error(`Tenant/branch ${env.tenantCode}/${env.branchCode} not found in the test database.`);
    }
    fixture.tenantId = scope.rows[0].tenant_id;
    fixture.branchId = scope.rows[0].branch_id;
    return fixture;
  }

  /** A MANAGER session that can open the Delivery Monitor. */
  async createManagerSession(label: string, role: 'MANAGER' | 'ADMIN' = 'MANAGER'): Promise<StaffSessionHandle> {
    // user_code must match ^[A-Z]{3}-[A-Z0-9]{6}$
    // QAE = automated QA/E2E user; prefix must be letters only.
    const userCode = `QAE-${this.runTag}${String(this.created.length).padStart(2, '0')}`;
    const user = await this.client.query<{ id: string }>(
      `insert into public.staff_users
         (tenant_id, user_code, first_name, last_name, password_hash, status, password_change_required)
       values ($1, $2, 'E2E', $3, 'scrypt$disabled$disabled', 'ACTIVE', false)
       returning id::text`,
      [this.tenantId, userCode, label],
    );
    const userId = user.rows[0].id;
    this.created.push(userId);
    await this.client.query(
      `insert into public.staff_user_branches (tenant_id, branch_id, user_id, role, status)
       values ($1, $2, $3, $4, 'ACTIVE')`,
      [this.tenantId, this.branchId, userId, role],
    );
    const token = randomBytes(32).toString('base64url');
    const session = await this.client.query<{ id: string }>(
      `insert into public.staff_sessions (tenant_id, branch_id, user_id, token_hash, expires_at)
       values ($1, $2, $3, $4, now() + interval '1 hour')
       returning id::text`,
      [this.tenantId, this.branchId, userId, createHash('sha256').update(token).digest('hex')],
    );
    return { label, userId, sessionId: session.rows[0].id, token };
  }

  private readonly probeLocationIds: string[] = [];

  /**
   * Publishes a movement through the REAL path: inserts a driver location for
   * the latest delivery so the database trigger fans it out to every eligible
   * staff session topic. The point repeats the delivery's latest position and
   * carries a unique accuracy value as marker; it is deleted in dispose().
   * Returns the marker text to look for in received frames.
   */
  async publishLocationProbe(): Promise<string> {
    // accuracy_meters keeps 2 decimals; a random 2-decimal value (1.01-29.99) is the marker.
    const accuracy = (1 + Math.floor(Math.random() * 2898 + 1) / 100).toFixed(2);
    const inserted = await this.client.query<{ id: string }>(
      `insert into public.delivery_driver_locations
         (tenant_id, branch_id, delivery_id, driver_id, position, accuracy_meters, captured_at, received_at)
       select l.tenant_id, l.branch_id, l.delivery_id, l.driver_id, l.position,
              $3::numeric, now(), now()
         from public.delivery_driver_locations l
        where l.tenant_id = $1 and l.branch_id = $2
        order by l.captured_at desc limit 1
       returning id::text`,
      [this.tenantId, this.branchId, accuracy],
    );
    if (!inserted.rows[0]) {
      throw new Error('No driver location exists in the test branch: live-delivery checks replay the latest one (seed data).');
    }
    this.probeLocationIds.push(inserted.rows[0].id);
    return String(Number(accuracy));
  }

  /** Tracking token of the most recent order of the test branch (read-only), for page smoke tests. */
  async latestTrackingToken(): Promise<string | null> {
    const r = await this.client.query<{ token: string }>(
      `select tracking_token::text as token from public.orders
        where tenant_id = $1 and branch_id = $2 and tracking_token is not null
        order by created_at desc limit 1`,
      [this.tenantId, this.branchId],
    );
    return r.rows[0]?.token ?? null;
  }

  /** Order and payment status by public order number (read-only), for checkout tests. */
  async orderState(orderNumber: number): Promise<{ orderStatus: string; orderType: string; total: string; paymentStatus: string | null } | null> {
    const r = await this.client.query<{ orderStatus: string; orderType: string; total: string; paymentStatus: string | null }>(
      `select o.status as "orderStatus", o.order_type as "orderType", o.total::text as total,
              (select p.status from public.order_payments p where p.order_id = o.id order by p.created_at desc limit 1) as "paymentStatus"
         from public.orders o where o.tenant_id = $1 and o.branch_id = $2 and o.order_number = $3`,
      [this.tenantId, this.branchId, orderNumber],
    );
    return r.rows[0] ?? null;
  }

  /** A point inside the branch's first active delivery zone (courier tests). */
  async deliveryZonePoint(): Promise<{ latitude: number; longitude: number } | null> {
    const r = await this.client.query<{ latitude: number; longitude: number }>(
      `select gis.ST_Y(p)::float8 as latitude, gis.ST_X(p)::float8 as longitude
         from (select gis.ST_PointOnSurface(z.area::gis.geometry) as p
                 from public.delivery_zones z
                where z.tenant_id = $1 and z.branch_id = $2 and z.status = 'ACTIVE'
                order by z.priority, z.code limit 1) s`,
      [this.tenantId, this.branchId],
    );
    return r.rows[0] ?? null;
  }

  /** Delivery state of a courier request by order number (read-only). */
  async courierDeliveryState(orderNumber: number): Promise<{ origin: string; orderStatus: string; deliveryStatus: string; fee: string; pickupName: string | null } | null> {
    const r = await this.client.query<{ origin: string; orderStatus: string; deliveryStatus: string; fee: string; pickupName: string | null }>(
      `select o.order_origin as origin, o.status as "orderStatus", d.status as "deliveryStatus",
              d.quoted_delivery_fee::text as fee, d.pickup_name as "pickupName"
         from public.orders o join public.deliveries d on d.order_id = o.id
        where o.tenant_id = $1 and o.branch_id = $2 and o.order_number = $3`,
      [this.tenantId, this.branchId, orderNumber],
    );
    return r.rows[0] ?? null;
  }

  private readonly driverIds: string[] = [];

  /**
   * D1c: a temporary driver for payout tests. It is INACTIVE with a DISABLED
   * branch membership, so real dispatch never offers it work. Removed in dispose().
   */
  async createPayoutDriver(): Promise<string> {
    const code = `QAE${this.runTag}D${this.driverIds.length}`;
    const r = await this.client.query<{ id: string }>(
      `insert into public.delivery_drivers (tenant_id, code, display_name, phone, status)
       values ($1, $2, $3, '70000001', 'INACTIVE') returning id::text`,
      [this.tenantId, code, `E2E Driver ${code}`],
    );
    const id = r.rows[0].id;
    this.driverIds.push(id);
    await this.client.query(
      `insert into public.delivery_driver_branches (tenant_id, branch_id, driver_id, status) values ($1, $2, $3, 'DISABLED')`,
      [this.tenantId, this.branchId, id],
    );
    return id;
  }

  /** D1c: marks a courier request as delivered by the given driver (releases any live assignment first). */
  async completeDelivery(orderNumber: number, driverId: string): Promise<void> {
    const d = await this.client.query<{ id: string }>(
      `select d.id::text from public.deliveries d join public.orders o on o.id = d.order_id
        where o.tenant_id = $1 and o.branch_id = $2 and o.order_number = $3`,
      [this.tenantId, this.branchId, orderNumber],
    );
    const deliveryId = d.rows[0]?.id;
    if (!deliveryId) throw new Error(`completeDelivery: order ${orderNumber} has no delivery`);
    await this.client.query('begin');
    try {
      await this.client.query(
        `update public.delivery_assignments set status = 'RELEASED', released_at = now(), release_reason = 'e2e settlement test'
          where delivery_id = $1 and status in ('ASSIGNED', 'ACCEPTED')`,
        [deliveryId],
      );
      await this.client.query(
        `insert into public.delivery_assignments (tenant_id, branch_id, delivery_id, driver_id, assignment_number, status, assigned_at, accepted_at, completed_at)
         select $1, $2, $3, $4, coalesce(max(assignment_number), 0) + 1, 'COMPLETED', now() - interval '10 minutes', now() - interval '9 minutes', now()
           from public.delivery_assignments where delivery_id = $3`,
        [this.tenantId, this.branchId, deliveryId, driverId],
      );
      await this.client.query(`update public.deliveries set status = 'DELIVERED' where id = $1`, [deliveryId]);
      await this.client.query('commit');
    } catch (error) {
      await this.client.query('rollback');
      throw error;
    }
  }

  /** B10: the session reaches its expiry time. */
  async expireSession(handle: StaffSessionHandle): Promise<void> {
    const result = await this.client.query(
      `update public.staff_sessions set expires_at = now() - interval '1 second' where id = $1`,
      [handle.sessionId],
    );
    if (result.rowCount !== 1) throw new Error('expireSession: session row not found');
  }

  /** B11: the user's branch membership is retired (deactivated). */
  async retireMembership(handle: StaffSessionHandle): Promise<void> {
    const result = await this.client.query(
      `update public.staff_user_branches set status = 'INACTIVE', updated_at = now()
        where tenant_id = $1 and branch_id = $2 and user_id = $3`,
      [this.tenantId, this.branchId, handle.userId],
    );
    if (result.rowCount !== 1) throw new Error('retireMembership: membership row not found');
  }

  async dispose(): Promise<void> {
    try {
      if (this.probeLocationIds.length) {
        await this.client.query(`delete from public.delivery_driver_locations where id = any($1::uuid[])`, [this.probeLocationIds]);
      }
      if (this.driverIds.length) {
        const ids = this.driverIds;
        await this.client.query(
          `delete from public.courier_driver_payouts where driver_id = any($1::uuid[])`, [ids]); // items cascade
        await this.client.query(`delete from public.delivery_assignments where driver_id = any($1::uuid[])`, [ids]);
        await this.client.query(`delete from public.delivery_driver_branches where driver_id = any($1::uuid[])`, [ids]);
        await this.client.query(`delete from public.delivery_drivers where id = any($1::uuid[])`, [ids]);
      }
      if (this.created.length) {
        // Sessions and memberships cascade from staff_users.
        await this.client.query(`delete from public.staff_sessions where user_id = any($1::uuid[])`, [this.created]);
        await this.client.query(`delete from public.staff_users where id = any($1::uuid[])`, [this.created]);
      }
    } finally {
      await this.client.end();
    }
  }
}
