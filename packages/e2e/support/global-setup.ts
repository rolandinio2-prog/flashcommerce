import pg from 'pg';

import { assertLocalDatabase, env } from './env';

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    return response.status < 500;
  } catch {
    return false;
  }
}

/** Fails fast with a clear message when the local stack is not running. */
export default async function globalSetup(): Promise<void> {
  assertLocalDatabase();
  const problems: string[] = [];
  if (!(await reachable(`${env.baseUrl}/ops`))) problems.push(`Customer/Ops not reachable at ${env.baseUrl}`);
  if (!(await reachable(`${env.apiUrl}/api/v1/staff/bootstrap-status`))) problems.push(`API not reachable at ${env.apiUrl}`);
  const client = new pg.Client({ connectionString: env.databaseUrl });
  try {
    await client.connect();
    await client.query('select 1 from public.staff_sessions limit 1');
  } catch (error) {
    problems.push(`Database not usable (${(error as Error).message})`);
  } finally {
    await client.end().catch(() => {});
  }
  if (problems.length) {
    throw new Error(`Local stack is not ready:\n - ${problems.join('\n - ')}\nStart Supabase, API (:3001) and Customer (:3000) first.`);
  }
}
