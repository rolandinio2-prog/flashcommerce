import PublicEntryView from '../../../components/public-entry-view';
import { resolvePublicEntry } from '../../../../lib/public-entry';
import type { EntryQuery } from '../../../../lib/entry-types';
export const dynamic = 'force-dynamic';
export const metadata = {title: 'Haz tu pedido | FlashCommerce', robots: {index: false, follow: false}};
export default async function BranchPage({params,searchParams}: {params: Promise<{tenant:string;branch:string}>;searchParams:Promise<EntryQuery>}) {
  return <PublicEntryView result={await resolvePublicEntry(await searchParams,await params)} />;
}
