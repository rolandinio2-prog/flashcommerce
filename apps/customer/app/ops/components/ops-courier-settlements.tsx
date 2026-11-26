"use client";

import { FormEvent, useEffect, useState } from "react";

import {
  courierApi,
  PAY_MODE_LABEL,
  PAYMENT_METHOD_LABEL,
  SETTLEMENT_STATUS_LABEL,
  type CourierClient,
  type CourierDriver,
  type DriverPayMode,
  type PaymentMethod,
  type PayoutDetail,
  type PayoutPreview,
  type PayoutSummary,
  type SettlementDelivery,
  type SettlementStatus,
  type StatementDetail,
  type StatementPreview,
  type StatementSummary,
} from "../../../lib/courier-api";

const input = "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm";
const label = "text-xs font-bold uppercase tracking-wide text-zinc-500";
const primary = "rounded-xl bg-zinc-950 px-5 py-3 text-sm font-bold text-white disabled:opacity-50";
const secondary = "rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-bold disabled:opacity-50";
const money = (n: number) => `Bs ${n.toFixed(2)}`;
const message = (e: unknown) => (e instanceof Error ? e.message : "No se pudo completar la operación.");
const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("es-BO");
const when = (iso: string) => new Date(iso).toLocaleString("es-BO", { dateStyle: "short", timeStyle: "short" });

function localDate(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function defaultPeriod() {
  const now = new Date();
  return { from: localDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: localDate(now) };
}

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className={label}>{title}</span>
      {children}
    </label>
  );
}

