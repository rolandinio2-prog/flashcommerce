"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  checkInOperationalReservation,
  getOperationalReservations,
  updateOperationalReservationStatus,
  type TableReservation,
  type TableReservationStatus,
} from "../../../lib/flash-api";

interface OpsReservationsPanelProps {
  tenantCode: string;
  branchCode: string;
}

type ReservationFilter = "ACTIVE" | "ALL" | TableReservationStatus;

type ReservationAction = "CONFIRM" | "CHECK_IN" | "CANCEL" | "NO_SHOW";

interface PendingReservationAction {
  reservation: TableReservation;
  action: ReservationAction;
}

const FILTERS: Array<{
  value: ReservationFilter;
  label: string;
}> = [
  { value: "ACTIVE", label: "Activas" },
  { value: "PENDING", label: "Pendientes" },
  { value: "CONFIRMED", label: "Confirmadas" },
  { value: "SEATED", label: "En mesa" },
  { value: "COMPLETED", label: "Completadas" },
  { value: "ALL", label: "Todas" },
];

function getStatusLabel(status: TableReservationStatus): string {
  switch (status) {
    case "PENDING":
      return "Pendiente";
    case "CONFIRMED":
      return "Confirmada";
    case "SEATED":
      return "En mesa";
    case "COMPLETED":
      return "Completada";
    case "CANCELLED":
      return "Cancelada";
    case "NO_SHOW":
      return "No se presentó";
  }
}

function getStatusClass(status: TableReservationStatus): string {
  switch (status) {
    case "PENDING":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "CONFIRMED":
      return "border-sky-200 bg-sky-50 text-sky-800";
    case "SEATED":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "COMPLETED":
      return "border-zinc-200 bg-zinc-100 text-zinc-700";
    case "CANCELLED":
    case "NO_SHOW":
      return "border-red-200 bg-red-50 text-red-700";
  }
}

function getPreorderStatusLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Recibido";
    case "CONFIRMED":
      return "Confirmado";
    case "PREPARING":
      return "En preparación";
    case "READY":
      return "Listo";
    case "COMPLETED":
      return "Entregado";
    case "CANCELLED":
      return "Cancelado";
    default:
      return status;
  }
}

