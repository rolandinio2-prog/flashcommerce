import { expect, test } from '@playwright/test';

import { env } from '../support/env';
import { STAFF_SESSION_COOKIE, StaffFixture } from '../support/staff-fixture';

/**
 * Customer checkout through the public menu (flash-menu-client):
 * cart -> checkout -> first-time customer registration -> take-away -> QR
 * payment -> simulated QR payment (Admin dev tool) -> order confirmed.
 * Safety net for refactors of the menu/checkout component.
 */
test('checkout: take-away order with simulated QR payment', async ({ page, request }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // 1. Cart
  await page.goto(`/menu/${env.tenantCode}/${env.branchCode}`);
  const add = page.getByRole('button', { name: 'Agregar Coca-Cola · Personal al pedido' });
  await expect(add).toBeEnabled({ timeout: 30_000 });
  await add.click();
  await page.getByRole('button', { name: 'Ver mi pedido' }).click();
  const cart = page.getByRole('dialog', { name: 'Tu pedido' });
  await expect(cart.getByRole('heading', { name: 'Coca-Cola · Personal' })).toBeVisible();
  await cart.getByRole('button', { name: 'Agregar una unidad de Coca-Cola · Personal' }).click();
  await expect(cart.getByRole('group', { name: 'Cantidad de Coca-Cola · Personal' }).getByRole('status')).toHaveText('2');
  await cart.getByRole('button', { name: 'Continuar pedido' }).click();

  // 2. Checkout: take-away + first-time customer (unique test phone)
  const checkout = page.getByRole('dialog', { name: 'Finalizar pedido' });
  await checkout.getByRole('radio', { name: /Retirar en el local/ }).check();
  await expect(checkout).toContainText(/Total general\s*Bs 24\.00/);
  await checkout.getByRole('button', { name: 'Primera vez' }).click();
  const customer = checkout.getByRole('region', { name: 'Tus datos y recuperación' });
  const phone = '7' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
  await customer.getByRole('textbox', { name: 'Nombre completo' }).fill('QA Checkout');
  await customer.getByRole('textbox', { name: /teléfono/i }).fill(phone);
  await customer.getByRole('textbox', { name: /Código de recuperación/i }).fill('246810');
  await expect(customer.getByRole('status')).toHaveText(/Datos verificados/, { timeout: 20_000 });

  // 3. Confirm -> order + QR
  const confirm = checkout.getByRole('button', { name: 'Confirmar y generar QR' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  const received = page.getByRole('dialog', { name: /^Pedido (recibido|confirmado)$/ });
  await expect(page.getByRole('dialog', { name: 'Pedido recibido' })).toBeVisible({ timeout: 30_000 });
  const orderText = await received.getByText(/Pedido #\d+/).first().textContent();
  const orderNumber = Number(/#(\d+)/.exec(orderText ?? '')?.[1]);
  expect(orderNumber).toBeGreaterThan(0);
  // BCP sandbox returns an image (alt "QR de pago BCP"); the MOCK provider (staging) a QR drawn as SVG.
  // Both show the scan instructions only when a QR is available.
  await expect(received.getByText(/escanea el código/)).toBeVisible();
  await expect(received.locator('img[alt^="QR de pago"], svg').first()).toBeVisible();
  await expect(received).toContainText('BOB 24.00');

  const fixture = await StaffFixture.open();
  try {
    expect(await fixture.orderState(orderNumber)).toMatchObject({
      orderType: 'TAKEAWAY', total: '24.00', paymentStatus: expect.stringMatching(/^(CREATED|AWAITING_CONFIRMATION)$/),
    });

    // 4. Simulated QR payment through the existing Admin dev tool (normal payment flow server-side)
    const admin = await fixture.createManagerSession('CHECKOUT-ADMIN', 'ADMIN');
    const cookie = `${STAFF_SESSION_COOKIE}=${admin.token}`;
    const status = await request.get(`${env.baseUrl}/api/v1/staff/admin/dev-payments/status`, { headers: { cookie } });
    test.skip(!status.ok() || (await status.json()).enabled === false, 'QR simulator disabled in this environment');
    const simulated = await request.post(
      `${env.baseUrl}/api/v1/staff/admin/dev-payments/orders/${orderNumber}/simulate-qr-paid`,
      { headers: { cookie } },
    );
    expect(simulated.status(), await simulated.text()).toBeLessThan(300);

    // 5. Customer screen leaves "waiting" by itself; order is paid in the database.
    await expect(page.getByRole('dialog', { name: 'Pedido confirmado' })).toBeVisible({ timeout: 30_000 });
    await expect(received.getByText('Esperando confirmación')).toHaveCount(0);
    await expect.poll(async () => (await fixture.orderState(orderNumber))?.paymentStatus, { timeout: 20_000 }).toBe('PAID');

    // 6. "Mis pedidos" lists the order for this browser/customer.
    await received.getByRole('button', { name: 'Volver al menú' }).click();
    await expect(received).toBeHidden();
    await page.getByRole('button', { name: /^Mis pedidos/ }).click();
    const vault = page.locator('dialog[open]').filter({ hasText: /Mis pedidos/ });
    await expect(vault).toBeVisible({ timeout: 15_000 });
    await expect(vault).toContainText(new RegExp(`Pedido #${orderNumber}(?!\\d)`), { timeout: 20_000 });
    await expect(vault).toContainText('Pagado');
  } finally {
    await fixture.dispose();
  }
  expect(errors).toEqual([]);
});
