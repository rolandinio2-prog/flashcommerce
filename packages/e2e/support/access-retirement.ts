import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { env, MONITOR_PATH } from './env';
import { RealtimeTracker } from './realtime-tracker';
import { STAFF_SESSION_COOKIE, StaffFixture, type StaffSessionHandle } from './staff-fixture';

/** Seconds the subject must stay silent after retirement (gate criterion). */
export const QUIET_WINDOW_MS = 30_000;
/** Watcher polls every 10 s with an 8 s read deadline. */
export const DENIAL_DEADLINE_MS = 25_000;

const MAP_SELECTOR = '[aria-label="Mapa operativo de Delivery Monitor"]';
const DENIED_TEXT = /Tu sesión no permite continuar|Tu sesión venció|No tienes acceso al monitor/;

export interface MonitorActor {
  handle: StaffSessionHandle;
  context: BrowserContext;
  page: Page;
  realtime: RealtimeTracker;
}

export async function openMonitor(browser: Browser, handle: StaffSessionHandle): Promise<MonitorActor> {
  const context = await browser.newContext();
  await context.addCookies([{
    name: STAFF_SESSION_COOKIE,
    value: handle.token,
    url: env.baseUrl,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  const realtime = new RealtimeTracker(page);
  await page.goto(MONITOR_PATH);
  return { handle, context, page, realtime };
}

/** Protected monitor UI is visible and a Realtime channel is connected. */
export async function expectMonitorLive(actor: MonitorActor): Promise<void> {
  await expect(actor.page.locator(MAP_SELECTOR)).toBeVisible();
  await expect.poll(() => actor.realtime.openCount(), { message: `${actor.handle.label}: Realtime socket open` }).toBeGreaterThan(0);
}

/** API rejects the subject's cookie on every protected monitor endpoint. */
export async function expectApiRejects(actor: MonitorActor): Promise<void> {
  const scope = `tenant=${encodeURIComponent(env.tenantCode)}&branch=${encodeURIComponent(env.branchCode)}`;
  for (const path of ['/api/v1/staff/auth/me', `/api/v1/ops/delivery-monitor/active?${scope}`,'/api/v1/ops/delivery-monitor/realtime-session']) {
    const method = path.includes('realtime-session') ? 'post' : 'get';
    const response = await actor.context.request[method](`${env.baseUrl}${path}`, { failOnStatusCode: false });
    expect([401, 403], `${method.toUpperCase()} ${path} must be rejected`).toContain(response.status());
  }
}

/**
 * Shared acceptance for B10 (expiry) and B11 (membership retirement):
 *  1. subject sees the denial and no protected monitor data;
 *  2. subject's Realtime sockets close;
 *  3. no reconnection and no frames for QUIET_WINDOW_MS;
 *  4. API rejects the subject;
 *  5. CONTROL keeps its monitor and Realtime connection throughout.
 */
export async function runAccessRetirementScenario(
  browser: Browser,
  retire: (fixture: StaffFixture, subject: StaffSessionHandle) => Promise<void>,
): Promise<void> {
  const fixture = await StaffFixture.open();
  const actors: MonitorActor[] = [];
  try {
    const subject = await openMonitor(browser, await fixture.createManagerSession('SUBJECT'));
    const control = await openMonitor(browser, await fixture.createManagerSession('CONTROL'));
    actors.push(subject, control);

    await expectMonitorLive(subject);
    await expectMonitorLive(control);
    const controlSocketsBefore = control.realtime.total;

    const retiredAt = Date.now();
    await retire(fixture, subject.handle);

    // 1. Denial is shown and protected data is gone.
    await expect(subject.page.getByRole('status').filter({ hasText: DENIED_TEXT }))
      .toBeVisible({ timeout: DENIAL_DEADLINE_MS });
    await expect(subject.page.locator(MAP_SELECTOR)).toHaveCount(0);

    // 2. Every Realtime socket of the subject closes.
    await expect.poll(() => subject.realtime.openCount(), {
      message: 'subject Realtime sockets must close after retirement',
      timeout: 15_000,
    }).toBe(0);

    // 3. Quiet window: no new sockets, no frames, data stays hidden.
    const quietFrom = Math.max(subject.realtime.lastCloseAt(), retiredAt);
    await subject.page.waitForTimeout(QUIET_WINDOW_MS);
    expect(subject.realtime.openedSince(quietFrom), 'no Realtime reconnection during quiet window').toBe(0);
    expect(subject.realtime.framesSince(quietFrom + 1), 'no Realtime frames during quiet window').toBe(0);
    await expect(subject.page.locator(MAP_SELECTOR)).toHaveCount(0);

    // 4. API rejects the subject.
    await expectApiRejects(subject);

    // 5. CONTROL is unaffected: still live, no forced reconnect storm.
    await expectMonitorLive(control);
    await expect(control.page.getByRole('status').filter({ hasText: DENIED_TEXT })).toHaveCount(0);
    expect(control.realtime.total - controlSocketsBefore, 'CONTROL should not churn sockets').toBeLessThanOrEqual(1);
  } finally {
    for (const actor of actors) await actor.context.close().catch(() => {});
    await fixture.dispose();
  }
}
