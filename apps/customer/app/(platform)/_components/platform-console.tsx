"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

import {
  type AdminPerson,
  type InitialAdmin,
  type PlatformOperator,
  type PlatformProduct,
  type TenantDetail,
  type TenantStatus,
  type TenantSummary,
  platformApi,
} from "../_lib/platform-api";

const input = "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none";
const primary = "rounded-lg bg-zinc-950 px-4 py-2 text-sm font-bold text-white disabled:opacity-50";
const secondary = "rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-bold disabled:opacity-50";
const card = "rounded-2xl border border-zinc-200 bg-white p-6";
const PRODUCT_LABEL: Record<PlatformProduct, string> = { COMMERCE: "Comercio", DELIVERY: "Delivery" };
const STATUS_LABEL: Record<TenantStatus, string> = { ACTIVE: "Activo", SUSPENDED: "Suspendido", INACTIVE: "Dado de baja" };
const ACTION_LABEL: Record<string, string> = {
  TENANT_CREATED: "Negocio creado",
  INITIAL_ADMIN_CREATED: "Administrador inicial creado",
  TENANT_STATUS_CHANGED: "Estado cambiado",
  TENANT_PRODUCTS_CHANGED: "Productos cambiados",
};

const message = (e: unknown) => (e instanceof Error ? e.message : "Ocurrió un error.");

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-bold uppercase tracking-wide text-zinc-500">{title}</span>
      {children}
    </label>
  );
}

/** Shows a one-time credential with the links the business will use. */
function Credentials({ admin, onClose }: { admin: InitialAdmin; onClose: () => void }) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const ops = `${origin.replace("//admin.", "//ops.")}/ops?tenantCode=${admin.tenantCode}&branchCode=${admin.branchCode}`;
  return (
    <div role="status" className="space-y-3 rounded-2xl border-2 border-amber-400 bg-amber-50 p-5">
      <h3 className="text-lg font-black">Acceso del administrador · {admin.displayName}</h3>
      <p className="text-sm">Copia estos datos ahora: la contraseña temporal no se vuelve a mostrar. Al entrar se le pedirá cambiarla.</p>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-bold">Negocio</dt><dd className="font-mono">{admin.tenantCode}</dd>
        <dt className="font-bold">Sucursal</dt><dd className="font-mono">{admin.branchCode}</dd>
        <dt className="font-bold">Usuario</dt><dd className="font-mono">{admin.userCode}</dd>
        <dt className="font-bold">Contraseña temporal</dt><dd className="font-mono">{admin.temporaryPassword}</dd>
        <dt className="font-bold">Entrar en</dt><dd className="break-all font-mono">{ops}</dd>
      </dl>
      <button type="button" className={secondary} onClick={onClose}>Ya los copié</button>
    </div>
  );
}

function AdminFields({ value, onChange }: { value: AdminPerson; onChange: (v: AdminPerson) => void }) {
  const set = (k: keyof AdminPerson) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field title="Nombre"><input className={input} required value={value.firstName} onChange={set("firstName")} maxLength={80} /></Field>
      <Field title="Apellido"><input className={input} required value={value.lastName} onChange={set("lastName")} maxLength={80} /></Field>
      <Field title="Carnet de identidad"><input className={input} value={value.identityDocument ?? ""} onChange={set("identityDocument")} maxLength={40} /></Field>
      <Field title="Teléfono"><input className={input} value={value.phone ?? ""} onChange={set("phone")} maxLength={40} /></Field>
      <Field title="Correo"><input className={input} type="email" value={value.email ?? ""} onChange={set("email")} maxLength={160} /></Field>
    </div>
  );
}

const emptyAdmin: AdminPerson = { firstName: "", lastName: "", identityDocument: "", phone: "", email: "" };

