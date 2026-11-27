'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import QRCode from 'react-qr-code';

import {
  assignOperationalOrderToTable,
  closeOperationalTableSession,
  getOperationalTableQrContext,
  getOperationalTables,
  occupyOperationalTable,
  type OperationalDiningTable,
  type OperationalDiningTablesResponse,
  type OperationalOrder,
  type OperationalOrderStatus,
  type OperationalTableQrContextResponse,
} from '../../../../lib/flash-api';

interface OpsTablesPanelProps {
  tenantCode: string;
  branchCode: string;
  orders: OperationalOrder[];
  onOrdersChanged: () => Promise<void>;
}

type TableConfirmation =
  | {
      kind: 'OCCUPY';
      table: OperationalDiningTable;
    }
  | {
      kind: 'CLOSE';
      table: OperationalDiningTable;
    }
  | {
      kind: 'ASSIGN';
      table: OperationalDiningTable;
      order: OperationalOrder;
    };

const ACTIVE_ORDER_STATUSES:
  OperationalOrderStatus[] = [
    'PENDING',
    'CONFIRMED',
    'PREPARING',
    'READY',
  ];

function getErrorMessage(
  error: unknown,
  fallback: string,
) {
  return error instanceof Error
    ? error.message
    : fallback;
}

function getStatusLabel(
  status: OperationalOrderStatus,
) {
  switch (status) {
    case 'PENDING':
      return 'Pendiente';

    case 'CONFIRMED':
      return 'Confirmado';

    case 'PREPARING':
      return 'En preparación';

    case 'READY':
      return 'Listo';

    case 'COMPLETED':
      return 'Completado';

    case 'CANCELLED':
      return 'Cancelado';

    default:
      return status;
  }
}

