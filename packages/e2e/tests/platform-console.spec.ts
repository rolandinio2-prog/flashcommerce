import { randomBytes } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { origin, platformApi as api, platformLogin as login, withOperator } from '../support/platform-fixture';

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

    // Ops learns the contracted products, so it can hide the areas the business does not have.
    // (Ops needs the temporary password replaced first.)
    const again = await staffLogin();
    const adminCookie = { Cookie: again.headers()['set-cookie']!.split(';')[0], ...origin };
    const changed = await request.post(api('/staff/auth/change-password'), { headers: adminCookie, data: { newPassword: `Nueva-${randomBytes(8).toString('hex')}` } });
    expect(changed.status(), await changed.text()).toBeLessThan(300);
    const access = await request.get(api('/ops/access'), { headers: adminCookie });
    expect(access.status(), await access.text()).toBe(200);
    expect(((await access.json()) as { products: string[] }).products).toEqual(['DELIVERY']);

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
