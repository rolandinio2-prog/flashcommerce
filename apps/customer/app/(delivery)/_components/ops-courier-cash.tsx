"use client";

import { FormEvent, useEffect, useState } from "react";

import { courierApi, type CashRemittance, type DriverCash, type DriverCashPending } from "../_lib/courier-api";

const input = "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm";
const label = "text-xs font-bold uppercase tracking-wide text-zinc-500";
const primary = "rounded-xl bg-zinc-950 px-5 py-3 text-sm font-bold text-white disabled:opacity-50";
const secondary = "rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-bold disabled:opacity-50";
const money = (n: number) => `Bs ${n.toFixed(2)}`;
const message = (e: unknown) => (e instanceof Error ? e.message : "No se pudo completar la operación.");
const when = (iso: string) => new Date(iso).toLocaleString("es-BO", { dateStyle: "short", timeStyle: "short" });

/** Courier cash on delivery: drivers hand in the cash they collected (rendición). */
export function CashRemittances() {
  const [drivers, setDrivers] = useState<DriverCash[] | null>(null);
  const [history, setHistory] = useState<CashRemittance[]>([]);
  const [selected, setSelected] = useState<DriverCashPending | null>(null);
  const [selectedName, setSelectedName] = useState("");
  const [received, setReceived] = useState("");
  const [notes, setNotes] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([courierApi.cashSummary(), courierApi.listRemittances()])
      .then(([s, h]) => {
        if (!alive) return;
        setDrivers(s.drivers);
        setHistory(h.remittances);
      })
      .catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, [revision]);

  async function open(d: DriverCash) {
    setError(null);
    setNotice(null);
    try {
      const pending = await courierApi.driverCash(d.driverId);
      setSelected(pending);
      setSelectedName(d.displayName);
      setReceived(pending.expectedAmount.toFixed(2));
      setNotes("");
    } catch (e) {
      setError(message(e));
    }
  }

  async function remit(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const r = await courierApi.remit({ driverId: selected.driverId, receivedAmount: Number(received), notes: notes || undefined });
      setNotice(
        r.differenceAmount === 0
          ? `Rendición registrada: ${money(r.receivedAmount)}.`
          : `Rendición registrada con diferencia de ${money(r.differenceAmount)} (esperado ${money(r.expectedAmount)}, recibido ${money(r.receivedAmount)}).`,
      );
      setSelected(null);
      setRevision((v) => v + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const diff =
    selected && received.trim() !== "" && Number.isFinite(Number(received))
      ? Math.round((Number(received) - selected.expectedAmount) * 100) / 100
      : null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="mb-2 text-lg font-black">Efectivo en manos de conductores</h2>
          <p className="mb-4 text-sm text-zinc-500">Lo que cada conductor cobró contra entrega y todavía no entregó a la empresa.</p>
          {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
          {notice && <p role="status" className="mb-3 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-900">{notice}</p>}
          {!drivers ? (
            <p className="text-zinc-500">Cargando…</p>
          ) : drivers.length === 0 ? (
            <p className="text-zinc-500">Ningún conductor tiene efectivo pendiente.</p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {drivers.map((d) => (
                <li key={d.driverId} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-bold">{d.displayName} <span className="text-xs text-zinc-400">{d.code}</span></p>
                    <p className="text-xs text-zinc-500">{d.collections} cobros · desde {when(d.oldestCollectedAt)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <b>{money(d.amount)}</b>
                    <button type="button" className={secondary} onClick={() => void open(d)}>Recibir</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected && (
          <form onSubmit={remit} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6">
            <h2 className="text-lg font-black">Rendición de {selectedName}</h2>
            <table className="w-full text-left text-sm">
              <thead className={label}>
                <tr><th className="py-2">Envío</th><th>Cliente</th><th>Destinatario</th><th>Cobrado</th><th className="text-right">Monto</th></tr>
              </thead>
              <tbody>
                {selected.collections.map((c) => (
                  <tr key={c.id} className="border-t border-zinc-100">
                    <td className="py-1.5 font-bold">#{c.orderNumber}</td>
                    <td>{c.clientName ?? "Sin cliente"}</td>
                    <td>{c.recipientName}</td>
                    <td>{when(c.collectedAt)}</td>
                    <td className="text-right">{money(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-sm">Esperado: <b className="text-xl">{money(selected.expectedAmount)}</b></p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className={label}>Efectivo recibido (Bs)</span>
                <input className={input} type="number" min={0} step="0.5" required aria-label="Efectivo recibido" value={received} onChange={(e) => setReceived(e.target.value)} />
              </label>
              <label className="block space-y-1">
                <span className={label}>Notas (opcional)</span>
                <input className={input} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
              </label>
            </div>
            {diff !== null && diff !== 0 && (
              <p className="text-sm text-amber-800">{diff < 0 ? `Faltan ${money(-diff)}` : `Sobran ${money(diff)}`}: quedará registrado como diferencia.</p>
            )}
            <div className="flex gap-2">
              <button type="submit" className={primary} disabled={busy}>Registrar rendición</button>
              <button type="button" className={secondary} onClick={() => setSelected(null)}>Cancelar</button>
            </div>
          </form>
        )}
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-black">Rendiciones recientes</h2>
        {history.length === 0 ? (
          <p className="text-zinc-500">Todavía no hay rendiciones.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className={label}>
              <tr><th className="py-2">Fecha</th><th>Conductor</th><th>Cobros</th><th className="text-right">Esperado</th><th className="text-right">Recibido</th><th className="text-right">Diferencia</th></tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-t border-zinc-100">
                  <td className="py-2">{h.settledAt ? when(h.settledAt) : h.status}</td>
                  <td>{h.driverName}</td>
                  <td>{h.collections}</td>
                  <td className="text-right">{money(h.expectedAmount)}</td>
                  <td className="text-right">{h.receivedAmount === null ? "—" : money(h.receivedAmount)}</td>
                  <td className={`text-right ${h.differenceAmount ? "font-bold text-amber-800" : ""}`}>{h.differenceAmount === null ? "—" : money(h.differenceAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
