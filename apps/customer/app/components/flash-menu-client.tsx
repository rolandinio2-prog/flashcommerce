"use client";
import { useResetOnChange } from '../../lib/use-reset-on-change';
import { type PendingCartAction, createCartActionQueue } from "./cart-action-queue";

import OrderConfirmation from './order-confirmation';
import Link from "next/link";
import DeliveryAddressMap from './delivery-address-map';
import RemoteDraftCard from './remote-draft-card';
import { clearCheckoutDraft } from '../../lib/checkout-draft';
import CustomerPageZoomGuard from './customer-page-zoom-guard';
import DeliveryQuoteSummary from './delivery-quote-summary';
import { usableDeliveryQuote, deliveryCheckoutError } from '../../lib/delivery-checkout';
import OrdersDialog from "./orders-dialog";
import vaultStyles from "./orders-history.module.css";
import { CatalogSection } from './catalog-section';
import { SauceCounter, SauceSelector, type SauceSummary } from './sauce-selector';
import CheckoutContact from './checkout-contact';
import RecoveryCodeInput from './recovery-code-input';
import { useAutomaticDeliveryQuote } from '../../lib/use-automatic-delivery-quote';
import CheckoutModeSelector from "./checkout-mode-selector";
import { orderConfirmationCopy } from "../../lib/checkout-presentation";
import { ProductCarouselThumbnails } from "./product-carousel-thumbnails";
import { OrderCart } from "./order-cart";
import { revealVisibleProduct, OrderProductCard, OrderButton, orderMoney } from "./order-product-card";
import orderStyles from "./order-design.module.css";
import { useEffect, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { pickupDateError } from "../../lib/pickup-date-validation";

import {
  FlashApiError, getCustomerRecoveryProfile, registerCustomerRecovery, updateCustomerRecoveryName, normalizeRecoveryContactPhone, recoveryAccessError, type CustomerRecoveryProfile,
  addCartItem,
  autocompleteDeliveryAddress,
  createCart,
  createOrder,
  quoteDeliveryCheckout,
  type DeliveryCheckoutPreview,
  createQrPayment,
  enrollCustomerRecovery,
  getCart,
  getCustomerRecoveryOrders,
  getDiningTableContext,
  getDiningTables,
  geocodeDeliveryAddress,
  getOrderDeliveryLocation,
  getOrderDeliveryPod,
  getOrderPayment,
  getOrderTracking,
  loginCustomerRecovery,
  linkCustomerRecoveryOrders,
  logoutCustomerRecovery,
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
  type PublicDeliveryPod,
  type TableReservation,
} from "../../lib/flash-api";

import TableReservationClient from "./table-reservation-client";

// =========================================================
// FLASH MENU - TIPOS LOCALES
// =========================================================

type IncludedRice = 'WHITE' | 'CHAUFA' | '';
function cartLineKey(id: string, rice: IncludedRice = '') { return rice ? `${id}:${rice}` : id; }
interface Product {
  baseProductId?: string;
  riceChoice?: IncludedRice;
  hasGarnishes?: boolean;
  garnishParentId?: string | null;
  garnishLabel?: string | null;
  garnishImageUrl?: string | null;
  garnishSortOrder?: number;

  hasPresentations?: boolean;
  presentationParentId?: string | null;
  presentationLabel?: string | null;
  presentationSortOrder?: number;

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
  lineTotal?: number;
  includedQuantity?: number;
  product: Product;
  quantity: number;
}

interface CustomerOrderVaultEntry {
  trackingToken: string;
  orderNumber: string;
  orderGroup?: string | null;
  orderType: FlashOrderType;
  tableCode: string | null;
  status: CreatedOrder["status"];
  paymentStatus: OrderPaymentStatus;
  currency: string;
  total: number;
  createdAt: string;
  savedAt: string;
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

  const [cart, updateCart] = useState<Record<string, CartItem>>({});
  const cartSnapshot = useRef<Record<string, CartItem>>({});
  function setCart(value: Record<string, CartItem>) { cartSnapshot.current = value; updateCart(value); }

  const [draftRestoring,setDraftRestoring]=useState(true);
  const [cartToken, updateCartToken] = useState<string | null>(null);
  const cartTokenRef = useRef<string | null>(null);
  function setCartToken(value: string | null) { cartTokenRef.current = value; updateCartToken(value); }

  const [cartReady, setCartReady] = useState(false);

  const [cartLoading, setCartBusy] = useState(false);
  const [pendingCartActions, setPendingCartActions] = useState<PendingCartAction[]>([]);
  const [cartUncertain, setCartUncertain] = useState(false);
  const cartBusy = cartLoading || cartUncertain || pendingCartActions.length > 0;

  const [cartError, setCartError] = useState<string | null>(null);
  const [cartActions] = useState(() => createCartActionQueue(setPendingCartActions, (_error, cancelled) => {
    setCartUncertain(true);
    setCartError('No pudimos confirmar el último cambio. Actualiza el pedido antes de continuar.' + (cancelled ? ' Las otras acciones pendientes no se enviaron.' : ''));
  }));
  useEffect(() => { cartActions.resume(); return () => cartActions.pause(); }, [cartActions]);

  const [cartOpen, setCartOpen] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [sauceRevealRequest, setSauceRevealRequest] = useState(0);
  const [serverSauces, setServerSauces] = useState<SauceSummary | null>(null);
  const [sizeRevealRequests,setSizeRevealRequests] = useState<Record<string,number>>({});

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
  const [, refreshPickupClock] = useState(0);
  // Wake when the selection expires or the customer returns; no periodic polling.
  useEffect(() => {
    if (!checkoutOpen || orderType !== "PICKUP") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer !== undefined) clearTimeout(timer);
      refreshPickupClock(value => value + 1);
      const remaining = new Date(scheduledFor).getTime() - Date.now();
      if (Number.isFinite(remaining) && remaining > 0) {
        timer = setTimeout(refresh, Math.min(remaining, 2147483647));
      }
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [checkoutOpen, orderType, scheduledFor]);
  const scheduledForError = pickupDateError(scheduledFor, Date.now());

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

  const [deliveryMapOpen, setDeliveryMapOpen] = useState(false);

  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Datos actuales del pedido seguido.
  const [completedOrder, setCompletedOrder] = useState<CreatedOrder | null>(
    null,
  );

  const [orderPayment, setOrderPayment] = useState<PaymentAttempt | null>(null);

  const [paymentBusy, setPaymentBusy] = useState(false);

  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [qrContact, setQrContact] = useState<{ token: string; phone: string } | null>(null);

  const [deliveryLocation, setDeliveryLocation] =
    useState<PublicDeliveryLocation | null>(null);

  const [deliveryLocationError, setDeliveryLocationError] =
    useState<string | null>(null);

  const [deliveryPod, setDeliveryPod] =
    useState<PublicDeliveryPod | null>(null);

  const [deliveryPodError, setDeliveryPodError] =
    useState<string | null>(null);

  // Controla solamente si el modal está abierto o cerrado.
  // El polling NO debe modificar este estado.
  const [orderModalOpen, setOrderModalOpen] = useState(false);

  // Token del pedido que el navegador está siguiendo.
  const [activeTrackingToken, setActiveTrackingToken] = useState<string | null>(
    null,
  );

  const [
    additionalOrderSourceTrackingToken,
    setAdditionalOrderSourceTrackingToken,
  ] = useState<string | null>(null);

  const [
    additionalDeliverySourceFulfillment,
    setAdditionalDeliverySourceFulfillment,
  ] = useState<{
    customerName: string;
    customerPhone: string;
    deliveryAddress: string;
  } | null>(null);

  const [orderVault, setOrderVault] = useState<CustomerOrderVaultEntry[]>([]);
  const [orderVaultOpen, setOrderVaultOpen] = useState(false);
  const [orderVaultBusy, setOrderVaultBusy] = useState(false);
  const [orderVaultError, setOrderVaultError] = useState<string | null>(null);

  const [customerRecoveryPhone, setCustomerRecoveryPhone] = useState("");
  const [customerRecoveryPin, setCustomerRecoveryPin] = useState("");
  const [
    customerRecoverySelectedTrackingToken,
    setCustomerRecoverySelectedTrackingToken,
  ] = useState("");
  const [customerRecoveryBusy, setCustomerRecoveryBusy] = useState(false);
  const [customerRecoveryError, setCustomerRecoveryError] =
    useState<string | null>(null);
  const [customerRecoveryMessage, setCustomerRecoveryMessage] =
    useState<string | null>(null);
  const [customerRecoveryAuthenticated, setCustomerRecoveryAuthenticated] =
    useState(false);
  const [checkoutProfile, setCheckoutProfile] = useState<CustomerRecoveryProfile | null>(null);
  const [registrationPin, setRegistrationPin] = useState('');
  const [contactMode, setContactMode] = useState<'recover'|'register'>('recover');
  const [editingContact, setEditingContact] = useState(false);
  const [registrationBusy, setRegistrationBusy] = useState(false);
  const [registrationLoading, setRegistrationLoading] = useState(true);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const registrationLock = useRef(false);
  const registrationMounted = useRef(false);
  const contactEdited = useRef(false);
  const normalizedRegistrationName = customerName.trim().replace(/\s+/g, ' ');
  const normalizedRegistrationPhone = normalizeRecoveryContactPhone(customerPhone);
  const sameProfilePhone = Boolean(checkoutProfile && checkoutProfile.tenantCode === catalog.tenant.code && normalizedRegistrationPhone === checkoutProfile.phone);
  const registrationNameValid = normalizedRegistrationName.length >= 2 && normalizedRegistrationName.length <= 120;
  const registrationPhoneValid = /^[0-9]{7,15}$/.test(normalizedRegistrationPhone);
  const registrationReady = registrationPhoneValid && (sameProfilePhone ? registrationNameValid && (!editingContact || /^[0-9]{6}$/.test(registrationPin)) : /^[0-9]{6}$/.test(registrationPin) && (contactMode === 'recover' || registrationNameValid));
  const registrationEnabled = checkoutOpen && Boolean(orderType) && orderType !== 'DINE_IN' && !draftRestoring && !orderBusy && !customerRecoveryBusy;
  const registrationSaved = !editingContact && registrationReady && sameProfilePhone && normalizedRegistrationName === checkoutProfile?.fullName && !registrationBusy && !registrationLoading && !registrationError;
  const registrationMessage = registrationLoading ? 'Verificando tus datos guardados…' : (contactMode === 'register' || sameProfilePhone) && !registrationNameValid ? 'Completa tu nombre completo.' : !registrationPhoneValid ? 'Ingresa un teléfono válido.' : !registrationReady ? 'Completa tu código de recuperación de 6 dígitos.' : 'Tus datos se guardarán automáticamente.';
  // This key stays in memory only. Versions invalidate a late result after edits,
  // draft restoration, checkout closure or a tenant change (including A -> B -> A).
  const registrationKey = JSON.stringify([catalog.tenant.code, customerName, customerPhone, registrationPin, contactMode, editingContact, checkoutOpen, orderType === 'DINE_IN', draftRestoring]);
  const registrationVersion = useRef({ key: registrationKey, value: 0 });
  if (registrationVersion.current.key !== registrationKey) {
    registrationVersion.current = { key: registrationKey, value: registrationVersion.current.value + 1 };
  }

  useEffect(() => {
    registrationMounted.current = true;
    return () => { registrationMounted.current = false; registrationVersion.current.value++; };
  }, []);

  useResetOnChange([catalog.tenant.code, checkoutOpen], () => setRegistrationLoading(true));
  useEffect(() => {
    let active = true;
    const version = registrationVersion.current.value;
    getCustomerRecoveryProfile(catalog.tenant.code).then(profile => {
      if (!active || version !== registrationVersion.current.value || profile.tenantCode !== catalog.tenant.code) return;
      setCheckoutProfile(profile); setRegistrationError(null); setRegistrationPin('');
      setCustomerRecoveryAuthenticated(true);
      setCustomerRecoveryPhone(profile.phone);
      if (!contactEdited.current || (!editingContact && normalizedRegistrationPhone === profile.phone)) {
        setCustomerName(profile.fullName);
        setCustomerPhone(profile.phone);
        setEditingContact(!profile.fullName);
      }
    }).catch(error => {
      if (!active) return;
      setCheckoutProfile(null); setCustomerRecoveryAuthenticated(false);
      if (!(error instanceof FlashApiError && error.status === 401)) setRegistrationError(recoveryAccessError(error));
    })
      .finally(() => { if (active) setRegistrationLoading(false); });
    return () => { active = false; };
  }, [catalog.tenant.code, checkoutOpen]);

  async function saveCheckoutRegistration() {
    if (registrationLock.current || registrationLoading || !registrationEnabled || !registrationReady) return;
    const version = registrationVersion.current.value;
    const tenant = catalog.tenant.code;
    const name = normalizedRegistrationName;
    const phone = normalizedRegistrationPhone;
    registrationLock.current = true;
    setRegistrationBusy(true); setRegistrationError(null);
    try {
      if (editingContact && sameProfilePhone) await updateCustomerRecoveryName(tenant, name, phone, registrationPin);
      else if (!sameProfilePhone && contactMode === 'recover') await loginCustomerRecovery(tenant, phone, registrationPin);
      else if (!sameProfilePhone) await registerCustomerRecovery(tenant, name, phone, registrationPin);
      // Enabling checkout requires a verified HttpOnly session, not just a POST success.
      const profile = await getCustomerRecoveryProfile(tenant);
      if (!registrationMounted.current) return;
      if (version !== registrationVersion.current.value) {
        setCheckoutProfile(null);
        setRegistrationError('Tus datos cambiaron durante el guardado. Revísalos y pulsa Reintentar.');
        return;
      }
      if (profile.tenantCode !== tenant || profile.phone !== phone || (editingContact && profile.fullName !== name)) throw new Error('Session could not be verified');
      setCheckoutProfile(profile); setCustomerName(profile.fullName); setCustomerPhone(profile.phone);
      setCustomerRecoveryPhone(profile.phone); setCustomerRecoveryAuthenticated(true); setRegistrationPin(''); setEditingContact(!profile.fullName);
    } catch (error) {
      if (!registrationMounted.current) return;
      if (error instanceof FlashApiError && error.status === 401) { setCheckoutProfile(null); setCustomerRecoveryAuthenticated(false); }
      setRegistrationError(recoveryAccessError(error));
    } finally {
      registrationLock.current = false;
      if (registrationMounted.current) setRegistrationBusy(false);
    }
  }

  useEffect(() => {
    if (editingContact || !registrationEnabled || !registrationReady || registrationSaved || registrationBusy || registrationLoading || registrationError) return;
    const timer = window.setTimeout(() => { void saveCheckoutRegistration(); }, 900);
    return () => window.clearTimeout(timer);
    // Input changes reset the debounce. A failed request requires an explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingContact, registrationKey, registrationEnabled, registrationReady, registrationSaved, registrationBusy, registrationLoading, registrationError]);

  useResetOnChange([orderVaultOpen, checkoutProfile?.phone, customerPhone], () => {
    if (orderVaultOpen) setCustomerRecoveryPhone(value => value || checkoutProfile?.phone || customerPhone);
  });

  const [orderAccessMessage, setOrderAccessMessage] = useState<string | null>(
    null,
  );

  // =========================================================
  // 3. CLAVES DE LOCALSTORAGE
  // =========================================================

  const [deliveryPreview, setDeliveryPreview] = useState<{ key: string; quote: DeliveryCheckoutPreview } | null>(null);
  const [deliveryQuoteBusy, setDeliveryQuoteBusy] = useState(false);
  const checkoutRequestBusy = useRef(false);
  const quoteRequestVersion = useRef(0);
  const [quoteEpoch, setQuoteEpoch] = useState(0);
  // Scope, products, contact and destination invalidate an outstanding preview.
  const deliveryPreviewKey = JSON.stringify([catalog.tenant.code, catalog.branch.code, cartToken, orderType,
    Object.values(cart).map(item => [item.product.id, item.quantity, item.product.price]).sort(),
    customerName.trim(), customerPhone.trim(), deliveryAddress.trim(), selectedDeliveryAddress,
    additionalOrderSourceTrackingToken, additionalDeliverySourceFulfillment]);
  useResetOnChange([deliveryPreviewKey], () => setDeliveryPreview(null));
  useEffect(() => {
    quoteRequestVersion.current += 1;
  }, [deliveryPreviewKey]);
  useEffect(() => {
    if (!deliveryPreview) return;
    const timer = window.setTimeout(() => {
      setDeliveryPreview(null);
      setQuoteEpoch(value => value + 1);
    }, Math.max(0, Date.parse(deliveryPreview.quote.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deliveryPreview]);
  const currentDeliveryQuote = usableDeliveryQuote(deliveryPreview?.quote ?? null, deliveryPreview?.key, deliveryPreviewKey)
    ? deliveryPreview!.quote : null;


  const storageKey = `flashcommerce.cartToken:${catalog.tenant.code}:${catalog.branch.code}`;

  const orderStorageKey = `flashcommerce.orderTracking:${catalog.tenant.code}:${catalog.branch.code}`;

  const additionalOrderStorageKey =
    `flashcommerce.additionalOrderSource:${catalog.tenant.code}:${catalog.branch.code}`;

  const orderVaultStorageKey =
    `flashcommerce.orderVault:v1:${catalog.tenant.code}:${catalog.branch.code}`;

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

  function readOrderVault(): CustomerOrderVaultEntry[] {
    const rawVault = window.localStorage.getItem(orderVaultStorageKey);

    if (!rawVault) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawVault);

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((entry): entry is CustomerOrderVaultEntry => {
          return Boolean(
            entry &&
              typeof entry === "object" &&
              typeof entry.trackingToken === "string" &&
              entry.trackingToken.length > 0 &&
              typeof entry.orderNumber === "string" &&
              typeof entry.orderType === "string" &&
              typeof entry.status === "string" &&
              typeof entry.paymentStatus === "string" &&
              typeof entry.currency === "string" &&
              typeof entry.total === "number" &&
              Number.isFinite(entry.total) &&
              typeof entry.createdAt === "string" &&
              typeof entry.savedAt === "string",
          );
        });
    } catch {
      return [];
    }
  }

  function writeOrderVault(entries: CustomerOrderVaultEntry[]): boolean {
    const deduplicated = Array.from(
      new Map(entries.map((entry) => [entry.trackingToken, entry])).values(),
    )
      .sort((left, right) => {
        const leftTime = new Date(left.createdAt || left.savedAt).getTime();
        const rightTime = new Date(right.createdAt || right.savedAt).getTime();

        return rightTime - leftTime;
      });

    setOrderVault(deduplicated);
    try {
      window.localStorage.setItem(
        orderVaultStorageKey,
        JSON.stringify(deduplicated),
      );

      setOrderVault(deduplicated);
      return true;
    } catch {
      setOrderVaultError(
        "No se pudo guardar Mis pedidos en este navegador.",
      );
      return false;
    }
  }

  function buildOrderVaultEntry(
    order: CreatedOrder,
    savedAt?: string,
  ): CustomerOrderVaultEntry {
    return {
      trackingToken: order.trackingToken,
      orderNumber: order.orderNumber,
      orderGroup: order.orderGroup,
      orderType: order.orderType,
      tableCode: order.fulfillment.tableCode ?? null,
      status: order.status,
      paymentStatus: order.paymentStatus,
      currency: order.currency,
      total: order.totals.total,
      createdAt: order.createdAt,
      savedAt: savedAt ?? new Date().toISOString(),
    };
  }

  function upsertOrderVaultOrder(order: CreatedOrder) {
    if (
      typeof order.trackingToken !== "string" ||
      order.trackingToken.length === 0
    ) {
      return;
    }

    const current = readOrderVault();
    const existing = current.find(
      (entry) => entry.trackingToken === order.trackingToken,
    );

    const nextEntry = buildOrderVaultEntry(order, existing?.savedAt);

    const changed =
      !existing ||
      existing.orderNumber !== nextEntry.orderNumber ||
      existing.orderGroup !== nextEntry.orderGroup ||
      existing.orderType !== nextEntry.orderType ||
      existing.tableCode !== nextEntry.tableCode ||
      existing.status !== nextEntry.status ||
      existing.paymentStatus !== nextEntry.paymentStatus ||
      existing.currency !== nextEntry.currency ||
      existing.total !== nextEntry.total ||
      existing.createdAt !== nextEntry.createdAt;

    if (!changed) {
      if (orderVault.length === 0 && current.length > 0) {
        setOrderVault(current);
      }

      return;
    }

    writeOrderVault([
      nextEntry,
      ...current.filter(
        (entry) => entry.trackingToken !== order.trackingToken,
      ),
    ]);
  }

  function removeOrderVaultEntry(trackingToken: string) {
    const current = readOrderVault();

    writeOrderVault(
      current.filter((entry) => entry.trackingToken !== trackingToken),
    );
  }

  async function openOrderVaultEntry(entry: CustomerOrderVaultEntry) {
    setOrderVaultBusy(true);
    setOrderVaultError(null);
    setOrderAccessMessage(null);

    try {
      const order = await getOrderTracking(entry.trackingToken);

      if (
        order.tenant.code !== catalog.tenant.code ||
        order.branch.code !== catalog.branch.code
      ) {
        throw new Error("El pedido pertenece a otra sucursal.");
      }

      upsertOrderVaultOrder(order);

      window.localStorage.setItem(orderStorageKey, order.trackingToken);

      setActiveTrackingToken(order.trackingToken);
      setCompletedOrder(order);
      setOrderPayment(null);
      setPaymentError(null);
      setDeliveryLocation(null);
      setDeliveryLocationError(null);
      setDeliveryPod(null);
      setDeliveryPodError(null);
      setOrderVaultOpen(false);
      setOrderModalOpen(true);
    } catch (error) {
      setOrderVaultError(
        `No se pudo abrir el pedido: ${getErrorMessage(error)}`,
      );
    } finally {
      setOrderVaultBusy(false);
    }
  }

  async function refreshOrderVault() {
    const current = readOrderVault();

    setOrderVault(current);
    setOrderVaultBusy(true);
    setOrderVaultError(null);

    try {
      const refreshed: CustomerOrderVaultEntry[] = [];

      for (const entry of current) {
        try {
          const order = await getOrderTracking(entry.trackingToken);

          if (
            order.tenant.code === catalog.tenant.code &&
            order.branch.code === catalog.branch.code
          ) {
            refreshed.push(buildOrderVaultEntry(order, entry.savedAt));
          } else {
            refreshed.push(entry);
          }
        } catch {
          // Un fallo temporal nunca destruye un acceso local guardado.
          refreshed.push(entry);
        }
      }

      writeOrderVault([...readOrderVault(), ...refreshed]);
    } finally {
      setOrderVaultBusy(false);
    }
  }

  function validateCustomerRecoveryCredentials(): {
    phone: string;
    pin: string;
  } | null {
    const phone = customerRecoveryPhone.trim();
    const pin = customerRecoveryPin.trim();

    if (!phone) {
      setCustomerRecoveryError("Ingresa tu teléfono.");
      return null;
    }

    if (!/^\d{6}$/.test(pin)) {
      setCustomerRecoveryError("El PIN debe tener exactamente 6 dígitos.");
      return null;
    }

    return { phone, pin };
  }

  async function syncCustomerRecoveryOrders(
    silent = false,
  ): Promise<number | null> {
    if (!silent) {
      setCustomerRecoveryError(null);
    }

    try {
      // A successful read proves the session before any local-order association.
      let page = await getCustomerRecoveryOrders(catalog.tenant.code, catalog.branch.code);
      const localTokens = readOrderVault().map(entry => entry.trackingToken);
      for (let index=0; index<localTokens.length; index+=100) {
        await linkCustomerRecoveryOrders(catalog.tenant.code, catalog.branch.code, localTokens.slice(index,index+100));
      }
      if (localTokens.length) page = await getCustomerRecoveryOrders(catalog.tenant.code, catalog.branch.code);
      const recovered: CustomerOrderVaultEntry[] = [];
      const seen = new Set<string>();
      for (;;) {
        for (const trackingToken of page.orderTrackingTokens) {
          try {
            const order = await getOrderTracking(trackingToken);
            if (order.tenant.code === catalog.tenant.code && order.branch.code === catalog.branch.code) {
              recovered.push(buildOrderVaultEntry(order));
            }
          } catch { /* Keep existing access if an individual order is temporarily unavailable. */ }
        }
        writeOrderVault([...readOrderVault(), ...recovered]);
        if (!page.nextCursor) break;
        if (seen.has(page.nextCursor)) throw new Error("No se pudo completar el historial. Vuelve a abrir Mis pedidos.");
        seen.add(page.nextCursor);
        page = await getCustomerRecoveryOrders(catalog.tenant.code, catalog.branch.code, page.nextCursor);
      }
      setCustomerRecoveryAuthenticated(true);

      return recovered.length;
    } catch (error) {
      setCustomerRecoveryAuthenticated(false);

      if (!silent) {
        setCustomerRecoveryError(
          `No se pudieron recuperar tus pedidos: ${getErrorMessage(error)}`,
        );
      }

      return null;
    }
  }

  async function handleEnrollCustomerRecovery() {
    const credentials = validateCustomerRecoveryCredentials();

    if (!credentials) {
      return;
    }

    const trackingToken =
      customerRecoverySelectedTrackingToken ||
      orderVault[0]?.trackingToken ||
      "";

    if (!trackingToken) {
      setCustomerRecoveryError(
        "Primero necesitas un pedido guardado en este navegador para activar la recuperación.",
      );
      return;
    }

    setCustomerRecoveryBusy(true);
    setCustomerRecoveryError(null);
    setCustomerRecoveryMessage(null);

    try {
      await enrollCustomerRecovery(
        trackingToken,
        credentials.phone,
        credentials.pin,
      );

      const recoveredCount = await syncCustomerRecoveryOrders(false);

      if (recoveredCount === null) {
        return;
      }

      setCustomerRecoveryMessage(
        recoveredCount === 1
          ? "Recuperación activada. Tu pedido ya puede recuperarse en otro navegador."
          : `Recuperación activada. ${recoveredCount} pedidos relacionados ya pueden recuperarse en otro navegador.`,
      );
    } catch (error) {
      setCustomerRecoveryError(
        `No se pudo activar la recuperación: ${getErrorMessage(error)}`,
      );
    } finally {
      setCustomerRecoveryBusy(false);
    }
  }

  async function handleLoginCustomerRecovery() {
    const credentials = validateCustomerRecoveryCredentials();

    if (!credentials) {
      return;
    }

    setCustomerRecoveryBusy(true);
    setCustomerRecoveryError(null);
    setCustomerRecoveryMessage(null);

    try {
      await loginCustomerRecovery(
        catalog.tenant.code,
        credentials.phone,
        credentials.pin,
      );

      setCustomerRecoveryPin('');
      try { const profile = await getCustomerRecoveryProfile(catalog.tenant.code); setCheckoutProfile(profile);
        setCustomerName(profile.fullName); setCustomerPhone(profile.phone); setEditingContact(!profile.fullName); setRegistrationPin(''); } catch { /* Orders still recover if profile fetch fails. */ }
      const recoveredCount = await syncCustomerRecoveryOrders(false);

      if (recoveredCount === null) {
        return;
      }

      setCustomerRecoveryMessage(
        recoveredCount === 1
          ? "Pedido recuperado en este navegador."
          : `${recoveredCount} pedidos recuperados en este navegador.`,
      );
    } catch (error) {
      setCustomerRecoveryError(recoveryAccessError(error));
    } finally {
      setCustomerRecoveryBusy(false);
    }
  }

  async function handleLogoutCustomerRecovery() {
    setCustomerRecoveryBusy(true);
    setCustomerRecoveryError(null);
    setCustomerRecoveryMessage(null);

    try {
      await logoutCustomerRecovery();
      setCheckoutProfile(null); setRegistrationPin(''); setEditingContact(false); setContactMode('recover'); setCustomerName(''); setCustomerPhone('');
      setCustomerRecoveryAuthenticated(false);
      setCustomerRecoveryMessage(
        "Sesión de recuperación cerrada. Los pedidos guardados en este navegador permanecen aquí.",
      );
    } catch (error) {
      setCustomerRecoveryError(
        `No se pudo cerrar la sesión de recuperación: ${getErrorMessage(error)}`,
      );
    } finally {
      setCustomerRecoveryBusy(false);
    }
  }

  async function shareOrderAccess(order: CreatedOrder) {
    const accessBase =
      `${window.location.origin}${window.location.pathname}${window.location.search}`;
    const accessUrl =
      `${accessBase}#order=${encodeURIComponent(order.trackingToken)}`;

    setOrderAccessMessage(null);

    try {
      if (typeof navigator.share === "function") {
        await navigator.share({
          title: `Pedido #${order.orderNumber}`,
          text: `Acceso al seguimiento del pedido #${order.orderNumber}`,
          url: accessUrl,
        });

        setOrderAccessMessage("Acceso compartido.");
        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(accessUrl);
        setOrderAccessMessage("Enlace de acceso copiado.");
        return;
      }

      window.prompt(
        "Copia este enlace para recuperar el pedido:",
        accessUrl,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      setOrderAccessMessage(
        `No se pudo compartir el acceso: ${getErrorMessage(error)}`,
      );
    }
  }

  function applyServerCart(serverCart: FlashCart) {
    const nextCart: Record<string, CartItem> = {};

    for (const item of serverCart.items) {
      const catalogProduct = findCatalogProduct(item.product.id);

      if (!catalogProduct) {
        continue;
      }

      nextCart[cartLineKey(item.product.id,item.riceChoice)] = {
        product: {
          ...catalogProduct,
          id: cartLineKey(item.product.id,item.riceChoice),
          baseProductId: item.product.id,
          riceChoice: item.riceChoice,
          name: item.product.name,

          // El precio del carrito viene del backend.
          price: item.unitPrice,
          currency: item.currency,
        },

        quantity: item.quantity,
        lineTotal: item.lineTotal,
        includedQuantity: item.includedQuantity,
      };
    }

    setCart(nextCart);
    setServerSauces(serverCart.summary.sauces ?? null);
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
    if (cartTokenRef.current) {
      return cartTokenRef.current;
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

  async function prepareQrPayment(trackingToken: string, phoneInput?: string) {
    const phone = (phoneInput ?? (
      completedOrder?.trackingToken === trackingToken
        ? completedOrder.fulfillment.customerPhone || (qrContact?.token === trackingToken ? qrContact.phone : '')
        : ''
    )).trim();
    if (!/^\+?[0-9 ()-]{7,25}$/.test(phone) || !/^[0-9]{7,15}$/.test(phone.replace(/\D/g, ''))) {
      setPaymentError('Ingresa un teléfono válido de 7 a 15 dígitos para generar el QR.');
      return;
    }
    setPaymentBusy(true);
    setPaymentError(null);

    try {
      const result = await createQrPayment(trackingToken, phone);

      setOrderPayment(result.payment);

      setCompletedOrder((currentOrder) => {
        if (!currentOrder || currentOrder.trackingToken !== trackingToken) {
          return currentOrder;
        }

        return {
          ...currentOrder,
          fulfillment: { ...currentOrder.fulfillment, customerPhone: currentOrder.fulfillment.customerPhone || phone },
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
    setCustomerName(checkoutProfile?.fullName ?? "");
    setCustomerPhone(checkoutProfile?.phone ?? "");
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

  useResetOnChange([orderType, deliveryAddress, selectedDeliveryAddress, catalog.tenant.code, catalog.branch.code], () => {
    const input = deliveryAddress.trim();
    setDeliveryAddressSearching(false);
    if (orderType !== "DELIVERY" || (selectedDeliveryAddress && selectedDeliveryAddress.formattedAddress.trim() === input) || input.length < 3) {
      setDeliveryAddressSuggestions([]);
      setDeliveryAddressError(null);
    }
  });
  useEffect(() => {
    if (orderType !== "DELIVERY") {
      return;
    }

    const normalizedInput = deliveryAddress.trim();

    if (
      selectedDeliveryAddress &&
      selectedDeliveryAddress.formattedAddress.trim() === normalizedInput
    ) {
      return;
    }

    if (normalizedInput.length < 3) {
      return;
    }

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
              : "No pudimos mostrar sugerencias. Puedes elegir el punto en el mapa o escribir la dirección completa y pulsar Calcular envío.",
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
      if (response.location.requiresMapConfirmation) {
        setDeliveryAddressError("Encontramos una ubicación aproximada. Ajusta el punto de entrega en el mapa.");
        setDeliveryMapOpen(true);
      }
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

    // eslint-disable-next-line react-hooks/set-state-in-effect -- starts loading a table context read from window.location (browser-only; SSR-safe)
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

        // El QR identifica solo la mesa/sesion fisica.
        // La propiedad del pedido sigue siendo del navegador
        // mediante su propio trackingToken persistido.
        // Nunca adoptar ni borrar aqui el pedido de otro cliente.
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
  }, [
    catalog.tenant.code,
    catalog.branch.code,
  ]);

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

      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrates the active order from localStorage after mount (browser-only; SSR-safe)
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

  useEffect(() => {
    const storedAdditionalSource =
      window.localStorage.getItem(additionalOrderStorageKey);

    if (
      !storedAdditionalSource ||
      storedAdditionalSource === "undefined" ||
      storedAdditionalSource === "null"
    ) {
      window.localStorage.removeItem(additionalOrderStorageKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrates the additional-order source from localStorage (browser-only; SSR-safe)
      setAdditionalOrderSourceTrackingToken(null);
      return;
    }

    setAdditionalOrderSourceTrackingToken(storedAdditionalSource);
  }, [additionalOrderStorageKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads "Mis pedidos" from localStorage after mount (browser-only; SSR-safe)
    setOrderVault(readOrderVault());
  }, [orderVaultStorageKey]);

  useEffect(() => {
    const match =
      /^#order=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
        window.location.hash,
      );

    if (!match) {
      return;
    }

    const trackingToken = match[1];
    let cancelled = false;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- starts loading an order shared via the #order= URL fragment (browser-only)
    setOrderVaultBusy(true);
    setOrderVaultError(null);

    void getOrderTracking(trackingToken)
      .then((order) => {
        if (cancelled) {
          return;
        }

        if (
          order.tenant.code !== catalog.tenant.code ||
          order.branch.code !== catalog.branch.code
        ) {
          throw new Error("El pedido pertenece a otra sucursal.");
        }

        upsertOrderVaultOrder(order);

        window.localStorage.setItem(orderStorageKey, order.trackingToken);

        setActiveTrackingToken(order.trackingToken);
        setCompletedOrder(order);
        setOrderPayment(null);
        setPaymentError(null);
        setDeliveryLocation(null);
        setDeliveryLocationError(null);
        setDeliveryPod(null);
        setDeliveryPodError(null);
        setOrderModalOpen(true);

        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search,
        );
      })
      .catch((error) => {
        if (!cancelled) {
          setOrderVaultError(
            `No se pudo recuperar el pedido guardado: ${getErrorMessage(error)}`,
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setOrderVaultBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    catalog.tenant.code,
    catalog.branch.code,
    orderStorageKey,
    orderVaultStorageKey,
  ]);

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
        upsertOrderVaultOrder(order);

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

  useResetOnChange([activeTrackingToken, completedOrder?.orderType], () => {
    if (!activeTrackingToken || completedOrder?.orderType !== "DELIVERY") {
      setDeliveryLocation(null);
      setDeliveryLocationError(null);
      setDeliveryPod(null);
      setDeliveryPodError(null);
    }
  });
  useEffect(() => {
    if (
      !activeTrackingToken ||
      completedOrder?.orderType !== "DELIVERY"
    ) {
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

        if (
          result.delivery.status ===
          "ARRIVED"
        ) {
          try {
            const podResult =
              await getOrderDeliveryPod(
                trackingToken,
              );

            if (stopped) {
              return;
            }

            setDeliveryPod(
              podResult,
            );

            setDeliveryPodError(null);
          } catch (error) {
            if (stopped) {
              return;
            }

            setDeliveryPod(null);

            setDeliveryPodError(
              getErrorMessage(error),
            );
          }
        } else {
          setDeliveryPod(null);
          setDeliveryPodError(null);
        }
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

  function canChangeCart() { return cartReady && !draftRestoring && !cartLoading && !cartUncertain && !orderBusy; }

  async function refreshCartAfterError() {
    if (cartLoading || cartActions.isBusy()) return;
    setCartBusy(true);
    try {
      if (cartTokenRef.current) await syncCart(cartTokenRef.current);
      setCartUncertain(false); setCartError(null); cartActions.resume();
    } catch (error) { setCartError('No se pudo actualizar el pedido: ' + getErrorMessage(error)); }
    finally { setCartBusy(false); }
  }

  function addProduct(product: Product, rice: IncludedRice = '') {
    if (!canChangeCart()) return;
    const accepted = cartActions.enqueue(cartLineKey(product.id, rice), 'add', async () => {
      const token = await ensureCartToken();
      await addCartItem(token, product.id, 1, rice);
      await syncCart(token);
    });
    if (accepted) setCartError(null);
  }

  function decreaseProduct(productId: string) {
    if (!canChangeCart()) return;
    const accepted = cartActions.enqueue(productId, 'decrease', async () => {
      const existing = cartSnapshot.current[productId], token = cartTokenRef.current;
      if (!existing || !token) return;
      if (existing.quantity <= 1) await removeCartItem(token, existing.product.baseProductId ?? productId, existing.product.riceChoice);
      else await updateCartItem(token, existing.product.baseProductId ?? productId, existing.quantity - 1, existing.product.riceChoice);
      await syncCart(token);
    });
    if (accepted) setCartError(null);
  }

  function removeProduct(productId: string) {
    if (!canChangeCart()) return;
    const accepted = cartActions.enqueue(productId, 'remove', async () => {
      const item = cartSnapshot.current[productId], token = cartTokenRef.current;
      if (!item || !token) return;
      await removeCartItem(token, item.product.baseProductId ?? productId, item.product.riceChoice);
      await syncCart(token);
    });
    if (accepted) setCartError(null);
  }

  // =========================================================
  // 9. CREAR PEDIDO
  //
  // Construye el fulfillment según la modalidad elegida.
  // Sólo enviamos al backend los campos que corresponden.
  // =========================================================

  async function submitOrder(intent: 'quote' | 'confirm' = 'confirm') {
    if (draftRestoring || checkoutRequestBusy.current || registrationLock.current) return;
    if (orderType && orderType !== 'DINE_IN' && !registrationSaved) {
      setCheckoutError('Completa tus datos y espera a que se confirme el guardado antes de continuar.');
      return;
    }
    if (sauceSummary.missing > 0) {
      setCheckoutError('Elige tus dos salsas incluidas antes de confirmar el pedido.');
      return;
    }
    if (orderType === 'DELIVERY' && selectedDeliveryAddress?.requiresMapConfirmation) {
      setCheckoutError('Ajusta el punto de entrega en el mapa antes de calcular el envío.');
      setDeliveryMapOpen(true);
      return;
    }
    if (intent === 'confirm' && orderType === 'DELIVERY' && !currentDeliveryQuote) {
      setCheckoutError('Espera a que se actualice el envío antes de confirmar.');
      return;
    }
    if (
      !cartToken ||
      !orderType ||
      cartBusy ||
      orderBusy ||
      deliveryAddressResolving
    ) {
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
      if (!customerName.trim() || !/^[+\d][\d\s()-]{6,24}$/.test(customerPhone.trim()) || !/^[0-9]{7,15}$/.test(customerPhone.replace(/\D/g, ""))) { setCheckoutError("Completa el nombre y un teléfono válido de 7 a 15 dígitos."); return; }
      fulfillment = {
        customerName: customerName.trim(), customerPhone: customerPhone.trim(),
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
      const normalizedName =
        customerName.trim();

      const normalizedPhone =
        customerPhone.trim();

      const normalizedAddress =
        deliveryAddress.trim();

      const sourceFulfillment =
        additionalDeliverySourceFulfillment;

      const isAdditionalDelivery =
        additionalOrderSourceTrackingToken !== null;

      const reusingSourceAddress =
        isAdditionalDelivery && !selectedDeliveryAddress?.selectedOnMap &&
        (
          !normalizedAddress ||
          (
            sourceFulfillment !== null &&
            normalizedAddress ===
              sourceFulfillment.deliveryAddress.trim()
          )
        );

      if (!normalizedName && !isAdditionalDelivery) {
        setCheckoutError(
          "Ingresa el nombre de quien recibirÃ¡ el pedido.",
        );

        return;
      }

      if (!normalizedPhone && !isAdditionalDelivery) {
        setCheckoutError(
          "Ingresa un telÃ©fono de contacto.",
        );

        return;
      }

      if (!normalizedAddress && !isAdditionalDelivery) {
        setCheckoutError(
          "Ingresa la direcciÃ³n de entrega.",
        );

        return;
      }

      if (reusingSourceAddress) {
        fulfillment = {
          customerName:
            normalizedName || undefined,

          customerPhone:
            normalizedPhone || undefined,

          customerNotes:
            customerNotes.trim() || undefined,
        };
      }
      else {
        let resolvedAddress =
          selectedDeliveryAddress;

        if (
          !resolvedAddress ||
          resolvedAddress.formattedAddress.trim() !==
            normalizedAddress
        ) {
          setDeliveryAddressResolving(true);
          setDeliveryAddressError(null);

          try {
            const response =
              await geocodeDeliveryAddress(
                catalog.tenant.code,
                catalog.branch.code,
                normalizedAddress,
              );

            if (!response.location) {
              setCheckoutError(
                "No pudimos ubicar esa direcciÃ³n. Agrega una referencia mÃ¡s precisa e intenta nuevamente.",
              );

              return;
            }

            resolvedAddress =
              response.location;

            setDeliveryAddress(
              response.location.formattedAddress,
            );

            setSelectedDeliveryAddress(
              response.location,
            );

            setDeliveryAddressSuggestions([]);
            if (response.location.requiresMapConfirmation) {
              setCheckoutError('Ubicación aproximada. Ajusta el punto de entrega en el mapa.');
              setDeliveryMapOpen(true);
            } else {
              setCheckoutError(null);
            }
            return;
          }
          catch (error) {
            const message =
              getErrorMessage(error);

            setCheckoutError(
              message ===
                "Delivery is not enabled for this branch"
                ? "Delivery todavÃ­a no estÃ¡ disponible en esta sucursal."
                : "No pudimos validar la direcciÃ³n en este momento. Revisa la direcciÃ³n e intenta nuevamente.",
            );

            return;
          }
          finally {
            setDeliveryAddressResolving(false);
          }
        }

        fulfillment = {
          customerName:
            normalizedName || undefined,

          customerPhone:
            normalizedPhone || undefined,

          deliveryAddress:
            resolvedAddress.formattedAddress,

          deliveryLatitude:
            resolvedAddress.location.latitude,

          deliveryLongitude:
            resolvedAddress.location.longitude,

          deliveryReference:
            resolvedAddress.placeId,

          customerNotes:
            customerNotes.trim() || undefined,
        };
      }
    }

    if (additionalOrderSourceTrackingToken) {
      if (
        orderType !== "DINE_IN" &&
        orderType !== "DELIVERY"
      ) {
        setCheckoutError(
          "El pedido adicional debe conservar la modalidad del pedido original.",
        );

        return;
      }

      fulfillment.additionalToTrackingToken =
        additionalOrderSourceTrackingToken;
    }

    if (intent === 'quote') {
      if (orderType !== 'DELIVERY') return;
      checkoutRequestBusy.current = true;
      setDeliveryQuoteBusy(true);
      setDeliveryPreview(null);
      const requestVersion = quoteRequestVersion.current;
      try {
        const quote = await quoteDeliveryCheckout(cartToken, fulfillment);
        if (requestVersion === quoteRequestVersion.current && quote.tenant === catalog.tenant.code && quote.branch === catalog.branch.code) {
          setDeliveryPreview({ key: deliveryPreviewKey, quote });
        }
      } catch (error) {
        if (requestVersion === quoteRequestVersion.current) setCheckoutError(deliveryCheckoutError(getErrorMessage(error)));
      } finally {
        checkoutRequestBusy.current = false;
        setDeliveryQuoteBusy(false);
      }
      return;
    }
    if (orderType !== 'DINE_IN' && !registrationSaved) {
      setRegistrationError('Verifica tus datos antes de confirmar el pedido.');
      setCheckoutError('Completa el registro en Tus datos y recuperación.'); return;
    }
    if (orderType !== 'DINE_IN') fulfillment.requireRecoveryProfile = true;
    if (orderType === 'DELIVERY') fulfillment.deliveryQuoteToken = currentDeliveryQuote!.quoteToken;
    checkoutRequestBusy.current = true;
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

        // Table and takeaway orders may not have contact data yet.
        // Ask in the payment card instead of creating a doomed payment attempt.
        const phone = order.fulfillment.customerPhone?.trim() || '';
        if (/^\+?[0-9 ()-]{7,25}$/.test(phone) && /^[0-9]{7,15}$/.test(phone.replace(/\D/g, ''))) {
          void prepareQrPayment(order.trackingToken, phone);
        }
      } else {
        console.error("Order created without trackingToken", order);
      }

      clearCheckoutDraft(window.localStorage, catalog.tenant.code, catalog.branch.code);
      // El carrito ya quedó CONVERTED en PostgreSQL.
      // Eliminamos solamente la referencia local del carrito.
      window.localStorage.removeItem(storageKey);
      window.localStorage.removeItem(additionalOrderStorageKey);
      setAdditionalOrderSourceTrackingToken(null);
      setAdditionalDeliverySourceFulfillment(null);

      setCompletedOrder(order);
      upsertOrderVaultOrder(order);
      setOrderModalOpen(true);

      setCheckoutOpen(false);
      setOrderType(null);

      resetFulfillmentForm();

      setReservationPreorder(null);
      setTableCode(tableContext?.table.code ?? "");

      setCart({});
      setCartToken(null);
    } catch (error) {
      setDeliveryPreview(null);
      if (error instanceof FlashApiError && error.status === 401) {
        setCheckoutProfile(null); setRegistrationError('La sesión venció. Ingresa tu código actual y guarda tus datos de nuevo.');
        setCheckoutError('Verifica tu código de recuperación antes de confirmar.');
      } else setCheckoutError(orderType === 'DELIVERY' ? deliveryCheckoutError(getErrorMessage(error)) : getErrorMessage(error));
    } finally {
      checkoutRequestBusy.current = false;
      setOrderBusy(false);
    }
  }

  function beginAdditionalOrder() {
    if (
      !completedOrder ||
      (
        completedOrder.orderType !== "DINE_IN" &&
        completedOrder.orderType !== "DELIVERY"
      )
    ) {
      return;
    }

    if (
      completedOrder.orderType === "DINE_IN" &&
      !tableContext
    ) {
      return;
    }

    const sourcePaid =
      completedOrder.paymentStatus === "PAID" ||
      orderPayment?.status === "PAID";

    if (!sourcePaid) {
      setPaymentError(
        "El pedido debe tener el pago verificado antes de crear un pedido adicional.",
      );

      return;
    }

    const isDelivery =
      completedOrder.orderType === "DELIVERY";

    const sourceTableCode =
      completedOrder.fulfillment.tableCode ??
      tableContext?.table.code ??
      "";

    const sourceDeliveryAddress =
      completedOrder.fulfillment.deliveryAddress ??
      "";

    const accepted = window.confirm(
      isDelivery
        ? "Realizar pedido adicional\n\n" +
            "Este serÃ¡ un nuevo pedido y tendrÃ¡ su propio pago.\n\n" +
            "Tu nuevo pedido intentarÃ¡ enviarse junto con tu pedido anterior mientras la entrega todavÃ­a no haya iniciado.\n\n" +
            "Todos los productos de una entrega conjunta esperarÃ¡n a estar listos antes de enviar al repartidor.\n\n" +
            "La direcciÃ³n actual se reutilizarÃ¡ por defecto. Si la cambias y seleccionas una nueva ubicaciÃ³n, el nuevo pedido se enviarÃ¡ en una entrega separada.\n\n" +
            "Â¿Deseas continuar?"
        : "Realizar pedido adicional\n\n" +
            "Este serÃ¡ un nuevo pedido y tendrÃ¡ su propio pago.\n\n" +
            "Los productos adicionales pueden estar listos en un momento diferente al pedido anterior.\n\n" +
            `Se mantendrÃ¡n asociados a tu consumo en la Mesa ${sourceTableCode}.\n\n` +
            "Â¿Deseas continuar?",
    );

    if (!accepted) {
      return;
    }

    upsertOrderVaultOrder(completedOrder);

    window.localStorage.setItem(
      additionalOrderStorageKey,
      completedOrder.trackingToken,
    );

    window.localStorage.removeItem(orderStorageKey);
    window.localStorage.removeItem(storageKey);

    setAdditionalOrderSourceTrackingToken(
      completedOrder.trackingToken,
    );

    setActiveTrackingToken(null);
    setCompletedOrder(null);
    setOrderPayment(null);
    setPaymentError(null);
    setDeliveryLocation(null);
    setDeliveryLocationError(null);
    setDeliveryPod(null);
    setDeliveryPodError(null);

    setCart({});
    setCartToken(null);

    resetFulfillmentForm();
    setReservationPreorder(null);

    if (isDelivery) {
      const sourceCustomerName =
        completedOrder.fulfillment.customerName ??
        "";

      const sourceCustomerPhone =
        completedOrder.fulfillment.customerPhone ??
        "";

      setAdditionalDeliverySourceFulfillment({
        customerName: sourceCustomerName,
        customerPhone: sourceCustomerPhone,
        deliveryAddress: sourceDeliveryAddress,
      });

      setOrderType("DELIVERY");
      setCustomerName(sourceCustomerName);
      setCustomerPhone(sourceCustomerPhone);
      setDeliveryAddress(sourceDeliveryAddress);
      setSelectedDeliveryAddress(null);
    }
    else {
      setAdditionalDeliverySourceFulfillment(null);
      setOrderType("DINE_IN");
      setTableCode(sourceTableCode);
    }

    setCheckoutOpen(false);
    setOrderModalOpen(false);
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
    if (completedOrder) {
      upsertOrderVaultOrder(completedOrder);
    }

    // Eliminamos solamente el puntero de seguimiento activo.
    // El pedido permanece dentro de Mis pedidos.
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
    setDeliveryPod(null);
    setDeliveryPodError(null);

    // Cerramos el modal.
    setOrderModalOpen(false);
  }

  const normalizedSearch = catalogSearch.trim().toLocaleLowerCase("es");
  const visibleCategories = catalog.categories.map((category) => ({
    ...category,
    products: category.products.filter((product) => !product.presentationParentId && !product.garnishParentId && (
      `${product.name} ${product.description ?? ""}`.toLocaleLowerCase("es").includes(normalizedSearch) || category.products.some(child => child.presentationParentId === product.id && `${child.name} ${child.presentationLabel ?? ""}`.toLocaleLowerCase("es").includes(normalizedSearch)))),
  })).filter((category) => category.products.length > 0);
  const cartItems = Object.values(cart);

  const totalItems = cartItems.reduce(
    (total, item) => total + item.quantity,
    0,
  );

  const totalAmount = cartItems.reduce(
    (total, item) => total + (item.lineTotal ?? item.product.price * item.quantity),
    0,
  );

  const sauceProducts = visibleCategories.filter(category => category.slug === 'salsas').flatMap(category => category.products);
  const sauceSummary: SauceSummary = cartItems.length && serverSauces ? serverSauces : {
    selected: 0, includedLimit: catalog.tenant.code === 'POLLO001' && catalog.branch.code === 'SUC001' ? 2 : 0, included: 0, extra: 0, extraTotal: 0, missing: 0, discountTotal: 0,
  };


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
        ? Boolean(customerName.trim() && /^[0-9]{7,15}$/.test(customerPhone.replace(/\D/g, "")))
        : orderType === "PICKUP"
          ? Boolean(!scheduledForError && customerName.trim() && customerPhone.trim())
          : orderType === "DELIVERY"
            ? Boolean(
                customerName.trim() &&
                customerPhone.trim() &&
                deliveryAddress.trim(),
              )
            : false;

  useAutomaticDeliveryQuote({
    inputKey: deliveryPreviewKey + ':' + quoteEpoch,
    open: checkoutOpen,
    enabled: orderType === 'DELIVERY' && registrationSaved && checkoutFulfillmentValid && /^[0-9]{7,15}$/.test(customerPhone.replace(/\D/g, '')) && cartReady && !draftRestoring && !cartBusy && !orderBusy && !deliveryQuoteBusy && !deliveryAddressResolving && !deliveryMapOpen && !selectedDeliveryAddress?.requiresMapConfirmation && cartItems.length > 0 && sauceSummary.missing === 0 && !currentDeliveryQuote,
    calculate: () => submitOrder('quote'),
  });

  const confirmationCopy = completedOrder
    ? orderConfirmationCopy(completedOrder.status, completedOrder.paymentStatus)
    : null;

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

  function renderCategory(category: Category, showTitle = true) {
    return (<section className={orderStyles.category} id={`menu-category-${category.id}`} key={category.id}>
              {showTitle && <h2 className="mb-5 text-2xl font-black tracking-tight">{category.name.trim().toLocaleLowerCase("es") === "guarniciones" ? "Guarniciones (Extras)" : category.name}</h2>}

              <div className={["guarniciones", "bebidas", "jugos"].includes(category.name.trim().toLocaleLowerCase("es")) ? `${orderStyles.sideCatalogGrid} ${["bebidas", "jugos"].includes(category.name.trim().toLocaleLowerCase("es")) ? orderStyles.beverageGrid : ""}` : orderStyles.catalogGrid} data-product-carousel={!["guarniciones", "bebidas", "jugos"].includes(category.name.trim().toLocaleLowerCase("es")) ? "true" : undefined} role="region" aria-label={"Productos de " + category.name} tabIndex={0}
                onScroll={(event) => {
                  if (category.slug !== 'pollos') return;
                  revealVisibleProduct(event.currentTarget,id => setSizeRevealRequests(current => ({...current,[id]:(current[id] ?? 0)+1})));
                }}>
                {category.products.map((product) => {
                  const cartItem = cart[product.id];

                  return (
                    <OrderProductCard
                      belowPhoto={!["guarniciones", "bebidas", "jugos"].includes(category.name.trim().toLocaleLowerCase("es")) ? <ProductCarouselThumbnails products={category.products} currentId={product.id} /> : undefined}
                      compact={["guarniciones", "bebidas", "jugos"].includes(category.name.trim().toLocaleLowerCase("es"))}

                      expandSizesRequest={sizeRevealRequests[product.id] ?? 0}
                      requiresRice={category.slug === 'pollos'}
                      riceQuantities={Object.fromEntries(Object.entries(cart).map(([key,item]) => [key,item.quantity]))}
                      totalQuantities={Object.values(cart).reduce<Record<string,number>>((counts,item)=>{const id=item.product.baseProductId ?? item.product.id;counts[id]=(counts[id] ?? 0)+item.quantity;return counts;},{})}
                      presentations={catalog.categories.flatMap(group => group.products).filter(child => child.presentationParentId === product.id).sort((a,b) => (a.presentationSortOrder ?? 0) - (b.presentationSortOrder ?? 0)).map(child => ({product:child,label:child.presentationLabel ?? child.name,quantity:cart[child.id]?.quantity ?? 0}))}
                      onAddPresentation={(id,rice) => {const selected=findCatalogProduct(id);if(selected)void addProduct(selected,rice);}}
                      onDecreasePresentation={(id,rice) => void decreaseProduct(cartLineKey(id,rice))}
                      key={product.id}
                      product={product}
                      quantity={cartItem?.quantity ?? 0}
                      ready={cartReady && !draftRestoring && !cartUncertain}
                      busy={cartLoading} pendingActions={pendingCartActions}
                      onAdd={() => void addProduct(product)}
                      onDecrease={() => void decreaseProduct(product.id)}
                    />
                  );
                })}
              </div>
            </section>);
  }

  function showSauces() {
    setCatalogSearch('');
    setCartOpen(false);
    setCheckoutOpen(false);
    setSauceRevealRequest(value => value + 1);
    requestAnimationFrame(() => {
      const section = document.getElementById('menu-sauces');
      section?.scrollIntoView({ block: 'center', behavior: 'auto' });
      section?.focus({ preventScroll: true });
    });
  }

  // =========================================================
  // 11. UI
  // =========================================================

  return (
    <main data-customer-order-page="true" className={`${orderStyles.scope} min-h-screen bg-gradient-to-b from-zinc-50 via-white to-zinc-50 pb-28 text-zinc-950`}>
      <CustomerPageZoomGuard />

      {deliveryMapOpen && checkoutOpen && orderType === 'DELIVERY' && <DeliveryAddressMap
        tenantCode={catalog.tenant.code} branchCode={catalog.branch.code} initial={selectedDeliveryAddress}
        onClose={() => setDeliveryMapOpen(false)}
        onSelect={address => {
          setSelectedDeliveryAddress(address); setDeliveryAddress(address.formattedAddress);
          setDeliveryAddressSuggestions([]); setDeliveryAddressError(null); setCheckoutError(null);
          setDeliveryPreview(null); setDeliveryMapOpen(false);
        }}
      />}

      <header className={orderStyles.catalogHeader}>
        <div className={orderStyles.catalogHeaderInner}>
          {catalog.tenant.code === "POLLO001" ? (
            <div className={orderStyles.restaurantBrand}>
              <h1><img src="/images/menu/mr-pollo-logo-v1.png" width="2170" height="725" alt="Mr. Pollo — Sabor que nos une" fetchPriority="high" /></h1>
              <p>{catalog.branch.name}</p>
            </div>
          ) : (
            <div className={orderStyles.restaurantBrand}>
              <h1>{catalog.tenant.name}</h1>
              <p>{catalog.branch.name}</p>
            </div>
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
            {cartUncertain && <button type="button" disabled={cartLoading} className="font-bold" onClick={() => void refreshCartAfterError()}>Actualizar pedido</button>}

            <button
              type="button"
              onClick={() => { if (!cartUncertain) setCartError(null); }}
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

      <div id="order-catalog" tabIndex={-1} className={`mx-auto max-w-6xl px-5 py-8 ${orderStyles.catalogAnchor} ${orderStyles.catalogCompact}`}>
        {visibleCategories.length === 0 && <p className={orderStyles.empty} role="status">{normalizedSearch ? "No encontramos productos con esa búsqueda." : "El menú estará disponible pronto."}</p>}
        <div className="space-y-10">
          {visibleCategories.filter(category => !['guarniciones','bebidas','jugos','salsas'].includes(category.slug)).map(category => renderCategory(category))}
          {visibleCategories.some(category => category.slug === 'guarniciones') && <CatalogSection title="Guarniciones" revealRequest={normalizedSearch ? 1 : 0}>
            {visibleCategories.filter(category => category.slug === 'guarniciones').map(category => renderCategory(category, false))}
          </CatalogSection>}
          {visibleCategories.some(category => ['bebidas','jugos'].includes(category.slug)) && <CatalogSection title="Bebidas y Jugos" revealRequest={normalizedSearch ? 1 : 0}>
            {visibleCategories.filter(category => ['bebidas','jugos'].includes(category.slug)).map(category => renderCategory(category))}
          </CatalogSection>}
          {sauceProducts.length > 0 && <div id="menu-sauces" tabIndex={-1} className={orderStyles.catalogAnchor}>
            <CatalogSection title="Salsas" revealRequest={sauceRevealRequest || (normalizedSearch ? 1 : 0)} summary={<SauceCounter summary={sauceSummary} />}>
              <SauceSelector includedQuantities={Object.fromEntries(cartItems.map(item => [item.product.baseProductId ?? item.product.id, item.includedQuantity ?? 0]))} products={sauceProducts} summary={sauceSummary} quantities={Object.fromEntries(cartItems.map(item => [item.product.baseProductId ?? item.product.id,item.quantity]))}
                ready={cartReady && !draftRestoring && !cartUncertain} busy={cartLoading} pendingActions={pendingCartActions} onAdd={product => { const original = findCatalogProduct(product.id); if (original) void addProduct(original); }} onDecrease={id => void decreaseProduct(id)} />
            </CatalogSection>
          </div>}
        </div>
      </div>

      {/* =====================================================
          BARRA INFERIOR DEL CARRITO
      ====================================================== */}

      {totalItems > 0 && (
        <div className={orderStyles.cartBar}>
          <div className={orderStyles.cartBarInner}>
            <div><p className={orderStyles.caption}>{totalItems} {totalItems === 1 ? "producto" : "productos"}</p>
              <p className={orderStyles.cartBarPrice}>{orderMoney(totalAmount, cartItems[0]?.product.currency ?? "BOB")}</p>
              <p className={orderStyles.caption} role="status">Subtotal de productos</p>
            </div>
            <OrderButton onClick={() => setCartOpen(true)}>Ver mi pedido</OrderButton>
          </div>
        </div>
      )}
      {cartOpen && <OrderCart
        items={cartItems} busy={cartBusy} pendingActions={pendingCartActions} onRefresh={cartUncertain ? refreshCartAfterError : undefined} refreshing={cartLoading} ready={cartReady && !draftRestoring && !cartUncertain} total={totalAmount}
        sauceSummary={sauceSummary} onChooseSauces={showSauces}
        currency={cartItems[0]?.product.currency ?? "BOB"} error={cartError}
        onClose={() => setCartOpen(false)}
        onAdd={(product) => { const original = findCatalogProduct(product.baseProductId ?? product.id); if (original) void addProduct(original,product.riceChoice); }}
        onDecrease={(id) => void decreaseProduct(id)} onRemove={(id) => void removeProduct(id)}
        onContinue={() => {
          if (cartActions.isBusy() || cartUncertain || cartLoading) return;
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
      />}

      {/* =====================================================
          MODAL DE CHECKOUT / FULFILLMENT
      ====================================================== */}

      {checkoutOpen && (
        <div className={orderStyles.checkoutOverlay}>
          <div className={orderStyles.checkoutPanel} role="dialog" aria-modal="true" aria-labelledby="checkout-title">
            <header className={orderStyles.checkoutHeader}>
            <button type="button" className={orderStyles.addMoreProducts} disabled={orderBusy || cartBusy}
              onClick={() => {
                setCheckoutOpen(false); setCartOpen(false); setCheckoutError(null);
                window.requestAnimationFrame(() => {
                  const catalog = document.getElementById('order-catalog');
                  catalog?.focus({preventScroll:true});
                  catalog?.scrollIntoView({block:'start',behavior:'instant'});
                });
              }}><span aria-hidden="true">+</span> Agregar más productos</button>
              <h2 id="checkout-title">Finalizar pedido</h2>
            </header>

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

            {orderType && orderType !== 'DINE_IN' && <CheckoutContact name={customerName} phone={customerPhone}
              mode={contactMode} onMode={mode => {contactEdited.current=true; setContactMode(mode); setRegistrationPin(''); setCustomerName(''); setRegistrationError(null); setEditingContact(false);}}
              editing={editingContact} onEdit={() => {setEditingContact(true); setRegistrationPin(''); setRegistrationError(null);}}
              onCancelEdit={() => {setCustomerName(checkoutProfile?.fullName ?? ''); setEditingContact(false); setRegistrationPin(''); setRegistrationError(null);}}
              onSaveEdit={() => void saveCheckoutRegistration()}
              onName={value => {contactEdited.current=true; setCustomerName(value);}}
              onPhone={value => {contactEdited.current=true; if(checkoutProfile){setCustomerName(''); setCheckoutProfile(null); setEditingContact(false);} setCustomerPhone(value); setRegistrationPin('');}}
              disabled={orderBusy || registrationBusy || registrationLoading} pin={registrationPin} onPin={setRegistrationPin}
              saved={registrationSaved} samePhone={sameProfilePhone} saving={registrationBusy} error={registrationError}
              pending={!editingContact && registrationReady && !registrationSaved && !registrationLoading && !registrationBusy && !registrationError}
              message={registrationMessage} retryDisabled={!registrationReady || registrationLoading || !registrationEnabled}
              onRetry={() => void saveCheckoutRegistration()}/>}
            <CheckoutModeSelector tenant={catalog.tenant.code} branch={catalog.branch.code} value={orderType} locked={Boolean(tableContext || reservationPreorder)}
              busy={orderBusy || cartBusy || registrationBusy}
              onChange={(mode) => {
                setOrderType(mode);
                setCheckoutError(null);
                if (mode === "DINE_IN" && !tableContext && !reservationPreorder) {
                  void loadDiningTables().catch(() => undefined);
                }
              }} />

            {/* ===============================================
                FORMULARIO DINÁMICO DE FULFILLMENT
            ================================================ */}

            {orderType && (
              <div className={orderStyles.checkoutSection}>
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
                        aria-invalid={Boolean(scheduledFor && scheduledForError)}
                        aria-describedby={scheduledFor && scheduledForError ? "scheduledFor-error" : undefined}
                        onChange={(event) =>
                          setScheduledFor(event.target.value)
                        }
                        className="mt-2 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 outline-none focus:border-zinc-950"
                      />
                      {scheduledFor && scheduledForError && (
                        <p id="scheduledFor-error" role="status" className="mt-2 text-sm text-red-700">
                          {scheduledForError}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {orderType === "DELIVERY" && (
                  <div className="space-y-4">

                    <div className="relative">
                      <label
                        htmlFor="deliveryAddress"
                        className="text-sm font-semibold"
                      >
                        Dirección de entrega
                      </label>

                      <div className={orderStyles.addressField}>
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

                      <button type="button"
                        onClick={() => { setDeliveryAddressSuggestions([]); setDeliveryMapOpen(true); }}
                        disabled={deliveryAddressResolving || orderBusy}
                        className={orderStyles.addressMapButton} aria-label="Elegir en el mapa">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg><span>Mapa</span>
                      </button>
                      </div>

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
                            {selectedDeliveryAddress.selectedOnMap ? 'Punto elegido en el mapa' : selectedDeliveryAddress.requiresMapConfirmation ? 'Ubicación aproximada: ajusta el punto' : 'Ubicación encontrada'}
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
                    {orderType === "DELIVERY" ? "Referencia / indicaciones (opcional)" : "Nota opcional"}
                  </label>

                  <textarea
                    id="customerNotes"
                    value={customerNotes}
                    onChange={(event) => setCustomerNotes(event.target.value)}
                    placeholder="Ej.: sin picante, llamar al llegar..."
                    rows={2}
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

            <div className={orderStyles.checkoutFooter}>
              {!currentDeliveryQuote && <div className="mb-4 flex justify-between">
                <span className="text-zinc-500">Subtotal de productos</span>

                <span className="text-xl font-bold">
                  {orderMoney(totalAmount, cartItems[0]?.product.currency ?? "BOB")}
                </span>
              </div>}

              {orderType === 'DELIVERY' && <DeliveryQuoteSummary
                quote={currentDeliveryQuote} busy={deliveryQuoteBusy || deliveryAddressResolving}
                waiting={!checkoutFulfillmentValid || !selectedDeliveryAddress || Boolean(selectedDeliveryAddress.requiresMapConfirmation)}
              />}
              {orderType !== 'DELIVERY' && <div className="mb-4 flex justify-between gap-3 border-t pt-3 text-lg font-bold">
                <span>Total general</span><span>{orderMoney(totalAmount, cartItems[0]?.product.currency ?? 'BOB')}</span>
              </div>}
              {sauceSummary.missing > 0 && <button type="button" className={orderStyles.secondary} onClick={showSauces}>Elegir mis {sauceSummary.missing} salsas incluidas pendientes</button>}
              <section className={orderStyles.checkoutPayment} aria-label="Forma de pago">
                <h3>Pagar con QR</h3>
                <div><strong>{orderType === 'DELIVERY' ? 'Un solo pago: pedido + envío' : 'Pago del pedido'}</strong>
                  <span>{orderType === 'DINE_IN'
                    ? 'Confirma el pedido y completa tu teléfono para generar el QR.'
                    : 'Al confirmar, registraremos tu pedido y generaremos el QR por el total general.'}</span>
                </div>
              </section>
              <button
                type="button"
                disabled={
                  !orderType ||
                  !checkoutFulfillmentValid ||
                  (orderType !== 'DINE_IN' && !registrationSaved) ||
                  !cartReady || draftRestoring || cartItems.length === 0 || sauceSummary.missing > 0 ||
                  deliveryQuoteBusy ||
                  (orderType === "DELIVERY" && !currentDeliveryQuote) ||
                  cartBusy ||
                  orderBusy ||
                  deliveryAddressResolving
                }
                onClick={() => void submitOrder()}
                className={orderStyles.primary}
              >
                {deliveryAddressResolving
                  ? "Validando dirección..."
                  : orderBusy
                    ? "Creando pedido..."
                    : orderType === 'DINE_IN'
                      ? 'Confirmar pedido'
                      : 'Confirmar y generar QR'}
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
          MIS PEDIDOS / CUSTOMER ORDER VAULT V1
      ====================================================== */}

      <div className="mx-auto max-w-6xl px-5 pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div>
            <p className="font-bold">Mis pedidos</p>

            <p className="text-xs text-zinc-500">
              {orderVault.length > 0
                ? `${orderVault.length} ${
                    orderVault.length === 1
                      ? "pedido guardado"
                      : "pedidos guardados"
                  } en este navegador`
                : "Recupera tus pedidos con teléfono y PIN."}
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              setOrderVaultOpen(true);
              void refreshOrderVault().then(() => syncCustomerRecoveryOrders(true));
            }}
            className="rounded-xl bg-zinc-950 px-4 py-3 text-sm font-semibold text-white"
          >
            {orderVault.length > 0
              ? `Mis pedidos (${orderVault.length})`
              : "Mis pedidos"}
          </button>
        </div>
      </div>

      {!tableContext && (
        <section className={orderStyles.reservationEntry} aria-labelledby="reserve-tables-title">
          <div><h2 id="reserve-tables-title">Reserva de mesas</h2><p>Elige cuándo venir y disfruta en el local.</p></div>
          <TableReservationClient
            restaurantName={catalog.tenant.code === "POLLO001" ? "Mr. Pollo" : catalog.tenant.name}
            branchName={catalog.branch.name}
            tenantCode={catalog.tenant.code}
            branchCode={catalog.branch.code}
            timeZone={catalog.branch.timezone}
            onProfileSaved={profile => {
              setCheckoutProfile(profile); setCustomerName(profile.fullName); setCustomerPhone(profile.phone);
              setCustomerRecoveryPhone(profile.phone); setCustomerRecoveryAuthenticated(true); setRegistrationPin(''); setEditingContact(!profile.fullName); setRegistrationError(null);
            }}
            onStartPreorder={startReservationPreorder}
          />
        </section>
      )}

      <div className={orderStyles.draftNotice}>
      <RemoteDraftCard compactNotice key={catalog.tenant.code+":"+catalog.branch.code} tenant={catalog.tenant.code} branch={catalog.branch.code} cartToken={cartToken}
        ready={cartReady} authenticated={customerRecoveryAuthenticated} onPendingChange={setDraftRestoring} busy={cartBusy || orderBusy || registrationBusy || tableContextLoading} completed={Boolean(completedOrder)}
        form={{orderType,customerName,customerPhone,deliveryAddress,selectedDeliveryAddress,customerNotes,scheduledFor}}
        items={Object.values(cart).map(item=>({name:item.product.name,quantity:item.quantity}))}
        onViewOrders={()=>setOrderVaultOpen(true)} onRestore={async (remote,isCurrent)=>{
          const serverCart=await getCart(remote.cartToken);
          if(!isCurrent())return;
          if(serverCart.status!=='OPEN'||Date.parse(serverCart.expiresAt)<=Date.now()||serverCart.tenant.code!==catalog.tenant.code||serverCart.branch.code!==catalog.branch.code)throw new Error('El carrito no está disponible en esta sucursal.');
          // Check cart scope and validity before replacing the active cart.
          const draft=remote.form;
          try{clearCheckoutDraft(window.localStorage,catalog.tenant.code,catalog.branch.code);}catch{/* Storage can be unavailable in private viewers. */}
          try{window.localStorage.setItem(storageKey,remote.cartToken);}catch{/* The private link works independently of browser persistence. */}
          setCartToken(remote.cartToken);applyServerCart(serverCart);
          contactEdited.current=true; setRegistrationPin('');
          setCustomerName(draft.customerName);setCustomerPhone(draft.customerPhone);setCustomerNotes(draft.customerNotes);
          setDeliveryAddress(draft.deliveryAddress);setSelectedDeliveryAddress(draft.selectedDeliveryAddress);
          setScheduledFor(draft.scheduledFor);setDeliveryPreview(null);setDeliveryAddressSuggestions([]);
          if(tableContext){setOrderType('DINE_IN');setTableCode(tableContext.table.code);}
          else if(reservationPreorder){setOrderType('DINE_IN');setTableCode(reservationPreorder.table.code);}
          else setOrderType(draft.orderType);
          setOrderModalOpen(false);setCartOpen(true);setCheckoutOpen(false);
        }} />
      </div>

      {orderVaultOpen && (
        <OrdersDialog onClose={() => {setOrderVaultOpen(false); setCustomerRecoveryPin('');}}>
          <p className={vaultStyles.intro}>Consulta el estado y continúa tus pedidos de {catalog.tenant.name} · {catalog.branch.name}.</p>
          {!orderVaultBusy && orderVault.length === 0 && <div className={vaultStyles.empty}>
            <h3>Aún no hay pedidos guardados aquí</h3>
            <p>Si pediste desde otro navegador, puedes recuperarlos con tu teléfono y PIN.</p>
          </div>}
            {orderVaultBusy && (
              <p className="mt-4 text-sm font-medium text-zinc-500">
                Actualizando pedidos...
              </p>
            )}

            {orderVaultError && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {orderVaultError}
              </div>
            )}

            <div className={vaultStyles.list}>
              {orderVault.map((entry) => (
                <article
                  key={entry.trackingToken}
                  className={vaultStyles.card}
                >
                  <div className={vaultStyles.cardTop}>
                    <div>
                      <p className="text-lg font-bold">
                        Pedido #{entry.orderNumber}
                      </p>
                      {entry.orderGroup &&
                        orderVault.some(
                          (candidate) =>
                            candidate.trackingToken !== entry.trackingToken &&
                            candidate.orderGroup === entry.orderGroup,
                        ) ? (
                          <p
                            className="mt-1 text-xs font-medium text-blue-700"
                            data-order-group-related="true"
                          >
                            Grupo de pedidos:{" "}
                            {[
                              `#${entry.orderNumber}`,
                              ...orderVault
                                .filter(
                                  (candidate) =>
                                    candidate.trackingToken !==
                                      entry.trackingToken &&
                                    candidate.orderGroup === entry.orderGroup,
                                )
                                .map(
                                  (candidate) =>
                                    `#${candidate.orderNumber}`,
                                ),
                            ].join(", ")}
                          </p>
                        ) : null}

                      <p className="mt-1 text-sm text-zinc-600">
                        {entry.orderType === "DINE_IN" && "Consumo en local"}
                        {entry.orderType === "TAKEAWAY" && "Para llevar"}
                        {entry.orderType === "PICKUP" && "Recoger después"}
                        {entry.orderType === "DELIVERY" && "Delivery"}
                        {entry.tableCode ? ` · Mesa ${entry.tableCode}` : ""}
                      </p>
                    </div>

                    <span className={vaultStyles.status} data-order-state={entry.status}>
                      {getCustomerOrderStatusLabel(entry.status)}
                    </span>
                  </div>

                  <div className="mt-3 flex items-center justify-between text-sm">
                    <span className={vaultStyles.payment} data-payment-state={entry.paymentStatus}>
                      {getCustomerPaymentStatusLabel(entry.paymentStatus)}
                    </span>

                    <span className={vaultStyles.amount}>
                      {orderMoney(entry.total, entry.currency)}
                    </span>
                  </div>

                  <p className="mt-2 text-xs text-zinc-400">
                    {new Date(entry.createdAt).toLocaleString("es-BO", {
                      timeZone: catalog.branch.timezone,
                    })}
                  </p>

                  <div className={vaultStyles.actions}>
                    <button
                      type="button"
                      disabled={orderVaultBusy}
                      onClick={() => void openOrderVaultEntry(entry)}
                      className={vaultStyles.primary}
                    >
                      Ver pedido
                    </button>

                    <button
                      type="button"
                      disabled={orderVaultBusy}
                      onClick={() => {
                        const confirmed = window.confirm(
                          `Quitar el pedido #${entry.orderNumber} de Mis pedidos?\n\nEl pedido no se borrará del restaurante.`,
                        );

                        if (confirmed) {
                          removeOrderVaultEntry(entry.trackingToken);
                        }
                      }}
                      className={vaultStyles.remove}
                    >
                      Quitar
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <details className={vaultStyles.recovery} open={orderVault.length === 0}>
              <summary>Proteger o recuperar mis pedidos</summary>

              <p className="mt-1 text-xs text-zinc-500">
                Si guardaste tus datos al finalizar el pedido, la recuperación ya está activada. Usa ese mismo teléfono y código cuando entres desde otro navegador.
              </p>

              {customerRecoveryAuthenticated ? (
                <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <p className="font-bold text-emerald-900">
                    Recuperación activa
                  </p>

                  {checkoutProfile && <p className="mt-2 text-sm text-emerald-900">{checkoutProfile.fullName && <strong>{checkoutProfile.fullName}<br/></strong>}{checkoutProfile.phone}</p>}
                  <p className="mt-1 text-sm text-emerald-800">
                    Tus pedidos pueden recuperarse en otros navegadores con tu
                    teléfono y PIN.
                  </p>

                  <button
                    type="button"
                    disabled={customerRecoveryBusy}
                    onClick={() => void handleLogoutCustomerRecovery()}
                    className="mt-3 rounded-xl border border-emerald-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
                  >
                    Cerrar recuperación
                  </button>
                </div>
              ) : (
                <>
                  <div className="mt-4 grid gap-3">
                    <label className="grid gap-1 text-sm font-medium">
                      Teléfono
                      <input
                        type="tel"
                        autoComplete="tel"
                        value={customerRecoveryPhone}
                        onChange={(event) => {
                          setCustomerRecoveryPhone(event.target.value);
                          setCustomerRecoveryPin('');
                          setCustomerRecoveryError(null);
                          setCustomerRecoveryMessage(null);
                        }}
                        placeholder="Tu número de teléfono"
                        className="rounded-xl border border-zinc-300 bg-white px-3 py-2 outline-none focus:border-zinc-500"
                      />
                    </label>

                    <div className="grid gap-1 text-sm font-medium">
                      <label htmlFor="order-recovery-code">Código de recuperación</label>
                      <RecoveryCodeInput id="order-recovery-code" value={customerRecoveryPin} disabled={customerRecoveryBusy} boxed
                        onChange={value => { setCustomerRecoveryPin(value); setCustomerRecoveryError(null); setCustomerRecoveryMessage(null); }}/>
                    </div>
                  </div>

                  {orderVault.length > 0 ? (
                    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4">
                      <p className="font-bold">¿Es la primera vez?</p>

                      <p className="mt-1 text-sm text-zinc-600">
                        Elige un pedido y activa la recuperación con el teléfono y PIN que ingresaste.
                      </p>

                      <label className="mt-3 grid gap-1 text-sm font-medium">
                        Pedido para activar recuperación
                        <select
                          value={
                            customerRecoverySelectedTrackingToken ||
                            orderVault[0]?.trackingToken ||
                            ""
                          }
                          onChange={(event) =>
                            setCustomerRecoverySelectedTrackingToken(
                              event.target.value,
                            )
                          }
                          className="rounded-xl border border-zinc-300 bg-white px-3 py-2 outline-none focus:border-zinc-500"
                        >
                          {orderVault.map((entry) => (
                            <option
                              key={entry.trackingToken}
                              value={entry.trackingToken}
                            >
                              Pedido #{entry.orderNumber}
                            </option>
                          ))}
                        </select>
                      </label>

                      <button
                        type="button"
                        disabled={customerRecoveryBusy}
                        onClick={() => void handleEnrollCustomerRecovery()}
                        className={vaultStyles.primary}
                      >
                        Activar recuperación
                      </button>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                      <p className="font-bold text-amber-900">
                        ¿Primera vez?
                      </p>

                      <p className="mt-1 text-sm text-amber-800">
                        Para activarla por primera vez, abre un enlace privado de tu pedido o usa el navegador donde lo realizaste. Si perdiste ambos accesos, solicita ayuda al comercio.
                      </p>
                    </div>
                  )}

                  <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4">
                    <p className="font-bold">
                      ¿Ya activaste la recuperación?
                    </p>

                    <p className="mt-1 text-sm text-zinc-600">
                      Ingresa el mismo teléfono y PIN para traer tus pedidos a
                      este navegador.
                    </p>

                    <button
                      type="button"
                      disabled={customerRecoveryBusy}
                      onClick={() => void handleLoginCustomerRecovery()}
                      className="mt-3 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
                    >
                      Recuperar mis pedidos
                    </button>
                  </div>
                </>
              )}

              {customerRecoveryBusy && (
                <p className="mt-3 text-sm font-medium text-zinc-500">
                  Verificando acceso...
                </p>
              )}

              {customerRecoveryError && (
                <p role="alert" className="mt-3 text-sm font-medium text-red-700">
                  {customerRecoveryError}
                </p>
              )}

              {customerRecoveryMessage && (
                <p role="status" className="mt-3 text-sm font-medium text-emerald-700">
                  {customerRecoveryMessage}
                </p>
              )}
            </details>


        </OrdersDialog>
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
        <OrderConfirmation key={completedOrder.trackingToken} order={completedOrder} delivery={deliveryLocation} paymentPaid={paymentPaid}
          payment={<>{completedOrder.paymentStatus !== "NOT_REQUIRED" && (
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

                {completedOrder.deliveryRelationship?.mode ===
                  "JOINED_EXISTING" && (
                    <div
                      className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-center"
                      data-delivery-relationship="JOINED_EXISTING"
                    >
                      <p className="font-bold text-blue-900">
                        Entrega conjunta
                      </p>

                      <p className="mt-1 text-sm text-blue-800">
                        Tu nuevo pedido se enviarÃ¡ junto con tu pedido anterior.
                      </p>

                      <p className="mt-1 text-xs text-blue-700">
                        El repartidor saldrÃ¡ cuando todos los productos de la entrega estÃ©n listos.
                      </p>
                    </div>
                  )}

                {completedOrder.deliveryRelationship?.mode ===
                  "SEPARATE_DELIVERY" && (
                    <div
                      className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-center"
                      data-delivery-relationship="SEPARATE_DELIVERY"
                    >
                      <p className="font-bold text-amber-900">
                        Entrega separada
                      </p>

                      <p className="mt-1 text-sm text-amber-800">
                        Este pedido tendrÃ¡ su propia entrega porque la entrega anterior ya iniciÃ³ o cambiÃ³ el destino.
                      </p>
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

                {paymentPaid &&
                  (
                    (
                      completedOrder.orderType === "DINE_IN" &&
                      tableContext
                    ) ||
                    completedOrder.orderType === "DELIVERY"
                  ) && (
                    <button
                      type="button"
                      onClick={beginAdditionalOrder}
                      className="mt-4 w-full rounded-xl border border-zinc-950 bg-zinc-950 px-4 py-3 text-sm font-bold text-white transition hover:bg-zinc-800"
                    >
                      Hacer pedido adicional
                    </button>
                  )}

                {activeQrAvailable && orderPayment?.qrPayload && (
                  <>
                    <div className="mx-auto mt-4 w-fit rounded-2xl border border-zinc-200 bg-white p-4">
                      {orderPayment.qrContentType === "IMAGE_BASE64" ? (
                        <img
                          src={`data:${
                            orderPayment.qrMimeType === "image/jpeg"
                              ? "image/jpeg"
                              : "image/png"
                          };base64,${orderPayment.qrPayload}`}
                          alt="QR de pago BCP"
                          width={192}
                          height={192}
                          className="block h-48 w-48 object-contain"
                        />
                      ) : (
                        <QRCode
                          value={orderPayment.qrPayload}
                          size={192}
                        />
                      )}
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

                    {!completedOrder.fulfillment.customerPhone?.trim() && (
                      <div className="mt-3">
                        <label htmlFor="qr-customer-phone" className="block text-sm font-semibold">Teléfono para el pago QR</label>
                        <input id="qr-customer-phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={25}
                          aria-describedby="qr-phone-help"
                          value={qrContact?.token === completedOrder.trackingToken ? qrContact.phone : ''}
                          onChange={(event) => setQrContact({ token: completedOrder.trackingToken, phone: event.target.value })}
                          className="mt-2 w-full min-w-0 rounded-xl border border-zinc-300 bg-white px-3 py-3 text-base"
                        />
                        <p id="qr-phone-help" className="mt-2 text-sm text-zinc-600">BCP solicita este dato para generar el QR de tu pedido.</p>
                      </div>
                    )}
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
            )}</>}
          summary={<div className="mt-6 rounded-2xl bg-zinc-50 p-5 text-left">
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

              {(completedOrder.orderType === "TAKEAWAY" || completedOrder.orderType === "PICKUP" ||
                completedOrder.orderType === "DELIVERY") &&
                completedOrder.fulfillment.customerName && (
                  <div className="mt-3 flex justify-between gap-4">
                    <span className="text-zinc-500">Cliente</span>

                    <span className="text-right font-semibold">
                      {completedOrder.fulfillment.customerName}
                    </span>
                  </div>
                )}

              {(completedOrder.orderType === "TAKEAWAY" || completedOrder.orderType === "PICKUP" ||
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

              <div className="mt-4 border-t pt-3">
                <h3 className="font-bold">Productos</h3>
                <ul className="mt-2 space-y-2" aria-label="Productos del pedido">
                  {completedOrder.items.map((item,index)=><li key={index} className="flex justify-between gap-3"><span>{item.quantity} × {item.product.name}</span><strong className="shrink-0">{orderMoney(item.lineTotal,completedOrder.currency)}</strong></li>)}
                </ul>
                <div className="mt-4 flex justify-between gap-3"><span>Subtotal de productos</span><strong>{orderMoney(completedOrder.totals.subtotal,completedOrder.currency)}</strong></div>
                {completedOrder.totals.discountTotal>0 && <div className="mt-2 flex justify-between gap-3"><span>Descuento</span><strong>−{orderMoney(completedOrder.totals.discountTotal,completedOrder.currency)}</strong></div>}
                {(completedOrder.orderType==='DELIVERY'||completedOrder.totals.deliveryFee>0) && <div className="mt-2 flex justify-between gap-3"><span>Envío</span><strong>{orderMoney(completedOrder.totals.deliveryFee,completedOrder.currency)}</strong></div>}
                <div className="mt-3 flex justify-between gap-3 border-t pt-3"><span className="font-bold">Total general</span><strong className="text-lg text-red-600">{orderMoney(completedOrder.totals.total,completedOrder.currency)}</strong></div>
              </div>
            </div>}
          tracking={<>{completedOrder.orderType === "DELIVERY" && (
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
                    <div className="mt-4 rounded-xl bg-white p-3 text-sm">
                      {deliveryLocation.route ? (
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <p className="text-xs text-zinc-500">
                              Distancia
                            </p>
                            <p className="font-bold text-sky-950">
                              {(deliveryLocation.route.distanceMeters / 1000).toFixed(
                                1,
                              )}{" "}
                              km
                            </p>
                          </div>

                          <div>
                            <p className="text-xs text-zinc-500">
                              Tiempo estimado
                            </p>
                            <p className="font-bold text-sky-950">
                              {Math.max(
                                1,
                                Math.round(
                                  deliveryLocation.route.durationSeconds / 60,
                                ),
                              )}{" "}
                              min
                            </p>
                          </div>
                        </div>
                      ) : null}

                      <p className="mt-3 border-t pt-2 text-xs text-zinc-500">
                        Ultima ubicacion: {formatOrderDateTime(
                          deliveryLocation.location.capturedAt,
                        )}
                      </p>
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

                  {activeTrackingToken ? (
                    <Link
                      href={`/track/${encodeURIComponent(
                        activeTrackingToken,
                      )}`}
                      className="mt-4 flex w-full justify-center rounded-xl bg-sky-700 px-4 py-3 text-sm font-black text-white"
                    >
                      Abrir mapa de seguimiento
                    </Link>
                  ) : null}
                </div>
              )}</>}
          attention={completedOrder.orderType==='DELIVERY' && deliveryLocation?.delivery.status==='ARRIVED' && (deliveryPod?.pod.status==='ACTIVE'||deliveryPodError) ? <>{completedOrder.orderType === "DELIVERY" &&
                deliveryLocation?.delivery.status === "ARRIVED" &&
                deliveryPod?.pod.status === "ACTIVE" && (
                  <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                      Codigo de entrega
                    </p>

                    <p className="mt-2 text-center font-mono text-4xl font-black tracking-[0.35em] text-emerald-950">
                      {deliveryPod.pod.code}
                    </p>

                    <p className="mt-2 text-sm text-emerald-800">
                      Indica este codigo al repartidor solamente cuando recibas tu pedido.
                    </p>
                  </div>
                )}
{completedOrder.orderType === "DELIVERY" &&
                deliveryLocation?.delivery.status === "ARRIVED" &&
                deliveryPodError && (
                  <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    No se pudo obtener el codigo de entrega:{" "}
                    {deliveryPodError}
                  </p>
                )}</> : null}
          accessMessage={orderAccessMessage}
          onShare={()=>{void shareOrderAccess(completedOrder);}}
          onClose={()=>{if(completedOrder.status==='COMPLETED'||completedOrder.status==='CANCELLED'){finalizeOrderTracking();return;}setOrderModalOpen(false);}}
        />
      )}
    </main>
  );
}
