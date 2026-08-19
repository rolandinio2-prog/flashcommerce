"use client";

import {
  FormEvent,
  useEffect,
  useState,
} from "react";

import {
  DriverSession,
  flashApiBase,
  getDriverMe,
} from "@/lib/flash-api";

const SESSION_STORAGE_KEY =
  "flashdelivery.driver.accessToken";

function getDriverLabel(
  session: DriverSession | null,
): string {
  if (!session) {
    return "Repartidor";
  }

  const candidates = [
    session.displayName,
    session.driverName,
    session.name,
    session.code,
  ];

  for (const value of candidates) {
    if (
      typeof value === "string" &&
      value.trim().length > 0
    ) {
      return value.trim();
    }
  }

  return "Repartidor";
}

export function DriverSessionClient() {
  const [token, setToken] =
    useState("");

  const [session, setSession] =
    useState<DriverSession | null>(null);

  const [loading, setLoading] =
    useState(false);

  const [message, setMessage] =
    useState("");

  useEffect(() => {
    const storedToken =
      window.sessionStorage.getItem(
        SESSION_STORAGE_KEY,
      );

    if (storedToken) {
      setToken(storedToken);
    }
  }, []);

  async function validateAccess(
    event?: FormEvent<HTMLFormElement>,
  ) {
    event?.preventDefault();

    const candidate =
      token.trim();

    if (!candidate) {
      setSession(null);
      setMessage(
        "Ingresa el token de acceso asignado al repartidor.",
      );
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const driverSession =
        await getDriverMe(candidate);

      window.sessionStorage.setItem(
        SESSION_STORAGE_KEY,
        candidate,
      );

      setSession(driverSession);
      setMessage(
        "Acceso validado correctamente.",
      );
    } catch (error) {
      window.sessionStorage.removeItem(
        SESSION_STORAGE_KEY,
      );

      setSession(null);

      setMessage(
        error instanceof Error
          ? error.message
          : "No se pudo validar el acceso.",
      );
    } finally {
      setLoading(false);
    }
  }

  function closeSession() {
    window.sessionStorage.removeItem(
      SESSION_STORAGE_KEY,
    );

    setToken("");
    setSession(null);
    setMessage("Sesion cerrada.");
  }

  const authenticated =
    session !== null;

  return (
    <main className="driver-shell">
      <section className="driver-card">
        <div className="brand-row">
          <div className="brand-mark">
            FD
          </div>

          <div>
            <p className="eyebrow">
              FlashDelivery
            </p>

            <h1>
              App del repartidor
            </h1>
          </div>
        </div>

        {!authenticated ? (
          <>
            <p className="intro">
              Ingresa el token asignado para validar
              tu sesion de reparto.
            </p>

            <form
              className="access-form"
              onSubmit={validateAccess}
            >
              <label htmlFor="driver-token">
                Token de acceso
              </label>

              <input
                id="driver-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) =>
                  setToken(event.target.value)
                }
                placeholder="Token del repartidor"
                disabled={loading}
              />

              <button
                type="submit"
                disabled={loading}
              >
                {loading
                  ? "Validando..."
                  : "Validar acceso"}
              </button>
            </form>

            <p className="security-note">
              El token se conserva solamente
              durante esta sesion del navegador.
            </p>
          </>
        ) : (
          <div className="session-panel">
            <div className="status-row">
              <span className="status-dot" />

              <div>
                <p className="status-label">
                  Sesion activa
                </p>

                <strong>
                  {getDriverLabel(session)}
                </strong>
              </div>
            </div>

            <div className="feature-placeholder">
              <p className="eyebrow">
                Proximo paso
              </p>

              <h2>
                Entrega y ubicacion
              </h2>

              <p>
                La sesion ya esta preparada.
                El seguimiento GPS se incorporara
                en el siguiente gate.
              </p>
            </div>

            <button
              className="secondary-button"
              type="button"
              onClick={closeSession}
            >
              Cerrar sesion
            </button>
          </div>
        )}

        {message ? (
          <p
            className={
              authenticated
                ? "message success"
                : "message"
            }
          >
            {message}
          </p>
        ) : null}

        <p className="api-hint">
          API configurada: {flashApiBase}
        </p>
      </section>
    </main>
  );
}