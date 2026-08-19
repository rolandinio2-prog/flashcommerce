"use client";

import {
  FormEvent,
  useEffect,
  useState,
} from "react";

import {
  DriverActiveDelivery,
  DriverSession,
  flashApiBase,
  getDriverActiveDeliveries,
  getDriverMe,
} from "@/lib/flash-api";

const SESSION_STORAGE_KEY =
  "flashdelivery.driver.accessToken";

const TRACKING_ELIGIBLE_DELIVERY_STATUSES =
  new Set<string>([
    "ACCEPTED",
    "PICKED_UP",
    "EN_ROUTE",
    "ARRIVED",
  ]);

function isTrackingEligibleDelivery(
  item: DriverActiveDelivery,
): boolean {
  return (
    item.assignment.status === "ACCEPTED" &&
    TRACKING_ELIGIBLE_DELIVERY_STATUSES.has(
      item.delivery.status,
    )
  );
}

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

  const [activeDeliveries, setActiveDeliveries] =
    useState<DriverActiveDelivery[]>([]);

  const [deliveriesLoading, setDeliveriesLoading] =
    useState(false);

  const [deliveriesMessage, setDeliveriesMessage] =
    useState("");

  const [selectedDeliveryId, setSelectedDeliveryId] =
    useState<string | null>(null);

  useEffect(() => {
    const storedToken =
      window.sessionStorage.getItem(
        SESSION_STORAGE_KEY,
      );

    if (storedToken) {
      setToken(storedToken);
    }
  }, []);

  async function loadActiveDeliveries(
    accessToken: string,
  ) {
    const candidate =
      accessToken.trim();

    if (!candidate) {
      setActiveDeliveries([]);
      setSelectedDeliveryId(null);
      setDeliveriesMessage("");
      return;
    }

    setDeliveriesLoading(true);
    setDeliveriesMessage("");

    try {
      const result =
        await getDriverActiveDeliveries(
          candidate,
        );

      const nextDeliveries =
        result.deliveries;

      setActiveDeliveries(
        nextDeliveries,
      );

      const eligibleDeliveries =
        nextDeliveries.filter(
          isTrackingEligibleDelivery,
        );

      setSelectedDeliveryId(
        (currentSelectedDeliveryId) => {
          if (
            currentSelectedDeliveryId &&
            eligibleDeliveries.some(
              (item) =>
                item.delivery.id ===
                currentSelectedDeliveryId,
            )
          ) {
            return currentSelectedDeliveryId;
          }

          if (eligibleDeliveries.length === 1) {
            return (
              eligibleDeliveries[0]?.delivery.id ??
              null
            );
          }

          return null;
        },
      );

      if (result.total === 0) {
        setDeliveriesMessage(
          "No tienes entregas activas en este momento.",
        );
      } else {
        const suffix =
          result.total === 1
            ? ""
            : "s";

        setDeliveriesMessage(
          `${result.total} entrega${suffix} activa${suffix}.`,
        );
      }
    } catch (error) {
      setActiveDeliveries([]);
      setSelectedDeliveryId(null);

      setDeliveriesMessage(
        error instanceof Error
          ? error.message
          : "No se pudieron cargar las entregas activas.",
      );
    } finally {
      setDeliveriesLoading(false);
    }
  }
  async function validateAccess(
    event?: FormEvent<HTMLFormElement>,
  ) {
    event?.preventDefault();

    const candidate =
      token.trim();

    if (!candidate) {
      setSession(null);
      setActiveDeliveries([]);
      setSelectedDeliveryId(null);
      setDeliveriesMessage("");
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

      await loadActiveDeliveries(
        candidate,
      );

      setMessage(
        "Acceso validado correctamente.",
      );
    } catch (error) {
      window.sessionStorage.removeItem(
        SESSION_STORAGE_KEY,
      );

      setSession(null);
      setActiveDeliveries([]);
      setSelectedDeliveryId(null);
      setDeliveriesMessage("");

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
    setActiveDeliveries([]);
    setSelectedDeliveryId(null);
    setDeliveriesMessage("");
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
                Entregas activas
              </p>

              <h2>
                {deliveriesLoading
                  ? "Actualizando..."
                  : `${activeDeliveries.length} activa${activeDeliveries.length === 1 ? "" : "s"}`}
              </h2>

              {deliveriesLoading ? (
                <p>
                  Consultando tus entregas...
                </p>
              ) : activeDeliveries.length === 0 ? (
                <p>
                  No hay entregas activas para mostrar.
                </p>
              ) : (
                <div>
                  {activeDeliveries.map((item) => (
                    <div
                      key={item.assignment.id}
                    >
                      <p>
                        <strong>
                          Pedido #{item.order.number}
                        </strong>
                      </p>

                      <p>
                        Estado: {item.delivery.status}
                      </p>

                      <p>
                        Cliente: {item.recipient.name}
                      </p>

                      <p>
                        Telefono: {item.recipient.phone}
                      </p>

                      <p>
                        Direccion: {item.destination.address}
                      </p>

                      {item.destination.reference ? (
                        <p>
                          Referencia: {item.destination.reference}
                        </p>
                      ) : null}

                      <p>
                        Asignacion: {item.assignment.status}
                      </p>

                      <p>
                        ETA: {item.eta.minMinutes !== null &&
                        item.eta.maxMinutes !== null
                          ? `${item.eta.minMinutes}-${item.eta.maxMinutes} min`
                          : "No disponible"}
                      </p>

                      {isTrackingEligibleDelivery(item) ? (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={
                            selectedDeliveryId ===
                            item.delivery.id
                          }
                          onClick={() =>
                            setSelectedDeliveryId(
                              item.delivery.id,
                            )
                          }
                        >
                          {selectedDeliveryId ===
                          item.delivery.id
                            ? "Seleccionada para seguimiento"
                            : "Seleccionar para seguimiento"}
                        </button>
                      ) : (
                        <p>
                          Seguimiento no disponible hasta aceptar la entrega.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {selectedDeliveryId ? (
                <p>
                  Entrega seleccionada para seguimiento.
                  El GPS aun no se ha iniciado.
                </p>
              ) : activeDeliveries.filter(
                  isTrackingEligibleDelivery,
                ).length > 1 ? (
                <p>
                  Selecciona una entrega para el seguimiento.
                </p>
              ) : null}

              {deliveriesMessage ? (
                <p>
                  {deliveriesMessage}
                </p>
              ) : null}

              <button
                className="secondary-button"
                type="button"
                disabled={deliveriesLoading}
                onClick={() =>
                  loadActiveDeliveries(token)
                }
              >
                {deliveriesLoading
                  ? "Actualizando..."
                  : "Actualizar entregas"}
              </button>
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