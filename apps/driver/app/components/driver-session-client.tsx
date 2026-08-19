"use client";

import {
  FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  DriverActiveDelivery,
  DriverSession,
  flashApiBase,
  getDriverActiveDeliveries,
  getDriverMe,
  postDriverLocation,
} from "@/lib/flash-api";

const SESSION_STORAGE_KEY =
  "flashdelivery.driver.accessToken";

const TRACKING_SEND_INTERVAL_MS =
  10_000;

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

  const [trackingActive, setTrackingActive] =
    useState(false);

  const [trackingMessage, setTrackingMessage] =
    useState("");

  const geolocationWatchIdRef =
    useRef<number | null>(null);

  const trackingDeliveryIdRef =
    useRef<string | null>(null);

  const locationPostInFlightRef =
    useRef(false);

  const lastLocationSentAtRef =
    useRef(0);

  useEffect(() => {
    const storedToken =
      window.sessionStorage.getItem(
        SESSION_STORAGE_KEY,
      );

    if (storedToken) {
      setToken(storedToken);
    }
  }, []);

  function clearTrackingWatch() {
    const watchId =
      geolocationWatchIdRef.current;

    if (
      watchId !== null &&
      typeof navigator !== "undefined" &&
      "geolocation" in navigator
    ) {
      navigator.geolocation.clearWatch(
        watchId,
      );
    }

    geolocationWatchIdRef.current = null;
    trackingDeliveryIdRef.current = null;
    lastLocationSentAtRef.current = 0;
  }

  function stopTracking(
    nextMessage =
      "Seguimiento GPS detenido.",
  ) {
    clearTrackingWatch();
    setTrackingActive(false);
    setTrackingMessage(nextMessage);
  }

  useEffect(() => {
    return () => {
      const watchId =
        geolocationWatchIdRef.current;

      if (
        watchId !== null &&
        typeof navigator !== "undefined" &&
        "geolocation" in navigator
      ) {
        navigator.geolocation.clearWatch(
          watchId,
        );
      }

      geolocationWatchIdRef.current = null;
      trackingDeliveryIdRef.current = null;
      lastLocationSentAtRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const trackedDeliveryId =
      trackingDeliveryIdRef.current;

    if (!trackedDeliveryId) {
      return;
    }

    const selectedStillEligible =
      selectedDeliveryId ===
        trackedDeliveryId &&
      activeDeliveries.some(
        (item) =>
          item.delivery.id ===
            trackedDeliveryId &&
          isTrackingEligibleDelivery(
            item,
          ),
      );

    if (selectedStillEligible) {
      return;
    }

    const watchId =
      geolocationWatchIdRef.current;

    if (
      watchId !== null &&
      typeof navigator !== "undefined" &&
      "geolocation" in navigator
    ) {
      navigator.geolocation.clearWatch(
        watchId,
      );
    }

    geolocationWatchIdRef.current = null;
    trackingDeliveryIdRef.current = null;
    lastLocationSentAtRef.current = 0;

    setTrackingActive(false);
    setTrackingMessage(
      "Seguimiento GPS detenido porque la entrega seleccionada cambio o dejo de ser elegible.",
    );
  }, [
    activeDeliveries,
    selectedDeliveryId,
  ]);

  function selectDeliveryForTracking(
    deliveryId: string,
  ) {
    if (
      trackingDeliveryIdRef.current &&
      trackingDeliveryIdRef.current !==
        deliveryId
    ) {
      stopTracking(
        "Seguimiento GPS detenido porque cambiaste de entrega.",
      );
    }

    setSelectedDeliveryId(
      deliveryId,
    );
  }

  function startTracking() {
    const candidate =
      token.trim();

    const deliveryId =
      selectedDeliveryId;

    if (!candidate) {
      setTrackingMessage(
        "No hay una sesion valida para iniciar el GPS.",
      );
      return;
    }

    if (!deliveryId) {
      setTrackingMessage(
        "Selecciona una entrega antes de iniciar el GPS.",
      );
      return;
    }

    const selectedDelivery =
      activeDeliveries.find(
        (item) =>
          item.delivery.id ===
          deliveryId,
      );

    if (
      !selectedDelivery ||
      !isTrackingEligibleDelivery(
        selectedDelivery,
      )
    ) {
      stopTracking(
        "La entrega seleccionada ya no permite seguimiento GPS.",
      );
      return;
    }

    if (
      typeof navigator === "undefined" ||
      !("geolocation" in navigator)
    ) {
      setTrackingMessage(
        "Este dispositivo no ofrece geolocalizacion compatible.",
      );
      return;
    }

    clearTrackingWatch();

    trackingDeliveryIdRef.current =
      deliveryId;

    setTrackingActive(true);
    setTrackingMessage(
      "Seguimiento GPS iniciado. Esperando ubicacion del dispositivo.",
    );

    const watchId =
      navigator.geolocation.watchPosition(
        (position) => {
          if (
            trackingDeliveryIdRef.current !==
            deliveryId
          ) {
            return;
          }

          const now =
            Date.now();

          if (
            locationPostInFlightRef.current
          ) {
            return;
          }

          if (
            lastLocationSentAtRef.current >
              0 &&
            now -
                lastLocationSentAtRef.current <
              TRACKING_SEND_INTERVAL_MS
          ) {
            return;
          }

          const capturedAt =
            new Date(
              position.timestamp,
            );

          if (
            !Number.isFinite(
              capturedAt.getTime(),
            )
          ) {
            setTrackingMessage(
              "El dispositivo entrego una fecha de ubicacion invalida.",
            );
            return;
          }

          const headingDegrees =
            typeof position.coords
              .heading === "number" &&
            Number.isFinite(
              position.coords.heading,
            )
              ? position.coords.heading
              : null;

          const speedMps =
            typeof position.coords
              .speed === "number" &&
            Number.isFinite(
              position.coords.speed,
            )
              ? position.coords.speed
              : null;

          const accuracyMeters =
            Number.isFinite(
              position.coords.accuracy,
            )
              ? position.coords.accuracy
              : null;

          locationPostInFlightRef.current =
            true;

          lastLocationSentAtRef.current =
            now;

          void postDriverLocation(
            candidate,
            deliveryId,
            {
              latitude:
                position.coords.latitude,

              longitude:
                position.coords.longitude,

              accuracyMeters,
              headingDegrees,
              speedMps,

              capturedAt:
                capturedAt.toISOString(),
            },
          )
            .then(() => {
              if (
                trackingDeliveryIdRef.current ===
                deliveryId
              ) {
                setTrackingMessage(
                  "Seguimiento GPS activo. Ubicacion enviada correctamente.",
                );
              }
            })
            .catch((error) => {
              if (
                trackingDeliveryIdRef.current ===
                deliveryId
              ) {
                setTrackingMessage(
                  error instanceof Error
                    ? error.message
                    : "No se pudo enviar la ubicacion.",
                );
              }
            })
            .finally(() => {
              locationPostInFlightRef.current =
                false;
            });
        },
        (error) => {
          if (
            trackingDeliveryIdRef.current !==
            deliveryId
          ) {
            return;
          }

          let nextMessage =
            "No se pudo obtener la ubicacion del dispositivo.";

          if (error.code === 1) {
            nextMessage =
              "Permiso de ubicacion denegado.";

            clearTrackingWatch();
            setTrackingActive(false);
          } else if (error.code === 2) {
            nextMessage =
              "La ubicacion del dispositivo no esta disponible.";
          } else if (error.code === 3) {
            nextMessage =
              "La ubicacion tardo demasiado en responder.";
          }

          setTrackingMessage(
            nextMessage,
          );
        },
        {
          enableHighAccuracy: true,
          maximumAge: 5_000,
          timeout: 15_000,
        },
      );

    geolocationWatchIdRef.current =
      watchId;
  }

  async function loadActiveDeliveries(
    accessToken: string,
  ) {
    const candidate =
      accessToken.trim();

    if (!candidate) {
      stopTracking("");
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

      const trackedDeliveryId =
        trackingDeliveryIdRef.current;

      if (
        trackedDeliveryId &&
        !eligibleDeliveries.some(
          (item) =>
            item.delivery.id ===
            trackedDeliveryId,
        )
      ) {
        stopTracking(
          "Seguimiento GPS detenido porque la entrega dejo de ser elegible.",
        );
      }

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
      stopTracking("");
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
      stopTracking("");
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
      stopTracking("");

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
    stopTracking("");

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
                            selectDeliveryForTracking(
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
                <div>
                  <p>
                    Entrega seleccionada para seguimiento.
                    {trackingActive
                      ? " GPS activo."
                      : " El GPS aun no se ha iniciado."}
                  </p>

                  <button
                    className="secondary-button"
                    type="button"
                    onClick={
                      trackingActive
                        ? () => stopTracking()
                        : startTracking
                    }
                  >
                    {trackingActive
                      ? "Detener GPS"
                      : "Iniciar GPS"}
                  </button>

                  {trackingMessage ? (
                    <p>
                      {trackingMessage}
                    </p>
                  ) : null}
                </div>
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