'use client';

import { useEffect, useState } from 'react';
import { listDrafts, type CheckoutDraft } from '../../../lib/checkout-draft';
import { readSavedOrderEntries, type SavedOrderEntry } from '../../../lib/saved-order-entries';

export default function SavedOrdersEntry() {
  const [drafts,setDrafts]=useState<CheckoutDraft[]>([]);
  const [entries, setEntries] = useState<SavedOrderEntry[]>([]);

  useEffect(() => {
    const refresh = () => {
      try { setEntries(readSavedOrderEntries(window.localStorage));setDrafts(listDrafts(window.localStorage)); }
      catch { setEntries([]);setDrafts([]); }
    };
    refresh();
    window.addEventListener('storage', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, []);

  if (entries.length === 0 && drafts.length === 0) return null;

  return <section aria-labelledby="saved-orders-title" className="mt-8 rounded-2xl border border-red-200 bg-white p-5">
    <h2 id="saved-orders-title" className="text-xl font-bold">Retoma tu pedido</h2>
    <p className="mt-2 text-sm leading-6 text-zinc-600">Recupera una compra en preparación o consulta un pedido ya confirmado en este navegador.</p>
    {drafts.length>0&&<div className="mt-4 space-y-3"><h3 className="font-bold">Pedidos por terminar</h3>{drafts.map(draft=><a key={draft.tenant+':'+draft.branch}
      href={'/menu/'+encodeURIComponent(draft.tenant)+'/'+encodeURIComponent(draft.branch)} className="block rounded-xl border border-red-200 p-4 text-red-700">
      <strong>Continuar mi pedido</strong><span className="block text-sm">Comercio {draft.tenant} · Sucursal {draft.branch}</span>
      <span className="block text-sm">{draft.items.map(item=>item.quantity+' × '+item.name).join(' · ')}</span></a>)}</div>}
    <ul className="mt-4 space-y-3">
      {entries.map(entry => <li key={entry.href}>
        <a href={entry.href} className="block rounded-xl bg-red-700 px-4 py-3 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2">
          Retomar pedido
          <span className="mt-1 block break-words text-sm font-normal">Comercio {entry.tenant} · Sucursal {entry.branch}</span>
        </a>
      </li>)}
    </ul>
  </section>;
}
