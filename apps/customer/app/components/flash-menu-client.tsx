"use client";

import { useEffect, useState } from "react";
import QRCode from "react-qr-code";

import {
  addCartItem,
  autocompleteDeliveryAddress,
  createCart,
  createOrder,
  createQrPayment,
  getCart,
  getDiningTableContext,
  getDiningTables,
  getOrderDeliveryLocation,
  getOrderPayment,
  getOrderTracking,
  removeCartItem,
  resolveDeliveryAddress,
  updateCartItem,
  type CreatedOrder,
  type DeliveryAddressLocation,
  type DeliveryAddressSuggestion,
  type DiningTable,
  type DiningTableContextResponse,
  type FlashCart,
  type FlashOrderFulfillmentInput,
  type FlashOrderType,
  type OrderPaymentStatus,
  type PaymentAttempt,
  type PublicDeliveryLocation,
  type TableReservation,
} from "../../lib/flash-api";

import TableReservationClient from "./table-reservation-client";

// =========================================================
// FLASH MENU - TIPOS LOCALES
// =========================================================

interface Product {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  price: number;
  currency: string;
  available: boolean;
  availableQuantity: number | null;
  preparationMinutes: number;
}

interface Category {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  products: Product[];
}

interface Catalog {
  tenant: {
    code: string;
    name: string;
  };

  branch: {
    code: string;
    name: string;
    timezone: string;
  };

  categories: Category[];
}

interface CartItem {
  product: Product;
  quantity: number;
}

interface FlashMenuClientProps {
  catalog: Catalog;
}

// =========================================================
// ESTADOS DEL PEDIDO - TEXTOS PARA EL CLIENTE
//
// El backend seguirá trabajando con:
// PENDING, CONFIRMED, PREPARING, READY, etc.
//
// Aquí solamente traducimos esos estados técnicos
// a textos amigables para mostrar en pantalla.
// =========================================================

function getCustomerOrderStatusLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Pedido recibido";

    case "CONFIRMED":
      return "Pedido confirmado";

    case "PREPARING":
      return "En preparación";

    case "READY":
      return "Listo";

    case "COMPLETED":
      return "Pedido entregado";

    case "CANCELLED":
      return "Pedido cancelado";

    default:
      return status;
  }
}

function getCustomerOrderStatusMessage(
  status: string,
  paymentStatus?: OrderPaymentStatus,
): string {
  switch (status) {
    case "PENDING":
      if (
        paymentStatus === "PENDING" ||
        paymentStatus === "AWAITING_CONFIRMATION"
      ) {
        return "Tu pedido empezará a prepararse cuando confirmemos el pago.";
      }

      return "Recibimos tu pedido y estamos esperando confirmarlo.";

    case "CONFIRMED":
      return "Tu pedido fue confirmado por el restaurante.";

    case "PREPARING":
      return "Estamos preparando tu pedido.";

    case "READY":
      return "Tu pedido está listo.";

    case "COMPLETED":
      return "Tu pedido fue completado.";

    case "CANCELLED":
      return "Este pedido fue cancelado.";

    default:
      return "";
  }
}

function getCustomerPaymentStatusLabel(status: OrderPaymentStatus): string {
  switch (status) {
    case "NOT_REQUIRED":
      return "No requerido";

    case "PENDING":
      return "Pendiente";

    case "AWAITING_CONFIRMATION":
      return "Esperando confirmación";

    case "PAID":
      return "Pagado";

    case "FAILED":
      return "Fallido";

    case "EXPIRED":
      return "Expirado";

    case "CANCELLED":
      return "Cancelado";

    case "REFUND_PENDING":
      return "Reembolso pendiente";

    case "REFUNDED":
      return "Reembolsado";

    case "REVIEW_REQUIRED":
      return "Revisión requerida";
  }
}

// =========================================================
// TRACKING VISUAL DEL PEDIDO
//
// Define las etapas normales que verá el cliente.
// CANCELLED se maneja como un estado especial.
// =========================================================

const CUSTOMER_ORDER_STEPS = [
  {
    status: "PENDING",
    label: "Pedido recibido",
  },
  {
    status: "CONFIRMED",
    label: "Pedido confirmado",
  },
  {
    status: "PREPARING",
    label: "En preparación",
  },
  {
    status: "READY",
    label: "Listo",
  },
  {
    status: "COMPLETED",
    label: "Entregado",
  },
] as const;

// =========================================================
// POSICIÓN ACTUAL DEL PEDIDO
//
// Convierte el estado actual en la posición correspondiente
// dentro de la línea de progreso.
// =========================================================

function getCustomerOrderStepIndex(status: string): number {
  return CUSTOMER_ORDER_STEPS.findIndex((step) => step.status === status);
}