function NewTenant({ onCreated }: { onCreated: (t: TenantDetail, admin: InitialAdmin) => void }) {
  const [form, setForm] = useState({ code: "", name: "", branchCode: "CENTRAL", branchName: "Sucursal Central", timezone: "America/La_Paz" });
  const [products, setProducts] = useState<PlatformProduct[]>(["COMMERCE"]);
  const [admin, setAdmin] = useState<AdminPerson>(emptyAdmin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (p: PlatformProduct) => setProducts((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await platformApi.createTenant({ ...form, code: form.code.toUpperCase(), branchCode: form.branchCode.toUpperCase(), products, admin });
      setForm({ code: "", name: "", branchCode: "CENTRAL", branchName: "Sucursal Central", timezone: "America/La_Paz" });
      setAdmin(emptyAdmin);
      onCreated(created, created.initialAdmin);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`${card} space-y-4`}>
      <h2 className="text-lg font-black">Nuevo negocio</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field title="Código del negocio"><input className={input} required value={form.code} onChange={set("code")} maxLength={30} placeholder="FARMA01" /></Field>
        <Field title="Nombre del negocio"><input className={input} required value={form.name} onChange={set("name")} maxLength={150} /></Field>
        <Field title="Código de la sucursal"><input className={input} required value={form.branchCode} onChange={set("branchCode")} maxLength={30} /></Field>
        <Field title="Nombre de la sucursal"><input className={input} required value={form.branchName} onChange={set("branchName")} maxLength={150} /></Field>
        <Field title="Zona horaria"><input className={input} required value={form.timezone} onChange={set("timezone")} maxLength={60} /></Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs font-bold uppercase tracking-wide text-zinc-500">Productos contratados</legend>
        <div className="flex gap-4">
          {(Object.keys(PRODUCT_LABEL) as PlatformProduct[]).map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm font-bold">
              <input type="checkbox" checked={products.includes(p)} onChange={() => toggle(p)} /> {PRODUCT_LABEL[p]}
            </label>
          ))}
        </div>
      </fieldset>
      <h3 className="pt-2 font-black">Administrador del negocio</h3>
      <AdminFields value={admin} onChange={setAdmin} />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button type="submit" className={primary} disabled={busy || !products.length}>Crear negocio</button>
    </form>
  );
}

function TenantPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [admin, setAdmin] = useState<AdminPerson>(emptyAdmin);
  const [credentials, setCredentials] = useState<InitialAdmin | null>(null);

  useEffect(() => {
    let alive = true;
    platformApi.getTenant(id).then((t) => alive && setTenant(t)).catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, [id]);

  async function run(action: () => Promise<TenantDetail | void>) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      if (next) setTenant(next);
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (!tenant) return <section className={card}>{error ? <p role="alert">{error}</p> : <p>Cargando…</p>}</section>;
  const active = (Object.keys(tenant.products) as PlatformProduct[]).filter((p) => tenant.products[p]);
  const toggle = (p: PlatformProduct) => {
    const next = active.includes(p) ? active.filter((x) => x !== p) : [...active, p];
    if (!next.length) return setError("Un negocio necesita al menos un producto. Para cortarlo, suspéndelo.");
    void run(() => platformApi.setProducts(tenant.id, next));
  };
  const branch = tenant.branches[0];
  const needsAdmin = branch && branch.staffCount === 0;

  return (
    <section className={`${card} space-y-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black">{tenant.name}</h2>
          <p className="font-mono text-sm text-zinc-500">{tenant.code}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${tenant.status === "ACTIVE" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>
          {STATUS_LABEL[tenant.status]}
        </span>
      </div>
      {credentials && <Credentials admin={credentials} onClose={() => setCredentials(null)} />}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div>
        <h3 className="mb-2 font-black">Productos</h3>
        <div className="flex gap-4">
          {(Object.keys(PRODUCT_LABEL) as PlatformProduct[]).map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm font-bold">
              <input type="checkbox" checked={tenant.products[p]} disabled={busy} onChange={() => toggle(p)} /> {PRODUCT_LABEL[p]}
            </label>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 font-black">Sucursales</h3>
        <ul className="divide-y divide-zinc-100 text-sm">
          {tenant.branches.map((b) => (
            <li key={b.id} className="flex justify-between py-2">
              <span><b>{b.name}</b> <span className="font-mono text-zinc-500">{b.code}</span></span>
              <span className="text-zinc-500">{b.staffCount} usuarios · {b.timezone}</span>
            </li>
          ))}
        </ul>
        {branch && (
          <p className="mt-2 break-all text-xs text-zinc-500">
            Acceso del personal: <span className="font-mono">/ops?tenantCode={tenant.code}&amp;branchCode={branch.code}</span>
          </p>
        )}
      </div>

      {needsAdmin && (
        <form
          className="space-y-3 rounded-xl bg-zinc-50 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              setCredentials(await platformApi.createInitialAdmin(tenant.id, admin));
              setAdmin(emptyAdmin);
              return platformApi.getTenant(tenant.id);
            });
          }}
        >
          <h3 className="font-black">Este negocio no tiene administrador</h3>
          <AdminFields value={admin} onChange={setAdmin} />
          <button type="submit" className={primary} disabled={busy}>Crear administrador</button>
        </form>
      )}

      <div className="space-y-2">
        <h3 className="font-black">Estado</h3>
        <Field title="Motivo (obligatorio para suspender o dar de baja)">
          <input className={input} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Ej.: suscripción vencida" />
        </Field>
        <div className="flex flex-wrap gap-2">
          {tenant.status !== "ACTIVE" && (
            <button type="button" className={primary} disabled={busy} onClick={() => void run(() => platformApi.setStatus(tenant.id, "ACTIVE", reason))}>Reactivar</button>
          )}
          {tenant.status !== "SUSPENDED" && (
            <button type="button" className={secondary} disabled={busy || !reason.trim()} onClick={() => void run(() => platformApi.setStatus(tenant.id, "SUSPENDED", reason))}>Suspender</button>
          )}
          {tenant.status !== "INACTIVE" && (
            <button type="button" className={secondary} disabled={busy || !reason.trim()} onClick={() => void run(() => platformApi.setStatus(tenant.id, "INACTIVE", reason))}>Dar de baja</button>
          )}
        </div>
        <p className="text-xs text-zinc-500">Suspender cierra al instante las sesiones del personal y bloquea su acceso, la tienda y los pedidos. Reactivar lo devuelve todo.</p>
      </div>

      <div>
        <h3 className="mb-2 font-black">Historial</h3>
        <ul className="space-y-1 text-sm">
          {tenant.audit.map((e, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span>{ACTION_LABEL[e.action] ?? e.action}{typeof e.details?.reason === "string" ? ` · ${e.details.reason}` : ""}</span>
              <span className="shrink-0 text-zinc-500">{new Date(e.at).toLocaleString("es-BO")}{e.actor ? ` · ${e.actor}` : ""}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Tenants({ operator, onLogout }: { operator: PlatformOperator; onLogout: () => void }) {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<InitialAdmin | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => setRevision((r) => r + 1), []);

  useEffect(() => {
    let alive = true;
    platformApi.listTenants().then((r) => alive && setTenants(r.tenants)).catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, [revision]);

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">FlashCommerce Cloud</p>
          <h1 className="text-2xl font-black">Consola de plataforma</h1>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-zinc-600">{operator.displayName}</span>
          <button type="button" className={secondary} onClick={onLogout}>Salir</button>
        </div>
      </header>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-red-700">{error}</p>}
      {credentials && <Credentials admin={credentials} onClose={() => setCredentials(null)} />}
      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <section className={`${card} space-y-3`}>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-black">Negocios</h2>
            <button type="button" className={secondary} onClick={() => { setCreating(true); setSelected(null); }}>Nuevo</button>
          </div>
          <ul className="divide-y divide-zinc-100">
            {tenants.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  aria-pressed={selected === t.id}
                  onClick={() => { setSelected(t.id); setCreating(false); }}
                  className={`w-full py-3 text-left ${selected === t.id ? "font-black" : ""}`}
                >
                  <span className="block">{t.name}</span>
                  <span className="block text-xs text-zinc-500">
                    {t.code} · {STATUS_LABEL[t.status]} · {t.products.map((p) => PRODUCT_LABEL[p]).join(", ") || "sin productos"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <div>
          {creating && (
            <NewTenant
              onCreated={(t, admin) => {
                setCreating(false);
                setCredentials(admin);
                setSelected(t.id);
                reload();
              }}
            />
          )}
          {selected && <TenantPanel key={selected} id={selected} onChanged={reload} />}
          {!creating && !selected && <p className="text-zinc-500">Elige un negocio o crea uno nuevo.</p>}
        </div>
      </div>
    </main>
  );
}

function Login({ onDone }: { onDone: (op: PlatformOperator) => void }) {
  const [mode, setMode] = useState<"login" | "bootstrap">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [opsKey, setOpsKey] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") onDone((await platformApi.login(email, password)).operator);
      else {
        const r = await platformApi.bootstrap(opsKey, email, name);
        setCreated(r.temporaryPassword);
        setOpsKey("");
        setMode("login");
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md space-y-4 px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">FlashCommerce Cloud</p>
      <h1 className="text-2xl font-black">{mode === "login" ? "Consola de plataforma" : "Primer operador"}</h1>
      {created && (
        <p role="status" className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3 text-sm">
          Operador creado. Tu contraseña temporal es <b className="font-mono">{created}</b>. Cópiala: no se vuelve a mostrar.
        </p>
      )}
      <form onSubmit={submit} className={`${card} space-y-3`}>
        <Field title="Correo"><input className={input} type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {mode === "login" ? (
          <Field title="Contraseña"><input className={input} type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        ) : (
          <>
            <Field title="Tu nombre"><input className={input} required value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field title="Clave de operaciones del servidor"><input className={input} type="password" required autoComplete="off" value={opsKey} onChange={(e) => setOpsKey(e.target.value)} /></Field>
          </>
        )}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <button type="submit" className={primary} disabled={busy}>{mode === "login" ? "Entrar" : "Crear operador"}</button>
      </form>
      <button type="button" className="text-sm text-zinc-500 underline" onClick={() => { setMode(mode === "login" ? "bootstrap" : "login"); setError(null); }}>
        {mode === "login" ? "Primera vez: crear el primer operador" : "Ya tengo acceso"}
      </button>
    </main>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="mx-auto max-w-md space-y-4 px-6 py-16">
      <h1 className="text-2xl font-black">Cambia tu contraseña temporal</h1>
      <form
        className={`${card} space-y-3`}
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          platformApi.changePassword(current, next).then(onDone, (err: unknown) => setError(message(err))).finally(() => setBusy(false));
        }}
      >
        <Field title="Contraseña temporal"><input className={input} type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field title="Nueva contraseña (mínimo 12 caracteres)"><input className={input} type="password" required minLength={12} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <button type="submit" className={primary} disabled={busy}>Guardar</button>
      </form>
    </main>
  );
}

export default function PlatformConsole() {
  const [operator, setOperator] = useState<PlatformOperator | null | undefined>(undefined);
  const check = useCallback(() => {
    platformApi.me().then(
      (r) => setOperator(r.operator),
      // Any failure (401 or the console being unreachable) shows the sign-in form.
      () => setOperator(null),
    );
  }, []);
  useEffect(check, [check]);

  if (operator === undefined) return <main className="p-10 text-zinc-500">Cargando…</main>;
  if (!operator) return <Login onDone={setOperator} />;
  if (operator.passwordChangeRequired) return <ChangePassword onDone={check} />;
  return (
    <Tenants
      operator={operator}
      onLogout={() => {
        void platformApi.logout().finally(() => setOperator(null));
      }}
    />
  );
}
