import OpsSessionClient from './components/ops-session-client';
import CustomerPageZoomGuard from '../../_shared/customer-page-zoom-guard';
import { resolveOpsEntryContext, type OpsEntryParams } from '../../../lib/ops-entry-context';

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<OpsEntryParams>;
}) {
  const context = resolveOpsEntryContext(await searchParams);
  return (
    <div data-ops-page-zoom="fixed">
      <CustomerPageZoomGuard />
      {context.valid ? (
        <OpsSessionClient
          key={`${context.tenantCode}:${context.branchCode}`}
          tenantCode={context.tenantCode}
          branchCode={context.branchCode}
        />
      ) : (
        <main className="mx-auto max-w-lg space-y-4 px-4 py-10">
          <h1 className="text-2xl font-black">Acceso de operadores</h1>
          <p role="alert">{context.message}</p>
          <a href="/ops" className="inline-block rounded-lg border px-4 py-3 font-bold">
            Volver al acceso principal
          </a>
        </main>
      )}
    </div>
  );
}
