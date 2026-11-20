import 'server-only';
import type { BranchDirectory, Catalog, EntryQuery } from './entry-types';

export type EntryResult =
  | { kind: 'welcome' }
  | { kind: 'unavailable' | 'invalid' | 'temporary' }
  | { kind: 'branches'; directory: BranchDirectory }
  | { kind: 'catalog'; catalog: Catalog };
export function validEntryCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}
class EntryFailure extends Error {
  constructor(public kind: 'unavailable' | 'invalid' | 'temporary') { super(kind); }
}
async function apiRead<T>(endpoint: string): Promise<T> {
  const configured = process.env.FLASH_API_INTERNAL_URL?.trim() || process.env.FLASH_API_URL?.trim();
  if (!configured) throw new EntryFailure('temporary');
  let response: Response;
  try {
    response = await fetch(`${configured.replace(/\/+$/, '')}/api/v1/${endpoint}`, {
      cache: 'no-store', signal: AbortSignal.timeout(10000), redirect: 'error',
    });
  } catch { throw new EntryFailure('temporary'); }
  if (!response.ok) throw new EntryFailure(response.status === 404 ? 'unavailable' : [400,401,403].includes(response.status) ? 'invalid' : 'temporary');
  try { return await response.json() as T; } catch { throw new EntryFailure('temporary'); }
}
export async function resolvePublicEntry(query: EntryQuery, expected?: {tenant: string; branch?: string}): Promise<EntryResult> {
  try {
    let tenant: unknown = expected?.tenant ?? query.tenant;
    let branch: unknown = expected?.branch ?? query.branch;
    // Canonical paths cannot be overridden by query parameters.
    if (expected && ((query.tenant !== undefined && query.tenant !== expected.tenant) ||
      (query.branch !== undefined && query.branch !== expected.branch))) return {kind:'invalid'};
    if (query.tableContext !== undefined) {
      const token = query.tableContext;
      if (typeof token !== 'string' || token.length === 0 || token.length > 8192) return {kind:'invalid'};
      const context = await apiRead<{tenant: string; branch: string}>(`tables/context?${new URLSearchParams({token})}`);
      if (!validEntryCode(context.tenant) || !validEntryCode(context.branch)) return {kind:'invalid'};
      if ((tenant !== undefined && tenant !== context.tenant) || (branch !== undefined && branch !== context.branch)) return {kind:'invalid'};
      tenant = context.tenant; branch = context.branch;
    }
    if (tenant === undefined && branch === undefined) return {kind:'welcome'};
    if (!validEntryCode(tenant) || (branch !== undefined && !validEntryCode(branch))) return {kind:'invalid'};
    if (branch === undefined) {
      const directory = await apiRead<BranchDirectory>(`catalog/branches?${new URLSearchParams({tenant})}`);
      if (directory?.tenant?.code !== tenant || !Array.isArray(directory.branches) || !directory.branches.length || directory.branches.some(b=>!validEntryCode(b.code))) return {kind:'unavailable'};
      return {kind:'branches',directory};
    }
    const catalog = await apiRead<Catalog>(`catalog?${new URLSearchParams({tenant,branch:branch as string})}`);
    if (catalog?.tenant?.code !== tenant || catalog?.branch?.code !== branch || !Array.isArray(catalog.categories)) return {kind:'invalid'};
    return {kind:'catalog',catalog};
  } catch(error) { return {kind:error instanceof EntryFailure ? error.kind : 'temporary'}; }
}
