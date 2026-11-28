"use client";

import { useEffect, useState } from "react";

import {
  type PaymentMethod,
  type PlatformProduct,
  type PriceList,
  type Subscription,
  type SubscriptionState,
  platformApi,
} from "../_lib/platform-api";
import { platformError } from "./platform-errors";

const input = "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none";
const primary = "rounded-lg bg-zinc-950 px-4 py-2 text-sm font-bold text-white disabled:opacity-50";
const secondary = "rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-bold disabled:opacity-50";
const bs = (n: number) => `Bs ${n.toFixed(2)}`;
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("es-BO", { day: "2-digit", month: "short", year: "numeric" });

export const STATE_LABEL: Record<SubscriptionState, string> = {
  ACTIVE: "Al día",
  DUE_SOON: "Por vencer",
  GRACE: "Vencida · en gracia",
  OVERDUE: "Vencida",
};
export const STATE_STYLE: Record<SubscriptionState, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-800",
  DUE_SOON: "bg-amber-100 text-amber-800",
  GRACE: "bg-orange-100 text-orange-800",
  OVERDUE: "bg-red-100 text-red-800",
};
const METHOD_LABEL: Record<PaymentMethod, string> = { CASH: "Efectivo", TRANSFER: "Transferencia", QR: "QR", OTHER: "Otro" };
const PRODUCT_LABEL: Record<PlatformProduct, string> = { COMMERCE: "Comercio", DELIVERY: "Delivery" };

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-bold uppercase tracking-wide text-zinc-500">{title}</span>
      {children}
    </label>
  );
}

/** Monthly price of each product; a business pays the sum of its active products. */
export function PriceEditor({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<PriceList | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    platformApi.getPrices().then(
      (p) => {
        setList(p);
        setDraft(Object.fromEntries(Object.entries(p.prices).map(([k, v]) => [k, String(v)])));
      },
      (e: unknown) => setError(platformError(e)),
    );
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await platformApi.setPrices(
        Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)])) as Record<PlatformProduct, number>,
      );
      setList(saved);
      setNotice("Precios guardados. Se aplican a los próximos pagos.");
    } catch (e) {
      setError(platformError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-black">Precios mensuales por producto</h2>
        <button type="button" className={secondary} onClick={onClose}>Cerrar</button>
      </div>
      {!list && !error && <p>Cargando…</p>}
      {list && (
        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(PRODUCT_LABEL) as PlatformProduct[]).map((p) => (
            <Field key={p} title={`${PRODUCT_LABEL[p]} (Bs por mes)`}>
              <input className={input} type="number" min={0} step="0.5" value={draft[p] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))} />
            </Field>
          ))}
        </div>
      )}
      <p className="text-xs text-zinc-500">Cada negocio paga la suma de sus productos activos, salvo que tenga un precio especial.</p>
      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button type="button" className={primary} disabled={busy || !list} onClick={() => void save()}>Guardar precios</button>
    </section>
  );
}

