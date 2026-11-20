"use client";

import OpsPosCheckout from './ops-pos-checkout';

import { useCallback, useEffect, useRef, useState } from "react";

import {
  confirmOperationalCashPayment,
  getOperationalOrders,
  getOperationsCapabilities,
  type OperationsCapabilities,
  handoffOperationalDelivery,
  updateOperationalOrderStatus,
  type OrderOrigin,
  type OrderPaymentStatus,
  type OperationalOrder,
  type OperationalOrderStatus,
  type StaffSessionUser,
} from "../../../lib/flash-api";

import OpsCashPanel from './ops-cash-panel';
import OpsCashWorkbench from './ops-cash-workbench';
import OpsCashProducts from './ops-cash-products';
import { canReceiveCashPayment, cashOrderFingerprint } from './ops-cash-eligibility';
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

interface CashPaymentReceipt {
  orderNumber: string;
  currency: string;
  total: number;
  received: number;
  change: number;
  transactionId: string | null;
}
interface OpsOrdersClientProps {
  tenantCode: string;
  branchCode: string;
  operator: StaffSessionUser;
}

interface StatusColumn {
  status: OperationalOrderStatus;
  title: string;
}

type OpsTab = "ORDERS" | "TABLES" | "RESERVATIONS" | "CASH";

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

function getPaymentStatusLabel(status: OrderPaymentStatus) {
  switch (status) {
    case "NOT_REQUIRED":
      return "No requerido";

    case "PENDING":
      return "Pago pendiente";

    case "AWAITING_CONFIRMATION":
      return "Esperando confirmación";

    case "PAID":
      return "Pago verificado";

    case "FAILED":
      return "Pago fallido";

    case "EXPIRED":
      return "QR expirado";

    case "CANCELLED":
      return "Pago cancelado";

    case "REFUND_PENDING":
      return "Reembolso pendiente";

    case "REFUNDED":
      return "Reembolsado";

    case "REVIEW_REQUIRED":
      return "Revisión requerida";
  }
}

function getOrderOriginLabel(origin: OrderOrigin) {
  switch (origin) {
    case "LEGACY":
      return "Pedido anterior";

    case "PUBLIC_MENU":
      return "Menú público";

    case "TABLE_QR":
      return "QR de mesa";

    case "BRANCH_QR":
      return "QR de sucursal";

    case "OPS_STAFF":
      return "Personal de sucursal";

    case "RESERVATION_PREORDER":
      return "Prepedido de reserva";

    case "RESERVATION_CHECKIN":
      return "Check-in de reserva";
  }
}

