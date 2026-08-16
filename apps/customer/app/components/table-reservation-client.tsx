"use client";

import { useEffect, useMemo, useState } from "react";

import {
  createTableReservation,
  getReservationAvailability,
  getTableReservationTracking,
  type ReservationAvailabilityResponse,
  type TableReservation,
} from "../../lib/flash-api";

interface TableReservationClientProps {
  tenantCode: string;
  branchCode: string;
  timeZone: string;
  onStartPreorder?: (reservation: TableReservation) => void;
}

type ReservationView = "FORM" | "SUCCESS";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function getInitialSchedule(): {
  date: string;
  time: string;
} {
  const value = new Date(Date.now() + 90 * 60 * 1000);

  value.setMinutes(Math.ceil(value.getMinutes() / 15) * 15, 0, 0);

  return {
    date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
  };
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Pendiente de confirmación";
    case "CONFIRMED":
      return "Confirmada";
    case "SEATED":
      return "Clientes en la mesa";
    case "COMPLETED":
      return "Completada";
    case "CANCELLED":
      return "Cancelada";
    case "NO_SHOW":
      return "No se presentó";
    default:
      return status;
  }
}

function getStatusClass(status: string): string {
  if (status === "CONFIRMED" || status === "SEATED") {
    return "bg-emerald-100 text-emerald-800";
  }

  if (status === "CANCELLED" || status === "NO_SHOW") {
    return "bg-red-100 text-red-700";
  }

  if (status === "COMPLETED") {
    return "bg-zinc-200 text-zinc-700";
  }

  return "bg-amber-100 text-amber-800";
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

function isFinalReservationStatus(status: string): boolean {
  return ["COMPLETED", "CANCELLED", "NO_SHOW"].includes(status);
}

function formatReservationDate(value: string, timeZone: string): string {
  return new Date(value).toLocaleString("es-BO", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
}

export default function TableReservationClient({
  tenantCode,
  branchCode,
  timeZone,
  onStartPreorder,
}: TableReservationClientProps) {
  const storageKey = `flashcommerce.tableReservation:${tenantCode}:${branchCode}`;

  const [modalOpen, setModalOpen] = useState(false);
  const [view, setView] = useState<ReservationView>("FORM");
  const [reservationDate, setReservationDate] = useState("");
  const [reservationTime, setReservationTime] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(90);
  const [partySize, setPartySize] = useState(2);
  const [availability, setAvailability] =
    useState<ReservationAvailabilityResponse | null>(null);
  const [selectedTableId, setSelectedTableId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [activeReservation, setActiveReservation] =
    useState<TableReservation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initialSchedule = getInitialSchedule();
    setReservationDate(initialSchedule.date);
    setReservationTime(initialSchedule.time);

    const trackingToken = window.localStorage.getItem(storageKey);

    if (!trackingToken) {
      return;
    }

    void getTableReservationTracking(trackingToken)
      .then((result) => {
        setActiveReservation(result.reservation);
      })
      .catch(() => {
        window.localStorage.removeItem(storageKey);
      });
  }, [storageKey]);

  useEffect(() => {
    const trackingToken = activeReservation?.trackingToken;

    if (!trackingToken || isFinalReservationStatus(activeReservation.status)) {
      return;
    }

    let disposed = false;

    const intervalId = window.setInterval(() => {
      void getTableReservationTracking(trackingToken)
        .then((result) => {
          if (!disposed) {
            setActiveReservation(result.reservation);
          }
        })
        .catch(() => {
          // A transient network error must not interrupt automatic tracking.
          // The manual refresh button remains available to surface errors.
        });
    }, 5_000);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [activeReservation?.status, activeReservation?.trackingToken]);

  const selectedTable = useMemo(
    () =>
      availability?.tables.find((table) => table.id === selectedTableId) ??
      null,
    [availability, selectedTableId],
  );

  function resetAvailability() {
    setAvailability(null);
    setSelectedTableId("");
    setError(null);
  }

  function getReservedFor(): string {
    const value = new Date(`${reservationDate}T${reservationTime}:00`);

    if (Number.isNaN(value.getTime())) {
      throw new Error("Selecciona una fecha y hora válidas");
    }

    return value.toISOString();
  }

  async function loadAvailability() {
    setBusy(true);
    setError(null);
    setSelectedTableId("");

    try {
      const result = await getReservationAvailability(
        tenantCode,
        branchCode,
        getReservedFor(),
        durationMinutes,
        partySize,
      );

      setAvailability(result);
    } catch (caught) {
      setAvailability(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "No se pudo consultar la disponibilidad",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitReservation() {
    if (!selectedTable) {
      setError("Selecciona una mesa disponible");
      return;
    }

    if (customerName.trim().length < 2) {
      setError("Ingresa el nombre de la persona responsable");
      return;
    }

    if (customerPhone.trim().length < 6) {
      setError("Ingresa un teléfono válido");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const result = await createTableReservation({
        tenantCode,
        branchCode,
        tableId: selectedTable.id,
        reservedFor: getReservedFor(),
        durationMinutes,
        partySize,
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        customerNotes: customerNotes.trim() || undefined,
      });

      window.localStorage.setItem(storageKey, result.reservation.trackingToken);
      setActiveReservation(result.reservation);
      setView("SUCCESS");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "No se pudo crear la reserva",
      );
    } finally {
      setBusy(false);
    }
  }

  async function refreshReservation() {
    if (!activeReservation) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const result = await getTableReservationTracking(
        activeReservation.trackingToken,
      );
      setActiveReservation(result.reservation);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "No se pudo actualizar la reserva",
      );
    } finally {
      setBusy(false);
    }
  }

  function openNewReservation() {
    setView("FORM");
    setModalOpen(true);
    setError(null);
  }

  function openActiveReservation() {
    setView("SUCCESS");
    setModalOpen(true);
    setError(null);
  }

  function startAnotherReservation() {
    window.localStorage.removeItem(storageKey);
    setActiveReservation(null);
    setView("FORM");
    setAvailability(null);
    setSelectedTableId("");
    setCustomerName("");
    setCustomerPhone("");
    setCustomerNotes("");
    setError(null);
  }

  return (
    <>
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={openNewReservation}
          className="rounded-xl bg-zinc-950 px-5 py-3 text-sm font-bold text-white"
        >
          Reservar una mesa
        </button>

        {activeReservation && (
          <button
            type="button"
            onClick={openActiveReservation}
            className="rounded-xl border border-emerald-300 bg-emerald-50 px-5 py-3 text-sm font-bold text-emerald-900"
          >
            Ver reserva {activeReservation.reservationCode}
          </button>
        )}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white shadow-2xl">
            <header className="sticky top-0 z-10 flex items-start justify-between border-b border-zinc-200 bg-white px-6 py-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">
                  Reserva de mesa
                </p>
                <h2 className="mt-1 text-2xl font-black">
                  {view === "FORM"
                    ? "Planifica tu visita"
                    : "Detalle de la reserva"}
                </h2>
                <p className="mt-1 text-sm text-zinc-500">{timeZone}</p>
              </div>

              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 text-xl"
                aria-label="Cerrar"
              >
                ×
              </button>
            </header>

            {view === "FORM" ? (
              <div className="space-y-6 p-6">
                <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5">
                  <h3 className="font-black">Fecha, hora y grupo</h3>

                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <label className="text-sm font-semibold">
                      Fecha
                      <input
                        type="date"
                        value={reservationDate}
                        onChange={(event) => {
                          setReservationDate(event.target.value);
                          resetAvailability();
                        }}
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3"
                      />
                    </label>

                    <label className="text-sm font-semibold">
                      Hora
                      <input
                        type="time"
                        step="900"
                        value={reservationTime}
                        onChange={(event) => {
                          setReservationTime(event.target.value);
                          resetAvailability();
                        }}
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3"
                      />
                    </label>

                    <label className="text-sm font-semibold">
                      Personas
                      <input
                        type="number"
                        min="1"
                        max="50"
                        value={partySize}
                        onChange={(event) => {
                          setPartySize(Number(event.target.value));
                          resetAvailability();
                        }}
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3"
                      />
                    </label>

                    <label className="text-sm font-semibold">
                      Duración estimada
                      <select
                        value={durationMinutes}
                        onChange={(event) => {
                          setDurationMinutes(Number(event.target.value));
                          resetAvailability();
                        }}
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3"
                      >
                        <option value={60}>1 hora</option>
                        <option value={90}>1 hora 30 min</option>
                        <option value={120}>2 horas</option>
                        <option value={150}>2 horas 30 min</option>
                        <option value={180}>3 horas</option>
                      </select>
                    </label>
                  </div>

                  <button
                    type="button"
                    disabled={busy || !reservationDate || !reservationTime}
                    onClick={() => void loadAvailability()}
                    className="mt-5 w-full rounded-xl bg-zinc-950 px-5 py-3 font-bold text-white disabled:bg-zinc-300"
                  >
                    {busy ? "Consultando..." : "Buscar mesas disponibles"}
                  </button>
                </section>

                {availability && (
                  <section>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h3 className="font-black">Selecciona una mesa</h3>
                        <p className="mt-1 text-sm text-zinc-500">
                          {availability.available} de {availability.total}{" "}
                          disponibles para este horario
                        </p>
                      </div>
                      <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-bold text-emerald-800">
                        {partySize} personas
                      </span>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      {availability.tables.map((table) => {
                        const selected = table.id === selectedTableId;

                        return (
                          <button
                            key={table.id}
                            type="button"
                            disabled={!table.available}
                            onClick={() => {
                              setSelectedTableId(table.id);
                              setError(null);
                            }}
                            className={`rounded-2xl border p-4 text-left transition ${
                              selected
                                ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-100"
                                : table.available
                                  ? "border-zinc-200 bg-white hover:border-zinc-950"
                                  : "cursor-not-allowed border-zinc-200 bg-zinc-100 opacity-55"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-lg font-black">
                                  {table.code} · {table.name}
                                </p>
                                <p className="mt-1 text-sm text-zinc-500">
                                  {table.zone || "Sin zona"} · Capacidad{" "}
                                  {table.capacity}
                                </p>
                              </div>
                              <span
                                className={`rounded-full px-2 py-1 text-[10px] font-bold ${
                                  table.available
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-zinc-200 text-zinc-600"
                                }`}
                              >
                                {table.available
                                  ? "DISPONIBLE"
                                  : table.slotAvailability === "CAPACITY"
                                    ? "CAPACIDAD"
                                    : "RESERVADA"}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}

                {selectedTable && (
                  <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
                    <h3 className="font-black text-emerald-950">
                      Datos de contacto
                    </h3>
                    <p className="mt-1 text-sm text-emerald-800">
                      {selectedTable.code} · {selectedTable.name}
                    </p>

                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <label className="text-sm font-semibold">
                        Nombre
                        <input
                          type="text"
                          value={customerName}
                          onChange={(event) =>
                            setCustomerName(event.target.value)
                          }
                          placeholder="Nombre del responsable"
                          className="mt-2 w-full rounded-xl border border-emerald-200 bg-white px-4 py-3"
                        />
                      </label>

                      <label className="text-sm font-semibold">
                        Teléfono
                        <input
                          type="tel"
                          value={customerPhone}
                          onChange={(event) =>
                            setCustomerPhone(event.target.value)
                          }
                          placeholder="Ej.: 70000000"
                          className="mt-2 w-full rounded-xl border border-emerald-200 bg-white px-4 py-3"
                        />
                      </label>
                    </div>

                    <label className="mt-4 block text-sm font-semibold">
                      Nota opcional
                      <textarea
                        value={customerNotes}
                        onChange={(event) =>
                          setCustomerNotes(event.target.value)
                        }
                        placeholder="Cumpleaños, silla para bebé, indicaciones..."
                        className="mt-2 min-h-24 w-full rounded-xl border border-emerald-200 bg-white px-4 py-3"
                      />
                    </label>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void submitReservation()}
                      className="mt-5 w-full rounded-xl bg-emerald-700 px-5 py-4 font-black text-white disabled:bg-zinc-300"
                    >
                      {busy
                        ? "Reservando..."
                        : "Confirmar solicitud de reserva"}
                    </button>
                  </section>
                )}

                {error && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
                    {error}
                  </div>
                )}
              </div>
            ) : activeReservation ? (
              <div className="p-6">
                <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-200 text-2xl font-black text-emerald-900">
                    ✓
                  </div>
                  <p className="mt-4 text-xs font-bold uppercase tracking-[0.2em] text-emerald-700">
                    Código de reserva
                  </p>
                  <h3 className="mt-1 text-3xl font-black text-emerald-950">
                    {activeReservation.reservationCode}
                  </h3>
                  <span
                    className={`mt-4 inline-flex rounded-full px-3 py-1 text-sm font-bold ${getStatusClass(activeReservation.status)}`}
                  >
                    {getStatusLabel(activeReservation.status)}
                  </span>
                </div>

                <div className="mt-5 space-y-3 rounded-2xl bg-zinc-50 p-5">
                  <div className="flex justify-between gap-4">
                    <span className="text-zinc-500">Mesa</span>
                    <strong className="text-right">
                      {activeReservation.table.code} ·{" "}
                      {activeReservation.table.name}
                    </strong>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-zinc-500">Fecha</span>
                    <strong className="text-right capitalize">
                      {formatReservationDate(
                        activeReservation.reservedFor,
                        timeZone,
                      )}
                    </strong>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-zinc-500">Personas</span>
                    <strong>{activeReservation.partySize}</strong>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-zinc-500">Responsable</span>
                    <strong className="text-right">
                      {activeReservation.customerName}
                    </strong>
                  </div>
                </div>

                {activeReservation.preorder ? (
                  <div className="mt-5 rounded-2xl border border-sky-200 bg-sky-50 p-5">
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-700">
                      Pedido anticipado vinculado
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-4">
                      <div>
                        <p className="text-lg font-black text-sky-950">
                          Pedido #{activeReservation.preorder.orderNumber}
                        </p>
                        <p className="mt-1 text-sm text-sky-800">
                          {activeReservation.preorder.currency}{" "}
                          {activeReservation.preorder.total.toFixed(2)}
                        </p>
                      </div>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-sky-800">
                        {getPreorderStatusLabel(
                          activeReservation.preorder.status,
                        )}
                      </span>
                    </div>
                  </div>
                ) : (
                  onStartPreorder &&
                  ["PENDING", "CONFIRMED"].includes(
                    activeReservation.status,
                  ) && (
                    <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
                      <p className="font-black text-emerald-950">
                        ¿Quieres dejar listo tu pedido?
                      </p>
                      <p className="mt-1 text-sm text-emerald-800">
                        Es opcional. Podrás elegir los productos ahora y el
                        pedido quedará programado para la hora de tu reserva.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          onStartPreorder(activeReservation);
                          setModalOpen(false);
                        }}
                        className="mt-4 w-full rounded-xl bg-emerald-700 px-5 py-3 font-black text-white"
                      >
                        Agregar pedido anticipado
                      </button>
                    </div>
                  )
                )}

                <p className="mt-5 text-center text-sm text-zinc-500">
                  Conserva este código. El restaurante confirmará la reserva y
                  el estado se actualizará automáticamente cada 5 segundos.
                </p>

                {error && (
                  <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
                    {error}
                  </div>
                )}

                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void refreshReservation()}
                    className="rounded-xl border border-zinc-300 bg-white px-5 py-3 font-bold disabled:opacity-50"
                  >
                    {busy ? "Actualizando..." : "Actualizar estado"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setModalOpen(false)}
                    className="rounded-xl bg-zinc-950 px-5 py-3 font-bold text-white"
                  >
                    Volver al menú
                  </button>
                </div>

                {["COMPLETED", "CANCELLED", "NO_SHOW"].includes(
                  activeReservation.status,
                ) && (
                  <button
                    type="button"
                    onClick={startAnotherReservation}
                    className="mt-3 w-full rounded-xl px-5 py-3 text-sm font-bold text-zinc-600"
                  >
                    Crear una nueva reserva
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
