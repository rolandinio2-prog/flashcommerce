"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import {
  createDeliveryAdminDriver,
  getDeliveryAdminDrivers,
  getStaffSession,
  resetDeliveryAdminDriverCredentials,
  updateDeliveryAdminDriverProfile,
  updateDeliveryAdminDriverStatus,
  type DeliveryAdminDriverSummary,
  type StaffSessionUser,
} from "../../../../lib/flash-api";

interface OpsDriversClientProps {
  tenantCode: string;
  branchCode: string;
  returnHref?: string;
  returnLabel?: string;
}

interface DriverCredentialNotice {
  driverCode: string;
  displayName: string;
  temporaryPassword: string;
}

function getAvailabilityLabel(driver: DeliveryAdminDriverSummary) {
  if (driver.status !== "ACTIVE") {
    return "Inactivo";
  }

  if (driver.activeAssignments > 0) {
    return "En entrega";
  }

  return "Disponible";
}

function splitLegacyDisplayName(displayName: string) {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);

  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

export default function OpsDriversClient({
  tenantCode,
  branchCode,
  returnHref = "/ops",
  returnLabel = "Volver a operaciones",
}: OpsDriversClientProps) {
  const [sessionUser, setSessionUser] = useState<StaffSessionUser | null>(null);
  const [drivers, setDrivers] = useState<DeliveryAdminDriverSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialNotice, setCredentialNotice] =
    useState<DriverCredentialNotice | null>(null);

  const [editingDriverId, setEditingDriverId] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [identityDocument, setIdentityDocument] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [vehiclePlate, setVehiclePlate] = useState("");

  const loadDrivers = useCallback(async () => {
    const response = await getDeliveryAdminDrivers();
    setDrivers(response.drivers);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const session = await getStaffSession();

        if (cancelled) {
          return;
        }

        if (session.user.passwordChangeRequired) {
          window.location.href = "/ops";
          return;
        }

        setSessionUser(session.user);

        if (session.user.role !== "ADMIN" && session.user.role !== "MANAGER") {
          setError("Tu usuario no tiene permisos para administrar repartidores");
          return;
        }

        await loadDrivers();
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "No se pudo cargar la administración de repartidores",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [loadDrivers]);

  function clearForm() {
    setEditingDriverId(null);
    setFirstName("");
    setLastName("");
    setIdentityDocument("");
    setPhone("");
    setEmail("");
    setVehiclePlate("");
  }

  function editDriver(driver: DeliveryAdminDriverSummary) {
    const legacyNames = splitLegacyDisplayName(driver.displayName);

    setEditingDriverId(driver.id);
    setFirstName(driver.firstName ?? legacyNames.firstName);
    setLastName(driver.lastName ?? legacyNames.lastName);
    setIdentityDocument(driver.identityDocument ?? "");
    setPhone(driver.phone ?? "");
    setEmail(driver.email ?? "");
    setVehiclePlate(driver.vehiclePlate ?? "");
    setCredentialNotice(null);
    setError(null);

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submitDriver(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (
      !firstName.trim() ||
      !lastName.trim() ||
      !identityDocument.trim() ||
      !phone.trim() ||
      !vehiclePlate.trim()
    ) {
      setError("Completa nombres, apellidos, CI, teléfono y placa");
      return;
    }

    const input = {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      identityDocument: identityDocument.trim(),
      phone: phone.trim(),
      email: email.trim() || undefined,
      vehiclePlate: vehiclePlate.trim().toUpperCase(),
    };

    setBusy(true);
    setError(null);

    try {
      if (editingDriverId) {
        await updateDeliveryAdminDriverProfile(editingDriverId, input);
        clearForm();
      } else {
        const created = await createDeliveryAdminDriver(input);

        setCredentialNotice({
          driverCode: created.credentials.driverCode,
          displayName: created.driver.displayName,
          temporaryPassword: created.credentials.temporaryPassword,
        });

        clearForm();
      }

      await loadDrivers();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "No se pudo guardar el repartidor",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resetCredentials(driver: DeliveryAdminDriverSummary) {
    if (
      !window.confirm(
        `¿Generar una nueva contraseña temporal para ${driver.displayName}? Las sesiones anteriores dejarán de funcionar.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const result = await resetDeliveryAdminDriverCredentials(driver.id);

      setCredentialNotice({
        driverCode: result.credentials.driverCode,
        displayName: result.driver.displayName,
        temporaryPassword: result.credentials.temporaryPassword,
      });

      await loadDrivers();
    } catch (resetError) {
      setError(
        resetError instanceof Error
          ? resetError.message
          : "No se pudo generar una nueva credencial",
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(driver: DeliveryAdminDriverSummary) {
    const nextStatus = driver.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";

    setBusy(true);
    setError(null);

    try {
      await updateDeliveryAdminDriverStatus(driver.id, nextStatus);
      await loadDrivers();
    } catch (statusError) {
      setError(
        statusError instanceof Error
          ? statusError.message
          : "No se pudo actualizar el estado del repartidor",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyTemporaryPassword() {
    if (!credentialNotice) {
      return;
    }

    try {
      await navigator.clipboard.writeText(credentialNotice.temporaryPassword);
    } catch {
      setError("No se pudo copiar automáticamente. Selecciona la contraseña y cópiala manualmente.");
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-zinc-100 px-6 py-16 text-zinc-950">
        <div className="mx-auto max-w-6xl rounded-2xl border border-zinc-200 bg-white p-8 text-center">
          Cargando repartidores...
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-5">
          <div>
            <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
              Flash Commerce · FlashDelivery
            </p>
            <h1 className="text-2xl font-black">Administración de repartidores</h1>
            <p className="mt-1 text-sm text-zinc-500">
              {sessionUser?.tenantCode ?? tenantCode} · {sessionUser?.branchCode ?? branchCode}
              {sessionUser ? ` · ${sessionUser.displayName}` : ""}
            </p>
          </div>
          <a
            href={returnHref}
            className="rounded-xl bg-zinc-950 px-4 py-3 text-sm font-black text-white"
          >
            {returnLabel}
          </a>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-6 px-6 py-6 lg:grid-cols-[390px_1fr]">
        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-black">
                {editingDriverId ? "Editar repartidor" : "Registrar repartidor"}
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                {editingDriverId
                  ? "Actualiza los datos personales y del vehículo."
                  : "Al registrarlo queda disponible para la asignación automática de pedidos Delivery."}
              </p>
            </div>
            {editingDriverId && (
              <button
                type="button"
                disabled={busy}
                onClick={clearForm}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-bold disabled:opacity-50"
              >
                Cancelar
              </button>
            )}
          </div>

          <form onSubmit={submitDriver} className="mt-5 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <label>
                <span className="text-sm font-bold">Nombres</span>
                <input
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                  maxLength={80}
                />
              </label>
              <label>
                <span className="text-sm font-bold">Apellidos</span>
                <input
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                  maxLength={80}
                />
              </label>
            </div>

            <label className="block">
              <span className="text-sm font-bold">CI / documento</span>
              <input
                value={identityDocument}
                onChange={(event) => setIdentityDocument(event.target.value)}
                className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                maxLength={40}
              />
            </label>

            <label className="block">
              <span className="text-sm font-bold">Teléfono</span>
              <input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                maxLength={40}
              />
            </label>

            <label className="block">
              <span className="text-sm font-bold">Correo</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                maxLength={160}
              />
            </label>

            <label className="block">
              <span className="text-sm font-bold">Placa del vehículo</span>
              <input
                value={vehiclePlate}
                onChange={(event) => setVehiclePlate(event.target.value.toUpperCase())}
                className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 font-mono font-bold uppercase outline-none focus:border-zinc-950"
                placeholder="1234 ABC"
                maxLength={20}
              />
            </label>

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-zinc-950 px-4 py-3 font-black text-white disabled:bg-zinc-400"
            >
              {busy
                ? "Guardando..."
                : editingDriverId
                  ? "Guardar cambios"
                  : "Registrar repartidor"}
            </button>
          </form>
        </section>

        <section className="space-y-5">
          {credentialNotice && (
            <div className="rounded-2xl border border-green-300 bg-green-50 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-black text-green-950">
                    Acceso de FlashDelivery generado
                  </h2>
                  <p className="mt-1 text-sm text-green-800">
                    Entrega estas credenciales a {credentialNotice.displayName}. La contraseña temporal sólo se muestra ahora y deberá cambiarla al ingresar por primera vez.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCredentialNotice(null)}
                  className="rounded-lg border border-green-300 bg-white px-3 py-2 text-sm font-bold"
                >
                  Cerrar
                </button>
              </div>

              <dl className="mt-4 grid gap-3 rounded-xl bg-white p-4">
                <div>
                  <dt className="text-xs uppercase text-zinc-500">Código del repartidor</dt>
                  <dd className="mt-1 font-mono text-lg font-black">
                    {credentialNotice.driverCode}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase text-zinc-500">Contraseña temporal</dt>
                  <dd className="mt-1 break-all font-mono text-sm font-black">
                    {credentialNotice.temporaryPassword}
                  </dd>
                </div>
              </dl>

              <button
                type="button"
                onClick={() => void copyTemporaryPassword()}
                className="mt-3 rounded-lg border border-green-300 bg-white px-3 py-2 text-sm font-bold"
              >
                Copiar contraseña
              </button>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {error}
            </div>
          )}

          <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-black">Repartidores de la sucursal</h2>
                <p className="mt-1 text-sm text-zinc-500">
                  {drivers.length} registrados · la asignación automática utiliza sólo los disponibles
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void loadDrivers()}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-bold disabled:opacity-50"
              >
                Actualizar
              </button>
            </div>

            <div className="mt-5 space-y-3">
              {drivers.map((driver) => {
                const availability = getAvailabilityLabel(driver);
                const profileComplete = Boolean(
                  driver.firstName &&
                    driver.lastName &&
                    driver.identityDocument &&
                    driver.vehiclePlate,
                );

                return (
                  <article
                    key={driver.id}
                    className="rounded-xl border border-zinc-200 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-black">{driver.displayName}</h3>
                          <span className="rounded-full bg-zinc-100 px-2 py-1 font-mono text-xs font-bold">
                            {driver.code}
                          </span>
                          <span
                            className={`rounded-full px-2 py-1 text-xs font-bold ${
                              availability === "Disponible"
                                ? "bg-green-100 text-green-800"
                                : availability === "En entrega"
                                  ? "bg-blue-100 text-blue-800"
                                  : "bg-zinc-200 text-zinc-600"
                            }`}
                          >
                            {availability}
                          </span>
                          {!profileComplete && (
                            <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-800">
                              Perfil incompleto
                            </span>
                          )}
                        </div>

                        <div className="mt-3 grid gap-1 text-sm text-zinc-600 sm:grid-cols-2">
                          <p>
                            <span className="font-bold text-zinc-800">CI:</span>{" "}
                            {driver.identityDocument ?? "Pendiente"}
                          </p>
                          <p>
                            <span className="font-bold text-zinc-800">Tel.:</span>{" "}
                            {driver.phone}
                          </p>
                          <p>
                            <span className="font-bold text-zinc-800">Placa:</span>{" "}
                            {driver.vehiclePlate ?? "Pendiente"}
                          </p>
                          <p>
                            <span className="font-bold text-zinc-800">Acceso:</span>{" "}
                            {!driver.passwordConfigured
                              ? "Sin contraseña"
                              : driver.passwordChangeRequired
                                ? "Clave temporal"
                                : "Clave personal"}
                          </p>
                          {driver.email && <p className="sm:col-span-2">{driver.email}</p>}
                        </div>

                        {driver.activeAssignments > 0 && (
                          <p className="mt-2 text-sm font-bold text-blue-700">
                            {driver.activeAssignments} entrega activa
                            {driver.activeAssignments === 1 ? "" : "s"}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => editDriver(driver)}
                          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-bold disabled:opacity-50"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void resetCredentials(driver)}
                          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-bold disabled:opacity-50"
                        >
                          Nueva clave
                        </button>
                        <button
                          type="button"
                          disabled={busy || (driver.status === "ACTIVE" && driver.activeAssignments > 0)}
                          onClick={() => void toggleStatus(driver)}
                          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-bold disabled:opacity-40"
                        >
                          {driver.status === "ACTIVE" ? "Desactivar" : "Activar"}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}

              {drivers.length === 0 && (
                <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">
                  No hay repartidores registrados para esta sucursal.
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
