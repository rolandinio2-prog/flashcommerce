"use client";

import { useCallback, useEffect, useState } from "react";

import {
  getOperationalOrders,
  updateOperationalOrderStatus,
  type OperationalOrder,
  type OperationalOrderStatus,
} from "../../../lib/flash-api";

import OpsTablesPanel from "./ops-tables-panel";
import OpsReservationsPanel from "./ops-reservations-panel";

// =========================================================
// KDS - DATOS DE FULFILLMENT
//
// Esta interfaz local permite mostrar los nuevos datos
// enviados por el backend sin obligarnos todavía a modificar
// otros módulos del frontend.
// =========================================================

interface OperationalOrderFulfillment {
  scheduledFor: string | null;
  customerName: string | null;
  customerPhone: string | null;
  tableCode: string | null;
  deliveryAddress: string | null;
  customerNotes: string | null;
}

type OperationalOrderWithFulfillment = OperationalOrder & {
  fulfillment?: OperationalOrderFulfillment;
};

interface OpsOrdersClientProps {
  tenantCode: string;
  branchCode: string;
}

interface StatusColumn {
  status: OperationalOrderStatus;
  title: string;
}

type OpsTab = "ORDERS" | "TABLES" | "RESERVATIONS";

const STATUS_COLUMNS: StatusColumn[] = [
  {
    status: "PENDING",
    title: "Pendientes",
  },
  {
    status: "CONFIRMED",
    title: "Confirmados",
  },
  {
    status: "PREPARING",
    title: "En preparación",
  },
  {
    status: "READY",
    title: "Listos",
  },
];

// =========================================================
// 1. ETIQUETAS DE MODALIDAD
// =========================================================

function getOrderTypeLabel(orderType: string) {
  switch (orderType) {
    case "DINE_IN":
      return "Consumo en local";

    case "TAKEAWAY":
      return "Para llevar";

    case "PICKUP":
      return "Recoger programado";

    case "DELIVERY":
      return "Delivery";

    default:
      return orderType;
  }
}

// =========================================================
// 2. FORMATO DE HORAS
//
// El piloto trabaja con la zona horaria de Bolivia.
// Más adelante podremos tomar el timezone de la sucursal.
// =========================================================

function formatBoliviaTime(value: string) {
  return new Date(value).toLocaleTimeString("es-BO", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/La_Paz",
  });
}

// =========================================================
// 3. FLUJO DE ESTADOS KDS
// =========================================================

function getNextStatus(
  status: OperationalOrderStatus,
): OperationalOrderStatus | null {
  switch (status) {
    case "PENDING":
      return "CONFIRMED";

    case "CONFIRMED":
      return "PREPARING";

    case "PREPARING":
      return "READY";

    case "READY":
      return "COMPLETED";

    default:
      return null;
  }
}

function getActionLabel(status: OperationalOrderStatus) {
  switch (status) {
    case "PENDING":
      return "Confirmar pedido";

    case "CONFIRMED":
      return "Iniciar preparación";

    case "PREPARING":
      return "Marcar como listo";

    case "READY":
      return "Completar pedido";

    default:
      return "Continuar";
  }
}

function isAdvanceOrderPreparationLocked(
  order: OperationalOrderWithFulfillment,
): boolean {
  return Boolean(
    order.status === "CONFIRMED" &&
    order.reservation &&
    new Date(order.reservation.reservedFor).getTime() - Date.now() >
      60 * 60 * 1000,
  );
}

// =========================================================
// 4. COMPONENTE KDS
// =========================================================

