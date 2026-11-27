import { randomBytes } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { env } from '../support/env';
import { STAFF_SESSION_COOKIE, StaffFixture } from '../support/staff-fixture';

/**
 * D1 (FlashCommerce Delivery standalone): a manager registers a courier client
 * and rate, then creates a manual delivery request. It must reach dispatch
 * (WAITING_ASSIGNMENT / ASSIGNED) without going through the kitchen list.
 */
test('courier: manual delivery request reaches dispatch, not the kitchen', async ({ request }) => {
  const fixture = await StaffFixture.open();
  try {
    const point = await fixture.deliveryZonePoint();
    test.skip(!point, 'branch has no active delivery zone');
    const { token } = await fixture.createManagerSession('COURIER');
    const headers = { Cookie: `${STAFF_SESSION_COOKIE}=${token}`, Origin: env.baseUrl };
    const api = (path: string) => `${env.apiUrl}/api/v1/ops/courier${path}`;

    const code = `E2E${randomBytes(3).toString('hex').toUpperCase()}`;
    const created = await request.post(api('/clients'), {
      headers,
      data: { code, name: `Farmacia ${code}`, phone: '70000000', pickupAddress: 'Calle 1' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const client = (await created.json()) as { id: string; name: string };

    // The client list carries the branch origin so the Ops maps open centered on the branch.
    const clientList = (await (await request.get(api('/clients'), { headers })).json()) as { branchOrigin: { latitude: number; longitude: number } | null };
    expect(clientList.branchOrigin).toEqual({ latitude: expect.any(Number), longitude: expect.any(Number) });

    const rate = await request.put(api('/rates'), {
      headers,
      data: { courierClientId: client.id, pricingMode: 'DISTANCE', baseFee: 5, perKmFee: 0, minFee: 9 },
    });
    expect(rate.status(), await rate.text()).toBe(200);

    const quote = await request.post(api('/quote'), {
      headers,
      data: { courierClientId: client.id, latitude: point!.latitude, longitude: point!.longitude },
    });
    expect(quote.status(), await quote.text()).toBe(201);
    expect((await quote.json()).fee).toBe(9);

    // Cash on delivery: the order carries the amount to collect and a pending DRIVER_COD payment,
    // and it is still dispatched (cash is collected on arrival).
    const withCod = await request.post(api('/requests'), {
      headers,
      data: { courierClientId: client.id, recipientName: 'Ana', recipientPhone: '71111111', addressText: 'Av. 2', latitude: point!.latitude, longitude: point!.longitude, collectAmount: 50 },
    });
    expect(withCod.status(), await withCod.text()).toBe(201);
    const cod = (await withCod.json()) as { orderNumber: number; collectAmount: number };
    expect(cod.collectAmount).toBe(50);
    const codState = await fixture.orderState(cod.orderNumber);
    expect(codState).toMatchObject({ total: '50.00', paymentStatus: 'AWAITING_CONFIRMATION' });
    expect(['WAITING_ASSIGNMENT', 'ASSIGNED']).toContain((await fixture.courierDeliveryState(cod.orderNumber))!.deliveryStatus);

    const res = await request.post(api('/requests'), {
      headers,
      data: {
        courierClientId: client.id,
        recipientName: 'Ana E2E',
        recipientPhone: '71111111',
        addressText: 'Av. Siempre Viva 2',
        latitude: point!.latitude,
        longitude: point!.longitude,
        packageDescription: 'Caja pequeña',
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const order = (await res.json()) as { orderNumber: number; fee: number };
    expect(order.fee).toBe(9);

    const state = await fixture.courierDeliveryState(order.orderNumber);
    expect(state).toMatchObject({ origin: 'COURIER_REQUEST', orderStatus: 'READY', fee: '9.00', pickupName: client.name });
    expect(['WAITING_ASSIGNMENT', 'ASSIGNED']).toContain(state!.deliveryStatus);

    const listed = await request.get(api('/requests'), { headers });
    expect((await listed.json()).requests.map((r: { orderNumber: number }) => r.orderNumber)).toContain(order.orderNumber);

    const kitchen = await request.get(`${env.apiUrl}/api/v1/ops/orders`, { headers });
    expect(kitchen.status()).toBe(200);
    const kitchenText = JSON.stringify(await kitchen.json());
    const inKitchen = new RegExp(`"orderNumber":"?${order.orderNumber}"?[,}]`);
    expect(kitchenText).toMatch(/"orderNumber":/); // the list is not empty, so the check is meaningful
    expect(kitchenText).not.toMatch(inKitchen);
  } finally {
    await fixture.dispose();
  }
});

test('courier: Ops "Envíos" tab creates a request from the form', async ({ page, context }) => {
  const fixture = await StaffFixture.open();
  try {
    const point = await fixture.deliveryZonePoint();
    test.skip(!point, 'branch has no active delivery zone');
    const { token } = await fixture.createManagerSession('COURIERUI');
    await context.addCookies([{ name: STAFF_SESSION_COOKIE, value: token, url: env.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/ops');
    await page.getByRole('button', { name: 'Envíos', exact: true }).click();
    await expect(page.getByRole('heading', { name: '2. Entregar' })).toBeVisible({ timeout: 20_000 });

    await page.getByLabel('Destinatario').fill('Luis UI');
    await page.getByLabel('Teléfono', { exact: true }).fill('72222222');
    await page.getByLabel('Dirección', { exact: true }).fill('Calle UI 3');
    await page.getByLabel('Latitud destino').fill(String(point!.latitude));
    await page.getByLabel('Longitud destino').fill(String(point!.longitude));
    await page.getByRole('button', { name: 'Calcular tarifa' }).click();
    await expect(page.getByText(/Bs \d+\.\d{2}/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Crear envío' }).click();
    const status = page.getByRole('status').filter({ hasText: /Envío #\d+ creado/ });
    await expect(status).toBeVisible();
    const orderNumber = Number((await status.textContent())!.match(/Envío #(\d+)/)![1]);
    expect((await fixture.courierDeliveryState(orderNumber))?.origin).toBe('COURIER_REQUEST');

    await page.getByRole('button', { name: 'Envíos', exact: true }).last().click();
    await expect(page.getByRole('cell', { name: String(orderNumber), exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});
