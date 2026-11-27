"use client";

import { useEffect, useState } from "react";

import AdminBranchOperationsPanel from './admin-branch-operations-panel';
import AdminBranchLocationPanel from './admin-branch-location-panel';

import AdminDevQrPaymentClient from "./admin-dev-qr-payment-client";

import {
  getStaffSession,
  logoutStaff,
  type StaffSessionUser,
} from "../../../../lib/flash-api";

interface AdminHomeClientProps {
  tenantCode: string;
  branchCode: string;
}

export default function AdminHomeClient({
  tenantCode,
  branchCode,
}: AdminHomeClientProps) {
  const [sessionUser, setSessionUser] = useState<StaffSessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const session = await getStaffSession();

        if (!cancelled) {
          if (session.user.passwordChangeRequired) {
            window.location.href = "/ops";
            return;
          }

          setSessionUser(session.user);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "No se pudo verificar la sesión administrativa",
          );
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
  }, []);

  async function handleLogout() {
    try {
      await logoutStaff();
    } catch {
      // Una sesión vencida ya está efectivamente cerrada.
    }

    window.location.href = "/ops";
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-zinc-100 px-6 py-16 text-zinc-950">
        <div className="mx-auto max-w-5xl rounded-2xl border border-zinc-200 bg-white p-8 text-center">
          Cargando administración...
        </div>
      </main>
    );
  }

  if (!sessionUser) {
    return (
      <main className="min-h-screen bg-zinc-100 px-6 py-16 text-zinc-950">
        <div className="mx-auto max-w-xl rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
            Flash Commerce
          </p>
          <h1 className="mt-1 text-3xl font-black">Administración</h1>
          <p className="mt-4 text-sm text-zinc-600">
            {error ?? "Necesitas iniciar sesión con un usuario autorizado."}
          </p>
          <a
            href="/ops"
            className="mt-6 inline-flex rounded-xl bg-zinc-950 px-4 py-3 text-sm font-black text-white"
          >
            Ir al acceso de operadores
          </a>
        </div>
      </main>
    );
  }

  const canManageOperators = sessionUser.role === "ADMIN";
  const canManageDrivers =
    sessionUser.role === "ADMIN" || sessionUser.role === "MANAGER";

  if (!canManageOperators && !canManageDrivers) {
    return (
      <main className="min-h-screen bg-zinc-100 px-6 py-16 text-zinc-950">
        <div className="mx-auto max-w-xl rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
            Flash Commerce
          </p>
          <h1 className="mt-1 text-3xl font-black">Administración</h1>
          <p className="mt-4 text-sm text-zinc-600">
            Tu rol {sessionUser.role} no tiene permisos administrativos.
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
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-6">
          <div>
            <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
              Flash Commerce
            </p>
            <h1 className="text-3xl font-black">Administración</h1>
            <p className="mt-1 text-sm text-zinc-500">
              {sessionUser.tenantCode} · {sessionUser.branchCode} · {sessionUser.displayName} · {sessionUser.role}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <a
              href="/ops"
              className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-black"
            >
              Operaciones / KDS
            </a>
            <a
              href="/tracking"
              className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-black"
            >
              Seguimiento
            </a>
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

      <section className="mx-auto max-w-6xl px-6 py-8">
        {canManageOperators && <AdminBranchOperationsPanel key={sessionUser.tenantCode+":"+sessionUser.branchCode} />}
        {canManageOperators && <AdminBranchLocationPanel tenantCode={sessionUser.tenantCode} branchCode={sessionUser.branchCode} />}

        <div className="mb-6">
          <h2 className="text-xl font-black">Usuarios y operadores del sistema</h2>
          <p className="mt-2 max-w-3xl text-sm text-zinc-600">
            Este módulo concentra la administración de las personas que trabajan en el sistema. Operaciones queda dedicado a pedidos, cocina, mesas y reservas.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          {canManageOperators && (
            <a
              href="/admin/operators"
              className="group rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-400 hover:shadow-md"
            >
              <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">
                Personal interno
              </p>
              <h3 className="mt-2 text-2xl font-black">Operadores</h3>
              <p className="mt-3 text-sm leading-6 text-zinc-600">
                Administradores, encargados, cajeros, cocina/KDS y meseros. Crea usuarios, entrega credenciales, regenera accesos y activa o desactiva cuentas.
              </p>
              <div className="mt-6 text-sm font-black group-hover:underline">
                Administrar operadores →
              </div>
            </a>
          )}

          {canManageDrivers && (
            <a
              href="/admin/drivers"
              className="group rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-400 hover:shadow-md"
            >
              <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">
                FlashDelivery
              </p>
              <h3 className="mt-2 text-2xl font-black">Repartidores</h3>
              <p className="mt-3 text-sm leading-6 text-zinc-600">
                Registra datos personales, teléfono, correo y placa del vehículo. Administra credenciales y disponibilidad para la asignación automática.
              </p>
              <div className="mt-6 text-sm font-black group-hover:underline">
                Administrar repartidores →
              </div>
            </a>
          )}
        </div>

        <AdminDevQrPaymentClient />
      </section>
    </main>
  );
}
