"use client";

import {
  FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  DriverActiveDelivery,
  DriverMapRoute,
  DriverSession,
  acceptDriverDelivery,
  changeDriverPassword,
  arriveDriverDelivery,
  collectDriverCodCash,
  deliverDriverDelivery,
  flashApiBase,
  getDriverActiveDeliveries,
  getDriverDeliveryMapRoute,
  getDriverMe,
  loginDriver,
  logoutDriver,
  pickupDriverDelivery,
  postDriverLocation,
  startDriverDelivery,
} from "@/lib/flash-api";

import DriverWorkspace from './driver-workspace';
import {FlashApiError} from '../../lib/flash-api';
import DriverTrackingMap from "./driver-tracking-map";
import { resolveDriverLocation, readTrackingIntent } from "@/lib/driver-tracking-state";
const TRACKING_INTENT_KEY = "flashdelivery.driver.trackingIntent.v1";

const SESSION_STORAGE_KEY =
  "flashdelivery.driver.accessToken";

function readSessionStorage(
  key: string,
): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(
  key: string,
  value: string,
): boolean {
  try {
    window.sessionStorage.setItem(
      key,
      value,
    );

    return true;
  } catch {
    return false;
  }
}

function removeSessionStorage(
  key: string,
): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // El cierre o invalidacion de sesion no debe fallar
    // solamente porque el navegador bloquee storage.
  }
}

const COD_COLLECTION_IDEMPOTENCY_KEY_PREFIX =
  "flashdelivery.driver.codCollectionIdempotency";
const TRACKING_SEND_INTERVAL_MS =
  10_000;

