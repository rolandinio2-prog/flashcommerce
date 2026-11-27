"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  getStaffSession,
  getStaffTrackingDeliveries,
  logoutStaff,
  type StaffSessionUser,
  type StaffTrackingDelivery,
  type StaffTrackingDeliveryStatus,
  type StaffTrackingResponse,
} from "../../../../lib/flash-api";

type TrackingTab = "ACTIVE" | "DELIVERED";

function canViewTracking(user: StaffSessionUser) {
  return (
    user.role === "ADMIN" ||
    user.role === "MANAGER" ||
    user.role === "CASHIER"
  );
}

function canOpenAdministration(user: StaffSessionUser) {
  return user.role === "ADMIN" || user.role === "MANAGER";
}

function statusLabel(status: StaffTrackingDeliveryStatus) {
  switch (status) {
    case "PICKED_UP":
      return "Entregado al repartidor";
    case "EN_ROUTE":
      return "En camino";
    case "ARRIVED":
      return "Repartidor en destino";
    case "DELIVERED":
      return "Entregado al cliente";
  }
}

function statusClass(status: StaffTrackingDeliveryStatus) {
  switch (status) {
    case "PICKED_UP":
      return "bg-sky-100 text-sky-800";
    case "EN_ROUTE":
      return "bg-blue-100 text-blue-800";
    case "ARRIVED":
      return "bg-amber-100 text-amber-900";
    case "DELIVERED":
      return "bg-emerald-100 text-emerald-800";
  }
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("es-BO", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function formatMoney(currency: string, value: number) {
  return new Intl.NumberFormat("es-BO", {
    style: "currency",
    currency: currency || "BOB",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatGpsAge(delivery: StaffTrackingDelivery) {
  const value =
    delivery.latestGps?.capturedAt ??
    delivery.latestGps?.receivedAt;

  if (!value) {
    return { label: "Sin ubicación GPS", stale: true };
  }

  const timestamp = new Date(value).getTime();

  if (Number.isNaN(timestamp)) {
    return { label: "GPS sin hora válida", stale: true };
  }

  const seconds = Math.max(
    0,
    Math.round((Date.now() - timestamp) / 1000),
  );

  if (seconds < 60) {
    return {
      label: `GPS hace ${seconds} s`,
      stale: seconds > 30,
    };
  }

  return {
    label: `GPS hace ${Math.floor(seconds / 60)} min`,
    stale: true,
  };
}

function timelineRows(delivery: StaffTrackingDelivery) {
  return [
    { label: "Asignado", value: delivery.assignment?.assignedAt },
    { label: "Aceptado", value: delivery.assignment?.acceptedAt },
    { label: "Recogido", value: delivery.timeline.pickedUpAt },
    { label: "En camino", value: delivery.timeline.enRouteAt },
    { label: "En destino", value: delivery.timeline.arrivedAt },
    { label: "Entregado", value: delivery.timeline.deliveredAt },
  ];
}

function DeliveryCard({ delivery }: { delivery: StaffTrackingDelivery }) {
  const gps = formatGpsAge(delivery);

  return (
    <article className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xl font-black">
              Pedido #{delivery.order.orderNumber}
            </h3>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-black ${statusClass(
                delivery.status,
              )}`}
            >
              {statusLabel(delivery.status)}
            </span>
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {delivery.recipient.name} · {delivery.recipient.phone}
          </p>
        </div>

        <div className="text-right">
          <p className="text-sm font-black">
            {formatMoney(delivery.order.currency, delivery.order.total)}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Pago: {delivery.order.paymentStatus}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl bg-zinc-50 p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">
            Entrega
          </p>
          <p className="mt-2 text-sm font-semibold">
            {delivery.destination.address}
          </p>

          {delivery.destination.reference && (
            <p className="mt-1 text-xs text-zinc-500">
              Ref.: {delivery.destination.reference}
            </p>
          )}

          <p className="mt-3 text-sm">
            <span className="font-bold">Repartidor:</span>{" "}
            {delivery.assignment?.driver?.name ?? "Sin repartidor"}
          </p>

          {delivery.assignment?.driver?.code && (
            <p className="mt-1 text-xs text-zinc-500">
              {delivery.assignment.driver.code}
            </p>
          )}

          {delivery.status !== "DELIVERED" ? (
            <div
              className={`mt-3 rounded-lg px-3 py-2 text-xs font-bold ${
                gps.stale
                  ? "bg-amber-50 text-amber-900"
                  : "bg-emerald-50 text-emerald-800"
              }`}
            >
              {gps.label}
            </div>
          ) : (
            <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800">
              Código de entrega verificado ✓
            </div>
          )}
        </div>

        <div className="rounded-xl bg-zinc-50 p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">
            Línea de tiempo
          </p>
          <div className="mt-3 space-y-2 text-sm">
            {timelineRows(delivery).map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between gap-4"
              >
                <span className="text-zinc-600">{row.label}</span>
                <span className="font-semibold">
                  {formatDateTime(row.value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-zinc-500">
          {delivery.quote.distanceMeters !== null && (
            <span>
              Distancia cotizada:{" "}
              {(delivery.quote.distanceMeters / 1000).toFixed(1)} km
            </span>
          )}
          {delivery.quote.eta.minMinutes !== null &&
            delivery.quote.eta.maxMinutes !== null && (
              <span className="ml-3">
                ETA inicial: {delivery.quote.eta.minMinutes}–
                {delivery.quote.eta.maxMinutes} min
              </span>
            )}
        </div>

        <a
          href={`/track/${delivery.trackingToken}`}
          className="rounded-xl bg-zinc-950 px-4 py-2.5 text-sm font-black text-white"
        >
          Ver seguimiento
        </a>
      </div>
    </article>
  );
}

export default function TrackingClient() {
  const [sessionUser, setSessionUser] =
    useState<StaffSessionUser | null>(null);
  const [data, setData] =
    useState<StaffTrackingResponse | null>(null);
  const [tab, setTab] = useState<TrackingTab>("ACTIVE");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTracking = useCallback(async (showBusy: boolean) => {
    if (showBusy) setRefreshing(true);

    try {
      const response = await getStaffTrackingDeliveries();
      setData(response);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "No se pudo cargar el seguimiento",
      );
    } finally {
      if (showBusy) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const session = await getStaffSession();
        if (cancelled) return;

        if (session.user.passwordChangeRequired) {
          window.location.href = "/ops";
          return;
        }

        setSessionUser(session.user);

        if (canViewTracking(session.user)) {
          const response = await getStaffTrackingDeliveries();
          if (!cancelled) setData(response);
        }
      } catch (bootError) {
        if (!cancelled) {
          setError(
            bootError instanceof Error
              ? bootError.message
              : "No se pudo iniciar Seguimiento",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionUser || !canViewTracking(sessionUser)) return;

    const timer = window.setInterval(() => {
      void loadTracking(false);
    }, 10_000);

    return () => window.clearInterval(timer);
  }, [loadTracking, sessionUser]);

  const visibleDeliveries = useMemo(() => {
    const source =
      tab === "ACTIVE" ? data?.active ?? [] : data?.delivered ?? [];
    const query = search.trim().toLowerCase();

    if (!query) return source;

    return source.filter((delivery) =>
      [
        delivery.order.orderNumber,
        delivery.recipient.name,
        delivery.recipient.phone,
        delivery.destination.address,
        delivery.assignment?.driver?.name ?? "",
        delivery.assignment?.driver?.code ?? "",
      ].some((value) => value.toLowerCase().includes(query)),
    );
  }, [data, search, tab]);

  async function handleLogout() {
    try {
      await logoutStaff();
    } catch {
      // La sesión ya puede estar vencida.
    }

    window.location.href = "/ops";
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-zinc-100 px-6 py-16 text-zinc-950">
        <div className="mx-auto max-w-6xl rounded-2xl border border-zinc-200 bg-white p-8 text-center">
          Cargando seguimiento...
        </div>
      </main>
    );
  }

  if (!sessionUser || !canViewTracking(sessionUser)) {
    return (
      <main className="min-h-screen bg-zinc-100 px-6 py-16 text-zinc-950">
        <div className="mx-auto max-w-xl rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
            Flash Commerce · FlashDelivery
          </p>
          <h1 className="mt-1 text-3xl font-black">Seguimiento</h1>
          <p className="mt-4 text-sm text-zinc-600">
            {error ??
              "Tu usuario no tiene permisos para consultar el seguimiento de entregas."}
          </p>
          <a
            href="/ops"
            className="mt-6 inline-flex rounded-xl bg-zinc-950 px-4 py-3 text-sm font-black text-white"
          >
            Volver a Operaciones
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-6">
          <div>
            <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
              Flash Commerce · FlashDelivery
            </p>
            <h1 className="text-3xl font-black">Seguimiento de pedidos</h1>
            <p className="mt-1 text-sm text-zinc-500">
              {sessionUser.tenantCode} · {sessionUser.branchCode} ·{" "}
              {sessionUser.displayName} · {sessionUser.role}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <a
              href="/ops"
              className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-black"
            >
              Operaciones / KDS
            </a>
            {canOpenAdministration(sessionUser) && (
              <a
                href="/admin"
                className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-black"
              >
                Administración
              </a>
            )}
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="rounded-xl bg-zinc-950 px-4 py-3 text-sm font-black text-white"
            >
              Cerrar sesión
            </button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-6 py-8">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">
              En reparto
            </p>
            <p className="mt-2 text-3xl font-black">
              {data?.summary.active ?? 0}
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              Desde que el repartidor recoge el pedido hasta la entrega.
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">
              Entregados recientes
            </p>
            <p className="mt-2 text-3xl font-black">
              {data?.summary.delivered ?? 0}
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              Últimos 100 Delivery confirmados con POD.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTab("ACTIVE")}
              className={`rounded-xl px-4 py-3 text-sm font-black ${
                tab === "ACTIVE"
                  ? "bg-zinc-950 text-white"
                  : "border border-zinc-300 bg-white"
              }`}
            >
              En reparto ({data?.summary.active ?? 0})
            </button>
            <button
              type="button"
              onClick={() => setTab("DELIVERED")}
              className={`rounded-xl px-4 py-3 text-sm font-black ${
                tab === "DELIVERED"
                  ? "bg-zinc-950 text-white"
                  : "border border-zinc-300 bg-white"
              }`}
            >
              Entregados ({data?.summary.delivered ?? 0})
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Pedido, cliente o repartidor"
              className="min-w-[260px] rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm outline-none focus:border-zinc-700"
            />
            <button
              type="button"
              onClick={() => void loadTracking(true)}
              disabled={refreshing}
              className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-black disabled:text-zinc-400"
            >
              {refreshing ? "Actualizando..." : "Actualizar"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
            {error}
          </div>
        )}

        <div className="mt-5 space-y-4">
          {visibleDeliveries.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center text-sm text-zinc-500">
              {tab === "ACTIVE"
                ? "No hay pedidos actualmente en reparto."
                : "No hay entregas completadas para mostrar."}
            </div>
          ) : (
            visibleDeliveries.map((delivery) => (
              <DeliveryCard key={delivery.id} delivery={delivery} />
            ))
          )}
        </div>

        <p className="mt-6 text-xs text-zinc-500">
          Actualización automática cada 10 s. Seguimiento es de solo lectura; los estados logísticos se actualizan únicamente desde FlashDelivery Driver.
        </p>
      </section>
    </main>
  );
}