function isOrderPaymentVerified(order: OperationalOrder): boolean {
  return (
    order.paymentStatus === "PAID" || order.paymentStatus === "NOT_REQUIRED"
  );
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

function isAdvanceOrderPaymentLocked(
  order: OperationalOrderWithFulfillment,
): boolean {
  const nextStatus = getNextStatus(order.status);

  return Boolean(
    (nextStatus === "CONFIRMED" || nextStatus === "PREPARING") &&
    !isOrderPaymentVerified(order),
  );
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
  operator,
}: OpsOrdersClientProps) {
  const [orders, setOrders] = useState<OperationalOrderWithFulfillment[]>([]);

  const [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState<OperationsCapabilities | null>(null);

  const [error, setError] = useState<string | null>(null);

  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [busyHandoffDeliveryId, setBusyHandoffDeliveryId] = useState<
    string | null
  >(null);
  const [cashOrder, setCashOrder] =
    useState<OperationalOrderWithFulfillment | null>(null);

  const [cashReceivedAmount, setCashReceivedAmount] = useState("");

  const [terminalReference, setTerminalReference] = useState("CAJA-01");

  const [cashIdempotencyKey, setCashIdempotencyKey] = useState("");

  const [cashBusy, setCashBusy] = useState(false);
  const cashActionLock = useRef(false);
  const [cashReview, setCashReview] = useState(false);
  const [cashSummaryRevision, setCashSummaryRevision] = useState(0);

  const [cashError, setCashError] = useState<string | null>(null);

  const [cashReceipt, setCashReceipt] = useState<CashPaymentReceipt | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<OpsTab>("ORDERS");

  const parsedCashReceived = Number(cashReceivedAmount.replace(",", "."));

  const calculatedCashChange =
    cashOrder &&
    Number.isFinite(parsedCashReceived) &&
    parsedCashReceived >= cashOrder.total
      ? Math.round((parsedCashReceived - cashOrder.total) * 100) / 100
      : null;

  const canOperateCash =
    capabilities?.permissions.includes("payments.cash") ?? false;

  // =======================================================
  // 5. CARGA DE PEDIDOS ACTIVOS
  // =======================================================

  const loadOrders = useCallback(async () => {
    setError(null);

    try {
      const access = await getOperationsCapabilities();
      if (access.tenantCode !== tenantCode || access.branchCode !== branchCode) throw new Error('La sucursal de la sesión cambió. Vuelve a ingresar.');
      setCapabilities(access);
      const result = await getOperationalOrders(tenantCode, branchCode);

      setOrders(result.orders);
    } catch (error) {
      setCapabilities(null);
      setOrders([]);
      setActiveTab("ORDERS");
      if (error instanceof Error) {
        setError(error.message);
      } else {
        setError("No se pudieron recuperar los pedidos");
      }
    } finally {
      setLoading(false);
    }
  }, [tenantCode, branchCode]);

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

  // 7. AVANZAR ESTADO DEL PEDIDO
  // =======================================================

  async function advanceOrder(order: OperationalOrderWithFulfillment) {
    const nextStatus = getNextStatus(order.status);

    if (!nextStatus) {
      return;
    }

    if (
      order.orderType === "DELIVERY" &&
      order.status === "READY" &&
      nextStatus === "COMPLETED"
    ) {
      setError(
        "El pedido Delivery se completa desde la app del repartidor después de validar la entrega.",
      );

      return;
    }

    if (
      (nextStatus === "CONFIRMED" || nextStatus === "PREPARING") &&
      !isOrderPaymentVerified(order)
    ) {
      setError("El pedido no puede avanzar hasta verificar el pago");

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

  async function handoffDeliveryToDriver(
    order: OperationalOrderWithFulfillment,
  ) {
    const delivery = order.delivery;

    if (!delivery) {
      setError("No se encontró el Delivery vinculado al pedido");
      return;
    }

    if (delivery.status !== "ACCEPTED") {
      setError(
        "El repartidor debe aceptar la entrega antes de recibir el pedido.",
      );
      return;
    }

    setBusyHandoffDeliveryId(delivery.id);
    setError(null);

    try {
      await handoffOperationalDelivery(delivery.id);
      await loadOrders();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "No se pudo entregar el pedido al repartidor",
      );
    } finally {
      setBusyHandoffDeliveryId(null);
    }
  }

  function openCashPayment(order: OperationalOrderWithFulfillment) {
    if (!canOperateCash || !canReceiveCashPayment(order) || !order.items.length || cashActionLock.current) return;
    setCashReview(false);
    setCashOrder(order);

    setCashReceivedAmount("");

    setCashIdempotencyKey(window.crypto.randomUUID());

    setCashError(null);
    setCashReceipt(null);
  }

  function closeCashPayment() {
    if (cashBusy || cashActionLock.current) {
      return;
    }

    setCashOrder(null);
    setCashReceivedAmount("");
    setCashIdempotencyKey("");
    setCashError(null);
  }

  async function submitCashPayment() {
    if (!cashOrder || cashActionLock.current) {
      return;
    }

    const currentOrder = orders.find(order => order.id === cashOrder.id);
    if (!canOperateCash || !currentOrder || !canReceiveCashPayment(currentOrder) || !currentOrder.items.length ||
        cashOrderFingerprint(currentOrder) !== cashOrderFingerprint(cashOrder)) {
      setCashReview(false);
      setCashError("El pedido o tus permisos cambiaron. Cierra este cobro y revisa el pedido actualizado.");
      return;
    }
    const normalizedAmount = cashReceivedAmount.trim().replace(",", ".");

    if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(normalizedAmount)) {
      setCashError("Ingresa un importe válido con máximo dos decimales");

      return;
    }

    if (Number(normalizedAmount) < cashOrder.total) {
      setCashError("El efectivo recibido no cubre el total del pedido");

      return;
    }

    if (terminalReference.trim().length < 2) {
      setCashError("Ingresa la referencia de la caja");

      return;
    }

    if (!cashIdempotencyKey) {
      setCashError("No existe una clave segura para esta operación");

      return;
    }

    if (!cashReview) { setCashReview(true); return; }
    cashActionLock.current = true;
    setCashBusy(true);
    setCashError(null);

    try {
      const result = await confirmOperationalCashPayment(
        cashOrder.id,
        {
          cashReceivedAmount: normalizedAmount,
          terminalReference: terminalReference.trim(),
        },
        cashIdempotencyKey,
      );

      const received =
        result.payment.cashReceivedAmount ?? Number(normalizedAmount);

      const change =
        result.payment.cashChangeAmount ??
        Math.round((received - result.order.total) * 100) / 100;

      setCashReceipt({
        orderNumber: result.order.orderNumber,

        currency: result.order.currency,

        total: result.order.total,

        received,

        change,

        transactionId: result.payment.providerTransactionId,
      });

      setCashOrder(null);
      setCashReceivedAmount("");
      setCashIdempotencyKey("");

      setCashSummaryRevision(value => value + 1);
      await loadOrders();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "No se pudo registrar el pago";

      setCashError(message);
    } finally {
      cashActionLock.current = false;
      setCashBusy(false);
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
                  : activeTab === "CASH" ? "Caja" : "Reservas"}
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
        <nav className="mx-auto flex flex-wrap max-w-[1600px] gap-2 px-6 py-3">
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

          {capabilities?.permissions.includes("payments.read") && (
            <button type="button" onClick={() => setActiveTab("CASH")} aria-pressed={activeTab === "CASH"} className="rounded-xl border px-4 py-3 font-bold">Caja</button>
          )}
          {capabilities?.permissions.includes("tables.read") && (
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
          )}

          {capabilities?.permissions.includes("reservations.read") && (
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
          )}
        </nav>
      </div>

      {error && (
        <div className="mx-auto max-w-[1600px] px-6 pt-5">
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">
            {error}
          </div>
        </div>
      )}

      {cashReceipt && (
        <div className="mx-auto max-w-[1600px] px-6 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-green-900">
            <div>
              <p className="font-bold">
                Pago en efectivo registrado · Pedido #{cashReceipt.orderNumber}
              </p>

              <p className="mt-1 text-sm">
                Total {cashReceipt.currency} {cashReceipt.total.toFixed(2)} ·
                Recibido {cashReceipt.currency}{" "}
                {cashReceipt.received.toFixed(2)} · Cambio{" "}
                {cashReceipt.currency} {cashReceipt.change.toFixed(2)}
              </p>

              {cashReceipt.transactionId && (
                <p className="mt-1 text-xs text-green-700">
                  Transacción: {cashReceipt.transactionId}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => setCashReceipt(null)}
              className="rounded-lg border border-green-300 bg-white px-3 py-2 text-sm font-bold"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-[1600px] px-6 py-6">
        {activeTab === "CASH" && capabilities?.permissions.includes("payments.read") ? (
          <>
            {capabilities.permissions.includes('orders.create') && <OpsPosCheckout onComplete={async()=>{setCashSummaryRevision(value=>value+1);await loadOrders();}} />}
            <OpsCashWorkbench orders={orders} canCollect={canOperateCash} busy={cashBusy || busyOrderId !== null} onCollect={openCashPayment} />
            <OpsCashPanel key={cashSummaryRevision} canReconcile={capabilities.permissions.includes("payments.reconcile")} />
          </>
        ) : activeTab === "TABLES" && capabilities?.permissions.includes("tables.read") ? (
          <OpsTablesPanel
            tenantCode={tenantCode}
            branchCode={branchCode}
            orders={orders}
            onOrdersChanged={loadOrders}
          />
        ) : activeTab === "RESERVATIONS" && capabilities?.permissions.includes("reservations.read") ? (
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

                      const paymentLocked = isAdvanceOrderPaymentLocked(order);

                      const paymentVerified = isOrderPaymentVerified(order);

                      const isReadyDelivery =
                        order.orderType === "DELIVERY" &&
                        order.status === "READY";

                      const operationalDelivery = order.delivery;

                      const memberOrders =
                        operationalDelivery?.isShared
                          ? orders
                              .filter(
                                (candidate) =>
                                  candidate.delivery?.id ===
                                  operationalDelivery.id,
                              )
                              .map(
                                (candidate) =>
                                  candidate.orderNumber,
                              )
                          : [];

                      const operationalDriver =
                        operationalDelivery?.assignment?.driver ?? null;

                      const handoffBusy =
                        operationalDelivery !== null &&
                        busyHandoffDeliveryId === operationalDelivery?.id;

                      return (
                        <article
                          key={order.id}
                          className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm"
                        >
                          {operationalDelivery?.isShared ? (
                            <div
                              className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900"
                              data-ops-shared-delivery="true"
                            >
                              <p className="font-bold">
                                Entrega conjunta Â·{" "}
                                {operationalDelivery.memberCount} pedidos
                              </p>

                              <p className="mt-1">
                                Pedidos:{" "}
                                {memberOrders
                                  .map((number) => `#${number}`)
                                  .join(", ")}
                              </p>

                              <p className="mt-1 text-xs">
                                Rol de este pedido:{" "}
                                {operationalDelivery.relationshipRole ===
                                "PRIMARY"
                                  ? "Principal"
                                  : "Adicional"}
                              </p>
                            </div>
                          ) : null}

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

                          <div
                            className={`mt-4 rounded-xl border p-3 ${
                              paymentVerified
                                ? "border-green-200 bg-green-50"
                                : order.paymentStatus === "FAILED" ||
                                    order.paymentStatus === "CANCELLED" ||
                                    order.paymentStatus === "REVIEW_REQUIRED"
                                  ? "border-red-200 bg-red-50"
                                  : "border-amber-200 bg-amber-50"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">
                                  Pago
                                </p>

                                <p
                                  className={`mt-1 font-bold ${
                                    paymentVerified
                                      ? "text-green-800"
                                      : order.paymentStatus === "FAILED" ||
                                          order.paymentStatus === "CANCELLED" ||
                                          order.paymentStatus ===
                                            "REVIEW_REQUIRED"
                                        ? "text-red-800"
                                        : "text-amber-800"
                                  }`}
                                >
                                  {getPaymentStatusLabel(order.paymentStatus)}
                                </p>
                              </div>

                              <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-zinc-700">
                                {getOrderOriginLabel(order.orderOrigin)}
                              </span>
                            </div>

                            {paymentLocked && (
                              <p className="mt-2 text-xs font-medium text-amber-800">
                                Preparación bloqueada hasta recibir la
                                confirmación automática de fondos.
                              </p>
                            )}
                          </div>

                          {canOperateCash && canReceiveCashPayment(order) && (
                            <button
                              type="button"
                              disabled={busyOrderId !== null || cashBusy}
                              onClick={() => openCashPayment(order)}
                              className="mt-3 w-full rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-900 transition hover:bg-emerald-100 disabled:opacity-50"
                            >
                              {order.paymentStatus === "AWAITING_CONFIRMATION"
                                ? "Cobrar en efectivo · cancelará el QR"
                                : "Cobrar en efectivo"}
                            </button>
                          )}

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

                          {isReadyDelivery ? (
                            <div className="mt-5 space-y-3">
                              {operationalDriver && (
                                <p className="text-xs font-semibold text-zinc-600">
                                  Repartidor: {operationalDriver.name ?? operationalDriver.code}
                                  {operationalDriver.name && operationalDriver.code
                                    ? ` · ${operationalDriver.code}`
                                    : ""}
                                </p>
                              )}

                              {operationalDelivery?.status === "ACCEPTED" ? (
                                <button
                                  type="button"
                                  disabled={handoffBusy}
                                  onClick={() =>
                                    void handoffDeliveryToDriver(order)
                                  }
                                  className="w-full rounded-xl bg-zinc-950 px-4 py-3 text-sm font-bold text-white disabled:bg-zinc-400"
                                >
                                  {handoffBusy
                                    ? "Entregando al repartidor..."
                                    : "Entregar al repartidor"}
                                </button>
                              ) : operationalDelivery?.status === "ASSIGNED" ? (
                                <button
                                  type="button"
                                  disabled
                                  className="w-full rounded-xl bg-zinc-400 px-4 py-3 text-sm font-bold text-white"
                                >
                                  Esperando aceptación del repartidor
                                </button>
                              ) : operationalDelivery?.status ===
                                  "WAITING_ASSIGNMENT" ||
                                operationalDelivery?.status === "CREATED" ? (
                                <button
                                  type="button"
                                  disabled
                                  className="w-full rounded-xl bg-zinc-400 px-4 py-3 text-sm font-bold text-white"
                                >
                                  Buscando repartidor
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled
                                  className="w-full rounded-xl bg-zinc-400 px-4 py-3 text-sm font-bold text-white"
                                >
                                  Actualizando despacho...
                                </button>
                              )}
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={
                                !capabilities?.orderStatuses.includes(getNextStatus(order.status) ?? "") ||
                                busyOrderId === order.id ||
                                paymentLocked ||
                                preparationLocked
                              }
                              onClick={() => void advanceOrder(order)}
                              className="mt-5 w-full rounded-xl bg-zinc-950 px-4 py-3 text-sm font-bold text-white disabled:bg-zinc-400"
                            >
                              {!capabilities?.orderStatuses.includes(getNextStatus(order.status) ?? "") ? "Acción no disponible para tu rol" : busyOrderId === order.id
                                ? "Actualizando..."
                                : paymentLocked
                                  ? "Esperando confirmación del pago"
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
                          )}
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
      {cashOrder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeCashPayment();
            }
          }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="cash-payment-title"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCashPayment();
            }}
            className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">
                  Caja presencial
                </p>

                <h2
                  id="cash-payment-title"
                  className="mt-1 text-2xl font-black"
                >
                  Cobrar pedido #{cashOrder.orderNumber}
                </h2>
              </div>

              <button
                type="button"
                disabled={cashBusy}
                onClick={closeCashPayment}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-bold disabled:opacity-50"
                aria-label="Cerrar cobro"
              >
                Cerrar
              </button>
            </div>

            <OpsCashProducts order={cashOrder} />
            <div className="mt-5 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-zinc-600">Total del pedido</span>

                <strong className="text-xl">
                  {cashOrder.currency} {cashOrder.total.toFixed(2)}
                </strong>
              </div>

              {cashOrder.paymentStatus === "AWAITING_CONFIRMATION" && (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                  Este pedido tiene un QR pendiente. Al confirmar el efectivo,
                  ese QR quedará cancelado.
                </p>
              )}
            </div>

            <label className="mt-5 block">
              <span className="text-sm font-bold">Efectivo recibido</span>

              <input
                autoFocus
                disabled={cashBusy || cashReview}
                type="text"
                inputMode="decimal"
                value={cashReceivedAmount}
                onChange={(event) => {
                  setCashReview(false);
                  setCashReceivedAmount(event.target.value);
                  setCashError(null);
                }}
                placeholder={cashOrder.total.toFixed(2)}
                className="mt-2 w-full rounded-xl border border-zinc-300 px-4 py-3 text-xl font-bold outline-none focus:border-zinc-950"
              />
            </label>

            <div
              className={`mt-3 rounded-xl border px-4 py-3 ${
                calculatedCashChange === null
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-green-200 bg-green-50 text-green-900"
              }`}
            >
              {calculatedCashChange === null ? (
                <p className="text-sm font-bold">
                  El importe debe cubrir el total del pedido.
                </p>
              ) : (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-bold">Cambio a entregar</span>

                  <strong className="text-xl">
                    {cashOrder.currency} {calculatedCashChange.toFixed(2)}
                  </strong>
                </div>
              )}
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
                <span className="text-xs font-bold uppercase tracking-wide text-zinc-500">
                  Operador de caja
                </span>
                <p className="mt-1 font-black">{operator.displayName}</p>
                <p className="mt-1 font-mono text-xs text-zinc-500">
                  {operator.userCode} · {operator.role}
                </p>
              </div>

              <label className="block">
                <span className="text-sm font-bold">Caja o terminal</span>

                <input
                  type="text"
                  value={terminalReference}
                    disabled={cashBusy || cashReview}
                  onChange={(event) => {
                    setTerminalReference(event.target.value);
                    setCashError(null);
                  }}
                  maxLength={80}
                  placeholder="CAJA-01"
                  className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                />
              </label>
            </div>

            {cashReview && <div role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-bold">Revisa antes de confirmar</p>
              <p>Recibido: {cashOrder.currency} {parsedCashReceived.toFixed(2)} · Cambio: {cashOrder.currency} {calculatedCashChange?.toFixed(2)}</p>
              <p>Confirma únicamente después de recibir el dinero. Se cobra el pedido completo.</p>
              <button type="button" disabled={cashBusy} onClick={() => setCashReview(false)} className="mt-3 rounded-lg border px-3 py-2 font-bold">Corregir importe</button>
            </div>}
            {cashError && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
                {cashError}
              </div>
            )}

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                disabled={cashBusy}
                onClick={closeCashPayment}
                className="rounded-xl border border-zinc-300 px-4 py-3 font-bold disabled:opacity-50"
              >
                Cancelar
              </button>

              <button
                type="submit"
                disabled={
                  cashBusy ||
                  calculatedCashChange === null ||
                  terminalReference.trim().length < 2
                }
                className="rounded-xl bg-zinc-950 px-4 py-3 font-bold text-white disabled:bg-zinc-400"
              >
                {cashBusy ? "Registrando..." : cashReview ? "Confirmar efectivo" : "Revisar cobro"}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
