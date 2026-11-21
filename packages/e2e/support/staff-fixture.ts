import { createHash, randomBytes } from 'node:crypto';

import pg from 'pg';

import { assertLocalDatabase, env } from './env';

/** Must match apps/api/src/staff/staff.service.ts. */
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
  async createManagerSession(label: string): Promise<StaffSessionHandle> {
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
       values ($1, $2, $3, 'MANAGER', 'ACTIVE')`,
      [this.tenantId, this.branchId, userId],
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
