/**
 * Test environment. Defaults target the local development stack.
 *
 * E2E_DATABASE_URL must point to a LOCAL/test database: the suite creates and
 * deletes its own temporary staff users there. The guard below refuses
 * anything that is not localhost unless E2E_ALLOW_REMOTE_DB=true.
 */
function read(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export const env = {
  baseUrl: read('E2E_BASE_URL', 'http://localhost:3000'),
  apiUrl: read('E2E_API_URL', 'http://localhost:3001'),
  databaseUrl: read('E2E_DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'),
  tenantCode: read('E2E_TENANT', 'POLLO001').toUpperCase(),
  branchCode: read('E2E_BRANCH', 'SUC001').toUpperCase(),
  allowRemoteDb: process.env.E2E_ALLOW_REMOTE_DB === 'true',
};

export function assertLocalDatabase(): void {
  const host = new URL(env.databaseUrl).hostname;
  if (!env.allowRemoteDb && !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`E2E_DATABASE_URL host "${host}" is not local. Set E2E_ALLOW_REMOTE_DB=true only for a disposable test database.`);
  }
}

/** The monitor derives tenant/branch from the staff session itself. */
export const MONITOR_PATH = '/ops/delivery-monitor';