const TRACKING_ELIGIBLE_DELIVERY_STATUSES =
  new Set<string>([
    "ACCEPTED",
    "PICKED_UP",
    "EN_ROUTE",
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
  return session?.driver.displayName?.trim() || "Repartidor";
}

export function DriverSessionClient({
  tenantCode,
}: {
  tenantCode: string;
}) {
  const routeRequestInFlightRef = useRef(false);
  const [resumeDeliveryId, setResumeDeliveryId] = useState<string | null>(null);

  const [token, setToken] =
    useState("");

  const [driverCode, setDriverCode] =
    useState("");

  const [password, setPassword] =
    useState("");

  const [newPassword, setNewPassword] =
    useState("");

  const [confirmPassword, setConfirmPassword] =
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

  const mutationRef = useRef(false);
  const [actionNeedsRefresh, setActionNeedsRefresh] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [deliveryActionBusyId, setDeliveryActionBusyId] =
    useState<string | null>(null);
  const [selectedDeliveryId, setSelectedDeliveryId] =
    useState<string | null>(null);

  const [trackingActive, setTrackingActive] =
    useState(false);

  const [trackingMessage, setTrackingMessage] =
    useState("");

  const [latestDriverLocation, setLatestDriverLocation] =
    useState<{
      deliveryId: string;
      latitude: number;
      longitude: number;
      capturedAt: string;
    } | null>(null);

  const [driverMapRoute, setDriverMapRoute] =
    useState<DriverMapRoute | null>(null);

  const [driverMapMessage, setDriverMapMessage] =
    useState("");

  const geolocationWatchIdRef =
    useRef<number | null>(null);

  const trackingDeliveryIdRef =
    useRef<string | null>(null);

  const locationPostInFlightRef =
    useRef(false);

  const locationPostAbortControllerRef =
    useRef<AbortController | null>(null);

  const trackingSessionRef =
    useRef(0);

  const lastLocationSentAtRef =
    useRef(0);

  useEffect(() => {
    const storedToken = readSessionStorage(SESSION_STORAGE_KEY);

    if (!storedToken) {
      removeSessionStorage(TRACKING_INTENT_KEY);
      return;
    }

    const sessionToken = storedToken;
    let cancelled = false;

    async function restoreSession() {
      setLoading(true);

      try {
        const driverSession = await getDriverMe(sessionToken);

        if (cancelled) {
          return;
        }

        setToken(sessionToken);
        setSession(driverSession);

        if (!driverSession.driver.passwordChangeRequired) {
          const restoredDeliveries = await loadActiveDeliveries(sessionToken);
          if (cancelled) return;
          const intent = readTrackingIntent(
            readSessionStorage(TRACKING_INTENT_KEY), driverSession,
            restoredDeliveries ?? [],
          );
          if (intent) {
            setSelectedDeliveryId(intent);
            setResumeDeliveryId(intent);
          } else {
            removeSessionStorage(TRACKING_INTENT_KEY);
          }
        }
      } catch {
        removeSessionStorage(SESSION_STORAGE_KEY);
        removeSessionStorage(TRACKING_INTENT_KEY);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!resumeDeliveryId || selectedDeliveryId !== resumeDeliveryId || !session || !token) return;
    setResumeDeliveryId(null);
    if (geolocationWatchIdRef.current === null) startTracking();
  }, [resumeDeliveryId, selectedDeliveryId, session, token]);

  // Planned route is available before GPS; a failed read may be checked again safely.
  useEffect(() => {
    if (!token || !selectedDeliveryId) return;
    let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined;
    async function refreshRoute(){
      let retry=false;
      try{
        const snapshot=await getDriverDeliveryMapRoute(token,selectedDeliveryId!);
        if(cancelled)return;
        setDriverMapMessage('');
        setDriverMapRoute(current=>{
          if(current?.delivery.id===snapshot.delivery.id&&current.location&&(!snapshot.location||Date.parse(current.location.capturedAt)>Date.parse(snapshot.location.capturedAt)))return {...current,baseRoute:snapshot.baseRoute};
          return snapshot;
        });
        retry=snapshot.baseRoute?.status==='UNAVAILABLE';
      }catch{if(!cancelled){setDriverMapMessage('No se pudo cargar la ruta. Se volverá a consultar.');retry=true;}}
      if(!cancelled&&retry)timer=setTimeout(()=>void refreshRoute(),15000);
    }
    void refreshRoute();
    return()=>{cancelled=true;if(timer)clearTimeout(timer);};
  },[token,selectedDeliveryId]);

  function clearTrackingWatch() {
    trackingSessionRef.current += 1;

    locationPostAbortControllerRef.current?.abort();
    locationPostAbortControllerRef.current = null;
    locationPostInFlightRef.current = false;

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
    removeSessionStorage(TRACKING_INTENT_KEY);
    setResumeDeliveryId(null);
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
      trackingSessionRef.current += 1;
      locationPostAbortControllerRef.current?.abort();
      locationPostAbortControllerRef.current = null;
      locationPostInFlightRef.current = false;
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

    stopTracking(
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

    setLatestDriverLocation(null);
    setDriverMapRoute(null);
    setDriverMapMessage("");
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

    const trackingSession =
      trackingSessionRef.current;

    if (session) {
      writeSessionStorage(TRACKING_INTENT_KEY, JSON.stringify({
        tenantCode: session.tenant.code,
        driverCode: session.driver.code,
        deliveryId,
      }));
    }
    setTrackingActive(true);
    setTrackingMessage(
      "Seguimiento GPS iniciado. Esperando ubicacion del dispositivo.",
    );

    const watchId =
      navigator.geolocation.watchPosition(
        (position) => {
          if (
            trackingDeliveryIdRef.current !==
              deliveryId ||
            trackingSessionRef.current !==
              trackingSession
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

          const locationPostAbortController =
            new AbortController();

          locationPostAbortControllerRef.current =
            locationPostAbortController;

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
            {
              signal:
                locationPostAbortController.signal,
            },
          )
            .then((locationResult) => {
              if (
                trackingDeliveryIdRef.current ===
                  deliveryId &&
                trackingSessionRef.current ===
                  trackingSession
              ) {
                setLatestDriverLocation({
                  deliveryId,

                  latitude:
                    locationResult.location.latitude,

                  longitude:
                    locationResult.location.longitude,

                  capturedAt:
                    locationResult.location.capturedAt,
                });

                setTrackingMessage(
                  "Seguimiento GPS activo. Ubicacion enviada correctamente.",
                );

                // History/remaining route refresh is independent of GPS posting.
                // The server owns deviation hysteresis, provider cooldown and single-flight.
                if (!routeRequestInFlightRef.current) {
                  routeRequestInFlightRef.current = true;
                  void getDriverDeliveryMapRoute(candidate, deliveryId)
                    .then(nextRoute => {
                      if (trackingDeliveryIdRef.current === deliveryId && trackingSessionRef.current === trackingSession) {
                        setDriverMapRoute(nextRoute);
                        setDriverMapMessage("");
                      }
                    })
                    .catch(() => {
                      if (trackingDeliveryIdRef.current === deliveryId && trackingSessionRef.current === trackingSession) {
                        setDriverMapMessage("No se pudo actualizar el recorrido. Se conserva el ultimo disponible.");
                      }
                    })
                    .finally(() => { routeRequestInFlightRef.current = false; });
                }
              }
            })
            .catch((error) => {
              if (
                error instanceof DOMException &&
                error.name === "AbortError"
              ) {
                return;
              }

              if (
                trackingDeliveryIdRef.current ===
                  deliveryId &&
                trackingSessionRef.current ===
                  trackingSession
              ) {
                setTrackingMessage(
                  error instanceof Error
                    ? error.message
                    : "No se pudo enviar la ubicacion.",
                );
              }
            })
            .finally(() => {
              if (
                locationPostAbortControllerRef.current ===
                locationPostAbortController
              ) {
                locationPostAbortControllerRef.current =
                  null;

                locationPostInFlightRef.current =
                  false;
              }
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

            stopTracking(nextMessage);
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

      setActionNeedsRefresh(false);
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
      return nextDeliveries;
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

    const normalizedTenantCode = tenantCode.trim().toUpperCase();
    const normalizedDriverCode = driverCode.trim().toUpperCase();

    if (!normalizedTenantCode || !normalizedDriverCode || !password) {
      setMessage("Ingresa tu código de repartidor y contraseña.");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const login = await loginDriver(
        normalizedTenantCode,
        normalizedDriverCode,
        password,
      );

      const candidate = login.accessToken;
      const driverSession = await getDriverMe(candidate);

      setToken(candidate);
      setSession(driverSession);
      setPassword("");

      const sessionStored = writeSessionStorage(
        SESSION_STORAGE_KEY,
        candidate,
      );

      if (!driverSession.driver.passwordChangeRequired) {
        await loadActiveDeliveries(candidate);
      }

      setMessage(
        driverSession.driver.passwordChangeRequired
          ? "Acceso validado. Debes crear tu contraseña personal antes de iniciar entregas."
          : sessionStored
            ? "Acceso validado correctamente."
            : "Acceso validado. El navegador no permitió conservar la sesión.",
      );
    } catch (error) {
      stopTracking("");
      removeSessionStorage(SESSION_STORAGE_KEY);
      setToken("");
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

  async function savePersonalPassword(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    const candidate = token.trim();

    if (!candidate) {
      setMessage("No hay una sesión válida para cambiar la contraseña.");
      return;
    }

    if (newPassword.length < 10 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setMessage("La contraseña debe tener al menos 10 caracteres, una letra y un número.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setMessage("Las contraseñas no coinciden.");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      await changeDriverPassword(candidate, newPassword);
      const driverSession = await getDriverMe(candidate);

      setSession(driverSession);
      setNewPassword("");
      setConfirmPassword("");
      await loadActiveDeliveries(candidate);
      setMessage("Contraseña personal creada correctamente.");
      // CUSTOMER-QR-R3D.8.1: reconcile password-change state immediately.
      setSession((currentSession) =>
        currentSession
          ? {
              ...currentSession,
              passwordChangeRequired: false,
            }
          : currentSession,
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "No se pudo guardar la contraseña personal.",
      );
    } finally {
      setLoading(false);
    }
  }

  function getCodCollectionIdempotencyStorageKey(
    deliveryId: string,
  ) {
    return `${COD_COLLECTION_IDEMPOTENCY_KEY_PREFIX}:${deliveryId}`;
  }

  function getOrCreateCodCollectionIdempotencyKey(
    deliveryId: string,
  ) {
    const storageKey =
      getCodCollectionIdempotencyStorageKey(
        deliveryId,
      );

    const existingKey =
      window.sessionStorage.getItem(
        storageKey,
      );

    if (existingKey) {
      return existingKey;
    }

    const createdKey =
      window.crypto.randomUUID();

    window.sessionStorage.setItem(
      storageKey,
      createdKey,
    );

    return createdKey;
  }

  async function runDeliveryLifecycleAction(
    item: DriverActiveDelivery,
    action:
      | "accept"
      | "pickup"
      | "en-route"
      | "arrive",
  ) {
    const candidate =
      token.trim();

    if (
      !candidate ||
      deliveryActionBusyId !== null || mutationRef.current || actionNeedsRefresh
    ) {
      return;
    }

    mutationRef.current = true;
    setDeliveryActionBusyId(
      item.delivery.id,
    );

    setDeliveriesMessage("");

    try {
      if (action === "accept") {
        await acceptDriverDelivery(
          candidate,
          item.delivery.id,
        );
      }
      else if (action === "pickup") {
        await pickupDriverDelivery(
          candidate,
          item.delivery.id,
        );
      }
      else if (action === "en-route") {
        await startDriverDelivery(
          candidate,
          item.delivery.id,
        );
      }
      else {
        await arriveDriverDelivery(
          candidate,
          item.delivery.id,
        );
      }

      await loadActiveDeliveries(
        candidate,
      );

      setDeliveriesMessage(
        "Estado de la entrega actualizado correctamente.",
      );
    }
    catch (error) {
      if (!(error instanceof FlashApiError) || error.status >= 500 || error.status === 409 || error.status === 401 || error.status === 403) setActionNeedsRefresh(true);
      setDeliveriesMessage(
        error instanceof Error
          ? error.message
          : "No se pudo actualizar la entrega.",
      );
    }
    finally {
      mutationRef.current = false;
      setDeliveryActionBusyId(null);
    }
  }

  async function collectDeliveryCash(
    item: DriverActiveDelivery, enteredAmount: string,
  ) {
    const candidate =
      token.trim();

    const payment =
      item.payment;

    if (
      !candidate ||
      deliveryActionBusyId !== null || mutationRef.current || actionNeedsRefresh
    ) {
      return;
    }

    if (
      !payment ||
      !payment.cashCollectionRequired
    ) {
      setDeliveriesMessage(
        "Esta entrega no tiene un cobro contra entrega pendiente.",
      );

      return;
    }

    const cashReceivedAmount =
      Number(
        enteredAmount
          .trim()
          .replace(",", "."),
      );

    if (
      !Number.isFinite(
        cashReceivedAmount,
      ) ||
      cashReceivedAmount <
        payment.amount
    ) {
      setDeliveriesMessage(
        `El monto recibido debe ser igual o mayor a ${payment.currency} ${payment.amount.toFixed(
          2,
        )}.`,
      );

      return;
    }

    const storageKey =
      getCodCollectionIdempotencyStorageKey(
        item.delivery.id,
      );

    let idempotencyKey: string;
    try { idempotencyKey = getOrCreateCodCollectionIdempotencyKey(item.delivery.id); }
    catch { setDeliveriesMessage("No se pudo preparar el cobro de forma segura. Habilita el almacenamiento del navegador."); return; }

    mutationRef.current = true;
    setDeliveryActionBusyId(
      item.delivery.id,
    );

    setDeliveriesMessage("");

    try {
      await collectDriverCodCash(
        candidate,
        item.delivery.id,
        cashReceivedAmount,
        idempotencyKey,
      );

      window.sessionStorage.removeItem(
        storageKey,
      );

      await loadActiveDeliveries(
        candidate,
      );

      setDeliveriesMessage(
        "Cobro contra entrega registrado correctamente.",
      );
      return true;
    }
    catch (error) {
      if (!(error instanceof FlashApiError) || error.status >= 500 || error.status === 409 || error.status === 401 || error.status === 403) setActionNeedsRefresh(true);
      setDeliveriesMessage(
        error instanceof Error
          ? error.message
          : "No se pudo registrar el cobro.",
      );
    }
    finally {
      mutationRef.current = false;
      setDeliveryActionBusyId(null);
    }
  }

  async function completeDeliveryWithPod(
    item: DriverActiveDelivery, enteredPod: string,
  ) {
    const candidate =
      token.trim();

    if (
      !candidate ||
      deliveryActionBusyId !== null || mutationRef.current || actionNeedsRefresh
    ) {
      return;
    }

    if (
      item.payment?.cashCollectionRequired
    ) {
      setDeliveriesMessage(
        "Primero debes registrar el cobro contra entrega.",
      );

      return;
    }

    if (
      item.order.paymentStatus !== "PAID" &&
      item.order.paymentStatus !==
        "NOT_REQUIRED"
    ) {
      setDeliveriesMessage(
        "El pago de la entrega aun no esta listo para completar.",
      );

      return;
    }

    const pod =
      enteredPod.trim();

    if (!/^[0-9]{4}$/.test(pod)) {
      setDeliveriesMessage(
        "El codigo de entrega debe tener exactamente 4 digitos.",
      );

      return;
    }

    mutationRef.current = true;
    setDeliveryActionBusyId(
      item.delivery.id,
    );

    setDeliveriesMessage("");

    try {
      await deliverDriverDelivery(
        candidate,
        item.delivery.id,
        pod,
      );

      await loadActiveDeliveries(
        candidate,
      );

      setDeliveriesMessage(
        "Entrega completada correctamente.",
      );
      return true;
    }
    catch (error) {
      if (!(error instanceof FlashApiError) || error.status >= 500 || error.status === 409 || error.status === 401 || error.status === 403) setActionNeedsRefresh(true);
      setDeliveriesMessage(
        error instanceof Error
          ? error.message
          : "No se pudo completar la entrega.",
      );
    }
    finally {
      mutationRef.current = false;
      setDeliveryActionBusyId(null);
    }
  }
  async function closeSession() {
    if (mutationRef.current || loading) return;
    setLoading(true);
    try {
    const candidate = token.trim();

    if (candidate) {
      await logoutDriver(candidate);
    }

    stopTracking("");

    setLatestDriverLocation(null);
    setDriverMapRoute(null);
    setDriverMapMessage("");

    removeSessionStorage(
      SESSION_STORAGE_KEY,
    );

    setToken("");
    setPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setSession(null);
    setActiveDeliveries([]);
    setSelectedDeliveryId(null);
    setDeliveriesMessage("");
    setMessage("Sesión cerrada.");
    } catch { setMessage("No se pudo cerrar la sesión. Intenta de nuevo."); }
    finally { setLoading(false); }
  }

  const authenticated =
    session !== null;

  const selectedDelivery =
    selectedDeliveryId
      ? activeDeliveries.find(
          (item) =>
            item.delivery.id ===
            selectedDeliveryId,
        ) ?? null
      : null;

  const visibleMapRoute =
    driverMapRoute?.delivery.id ===
    selectedDeliveryId
      ? driverMapRoute
      : null;

  const visibleDriverLocation = resolveDriverLocation(
    selectedDeliveryId, latestDriverLocation, visibleMapRoute,
  );

  return <main className="driver-shell"><section className="driver-card">
    <header className="fp-header"><div className="fp-brand">Fast<span>Pay</span><small>Repartidor</small></div><p>{tenantCode === 'POLLO001' ? 'Mr. Pollo' : tenantCode}{selectedDelivery?.branchOrigin?.name ? ` · ${selectedDelivery.branchOrigin.name}` : ''}</p></header>
    {!authenticated ? <div className="fp-access"><h1>Bienvenido</h1><p className="fp-muted">Ingresa para gestionar tus entregas.</p><form className="fp-form" onSubmit={validateAccess}><label htmlFor="driver-code">Código de repartidor</label><input id="driver-code" value={driverCode} onChange={e=>setDriverCode(e.target.value.toUpperCase())} autoComplete="username" autoCapitalize="characters" autoCorrect="off" spellCheck={false} disabled={loading}/><label htmlFor="driver-password">Contraseña</label><div className="fp-password"><input id="driver-password" type={passwordVisible?'text':'password'} autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} disabled={loading}/><button type="button" disabled={loading} aria-label={passwordVisible?'Ocultar contraseña':'Mostrar contraseña'} onClick={()=>setPasswordVisible(v=>!v)}>{passwordVisible?'Ocultar':'Ver'}</button></div><button className="fp-primary" disabled={loading}>{loading?'Ingresando…':'Iniciar sesión'}</button></form><p className="fp-muted">Solicita tus credenciales al administrador.</p>{message&&<p className="fp-info" role="status">{message}</p>}</div>
    : session.driver.passwordChangeRequired ? <div className="fp-access"><span className="fp-badge">Primer ingreso</span><h1>Crea tu contraseña</h1><p>La contraseña entregada por Administración es temporal.</p><form className="fp-form" onSubmit={savePersonalPassword}><label htmlFor="driver-new-password">Nueva contraseña</label><input id="driver-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={e=>setNewPassword(e.target.value)} disabled={loading}/><label htmlFor="driver-confirm-password">Confirmar contraseña</label><input id="driver-confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} disabled={loading}/><button className="fp-primary" disabled={loading}>{loading?'Guardando…':'Guardar mi contraseña'}</button></form>{message&&<p className="fp-info" role="status">{message}</p>}<button className="fp-secondary" disabled={loading} onClick={()=>void closeSession()}>Cerrar sesión</button></div>
    : <DriverWorkspace session={session} items={activeDeliveries} loading={deliveriesLoading||loading} busyId={deliveryActionBusyId} needsRefresh={actionNeedsRefresh} message={deliveriesMessage} notice={message} selectedId={selectedDeliveryId} tracking={trackingActive} trackingMessage={trackingMessage} lastLocationAt={visibleDriverLocation?.capturedAt} onRefresh={()=>loadActiveDeliveries(token)} onAction={runDeliveryLifecycleAction} onCash={collectDeliveryCash} onDeliver={completeDeliveryWithPod} onSelect={selectDeliveryForTracking} onStartGPS={startTracking} onStopGPS={()=>stopTracking()} onLogout={closeSession} map={<>
       {selectedDelivery&&(visibleDriverLocation||selectedDelivery.branchOrigin)?<DriverTrackingMap tenantCode={session.tenant.code} deliveryId={selectedDelivery.delivery.id} currentLocation={visibleDriverLocation} branchOrigin={selectedDelivery.branchOrigin??null} destination={selectedDelivery.destination.location} baseRoute={visibleMapRoute?.baseRoute??null} journey={visibleMapRoute?.journey??null} navigation={visibleMapRoute?.navigation??null}/>:<p className="fp-info">Inicia el GPS para mostrar tu posición y la ruta.</p>}
       {visibleMapRoute?.navigation.distanceMeters!=null&&visibleMapRoute.navigation.durationSeconds!=null&&<div className="routeMetrics"><div><span>Distancia restante</span><strong>{(visibleMapRoute.navigation.distanceMeters/1000).toFixed(1)} km</strong></div><div><span>Tiempo restante estimado</span><strong>{Math.ceil(visibleMapRoute.navigation.durationSeconds/60)} min</strong></div></div>}{driverMapMessage&&<p className="fp-muted" role="status">{driverMapMessage}</p>}
     </>}/> }
  </section></main>;
}