/** The business's subscription: start/edit, record payments, void the last one, or make it exempt. */
export function SubscriptionSection({ tenantId, onChanged }: { tenantId: string; onChanged: () => void }) {
  const [sub, setSub] = useState<Subscription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paidUntil, setPaidUntil] = useState("");
  const [override, setOverride] = useState("");
  const [months, setMonths] = useState("1");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("TRANSFER");
  const [reference, setReference] = useState("");
  const [voidReason, setVoidReason] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let alive = true;
    platformApi.getSubscription(tenantId).then(
      (s) => {
        if (!alive) return;
        setSub(s);
        setPaidUntil(s.paidUntil ?? "");
        setOverride(s.monthlyPriceOverride == null ? "" : String(s.monthlyPriceOverride));
        setAmount(String(s.monthlyAmount));
      },
      (e: unknown) => alive && setError(platformError(e)),
    );
    return () => {
      alive = false;
    };
  }, [tenantId]);

  async function run(action: () => Promise<Subscription>) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setSub(next);
      setPaidUntil(next.paidUntil ?? "");
      setAmount(String(next.monthlyAmount * Number(months || 1)));
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(platformError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!sub) return <div>{error ? <p role="alert" className="text-sm text-red-700">{error}</p> : <p className="text-sm">Cargando suscripción…</p>}</div>;
  const latest = sub.payments.find((p) => !p.voidedAt);
  const assignForm = (
    <form
      className="grid gap-3 rounded-xl bg-zinc-50 p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => platformApi.assignSubscription(tenantId, { paidUntil, monthlyPriceOverride: override === "" ? null : Number(override) }));
      }}
    >
      <Field title="Pagado hasta (incluido)"><input className={input} type="date" required value={paidUntil} onChange={(e) => setPaidUntil(e.target.value)} /></Field>
      <Field title="Precio especial por mes (opcional)"><input className={input} type="number" min={0} step="0.5" value={override} placeholder={`Normal: ${bs(sub.monthlyAmount)}`} onChange={(e) => setOverride(e.target.value)} /></Field>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" className={primary} disabled={busy}>{sub.exempt ? "Empezar a cobrar" : "Guardar"}</button>
        {!sub.exempt && <button type="button" className={secondary} onClick={() => setEditing(false)}>Cancelar</button>}
      </div>
    </form>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-black">Suscripción</h3>
        {sub.state && <span className={`rounded-full px-3 py-1 text-xs font-bold ${STATE_STYLE[sub.state]}`}>{STATE_LABEL[sub.state]}</span>}
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {sub.exempt ? (
        <>
          <p className="text-sm text-zinc-600">Sin suscripción: este negocio no se cobra ni se suspende solo. Asigna hasta qué fecha está pagado para empezar a cobrarle ({bs(sub.monthlyAmount)} por mes).</p>
          {assignForm}
        </>
      ) : (
        <>
          <dl className="grid grid-cols-[11rem_1fr] gap-y-1 text-sm">
            <dt className="font-bold">Pagado hasta</dt>
            <dd>{fmtDate(sub.paidUntil!)} {sub.daysLeft! >= 0 ? `(faltan ${sub.daysLeft} días)` : `(venció hace ${-sub.daysLeft!} días)`}</dd>
            <dt className="font-bold">Se suspende el</dt>
            <dd>{fmtDate(sub.suspendsOn!)} si no paga ({sub.graceDays} días de gracia)</dd>
            <dt className="font-bold">Cuota mensual</dt>
            <dd>{bs(sub.monthlyAmount)}{sub.monthlyPriceOverride != null ? " · precio especial" : ""}</dd>
          </dl>
          {editing ? assignForm : (
            <div className="flex gap-2">
              <button type="button" className={secondary} onClick={() => setEditing(true)}>Editar fecha o precio</button>
              <button type="button" className={secondary} disabled={busy} onClick={() => { if (window.confirm("¿Dejar este negocio sin suscripción? No se le cobrará ni suspenderá.")) void run(() => platformApi.exemptSubscription(tenantId)); }}>Quitar suscripción</button>
            </div>
          )}

          <form
            className="grid gap-3 rounded-xl border border-zinc-200 p-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => platformApi.recordPayment(tenantId, { months: Number(months), amount: Number(amount), method, reference: reference || undefined })).then(() => setReference(""));
            }}
          >
            <h4 className="font-black sm:col-span-2">Registrar pago</h4>
            <Field title="Meses que paga">
              <input className={input} type="number" min={1} max={24} required value={months} onChange={(e) => { setMonths(e.target.value); setAmount(String(sub.monthlyAmount * Number(e.target.value || 0))); }} />
            </Field>
            <Field title="Monto recibido (Bs)"><input className={input} type="number" min={0} step="0.5" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field title="Forma de pago">
              <select className={input} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
              </select>
            </Field>
            <Field title="Referencia (opcional)"><input className={input} value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} placeholder="N.º de transferencia o recibo" /></Field>
            <div className="sm:col-span-2"><button type="submit" className={primary} disabled={busy}>Registrar pago</button></div>
          </form>
        </>
      )}

      {sub.payments.length > 0 && (
        <div>
          <h4 className="mb-1 font-black">Pagos</h4>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-zinc-500"><tr><th className="py-1">Fecha</th><th>Monto</th><th>Meses</th><th>Forma</th><th>Cubre hasta</th><th /></tr></thead>
            <tbody>
              {sub.payments.map((p) => (
                <tr key={p.id} className={`border-t border-zinc-100 ${p.voidedAt ? "text-zinc-400 line-through" : ""}`}>
                  <td className="py-1">{new Date(p.createdAt).toLocaleDateString("es-BO")}</td>
                  <td>{bs(p.amount)}</td>
                  <td>{p.months}</td>
                  <td>{METHOD_LABEL[p.method]}{p.reference ? ` · ${p.reference}` : ""}</td>
                  <td>{fmtDate(p.paidUntilAfter)}</td>
                  <td className="no-underline">{p.voidedAt ? `Anulado: ${p.voidReason ?? ""}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {latest && !sub.exempt && (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Field title="Anular el último pago (motivo)"><input className={input} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} maxLength={300} placeholder="Ej.: monto equivocado" /></Field>
              <button type="button" className={secondary} disabled={busy || !voidReason.trim()} onClick={() => void run(() => platformApi.voidPayment(tenantId, latest.id, voidReason)).then(() => setVoidReason(""))}>Anular</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
