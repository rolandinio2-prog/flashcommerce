import PublicEntryView from '../../components/public-entry-view';
import { resolvePublicEntry } from '../../../../lib/public-entry';
import type { EntryQuery } from '../../../../lib/entry-types';
export const dynamic = 'force-dynamic';
export const metadata = {title: 'Elige tu sucursal | FlashCommerce', robots: {index: false, follow: false}};
export default async function CommercePage({params,searchParams}: {params: Promise<{tenant:string}>;searchParams:Promise<EntryQuery>}) {
  const {tenant}=await params;
  return <PublicEntryView result={await resolvePublicEntry(await searchParams,{tenant})} />;
}
