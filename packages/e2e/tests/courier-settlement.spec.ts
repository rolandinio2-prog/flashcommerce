import { randomBytes } from 'node:crypto';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { env } from '../support/env';
import { STAFF_SESSION_COOKIE, StaffFixture } from '../support/staff-fixture';

/** YYYY-MM-DD in Bolivia, shifted by `days` (settlement periods are branch-local dates). */
function boDate(days = 0) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz' }).format(new Date(Date.now() + days * 86_400_000));
}

/**
 * D1c: a manager bills a courier client for its delivered requests and pays the
 * driver who delivered them, using the driver's pay rule. Voiding releases the
 * deliveries so they can be settled again; a paid settlement cannot be voided.
 */
test('courier settlements: client statement and driver payout', async ({ request }) => {
  const fixture = await StaffFixture.open();
  try {
    const point = await fixture.deliveryZonePoint();
    test.skip(!point, 'branch has no active delivery zone');
    const { token } = await fixture.createManagerSession('SETTLE');
    const headers = { Cookie: `${STAFF_SESSION_COOKIE}=${token}`, Origin: env.baseUrl };
    const api = (path: string) => `${env.apiUrl}/api/v1/ops/courier${path}`;
    const post = (r: APIRequestContext, path: string, data: unknown) => r.post(api(path), { headers, data });

    // A client with a flat Bs 10 distance rate and two delivered requests.
    const code = `E2E${randomBytes(3).toString('hex').toUpperCase()}`;
    const client = (await (await post(request, '/clients', { code, name: `Tienda ${code}` })).json()) as { id: string };
    expect((await request.put(api('/rates'), { headers, data: { courierClientId: client.id, pricingMode: 'DISTANCE', baseFee: 0, perKmFee: 0, minFee: 10 } })).status()).toBe(200);
    const driverId = await fixture.createPayoutDriver();
    const orders: number[] = [];
    for (const name of ['Ana', 'Beto']) {
      const res = await post(request, '/requests', {
        courierClientId: client.id, recipientName: `${name} E2E`, recipientPhone: '71111111',
        addressText: 'Calle E2E 1', latitude: point!.latitude, longitude: point!.longitude,
      });
      expect(res.status(), await res.text()).toBe(201);
      const { orderNumber } = (await res.json()) as { orderNumber: number };
      orders.push(orderNumber);
      await fixture.completeDelivery(orderNumber, driverId);
    }
    const period = { from: boDate(-1), to: boDate(1) };

    // ---- client statement
    const preview = await post(request, '/statements/preview', { courierClientId: client.id, ...period });
    expect(preview.status(), await preview.text()).toBe(201);
    expect(await preview.json()).toMatchObject({ deliveryCount: 2, totalFee: 20 });

    const created = await post(request, '/statements', { courierClientId: client.id, ...period });
    expect(created.status(), await created.text()).toBe(201);
    const statement = (await created.json()) as { id: string; status: string; totalFee: number; deliveries: { orderNumber: number }[] };
    expect(statement).toMatchObject({ status: 'ISSUED', totalFee: 20 });
    expect(statement.deliveries.map((d) => d.orderNumber).sort()).toEqual([...orders].sort());
    expect(statement.deliveries.every((d) => (d as { courierRequest?: boolean }).courierRequest === true)).toBe(true);

    expect((await post(request, '/statements', { courierClientId: client.id, ...period })).status()).toBe(409); // nothing left to bill

    const paid = await post(request, `/statements/${statement.id}/pay`, { paymentMethod: 'CASH', paymentReference: 'Recibo 1' });
    expect(paid.status(), await paid.text()).toBe(201);
    expect(await paid.json()).toMatchObject({ status: 'PAID', paymentMethod: 'CASH' });
    expect((await post(request, `/statements/${statement.id}/void`, {})).status()).toBe(409); // paid cannot be voided

    // ---- driver payout (50 % of each Bs 10 fee)
    const rule = await request.patch(api(`/drivers/${driverId}/pay-rule`), { headers, data: { payMode: 'PERCENT_OF_FEE', payValue: 50 } });
    expect(rule.status(), await rule.text()).toBe(200);

    const payoutPreview = await post(request, '/payouts/preview', { driverId, ...period });
    expect(payoutPreview.status(), await payoutPreview.text()).toBe(201);
    expect(await payoutPreview.json()).toMatchObject({ deliveryCount: 2, feeTotal: 20, amount: 10, payMode: 'PERCENT_OF_FEE' });

    const first = (await (await post(request, '/payouts', { driverId, ...period })).json()) as { id: string; amount: number; status: string };
    expect(first).toMatchObject({ amount: 10, status: 'ISSUED' });

    const voided = await post(request, `/payouts/${first.id}/void`, {});
    expect(voided.status(), await voided.text()).toBe(201);
    expect(await voided.json()).toMatchObject({ status: 'VOID', deliveries: [] });

    // Voiding released the deliveries: they can be paid again.
    const second = (await (await post(request, '/payouts', { driverId, ...period })).json()) as { id: string; deliveryCount: number };
    expect(second.deliveryCount).toBe(2);
    const paidPayout = await post(request, `/payouts/${second.id}/pay`, { paymentMethod: 'TRANSFER' });
    expect(await paidPayout.json()).toMatchObject({ status: 'PAID', amount: 10 });

    const listed = (await (await request.get(api('/payouts'), { headers })).json()) as { payouts: { id: string; status: string }[] };
    expect(listed.payouts.filter((p) => p.id === first.id || p.id === second.id).map((p) => p.status).sort()).toEqual(['PAID', 'VOID']);
  } finally {
    await fixture.dispose();
  }
});

test('courier settlements: Ops tabs render', async ({ page, context }) => {
  const fixture = await StaffFixture.open();
  try {
    const { token } = await fixture.createManagerSession('SETTLEUI');
    await context.addCookies([{ name: STAFF_SESSION_COOKIE, value: token, url: env.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/ops');
    await page.getByRole('button', { name: 'Envíos', exact: true }).click();
    await page.getByRole('button', { name: 'Cobros a clientes' }).click();
    await expect(page.getByRole('heading', { name: 'Liquidaciones de clientes' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Pagos a conductores' }).click();
    await expect(page.getByRole('heading', { name: 'Regla de pago por conductor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Nuevo pago a conductor' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});
