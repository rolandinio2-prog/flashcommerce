"use client";

import {
  type FormEvent,
  useEffect,
  useState,
} from "react";

import {
  getAdminDevQrPaymentStatus,
  simulateAdminDevQrPayment,
  type AdminDevQrPaymentResult,
} from "../../../../lib/flash-api";

export default function AdminDevQrPaymentClient() {
  const [checked, setChecked] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [orderNumber, setOrderNumber] =
    useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] =
    useState<string | null>(null);
  const [result, setResult] =
    useState<AdminDevQrPaymentResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    void getAdminDevQrPaymentStatus()
      .then((status) => {
        if (!cancelled) {
          setEnabled(status.enabled === true);
          setChecked(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEnabled(false);
          setChecked(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    const normalized = orderNumber.trim();

    if (!/^[1-9]\d{0,9}$/.test(normalized)) {
      setMessage(
        "Ingresa un numero de pedido valido.",
      );
      return;
    }

    const confirmed = window.confirm(
      `Confirmar pago QR ficticio para el pedido #${normalized}? Solo desarrollo BCP_QR Sandbox.`,
    );

    if (!confirmed) {
      return;
    }

    setBusy(true);
    setMessage(null);
    setResult(null);

    try {
      const response =
        await simulateAdminDevQrPayment(
          normalized,
        );

      setResult(response);
      setMessage(
        response.changed
          ? `Pedido #${response.order.number}: pago simulado correctamente.`
          : `Pedido #${response.order.number}: ya estaba pagado.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "No se pudo simular el pago QR.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!checked || !enabled) {
    return null;
  }

  return (
    <section className="mt-6">
      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-6 shadow-sm">
        <p className="text-xs font-black uppercase tracking-widest text-amber-800">
          Herramientas de desarrollo
        </p>
        <h2 className="mt-2 text-2xl font-black text-zinc-950">
          Simulacion de pagos QR
        </h2>
        <p className="mt-2 text-sm leading-6 text-amber-900">
          Solo BCP_QR Sandbox. No realiza debito bancario ni llama al BCP remoto.
        </p>

        <form
          onSubmit={submit}
          className="mt-5 flex flex-wrap items-end gap-3"
        >
          <label className="grid gap-2">
            <span className="text-sm font-bold text-zinc-800">
              Numero de pedido
            </span>
            <input
              value={orderNumber}
              onChange={(event) =>
                setOrderNumber(event.target.value)
              }
              inputMode="numeric"
              placeholder="Ej. 19"
              className="w-52 rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm outline-none focus:border-zinc-600"
            />
          </label>

          <button
            type="submit"
            disabled={busy}
            className="rounded-xl bg-zinc-950 px-5 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy
              ? "Procesando..."
              : "Simular pago QR"}
          </button>
        </form>

        {message ? (
          <p
            role="status"
            className="mt-4 text-sm font-bold text-zinc-800"
          >
            {message}
          </p>
        ) : null}

        {result ? (
          <div className="mt-4 rounded-xl bg-white p-4 text-sm text-zinc-700">
            Pedido:{" "}
            <strong>
              #{result.order.number}
            </strong>
            {" | "}
            Estado:{" "}
            <strong>
              {result.order.status}
            </strong>
            {" | "}
            Pago:{" "}
            <strong>
              {result.order.paymentStatus}
            </strong>
            {" | "}
            Proveedor:{" "}
            <strong>
              {result.payment.provider}
            </strong>
          </div>
        ) : null}
      </div>
    </section>
  );
}