import { expect, test, type Page } from '@playwright/test';

import { env } from '../support/env';
import { STAFF_SESSION_COOKIE, StaffFixture } from '../support/staff-fixture';

/**
 * Smoke test: main screens render their key content without uncaught
 * JavaScript errors. Safety net for UI refactors (React Compiler fixes).
 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Network failures of optional third-party resources are not app errors.
    if (/Failed to load resource|ERR_|net::|maps\.googleapis|tiles\.openfreemap/i.test(text)) return;
    errors.push(`console: ${text.slice(0, 200)}`);
  });
  return errors;
}

test.describe('smoke: public pages', () => {
  test('menu renders products and the cart entry', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/menu/${env.tenantCode}/${env.branchCode}`);
    await expect(page.getByText(/Pollo/i).first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
  });

  test('order tracking page renders an existing order', async ({ page }) => {
    const fixture = await StaffFixture.open();
    const token = await fixture.latestTrackingToken();
    await fixture.dispose();
    test.skip(!token, 'no order with tracking token in the test branch');
    const errors = collectErrors(page);
    await page.goto(`/track/${token}`);
    await expect(page.getByRole('heading', { name: /Seguimiento|Pedido/i }).first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
  });
});

test.describe('smoke: staff pages', () => {
  let fixture: StaffFixture;
  let token: string;

  test.beforeAll(async () => {
    fixture = await StaffFixture.open();
    token = (await fixture.createManagerSession('SMOKE')).token;
  });
  test.afterAll(async () => { await fixture.dispose(); });

  for (const [path, text] of [
    ['/ops', /Operaciones|Pedidos/i],
    ['/ops/delivery-monitor', /Delivery Monitor/i],
    ['/admin', /Administraci|Admin/i],
  ] as const) {
    test(`${path} renders for a manager`, async ({ page, context }) => {
      await context.addCookies([{ name: STAFF_SESSION_COOKIE, value: token, url: env.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
      const errors = collectErrors(page);
      await page.goto(path);
      await expect(page.getByText(text).first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      expect(errors).toEqual([]);
    });
  }
});
