import { randomBytes, scryptSync } from 'node:crypto';

import { expect, type APIRequestContext } from '@playwright/test';
import pg from 'pg';

import { env } from './env';

export const platformApi = (path: string) => `${env.apiUrl}/api/v1${path}`;
export const origin = { Origin: env.baseUrl };

/**
 * A platform operator inserted directly (the bootstrap endpoint needs the server's ops key).
 * Everything it created (businesses, audit events) is removed afterwards.
 */
export async function withOperator(run: (op: { email: string; password: string; db: pg.Client }) => Promise<void>) {
  const db = new pg.Client({ connectionString: env.databaseUrl });
  await db.connect();
  const email = `e2e-${randomBytes(4).toString('hex')}@platform.test`;
  const password = `E2e-${randomBytes(9).toString('base64url')}`;
  const salt = randomBytes(16);
  const hash = `scrypt$${salt.toString('base64url')}$${scryptSync(password, salt, 64).toString('base64url')}`;
  const r = await db.query<{ id: string }>(
    "insert into public.platform_users (email, display_name, password_hash, password_change_required) values ($1,'Operador E2E',$2,false) returning id::text",
    [email, hash],
  );
  try {
    await run({ email, password, db });
  } finally {
    const tenants = await db.query<{ id: string }>(
      "select distinct tenant_id::text as id from public.platform_audit_events where actor_user_id=$1::uuid and action='TENANT_CREATED'",
      [r.rows[0].id],
    );
    const ids = tenants.rows.map((t) => t.id);
    if (ids.length) await db.query('delete from public.platform_audit_events where tenant_id = any($1::uuid[])', [ids]);
    await db.query('delete from public.platform_audit_events where actor_user_id=$1::uuid', [r.rows[0].id]);
    if (ids.length) await db.query('delete from public.tenants where id = any($1::uuid[])', [ids]);
    await db.query('delete from public.platform_users where id=$1::uuid', [r.rows[0].id]);
    await db.end();
  }
}

export async function platformLogin(request: APIRequestContext, email: string, password: string) {
  const res = await request.post(platformApi('/platform/auth/login'), { headers: origin, data: { email, password } });
  expect(res.status(), await res.text()).toBe(200);
  const cookie = res.headers()['set-cookie']?.match(/flash_platform_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();
  return { Cookie: `flash_platform_session=${cookie}`, ...origin };
}
