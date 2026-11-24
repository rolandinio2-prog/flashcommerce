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

    const withCod = await request.post(api('/requests'), {
      headers,
      data: { courierClientId: client.id, recipientName: 'Ana', recipientPhone: '71111111', addressText: 'Av. 2', latitude: point!.latitude, longitude: point!.longitude, collectAmount: 50 },
    });
    expect(withCod.status()).toBe(409);

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
