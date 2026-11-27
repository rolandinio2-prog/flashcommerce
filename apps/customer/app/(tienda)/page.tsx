import PublicEntryView from './components/public-entry-view';
import { resolvePublicEntry } from '../../lib/public-entry';
import type { EntryQuery } from '../../lib/entry-types';
export const dynamic = 'force-dynamic';
export const metadata = {title: 'Haz tu pedido | FlashCommerce', robots: {index: false, follow: false}};
export default async function Home({searchParams}: {searchParams: Promise<EntryQuery>}) {
  const query = await searchParams;
  // Only a generic entry uses the default storefront; explicit QR contexts stay validated.
  const defaultStorefront = query.tenant === undefined &&
    query.branch === undefined && query.tableContext === undefined
      ? {tenant: 'POLLO001', branch: 'SUC001'}
      : undefined;
  return <PublicEntryView result={await resolvePublicEntry(query, defaultStorefront)} />;
}
