export interface SavedOrderEntry {
  tenant: string;
  branch: string;
  href: string;
}

// This is a local navigation index, never an authorization source.
// Tokens stay in the existing scoped storage and are not placed in links.
export function readSavedOrderEntries(storage: Pick<Storage, 'length' | 'key' | 'getItem'>): SavedOrderEntry[] {
  const entries: SavedOrderEntry[] = [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const scope = key?.match(/^flashcommerce\.orderTracking:([A-Za-z0-9_-]{1,80}):([A-Za-z0-9_-]{1,80})$/);
      if (!key || !scope || !uuid.test(storage.getItem(key) ?? '')) continue;
      const [, tenant, branch] = scope;
      entries.push({ tenant, branch, href: `/menu/${encodeURIComponent(tenant)}/${encodeURIComponent(branch)}` });
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts.
    return [];
  }
  return entries.sort((a, b) => a.href.localeCompare(b.href));
}