export default function OpsOrdersClient({
  tenantCode,
  branchCode,
}: OpsOrdersClientProps) {
  const [orders, setOrders] = useState<OperationalOrderWithFulfillment[]>([]);

  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);

  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<OpsTab>("ORDERS");

  // =======================================================
  // 5. CARGA DE PEDIDOS ACTIVOS
  // =======================================================

  const loadOrders = useCallback(async () => {
    setError(null);

    try {
      const result = await getOperationalOrders(tenantCode, branchCode);

      setOrders(result.orders);
    } catch (error) {
      if (error instanceof Error) {
        setError(error.message);
      } else {
        setError("No se pudieron recuperar los pedidos");
      }
    } finally {
      setLoading(false);
    }
  }, [tenantCode, branchCode]);

  // =======================================================
  // 6. POLLING AUTOMÁTICO CADA 5 SEGUNDOS
  // =======================================================

  useEffect(() => {
    let stopped = false;
    let timerId: number | undefined;

    async function refreshOrders() {
      await loadOrders();

      if (!stopped) {
        timerId = window.setTimeout(refreshOrders, 5000);
      }
    }

    void refreshOrders();

    return () => {
      stopped = true;

      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [loadOrders]);

  // =======================================================
  // 7. AVANZAR ESTADO DEL PEDIDO
  // =======================================================

  async function advanceOrder(order: OperationalOrderWithFulfillment) {
    const nextStatus = getNextStatus(order.status);

    if (!nextStatus) {
      return;
    }

    setBusyOrderId(order.id);
    setError(null);

    try {
      await updateOperationalOrderStatus(order.id, nextStatus);

      await loadOrders();
    } catch (error) {
      if (error instanceof Error) {
        setError(error.message);
      } else {
        setError("No se pudo actualizar el pedido");
      }
    } finally {
      setBusyOrderId(null);
    }
  }

  // =======================================================
  // 8. INTERFAZ KDS
  // =======================================================

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-5 px-6 py-5">
          <div>
            <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
              Flash Commerce
            </p>

            <h1 className="text-2xl font-bold">
              Operaciones ·{" "}
              {activeTab === "ORDERS"
                ? "KDS"
                : activeTab === "TABLES"
                  ? "Mesas"
                  : "Reservas"}
            </h1>

            <p className="mt-1 text-sm text-zinc-500">
              {tenantCode} · {branchCode}
            </p>
          </div>

          <div className="text-right">
            <p className="text-sm text-zinc-500">Pedidos activos</p>

            <p className="mt-1 text-xs text-zinc-400">
              Actualización automática · 5 s
            </p>

            <p className="text-2xl font-bold">{orders.length}</p>

            {activeTab === "ORDERS" && (
              <button
                type="button"
                disabled={loading || busyOrderId !== null}
                onClick={() => void loadOrders()}
                className="mt-2 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                Actualizar
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="border-b border-zinc-200 bg-white">
        <nav className="mx-auto flex max-w-[1600px] gap-2 px-6 py-3">
          <button
            type="button"
            onClick={() => setActiveTab("ORDERS")}
            className={`rounded-xl px-5 py-3 text-sm font-bold transition ${
              activeTab === "ORDERS"
                ? "bg-zinc-950 text-white"
                : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            }`}
          >
            Pedidos
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("TABLES")}
            className={`rounded-xl px-5 py-3 text-sm font-bold transition ${
              activeTab === "TABLES"
                ? "bg-zinc-950 text-white"
                : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            }`}
          >
            Mesas
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("RESERVATIONS")}
            className={`rounded-xl px-5 py-3 text-sm font-bold transition ${
              activeTab === "RESERVATIONS"
                ? "bg-zinc-950 text-white"
                : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            }`}
          >
            Reservas
          </button>
        </nav>
      </div>

      {error && (
        <div className="mx-auto max-w-[1600px] px-6 pt-5">
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">
            {error}
          </div>
        </div>
      )}

      <div className="mx-auto max-w-[1600px] px-6 py-6">
        {activeTab === "TABLES" ? (
          <OpsTablesPanel
            tenantCode={tenantCode}
            branchCode={branchCode}
            orders={orders}
            onOrdersChanged={loadOrders}
          />
        ) : activeTab === "RESERVATIONS" ? (
          <OpsReservationsPanel
            tenantCode={tenantCode}
            branchCode={branchCode}
          />
        ) : loading ? (
          <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center">
            Cargando pedidos...
          </div>
        ) : (
          <div className="grid gap-5 xl:grid-cols-4">
            {STATUS_COLUMNS.map((column) => {
              const columnOrders = orders.filter(
                (order) => order.status === column.status,
              );

              return (
                <section
                  key={column.status}
                  className="min-h-80 rounded-2xl border border-zinc-200 bg-zinc-50 p-4"
                >
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-lg font-bold">{column.title}</h2>

                    <span className="rounded-full bg-zinc-200 px-3 py-1 text-sm font-bold">
                      {columnOrders.length}
                    </span>
                  </div>

                  <div className="space-y-4">
                    {columnOrders.length === 0 && (
                      <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">
                        Sin pedidos
                      </div>
                    )}

                    {columnOrders.map((order) => {
                      const fulfillment = order.fulfillment;

                      // =====================================================
                      // MOSTRAR FULFILLMENT SÓLO SI EXISTE INFORMACIÓN REAL
                      // =====================================================

                      const hasFulfillmentData = Boolean(
                        fulfillment &&
                        (fulfillment.scheduledFor ||
                          fulfillment.customerName ||
                          fulfillment.customerPhone ||
                          fulfillment.tableCode ||
                          fulfillment.deliveryAddress),
                      );

                      const preparationLocked =
                        isAdvanceOrderPreparationLocked(order);

                      return (
                        <article
                          key={order.id}
                          className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm"
                        >
                          {/* =================================
                                  CABECERA DEL PEDIDO
                              ================================= */}

                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <p className="text-2xl font-bold">
                                #{order.orderNumber}
                              </p>

                              <p className="mt-1 text-sm font-semibold text-zinc-600">
                                {getOrderTypeLabel(order.orderType)}
                              </p>
                            </div>

                            <div className="text-right">
                              <p className="font-bold">
                                {order.currency} {order.total.toFixed(2)}
                              </p>

                              <p className="mt-1 text-xs text-zinc-500">
                                Pedido: {formatBoliviaTime(order.createdAt)}
                              </p>
                            </div>
                          </div>

                          {order.reservation && (
                            <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-3">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-xs font-bold uppercase tracking-wide text-sky-700">
                                  Pedido anticipado
                                </p>
                                <span className="rounded-full bg-white px-2 py-1 text-xs font-bold text-sky-800">
                                  Reserva {order.reservation.reservationCode}
                                </span>
                              </div>
                              <p className="mt-2 text-lg font-black text-sky-950">
                                Preparar para las{" "}
                                {formatBoliviaTime(
                                  order.reservation.reservedFor,
                                )}
                              </p>
                              <p className="mt-1 text-xs text-sky-800">
                                Se vinculará a la sesión de mesa durante el
                                check-in.
                              </p>
                            </div>
                          )}

                          {/* =================================
                                  FULFILLMENT
                              ================================= */}

                          {hasFulfillmentData && fulfillment && (
                            <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                              {order.orderType === "PICKUP" &&
                                fulfillment.scheduledFor && (
                                  <div className="mb-3">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                                      Retiro programado
                                    </p>

                                    <p className="mt-1 text-xl font-bold">
                                      {formatBoliviaTime(
                                        fulfillment.scheduledFor,
                                      )}
                                    </p>
                                  </div>
                                )}

                              {order.orderType === "DINE_IN" &&
                                fulfillment.tableCode && (
                                  <div className="mb-3">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                                      Mesa
                                    </p>

                                    <p className="mt-1 text-xl font-bold">
                                      {fulfillment.tableCode}
                                    </p>
                                  </div>
                                )}

                              {(fulfillment.customerName ||
                                fulfillment.customerPhone) && (
                                <div className="space-y-1 text-sm">
                                  {fulfillment.customerName && (
                                    <p className="font-semibold">
                                      {fulfillment.customerName}
                                    </p>
                                  )}

                                  {fulfillment.customerPhone && (
                                    <p className="text-zinc-600">
                                      Tel. {fulfillment.customerPhone}
                                    </p>
                                  )}
                                </div>
                              )}

                              {order.orderType === "DELIVERY" &&
                                fulfillment.deliveryAddress && (
                                  <div className="mt-3 border-t border-zinc-200 pt-3">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                                      Dirección
                                    </p>

                                    <p className="mt-1 text-sm font-medium">
                                      {fulfillment.deliveryAddress}
                                    </p>
                                  </div>
                                )}
                            </div>
                          )}

                          <div className="my-4 border-t border-zinc-200" />

                          {/* =================================
                                  PRODUCTOS
                              ================================= */}

                          <div className="space-y-2">
                            {order.items.map((item, index) => (
                              <div
                                key={`${item.productId}-${index}`}
                                className="flex justify-between gap-3 text-sm"
                              >
                                <span>
                                  <strong>{item.quantity}×</strong> {item.name}
                                </span>

                                <span className="text-zinc-500">
                                  {order.currency}{" "}
                                  {Number(item.lineTotal).toFixed(2)}
                                </span>
                              </div>
                            ))}
                          </div>

                          {/* =================================
                                  NOTAS DEL CLIENTE
                              ================================= */}

                          {fulfillment?.customerNotes && (
                            <div className="mt-4 rounded-xl border border-zinc-200 p-3">
                              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                                Nota
                              </p>

                              <p className="mt-1 text-sm">
                                {fulfillment.customerNotes}
                              </p>
                            </div>
                          )}

                          {/* =================================
                                  ACCIÓN OPERATIVA
                              ================================= */}

                          <button
                            type="button"
                            disabled={
                              busyOrderId === order.id || preparationLocked
                            }
                            onClick={() => void advanceOrder(order)}
                            className="mt-5 w-full rounded-xl bg-zinc-950 px-4 py-3 text-sm font-bold text-white disabled:bg-zinc-400"
                          >
                            {busyOrderId === order.id
                              ? "Actualizando..."
                              : preparationLocked
                                ? `Preparación disponible desde ${formatBoliviaTime(
                                    new Date(
                                      new Date(
                                        order.reservation!.reservedFor,
                                      ).getTime() -
                                        60 * 60 * 1000,
                                    ).toISOString(),
                                  )}`
                                : getActionLabel(order.status)}
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
