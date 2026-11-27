import SavedOrdersEntry from './saved-orders-entry';
import FlashMenuClient from './flash-menu-client';
import type { EntryResult } from '../../../lib/public-entry';
import styles from './order-design.module.css';

export default function PublicEntryView({ result }: { result: EntryResult }) {
  if (result.kind === 'catalog') {
    // Force independent client state if navigation changes commerce or branch.
    return <FlashMenuClient key={`${result.catalog.tenant.code}:${result.catalog.branch.code}`} catalog={result.catalog} />;
  }
  if (result.kind === 'branches') {
    const { directory } = result;
    return <main className={`${styles.scope} mx-auto max-w-xl px-5 py-10`}>
      <p className="text-sm text-zinc-600">Haz tu pedido</p>
      <h1 className="mt-2 text-3xl font-bold">{directory.tenant.name}</h1>
      <h2 className="mt-6 text-xl font-semibold">Elige tu sucursal</h2>
      <p className="mt-2 text-sm text-zinc-600">Cada sucursal tiene su propio catálogo y precios. Tus carritos se conservan por separado.</p>
      <ul className="mt-6 space-y-3">{directory.branches.map(branch => <li key={branch.code}>
        <a className="block rounded-xl border border-zinc-200 bg-white p-4 font-semibold text-red-700 focus-visible:outline-2 focus-visible:outline-offset-2" href={`/menu/${encodeURIComponent(directory.tenant.code)}/${encodeURIComponent(branch.code)}`}>
          {branch.name}<span className="mt-1 block text-sm font-normal text-zinc-600">Ver productos →</span>
        </a>
      </li>)}</ul>
    </main>;
  }
  const messages = {
    welcome: ['Tu próximo pedido empieza aquí', 'Abre el enlace o escanea el QR de tu comercio para ver sus productos y elegir la sucursal.'],
    invalid: ['No pudimos validar este acceso', 'Revisa el enlace del comercio. Si escaneaste el QR de una mesa, solicita al personal un acceso válido.'],
    unavailable: ['Este acceso no está disponible', 'El comercio o la sucursal no están disponibles. Solicita un enlace actualizado al negocio.'],
    temporary: ['No pudimos cargar el menú', 'Hay un problema temporal de conexión. Intenta abrir este mismo enlace de nuevo en unos momentos.'],
  } as const;
  const [title, description] = messages[result.kind];
  return <main className={`${styles.scope} mx-auto max-w-xl px-5 py-12`}>
    <p className="text-sm font-semibold text-red-700">FlashCommerce</p>
    <h1 className="mt-4 text-3xl font-bold">{title}</h1>
    <p className="mt-4 leading-7 text-zinc-600">{description}</p>
    {result.kind === 'welcome' && <SavedOrdersEntry />}
  </main>;
}
