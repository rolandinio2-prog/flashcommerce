import { defineConfig, devices } from '@playwright/test';

import { env } from './support/env';

/**
 * Security regression suite for the staff session lifecycle (gates B10/B11).
 *
 * Runs against an already running local stack (Supabase, API :3001 and
 * Customer/Ops :3000). It never starts, stops or removes containers.
 */
export default defineConfig({
  testDir: './tests',
  // Each test mutates shared session rows; keep them strictly sequential.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Session watcher interval (10 s) + read deadline (8 s) + 30 s quiet window.
  timeout: 120_000,
  expect: { timeout: 25_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './support/global-setup.ts',
  use: {
    baseURL: env.baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
