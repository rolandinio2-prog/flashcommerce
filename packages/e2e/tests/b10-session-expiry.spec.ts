import { test } from '@playwright/test';

import { runAccessRetirementScenario } from '../support/access-retirement';

/**
 * Gate B10 — staff session expiry.
 *
 * When a Delivery Monitor session reaches expires_at, the monitor must stop
 * showing deliveries, positions and trails, close its Realtime channels and
 * stay disconnected for at least 30 s, while a separate CONTROL session keeps
 * working.
 */
test('B10: expired session retires monitor data and Realtime channels', async ({ browser }) => {
  await runAccessRetirementScenario(browser, (fixture, subject) => fixture.expireSession(subject));
});
