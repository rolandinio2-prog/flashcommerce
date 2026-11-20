"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import {
  createStaffUser,
  getStaffSession,
  getStaffUsers,
  resetStaffCredentials,
  updateStaffUserStatus,
  type CreatedStaffCredentials,
  type StaffRole,
  type StaffSessionUser,
  type StaffUserSummary,
} from "../../../lib/flash-api";

interface OpsUsersClientProps {
  tenantCode: string;
  branchCode: string;
  returnHref?: string;
  returnLabel?: string;
}

const ROLE_OPTIONS: Array<{ value: StaffRole; label: string }> = [
  { value: "ADMIN", label: "Administrador" },
  { value: "MANAGER", label: "Encargado" },
  { value: "CASHIER", label: "Cajero" },
  { value: "KITCHEN", label: "Cocina / KDS" },
  { value: "WAITER", label: "Mesero" },
];

function roleLabel(role: StaffRole) {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

export default function OpsUsersClient({
  tenantCode,
  branchCode,
  returnHref = "/ops",
  returnLabel = "Volver a operaciones",
}: OpsUsersClientProps) {
  const [sessionUser, setSessionUser] = useState<StaffSessionUser | null>(null);
  const [users, setUsers] = useState<StaffUserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CreatedStaffCredentials | null>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [identityDocument, setIdentityDocument] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("CASHIER");

  const loadUsers = useCallback(async () => {
    const response = await getStaffUsers();
    setUsers(response.users);
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
          setError("Tu usuario no tiene permisos para administrar operadores");
          return;
        }

        await loadUsers();
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "No se pudo cargar la administración de usuarios",
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
  }, [loadUsers]);

  async function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!firstName.trim() || !lastName.trim()) {
      setError("Ingresa nombres y apellidos");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const created = await createStaffUser({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        identityDocument: identityDocument.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        role,
      });

      setCredentials(created);
      setFirstName("");
      setLastName("");
      setIdentityDocument("");
      setPhone("");
      setEmail("");
      setRole("CASHIER");
      await loadUsers();
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "No se pudo crear el usuario",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resetCredentials(user: StaffUserSummary) {
    if (!window.confirm(`¿Generar nuevas credenciales para ${user.displayName}?`)) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const result = await resetStaffCredentials(user.id);
      setCredentials(result);
    } catch (resetError) {
      setError(
        resetError instanceof Error
          ? resetError.message
          : "No se pudieron regenerar las credenciales",
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(user: StaffUserSummary) {
    const nextStatus = user.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";

    setBusy(true);
    setError(null);

    try {
      await updateStaffUserStatus(user.id, nextStatus);
      await loadUsers();
    } catch (statusError) {
      setError(
        statusError instanceof Error
          ? statusError.message
          : "No se pudo actualizar el usuario",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-zinc-100 px-6 py-16 text-zinc-950">
        <div className="mx-auto max-w-5xl rounded-2xl border border-zinc-200 bg-white p-8 text-center">
          Cargando usuarios...
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
              Flash Commerce
            </p>
            <h1 className="text-2xl font-black">Administración de usuarios</h1>
            <p className="mt-1 text-sm text-zinc-500">
              {tenantCode} · {branchCode}
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

      <div className="mx-auto grid max-w-6xl gap-6 px-6 py-6 lg:grid-cols-[380px_1fr]">
        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-black">Nuevo usuario</h2>
          <p className="mt-1 text-sm text-zinc-500">
            El sistema genera automáticamente el código y una contraseña temporal.
          </p>

          <form onSubmit={submitUser} className="mt-5 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <label>
                <span className="text-sm font-bold">Nombres</span>
                <input
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                />
              </label>
              <label>
                <span className="text-sm font-bold">Apellidos</span>
                <input
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                />
              </label>
            </div>

            <label className="block">
              <span className="text-sm font-bold">CI / documento</span>
              <input
                value={identityDocument}
                onChange={(event) => setIdentityDocument(event.target.value)}
                className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
              />
            </label>

            <label className="block">
              <span className="text-sm font-bold">Teléfono</span>
              <input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
              />
            </label>

            <label className="block">
              <span className="text-sm font-bold">Correo</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
              />
            </label>

            <label className="block">
              <span className="text-sm font-bold">Rol</span>
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as StaffRole)}
                className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-3 py-3 outline-none focus:border-zinc-950"
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-zinc-950 px-4 py-3 font-black text-white disabled:bg-zinc-400"
            >
              {busy ? "Guardando..." : "Crear usuario"}
            </button>
          </form>
        </section>

        <section className="space-y-5">
          {credentials && (
            <div className="rounded-2xl border border-green-300 bg-green-50 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-black text-green-950">Credenciales generadas</h2>
                  <p className="mt-1 text-sm text-green-800">
                    Entrégalas al operador. La contraseña no se guarda en texto plano y
                    sólo se muestra aquí.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCredentials(null)}
                  className="rounded-lg border border-green-300 bg-white px-3 py-2 text-sm font-bold"
                >
                  Cerrar
                </button>
              </div>
              <dl className="mt-4 grid gap-3 rounded-xl bg-white p-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs uppercase text-zinc-500">Usuario</dt>
                  <dd className="mt-1 font-mono text-lg font-black">
                    {credentials.credentials.userCode}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase text-zinc-500">Contraseña temporal</dt>
                  <dd className="mt-1 break-all font-mono text-lg font-black">
                    {credentials.credentials.temporaryPassword}
                  </dd>
                </div>
              </dl>
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
                <h2 className="text-lg font-black">Usuarios de la sucursal</h2>
                <p className="mt-1 text-sm text-zinc-500">{users.length} registrados</p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void loadUsers()}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-bold disabled:opacity-50"
              >
                Actualizar
              </button>
            </div>

            <div className="mt-5 space-y-3">
              {users.map((user) => (
                <article
                  key={user.id}
                  className="rounded-xl border border-zinc-200 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-black">{user.displayName}</h3>
                        <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs font-bold">
                          {roleLabel(user.role)}
                        </span>
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-bold ${
                            user.status === "ACTIVE"
                              ? "bg-green-100 text-green-800"
                              : "bg-zinc-200 text-zinc-600"
                          }`}
                        >
                          {user.status === "ACTIVE" ? "Activo" : "Inactivo"}
                        </span>
                        {user.passwordChangeRequired && (
                          <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-800">
                            Clave temporal
                          </span>
                        )}
                      </div>
                      <p className="mt-1 font-mono text-sm font-bold text-zinc-600">
                        {user.userCode}
                      </p>
                      <p className="mt-2 text-sm text-zinc-500">
                        {[user.identityDocument, user.phone, user.email]
                          .filter(Boolean)
                          .join(" · ") || "Sin datos adicionales"}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void resetCredentials(user)}
                        className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-bold disabled:opacity-50"
                      >
                        Nueva clave
                      </button>
                      <button
                        type="button"
                        disabled={busy || user.id === sessionUser?.userId}
                        onClick={() => void toggleStatus(user)}
                        className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-bold disabled:opacity-40"
                      >
                        {user.status === "ACTIVE" ? "Desactivar" : "Activar"}
                      </button>
                    </div>
                  </div>
                </article>
              ))}

              {users.length === 0 && (
                <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">
                  No hay usuarios registrados.
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