function formatDateTime(value: string, timeZone: string): string {
  return new Date(value).toLocaleString("es-BO", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
}

function getActionContent(action: ReservationAction): {
  title: string;
  description: string;
  button: string;
  destructive: boolean;
} {
  switch (action) {
    case "CONFIRM":
      return {
        title: "Confirmar reserva",
        description:
          "La reserva quedará confirmada y el cliente podrá consultar el nuevo estado.",
        button: "Sí, confirmar",
        destructive: false,
      };
    case "CHECK_IN":
      return {
        title: "Registrar llegada",
        description:
          "Se abrirá una sesión física y la mesa cambiará a ocupada.",
        button: "Sí, realizar check-in",
        destructive: false,
      };
    case "CANCEL":
      return {
        title: "Cancelar reserva",
        description:
          "El horario quedará disponible nuevamente para otros clientes.",
        button: "Sí, cancelar",
        destructive: true,
      };
    case "NO_SHOW":
      return {
        title: "Marcar ausencia",
        description:
          "La reserva se cerrará indicando que el cliente no se presentó.",
        button: "Marcar no presentado",
        destructive: true,
      };
  }
}

export default function OpsReservationsPanel({
  tenantCode,
  branchCode,
}: OpsReservationsPanelProps) {
  const [reservations, setReservations] = useState<TableReservation[]>([]);
  const [timeZone, setTimeZone] = useState("America/La_Paz");
  const [filter, setFilter] = useState<ReservationFilter>("ACTIVE");
  const [loading, setLoading] = useState(true);
  const [busyReservationId, setBusyReservationId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] =
    useState<PendingReservationAction | null>(null);

  const loadReservations = useCallback(async () => {
    setError(null);

    try {
      const result = await getOperationalReservations(tenantCode, branchCode);
      setReservations(result.reservations);
      setTimeZone(result.timeZone);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "No se pudieron recuperar las reservas",
      );
    } finally {
      setLoading(false);
    }
  }, [tenantCode, branchCode]);

  useEffect(() => {
    let stopped = false;
    let timerId: number | undefined;

    async function refresh() {
      await loadReservations();

      if (!stopped) {
        timerId = window.setTimeout(refresh, 10000);
      }
    }

    void refresh();

    return () => {
      stopped = true;
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [loadReservations]);

  const visibleReservations = useMemo(() => {
    if (filter === "ALL") {
      return reservations;
    }

    if (filter === "ACTIVE") {
      return reservations.filter((reservation) =>
        ["PENDING", "CONFIRMED", "SEATED"].includes(reservation.status),
      );
    }

    return reservations.filter((reservation) => reservation.status === filter);
  }, [filter, reservations]);

  const summary = useMemo(
    () => ({
      total: reservations.length,
      pending: reservations.filter(
        (reservation) => reservation.status === "PENDING",
      ).length,
      confirmed: reservations.filter(
        (reservation) => reservation.status === "CONFIRMED",
      ).length,
      seated: reservations.filter(
        (reservation) => reservation.status === "SEATED",
      ).length,
    }),
    [reservations],
  );

  async function executePendingAction() {
    if (!pendingAction) {
      return;
    }

    const { reservation, action } = pendingAction;
    setBusyReservationId(reservation.id);
    setError(null);

    try {
      if (action === "CHECK_IN") {
        await checkInOperationalReservation(
          reservation.id,
          tenantCode,
          branchCode,
        );
      } else {
        const targetStatus =
          action === "CONFIRM"
            ? "CONFIRMED"
            : action === "CANCEL"
              ? "CANCELLED"
              : "NO_SHOW";

        await updateOperationalReservationStatus(
          reservation.id,
          targetStatus,
          tenantCode,
          branchCode,
        );
      }

      setPendingAction(null);
      await loadReservations();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "No se pudo actualizar la reserva",
      );
      setPendingAction(null);
    } finally {
      setBusyReservationId(null);
    }
  }

  return (
    <section>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-zinc-500">
            Reservas del período
          </p>
          <p className="mt-2 text-3xl font-black">{summary.total}</p>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <p className="text-sm font-semibold text-amber-800">Pendientes</p>
          <p className="mt-2 text-3xl font-black text-amber-950">
            {summary.pending}
          </p>
        </div>
        <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
          <p className="text-sm font-semibold text-sky-800">Confirmadas</p>
          <p className="mt-2 text-3xl font-black text-sky-950">
            {summary.confirmed}
          </p>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
          <p className="text-sm font-semibold text-emerald-800">En mesa</p>
          <p className="mt-2 text-3xl font-black text-emerald-950">
            {summary.seated}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-200 bg-white p-4">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              className={`rounded-xl px-4 py-2 text-sm font-bold ${
                filter === item.value
                  ? "bg-zinc-950 text-white"
                  : "bg-zinc-100 text-zinc-600"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={loading || busyReservationId !== null}
          onClick={() => void loadReservations()}
          className="rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          Actualizar
        </button>
      </div>

      {error && (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 font-semibold text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="mt-5 rounded-2xl border border-zinc-200 bg-white p-8 text-center">
          Cargando reservas...
        </div>
      ) : visibleReservations.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-dashed border-zinc-300 bg-white p-10 text-center">
          <p className="text-lg font-black">No hay reservas en esta vista</p>
          <p className="mt-2 text-sm text-zinc-500">
            Las nuevas solicitudes aparecerán automáticamente.
          </p>
        </div>
      ) : (
        <div className="mt-5 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {visibleReservations.map((reservation) => (
            <article
              key={reservation.id}
              className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                    {reservation.reservationCode}
                  </p>
                  <h3 className="mt-1 text-2xl font-black">
                    {reservation.table.code} · {reservation.table.name}
                  </h3>
                  <p className="mt-1 text-sm text-zinc-500">
                    {reservation.table.zone || "Sin zona"} · Capacidad{" "}
                    {reservation.table.capacity}
                  </p>
                </div>

                <span
                  className={`rounded-full border px-3 py-1 text-xs font-bold ${getStatusClass(
                    reservation.status,
                  )}`}
                >
                  {getStatusLabel(reservation.status)}
                </span>
              </div>

              <div className="mt-5 rounded-2xl bg-zinc-50 p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Fecha y hora
                </p>
                <p className="mt-1 text-lg font-black capitalize">
                  {formatDateTime(reservation.reservedFor, timeZone)}
                </p>
                <p className="mt-1 text-sm text-zinc-500">
                  {reservation.durationMinutes} min · {reservation.partySize}{" "}
                  personas
                </p>
              </div>

              <div className="mt-4 space-y-1">
                <p className="font-black">{reservation.customerName}</p>
                <p className="text-sm text-zinc-600">
                  Tel. {reservation.customerPhone}
                </p>
                {reservation.customerNotes && (
                  <p className="mt-2 rounded-xl border border-zinc-200 p-3 text-sm">
                    {reservation.customerNotes}
                  </p>
                )}
              </div>

              {reservation.preorder && (
                <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950">
                  <div className="flex items-center justify-between gap-3">
                    <strong>
                      Pedido anticipado #{reservation.preorder.orderNumber}
                    </strong>
                    <span className="rounded-full bg-white px-2 py-1 text-xs font-bold text-sky-800">
                      {getPreorderStatusLabel(reservation.preorder.status)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-sky-800">
                    {reservation.preorder.currency}{" "}
                    {reservation.preorder.total.toFixed(2)} · Programado para la
                    reserva
                  </p>
                </div>
              )}

              {reservation.tableSession && (
                <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                  <strong>Sesión {reservation.tableSession.status}</strong>
                  <p className="mt-1 break-all text-xs">
                    {reservation.tableSession.id}
                  </p>
                </div>
              )}

              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                {reservation.status === "PENDING" && (
                  <button
                    type="button"
                    disabled={busyReservationId === reservation.id}
                    onClick={() =>
                      setPendingAction({ reservation, action: "CONFIRM" })
                    }
                    className="rounded-xl bg-sky-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-50"
                  >
                    Confirmar
                  </button>
                )}

                {reservation.status === "CONFIRMED" && (
                  <>
                    <button
                      type="button"
                      disabled={busyReservationId === reservation.id}
                      onClick={() =>
                        setPendingAction({ reservation, action: "CHECK_IN" })
                      }
                      className="rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-50"
                    >
                      Realizar check-in
                    </button>
                    <button
                      type="button"
                      disabled={busyReservationId === reservation.id}
                      onClick={() =>
                        setPendingAction({ reservation, action: "NO_SHOW" })
                      }
                      className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-bold disabled:opacity-50"
                    >
                      No se presentó
                    </button>
                  </>
                )}

                {(reservation.status === "PENDING" ||
                  reservation.status === "CONFIRMED") && (
                  <button
                    type="button"
                    disabled={busyReservationId === reservation.id}
                    onClick={() =>
                      setPendingAction({ reservation, action: "CANCEL" })
                    }
                    className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700 disabled:opacity-50"
                  >
                    Cancelar reserva
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {pendingAction && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl bg-white shadow-2xl">
            <div className="border-b border-zinc-200 px-6 py-5">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">
                Gestión de reservas
              </p>
              <h3 className="mt-1 text-2xl font-black">
                {getActionContent(pendingAction.action).title}
              </h3>
              <p className="mt-2 text-sm text-zinc-600">
                {getActionContent(pendingAction.action).description}
              </p>
            </div>

            <div className="p-6">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xl font-black">
                      {pendingAction.reservation.table.code} ·{" "}
                      {pendingAction.reservation.table.name}
                    </p>
                    <p className="mt-1 text-sm text-emerald-900">
                      {pendingAction.reservation.customerName} ·{" "}
                      {pendingAction.reservation.partySize} personas
                    </p>
                  </div>
                  <span className="rounded-full bg-emerald-200 px-3 py-1 text-xs font-bold text-emerald-900">
                    {pendingAction.reservation.reservationCode}
                  </span>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={busyReservationId !== null}
                  onClick={() => setPendingAction(null)}
                  className="rounded-xl border border-zinc-300 px-4 py-3 font-bold disabled:opacity-50"
                >
                  Volver
                </button>
                <button
                  type="button"
                  disabled={busyReservationId !== null}
                  onClick={() => void executePendingAction()}
                  className={`rounded-xl px-4 py-3 font-bold text-white disabled:opacity-50 ${
                    getActionContent(pendingAction.action).destructive
                      ? "bg-red-700"
                      : "bg-zinc-950"
                  }`}
                >
                  {busyReservationId
                    ? "Procesando..."
                    : getActionContent(pendingAction.action).button}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
