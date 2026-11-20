import { test } from '@playwright/test';

import { runAccessRetirementScenario } from '../support/access-retirement';

/**
 * Gate B11 — branch membership retirement.
 *
 * When an operator's membership in the branch is deactivated, the monitor must
 * stop showing protected data, close its Realtime channels and stay
 * disconnected for at least 30 s, while a separate CONTROL session keeps
 * working.
 */
test('B11: retired membership revokes monitor access and Realtime channels', async ({ browser }) => {
  await runAccessRetirementScenario(browser, (fixture, subject) => fixture.retireMembership(subject));
});