function formatOccupiedTime(
  minutes: number,
) {
  if (minutes < 1) {
    return 'Menos de 1 min';
  }

  const days =
    Math.floor(minutes / 1440);

  const hours =
    Math.floor((minutes % 1440) / 60);

  const remainingMinutes =
    minutes % 60;

  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days} d`);
  }

  if (hours > 0) {
    parts.push(`${hours} h`);
  }

  if (
    remainingMinutes > 0 ||
    parts.length === 0
  ) {
    parts.push(`${remainingMinutes} min`);
  }

  return parts.join(' ');
}

function hasActiveOrders(
  table: OperationalDiningTable,
) {
  return table.orders.some(
    (order) =>
      ACTIVE_ORDER_STATUSES.includes(
        order.status,
      ),
  );
}

export default function OpsTablesPanel({
  tenantCode,
  branchCode,
  orders,
  onOrdersChanged,
}: OpsTablesPanelProps) {
  const [tablesResponse, setTablesResponse] =
    useState<OperationalDiningTablesResponse | null>(
      null,
    );

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState<string | null>(null);

  const [busyAction, setBusyAction] =
    useState<string | null>(null);

  const [selectedTableByOrder, setSelectedTableByOrder] =
    useState<Record<string, string>>({});

  const [confirmation, setConfirmation] =
    useState<TableConfirmation | null>(null);

  const [qrContext, setQrContext] =
    useState<OperationalTableQrContextResponse | null>(
      null,
    );

  const [qrLoadingTableId, setQrLoadingTableId] =
    useState<string | null>(null);

  const [qrLinkCopied, setQrLinkCopied] =
    useState(false);

  const loadTables =
    useCallback(async () => {
      try {
        const result =
          await getOperationalTables(
            tenantCode,
            branchCode,
          );

        setTablesResponse(result);
        setError(null);
      } catch (error) {
        setError(
          getErrorMessage(
            error,
            'No se pudieron recuperar las mesas',
          ),
        );
      } finally {
        setLoading(false);
      }
    }, [tenantCode, branchCode]);

  useEffect(() => {
    let stopped = false;
    let timerId: number | undefined;

    async function refreshTables() {
      await loadTables();

      if (!stopped) {
        timerId = window.setTimeout(
          refreshTables,
          5000,
        );
      }
    }

    void refreshTables();

    return () => {
      stopped = true;

      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [loadTables]);

  useEffect(() => {
    if (
      (!confirmation && !qrContext) ||
      busyAction ||
      qrLoadingTableId
    ) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setConfirmation(null);
        setQrContext(null);
        setQrLinkCopied(false);
      }
    }

    window.addEventListener(
      'keydown',
      handleKeyDown,
    );

    return () => {
      window.removeEventListener(
        'keydown',
        handleKeyDown,
      );
    };
  }, [
    confirmation,
    qrContext,
    busyAction,
    qrLoadingTableId,
  ]);

  const tables =
    tablesResponse?.tables ?? [];

  const unassignedOrders =
    useMemo(
      () =>
        orders.filter(
          (order) =>
            order.orderType === 'DINE_IN' &&
            !order.fulfillment.tableCode &&
            !order.tableSession,
        ),
      [orders],
    );

  const groupedTables =
    useMemo(() => {
      const groups = new Map<
        string,
        OperationalDiningTable[]
      >();

      for (const table of tables) {
        const zone =
          table.zone?.trim() || 'Sin zona';

        const zoneTables =
          groups.get(zone) ?? [];

        zoneTables.push(table);
        groups.set(zone, zoneTables);
      }

      return Array.from(groups.entries());
    }, [tables]);

  async function refreshAll() {
    await Promise.all([
      loadTables(),
      onOrdersChanged(),
    ]);
  }

  async function openTableQr(
    table: OperationalDiningTable,
  ) {
    if (qrLoadingTableId) {
      return;
    }

    setQrLoadingTableId(table.id);
    setQrLinkCopied(false);
    setError(null);

    try {
      const context =
        await getOperationalTableQrContext(
          table.id,
          tenantCode,
          branchCode,
        );

      setQrContext(context);
    } catch (error) {
      setError(
        getErrorMessage(
          error,
          'No se pudo cargar el QR permanente de la mesa',
        ),
      );
    } finally {
      setQrLoadingTableId(null);
    }
  }

  async function copyQrLink() {
    if (!qrContext) {
      return;
    }

    try {
      await navigator.clipboard.writeText(
        qrContext.permanentUrl,
      );

      setQrLinkCopied(true);

      window.setTimeout(
        () => setQrLinkCopied(false),
        2000,
      );
    } catch {
      setError(
        'No se pudo copiar el enlace. Puedes abrirlo y copiarlo desde el navegador.',
      );
    }
  }

  function printPermanentQr() {
    if (!qrContext) {
      return;
    }

    const qrNode =
      document.getElementById(
        'permanent-table-qr',
      );

    if (!qrNode) {
      setError(
        'No se pudo preparar el QR para impresión.',
      );

      return;
    }

    const printWindow =
      window.open(
        '',
        '_blank',
        'width=720,height=900',
      );

    if (!printWindow) {
      setError(
        'El navegador bloqueó la ventana de impresión. Habilita las ventanas emergentes e intenta nuevamente.',
      );

      return;
    }

    printWindow.document.open();
    printWindow.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>QR permanente</title>' +
        '<style>' +
        'body{font-family:Arial,sans-serif;margin:0;padding:32px;color:#111;background:#fff}' +
        'main{max-width:560px;margin:0 auto;text-align:center}' +
        'h1{font-size:28px;margin:0 0 8px}' +
        'p{font-size:15px;line-height:1.5;margin:8px 0}' +
        '.qr{width:320px;max-width:100%;margin:28px auto;padding:24px;border:1px solid #ddd;border-radius:24px}' +
        '.qr svg{width:100%;height:auto;display:block}' +
        '.url{font-family:monospace;font-size:12px;word-break:break-all;margin-top:20px}' +
        '@media print{body{padding:0}.qr{border-color:#bbb}}' +
        '</style></head><body><main id="print-root"></main></body></html>',
    );
    printWindow.document.close();

    const root =
      printWindow.document.getElementById(
        'print-root',
      );

    if (!root) {
      printWindow.close();
      setError(
        'No se pudo preparar la vista de impresión.',
      );

      return;
    }

    const title =
      printWindow.document.createElement('h1');

    title.textContent =
      `${qrContext.table.code} · ${qrContext.table.name}`;

    const instruction =
      printWindow.document.createElement('p');

    instruction.textContent =
      'Escanea este código para abrir el menú de esta mesa.';

    const permanentLabel =
      printWindow.document.createElement('p');

    permanentLabel.textContent =
      'QR físico permanente';

    const qrWrapper =
      printWindow.document.createElement('div');

    qrWrapper.className = 'qr';
    qrWrapper.innerHTML = qrNode.innerHTML;

    const url =
      printWindow.document.createElement('p');

    url.className = 'url';
    url.textContent = qrContext.permanentUrl;

    root.append(
      title,
      permanentLabel,
      instruction,
      qrWrapper,
      url,
    );

    printWindow.addEventListener(
      'afterprint',
      () => printWindow.close(),
      { once: true },
    );

    window.setTimeout(
      () => {
        printWindow.focus();
        printWindow.print();
      },
      250,
    );
  }

  function requestOccupy(
    table: OperationalDiningTable,
  ) {
    setConfirmation({
      kind: 'OCCUPY',
      table,
    });
  }

  async function occupyTable(
    table: OperationalDiningTable,
  ) {
    setBusyAction(`occupy:${table.id}`);
    setError(null);

    try {
      await occupyOperationalTable(
        table.id,
        tenantCode,
        branchCode,
      );

      await refreshAll();
    } catch (error) {
      setError(
        getErrorMessage(
          error,
          'No se pudo marcar la mesa como ocupada',
        ),
      );
    } finally {
      setBusyAction(null);
    }
  }

  function requestClose(
    table: OperationalDiningTable,
  ) {
    const session =
      table.tableSession;

    if (!session) {
      return;
    }

    if (hasActiveOrders(table)) {
      setError(
        `${table.name} todavía tiene pedidos activos. Complétalos antes de liberar la mesa.`,
      );

      return;
    }

    setConfirmation({
      kind: 'CLOSE',
      table,
    });
  }

  async function closeTable(
    table: OperationalDiningTable,
  ) {
    const session = table.tableSession;

    if (!session) {
      return;
    }

    setBusyAction(`close:${session.id}`);
    setError(null);

    try {
      await closeOperationalTableSession(
        session.id,
        tenantCode,
        branchCode,
      );

      await refreshAll();
    } catch (error) {
      setError(
        getErrorMessage(
          error,
          'No se pudo liberar la mesa',
        ),
      );
    } finally {
      setBusyAction(null);
    }
  }

  function requestAssignOrder(
    order: OperationalOrder,
  ) {
    const tableId =
      selectedTableByOrder[order.id];

    if (!tableId) {
      setError(
        `Selecciona una mesa para el pedido #${order.orderNumber}.`,
      );

      return;
    }

    const table =
      tables.find(
        (candidate) =>
          candidate.id === tableId,
      );

    if (!table) {
      setError(
        'La mesa seleccionada ya no está disponible en la lista.',
      );

      return;
    }

    setConfirmation({
      kind: 'ASSIGN',
      table,
      order,
    });
  }

  async function assignOrder(
    order: OperationalOrder,
    table: OperationalDiningTable,
  ) {
    setBusyAction(`assign:${order.id}`);
    setError(null);

    try {
      await assignOperationalOrderToTable(
        order.id,
        table.id,
        tenantCode,
        branchCode,
      );

      setSelectedTableByOrder(
        (current) => {
          const next = { ...current };

          delete next[order.id];

          return next;
        },
      );

      await refreshAll();
    } catch (error) {
      setError(
        getErrorMessage(
          error,
          'No se pudo asignar el pedido a la mesa',
        ),
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function confirmPendingAction() {
    if (!confirmation || busyAction) {
      return;
    }

    try {
      switch (confirmation.kind) {
        case 'OCCUPY':
          await occupyTable(confirmation.table);
          break;

        case 'CLOSE':
          await closeTable(confirmation.table);
          break;

        case 'ASSIGN':
          await assignOrder(
            confirmation.order,
            confirmation.table,
          );
          break;
      }
    } finally {
      setConfirmation(null);
    }
  }

  if (loading && !tablesResponse) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center">
        Cargando mesas...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">
          {error}
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-zinc-500">
            Mesas configuradas
          </p>
          <p className="mt-2 text-3xl font-bold">
            {tablesResponse?.total ?? 0}
          </p>
        </div>

        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
          <p className="text-sm font-semibold text-emerald-700">
            Disponibles
          </p>
          <p className="mt-2 text-3xl font-bold text-emerald-900">
            {tablesResponse?.available ?? 0}
          </p>
        </div>

        <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
          <p className="text-sm font-semibold text-red-700">
            Ocupadas
          </p>
          <p className="mt-2 text-3xl font-bold text-red-900">
            {tablesResponse?.occupied ?? 0}
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">
              Pedidos sin mesa
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              Asigna aquí los pedidos de consumo en local que continuaron sin seleccionar mesa.
            </p>
          </div>

          <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-800">
            {unassignedOrders.length}
          </span>
        </div>

        {unassignedOrders.length === 0 ? (
          <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-800">
            Todos los pedidos activos de consumo en local tienen mesa asignada.
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {unassignedOrders.map(
              (order) => (
                <div
                  key={order.id}
                  className="grid gap-3 rounded-xl border border-zinc-200 p-4 md:grid-cols-[1fr_minmax(220px,320px)_auto] md:items-center"
                >
                  <div>
                    <p className="text-lg font-bold">
                      #{order.orderNumber}
                    </p>
                    <p className="text-sm text-zinc-500">
                      {getStatusLabel(order.status)} · {order.currency} {order.total.toFixed(2)}
                    </p>
                  </div>

                  <select
                    value={
                      selectedTableByOrder[
                        order.id
                      ] ?? ''
                    }
                    onChange={(event) =>
                      setSelectedTableByOrder(
                        (current) => ({
                          ...current,
                          [order.id]:
                            event.target.value,
                        }),
                      )
                    }
                    className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-3 text-sm"
                  >
                    <option value="">
                      Seleccionar mesa
                    </option>

                    {tables.map(
                      (table) => (
                        <option
                          key={table.id}
                          value={table.id}
                        >
                          {table.code} · {table.name} · {table.availability === 'AVAILABLE' ? 'Disponible' : 'Ocupada'}
                        </option>
                      ),
                    )}
                  </select>

                  <button
                    type="button"
                    disabled={
                      busyAction !== null ||
                      !selectedTableByOrder[
                        order.id
                      ]
                    }
                    onClick={() =>
                      requestAssignOrder(order)
                    }
                    className="rounded-xl bg-zinc-950 px-4 py-3 text-sm font-bold text-white disabled:bg-zinc-400"
                  >
                    {busyAction ===
                    `assign:${order.id}`
                      ? 'Asignando...'
                      : 'Asignar mesa'}
                  </button>
                </div>
              ),
            )}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">
            Estado del salón
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Actualización automática cada 5 segundos.
          </p>
        </div>

        <button
          type="button"
          disabled={
            loading ||
            busyAction !== null
          }
          onClick={() =>
            void refreshAll()
          }
          className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Actualizar
        </button>
      </div>

      {groupedTables.map(
        ([zone, zoneTables]) => (
          <section key={zone}>
            <h3 className="mb-3 text-sm font-bold uppercase tracking-widest text-zinc-500">
              {zone}
            </h3>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {zoneTables.map(
                (table) => {
                  const session =
                    table.tableSession;

                  const activeOrders =
                    table.orders.filter(
                      (order) =>
                        ACTIVE_ORDER_STATUSES.includes(
                          order.status,
                        ),
                    );

                  const releaseBlocked =
                    activeOrders.length > 0;

                  return (
                    <article
                      key={table.id}
                      className={`rounded-2xl border p-5 shadow-sm ${
                        table.availability ===
                        'AVAILABLE'
                          ? 'border-emerald-200 bg-emerald-50'
                          : 'border-red-200 bg-white'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-2xl font-black">
                            {table.code}
                          </p>
                          <p className="font-semibold text-zinc-700">
                            {table.name}
                          </p>
                          <p className="mt-1 text-xs text-zinc-500">
                            Capacidad: {table.capacity}
                          </p>
                        </div>

                        <span
                          className={`rounded-full px-3 py-1 text-xs font-bold ${
                            table.availability ===
                            'AVAILABLE'
                              ? 'bg-emerald-200 text-emerald-900'
                              : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {table.availability ===
                          'AVAILABLE'
                            ? 'Disponible'
                            : 'Ocupada'}
                        </span>
                      </div>

                      {table.availability ===
                      'AVAILABLE' ? (
                        <>
                          <p className="mt-5 text-sm text-emerald-800">
                            Lista para recibir a un nuevo grupo.
                          </p>

                          <button
                            type="button"
                            disabled={
                              busyAction !== null
                            }
                            onClick={() =>
                              requestOccupy(table)
                            }
                            className="mt-5 w-full rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white disabled:bg-zinc-400"
                          >
                            {busyAction ===
                            `occupy:${table.id}`
                              ? 'Marcando...'
                              : 'Marcar ocupada'}
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="mt-5 rounded-xl bg-red-50 p-3">
                            <p className="text-xs font-bold uppercase tracking-wide text-red-700">
                              Tiempo ocupada
                            </p>
                            <p className="mt-1 text-xl font-black text-red-950">
                              {formatOccupiedTime(
                                session?.occupiedMinutes ??
                                  0,
                              )}
                            </p>
                          </div>

                          <div className="mt-4 space-y-2">
                            {table.orders.length ===
                            0 ? (
                              <p className="rounded-lg border border-dashed border-zinc-300 p-3 text-sm text-zinc-500">
                                Sesión sin pedidos vinculados
                              </p>
                            ) : (
                              table.orders.map(
                                (order) => (
                                  <div
                                    key={order.id}
                                    className="flex items-center justify-between gap-3 rounded-lg bg-zinc-100 px-3 py-2 text-sm"
                                  >
                                    <span className="font-bold">
                                      #{order.orderNumber}
                                    </span>
                                    <span className="text-xs font-semibold text-zinc-600">
                                      {getStatusLabel(
                                        order.status,
                                      )}
                                    </span>
                                  </div>
                                ),
                              )
                            )}
                          </div>

                          {releaseBlocked && (
                            <p className="mt-4 text-xs font-semibold text-amber-700">
                              Completa los pedidos activos antes de liberar esta mesa.
                            </p>
                          )}

                          <button
                            type="button"
                            disabled={
                              busyAction !== null ||
                              !session ||
                              releaseBlocked
                            }
                            onClick={() =>
                              requestClose(table)
                            }
                            className="mt-5 w-full rounded-xl bg-zinc-950 px-4 py-3 text-sm font-bold text-white disabled:bg-zinc-400"
                          >
                            {session &&
                            busyAction ===
                              `close:${session.id}`
                              ? 'Liberando...'
                              : 'Liberar mesa'}
                          </button>
                        </>
                      )}

                      <button
                        type="button"
                        disabled={
                          busyAction !== null ||
                          qrLoadingTableId !== null
                        }
                        onClick={() =>
                          void openTableQr(table)
                        }
                        className="mt-3 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-bold text-zinc-800 transition hover:border-zinc-950 hover:bg-zinc-50 disabled:opacity-50"
                      >
                        {qrLoadingTableId ===
                        table.id
                          ? 'Cargando QR...'
                          : 'Ver QR permanente'}
                      </button>
                    </article>
                  );
                },
              )}
            </div>
          </section>
        ),
      )}

      {confirmation && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/60 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              !busyAction
            ) {
              setConfirmation(null);
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="table-confirmation-title"
            aria-describedby="table-confirmation-description"
            className="w-full max-w-lg overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-2xl"
          >
            <div className="border-b border-zinc-100 px-6 py-5 sm:px-7">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">
                Gestión de mesas
              </p>
              <h2
                id="table-confirmation-title"
                className="mt-2 text-2xl font-black text-zinc-950"
              >
                {confirmation.kind === 'OCCUPY'
                  ? 'Confirmar ocupación'
                  : confirmation.kind === 'CLOSE'
                    ? 'Confirmar liberación'
                    : 'Confirmar asignación'}
              </h2>
              <p
                id="table-confirmation-description"
                className="mt-2 text-sm leading-6 text-zinc-600"
              >
                {confirmation.kind === 'OCCUPY'
                  ? 'Confirma que los clientes ya se encuentran en esta mesa.'
                  : confirmation.kind === 'CLOSE'
                    ? 'Confirma que los clientes se retiraron y la mesa está lista para otro grupo.'
                    : `El pedido #${confirmation.order.orderNumber} quedará vinculado a esta mesa.`}
              </p>
            </div>

            <div className="space-y-4 px-6 py-5 sm:px-7">
              <div
                className={`rounded-2xl border p-5 ${
                  confirmation.kind === 'CLOSE'
                    ? 'border-red-200 bg-red-50'
                    : 'border-emerald-200 bg-emerald-50'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-2xl font-black text-zinc-950">
                      {confirmation.table.code}
                    </p>
                    <p className="font-semibold text-zinc-700">
                      {confirmation.table.name}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      Capacidad: {confirmation.table.capacity}
                    </p>
                  </div>

                  <span
                    className={`rounded-full px-3 py-1 text-xs font-bold ${
                      confirmation.kind === 'CLOSE'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-emerald-200 text-emerald-900'
                    }`}
                  >
                    {confirmation.table.zone ||
                      'Sin zona'}
                  </span>
                </div>

                <div className="mt-5 flex items-center justify-between gap-3 rounded-xl bg-white/80 px-4 py-3 text-sm font-bold">
                  {confirmation.kind === 'ASSIGN' ? (
                    <>
                      <span className="text-zinc-600">
                        Pedido #{confirmation.order.orderNumber}
                      </span>
                      <span
                        aria-hidden="true"
                        className="text-zinc-400"
                      >
                        →
                      </span>
                      <span className="text-emerald-800">
                        {confirmation.table.code}
                      </span>
                    </>
                  ) : (
                    <>
                      <span
                        className={
                          confirmation.kind === 'CLOSE'
                            ? 'text-red-700'
                            : 'text-emerald-800'
                        }
                      >
                        {confirmation.kind === 'CLOSE'
                          ? 'Ocupada'
                          : 'Disponible'}
                      </span>
                      <span
                        aria-hidden="true"
                        className="text-zinc-400"
                      >
                        →
                      </span>
                      <span
                        className={
                          confirmation.kind === 'CLOSE'
                            ? 'text-emerald-800'
                            : 'text-red-700'
                        }
                      >
                        {confirmation.kind === 'CLOSE'
                          ? 'Disponible'
                          : 'Ocupada'}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {confirmation.kind === 'ASSIGN' &&
                confirmation.table.availability ===
                  'OCCUPIED' && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                    La mesa ya está ocupada. Confirma que el pedido pertenece al mismo grupo.
                  </div>
                )}
            </div>

            <div className="grid gap-3 border-t border-zinc-100 bg-zinc-50 px-6 py-5 sm:grid-cols-2 sm:px-7">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() =>
                  setConfirmation(null)
                }
                className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-bold text-zinc-800 transition hover:bg-zinc-100 disabled:opacity-50"
              >
                Cancelar
              </button>

              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() =>
                  void confirmPendingAction()
                }
                className={`rounded-xl px-4 py-3 text-sm font-bold text-white transition disabled:bg-zinc-400 ${
                  confirmation.kind === 'OCCUPY'
                    ? 'bg-emerald-700 hover:bg-emerald-800'
                    : 'bg-zinc-950 hover:bg-zinc-800'
                }`}
              >
                {busyAction
                  ? 'Procesando...'
                  : confirmation.kind === 'OCCUPY'
                    ? 'Sí, marcar ocupada'
                    : confirmation.kind === 'CLOSE'
                      ? 'Sí, liberar mesa'
                      : 'Sí, asignar mesa'}
              </button>
            </div>
          </section>
        </div>
      )}

      {qrContext && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-zinc-950/60 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setQrContext(null);
              setQrLinkCopied(false);
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="table-qr-title"
            className="max-h-[94vh] w-full max-w-md overflow-y-auto rounded-3xl border border-zinc-200 bg-white shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-zinc-100 px-6 py-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">
                  QR permanente
                </p>
                <h2
                  id="table-qr-title"
                  className="mt-2 text-2xl font-black text-zinc-950"
                >
                  {qrContext.table.code} · {qrContext.table.name}
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  {qrContext.table.zone || 'Sin zona'} · Capacidad {qrContext.table.capacity}
                </p>
              </div>

              <button
                type="button"
                aria-label="Cerrar QR"
                onClick={() => {
                  setQrContext(null);
                  setQrLinkCopied(false);
                }}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-200 bg-white text-xl text-zinc-700 hover:bg-zinc-100"
              >
                ×
              </button>
            </div>

            <div className="space-y-4 px-6 py-5">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-center">
                <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                  QR físico permanente
                </p>
                <p className="mt-1 text-sm font-semibold text-emerald-950">
                  Puedes imprimirlo y mantenerlo en la mesa. No vence cuando cambia la sesión.
                </p>
              </div>
              <div
                id="permanent-table-qr"
                className="mx-auto w-full max-w-[300px] rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm"
              >
                <QRCode
                  value={qrContext.permanentUrl}
                  title={`QR permanente de ${qrContext.table.code}`}
                  size={256}
                  level="M"
                  viewBox="0 0 256 256"
                  style={{
                    height: 'auto',
                    maxWidth: '100%',
                    width: '100%',
                  }}
                />
              </div>

              <button
                type="button"
                onClick={printPermanentQr}
                className="w-full rounded-xl bg-zinc-950 px-4 py-3 text-sm font-bold text-white transition hover:bg-zinc-800"
              >
                Imprimir QR
              </button>

              <p className="text-center text-sm leading-6 text-zinc-600">
                Al escanear este código, FastPay identifica automáticamente la mesa para realizar pedidos desde ella.
              </p>

              <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
                <p className="font-bold">
                  Independiente de pedidos y sesiones
                </p>
                <p className="mt-1 leading-5">
                  Este QR identifica únicamente la mesa. Cada cliente conserva sus propios pedidos y el código sigue siendo válido cuando la mesa se libera y vuelve a ocuparse.
                </p>
              </div>
              <div className="rounded-xl bg-zinc-100 px-4 py-3">
                <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">
                  Enlace permanente
                </p>
                <p className="mt-2 break-all text-xs leading-5 text-zinc-700">
                  {qrContext.permanentUrl}
                </p>
              </div>
            </div>

            <div className="grid gap-3 border-t border-zinc-100 bg-zinc-50 px-6 py-5 sm:grid-cols-2">
              <button
                type="button"
                onClick={() =>
                  void copyQrLink()
                }
                className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-bold text-zinc-800 hover:bg-zinc-100"
              >
                {qrLinkCopied
                  ? 'Enlace copiado'
                  : 'Copiar enlace'}
              </button>

              <a
                href={qrContext.permanentUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-xl bg-zinc-950 px-4 py-3 text-center text-sm font-bold text-white hover:bg-zinc-800"
              >
                Abrir menú
              </a>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