function StatusBadge({ status }: { status: SettlementStatus }) {
  const tone =
    status === "PAID" ? "bg-green-100 text-green-800" : status === "VOID" ? "bg-zinc-200 text-zinc-600" : "bg-amber-100 text-amber-900";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${tone}`}>{SETTLEMENT_STATUS_LABEL[status]}</span>;
}

function PeriodFields({ period, onChange }: { period: { from: string; to: string }; onChange: (p: { from: string; to: string }) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field title="Desde"><input className={input} type="date" required value={period.from} onChange={(e) => onChange({ ...period, from: e.target.value })} /></Field>
      <Field title="Hasta"><input className={input} type="date" required value={period.to} onChange={(e) => onChange({ ...period, to: e.target.value })} /></Field>
    </div>
  );
}

/** Fees vs cash collected for the client, and who owes whom. */
function NetSummary({ totalFee, collectedTotal, netAmount }: { totalFee: number; collectedTotal: number; netAmount: number }) {
  return (
    <dl className="grid gap-1 text-sm sm:max-w-sm">
      <div className="flex justify-between"><dt>Tarifas de envío</dt><dd>{money(totalFee)}</dd></div>
      <div className="flex justify-between"><dt>Cobrado para el cliente</dt><dd>{money(collectedTotal)}</dd></div>
      <div className="flex justify-between border-t border-zinc-200 pt-1 font-bold">
        <dt>{netAmount > 0 ? "A pagar al cliente" : netAmount < 0 ? "El cliente debe pagar" : "Saldo"}</dt>
        <dd>{money(Math.abs(netAmount))}</dd>
      </div>
    </dl>
  );
}

function DeliveriesTable({ rows, showClient, showAmount, showCollected }: { rows: SettlementDelivery[]; showClient?: boolean; showAmount?: boolean; showCollected?: boolean }) {
  if (!rows.length) return <p className="text-sm text-zinc-500">Sin entregas.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead className={label}>
        <tr>
          <th className="py-2">Envío</th>
          <th>Entregado</th>
          {showClient && <th>Cliente</th>}
          <th>Destinatario</th>
          <th className="text-right">Tarifa</th>
          {showCollected && <th className="text-right">Cobrado</th>}
          {showAmount && <th className="text-right">Pago</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.deliveryId} className="border-t border-zinc-100">
            <td className="py-1.5 font-bold">#{r.orderNumber}</td>
            <td>{when(r.deliveredAt)}</td>
            {showClient && <td>{r.clientName ?? (r.courierRequest ? "Sin cliente" : "Tienda")}</td>}
            <td>{r.recipientName}</td>
            <td className="text-right">{money(r.fee)}</td>
            {showCollected && <td className="text-right">{r.collected ? money(r.collected) : "—"}</td>}
            {showAmount && <td className="text-right">{money(r.amount ?? 0)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Pay (method + reference) / void / print controls for an issued settlement. */
function SettlementActions({
  status,
  onPay,
  onVoid,
}: {
  status: SettlementStatus;
  onPay: (method: PaymentMethod, reference: string) => Promise<void>;
  onVoid: () => Promise<void>;
}) {
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-3 print:hidden">
      {status === "ISSUED" && (
        <>
          <Field title="Forma de pago">
            <select className={input} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {(Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
            </select>
          </Field>
          <Field title="Referencia (opcional)"><input className={input} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} /></Field>
          <button type="button" className={primary} disabled={busy} onClick={() => void run(() => onPay(method, reference))}>Registrar pago</button>
          <button
            type="button"
            className={secondary}
            disabled={busy}
            onClick={() => window.confirm("¿Anular esta liquidación? Sus entregas quedarán libres para liquidarse de nuevo.") && void run(onVoid)}
          >
            Anular
          </button>
        </>
      )}
      <button type="button" className={secondary} onClick={() => window.print()}>Imprimir</button>
    </div>
  );
}

// ------------------------------------------------------------------ client statements

export function ClientStatements({ clients }: { clients: CourierClient[] }) {
  const [clientId, setClientId] = useState("");
  const [period, setPeriod] = useState(defaultPeriod);
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [list, setList] = useState<StatementSummary[] | null>(null);
  const [detail, setDetail] = useState<StatementDetail | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    courierApi
      .listStatements()
      .then((r) => alive && setList(r.statements))
      .catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, [revision]);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const runPreview = (event: FormEvent) => {
    event.preventDefault();
    void guard(async () => setPreview(await courierApi.previewStatement({ courierClientId: clientId, ...period })));
  };
  const create = () =>
    guard(async () => {
      setDetail(await courierApi.createStatement({ courierClientId: clientId, ...period }));
      setPreview(null);
      setRevision((v) => v + 1);
    });
  const open = (id: string) => guard(async () => setDetail(await courierApi.getStatement(id)));
  const after = async (p: Promise<StatementDetail>) => {
    setDetail(await p);
    setRevision((v) => v + 1);
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2 print:hidden">
        <form onSubmit={runPreview} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-lg font-black">Nueva liquidación de cliente</h2>
          <p className="text-sm text-zinc-500">Reúne los envíos entregados del cliente en el periodo que todavía no se le cobraron.</p>
          <Field title="Cliente">
            <select className={input} required value={clientId} onChange={(e) => { setClientId(e.target.value); setPreview(null); }}>
              <option value="">Elige un cliente</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.billingMode === "PERIODIC" ? " (periódico)" : ""}</option>)}
            </select>
          </Field>
          <PeriodFields period={period} onChange={(p) => { setPeriod(p); setPreview(null); }} />
          <button type="submit" className={secondary} disabled={busy || !clientId}>Ver envíos a liquidar</button>
          {preview && (
            <div className="space-y-3 rounded-xl bg-zinc-50 p-4">
              <p className="text-sm">{preview.deliveryCount} envíos</p>
              <NetSummary totalFee={preview.totalFee} collectedTotal={preview.collectedTotal} netAmount={preview.netAmount} />
              <DeliveriesTable rows={preview.deliveries} showCollected />
              <button type="button" className={primary} disabled={busy || preview.deliveryCount === 0} onClick={() => void create()}>Generar liquidación</button>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </form>

        <div className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-black">Liquidaciones de clientes</h2>
          {!list ? <p className="text-zinc-500">Cargando…</p> : list.length === 0 ? <p className="text-zinc-500">Todavía no hay liquidaciones.</p> : (
            <table className="w-full text-left text-sm">
              <thead className={label}><tr><th className="py-2">N.º</th><th>Cliente</th><th>Periodo</th><th className="text-right">Saldo</th><th>Estado</th></tr></thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id} className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50" onClick={() => void open(s.id)}>
                    <td className="py-2 font-bold">{s.number}</td>
                    <td>{s.clientName}</td>
                    <td>{day(s.periodFrom)} – {day(s.periodTo)}</td>
                    <td className="text-right" title={s.netAmount > 0 ? "A pagar al cliente" : "A cobrar al cliente"}>
                      {s.netAmount > 0 ? "−" : ""}{money(Math.abs(s.netAmount))}
                    </td>
                    <td><StatusBadge status={s.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {detail && (
        <article aria-label={`Liquidación ${detail.number}`} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-black">Liquidación N.º {detail.number} · {detail.client.name}</h2>
              <p className="text-sm text-zinc-500">
                Periodo {day(detail.periodFrom)} – {day(detail.periodTo)}{detail.client.taxId ? ` · NIT ${detail.client.taxId}` : ""} · emitida {when(detail.createdAt)}
              </p>
            </div>
            <StatusBadge status={detail.status} />
          </header>
          <p className="text-sm">{detail.deliveryCount} envíos</p>
          <NetSummary totalFee={detail.totalFee} collectedTotal={detail.collectedTotal} netAmount={detail.netAmount} />
          {detail.status === "PAID" && detail.paymentMethod && (
            <p className="text-sm text-green-800">Saldada el {when(detail.paidAt!)} · {PAYMENT_METHOD_LABEL[detail.paymentMethod]}{detail.paymentReference ? ` · ${detail.paymentReference}` : ""}</p>
          )}
          {detail.status === "VOID" ? <p className="text-sm text-zinc-500">Anulada: sus envíos quedaron libres para otra liquidación.</p> : <DeliveriesTable rows={detail.deliveries} showCollected />}
          <SettlementActions
            status={detail.status}
            onPay={(m, ref) => guard(() => after(courierApi.payStatement(detail.id, { paymentMethod: m, paymentReference: ref || undefined })))}
            onVoid={() => guard(() => after(courierApi.voidStatement(detail.id)))}
          />
        </article>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ driver payouts

const payValueLabel = (mode: DriverPayMode) =>
  mode === "PERCENT_OF_FEE" ? "Porcentaje (%)" : mode === "SALARY" ? "Sueldo del periodo (Bs)" : "Monto por entrega (Bs)";
const ruleText = (mode: DriverPayMode, value: number) =>
  mode === "NONE" ? "Sin regla" : mode === "PERCENT_OF_FEE" ? `${value}% de la tarifa` : mode === "SALARY" ? `Sueldo ${money(value)}` : `${money(value)} por entrega`;

function PayRules({ drivers, onChanged }: { drivers: CourierDriver[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<CourierDriver | null>(null);
  const [mode, setMode] = useState<DriverPayMode>("FIXED_PER_DELIVERY");
  const [value, setValue] = useState("0");
  const [error, setError] = useState<string | null>(null);

  function edit(d: CourierDriver) {
    setEditing(d);
    setMode(d.payMode === "NONE" ? "FIXED_PER_DELIVERY" : d.payMode);
    setValue(String(d.payValue));
    setError(null);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    try {
      await courierApi.setPayRule(editing.id, { payMode: mode, payValue: Number(value) });
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6">
      <h2 className="mb-4 text-lg font-black">Regla de pago por conductor</h2>
      <ul className="divide-y divide-zinc-100">
        {drivers.map((d) => (
          <li key={d.id} className="py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-bold">{d.displayName} <span className="text-xs text-zinc-400">{d.code}</span></p>
                <p className="text-xs text-zinc-500">{ruleText(d.payMode, d.payValue)}</p>
              </div>
              <button type="button" className={secondary} onClick={() => edit(d)}>Cambiar</button>
            </div>
            {editing?.id === d.id && (
              <form onSubmit={save} className="mt-3 grid gap-3 rounded-xl bg-zinc-50 p-4 sm:grid-cols-3">
                <Field title="Cómo se paga">
                  <select className={input} value={mode} onChange={(e) => setMode(e.target.value as DriverPayMode)}>
                    {(Object.keys(PAY_MODE_LABEL) as DriverPayMode[]).map((m) => <option key={m} value={m}>{PAY_MODE_LABEL[m]}</option>)}
                  </select>
                </Field>
                {mode !== "NONE" && (
                  <Field title={payValueLabel(mode)}>
                    <input className={input} type="number" min={0} max={mode === "PERCENT_OF_FEE" ? 100 : undefined} step="0.5" value={value} onChange={(e) => setValue(e.target.value)} />
                  </Field>
                )}
                <div className="flex items-end gap-2">
                  <button type="submit" className={primary}>Guardar</button>
                  <button type="button" className={secondary} onClick={() => setEditing(null)}>Cancelar</button>
                </div>
                {error && <p role="alert" className="text-sm text-red-700 sm:col-span-3">{error}</p>}
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DriverPayouts() {
  const [drivers, setDrivers] = useState<CourierDriver[]>([]);
  const [driverId, setDriverId] = useState("");
  const [period, setPeriod] = useState(defaultPeriod);
  const [preview, setPreview] = useState<PayoutPreview | null>(null);
  const [list, setList] = useState<PayoutSummary[] | null>(null);
  const [detail, setDetail] = useState<PayoutDetail | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([courierApi.listDrivers(), courierApi.listPayouts()])
      .then(([d, p]) => {
        if (!alive) return;
        setDrivers(d.drivers);
        setList(p.payouts);
      })
      .catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, [revision]);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const runPreview = (event: FormEvent) => {
    event.preventDefault();
    void guard(async () => setPreview(await courierApi.previewPayout({ driverId, ...period })));
  };
  const create = () =>
    guard(async () => {
      setDetail(await courierApi.createPayout({ driverId, ...period }));
      setPreview(null);
      setRevision((v) => v + 1);
    });
  const open = (id: string) => guard(async () => setDetail(await courierApi.getPayout(id)));
  const after = async (p: Promise<PayoutDetail>) => {
    setDetail(await p);
    setRevision((v) => v + 1);
  };
  const canCreate = preview && preview.payMode !== "NONE" && (preview.deliveryCount > 0 || preview.payMode === "SALARY");

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2 print:hidden">
        <div className="space-y-6">
          <form onSubmit={runPreview} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6">
            <h2 className="text-lg font-black">Nuevo pago a conductor</h2>
            <p className="text-sm text-zinc-500">Reúne las entregas completadas del conductor en el periodo que todavía no se le pagaron.</p>
            <Field title="Conductor">
              <select className={input} required value={driverId} onChange={(e) => { setDriverId(e.target.value); setPreview(null); }}>
                <option value="">Elige un conductor</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
              </select>
            </Field>
            <PeriodFields period={period} onChange={(p) => { setPeriod(p); setPreview(null); }} />
            <button type="submit" className={secondary} disabled={busy || !driverId}>Calcular pago</button>
            {preview && (
              <div className="space-y-3 rounded-xl bg-zinc-50 p-4">
                <p className="text-sm">
                  <b className="text-xl">{money(preview.amount)}</b> · {preview.deliveryCount} entregas · {ruleText(preview.payMode, preview.payValue)}
                </p>
                {preview.payMode === "NONE" && <p className="text-sm text-amber-800">Configura primero la regla de pago del conductor.</p>}
                <DeliveriesTable rows={preview.deliveries} showClient showAmount={preview.payMode !== "SALARY"} />
                <button type="button" className={primary} disabled={busy || !canCreate} onClick={() => void create()}>Generar pago</button>
              </div>
            )}
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          </form>
          <PayRules drivers={drivers} onChanged={() => setRevision((v) => v + 1)} />
        </div>

        <div className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-black">Pagos a conductores</h2>
          {!list ? <p className="text-zinc-500">Cargando…</p> : list.length === 0 ? <p className="text-zinc-500">Todavía no hay pagos.</p> : (
            <table className="w-full text-left text-sm">
              <thead className={label}><tr><th className="py-2">N.º</th><th>Conductor</th><th>Periodo</th><th className="text-right">Monto</th><th>Estado</th></tr></thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id} className="cursor-pointer border-t border-zinc-100 hover:bg-zinc-50" onClick={() => void open(p.id)}>
                    <td className="py-2 font-bold">{p.number}</td>
                    <td>{p.driverName}</td>
                    <td>{day(p.periodFrom)} – {day(p.periodTo)}</td>
                    <td className="text-right">{money(p.amount)}</td>
                    <td><StatusBadge status={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {detail && (
        <article aria-label={`Pago ${detail.number}`} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-black">Pago N.º {detail.number} · {detail.driver.name}</h2>
              <p className="text-sm text-zinc-500">Periodo {day(detail.periodFrom)} – {day(detail.periodTo)} · {ruleText(detail.payMode, detail.payValue)} · emitido {when(detail.createdAt)}</p>
            </div>
            <StatusBadge status={detail.status} />
          </header>
          <p><b className="text-2xl">{money(detail.amount)}</b> · {detail.deliveryCount} entregas · tarifas cobradas {money(detail.feeTotal)}</p>
          {detail.status === "PAID" && detail.paymentMethod && (
            <p className="text-sm text-green-800">Pagado el {when(detail.paidAt!)} · {PAYMENT_METHOD_LABEL[detail.paymentMethod]}{detail.paymentReference ? ` · ${detail.paymentReference}` : ""}</p>
          )}
          {detail.status === "VOID" ? <p className="text-sm text-zinc-500">Anulado: sus entregas quedaron libres para otro pago.</p> : <DeliveriesTable rows={detail.deliveries} showClient showAmount={detail.payMode !== "SALARY"} />}
          <SettlementActions
            status={detail.status}
            onPay={(m, ref) => guard(() => after(courierApi.payPayout(detail.id, { paymentMethod: m, paymentReference: ref || undefined })))}
            onVoid={() => guard(() => after(courierApi.voidPayout(detail.id)))}
          />
        </article>
      )}
    </div>
  );
}
