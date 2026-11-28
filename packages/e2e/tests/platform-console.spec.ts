import { randomBytes, scryptSync } from 'node:crypto';

import { expect, test, type APIRequestContext } from '@playwright/test';
import pg from 'pg';

import { env } from '../support/env';

/** A platform operator inserted directly (the bootstrap endpoint needs the server's ops key). */
async function withOperator(run: (op: { email: string; password: string; db: pg.Client }) => Promise<void>) {
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
  const created: string[] = [];
  try {
    await run({ email, password, db });
  } finally {
    const tenants = await db.query<{ id: string }>(
      "select distinct tenant_id::text as id from public.platform_audit_events where actor_user_id=$1::uuid and action='TENANT_CREATED'",
      [r.rows[0].id],
    );
    created.push(...tenants.rows.map((t) => t.id));
    await db.query('delete from public.platform_audit_events where actor_user_id=$1::uuid', [r.rows[0].id]);
    if (created.length) await db.query('delete from public.tenants where id = any($1::uuid[])', [created]);
    await db.query('delete from public.platform_users where id=$1::uuid', [r.rows[0].id]);
    await db.end();
  }
}

const api = (path: string) => `${env.apiUrl}/api/v1${path}`;
const origin = { Origin: env.baseUrl };

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post(api('/platform/auth/login'), { headers: origin, data: { email, password } });
  expect(res.status(), await res.text()).toBe(200);
  const cookie = res.headers()['set-cookie']?.match(/flash_platform_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();
  return { Cookie: `flash_platform_session=${cookie}`, ...origin };
}

/**
 * R4a: a platform operator creates a business with its first branch, products and ADMIN. The ADMIN
 * signs in with the one-time password; suspending the business ends that session and blocks login.
 */
test('platform console: create, suspend and reactivate a business', async ({ request }) => {
  await withOperator(async ({ email, password }) => {
    expect((await request.get(api('/platform/tenants'))).status()).toBe(401);
    expect((await request.post(api('/platform/auth/login'), { headers: origin, data: { email, password: 'wrong-password' } })).status()).toBe(401);
    const headers = await login(request, email, password);
    expect((await request.post(api('/platform/tenants'), { headers: { Cookie: headers.Cookie }, data: {} })).status()).toBe(403); // no Origin

    const code = `E2EP${randomBytes(3).toString('hex').toUpperCase()}`;
    const created = await request.post(api('/platform/tenants'), {
      headers,
      data: { code, name: `Negocio ${code}`, branchCode: 'CENTRAL', branchName: 'Central', timezone: 'America/La_Paz',
        products: ['COMMERCE', 'DELIVERY'], admin: { firstName: 'Ana', lastName: 'Prueba', phone: '70000000' } },
    });
    expect(created.status(), await created.text()).toBe(201);
    const tenant = (await created.json()) as {
      id: string; status: string; products: Record<string, boolean>;
      initialAdmin: { tenantCode: string; branchCode: string; userCode: string; temporaryPassword: string };
    };
    expect(tenant).toMatchObject({ status: 'ACTIVE', products: { COMMERCE: true, DELIVERY: true } });
    expect(tenant.initialAdmin).toMatchObject({ tenantCode: code, branchCode: 'CENTRAL' });
    expect((await request.post(api('/platform/tenants'), { headers, data: { code, name: 'x', products: ['COMMERCE'], admin: { firstName: 'a', lastName: 'b' } } })).status()).toBe(409);
    expect((await request.post(api(`/platform/tenants/${tenant.id}/initial-admin`), { headers, data: { firstName: 'Otro', lastName: 'Admin' } })).status()).toBe(409);

    // The new ADMIN signs in with the one-time password.
    const staffLogin = () => request.post(api('/staff/auth/login'), {
      headers: origin,
      data: { tenantCode: code, branchCode: 'CENTRAL', userCode: tenant.initialAdmin.userCode, password: tenant.initialAdmin.temporaryPassword },
    });
    const signedIn = await staffLogin();
    expect(signedIn.status(), await signedIn.text()).toBe(201);
    const staffCookie = signedIn.headers()['set-cookie']!.split(';')[0];
    expect((await request.get(api('/staff/auth/me'), { headers: { Cookie: staffCookie } })).status()).toBe(200);

    // Suspension needs a reason, ends the staff session and blocks new logins.
    expect((await request.patch(api(`/platform/tenants/${tenant.id}/status`), { headers, data: { status: 'SUSPENDED' } })).status()).toBe(400);
    const suspended = await request.patch(api(`/platform/tenants/${tenant.id}/status`), { headers, data: { status: 'SUSPENDED', reason: 'Suscripción vencida' } });
    expect(await suspended.json()).toMatchObject({ status: 'SUSPENDED' });
    expect((await request.get(api('/staff/auth/me'), { headers: { Cookie: staffCookie } })).status()).toBe(401);
    expect((await staffLogin()).status()).toBe(401);

    const reactivated = await request.patch(api(`/platform/tenants/${tenant.id}/status`), { headers, data: { status: 'ACTIVE' } });
    expect(await reactivated.json()).toMatchObject({ status: 'ACTIVE' });
    expect((await staffLogin()).status()).toBe(201);

    const products = await request.put(api(`/platform/tenants/${tenant.id}/products`), { headers, data: { products: ['DELIVERY'] } });
    const detail = (await products.json()) as { products: Record<string, boolean>; audit: { action: string }[] };
    expect(detail.products).toEqual({ COMMERCE: false, DELIVERY: true });
    expect(detail.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['TENANT_CREATED', 'INITIAL_ADMIN_CREATED', 'TENANT_STATUS_CHANGED', 'TENANT_PRODUCTS_CHANGED']));
    expect((await request.put(api(`/platform/tenants/${tenant.id}/products`), { headers, data: { products: [] } })).status()).toBe(400);

    const listed = (await (await request.get(api('/platform/tenants'), { headers })).json()) as { tenants: { code: string }[] };
    expect(listed.tenants.map((t) => t.code)).toContain(code);
  });
});

test('platform console: page signs in and lists businesses', async ({ page }) => {
  await withOperator(async ({ email, password }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/platform');
    await page.getByLabel('Correo').fill(email);
    await page.getByLabel('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('heading', { name: 'Consola de plataforma' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Negocios' })).toBeVisible();
    await page.getByRole('button', { name: 'Nuevo', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Nuevo negocio' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