export default function FlashMenuClient({ catalog }: FlashMenuClientProps) {
  // =========================================================
  // 1. ESTADO DEL CARRITO
  // =========================================================

  const [cart, setCart] = useState<Record<string, CartItem>>({});

  const [cartToken, setCartToken] = useState<string | null>(null);

  const [cartReady, setCartReady] = useState(false);

  const [cartBusy, setCartBusy] = useState(false);

  const [cartError, setCartError] = useState<string | null>(null);

  const [cartOpen, setCartOpen] = useState(false);

  // =========================================================
  // 2. ESTADO DEL CHECKOUT / PEDIDO
  // =========================================================

  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const [orderType, setOrderType] = useState<FlashOrderType | null>(null);

  const [orderBusy, setOrderBusy] = useState(false);

  // =========================================================
  // 2.1 DATOS DE FULFILLMENT DEL CHECKOUT
  //
  // Los campos visibles cambian según la modalidad elegida.
  // =========================================================

  const [scheduledFor, setScheduledFor] = useState("");

  const [customerName, setCustomerName] = useState("");

  const [customerPhone, setCustomerPhone] = useState("");

  const [tableCode, setTableCode] = useState("");

  const [tableContextToken, setTableContextToken] = useState<string | null>(
    null,
  );

  const [tableContext, setTableContext] =
    useState<DiningTableContextResponse | null>(null);

  const [reservationPreorder, setReservationPreorder] =
    useState<TableReservation | null>(null);

  const [tableContextLoading, setTableContextLoading] = useState(false);

  const [tableContextError, setTableContextError] = useState<string | null>(
    null,
  );

  // =========================================================
  // 2.2 DISPONIBILIDAD DE MESAS
  //
  // La lista se obtiene desde GET /api/v1/tables.
  // Las mesas OCCUPIED se muestran, pero no pueden elegirse.
  // =========================================================

  const [diningTables, setDiningTables] = useState<DiningTable[]>([]);

  const [tablesLoading, setTablesLoading] = useState(false);

  const [tablesError, setTablesError] = useState<string | null>(null);

  const [tableSelectorOpen, setTableSelectorOpen] = useState(false);

  const [deliveryAddress, setDeliveryAddress] = useState("");

  const [deliveryAddressSuggestions, setDeliveryAddressSuggestions] =
    useState<DeliveryAddressSuggestion[]>([]);

  const [deliveryAddressSearching, setDeliveryAddressSearching] =
    useState(false);

  const [deliveryAddressResolving, setDeliveryAddressResolving] =
    useState(false);

  const [deliveryAddressError, setDeliveryAddressError] =
    useState<string | null>(null);

  const [selectedDeliveryAddress, setSelectedDeliveryAddress] =
    useState<DeliveryAddressLocation | null>(null);

  const [customerNotes, setCustomerNotes] = useState("");

  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Datos actuales del pedido seguido.
  const [completedOrder, setCompletedOrder] = useState<CreatedOrder | null>(
    null,
  );

  const [orderPayment, setOrderPayment] = useState<PaymentAttempt | null>(null);

  const [paymentBusy, setPaymentBusy] = useState(false);

  const [paymentError, setPaymentError] = useState<string | null>(null);

  const [deliveryLocation, setDeliveryLocation] =
    useState<PublicDeliveryLocation | null>(null);

  const [deliveryLocationError, setDeliveryLocationError] =
    useState<string | null>(null);

  // Controla solamente si el modal está abierto o cerrado.
  // El polling NO debe modificar este estado.
  const [orderModalOpen, setOrderModalOpen] = useState(false);

  // Token del pedido que el navegador está siguiendo.
  const [activeTrackingToken, setActiveTrackingToken] = useState<string | null>(
    null,
  );

  // =========================================================
  // 3. CLAVES DE LOCALSTORAGE
  // =========================================================

  const storageKey = `flashcommerce.cartToken:${catalog.tenant.code}:${catalog.branch.code}`;

  const orderStorageKey = `flashcommerce.orderTracking:${catalog.tenant.code}:${catalog.branch.code}`;

  // =========================================================
  // 4. HELPERS
  // =========================================================

  function findCatalogProduct(productId: string): Product | undefined {
    for (const category of catalog.categories) {
      const product = category.products.find((item) => item.id === productId);

      if (product) {
        return product;
      }
    }

    return undefined;
  }

  function applyServerCart(serverCart: FlashCart) {
    const nextCart: Record<string, CartItem> = {};

    for (const item of serverCart.items) {
      const catalogProduct = findCatalogProduct(item.product.id);

      if (!catalogProduct) {
        continue;
      }

      nextCart[item.product.id] = {
        product: {
          ...catalogProduct,

          // El precio del carrito viene del backend.
          price: item.unitPrice,
          currency: item.currency,
        },

        quantity: item.quantity,
      };
    }

    setCart(nextCart);
  }

  async function syncCart(token: string) {
    const serverCart = await getCart(token);

    applyServerCart(serverCart);

    return serverCart;
  }

  async function createNewCartToken() {
    const createdCart = await createCart(
      catalog.tenant.code,
      catalog.branch.code,
    );

    window.localStorage.setItem(storageKey, createdCart.token);

    setCartToken(createdCart.token);

    return createdCart.token;
  }

  async function ensureCartToken() {
    if (cartToken) {
      return cartToken;
    }

    return createNewCartToken();
  }

  function getErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return "Ocurrió un error inesperado";
  }

  function getCustomerDeliveryStatusLabel(
    status: string,
  ): string {
    switch (status) {
      case "CREATED":
        return "Delivery creado";

      case "WAITING_ASSIGNMENT":
        return "Esperando repartidor";

      case "ASSIGNED":
        return "Repartidor asignado";

      case "ACCEPTED":
        return "Repartidor confirmado";

      case "PICKED_UP":
        return "Pedido recogido";

      case "EN_ROUTE":
        return "Repartidor en camino";

      case "ARRIVED":
        return "Repartidor en destino";

      case "DELIVERED":
        return "Pedido entregado";

      case "FAILED":
        return "Entrega con incidencia";

      case "CANCELLED":
        return "Delivery cancelado";

      default:
        return status;
    }
  }

  async function prepareQrPayment(trackingToken: string) {
    setPaymentBusy(true);
    setPaymentError(null);

    try {
      const result = await createQrPayment(trackingToken);

      setOrderPayment(result.payment);

      setCompletedOrder((currentOrder) => {
        if (!currentOrder || currentOrder.trackingToken !== trackingToken) {
          return currentOrder;
        }

        return {
          ...currentOrder,
          status: result.order.status,
          paymentStatus: result.order.paymentStatus,
          orderOrigin: result.order.orderOrigin,
        };
      });
    } catch (error) {
      setPaymentError(getErrorMessage(error));
    } finally {
      setPaymentBusy(false);
    }
  }

  // =========================================================
  // 4.1 FORMATO DE FECHA/HORA PARA EL CLIENTE
  // =========================================================

  function formatOrderDateTime(value: string): string {
    return new Date(value).toLocaleString("es-BO", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: catalog.branch.timezone,
    });
  }

  // =========================================================
  // 4.2 FECHA/HORA MÍNIMA PARA PICKUP
  //
  // V0.2 usa la zona horaria local del navegador para el
  // control datetime-local. Para el piloto en Bolivia coincide
  // con America/La_Paz. Más adelante centralizaremos esta
  // conversión para sucursales en diferentes zonas horarias.
  // =========================================================

  function getMinimumPickupDateTime() {
    const minimumDate = new Date(Date.now() + 15 * 60 * 1000);

    const timezoneOffset = minimumDate.getTimezoneOffset();

    const localDate = new Date(
      minimumDate.getTime() - timezoneOffset * 60 * 1000,
    );

    return localDate.toISOString().slice(0, 16);
  }

  // =========================================================
  // 4.3 MESAS - CONSULTA DE DISPONIBILIDAD
  // =========================================================

  async function loadDiningTables() {
    setTablesLoading(true);
    setTablesError(null);

    try {
      const result = await getDiningTables(
        catalog.tenant.code,
        catalog.branch.code,
      );

      setDiningTables(result.tables);

      // Si la mesa seleccionada dejó de estar disponible,
      // limpiamos la selección para no permitir continuar
      // con información obsoleta.
      if (tableCode && !tableContext) {
        const selected = result.tables.find(
          (table) => table.code === tableCode,
        );

        if (!selected || selected.availability !== "AVAILABLE") {
          setTableCode("");
        }
      }

      return result;
    } catch (error) {
      setTablesError(getErrorMessage(error));

      throw error;
    } finally {
      setTablesLoading(false);
    }
  }

  function openTableSelector() {
    if (tableContext) {
      return;
    }

    setTableSelectorOpen(true);
    setTablesError(null);

    void loadDiningTables().catch(() => undefined);
  }

  const selectedDiningTable =
    diningTables.find((table) => table.code === tableCode) ?? null;

  const diningTableZones = Array.from(
    new Set(diningTables.map((table) => table.zone || "Sin zona")),
  );

  // =========================================================
  // 4.3 LIMPIAR FORMULARIO DE FULFILLMENT
  // =========================================================

  function resetFulfillmentForm() {
    setScheduledFor("");
    setCustomerName("");
    setCustomerPhone("");
    setTableCode(tableContext?.table.code ?? "");
    setDeliveryAddress("");
    setDeliveryAddressSuggestions([]);
    setDeliveryAddressSearching(false);
    setDeliveryAddressResolving(false);
    setDeliveryAddressError(null);
    setSelectedDeliveryAddress(null);
    setCustomerNotes("");
    setCheckoutError(null);

    setTableSelectorOpen(false);
    setTablesError(null);
  }

  // =========================================================
  // 4.4 DIRECCION DE DELIVERY
  //
  // Buscamos sugerencias solamente a partir de 3 caracteres.
  // Una direccion queda valida para checkout solo despues de
  // resolver una sugerencia y conservar su placeId + lat/lng.
  // =========================================================

  useEffect(() => {
    if (orderType !== "DELIVERY") {
      setDeliveryAddressSuggestions([]);
      setDeliveryAddressSearching(false);
      setDeliveryAddressError(null);

      return;
    }

    const normalizedInput = deliveryAddress.trim();

    if (
      selectedDeliveryAddress &&
      selectedDeliveryAddress.formattedAddress.trim() === normalizedInput
    ) {
      setDeliveryAddressSuggestions([]);
      setDeliveryAddressSearching(false);
      setDeliveryAddressError(null);

      return;
    }

    if (normalizedInput.length < 3) {
      setDeliveryAddressSuggestions([]);
      setDeliveryAddressSearching(false);
      setDeliveryAddressError(null);

      return;
    }

    setDeliveryAddressSearching(false);

    const controller = new AbortController();

    const timerId = window.setTimeout(() => {
      setDeliveryAddressSearching(true);
      setDeliveryAddressError(null);

      void autocompleteDeliveryAddress(
        catalog.tenant.code,
        catalog.branch.code,
        normalizedInput,
        controller.signal,
      )
        .then((response) => {
          if (controller.signal.aborted) {
            return;
          }

          setDeliveryAddressSuggestions(response.suggestions);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }

          const message = getErrorMessage(error);

          setDeliveryAddressSuggestions([]);

          setDeliveryAddressError(
            message === "Delivery is not enabled for this branch"
              ? "Delivery todavía no está disponible en esta sucursal."
              : "No pudimos buscar direcciones en este momento.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setDeliveryAddressSearching(false);
          }
        });
    }, 350);

    return () => {
      window.clearTimeout(timerId);
      controller.abort();
    };
  }, [
    orderType,
    deliveryAddress,
    selectedDeliveryAddress,
    catalog.tenant.code,
    catalog.branch.code,
  ]);

  function handleDeliveryAddressChange(value: string) {
    setDeliveryAddress(value);
    setSelectedDeliveryAddress(null);
    setDeliveryAddressSuggestions([]);
    setDeliveryAddressError(null);
  }

  async function selectDeliveryAddressSuggestion(
    suggestion: DeliveryAddressSuggestion,
  ) {
    setDeliveryAddressResolving(true);
    setDeliveryAddressError(null);

    try {
      const response = await resolveDeliveryAddress(
        catalog.tenant.code,
        catalog.branch.code,
        suggestion.placeId,
      );

      setDeliveryAddress(response.location.formattedAddress);
      setSelectedDeliveryAddress(response.location);
      setDeliveryAddressSuggestions([]);
    } catch (error) {
      const message = getErrorMessage(error);

      setSelectedDeliveryAddress(null);

      setDeliveryAddressError(
        message === "Delivery is not enabled for this branch"
          ? "Delivery todavía no está disponible en esta sucursal."
          : "No pudimos verificar esa dirección. Intenta nuevamente.",
      );
    } finally {
      setDeliveryAddressResolving(false);
    }
  }
  function startReservationPreorder(reservation: TableReservation) {
    setReservationPreorder(reservation);
    setOrderType("DINE_IN");
    setTableCode(reservation.table.code);
    setScheduledFor(reservation.reservedFor);
    setCustomerName(reservation.customerName);
    setCustomerPhone(reservation.customerPhone);
    setCheckoutError(null);
    setCartError(null);
  }

  // =========================================================
  // 4.4 QR CONTEXTUAL DE MESA
  //
  // El token se valida siempre contra el backend. Cuando es
  // válido, la mesa queda identificada y no puede cambiarse
  // manualmente desde este menú.
  // =========================================================

  useEffect(() => {
    const contextToken = new URLSearchParams(window.location.search)
      .get("tableContext")
      ?.trim();

    if (!contextToken) {
      return;
    }

    let cancelled = false;

    setTableContextLoading(true);
    setTableContextError(null);

    void getDiningTableContext(contextToken)
      .then((context) => {
        if (cancelled) {
          return;
        }

        if (
          context.tenant !== catalog.tenant.code ||
          context.branch !== catalog.branch.code
        ) {
          throw new Error("El QR pertenece a otra sucursal.");
        }

        setTableContextToken(contextToken);
        setTableContext(context);
        setTableCode(context.table.code);
        setOrderType("DINE_IN");

        setDiningTables((current) => [
          context.table,
          ...current.filter((table) => table.id !== context.table.id),
        ]);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setTableContextToken(null);
        setTableContext(null);
        setTableCode("");
        setTableContextError(
          "El código QR de esta mesa no es válido o ya venció. Solicita al personal un QR actualizado.",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setTableContextLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [catalog.tenant.code, catalog.branch.code]);

  // =========================================================
  // 5. RESTAURAR CARRITO AL ENTRAR / F5
  // =========================================================

  useEffect(() => {
    let cancelled = false;

    async function restoreCart() {
      const storedToken = window.localStorage.getItem(storageKey);

      if (!storedToken) {
        setCartReady(true);
        return;
      }

      setCartBusy(true);
      setCartError(null);

      try {
        const serverCart = await getCart(storedToken);

        if (cancelled) {
          return;
        }

        const expired =
          serverCart.status !== "OPEN" ||
          new Date(serverCart.expiresAt).getTime() <= Date.now();

        if (expired) {
          window.localStorage.removeItem(storageKey);

          setCartToken(null);
          setCart({});

          return;
        }

        setCartToken(storedToken);
        applyServerCart(serverCart);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = getErrorMessage(error);

        if (message === "Cart not found") {
          window.localStorage.removeItem(storageKey);

          setCartToken(null);
          setCart({});
        } else {
          setCartToken(storedToken);

          setCartError(`No se pudo recuperar el carrito: ${message}`);
        }
      } finally {
        if (!cancelled) {
          setCartBusy(false);
          setCartReady(true);
        }
      }
    }

    void restoreCart();

    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  // =========================================================
  // 6. RESTAURAR TOKEN DEL PEDIDO AL ENTRAR / F5
  //
  // IMPORTANTE:
  // Este efecto sólo decide QUÉ pedido seguir y abre el modal
  // una vez al entrar o al recargar la página.
  // =========================================================

  useEffect(() => {
    const trackingToken = window.localStorage.getItem(orderStorageKey);

    if (
      !trackingToken ||
      trackingToken === "undefined" ||
      trackingToken === "null"
    ) {
      window.localStorage.removeItem(orderStorageKey);

      setActiveTrackingToken(null);
      setCompletedOrder(null);
      setOrderPayment(null);
      setPaymentError(null);
      setOrderModalOpen(false);

      return;
    }

    setActiveTrackingToken(trackingToken);
    setOrderPayment(null);
    setPaymentError(null);

    // Al entrar o hacer F5 mostramos inicialmente
    // el pedido activo. El polling NO vuelve a abrirlo.
    setOrderModalOpen(true);
  }, [orderStorageKey]);

  // =========================================================
  // 7. POLLING DEL PEDIDO ACTIVO CADA 5 SEGUNDOS
  //
  // IMPORTANTE:
  // Copiamos activeTrackingToken a una constante local.
  // Después de validar que no sea null, TypeScript sabe
  // que trackingToken es definitivamente string.
  // =========================================================

  useEffect(() => {
    if (!activeTrackingToken) {
      return;
    }

    // =========================================================
    // TOKEN VALIDADO
    //
    // Después de comprobar que activeTrackingToken no es null,
    // creamos una constante cuyo tipo es explícitamente string.
    // Esto evita que TypeScript vuelva a tratarlo como string|null
    // dentro de refreshOrder().
    // =========================================================

    const trackingToken: string = activeTrackingToken;

    let stopped = false;
    let timerId: number | undefined;

    async function refreshOrder() {
      try {
        const [orderResult, paymentResult] = await Promise.allSettled([
          getOrderTracking(trackingToken),
          getOrderPayment(trackingToken),
        ]);

        if (stopped) {
          return;
        }

        if (orderResult.status === "rejected") {
          throw orderResult.reason;
        }

        let order = orderResult.value;

        if (paymentResult.status === "fulfilled") {
          order = {
            ...order,
            status: paymentResult.value.order.status,
            paymentStatus: paymentResult.value.order.paymentStatus,
            orderOrigin: paymentResult.value.order.orderOrigin,
          };

          setOrderPayment(paymentResult.value.payment);
          setPaymentError(null);
        } else {
          setPaymentError(getErrorMessage(paymentResult.reason));
        }

        // Actualizamos los datos del pedido,
        // pero NO volvemos a abrir el modal.
        setCompletedOrder(order);

        // Si el pedido terminó, detenemos el polling.
        if (order.status === "COMPLETED" || order.status === "CANCELLED") {
          return;
        }

        timerId = window.setTimeout(refreshOrder, 5000);
      } catch (error) {
        if (stopped) {
          return;
        }

        const message = getErrorMessage(error);

        if (message === "Order not found") {
          window.localStorage.removeItem(orderStorageKey);

          setActiveTrackingToken(null);
          setCompletedOrder(null);
          setOrderPayment(null);
          setPaymentError(null);
          setOrderModalOpen(false);

          return;
        }

        setCartError(`No se pudo actualizar el pedido: ${message}`);

        // Reintento después de un error temporal.
        timerId = window.setTimeout(refreshOrder, 5000);
      }
    }

    void refreshOrder();

    return () => {
      stopped = true;

      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [activeTrackingToken, orderStorageKey]);

  // =========================================================
  // 7.1 POLLING DE UBICACION DEL REPARTIDOR CADA 10 SEGUNDOS
  //
  // Es independiente del polling del pedido y del pago.
  // Un fallo de ubicacion no detiene el seguimiento principal.
  // =========================================================

  useEffect(() => {
    if (
      !activeTrackingToken ||
      completedOrder?.orderType !== "DELIVERY"
    ) {
      setDeliveryLocation(null);
      setDeliveryLocationError(null);

      return;
    }

    const trackingToken: string =
      activeTrackingToken;

    let stopped = false;
    let locationTimerId:
      | number
      | undefined;

    async function refreshDeliveryLocation() {
      try {
        const result =
          await getOrderDeliveryLocation(
            trackingToken,
          );

        if (stopped) {
          return;
        }

        setDeliveryLocation(result);
        setDeliveryLocationError(null);
      } catch (error) {
        if (stopped) {
          return;
        }

        setDeliveryLocationError(
          getErrorMessage(error),
        );
      }

      if (!stopped) {
        locationTimerId =
          window.setTimeout(
            refreshDeliveryLocation,
            10000,
          );
      }
    }

    void refreshDeliveryLocation();

    return () => {
      stopped = true;

      if (
        locationTimerId !== undefined
      ) {
        window.clearTimeout(
          locationTimerId,
        );
      }
    };
  }, [
    activeTrackingToken,
    completedOrder?.orderType,
  ]);

  // =========================================================
  // 8. OPERACIONES DEL CARRITO
  // =========================================================

  async function addProduct(product: Product) {
    if (!cartReady || cartBusy) {
      return;
    }

    setCartBusy(true);
    setCartError(null);

    try {
      const token = await ensureCartToken();

      await addCartItem(token, product.id, 1);

      await syncCart(token);
    } catch (error) {
      setCartError(getErrorMessage(error));
    } finally {
      setCartBusy(false);
    }
  }

  async function decreaseProduct(productId: string) {
    if (!cartReady || cartBusy) {
      return;
    }

    const existing = cart[productId];

    if (!existing || !cartToken) {
      return;
    }

    setCartBusy(true);
    setCartError(null);

    try {
      if (existing.quantity <= 1) {
        await removeCartItem(cartToken, productId);
      } else {
        await updateCartItem(cartToken, productId, existing.quantity - 1);
      }

      await syncCart(cartToken);
    } catch (error) {
      setCartError(getErrorMessage(error));
    } finally {
      setCartBusy(false);
    }
  }

  async function removeProduct(productId: string) {
    if (!cartReady || cartBusy || !cartToken) {
      return;
    }

    setCartBusy(true);
    setCartError(null);

    try {
      await removeCartItem(cartToken, productId);

      await syncCart(cartToken);
    } catch (error) {
      setCartError(getErrorMessage(error));
    } finally {
      setCartBusy(false);
    }
  }

  // =========================================================
  // 9. CREAR PEDIDO
  //
  // Construye el fulfillment según la modalidad elegida.
  // Sólo enviamos al backend los campos que corresponden.
  // =========================================================

  async function submitOrder() {
    if (!cartToken || !orderType || cartBusy || orderBusy) {
      return;
    }

    setCheckoutError(null);

    let fulfillment: FlashOrderFulfillmentInput = {};

    // -------------------------------------------------------
    // DINE_IN
    // -------------------------------------------------------

    if (orderType === "DINE_IN") {
      const normalizedTableCode = tableCode.trim();

      if (reservationPreorder) {
        fulfillment = {
          reservationTrackingToken: reservationPreorder.trackingToken,
          customerNotes: customerNotes.trim() || undefined,
        };
      } else if (tableContextToken && tableContext) {
        if (normalizedTableCode !== tableContext.table.code) {
          setCheckoutError(
            "La mesa del pedido no coincide con el QR escaneado.",
          );

          return;
        }
      } else if (normalizedTableCode) {
        // Una mesa elegida manualmente debe continuar libre.
        // La mesa contextual puede estar ocupada porque su
        // token autoriza reutilizar la sesión OPEN del grupo.
        try {
          const tablesResult = await getDiningTables(
            catalog.tenant.code,
            catalog.branch.code,
          );

          setDiningTables(tablesResult.tables);

          const currentTable = tablesResult.tables.find(
            (table) => table.code === normalizedTableCode,
          );

          if (!currentTable || currentTable.availability !== "AVAILABLE") {
            setTableCode("");

            setCheckoutError(
              "La mesa seleccionada ya no está disponible. Selecciona otra mesa o continúa sin mesa.",
            );

            return;
          }
        } catch (error) {
          setCheckoutError(
            `No se pudo verificar la disponibilidad de la mesa: ${getErrorMessage(
              error,
            )}`,
          );

          return;
        }
      }

      if (!reservationPreorder) {
        fulfillment = {
          tableCode: normalizedTableCode || undefined,

          tableContextToken: tableContextToken || undefined,

          customerNotes: customerNotes.trim() || undefined,
        };
      }
    }

    // -------------------------------------------------------
    // TAKEAWAY
    // -------------------------------------------------------

    if (orderType === "TAKEAWAY") {
      fulfillment = {
        customerNotes: customerNotes.trim() || undefined,
      };
    }

    // -------------------------------------------------------
    // PICKUP
    // -------------------------------------------------------

    if (orderType === "PICKUP") {
      const normalizedName = customerName.trim();

      const normalizedPhone = customerPhone.trim();

      if (!scheduledFor) {
        setCheckoutError("Selecciona la fecha y hora de retiro.");

        return;
      }

      if (!normalizedName) {
        setCheckoutError(
          "Ingresa el nombre de la persona que recogerá el pedido.",
        );

        return;
      }

      if (!normalizedPhone) {
        setCheckoutError("Ingresa un teléfono de contacto.");

        return;
      }

      const scheduledDate = new Date(scheduledFor);

      if (Number.isNaN(scheduledDate.getTime())) {
        setCheckoutError("La fecha y hora de retiro no es válida.");

        return;
      }

      if (scheduledDate.getTime() <= Date.now()) {
        setCheckoutError("La fecha y hora de retiro debe ser futura.");

        return;
      }

      fulfillment = {
        scheduledFor: scheduledDate.toISOString(),

        customerName: normalizedName,

        customerPhone: normalizedPhone,

        customerNotes: customerNotes.trim() || undefined,
      };
    }

    // -------------------------------------------------------
    // DELIVERY
    // -------------------------------------------------------

    if (orderType === "DELIVERY") {
      const normalizedName = customerName.trim();

      const normalizedPhone = customerPhone.trim();

      const normalizedAddress = deliveryAddress.trim();

      const resolvedAddress = selectedDeliveryAddress;

      if (!normalizedName) {
        setCheckoutError("Ingresa el nombre de quien recibirá el pedido.");

        return;
      }

      if (!normalizedPhone) {
        setCheckoutError("Ingresa un teléfono de contacto.");

        return;
      }

      if (!normalizedAddress) {
        setCheckoutError("Ingresa la dirección de entrega.");

        return;
      }
      if (
        !resolvedAddress ||
        resolvedAddress.formattedAddress.trim() !== normalizedAddress
      ) {
        setCheckoutError(
          "Selecciona una dirección de la lista para validar la ubicación.",
        );

        return;
      }

      fulfillment = {
        customerName: normalizedName,

        customerPhone: normalizedPhone,

        deliveryAddress: resolvedAddress.formattedAddress,

        deliveryLatitude: resolvedAddress.location.latitude,

        deliveryLongitude: resolvedAddress.location.longitude,

        deliveryReference: resolvedAddress.placeId,

        customerNotes: customerNotes.trim() || undefined,
      };
    }

    setOrderBusy(true);

    try {
      const order = await createOrder(cartToken, orderType, fulfillment);

      setOrderPayment(null);
      setPaymentError(null);

      // Guardamos solamente tokens válidos.
      if (
        typeof order.trackingToken === "string" &&
        order.trackingToken.length > 0
      ) {
        window.localStorage.setItem(orderStorageKey, order.trackingToken);

        setActiveTrackingToken(order.trackingToken);

        void prepareQrPayment(order.trackingToken);
      } else {
        console.error("Order created without trackingToken", order);
      }

      // El carrito ya quedó CONVERTED en PostgreSQL.
      // Eliminamos solamente la referencia local del carrito.
      window.localStorage.removeItem(storageKey);

      setCompletedOrder(order);
      setOrderModalOpen(true);

      setCheckoutOpen(false);
      setOrderType(null);

      resetFulfillmentForm();

      setReservationPreorder(null);
      setTableCode(tableContext?.table.code ?? "");

      setCart({});
      setCartToken(null);
    } catch (error) {
      setCheckoutError(getErrorMessage(error));
    } finally {
      setOrderBusy(false);
    }
  }

  // =========================================================
  // 10. TOTALES DEL CARRITO
  // =========================================================

  // =========================================================
  // 10. FINALIZAR SEGUIMIENTO DEL PEDIDO
  //
  // Se utiliza cuando el pedido llegó a un estado terminal:
  //
  // COMPLETED
  // CANCELLED
  //
  // El pedido NO se elimina de PostgreSQL.
  // Solamente dejamos de seguirlo en este navegador.
  // =========================================================

  function finalizeOrderTracking() {
    // Eliminamos la referencia pública guardada
    // en este navegador.
    window.localStorage.removeItem(orderStorageKey);

    // Al quedar null, el useEffect del polling
    // se desmonta y deja de consultar el pedido.
    setActiveTrackingToken(null);

    // Quitamos los datos del pedido de la UI.
    setCompletedOrder(null);
    setOrderPayment(null);
    setPaymentError(null);
    setDeliveryLocation(null);
    setDeliveryLocationError(null);

    // Cerramos el modal.
    setOrderModalOpen(false);
  }

  const cartItems = Object.values(cart);

  const totalItems = cartItems.reduce(
    (total, item) => total + item.quantity,
    0,
  );

  const totalAmount = cartItems.reduce(
    (total, item) => total + item.product.price * item.quantity,
    0,
  );

  // =========================================================
  // 10.1 VALIDACIÓN RÁPIDA DEL CHECKOUT
  //
  // Esta validación controla el botón Confirmar pedido.
  // submitOrder() vuelve a validar antes de enviar al backend.
  // =========================================================

  const checkoutFulfillmentValid =
    orderType === "DINE_IN"
      ? !tableContextLoading
      : orderType === "TAKEAWAY"
        ? true
        : orderType === "PICKUP"
          ? Boolean(scheduledFor && customerName.trim() && customerPhone.trim())
          : orderType === "DELIVERY"
            ? Boolean(
                customerName.trim() &&
                customerPhone.trim() &&
                deliveryAddress.trim() &&
                selectedDeliveryAddress !== null &&
                selectedDeliveryAddress.formattedAddress.trim() ===
                  deliveryAddress.trim(),
              )
            : false;

  const paymentExpirationTime = orderPayment?.expiresAt
    ? new Date(orderPayment.expiresAt).getTime()
    : null;

  const paymentExpired =
    paymentExpirationTime !== null && paymentExpirationTime <= Date.now();

  const paymentPaid = Boolean(
    completedOrder?.paymentStatus === "PAID" || orderPayment?.status === "PAID",
  );

  const activeQrAvailable = Boolean(
    orderPayment?.status === "AWAITING_CONFIRMATION" &&
    orderPayment.qrPayload &&
    !paymentExpired,
  );

  const retryablePayment = Boolean(
    !orderPayment ||
    orderPayment.status === "CREATED" ||
    orderPayment.status === "FAILED" ||
    orderPayment.status === "EXPIRED" ||
    orderPayment.status === "CANCELLED" ||
    paymentExpired,
  );

  const canGenerateQr = Boolean(
    completedOrder &&
    completedOrder.status !== "COMPLETED" &&
    completedOrder.status !== "CANCELLED" &&
    completedOrder.paymentStatus !== "NOT_REQUIRED" &&
    !paymentPaid &&
    !paymentBusy &&
    retryablePayment,
  );

  // =========================================================
  // 11. UI
  // =========================================================

  return (
    <main className="min-h-screen bg-zinc-50 pb-28 text-zinc-950">
      <header className="border-b bg-white">
        <div className="mx-auto max-w-6xl px-5 py-6">
          <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
            Flash Menu
          </p>

          <h1 className="mt-1 text-3xl font-bold">{catalog.tenant.name}</h1>

          <p className="mt-1 text-zinc-600">{catalog.branch.name}</p>

          {!tableContext && (
            <TableReservationClient
              tenantCode={catalog.tenant.code}
              branchCode={catalog.branch.code}
              timeZone={catalog.branch.timezone}
              onStartPreorder={startReservationPreorder}
            />
          )}

          {reservationPreorder && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-sky-700">
                  Pedido anticipado para tu reserva
                </p>
                <p className="mt-1 font-bold text-sky-950">
                  {reservationPreorder.reservationCode} ·{" "}
                  {reservationPreorder.table.code} ·{" "}
                  {formatOrderDateTime(reservationPreorder.reservedFor)}
                </p>
                <p className="mt-1 text-sm text-sky-800">
                  Agrega productos al carrito. La mesa no se ocupará hasta el
                  check-in.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setReservationPreorder(null);
                  resetFulfillmentForm();
                }}
                className="rounded-xl border border-sky-300 bg-white px-4 py-2 text-sm font-bold text-sky-900"
              >
                Cancelar pedido anticipado
              </button>
            </div>
          )}

          {tableContextLoading && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              Identificando la mesa del código QR...
            </div>
          )}

          {tableContext && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                  Pedido desde la mesa
                </p>
                <p className="mt-1 text-lg font-black text-emerald-950">
                  {tableContext.table.code} · {tableContext.table.name}
                </p>
              </div>

              <span className="rounded-full bg-emerald-200 px-3 py-1 text-xs font-bold text-emerald-900">
                Mesa identificada
              </span>
            </div>
          )}

          {tableContextError && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
              {tableContextError}
            </div>
          )}
        </div>
      </header>

      {/* =====================================================
          ERROR GLOBAL DEL CARRITO / TRACKING
      ====================================================== */}

      {cartError && (
        <div className="mx-auto max-w-6xl px-5 pt-5">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{cartError}</span>

            <button
              type="button"
              onClick={() => setCartError(null)}
              className="font-bold"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* =====================================================
          CATÁLOGO
      ====================================================== */}

      <div className="mx-auto max-w-6xl px-5 py-8">
        <div className="space-y-10">
          {catalog.categories.map((category) => (
            <section key={category.id}>
              <h2 className="mb-4 text-2xl font-bold">{category.name}</h2>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {category.products.map((product) => {
                  const cartItem = cart[product.id];

                  return (
                    <article
                      key={product.id}
                      className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
                    >
                      <div className="flex min-h-28 items-center justify-center rounded-xl bg-zinc-100 text-sm text-zinc-400">
                        Foto del producto
                      </div>

                      <div className="mt-4">
                        <h3 className="text-lg font-semibold">
                          {product.name}
                        </h3>

                        {product.description && (
                          <p className="mt-1 text-sm text-zinc-600">
                            {product.description}
                          </p>
                        )}

                        <div className="mt-5 flex items-end justify-between gap-3">
                          <div>
                            <p className="text-xl font-bold">
                              {product.currency} {product.price.toFixed(2)}
                            </p>

                            <p
                              className={`mt-1 text-sm font-medium ${
                                product.available
                                  ? "text-green-700"
                                  : "text-zinc-500"
                              }`}
                            >
                              {product.available
                                ? "Disponible"
                                : "No disponible"}
                            </p>

                            {product.preparationMinutes > 0 && (
                              <p className="mt-1 text-xs text-zinc-500">
                                Preparación aproximada:{" "}
                                {product.preparationMinutes} min
                              </p>
                            )}
                          </div>

                          {!cartItem ? (
                            <button
                              type="button"
                              disabled={
                                !product.available || !cartReady || cartBusy
                              }
                              onClick={() => void addProduct(product)}
                              className="rounded-xl bg-zinc-950 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-300"
                            >
                              {cartBusy ? "..." : "Agregar"}
                            </button>
                          ) : (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={cartBusy}
                                onClick={() => void decreaseProduct(product.id)}
                                className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-300 bg-white text-lg font-bold disabled:opacity-50"
                              >
                                −
                              </button>

                              <span className="min-w-6 text-center font-bold">
                                {cartItem.quantity}
                              </span>

                              <button
                                type="button"
                                disabled={cartBusy}
                                onClick={() => void addProduct(product)}
                                className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-950 text-lg font-bold text-white disabled:opacity-50"
                              >
                                +
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      {/* =====================================================
          BARRA INFERIOR DEL CARRITO
      ====================================================== */}

      {totalItems > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-zinc-200 bg-white p-4 shadow-lg">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
            <div>
              <p className="text-sm text-zinc-500">
                {totalItems} {totalItems === 1 ? "producto" : "productos"}
                {cartBusy && <span className="ml-2">· Guardando...</span>}
              </p>

              <p className="text-xl font-bold">BOB {totalAmount.toFixed(2)}</p>
            </div>

            <button
              type="button"
              disabled={cartBusy}
              onClick={() => setCartOpen(true)}
              className="rounded-xl bg-zinc-950 px-6 py-3 font-semibold text-white disabled:opacity-50"
            >
              Ver carrito
            </button>
          </div>
        </div>
      )}

      {/* =====================================================
          PANEL DEL CARRITO
      ====================================================== */}

      {cartOpen && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Cerrar carrito"
            onClick={() => setCartOpen(false)}
            className="absolute inset-0 bg-black/40"
          />

          <aside className="absolute bottom-0 right-0 top-0 flex w-full max-w-md flex-col bg-white shadow-2xl">
            <header className="flex items-center justify-between border-b px-5 py-4">
              <div>
                <h2 className="text-xl font-bold">Tu pedido</h2>

                <p className="text-sm text-zinc-500">
                  {totalItems} {totalItems === 1 ? "producto" : "productos"}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 text-xl"
              >
                ×
              </button>
            </header>

            <div className="flex-1 overflow-y-auto p-5">
              {cartItems.length === 0 ? (
                <p className="text-zinc-500">Tu carrito está vacío.</p>
              ) : (
                <div className="space-y-5">
                  {cartItems.map((item) => (
                    <article
                      key={item.product.id}
                      className="border-b border-zinc-200 pb-5"
                    >
                      <div className="flex justify-between gap-4">
                        <div>
                          <h3 className="font-semibold">{item.product.name}</h3>

                          <p className="mt-1 text-sm text-zinc-500">
                            {item.product.currency}{" "}
                            {item.product.price.toFixed(2)} c/u
                          </p>
                        </div>

                        <p className="font-bold">
                          {item.product.currency}{" "}
                          {(item.product.price * item.quantity).toFixed(2)}
                        </p>
                      </div>

                      <div className="mt-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            disabled={cartBusy}
                            onClick={() =>
                              void decreaseProduct(item.product.id)
                            }
                            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 font-bold disabled:opacity-50"
                          >
                            −
                          </button>

                          <span className="min-w-5 text-center font-bold">
                            {item.quantity}
                          </span>

                          <button
                            type="button"
                            disabled={cartBusy}
                            onClick={() => void addProduct(item.product)}
                            className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-950 font-bold text-white disabled:opacity-50"
                          >
                            +
                          </button>
                        </div>

                        <button
                          type="button"
                          disabled={cartBusy}
                          onClick={() => void removeProduct(item.product.id)}
                          className="text-sm font-medium text-red-600 disabled:opacity-50"
                        >
                          Eliminar
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <footer className="border-t bg-white p-5">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-zinc-600">Total</span>

                <span className="text-2xl font-bold">
                  BOB {totalAmount.toFixed(2)}
                </span>
              </div>

              <button
                type="button"
                disabled={totalItems === 0 || cartBusy}
                onClick={() => {
                  setCartOpen(false);
                  setCheckoutOpen(true);

                  if (tableContext) {
                    setOrderType("DINE_IN");
                    setTableCode(tableContext.table.code);
                  } else if (reservationPreorder) {
                    setOrderType("DINE_IN");
                    setTableCode(reservationPreorder.table.code);
                  }
                }}
                className="w-full rounded-xl bg-zinc-950 px-5 py-4 text-base font-semibold text-white disabled:bg-zinc-300"
              >
                Continuar pedido
              </button>
            </footer>
          </aside>
        </div>
      )}

      {/* =====================================================
          MODAL DE CHECKOUT / FULFILLMENT
      ====================================================== */}

      {checkoutOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
                  Tu pedido
                </p>

                <h2 className="mt-1 text-2xl font-bold">
                  {reservationPreorder
                    ? "Pedido anticipado para tu reserva"
                    : tableContext
                      ? "Pedido desde tu mesa"
                      : "¿Cómo quieres recibirlo?"}
                </h2>

                <p className="mt-2 text-sm text-zinc-500">
                  {reservationPreorder
                    ? `${reservationPreorder.table.code} está reservada para ${formatOrderDateTime(reservationPreorder.reservedFor)}.`
                    : tableContext
                      ? `${tableContext.table.code} está identificada por el código QR.`
                      : "Selecciona una modalidad y completa los datos necesarios."}
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  setCheckoutOpen(false);
                  setCheckoutError(null);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 text-xl"
              >
                ×
              </button>
            </div>

            {/* ===============================================
                MODALIDADES
            ================================================ */}

            {tableContext && (
              <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                  Contexto verificado
                </p>
                <p className="mt-1 font-bold text-emerald-950">
                  {tableContext.table.code} · {tableContext.table.name}
                </p>
                <p className="mt-1 text-sm text-emerald-800">
                  El pedido se agregará a la sesión actual de esta mesa.
                </p>
              </div>
            )}

            {reservationPreorder && (
              <div className="mt-6 rounded-2xl border border-sky-200 bg-sky-50 p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-sky-700">
                  Reserva verificada
                </p>
                <p className="mt-1 font-bold text-sky-950">
                  {reservationPreorder.reservationCode} ·{" "}
                  {reservationPreorder.table.code} ·{" "}
                  {reservationPreorder.table.name}
                </p>
                <p className="mt-1 text-sm text-sky-800">
                  El pedido quedará programado para la reserva y se vinculará a
                  la mesa cuando el personal realice el check-in.
                </p>
              </div>
            )}

            <div className="mt-6 grid gap-3">
              <button
                type="button"
                onClick={() => {
                  setOrderType("DINE_IN");
                  setCheckoutError(null);

                  if (!tableContext && !reservationPreorder) {
                    void loadDiningTables().catch(() => undefined);
                  }
                }}
                className={`rounded-2xl border p-4 text-left ${
                  orderType === "DINE_IN"
                    ? "border-zinc-950 bg-zinc-100"
                    : "border-zinc-200"
                }`}
              >
                <div className="flex items-center gap-4">
                  <span className="text-3xl">🍽️</span>

                  <div>
                    <p className="font-bold">Comer aquí</p>

                    <p className="text-sm text-zinc-500">
                      Consumir el pedido en el restaurante
                    </p>
                  </div>
                </div>
              </button>

              <button
                type="button"
                disabled={tableContext !== null || reservationPreorder !== null}
                onClick={() => {
                  setOrderType("TAKEAWAY");
                  setCheckoutError(null);
                }}
                className={`rounded-2xl border p-4 text-left disabled:cursor-not-allowed disabled:opacity-45 ${
                  orderType === "TAKEAWAY"
                    ? "border-zinc-950 bg-zinc-100"
                    : "border-zinc-200"
                }`}
              >
                <div className="flex items-center gap-4">
                  <span className="text-3xl">🥡</span>

                  <div>
                    <p className="font-bold">Para llevar</p>

                    <p className="text-sm text-zinc-500">
                      Preparar ahora y retirar en el local
                    </p>
                  </div>
                </div>
              </button>

              <button
                type="button"
                disabled={tableContext !== null || reservationPreorder !== null}
                onClick={() => {
                  setOrderType("PICKUP");
                  setCheckoutError(null);
                }}
                className={`rounded-2xl border p-4 text-left disabled:cursor-not-allowed disabled:opacity-45 ${
                  orderType === "PICKUP"
                    ? "border-zinc-950 bg-zinc-100"
                    : "border-zinc-200"
                }`}
              >
                <div className="flex items-center gap-4">
                  <span className="text-3xl">🕐</span>

                  <div>
                    <p className="font-bold">Recoger después</p>

                    <p className="text-sm text-zinc-500">
                      Reservar el pedido para una fecha y hora determinada
                    </p>
                  </div>
                </div>
              </button>

              <button
                type="button"
                disabled={tableContext !== null || reservationPreorder !== null}
                onClick={() => {
                  setOrderType("DELIVERY");
                  setCheckoutError(null);
                }}
                className={`rounded-2xl border p-4 text-left disabled:cursor-not-allowed disabled:opacity-45 ${
                  orderType === "DELIVERY"
                    ? "border-zinc-950 bg-zinc-100"
                    : "border-zinc-200"
                }`}
              >
                <div className="flex items-center gap-4">
                  <span className="text-3xl">🛵</span>

                  <div>
                    <p className="font-bold">Delivery</p>

                    <p className="text-sm text-zinc-500">
                      Enviar el pedido a una dirección
                    </p>
                  </div>
                </div>
              </button>
            </div>

            {/* ===============================================
                FORMULARIO DINÁMICO DE FULFILLMENT
            ================================================ */}

            {orderType && (
              <div className="mt-6 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
                {orderType === "DINE_IN" && (
                  <div>
                    <p className="text-sm font-semibold">
                      {reservationPreorder
                        ? "Mesa reservada"
                        : tableContext
                          ? "Mesa identificada por QR"
                          : "Mesa (opcional)"}
                    </p>

                    {reservationPreorder ? (
                      <div className="mt-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="font-semibold text-zinc-950">
                              {reservationPreorder.table.name}
                            </p>
                            <p className="mt-1 text-xs text-zinc-500">
                              {reservationPreorder.table.code} ·{" "}
                              {reservationPreorder.partySize} personas ·{" "}
                              {formatOrderDateTime(
                                reservationPreorder.reservedFor,
                              )}
                            </p>
                          </div>
                          <span className="text-sm font-semibold text-sky-800">
                            Programado
                          </span>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={tableContext !== null}
                        onClick={openTableSelector}
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-left outline-none transition hover:border-zinc-950 disabled:cursor-default disabled:border-emerald-200 disabled:bg-emerald-50"
                      >
                        {selectedDiningTable ? (
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <p className="font-semibold text-zinc-950">
                                {selectedDiningTable.name}
                              </p>

                              <p className="mt-1 text-xs text-zinc-500">
                                {selectedDiningTable.code}
                                {" · "}
                                {selectedDiningTable.capacity} personas
                                {selectedDiningTable.zone
                                  ? ` · ${selectedDiningTable.zone}`
                                  : ""}
                              </p>
                            </div>

                            <span className="text-sm font-semibold text-zinc-600">
                              {tableContext ? "Bloqueada" : "Cambiar"}
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <p className="font-semibold text-zinc-950">
                                Seleccionar mesa
                              </p>

                              <p className="mt-1 text-xs text-zinc-500">
                                Consulta las mesas disponibles o continúa sin
                                mesa
                              </p>
                            </div>

                            <span className="text-xl">→</span>
                          </div>
                        )}
                      </button>
                    )}

                    {tablesLoading && (
                      <p className="mt-2 text-xs text-zinc-500">
                        Consultando disponibilidad...
                      </p>
                    )}

                    {tablesError && (
                      <p className="mt-2 text-xs text-red-600">{tablesError}</p>
                    )}

                    {tableContext && (
                      <p className="mt-3 text-xs font-semibold text-emerald-700">
                        No necesitas seleccionar otra mesa. El QR mantiene este
                        pedido asociado a {tableContext.table.code}.
                      </p>
                    )}

                    {!reservationPreorder &&
                      !tableContext &&
                      !selectedDiningTable && (
                        <p className="mt-3 text-xs text-zinc-500">
                          Puedes confirmar el pedido sin seleccionar una mesa.
                          El personal podrá asignarla cuando llegues.
                        </p>
                      )}
                  </div>
                )}

                {orderType === "TAKEAWAY" && (
                  <div className="rounded-xl bg-white p-3 text-sm text-zinc-600">
                    El pedido comenzará a prepararse para retiro en el local.
                  </div>
                )}

                {orderType === "PICKUP" && (
                  <div className="space-y-4">
                    <div>
                      <label
                        htmlFor="scheduledFor"
                        className="text-sm font-semibold"
                      >
                        Fecha y hora de retiro
                      </label>

                      <input
                        id="scheduledFor"
                        type="datetime-local"
                        min={getMinimumPickupDateTime()}
                        value={scheduledFor}
                        onChange={(event) =>
                          setScheduledFor(event.target.value)
                        }
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-zinc-950"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="pickupCustomerName"
                        className="text-sm font-semibold"
                      >
                        Nombre
                      </label>

                      <input
                        id="pickupCustomerName"
                        type="text"
                        value={customerName}
                        onChange={(event) =>
                          setCustomerName(event.target.value)
                        }
                        placeholder="Nombre de quien recogerá"
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-zinc-950"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="pickupCustomerPhone"
                        className="text-sm font-semibold"
                      >
                        Teléfono
                      </label>

                      <input
                        id="pickupCustomerPhone"
                        type="tel"
                        inputMode="tel"
                        value={customerPhone}
                        onChange={(event) =>
                          setCustomerPhone(event.target.value)
                        }
                        placeholder="Ej.: 70000000"
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-zinc-950"
                      />
                    </div>
                  </div>
                )}

                {orderType === "DELIVERY" && (
                  <div className="space-y-4">
                    <div>
                      <label
                        htmlFor="deliveryCustomerName"
                        className="text-sm font-semibold"
                      >
                        Nombre
                      </label>

                      <input
                        id="deliveryCustomerName"
                        type="text"
                        value={customerName}
                        onChange={(event) =>
                          setCustomerName(event.target.value)
                        }
                        placeholder="Nombre de quien recibirá"
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-zinc-950"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="deliveryCustomerPhone"
                        className="text-sm font-semibold"
                      >
                        Teléfono
                      </label>

                      <input
                        id="deliveryCustomerPhone"
                        type="tel"
                        inputMode="tel"
                        value={customerPhone}
                        onChange={(event) =>
                          setCustomerPhone(event.target.value)
                        }
                        placeholder="Ej.: 70000000"
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-zinc-950"
                      />
                    </div>

                    <div className="relative">
                      <label
                        htmlFor="deliveryAddress"
                        className="text-sm font-semibold"
                      >
                        Dirección de entrega
                      </label>

                      <input
                        id="deliveryAddress"
                        type="text"
                        value={deliveryAddress}
                        onChange={(event) =>
                          handleDeliveryAddressChange(event.target.value)
                        }
                        placeholder="Ej.: Av. Banzer 100"
                        autoComplete="off"
                        aria-autocomplete="list"
                        aria-controls="deliveryAddressSuggestions"
                        aria-expanded={
                          deliveryAddressSuggestions.length > 0 &&
                          selectedDeliveryAddress === null
                        }
                        disabled={deliveryAddressResolving || orderBusy}
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-zinc-950 disabled:cursor-wait disabled:bg-zinc-100"
                      />

                      {deliveryAddressSearching && (
                        <p className="mt-2 text-xs text-zinc-500">
                          Buscando direcciones...
                        </p>
                      )}

                      {deliveryAddressError && (
                        <p
                          role="alert"
                          className="mt-2 text-sm text-red-700"
                        >
                          {deliveryAddressError}
                        </p>
                      )}

                      {deliveryAddressSuggestions.length > 0 &&
                        selectedDeliveryAddress === null && (
                          <div
                            id="deliveryAddressSuggestions"
                            role="listbox"
                            className="absolute left-0 right-0 z-20 mt-2 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl"
                          >
                            <div className="max-h-64 overflow-y-auto">
                              {deliveryAddressSuggestions.map((suggestion) => (
                                <button
                                  key={suggestion.placeId}
                                  type="button"
                                  role="option"
                                  aria-selected={false}
                                  disabled={deliveryAddressResolving}
                                  onClick={() =>
                                    void selectDeliveryAddressSuggestion(
                                      suggestion,
                                    )
                                  }
                                  className="block w-full border-b border-zinc-100 px-4 py-3 text-left transition last:border-b-0 hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-60"
                                >
                                  <span className="block text-sm font-semibold text-zinc-950">
                                    {suggestion.mainText || suggestion.text}
                                  </span>

                                  {suggestion.secondaryText && (
                                    <span className="mt-1 block text-xs text-zinc-500">
                                      {suggestion.secondaryText}
                                    </span>
                                  )}
                                </button>
                              ))}
                            </div>

                            <div className="flex justify-end border-t border-zinc-100 bg-white px-3 py-2">
                              <span
                                translate="no"
                                className="whitespace-nowrap text-xs font-normal text-[#5E5E5E]"
                              >
                                Google Maps
                              </span>
                            </div>
                          </div>
                        )}

                      {deliveryAddressResolving && (
                        <p className="mt-2 text-xs text-zinc-500">
                          Verificando ubicación...
                        </p>
                      )}

                      {selectedDeliveryAddress && (
                        <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
                          <p className="text-xs font-semibold text-emerald-800">
                            Dirección verificada
                          </p>

                          <p className="mt-1 text-xs text-emerald-900">
                            {selectedDeliveryAddress.formattedAddress}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ===========================================
                    NOTA OPCIONAL PARA TODAS LAS MODALIDADES
                ============================================ */}

                <div className="mt-4">
                  <label
                    htmlFor="customerNotes"
                    className="text-sm font-semibold"
                  >
                    Nota opcional
                  </label>

                  <textarea
                    id="customerNotes"
                    value={customerNotes}
                    onChange={(event) => setCustomerNotes(event.target.value)}
                    placeholder="Ej.: sin picante, llamar al llegar..."
                    rows={3}
                    className="mt-2 w-full resize-none rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-zinc-950"
                  />
                </div>
              </div>
            )}

            {/* ===============================================
                ERROR DEL CHECKOUT
            ================================================ */}

            {checkoutError && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {checkoutError}
              </div>
            )}

            {/* ===============================================
                TOTAL + CONFIRMACIÓN
            ================================================ */}

            <div className="mt-6 border-t pt-5">
              <div className="mb-4 flex justify-between">
                <span className="text-zinc-500">Total</span>

                <span className="text-xl font-bold">
                  BOB {totalAmount.toFixed(2)}
                </span>
              </div>

              <button
                type="button"
                disabled={
                  !orderType ||
                  !checkoutFulfillmentValid ||
                  cartBusy ||
                  orderBusy
                }
                onClick={() => void submitOrder()}
                className="w-full rounded-xl bg-zinc-950 px-5 py-4 font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-300"
              >
                {orderBusy ? "Creando pedido..." : "Confirmar pedido"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================
          POPUP DE SELECCIÓN DE MESA

          Muestra todas las mesas activas de la sucursal.
          Las OCCUPIED son visibles, pero quedan deshabilitadas.
      ====================================================== */}

      {checkoutOpen &&
        orderType === "DINE_IN" &&
        !tableContext &&
        tableSelectorOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
            <div className="max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
                    Comer aquí
                  </p>

                  <h3 className="mt-1 text-2xl font-bold">Mesa opcional</h3>

                  <p className="mt-2 text-sm text-zinc-500">
                    Las mesas ocupadas se muestran como referencia, pero no
                    pueden seleccionarse.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setTableSelectorOpen(false)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-200 text-xl"
                >
                  ×
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setTableCode("");
                  setCheckoutError(null);
                  setTableSelectorOpen(false);
                }}
                className="mt-5 w-full rounded-2xl border border-zinc-300 bg-white p-4 text-left transition hover:border-zinc-950"
              >
                <p className="font-bold text-zinc-950">Continuar sin mesa</p>

                <p className="mt-1 text-sm text-zinc-500">
                  El personal podrá asignarte una mesa cuando llegues al local.
                </p>
              </button>

              <div className="mt-5 flex items-center justify-between gap-4 rounded-xl bg-zinc-50 px-4 py-3">
                <div className="text-sm">
                  <span className="font-semibold">
                    {
                      diningTables.filter(
                        (table) => table.availability === "AVAILABLE",
                      ).length
                    }
                  </span>{" "}
                  disponibles
                  {" · "}
                  <span className="font-semibold">
                    {
                      diningTables.filter(
                        (table) => table.availability === "OCCUPIED",
                      ).length
                    }
                  </span>{" "}
                  ocupadas
                </div>

                <button
                  type="button"
                  disabled={tablesLoading}
                  onClick={() => void loadDiningTables().catch(() => undefined)}
                  className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  {tablesLoading ? "Actualizando..." : "Actualizar"}
                </button>
              </div>

              {tablesError && (
                <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {tablesError}
                </div>
              )}

              {!tablesLoading && !tablesError && diningTables.length === 0 && (
                <div className="mt-5 rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">
                  No hay mesas configuradas para esta sucursal.
                </div>
              )}

              <div className="mt-6 space-y-6">
                {diningTableZones.map((zone) => (
                  <section key={zone}>
                    <h4 className="text-sm font-bold uppercase tracking-wider text-zinc-500">
                      {zone}
                    </h4>

                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {diningTables
                        .filter((table) => (table.zone || "Sin zona") === zone)
                        .map((table) => {
                          const available = table.availability === "AVAILABLE";

                          const selected = table.code === tableCode;

                          return (
                            <button
                              key={table.id}
                              type="button"
                              disabled={!available}
                              onClick={() => {
                                setTableCode(table.code);

                                setCheckoutError(null);

                                setTableSelectorOpen(false);
                              }}
                              className={`rounded-2xl border p-4 text-left transition ${
                                selected
                                  ? "border-zinc-950 bg-zinc-100"
                                  : available
                                    ? "border-zinc-200 bg-white hover:border-zinc-950"
                                    : "cursor-not-allowed border-zinc-200 bg-zinc-100 opacity-55"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <p className="font-bold">{table.name}</p>

                                  <p className="mt-1 text-xs text-zinc-500">
                                    {table.code}
                                  </p>
                                </div>

                                <span
                                  className={`rounded-full px-2 py-1 text-[10px] font-bold ${
                                    available
                                      ? "bg-green-100 text-green-700"
                                      : "bg-zinc-200 text-zinc-600"
                                  }`}
                                >
                                  {available ? "LIBRE" : "OCUPADA"}
                                </span>
                              </div>

                              <p className="mt-4 text-sm text-zinc-600">
                                Hasta {table.capacity} personas
                              </p>
                            </button>
                          );
                        })}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          </div>
        )}

      {/* =====================================================
          ACCESO AL PEDIDO ACTIVO CUANDO EL MODAL ESTÁ CERRADO
      ====================================================== */}

      {completedOrder && !orderModalOpen && (
        <div className="mx-auto max-w-6xl px-5 pt-5">
          <button
            type="button"
            onClick={() => setOrderModalOpen(true)}
            className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-semibold shadow-sm"
          >
            Ver pedido #{completedOrder.orderNumber}
            {" · "}
            {getCustomerOrderStatusLabel(completedOrder.status)}
          </button>
        </div>
      )}

      {/* =====================================================
          MODAL DE SEGUIMIENTO DEL PEDIDO
      ====================================================== */}

      {completedOrder && orderModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-7 text-center shadow-2xl">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 text-3xl">
              ✓
            </div>

            <p className="mt-5 text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Pedido recibido
            </p>

            <h2 className="mt-1 text-3xl font-bold">
              Pedido #{completedOrder.orderNumber}
            </h2>

            <p className="mt-3 text-zinc-600">
              Tu pedido fue registrado correctamente.
            </p>

            {completedOrder.status !== "COMPLETED" &&
              completedOrder.status !== "CANCELLED" && (
                <p className="mt-2 text-xs text-zinc-400">
                  Estado actualizado automáticamente cada 5 s
                </p>
              )}

            {completedOrder.paymentStatus !== "NOT_REQUIRED" && (
              <div className="mt-6 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-left">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                      Pago QR
                    </p>

                    <p className="mt-1 font-bold text-zinc-950">
                      {paymentPaid
                        ? "Pago confirmado"
                        : "Escanea para completar tu pedido"}
                    </p>
                  </div>

                  <span
                    className={`rounded-full px-3 py-1 text-xs font-bold ${
                      paymentPaid
                        ? "bg-green-100 text-green-700"
                        : activeQrAvailable
                          ? "bg-amber-100 text-amber-700"
                          : "bg-zinc-200 text-zinc-700"
                    }`}
                  >
                    {getCustomerPaymentStatusLabel(
                      completedOrder.paymentStatus,
                    )}
                  </span>
                </div>

                {paymentBusy && (
                  <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 text-center text-sm font-semibold text-zinc-600">
                    Generando un QR seguro...
                  </div>
                )}

                {paymentPaid && (
                  <div className="mt-4 rounded-xl border border-green-200 bg-green-50 p-4 text-center">
                    <p className="text-lg font-bold text-green-800">
                      Pago verificado
                    </p>

                    <p className="mt-1 text-sm text-green-700">
                      El pedido ya puede avanzar a preparación.
                    </p>
                  </div>
                )}

                {activeQrAvailable && orderPayment?.qrPayload && (
                  <>
                    <div className="mx-auto mt-4 w-fit rounded-2xl border border-zinc-200 bg-white p-4">
                      <QRCode
                        value={orderPayment.qrPayload}
                        size={192}
                        aria-label={`QR de pago del pedido ${completedOrder.orderNumber}`}
                      />
                    </div>

                    <p className="mt-4 text-center text-sm text-zinc-600">
                      Abre la aplicación de tu banco, escanea el código y
                      confirma el importe exacto.
                    </p>

                    <div className="mt-4 space-y-2 rounded-xl border border-zinc-200 bg-white p-3 text-sm">
                      <div className="flex justify-between gap-4">
                        <span className="text-zinc-500">Importe</span>

                        <span className="font-bold">
                          {orderPayment.currency}{" "}
                          {orderPayment.amount.toFixed(2)}
                        </span>
                      </div>

                      {orderPayment.externalReference && (
                        <div className="flex justify-between gap-4">
                          <span className="text-zinc-500">Referencia</span>

                          <span className="text-right font-mono text-xs font-bold">
                            {orderPayment.externalReference}
                          </span>
                        </div>
                      )}

                      {orderPayment.expiresAt && (
                        <div className="flex justify-between gap-4">
                          <span className="text-zinc-500">Válido hasta</span>

                          <span className="text-right font-semibold">
                            {formatOrderDateTime(orderPayment.expiresAt)}
                          </span>
                        </div>
                      )}
                    </div>

                    <p className="mt-3 text-center text-xs text-zinc-500">
                      Verificaremos el pago automáticamente. No cierres esta
                      ventana hasta recibir la confirmación.
                    </p>
                  </>
                )}

                {canGenerateQr && (
                  <div className="mt-4">
                    <p className="text-sm text-zinc-600">
                      {paymentExpired
                        ? "El QR anterior expiró. Genera uno nuevo para continuar."
                        : "Genera el código QR para realizar el pago."}
                    </p>

                    <button
                      type="button"
                      onClick={() =>
                        void prepareQrPayment(completedOrder.trackingToken)
                      }
                      className="mt-3 w-full rounded-xl bg-zinc-950 px-4 py-3 text-sm font-bold text-white"
                    >
                      {paymentExpired ? "Generar nuevo QR" : "Generar QR"}
                    </button>
                  </div>
                )}

                {!paymentBusy &&
                  !paymentPaid &&
                  !activeQrAvailable &&
                  !canGenerateQr && (
                    <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                      El pago requiere revisión de la sucursal antes de que el
                      pedido pueda avanzar.
                    </p>
                  )}

                {paymentError && (
                  <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    No se pudo actualizar el pago: {paymentError}
                  </div>
                )}
              </div>
            )}

            {/* =============================================
                  RESUMEN DEL PEDIDO
              ============================================== */}

            <div className="mt-6 rounded-2xl bg-zinc-50 p-5 text-left">
              <div className="flex justify-between">
                <span className="text-zinc-500">Modalidad</span>

                <span className="font-semibold">
                  {completedOrder.orderType === "DINE_IN" && "Comer aquí"}

                  {completedOrder.orderType === "TAKEAWAY" && "Para llevar"}

                  {completedOrder.orderType === "PICKUP" && "Recoger después"}

                  {completedOrder.orderType === "DELIVERY" && "Delivery"}
                </span>
              </div>

              {completedOrder.reservation && (
                <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3">
                  <div className="flex justify-between gap-4">
                    <span className="text-sky-700">Reserva</span>
                    <span className="text-right font-semibold text-sky-950">
                      {completedOrder.reservation.reservationCode}
                    </span>
                  </div>
                  <div className="mt-2 flex justify-between gap-4">
                    <span className="text-sky-700">Programado para</span>
                    <span className="text-right font-semibold text-sky-950">
                      {formatOrderDateTime(
                        completedOrder.reservation.reservedFor,
                      )}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-sky-800">
                    La mesa se ocupará cuando el personal registre tu llegada.
                  </p>
                </div>
              )}

              {/* ===========================================
                    FULFILLMENT DEL PEDIDO
                ============================================ */}

              {completedOrder.orderType === "DINE_IN" && (
                <div className="mt-3 flex justify-between gap-4">
                  <span className="text-zinc-500">Mesa</span>

                  <span className="text-right font-semibold">
                    {completedOrder.fulfillment.tableCode ||
                      "Sin mesa asignada"}
                  </span>
                </div>
              )}

              {completedOrder.orderType === "PICKUP" &&
                completedOrder.fulfillment.scheduledFor && (
                  <div className="mt-3 flex justify-between gap-4">
                    <span className="text-zinc-500">Retiro</span>

                    <span className="text-right font-semibold">
                      {formatOrderDateTime(
                        completedOrder.fulfillment.scheduledFor,
                      )}
                    </span>
                  </div>
                )}

              {(completedOrder.orderType === "PICKUP" ||
                completedOrder.orderType === "DELIVERY") &&
                completedOrder.fulfillment.customerName && (
                  <div className="mt-3 flex justify-between gap-4">
                    <span className="text-zinc-500">Cliente</span>

                    <span className="text-right font-semibold">
                      {completedOrder.fulfillment.customerName}
                    </span>
                  </div>
                )}

              {(completedOrder.orderType === "PICKUP" ||
                completedOrder.orderType === "DELIVERY") &&
                completedOrder.fulfillment.customerPhone && (
                  <div className="mt-3 flex justify-between gap-4">
                    <span className="text-zinc-500">Teléfono</span>

                    <span className="text-right font-semibold">
                      {completedOrder.fulfillment.customerPhone}
                    </span>
                  </div>
                )}

              {completedOrder.orderType === "DELIVERY" &&
                completedOrder.fulfillment.deliveryAddress && (
                  <div className="mt-3">
                    <p className="text-zinc-500">Dirección</p>

                    <p className="mt-1 font-semibold">
                      {completedOrder.fulfillment.deliveryAddress}
                    </p>
                  </div>
                )}

              {completedOrder.orderType === "DELIVERY" && (
                <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider text-sky-700">
                        Seguimiento del repartidor
                      </p>

                      <p className="mt-1 font-bold text-sky-950">
                        {deliveryLocation
                          ? getCustomerDeliveryStatusLabel(
                              deliveryLocation.delivery.status,
                            )
                          : "Consultando delivery..."}
                      </p>
                    </div>

                    <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-sky-800">
                      Cada 10 s
                    </span>
                  </div>

                  {deliveryLocation?.location ? (
                    <div className="mt-4 space-y-2 rounded-xl bg-white p-3 text-sm">
                      <div className="flex justify-between gap-4">
                        <span className="text-zinc-500">
                          Latitud
                        </span>

                        <span className="font-mono font-semibold">
                          {deliveryLocation.location.latitude.toFixed(
                            6,
                          )}
                        </span>
                      </div>

                      <div className="flex justify-between gap-4">
                        <span className="text-zinc-500">
                          Longitud
                        </span>

                        <span className="font-mono font-semibold">
                          {deliveryLocation.location.longitude.toFixed(
                            6,
                          )}
                        </span>
                      </div>

                      {deliveryLocation.location.accuracyMeters !==
                        null && (
                        <div className="flex justify-between gap-4">
                          <span className="text-zinc-500">
                            Precision
                          </span>

                          <span className="font-semibold">
                            {deliveryLocation.location.accuracyMeters.toFixed(
                              1,
                            )}{" "}
                            m
                          </span>
                        </div>
                      )}

                      <div className="border-t pt-2">
                        <p className="text-xs text-zinc-500">
                          Ultima ubicacion:{" "}
                          {formatOrderDateTime(
                            deliveryLocation.location.capturedAt,
                          )}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-sky-800">
                      {deliveryLocation
                        ? "La ubicacion del repartidor aun no esta disponible."
                        : "Consultando la ubicacion del repartidor..."}
                    </p>
                  )}

                  {deliveryLocationError && (
                    <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                      No se pudo actualizar la ubicacion:{" "}
                      {deliveryLocationError}
                    </p>
                  )}
                </div>
              )}

              {completedOrder.fulfillment.customerNotes && (
                <div className="mt-3">
                  <p className="text-zinc-500">Nota</p>

                  <p className="mt-1 text-sm font-medium">
                    {completedOrder.fulfillment.customerNotes}
                  </p>
                </div>
              )}

              <div className="mt-3 flex justify-between gap-4">
                <span className="text-zinc-500">Estado</span>

                <span className="text-right font-semibold">
                  {getCustomerOrderStatusLabel(completedOrder.status)}
                </span>
              </div>

              <div className="mt-3 flex justify-between gap-4">
                <span className="text-zinc-500">Pago</span>

                <span className="text-right font-semibold">
                  {getCustomerPaymentStatusLabel(completedOrder.paymentStatus)}
                </span>
              </div>

              {/* ===========================================
                    MENSAJE AMIGABLE DEL ESTADO ACTUAL
                ============================================ */}

              <p className="mt-3 text-sm text-zinc-600">
                {getCustomerOrderStatusMessage(
                  completedOrder.status,
                  completedOrder.paymentStatus,
                )}
              </p>

              <div className="mt-3 flex justify-between border-t pt-3">
                <span className="font-semibold">Total</span>

                <span className="text-xl font-bold">
                  {completedOrder.currency}{" "}
                  {completedOrder.totals.total.toFixed(2)}
                </span>
              </div>
            </div>

            {/* =============================================
                  LÍNEA DE PROGRESO DEL PEDIDO

                  IMPORTANTE:
                  Este bloque tiene UN solo elemento raíz (<div>).
                  No debe envolverse con otro `&& (` dejando comentarios
                  JSX como hermanos, porque eso rompe el parser TSX.
              ============================================== */}

            <div className="mt-6 text-left">
              <p className="mb-4 text-sm font-semibold text-zinc-700">
                Seguimiento
              </p>

              {completedOrder.status === "CANCELLED" ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                  <p className="font-semibold text-red-700">Pedido cancelado</p>

                  <p className="mt-1 text-sm text-red-600">
                    Este pedido fue cancelado.
                  </p>
                </div>
              ) : (
                <div className="space-y-0">
                  {CUSTOMER_ORDER_STEPS.map((step, index) => {
                    const currentIndex = getCustomerOrderStepIndex(
                      completedOrder.status,
                    );

                    const completed = index < currentIndex;

                    const current = index === currentIndex;

                    const reached = completed || current;

                    const isLast = index === CUSTOMER_ORDER_STEPS.length - 1;

                    return (
                      <div key={step.status} className="flex gap-3">
                        {/* =============================
                                MARCADOR + LÍNEA VERTICAL
                            ============================== */}

                        <div className="flex flex-col items-center">
                          <div
                            className={`flex h-8 w-8 items-center justify-center rounded-full border text-sm font-bold ${
                              reached
                                ? "border-green-200 bg-green-100 text-green-700"
                                : "border-zinc-300 bg-white text-zinc-400"
                            }`}
                          >
                            {completed ? "✓" : current ? "●" : "○"}
                          </div>

                          {!isLast && (
                            <div
                              className={`min-h-8 w-px flex-1 ${
                                completed ? "bg-green-300" : "bg-zinc-200"
                              }`}
                            />
                          )}
                        </div>

                        {/* =============================
                                TEXTO DE LA ETAPA
                            ============================== */}

                        <div className={isLast ? "pb-0" : "pb-5"}>
                          <p
                            className={`text-sm font-semibold ${
                              reached ? "text-zinc-950" : "text-zinc-400"
                            }`}
                          >
                            {step.label}
                          </p>

                          {current && (
                            <p className="mt-1 text-xs text-zinc-500">
                              Estado actual
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* =====================================================
                      ACCIÓN FINAL DEL PEDIDO

                      Pedido activo:
                        → solamente cerrar modal.

                      Pedido terminado/cancelado:
                        → finalizar seguimiento y limpiar localStorage.
                  ====================================================== */}

            <button
              type="button"
              onClick={() => {
                if (
                  completedOrder.status === "COMPLETED" ||
                  completedOrder.status === "CANCELLED"
                ) {
                  finalizeOrderTracking();

                  return;
                }

                setOrderModalOpen(false);
              }}
              className="mt-6 w-full rounded-xl bg-zinc-950 px-5 py-4 font-semibold text-white"
            >
              {completedOrder.status === "COMPLETED" ||
              completedOrder.status === "CANCELLED"
                ? "Finalizar seguimiento"
                : "Volver al menú"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
