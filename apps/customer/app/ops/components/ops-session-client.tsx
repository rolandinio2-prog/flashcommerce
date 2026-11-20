"use client";

import { FormEvent, useEffect, useState } from "react";

import {
  bootstrapStaffAdmin,
  changeStaffPassword,
  getStaffBootstrapStatus,
  getStaffSession,
  loginStaff,
  logoutStaff,
  recoverStaffAdmin,
  type CreatedStaffCredentials,
  type StaffSessionUser,
} from "../../../lib/flash-api";

import CommercialLinksPanel from "./commercial-links-panel";

import OpsOrdersClient from "./ops-orders-client";

interface OpsSessionClientProps {
  tenantCode: string;
  branchCode: string;
}

export default function OpsSessionClient({
  tenantCode,
  branchCode,
}: OpsSessionClientProps) {
  const [sessionUser, setSessionUser] = useState<StaffSessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [userCode, setUserCode] = useState("");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [opsAccessKey, setOpsAccessKey] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [identityDocument, setIdentityDocument] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [createdCredentials, setCreatedCredentials] =
    useState<CreatedStaffCredentials | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordChangeBusy, setPasswordChangeBusy] = useState(false);

  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryOpsKey, setRecoveryOpsKey] = useState("");
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryCredentials, setRecoveryCredentials] =
    useState<{ userCode: string; temporaryPassword: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const session = await getStaffSession();

        if (!cancelled) {
          setSessionUser(session.user);
          setBootstrapRequired(false);
        }
      } catch {
        try {
          const status = await getStaffBootstrapStatus(tenantCode, branchCode);

          if (!cancelled) {
            setBootstrapRequired(status.bootstrapRequired);
          }
        } catch (statusError) {
          if (!cancelled) {
            setError(
              statusError instanceof Error
                ? statusError.message
                : "No se pudo verificar la configuración de operadores",
            );
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadSession();

    return () => {
      cancelled = true;
    };
  }, [tenantCode, branchCode]);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!userCode.trim() || !password) {
      setError("Ingresa el código de usuario y la contraseña");
      return;
    }

    setLoginBusy(true);
    setError(null);

    try {
      const result = await loginStaff(
        tenantCode,
        branchCode,
        userCode.trim(),
        password,
      );

      setSessionUser(result.user);
      setPassword("");
      setCreatedCredentials(null);
    } catch (loginError) {
      setError(
        loginError instanceof Error
          ? loginError.message
          : "No se pudo iniciar sesión",
      );
    } finally {
      setLoginBusy(false);
    }
  }

  async function submitBootstrap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!firstName.trim() || !lastName.trim()) {
      setError("Ingresa nombres y apellidos del administrador");
      return;
    }

    if (!opsAccessKey.trim()) {
      setError("Ingresa la clave privada de operaciones para crear el primer administrador");
      return;
    }

    setBootstrapBusy(true);
    setError(null);

    try {
      const created = await bootstrapStaffAdmin(
        {
          tenantCode,
          branchCode,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          identityDocument: identityDocument.trim() || undefined,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
        },
        opsAccessKey.trim(),
      );

      setCreatedCredentials(created);
      setUserCode(created.credentials.userCode);
      setPassword(created.credentials.temporaryPassword);
      setBootstrapRequired(false);
      setOpsAccessKey("");
    } catch (bootstrapError) {
      setError(
        bootstrapError instanceof Error
          ? bootstrapError.message
          : "No se pudo crear el administrador inicial",
      );
    } finally {
      setBootstrapBusy(false);
    }
  }

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (newPassword.length < 10) {
      setError("La nueva contraseña debe tener al menos 10 caracteres");
      return;
    }

    if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setError("La nueva contraseña debe contener al menos una letra y un número");
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("Las contraseñas no coinciden");
      return;
    }

    setPasswordChangeBusy(true);
    setError(null);

    try {
      const result = await changeStaffPassword(newPassword);
      setSessionUser(result.user);
      setNewPassword("");
      setConfirmPassword("");
    } catch (changeError) {
      setError(
        changeError instanceof Error
          ? changeError.message
          : "No se pudo guardar la contraseña personal",
      );
    } finally {
      setPasswordChangeBusy(false);
    }
  }

  async function submitAdminRecovery() {

    if (!userCode.trim()) {
      setError("Ingresa el código del administrador a recuperar");
      return;
    }

    if (!recoveryOpsKey.trim()) {
      setError("Ingresa la clave privada de operaciones");
      return;
    }

    setRecoveryBusy(true);
    setError(null);

    try {
      const recovered = await recoverStaffAdmin(
        tenantCode,
        branchCode,
        userCode.trim(),
        recoveryOpsKey.trim(),
      );

      setRecoveryCredentials(recovered.credentials);
      setUserCode(recovered.credentials.userCode);
      setPassword(recovered.credentials.temporaryPassword);
      setRecoveryOpsKey("");
    } catch (recoveryError) {
      setError(
        recoveryError instanceof Error
          ? recoveryError.message
          : "No se pudo recuperar el acceso del administrador",
      );
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function handleLogout() {
    setError(null);

    try {
      await logoutStaff();
    } catch {
      // El estado local se cierra igualmente. Una sesión vencida ya no sirve.
    }

    setSessionUser(null);
    setPassword("");
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-zinc-100 px-6 py-16 text-zinc-950">
        <div className="mx-auto max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center">
          Cargando sesión de operaciones...
        </div>
      </main>
    );
  }

  if (!sessionUser) {
    return (
      <main className="min-h-screen bg-zinc-100 px-5 py-10 text-zinc-950">
        <div className="mx-auto max-w-lg">
          <div className="mb-6">
            <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
              Flash Commerce
            </p>
            <h1 className="mt-1 text-3xl font-black">Acceso de operadores</h1>
            <p className="mt-2 text-sm text-zinc-500">
              {tenantCode} · {branchCode}
            </p>
          </div>

          <details className="mb-5 rounded-xl border border-zinc-300 bg-white p-4">
            <summary className="cursor-pointer font-bold">Cambiar negocio o sucursal</summary>
            <form action="/ops" method="get" className="mt-4 grid gap-3">
              <label className="grid gap-1 text-sm font-semibold">
                Código del negocio
                <input name="tenantCode" defaultValue={tenantCode} required minLength={2} maxLength={50}
                  pattern="[A-Za-z0-9_-]{2,50}" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
                  className="min-w-0 rounded-lg border border-zinc-300 px-3 py-3 text-base" />
              </label>
              <label className="grid gap-1 text-sm font-semibold">
                Código de sucursal
                <input name="branchCode" defaultValue={branchCode} required minLength={2} maxLength={50}
                  pattern="[A-Za-z0-9_-]{2,50}" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
                  className="min-w-0 rounded-lg border border-zinc-300 px-3 py-3 text-base" />
              </label>
              <button type="submit" className="rounded-lg bg-zinc-950 px-4 py-3 font-bold text-white">
                Continuar con este negocio
              </button>
            </form>
          </details>

          {createdCredentials && (
            <div className="mb-5 rounded-2xl border border-green-300 bg-green-50 p-5 text-green-950">
              <p className="font-black">Administrador creado</p>
              <p className="mt-2 text-sm">
                Guarda estas credenciales. La contraseña temporal sólo se muestra
                en este momento.
              </p>
              <dl className="mt-4 grid gap-2 rounded-xl bg-white p-4 text-sm">
                <div className="flex justify-between gap-4">
                  <dt>Código de usuario</dt>
                  <dd className="font-black">{createdCredentials.credentials.userCode}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Contraseña temporal</dt>
                  <dd className="font-mono font-black">
                    {createdCredentials.credentials.temporaryPassword}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {recoveryCredentials && (
            <div className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950">
              <p className="font-black">Acceso de administrador recuperado</p>
              <p className="mt-2 text-sm">
                Usa esta contraseña temporal para iniciar sesión. Después el sistema te obligará a crear una contraseña personal.
              </p>
              <dl className="mt-4 grid gap-2 rounded-xl bg-white p-4 text-sm">
                <div className="flex justify-between gap-4">
                  <dt>Código de usuario</dt>
                  <dd className="font-black">{recoveryCredentials.userCode}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>Contraseña temporal</dt>
                  <dd className="font-mono font-black">
                    {recoveryCredentials.temporaryPassword}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {error && (
            <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {error}
            </div>
          )}

          {bootstrapRequired ? (
            <form
              onSubmit={submitBootstrap}
              className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
            >
              <p className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                Configuración inicial
              </p>
              <h2 className="mt-1 text-xl font-black">Crear administrador</h2>
              <p className="mt-2 text-sm text-zinc-500">
                Este paso se realiza una sola vez. Luego los usuarios se crean desde
                el módulo administrativo.
              </p>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
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

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label>
                  <span className="text-sm font-bold">CI / documento</span>
                  <input
                    value={identityDocument}
                    onChange={(event) => setIdentityDocument(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                    maxLength={40}
                  />
                </label>
                <label>
                  <span className="text-sm font-bold">Teléfono</span>
                  <input
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                    maxLength={40}
                  />
                </label>
              </div>

              <label className="mt-4 block">
                <span className="text-sm font-bold">Correo</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                  maxLength={160}
                />
              </label>

              <label className="mt-4 block">
                <span className="text-sm font-bold">Clave privada de operaciones</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={opsAccessKey}
                  onChange={(event) => setOpsAccessKey(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-zinc-300 px-3 py-3 outline-none focus:border-zinc-950"
                  placeholder="Sólo para crear el primer administrador"
                />
              </label>

              <button
                type="submit"
                disabled={bootstrapBusy}
                className="mt-6 w-full rounded-xl bg-zinc-950 px-4 py-3 font-black text-white disabled:bg-zinc-400"
              >
                {bootstrapBusy ? "Creando..." : "Crear administrador inicial"}
              </button>
            </form>
          ) : (
            <form
              onSubmit={submitLogin}
              className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
            >
              <h2 className="text-xl font-black">Iniciar sesión</h2>

              <label className="mt-5 block">
                <span className="text-sm font-bold">Código de usuario</span>
                <input
                  autoFocus
                  value={userCode}
                  onChange={(event) => setUserCode(event.target.value.toUpperCase())}
                  className="mt-2 w-full rounded-xl border border-zinc-300 px-4 py-3 font-mono font-bold uppercase outline-none focus:border-zinc-950"
                  placeholder="CAJ-ABC123"
                  maxLength={10}
                />
              </label>

              <label className="mt-4 block">
                <span className="text-sm font-bold">Contraseña</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-zinc-300 px-4 py-3 outline-none focus:border-zinc-950"
                />
              </label>

              <button
                type="submit"
                disabled={loginBusy}
                className="mt-6 w-full rounded-xl bg-zinc-950 px-4 py-3 font-black text-white disabled:bg-zinc-400"
              >
                {loginBusy ? "Ingresando..." : "Ingresar al sistema"}
              </button>

              <button
                type="button"
                onClick={() => setRecoveryOpen((value) => !value)}
                className="mt-3 w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm font-bold"
              >
                Recuperar acceso de administrador
              </button>

              {recoveryOpen && (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm font-bold">Recuperación administrativa</p>
                  <p className="mt-1 text-xs text-zinc-600">
                    Requiere la clave privada de operaciones. Genera una nueva contraseña temporal y revoca las sesiones anteriores del administrador.
                  </p>
                  <label className="mt-3 block">
                    <span className="text-sm font-bold">Clave privada de operaciones</span>
                    <input
                      type="password"
                      autoComplete="off"
                      value={recoveryOpsKey}
                      onChange={(event) => setRecoveryOpsKey(event.target.value)}
                      className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-zinc-950"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={recoveryBusy}
                    onClick={() => void submitAdminRecovery()}
                    className="mt-3 w-full rounded-xl bg-amber-900 px-4 py-3 text-sm font-black text-white disabled:opacity-50"
                  >
                    {recoveryBusy ? "Recuperando..." : "Generar acceso temporal"}
                  </button>
                </div>
              )}
            </form>
          )}
        </div>
      </main>
    );
  }

  if (sessionUser.passwordChangeRequired) {
    return (
      <main className="min-h-screen bg-zinc-100 px-5 py-10 text-zinc-950">
        <div className="mx-auto max-w-lg">
          <div className="mb-6">
            <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
              Flash Commerce
            </p>
            <h1 className="mt-1 text-3xl font-black">Crea tu contraseña personal</h1>
            <p className="mt-2 text-sm text-zinc-500">
              {sessionUser.displayName} · {sessionUser.userCode}
            </p>
          </div>

          <form
            onSubmit={submitPasswordChange}
            className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
          >
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              La contraseña con la que ingresaste es temporal. Antes de usar Operaciones o Administración debes crear una contraseña personal.
            </div>

            {error && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
                {error}
              </div>
            )}

            <label className="mt-5 block">
              <span className="text-sm font-bold">Nueva contraseña</span>
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="mt-2 w-full rounded-xl border border-zinc-300 px-4 py-3 outline-none focus:border-zinc-950"
              />
            </label>

            <label className="mt-4 block">
              <span className="text-sm font-bold">Confirmar nueva contraseña</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="mt-2 w-full rounded-xl border border-zinc-300 px-4 py-3 outline-none focus:border-zinc-950"
              />
            </label>

            <p className="mt-3 text-xs text-zinc-500">
              Mínimo 10 caracteres, con al menos una letra y un número.
            </p>

            <button
              type="submit"
              disabled={passwordChangeBusy}
              className="mt-6 w-full rounded-xl bg-zinc-950 px-4 py-3 font-black text-white disabled:bg-zinc-400"
            >
              {passwordChangeBusy ? "Guardando..." : "Guardar mi contraseña"}
            </button>

            <button
              type="button"
              onClick={() => void handleLogout()}
              className="mt-3 w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm font-bold"
            >
              Cerrar sesión
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <>
      <div className="border-b border-zinc-800 bg-zinc-950 text-white">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm">
          <div>
            <span className="font-black">{sessionUser.displayName}</span>
            <span className="ml-2 text-zinc-400">
              {sessionUser.userCode} · {sessionUser.role}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {(sessionUser.role === "ADMIN" ||
              sessionUser.role === "MANAGER" ||
              sessionUser.role === "CASHIER") && (
              <a
                href="/tracking"
                className="rounded-lg border border-zinc-700 px-3 py-2 font-bold hover:bg-zinc-800"
              >
                Seguimiento
              </a>
            )}

            {(sessionUser.role === "ADMIN" || sessionUser.role === "MANAGER") && (
              <a
                href="/admin"
                className="rounded-lg border border-zinc-700 px-3 py-2 font-bold hover:bg-zinc-800"
              >
                Administración
              </a>
            )}
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="rounded-lg border border-zinc-700 px-3 py-2 font-bold hover:bg-zinc-800"
            >
              Cerrar sesión
            </button>
          </div>
        </div>
      </div>

      {(sessionUser.role === "ADMIN" || sessionUser.role === "MANAGER") && (
        <CommercialLinksPanel key={`${sessionUser.tenantCode}:${sessionUser.branchCode}:${sessionUser.sessionId}`} />
      )}
      <OpsOrdersClient
        tenantCode={sessionUser.tenantCode}
        branchCode={sessionUser.branchCode}
        operator={sessionUser}
      />
    </>
  );
}
