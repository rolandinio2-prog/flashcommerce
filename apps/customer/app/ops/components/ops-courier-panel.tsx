"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import AdminBranchMap, { type BranchPoint } from "../../admin/components/admin-branch-map";
import {
  courierApi,
  DELIVERY_STATUS_LABEL,
  type CourierClient,
  type CourierQuote,
  type CourierRate,
  type CourierRequestSummary,
} from "../../../lib/courier-api";
import { ClientStatements, DriverPayouts } from "./ops-courier-settlements";

type Section = "NEW" | "LIST" | "CLIENTS" | "RATES" | "STATEMENTS" | "PAYOUTS";

const input = "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm";
const label = "text-xs font-bold uppercase tracking-wide text-zinc-500";
const primary = "rounded-xl bg-zinc-950 px-5 py-3 text-sm font-bold text-white disabled:opacity-50";
const secondary = "rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-bold disabled:opacity-50";
const money = (n: number) => `Bs ${n.toFixed(2)}`;
const message = (e: unknown) => (e instanceof Error ? e.message : "No se pudo completar la operación.");

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className={label}>{title}</span>
      {children}
    </label>
  );
}

export default function OpsCourierPanel({ tenantCode, canManage }: { tenantCode: string; canManage: boolean }) {
  const [section, setSection] = useState<Section>("NEW");
  const [clients, setClients] = useState<CourierClient[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [clientsRevision, setClientsRevision] = useState(0);
  const loadClients = useCallback(async () => setClientsRevision((v) => v + 1), []);
  useEffect(() => {
    let alive = true;
    courierApi
      .listClients()
      .then((r) => alive && setClients(r.clients))
      .catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, [clientsRevision]);

  const tabs: [Section, string][] = [
    ["NEW", "Nuevo envío"],
    ["LIST", "Envíos"],
    ...(canManage
      ? ([
          ["CLIENTS", "Clientes"],
          ["RATES", "Tarifas"],
          ["STATEMENTS", "Cobros a clientes"],
          ["PAYOUTS", "Pagos a conductores"],
        ] as [Section, string][])
      : []),
  ];

  return (
    <section className="space-y-5">
      <nav className="flex flex-wrap gap-2 print:hidden">
        {tabs.map(([key, text]) => (
          <button
            key={key}
            type="button"
            aria-pressed={section === key}
            onClick={() => setSection(key)}
            className={`rounded-xl px-4 py-2 text-sm font-bold ${section === key ? "bg-zinc-950 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}
          >
            {text}
          </button>
        ))}
      </nav>
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700">{error}</p>}
      {section === "NEW" && <NewRequest tenantCode={tenantCode} clients={clients.filter((c) => c.status === "ACTIVE")} />}
      {section === "LIST" && <RequestList />}
      {section === "CLIENTS" && <Clients tenantCode={tenantCode} clients={clients} onChanged={loadClients} />}
      {section === "RATES" && <Rates clients={clients} />}
      {section === "STATEMENTS" && <ClientStatements clients={clients} />}
      {section === "PAYOUTS" && <DriverPayouts />}
    </section>
  );
}

// ------------------------------------------------------------------ new request

function NewRequest({ tenantCode, clients }: { tenantCode: string; clients: CourierClient[] }) {
  const [clientId, setClientId] = useState("");
  const [pickupName, setPickupName] = useState("");
  const [pickupPhone, setPickupPhone] = useState("");
  const [pickupAddress, setPickupAddress] = useState("");
  const [pickupPoint, setPickupPoint] = useState<BranchPoint | null>(null);
  const [editPickup, setEditPickup] = useState(false);
  const [recipientName, setRecipientName] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [addressText, setAddressText] = useState("");
  const [addressReference, setAddressReference] = useState("");
  const [destLat, setDestLat] = useState("");
  const [destLng, setDestLng] = useState("");
  const destination: BranchPoint | null =
    destLat.trim() && destLng.trim() && Number.isFinite(Number(destLat)) && Number.isFinite(Number(destLng))
      ? { latitude: Number(destLat), longitude: Number(destLng) }
      : null;
  const setDestination = (p: BranchPoint | null) => {
    setDestLat(p ? String(p.latitude) : "");
    setDestLng(p ? String(p.longitude) : "");
  };
  const [packageDescription, setPackageDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [quote, setQuote] = useState<CourierQuote | null>(null);
  const [feeOverride, setFeeOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ orderNumber: number; trackingToken: string; fee: number } | null>(null);

  function chooseClient(id: string) {
    setClientId(id);
    const c = clients.find((x) => x.id === id);
    setPickupName(c?.name ?? "");
    setPickupPhone(c?.phone ?? "");
    setPickupAddress(c?.pickupAddress ?? "");
    setPickupPoint(c?.pickupLatitude != null && c.pickupLongitude != null ? { latitude: c.pickupLatitude, longitude: c.pickupLongitude } : null);
    setQuote(null);
  }

  const pickupPayload = () => ({
    courierClientId: clientId || undefined,
    pickupLatitude: pickupPoint?.latitude,
    pickupLongitude: pickupPoint?.longitude,
  });

  async function runQuote() {
    if (!destination) return;
    setBusy(true);
    setError(null);
    try {
      setQuote(await courierApi.quote({ ...pickupPayload(), latitude: destination.latitude, longitude: destination.longitude }));
    } catch (e) {
      setQuote(null);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!destination) {
      setError("Marca el destino en el mapa.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await courierApi.createRequest({
        ...pickupPayload(),
        pickupName: pickupName || undefined,
        pickupPhone: pickupPhone || undefined,
        pickupAddress: pickupAddress || undefined,
        recipientName,
        recipientPhone,
        addressText,
        addressReference: addressReference || undefined,
        latitude: destination.latitude,
        longitude: destination.longitude,
        packageDescription: packageDescription || undefined,
        notes: notes || undefined,
        feeOverride: feeOverride === "" ? undefined : Number(feeOverride),
      });
      setCreated(result);
      setRecipientName("");
      setRecipientPhone("");
      setAddressText("");
      setAddressReference("");
      setDestination(null);
      setPackageDescription("");
      setNotes("");
      setQuote(null);
      setFeeOverride("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-5 rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-black">1. Recoger</h2>
        <Field title="Cliente">
          <select className={input} value={clientId} onChange={(e) => chooseClient(e.target.value)}>
            <option value="">Sin cliente (recoger en la sucursal)</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field title="Nombre en recogida"><input className={input} value={pickupName} onChange={(e) => setPickupName(e.target.value)} maxLength={120} /></Field>
          <Field title="Teléfono en recogida"><input className={input} value={pickupPhone} onChange={(e) => setPickupPhone(e.target.value)} maxLength={32} /></Field>
        </div>
        <Field title="Dirección de recogida"><input className={input} value={pickupAddress} onChange={(e) => setPickupAddress(e.target.value)} maxLength={500} /></Field>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-zinc-600">{pickupPoint ? `Punto: ${pickupPoint.latitude.toFixed(5)}, ${pickupPoint.longitude.toFixed(5)}` : "Punto: la sucursal"}</span>
          <button type="button" className={secondary} onClick={() => setEditPickup((v) => !v)}>{editPickup ? "Listo" : "Cambiar punto en el mapa"}</button>
        </div>
        {editPickup && <AdminBranchMap tenantCode={tenantCode} point={pickupPoint} onChange={(p) => { setPickupPoint(p); setQuote(null); }} disabled={busy} />}
        <h2 className="pt-2 text-lg font-black">3. Paquete</h2>
        <Field title="Qué se lleva"><input className={input} value={packageDescription} onChange={(e) => setPackageDescription(e.target.value)} maxLength={500} placeholder="Ej.: sobre, caja pequeña, medicamentos" /></Field>
        <Field title="Notas para el conductor"><textarea className={input} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
      </div>

      <div className="space-y-5 rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-black">2. Entregar</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field title="Destinatario"><input className={input} required value={recipientName} onChange={(e) => setRecipientName(e.target.value)} maxLength={120} /></Field>
          <Field title="Teléfono"><input className={input} required value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} maxLength={32} /></Field>
        </div>
        <Field title="Dirección"><input className={input} required value={addressText} onChange={(e) => setAddressText(e.target.value)} maxLength={500} /></Field>
        <Field title="Referencia"><input className={input} value={addressReference} onChange={(e) => setAddressReference(e.target.value)} maxLength={500} /></Field>
        <AdminBranchMap tenantCode={tenantCode} point={destination} onChange={(p) => { setDestination(p); setQuote(null); }} disabled={busy} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field title="Latitud destino">
            <input className={input} inputMode="decimal" aria-label="Latitud destino" value={destLat} onChange={(e) => { setDestLat(e.target.value); setQuote(null); }} />
          </Field>
          <Field title="Longitud destino">
            <input className={input} inputMode="decimal" aria-label="Longitud destino" value={destLng} onChange={(e) => { setDestLng(e.target.value); setQuote(null); }} />
          </Field>
        </div>

        <div className="rounded-xl bg-zinc-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className={label}>Tarifa</p>
              {quote ? (
                <p className="text-sm">
                  <b className="text-xl">{money(quote.fee)}</b> · {quote.zone.name} · {(quote.distanceMeters / 1000).toFixed(1)} km · {quote.eta.minMinutes}–{quote.eta.maxMinutes} min
                </p>
              ) : (
                <p className="text-sm text-zinc-500">Marca el destino y calcula la tarifa.</p>
              )}
            </div>
            <button type="button" className={secondary} disabled={!destination || busy} onClick={() => void runQuote()}>Calcular tarifa</button>
          </div>
          <div className="mt-3 max-w-xs">
            <Field title="Tarifa manual (opcional)"><input className={input} type="number" min={0} step="0.5" value={feeOverride} onChange={(e) => setFeeOverride(e.target.value)} placeholder={quote ? quote.fee.toFixed(2) : ""} /></Field>
          </div>
          <p className="mt-2 text-xs text-zinc-500">El cobro contra entrega para envíos estará disponible en la siguiente fase.</p>
        </div>

        {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        {created && (
          <p role="status" className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">
            Envío #{created.orderNumber} creado ({money(created.fee)}). Ya está en el monitor de delivery. ·{" "}
            <a className="font-bold underline" href={`/track/${created.trackingToken}`} target="_blank" rel="noreferrer">Ver seguimiento</a>
          </p>
        )}
        <button type="submit" className={primary} disabled={busy || !destination}>Crear envío</button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ list

function RequestList() {
  const [rows, setRows] = useState<CourierRequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const load = () => setRevision((v) => v + 1);
  useEffect(() => {
    let alive = true;
    courierApi
      .listRequests()
      .then((r) => {
        if (!alive) return;
        setRows(r.requests);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, [revision]);
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-black">Envíos recientes</h2>
        <button type="button" className={secondary} onClick={load}>Actualizar</button>
      </div>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {!rows ? (
        <p className="text-zinc-500">Cargando…</p>
      ) : rows.length === 0 ? (
        <p className="text-zinc-500">Todavía no hay envíos.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className={label}>
            <tr><th className="py-2">#</th><th>Cliente</th><th>Destinatario</th><th>Dirección</th><th>Tarifa</th><th>Estado</th><th>Creado</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.deliveryId} className="border-t border-zinc-100">
                <td className="py-2 font-bold">{r.orderNumber}</td>
                <td>{r.clientName ?? "—"}</td>
                <td>{r.recipientName}</td>
                <td className="max-w-xs truncate">{r.addressText}</td>
                <td>{money(r.fee)}</td>
                <td>{DELIVERY_STATUS_LABEL[r.deliveryStatus] ?? r.deliveryStatus}</td>
                <td>{new Date(r.createdAt).toLocaleString("es-BO", { dateStyle: "short", timeStyle: "short" })}</td>
                <td><a className="font-bold underline" href={`/track/${r.trackingToken}`} target="_blank" rel="noreferrer">Seguimiento</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ clients

const emptyClient = { code: "", name: "", phone: "", taxId: "", pickupAddress: "", pickupReference: "", billingMode: "PER_DELIVERY" as const };

function Clients({ tenantCode, clients, onChanged }: { tenantCode: string; clients: CourierClient[]; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<CourierClient | null>(null);
  const [form, setForm] = useState<typeof emptyClient | Omit<CourierClient, "id" | "status" | "pickupLatitude" | "pickupLongitude">>(emptyClient);
  const [point, setPoint] = useState<BranchPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function edit(c: CourierClient | null) {
    setEditing(c);
    setError(null);
    setForm(c ? { code: c.code, name: c.name, phone: c.phone ?? "", taxId: c.taxId ?? "", pickupAddress: c.pickupAddress ?? "", pickupReference: c.pickupReference ?? "", billingMode: c.billingMode } : emptyClient);
    setPoint(c?.pickupLatitude != null && c.pickupLongitude != null ? { latitude: c.pickupLatitude, longitude: c.pickupLongitude } : null);
  }
  const set = (k: keyof typeof emptyClient) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, pickupLatitude: point?.latitude ?? null, pickupLongitude: point?.longitude ?? null };
      if (editing) await courierApi.updateClient(editing.id, { ...body, code: undefined });
      else await courierApi.createClient(body);
      edit(null);
      await onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c: CourierClient) {
    try {
      await courierApi.updateClient(c.id, { status: c.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" });
      await onChanged();
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-black">Clientes del courier</h2>
        {clients.length === 0 ? (
          <p className="text-zinc-500">Agrega los comercios para los que reparte tu flota.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {clients.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-bold">{c.name} <span className="text-xs text-zinc-400">{c.code}</span></p>
                  <p className="text-xs text-zinc-500">{c.billingMode === "PERIODIC" ? "Liquidación periódica" : "Paga por envío"} · {c.status === "ACTIVE" ? "Activo" : "Inactivo"}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" className={secondary} onClick={() => edit(c)}>Editar</button>
                  <button type="button" className={secondary} onClick={() => void toggle(c)}>{c.status === "ACTIVE" ? "Desactivar" : "Activar"}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <form onSubmit={save} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-black">{editing ? `Editar ${editing.name}` : "Nuevo cliente"}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field title="Código"><input className={input} required={!editing} disabled={!!editing} value={form.code} onChange={set("code")} maxLength={32} placeholder="FARMA01" /></Field>
          <Field title="Nombre"><input className={input} required value={form.name} onChange={set("name")} maxLength={120} /></Field>
          <Field title="Teléfono"><input className={input} value={form.phone ?? ""} onChange={set("phone")} maxLength={32} /></Field>
          <Field title="NIT"><input className={input} value={form.taxId ?? ""} onChange={set("taxId")} maxLength={32} /></Field>
        </div>
        <Field title="Forma de cobro">
          <select className={input} value={form.billingMode} onChange={set("billingMode")}>
            <option value="PER_DELIVERY">Paga cada envío</option>
            <option value="PERIODIC">Liquidación semanal o mensual</option>
          </select>
        </Field>
        <Field title="Dirección de recogida"><input className={input} value={form.pickupAddress ?? ""} onChange={set("pickupAddress")} maxLength={500} /></Field>
        <Field title="Referencia"><input className={input} value={form.pickupReference ?? ""} onChange={set("pickupReference")} maxLength={500} /></Field>
        <AdminBranchMap tenantCode={tenantCode} point={point} onChange={setPoint} disabled={busy} />
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" className={primary} disabled={busy}>{editing ? "Guardar cambios" : "Crear cliente"}</button>
          {editing && <button type="button" className={secondary} onClick={() => edit(null)}>Cancelar</button>}
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ rates

function Rates({ clients }: { clients: CourierClient[] }) {
  const [rates, setRates] = useState<CourierRate[]>([]);
  const [scope, setScope] = useState("");
  const [form, setForm] = useState({ pricingMode: "ZONE", baseFee: "0", perKmFee: "0", minFee: "0" });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const formFor = (list: CourierRate[], id: string) => {
    const r = list.find((x) => (x.courierClientId ?? "") === id);
    return r
      ? { pricingMode: r.pricingMode, baseFee: String(r.baseFee), perKmFee: String(r.perKmFee), minFee: String(r.minFee) }
      : { pricingMode: "ZONE", baseFee: "0", perKmFee: "0", minFee: "0" };
  };
  const load = async () => {
    const list = (await courierApi.listRates()).rates;
    setRates(list);
    return list;
  };
  useEffect(() => {
    let alive = true;
    courierApi
      .listRates()
      .then((r) => {
        if (!alive) return;
        setRates(r.rates);
        setForm(formFor(r.rates, ""));
      })
      .catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, []);
  function chooseScope(id: string) {
    setScope(id);
    setForm(formFor(rates, id));
  }

  const nameOf = (id: string | null) => (id ? clients.find((c) => c.id === id)?.name ?? "Cliente" : "Tarifa general");

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await courierApi.setRate({
        courierClientId: scope || null,
        pricingMode: form.pricingMode as CourierRate["pricingMode"],
        baseFee: Number(form.baseFee),
        perKmFee: Number(form.perKmFee),
        minFee: Number(form.minFee),
      });
      setNotice("Tarifa guardada.");
      await load();
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="mb-2 text-lg font-black">Tarifas configuradas</h2>
        <p className="mb-4 text-sm text-zinc-500">Sin tarifa, se cobra el precio de la zona de cobertura. La tarifa de un cliente reemplaza a la general.</p>
        {rates.length === 0 ? <p className="text-zinc-500">Ninguna todavía.</p> : (
          <ul className="divide-y divide-zinc-100 text-sm">
            {rates.map((r) => (
              <li key={r.courierClientId ?? "default"} className="py-2">
                <b>{nameOf(r.courierClientId)}</b> ·{" "}
                {r.pricingMode === "ZONE" ? "Precio de la zona" : `Bs ${r.baseFee} + Bs ${r.perKmFee}/km (mínimo Bs ${r.minFee})`}
              </li>
            ))}
          </ul>
        )}
      </div>
      <form onSubmit={save} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6">
        <Field title="Aplicar a">
          <select className={input} value={scope} onChange={(e) => chooseScope(e.target.value)}>
            <option value="">Tarifa general</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field title="Cómo se calcula">
          <select className={input} value={form.pricingMode} onChange={(e) => setForm((f) => ({ ...f, pricingMode: e.target.value }))}>
            <option value="ZONE">Precio de la zona</option>
            <option value="DISTANCE">Por distancia</option>
          </select>
        </Field>
        {form.pricingMode === "DISTANCE" && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field title="Base (Bs)"><input className={input} type="number" min={0} step="0.5" value={form.baseFee} onChange={(e) => setForm((f) => ({ ...f, baseFee: e.target.value }))} /></Field>
            <Field title="Por km (Bs)"><input className={input} type="number" min={0} step="0.5" value={form.perKmFee} onChange={(e) => setForm((f) => ({ ...f, perKmFee: e.target.value }))} /></Field>
            <Field title="Mínimo (Bs)"><input className={input} type="number" min={0} step="0.5" value={form.minFee} onChange={(e) => setForm((f) => ({ ...f, minFee: e.target.value }))} /></Field>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {notice && <p role="status" className="text-sm text-green-800">{notice}</p>}
        <button type="submit" className={primary}>Guardar tarifa</button>
      </form>
    </div>
  );
}
