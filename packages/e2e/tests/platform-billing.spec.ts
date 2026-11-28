import { randomBytes } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { origin, platformApi as api, platformLogin, withOperator } from '../support/platform-fixture';

/** YYYY-MM-DD in Bolivia shifted by `days` (billing dates are business dates in La Paz). */
function boDate(days = 0) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(new Date(Date.now() + days * 86_400_000));
}

type Sub = { exempt: boolean; paidUntil: string | null; state: string | null; monthlyAmount: number; payments: { id: string; voidedAt: string | null }[] };

/**
 * R4b: a business with a subscription is suspended automatically after the 7 grace days, a payment
 * reactivates it and extends paid_until, the last payment can be voided, and Ops sees the notice.
 */
test('platform billing: prices, overdue suspension, payment and Ops notice', async ({ request }) => {
  await withOperator(async ({ email, password, db }) => {
    const headers = await platformLogin(request, email, password);
    const saved = (await db.query<{ product: string; monthly_price: string }>('select product, monthly_price::text from public.platform_product_prices')).rows;
    try {
      const prices = await request.put(api('/platform/billing/prices'), { headers, data: { prices: { COMMERCE: 150, DELIVERY: 100 } } });
      expect(await prices.json()).toMatchObject({ prices: { COMMERCE: 150, DELIVERY: 100 } });

      const code = `E2EB${randomBytes(3).toString('hex').toUpperCase()}`;
      const created = await request.post(api('/platform/tenants'), {
        headers,
        data: { code, name: `Cobro ${code}`, products: ['COMMERCE', 'DELIVERY'], admin: { firstName: 'Bea', lastName: 'Cobro' } },
      });
      expect(created.status(), await created.text()).toBe(201);
      const tenant = (await created.json()) as { id: string; initialAdmin: { userCode: string; temporaryPassword: string } };
      const sub = (path = '') => api(`/platform/tenants/${tenant.id}/subscription${path}`);

      // New businesses are exempt until billing starts; paying without a subscription is refused.
      expect(await (await request.get(sub(), { headers })).json()).toMatchObject({ exempt: true, monthlyAmount: 250 });
      expect((await request.post(sub('/payments'), { headers, data: { months: 1, amount: 250, method: 'CASH' } })).status()).toBe(409);

      // Paid through 8 days ago: past the 7 grace days, so the overdue run suspends it.
      const assigned = (await (await request.put(sub(), { headers, data: { paidUntil: boDate(-8), monthlyPriceOverride: null } })).json()) as Sub;
      expect(assigned).toMatchObject({ exempt: false, state: 'OVERDUE' });
      const run = await request.post(api('/platform/billing/run-suspensions'), { headers });
      expect(((await run.json()) as { suspended: number }).suspended).toBeGreaterThanOrEqual(1);
      const detail = (await (await request.get(api(`/platform/tenants/${tenant.id}`), { headers })).json()) as { status: string; audit: { action: string }[] };
      expect(detail.status).toBe('SUSPENDED');
      expect(detail.audit[0].action).toBe('TENANT_AUTO_SUSPENDED');
      const staffLogin = (password: string) => request.post(api('/staff/auth/login'), {
        headers: origin, data: { tenantCode: code, branchCode: 'CENTRAL', userCode: tenant.initialAdmin.userCode, password },
      });
      expect((await staffLogin(tenant.initialAdmin.temporaryPassword)).status()).toBe(401);

      // Paying one month after expiry starts from today and lifts the automatic suspension.
      const paid = (await (await request.post(sub('/payments'), { headers, data: { months: 1, amount: 250, method: 'TRANSFER', reference: 'TRX-1' } })).json()) as Sub;
      expect(paid).toMatchObject({ state: 'ACTIVE' });
      expect(paid.paidUntil! > boDate(25)).toBe(true);
      expect(((await (await request.get(api(`/platform/tenants/${tenant.id}`), { headers })).json()) as { status: string }).status).toBe('ACTIVE');

      // A second payment extends from paid_until; only the latest payment can be voided.
      const second = (await (await request.post(sub('/payments'), { headers, data: { months: 2, amount: 500, method: 'QR' } })).json()) as Sub;
      expect(second.paidUntil! > paid.paidUntil!).toBe(true);
      const older = second.payments[1].id;
      expect((await request.post(sub(`/payments/${older}/void`), { headers, data: { reason: 'prueba' } })).status()).toBe(409);
      const voided = (await (await request.post(sub(`/payments/${second.payments[0].id}/void`), { headers, data: { reason: 'Monto equivocado' } })).json()) as Sub;
      expect(voided.paidUntil).toBe(paid.paidUntil);

      // Ops shows the notice while the subscription is due soon (paid through in 2 days).
      await request.put(sub(), { headers, data: { paidUntil: boDate(2), monthlyPriceOverride: 200 } });
      const signedIn = await staffLogin(tenant.initialAdmin.temporaryPassword);
      expect(signedIn.status(), await signedIn.text()).toBe(201);
      const admin = { Cookie: signedIn.headers()['set-cookie']!.split(';')[0], ...origin };
      await request.post(api('/staff/auth/change-password'), { headers: admin, data: { newPassword: `Nueva-${randomBytes(8).toString('hex')}` } });
      const access = (await (await request.get(api('/ops/access'), { headers: admin })).json()) as { subscription: { state: string; daysLeft: number } | null };
      expect(access.subscription).toMatchObject({ state: 'DUE_SOON', daysLeft: 2 });
      expect(((await (await request.get(sub(), { headers })).json()) as Sub).monthlyAmount).toBe(200);

      // Exempt again: no notice, never auto-suspended.
      expect(await (await request.delete(sub(), { headers })).json()).toMatchObject({ exempt: true });
      expect(((await (await request.get(api('/ops/access'), { headers: admin })).json()) as { subscription: unknown }).subscription).toBeNull();
    } finally {
      for (const p of saved) await db.query('update public.platform_product_prices set monthly_price=$2 where product=$1', [p.product, p.monthly_price]);
      await db.query("delete from public.platform_audit_events where action='PRICES_CHANGED' and details ? 'COMMERCE' and actor_user_id in (select id from public.platform_users where email=$1)", [email]);
    }
  });
});

test('platform billing: console shows prices and the subscription section', async ({ page }) => {
  await withOperator(async ({ email, password }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/platform');
    await page.getByLabel('Correo').fill(email);
    await page.getByLabel('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.getByRole('button', { name: 'Precios' }).click();
    await expect(page.getByRole('heading', { name: 'Precios mensuales por producto' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Venta de Pollos|Negocio|Cobro/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Suscripción' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

