import {announceStaffLogout} from './staff-session-lifecycle';
import {withReadDeadline} from './read-deadline';
export interface FlashCartProduct {
  id: string;
  sku: string | null;
  name: string;
}

export interface FlashCartItem {
  includedQuantity?: number;
  riceChoice?: 'WHITE' | 'CHAUFA' | '';
  product: FlashCartProduct;
  quantity: number;
  unitPrice: number;
  currency: string;
  lineTotal: number;
}

export interface FlashCart {
  revision: string;
  id: string;
  token: string;
  status: string;
  currency: string;
  expiresAt: string;

  tenant: {
    code: string;
    name: string;
  };

  branch: {
    code: string;
    name: string;
  };

  items: FlashCartItem[];

  summary: {
    sauces?: { selected: number; includedLimit: number; included: number; extra: number; extraTotal: number; missing: number; discountTotal: number };
    totalItems: number;
    total: number;
  };
}

export interface CreatedCart {
  id: string;
  token: string;
  status: string;
  currency: string;
  expiresAt: string;
  tenant: string;
  branch: string;
}

export interface CartMutationItem {
  productId?: string;

  product?: {
    id: string;
    sku: string | null;
    name: string;
  };

  quantity: number;
  unitPrice: number;
  currency: string;
  lineTotal: number;
}

export type FlashOrderType = "DINE_IN" | "TAKEAWAY" | "PICKUP" | "DELIVERY";

export type FlashOrderStatus =
  "PENDING" | "CONFIRMED" | "PREPARING" | "READY" | "COMPLETED" | "CANCELLED";

export type OrderPaymentStatus =
  | "NOT_REQUIRED"
  | "PENDING"
  | "AWAITING_CONFIRMATION"
  | "PAID"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "REVIEW_REQUIRED";

export type StaffRole =
  | "ADMIN"
  | "MANAGER"
  | "CASHIER"
  | "KITCHEN"
  | "WAITER";

export interface StaffSessionUser {
  sessionId: string;
  userId: string;
  tenantId: string;
  tenantCode: string;
  branchId: string;
  branchCode: string;
  userCode: string;
  firstName: string;
  lastName: string;
  displayName: string;
  role: StaffRole;
  passwordChangeRequired: boolean;
  expiresAt: string;
}

export interface StaffUserSummary {
  id: string;
  userCode: string;
  firstName: string;
  lastName: string;
  displayName: string;
  identityDocument: string | null;
  phone: string | null;
  email: string | null;
  role: StaffRole;
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
  lastLoginAt: string | null;
  passwordChangeRequired: boolean;
}

export interface DeliveryAdminDriverSummary {
  id: string;
  code: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  identityDocument: string | null;
  phone: string;
  email: string | null;
  vehiclePlate: string | null;
  status: "ACTIVE" | "INACTIVE";
  activeAssignments: number;
  passwordConfigured: boolean;
  passwordChangeRequired: boolean;
  sessionActive: boolean;
  createdAt: string;
}

export interface CreatedDeliveryDriverCredentials {
  driver: DeliveryAdminDriverSummary;
  credentials: {
    driverCode: string;
    temporaryPassword: string;
  };
}

export type StaffTrackingDeliveryStatus =
  | "PICKED_UP"
  | "EN_ROUTE"
  | "ARRIVED"
  | "DELIVERED";

export interface StaffTrackingDelivery {
  id: string;
  trackingToken: string;
  status: StaffTrackingDeliveryStatus;
  order: {
    id: string;
    orderNumber: string;
    status: FlashOrderStatus;
    paymentStatus: OrderPaymentStatus;
    currency: string;
    total: number;
  };
  recipient: { name: string; phone: string };
  destination: { address: string; reference: string | null };
  quote: {
    deliveryFee: number;
    distanceMeters: number | null;
    eta: { minMinutes: number | null; maxMinutes: number | null };
  };
  assignment: {
    id: string;
    number: number | null;
    status: string | null;
    assignedAt: string | null;
    acceptedAt: string | null;
    completedAt: string | null;
    driver: { id: string; code: string | null; name: string | null } | null;
  } | null;
  timeline: {
    pickedUpAt: string | null;
    enRouteAt: string | null;
    arrivedAt: string | null;
    deliveredAt: string | null;
  };
  latestGps: { capturedAt: string | null; receivedAt: string | null } | null;
  podVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StaffTrackingResponse {
  tenant: { id: string; code: string };
  branch: { id: string; code: string };
  generatedAt: string;
  summary: { active: number; delivered: number };
  active: StaffTrackingDelivery[];
  delivered: StaffTrackingDelivery[];
}

export type OrderOrigin =
  | "LEGACY"
  | "PUBLIC_MENU"
  | "TABLE_QR"
  | "BRANCH_QR"
  | "OPS_STAFF"
  | "RESERVATION_PREORDER"
  | "RESERVATION_CHECKIN";

export type PaymentAttemptStatus =
  | "CREATED"
  | "AWAITING_CONFIRMATION"
  | "PAID"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "REVIEW_REQUIRED";

// =========================================================
// FULFILLMENT
// =========================================================

export interface FlashOrderFulfillment {
  scheduledFor: string | null;
  customerName: string | null;
  customerPhone: string | null;
  tableCode: string | null;
  deliveryAddress: string | null;
  customerNotes: string | null;
}

export interface FlashOrderFulfillmentInput {
  requireRecoveryProfile?: boolean;
  deliveryQuoteToken?: string;
  scheduledFor?: string;
  customerName?: string;
  customerPhone?: string;
  tableCode?: string;
  tableContextToken?: string;
  reservationTrackingToken?: string;
  additionalToTrackingToken?: string;
  deliveryAddress?: string;
  deliveryLatitude?: number;
  deliveryLongitude?: number;
  deliveryReference?: string;
  customerNotes?: string;
}

// =========================================================
// DINING TABLES V0.1
// =========================================================

export type DiningTableAvailability = "AVAILABLE" | "OCCUPIED";

export interface DiningTable {
  id: string;
  code: string;
  name: string;
  capacity: number;
  zone: string | null;
  availability: DiningTableAvailability;
}

export interface DiningTablesResponse {
  tenant: string;
  branch: string;
  total: number;
  available: number;
  occupied: number;
  tables: DiningTable[];
}

export interface DiningTableContextResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  validOn: string;
  expiresAt: string;
  sessionBound: boolean;
  table: DiningTable;
}

export interface CreatedOrder {
  id: string;
  orderNumber: string;
  trackingToken: string;
  orderGroup: string | null;
  orderType: FlashOrderType;
  status: FlashOrderStatus;
  paymentStatus: OrderPaymentStatus;
  orderOrigin: OrderOrigin;
  currency: string;

  fulfillment: FlashOrderFulfillment;

  deliveryRelationship:
    | {
        mode:
          | "JOINED_EXISTING"
          | "SEPARATE_DELIVERY";
      }
    | null;

  reservation: {
    id: string;
    reservationCode: string;
    trackingToken?: string;
    reservedFor: string;
    table?: {
      id: string;
      code: string;
      name: string;
    };
  } | null;

  tenant: {
    code: string;
    name?: string;
  };

  branch: {
    code: string;
    name?: string;
  };

  items: Array<{
    product: {
      id: string;
      sku: string | null;
      name: string;
    };

    quantity: number;
    unitPrice: number;
    lineTotal: number;
    currency: string;
  }>;

  totals: {
    subtotal: number;
    discountTotal: number;
    deliveryFee: number;
    total: number;
  };

  tracking?: Array<{
    status: string;
    changedAt: string;
  }>;

  createdAt: string;
}

export interface PublicDeliveryLocation {
  routeIdentity?: string | null;
  routeStatus?: 'READY' | 'UNAVAILABLE' | 'MISSING_ORIGIN' | 'HIDDEN';
  branchOrigin?: {name: string; latitude: number; longitude: number} | null;
  order: {
    number: string;
    status: string;
    paymentStatus: string;
  };

  delivery: {
    status: string;
  };

  destination: {
    latitude: number;
    longitude: number;
  } | null;

  location: {
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
    headingDegrees: number | null;
    speedMps: number | null;
    capturedAt: string;
  } | null;

  route: {
    distanceMeters: number;
    durationSeconds: number;
    encodedPolyline: string;
  } | null;
}

function getApiUrl(): string {
  if (typeof window !== "undefined") {
    return "";
  }

  const apiUrl =
    process.env.FLASH_API_INTERNAL_URL?.trim() ||
    process.env.FLASH_API_URL?.trim();

  if (!apiUrl) {
    throw new Error(
      "FLASH_API_INTERNAL_URL or FLASH_API_URL is not configured",
    );
  }

  return apiUrl.replace(/\/+$/, "");
}

export class FlashApiError extends Error {
  constructor(message: string, public status: number, public retryAfterSeconds: number | null) { super(message); this.name = 'FlashApiError'; }
}

export function normalizeRecoveryContactPhone(value: string): string {
  return value.replace(/\D/g, '').replace(/^(?:00591|591)([67]\d{7})$/, '$1');
}

export function recoveryAccessError(error: unknown): string {
  if (error instanceof FlashApiError) {
    if (error.status === 429) return error.retryAfterSeconds
      ? 'Demasiados intentos. Espera ' + Math.ceil(error.retryAfterSeconds / 60) + ' minuto(s) antes de intentar de nuevo.'
      : 'Demasiados intentos. Espera unos minutos antes de intentar de nuevo.';
    if (error.status === 401) return 'Verifica tu telÃ©fono y cÃ³digo de recuperaciÃ³n. Si ya te registraste, usa tu cÃ³digo actual. Si la sesiÃ³n no se conserva, abre FastPay en Safari o Chrome.';
    if (error.status === 400) return 'Revisa tu nombre, telÃ©fono y cÃ³digo de 6 dÃ­gitos.';
    if (error.status === 409) return 'Esta cuenta necesita revisiÃ³n. Solicita ayuda al comercio.';
  }
  return 'No pudimos verificar el acceso en este momento. Comprueba tu conexiÃ³n. Tus pedidos existentes se conservan.';
}

export interface CustomerRecoveryProfile { fullName: string; phone: string; tenantCode: string; }
export function getCustomerRecoveryProfile(tenantCode: string) {
  return apiRequest<CustomerRecoveryProfile>('/api/v1/orders/recovery/profile?tenant=' + encodeURIComponent(tenantCode), {cache: 'no-store'});
}
export function registerCustomerRecovery(tenantCode: string, fullName: string, phone: string, pin?: string) {
  return apiRequest<{authenticated: boolean}>('/api/v1/orders/recovery/register', {method:'POST', body:JSON.stringify({tenantCode,fullName,phone,pin})});
}

export function updateCustomerRecoveryName(tenantCode: string, fullName: string, phone: string, pin: string) {
  return apiRequest<{authenticated: boolean}>('/api/v1/orders/recovery/profile/name', {method:'POST', body:JSON.stringify({tenantCode,fullName,phone,pin})});
}

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiUrl()}${path}`, {
    credentials: "same-origin",
    ...options,

    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `Flash API error: ${response.status}`;
    let retryAfterSeconds = Number(response.headers.get("Retry-After")) || null;

    try {
      const error = await response.json();
      if (Number.isFinite(error?.retryAfterSeconds) && error.retryAfterSeconds > 0) retryAfterSeconds = error.retryAfterSeconds;

      if (typeof error?.message === "string") {
        message = error.message;
      }
    } catch {
      // Conservamos el mensaje HTTP.
    }

    throw new FlashApiError(message, response.status, retryAfterSeconds);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const responseText = await response.text();

  if (!responseText.trim()) {
    return undefined as T;
  }

  return JSON.parse(responseText) as T;
}

export function createCart(
  tenantCode: string,
  branchCode: string,
): Promise<CreatedCart> {
  return apiRequest<CreatedCart>("/api/v1/carts", {
    method: "POST",

    body: JSON.stringify({
      tenantCode,
      branchCode,
    }),
  });
}

export function getCart(cartToken: string): Promise<FlashCart> {
  return apiRequest<FlashCart>(`/api/v1/carts/${cartToken}`);
}

export function addCartItem(
  cartToken: string,
  productId: string,
  quantity = 1,
  riceChoice?: 'WHITE' | 'CHAUFA' | '',
): Promise<CartMutationItem> {
  return apiRequest<CartMutationItem>(`/api/v1/carts/${cartToken}/items`, {
    method: "POST",

    body: JSON.stringify({
      productId,
      quantity,
      riceChoice,
    }),
  });
}

export function updateCartItem(
  cartToken: string,
  productId: string,
  quantity: number,
  riceChoice?: 'WHITE' | 'CHAUFA' | '',
): Promise<CartMutationItem> {
  return apiRequest<CartMutationItem>(
    `/api/v1/carts/${cartToken}/items/${productId}`,
    {
      method: "PATCH",

      body: JSON.stringify({
        quantity,
        riceChoice,
      }),
    },
  );
}

export function removeCartItem(
  cartToken: string,
  productId: string,
  riceChoice?: 'WHITE' | 'CHAUFA' | '',
): Promise<{
  removed: boolean;
  productId: string;
}> {
  return apiRequest<{
    removed: boolean;
    productId: string;
  }>(`/api/v1/carts/${cartToken}/items/${productId}?riceChoice=${encodeURIComponent(riceChoice ?? "")}`, {
    method: "DELETE",
  });
}

// =========================================================
// DIRECCIONES DE DELIVERY
// =========================================================

export interface DeliveryAddressSuggestion {
  placeId: string;
  text: string;
  mainText: string | null;
  secondaryText: string | null;
}

export interface DeliveryAddressLocation {
  requiresMapConfirmation?: boolean;
  selectedOnMap?: boolean;
  placeId: string;
  formattedAddress: string;

  location: {
    latitude: number;
    longitude: number;
  };
}

export interface DeliveryAddressAutocompleteResponse {
  tenant: string;
  branch: string;
  suggestions: DeliveryAddressSuggestion[];
}

export interface DeliveryAddressResolveResponse {
  tenant: string;
  branch: string;
  location: DeliveryAddressLocation;
}

export interface DeliveryAddressGeocodeResponse {
  tenant: string;
  branch: string;
  location: DeliveryAddressLocation | null;
}

export function getDeliveryMapContext(tenantCode: string, branchCode: string, signal?: AbortSignal) {
  return apiRequest<{ tenant: string; branch: string; center: { latitude: number; longitude: number } | null }>('/api/v1/delivery/address/map-context', {
    method: 'POST', signal, body: JSON.stringify({ tenantCode, branchCode }),
  });
}
export function reverseDeliveryAddress(tenantCode: string, branchCode: string, point: { latitude: number; longitude: number }, signal?: AbortSignal) {
  return apiRequest<DeliveryAddressGeocodeResponse>('/api/v1/delivery/address/reverse', {
    method: 'POST', signal, body: JSON.stringify({ tenantCode, branchCode, ...point }),
  });
}

export function autocompleteDeliveryAddress(
  tenantCode: string,
  branchCode: string,
  input: string,
  signal?: AbortSignal,
): Promise<DeliveryAddressAutocompleteResponse> {
  return apiRequest<DeliveryAddressAutocompleteResponse>(
    "/api/v1/delivery/address/autocomplete",
    {
      method: "POST",
      signal,

      body: JSON.stringify({
        tenantCode,
        branchCode,
        input,
      }),
    },
  );
}

export function resolveDeliveryAddress(
  tenantCode: string,
  branchCode: string,
  placeId: string,
  signal?: AbortSignal,
): Promise<DeliveryAddressResolveResponse> {
  return apiRequest<DeliveryAddressResolveResponse>(
    "/api/v1/delivery/address/resolve",
    {
      method: "POST",
      signal,

      body: JSON.stringify({
        tenantCode,
        branchCode,
        placeId,
      }),
    },
  );
}

export function geocodeDeliveryAddress(
  tenantCode: string,
  branchCode: string,
  address: string,
  signal?: AbortSignal,
): Promise<DeliveryAddressGeocodeResponse> {
  return apiRequest<DeliveryAddressGeocodeResponse>(
    "/api/v1/delivery/address/geocode",
    {
      method: "POST",
      signal,

      body: JSON.stringify({
        tenantCode,
        branchCode,
        address,
      }),
    },
  );
}
// =========================================================
// CREAR PEDIDO
// =========================================================

export interface DeliveryCheckoutPreview {
  quoteToken: string; expiresAt: string; coverage: true;
  tenant: string; branch: string; currency: string;
  zone: { code: string; name: string }; minimumOrder: number;
  subtotal: number; discountTotal: number; deliveryFee: number; total: number;
  eta: { minMinutes: number; maxMinutes: number };
  deliveryMode: 'JOINED_EXISTING' | 'SEPARATE_DELIVERY';
}
export function quoteDeliveryCheckout(cartToken: string, fulfillment: FlashOrderFulfillmentInput): Promise<DeliveryCheckoutPreview> {
  return apiRequest<DeliveryCheckoutPreview>('/api/v1/orders/delivery-quote', {
    method: 'POST', body: JSON.stringify({ ...fulfillment, cartToken, orderType: 'DELIVERY' }),
  });
}

export function createOrder(
  cartToken: string,
  orderType: FlashOrderType,
  fulfillment: FlashOrderFulfillmentInput = {},
): Promise<CreatedOrder> {
  return apiRequest<CreatedOrder>("/api/v1/orders", {
    method: "POST",

    body: JSON.stringify({
      cartToken,
      orderType,
      ...fulfillment,
    }),
  });
}

export function getOrderTracking(trackingToken: string, signal?: AbortSignal): Promise<CreatedOrder> {
  return withReadDeadline(readSignal => apiRequest<CreatedOrder>(`/api/v1/orders/track/${encodeURIComponent(trackingToken)}`, {cache:"no-store",signal:readSignal}), {signal});
}

// =========================================================
// RECUPERACION DURABLE DE PEDIDOS DEL CLIENTE
// =========================================================

export interface CustomerRecoveryEnrollmentResponse {
  authenticated: true;
  tenantCode: string;
  recoveredOrderCount: number;
}

export interface CustomerRecoveryLoginResponse {
  authenticated: true;
  tenantCode: string;
}

export interface CustomerRecoveryOrdersResponse {
  authenticated: true;
  tenantCode: string;
  branchCode: string;
  orderTrackingTokens: string[];
  nextCursor?: string | null;
}

export function enrollCustomerRecovery(
  trackingToken: string,
  phone: string,
  pin: string,
): Promise<CustomerRecoveryEnrollmentResponse> {
  return apiRequest<CustomerRecoveryEnrollmentResponse>(
    "/api/v1/orders/recovery/enroll",
    {
      method: "POST",
      body: JSON.stringify({
        trackingToken,
        phone,
        pin,
      }),
    },
  );
}

export function loginCustomerRecovery(
  tenantCode: string,
  phone: string,
  pin: string,
): Promise<CustomerRecoveryLoginResponse> {
  return apiRequest<CustomerRecoveryLoginResponse>(
    "/api/v1/orders/recovery/login",
    {
      method: "POST",
      body: JSON.stringify({
        tenantCode,
        phone,
        pin,
      }),
    },
  );
}

export function getCustomerRecoveryOrders(
  tenantCode: string,
  branchCode: string,
  cursor?: string,
): Promise<CustomerRecoveryOrdersResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<CustomerRecoveryOrdersResponse>(
    `/api/v1/orders/recovery/orders?${params.toString()}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    {
      cache: "no-store",
    },
  );
}

export function logoutCustomerRecovery(): Promise<{
  authenticated: false;
}> {
  return apiRequest<{
    authenticated: false;
  }>("/api/v1/orders/recovery/logout", {
    method: "POST",
  });
}

export function getOrderDeliveryLocation(
  trackingToken: string, signal?: AbortSignal,
): Promise<PublicDeliveryLocation> {
  return withReadDeadline(readSignal => apiRequest<PublicDeliveryLocation>(
    `/api/v1/orders/track/${encodeURIComponent(
      trackingToken,
    )}/delivery-location`,
    {
      cache: "no-store", signal: readSignal,
    },
  ), {signal});
}

// =========================================================
// PAGOS QR
// =========================================================

export interface PaymentOrderSummary {
  id: string;
  orderNumber: string;
  trackingToken: string;
  status: FlashOrderStatus;
  paymentStatus: OrderPaymentStatus;
  orderOrigin: OrderOrigin;
  total: number;
  currency: string;
  reservationId: string | null;
  reservationStatus: string | null;
}

export interface PaymentAttempt {
  id: string;
  attemptNumber: number;
  method: "QR" | "CASH";
  provider: string;
  status: PaymentAttemptStatus;
  amount: number;
  currency: string;
  externalReference: string | null;
  providerPaymentId: string | null;
  providerTransactionId: string | null;
  qrPayload: string | null;
  qrContentType: "TEXT" | "IMAGE_BASE64" | null;
  qrMimeType: "image/png" | "image/jpeg" | null;
  expiresAt: string | null;
  paidAt: string | null;
  verifiedAt: string | null;
  cashReceivedAmount?: number | null;
  cashChangeAmount?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateQrPaymentResponse {
  reused: boolean;
  order: PaymentOrderSummary;
  payment: PaymentAttempt;
}

export interface OrderPaymentResponse {
  order: PaymentOrderSummary;
  payment: PaymentAttempt | null;
}

export function createQrPayment(
  trackingToken: string,
  customerPhone?: string,
): Promise<CreateQrPaymentResponse> {
  return apiRequest<CreateQrPaymentResponse>(
    `/api/v1/payments/orders/${encodeURIComponent(trackingToken)}/qr`,
    {
      method: "POST",
      body: customerPhone ? JSON.stringify({ customerPhone }) : undefined,
    },
  );
}

export function getOrderPayment(
  trackingToken: string,
): Promise<OrderPaymentResponse> {
  return apiRequest<OrderPaymentResponse>(
    `/api/v1/payments/orders/${encodeURIComponent(trackingToken)}`,
  );
}

// =========================================================
// STAFF / OPERADORES
// =========================================================

export function getStaffBootstrapStatus(
  tenantCode: string,
  branchCode: string,
): Promise<{
  tenantCode: string;
  branchCode: string;
  bootstrapRequired: boolean;
}> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest(`/api/v1/staff/bootstrap-status?${params.toString()}`);
}

export interface CreatedStaffCredentials {
  user: StaffUserSummary;
  credentials: {
    userCode: string;
    temporaryPassword: string;
  };
}

export function bootstrapStaffAdmin(
  input: {
    tenantCode: string;
    branchCode: string;
    firstName: string;
    lastName: string;
    identityDocument?: string;
    phone?: string;
    email?: string;
  },
  opsAccessKey: string,
): Promise<CreatedStaffCredentials> {
  return apiRequest<CreatedStaffCredentials>(
    "/api/v1/staff/bootstrap-admin",
    {
      method: "POST",
      headers: {
        "X-Ops-Key": opsAccessKey,
      },
      body: JSON.stringify(input),
    },
  );
}

export function loginStaff(
  tenantCode: string,
  branchCode: string,
  userCode: string,
  password: string,
): Promise<{ authenticated: true; user: StaffSessionUser }> {
  return apiRequest("/api/v1/staff/auth/login", {
    method: "POST",
    body: JSON.stringify({
      tenantCode,
      branchCode,
      userCode,
      password,
    }),
  });
}

export function getStaffSession(signal?: AbortSignal): Promise<{
  authenticated: true;
  user: StaffSessionUser;
}> {
  return withReadDeadline(readSignal => apiRequest<{authenticated:true;user:StaffSessionUser}>("/api/v1/staff/auth/me", {cache:"no-store",signal:readSignal}), {signal});
}

export function getStaffTrackingDeliveries(): Promise<StaffTrackingResponse> {
  return apiRequest<StaffTrackingResponse>(
    "/api/v1/staff/tracking/deliveries",
  );
}

export interface StaffDeliveryHandoffResponse {
  changed: boolean;
  action: "PICKED_UP" | "UNCHANGED";
  delivery: {
    id: string;
    status: "PICKED_UP";
    pickedUpAt?: string;
  };
  order: {
    id: string;
    number: string;
    status: OperationalOrderStatus;
  };
  assignment: {
    id: string;
    number: number;
    status: string;
    acceptedAt: string | null;
    driver: {
      id: string;
      code: string;
      name: string;
    };
  };
}

export function handoffOperationalDelivery(
  deliveryId: string,
): Promise<StaffDeliveryHandoffResponse> {
  return apiRequest<StaffDeliveryHandoffResponse>(
    `/api/v1/staff/ops/deliveries/${encodeURIComponent(deliveryId)}/handoff`,
    {
      method: "PATCH",
    },
  );
}

export function changeStaffPassword(
  newPassword: string,
): Promise<{ changed: true; user: StaffSessionUser }> {
  return apiRequest("/api/v1/staff/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ newPassword }),
  });
}

export function recoverStaffAdmin(
  tenantCode: string,
  branchCode: string,
  userCode: string,
  opsAccessKey: string,
): Promise<{
  user: { userCode: string; displayName: string };
  credentials: { userCode: string; temporaryPassword: string };
}> {
  return apiRequest("/api/v1/staff/auth/recover-admin", {
    method: "POST",
    headers: {
      "X-Ops-Key": opsAccessKey,
    },
    body: JSON.stringify({ tenantCode, branchCode, userCode }),
  });
}

export function logoutStaff(): Promise<{ loggedOut: true }> {
  // Stop local readers before starting the one server logout request.
  // A failed request does not silently restore an old monitor.
  announceStaffLogout();
  return apiRequest("/api/v1/staff/auth/logout", {
    method: "POST",
  });
}

export function getStaffUsers(): Promise<{
  tenantCode: string;
  branchCode: string;
  users: StaffUserSummary[];
}> {
  return apiRequest("/api/v1/staff/users");
}

export function createStaffUser(input: {
  firstName: string;
  lastName: string;
  identityDocument?: string;
  phone?: string;
  email?: string;
  role: StaffRole;
}): Promise<CreatedStaffCredentials> {
  return apiRequest<CreatedStaffCredentials>("/api/v1/staff/users", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function resetStaffCredentials(
  userId: string,
): Promise<CreatedStaffCredentials> {
  return apiRequest<CreatedStaffCredentials>(
    `/api/v1/staff/users/${encodeURIComponent(userId)}/reset-credentials`,
    {
      method: "POST",
    },
  );
}

export function updateStaffUserStatus(
  userId: string,
  status: "ACTIVE" | "INACTIVE",
): Promise<{
  changed: boolean;
  user: {
    id: string;
    userCode: string;
    displayName: string;
    status: "ACTIVE" | "INACTIVE";
  };
}> {
  return apiRequest(
    `/api/v1/staff/users/${encodeURIComponent(userId)}/status`,
    {
      method: "PATCH",
      body: JSON.stringify({ status }),
    },
  );
}

// =========================================================
// REPARTIDORES / DELIVERY ADMIN
// =========================================================

export function getDeliveryAdminDrivers(): Promise<{
  tenantCode: string;
  branchCode: string;
  drivers: DeliveryAdminDriverSummary[];
}> {
  return apiRequest("/api/v1/staff/drivers");
}

export function createDeliveryAdminDriver(input: {
  firstName: string;
  lastName: string;
  identityDocument: string;
  phone: string;
  email?: string;
  vehiclePlate: string;
}): Promise<CreatedDeliveryDriverCredentials> {
  return apiRequest<CreatedDeliveryDriverCredentials>(
    "/api/v1/staff/drivers",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function updateDeliveryAdminDriverProfile(
  driverId: string,
  input: {
    firstName: string;
    lastName: string;
    identityDocument: string;
    phone: string;
    email?: string;
    vehiclePlate: string;
  },
): Promise<{ changed: true; driver: DeliveryAdminDriverSummary }> {
  return apiRequest(
    `/api/v1/staff/drivers/${encodeURIComponent(driverId)}/profile`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export function resetDeliveryAdminDriverCredentials(
  driverId: string,
): Promise<{
  driver: { id: string; code: string; displayName: string };
  credentials: { driverCode: string; temporaryPassword: string };
}> {
  return apiRequest(
    `/api/v1/staff/drivers/${encodeURIComponent(driverId)}/reset-credentials`,
    {
      method: "POST",
    },
  );
}

export function updateDeliveryAdminDriverStatus(
  driverId: string,
  status: "ACTIVE" | "INACTIVE",
): Promise<{ changed: true; driver: DeliveryAdminDriverSummary }> {
  return apiRequest(
    `/api/v1/staff/drivers/${encodeURIComponent(driverId)}/status`,
    {
      method: "PATCH",
      body: JSON.stringify({ status }),
    },
  );
}

// =========================================================
// PAGO EN EFECTIVO - SOLO OPERACIONES
// =========================================================

export interface ConfirmOperationalCashPaymentInput {
  cashReceivedAmount: string;
  terminalReference: string;
}

export interface ConfirmOperationalCashPaymentResponse {
  changed: boolean;
  order: PaymentOrderSummary;
  payment: PaymentAttempt;
}

export function confirmOperationalCashPayment(
  orderId: string,
  input: ConfirmOperationalCashPaymentInput,
  idempotencyKey: string,
): Promise<ConfirmOperationalCashPaymentResponse> {
  return apiRequest<ConfirmOperationalCashPaymentResponse>(
    `/api/v1/ops/payments/orders/${encodeURIComponent(orderId)}/cash`,
    {
      method: "POST",

      headers: {
        "Idempotency-Key": idempotencyKey,
      },

      body: JSON.stringify(input),
    },
  );
}
// =========================================================
// CONSULTAR MESAS
// =========================================================

export function getDiningTables(
  tenantCode: string,
  branchCode: string,
): Promise<DiningTablesResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<DiningTablesResponse>(
    `/api/v1/tables?${params.toString()}`,
  );
}

export function getDiningTableContext(
  contextToken: string,
): Promise<DiningTableContextResponse> {
  const params = new URLSearchParams({
    token: contextToken,
  });

  return apiRequest<DiningTableContextResponse>(
    `/api/v1/tables/context?${params.toString()}`,
  );
}

// =========================================================
// OPERACIONES / KDS
// =========================================================

export type OperationalOrderStatus = FlashOrderStatus;

export type OperationalTableSessionStatus = "OPEN" | "CLOSED";

export interface OperationalOrderItem {
  productId: string | null;
  sku: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface OperationalTableSession {
  id: string;
  status: OperationalTableSessionStatus;
  closedAt: string | null;
}

export interface OperationalOrder {
  id: string;
  orderNumber: string;
  trackingToken: string;
  orderType: FlashOrderType;
  status: OperationalOrderStatus;
  paymentStatus: OrderPaymentStatus;
  orderOrigin: OrderOrigin;
  currency: string;
  total: number;

  fulfillment: FlashOrderFulfillment;

  reservation: {
    id: string;
    reservationCode: string;
    reservedFor: string;
  } | null;

  tableSession: OperationalTableSession | null;

  delivery: {
    id: string;
    status: OperationalDeliveryStatus;

    relationshipRole:
      | "PRIMARY"
      | "ADDITIONAL"
      | null;

    memberCount: number;
    isShared: boolean;

    assignment: {
      id: string;
      status: string | null;
      acceptedAt: string | null;
      driver: {
        id: string;
        code: string | null;
        name: string | null;
      } | null;
    } | null;
  } | null;

  items: OperationalOrderItem[];
  createdAt: string;
  updatedAt: string;
}

export interface OperationalOrdersResponse {
  tenant: string;
  branch: string;
  total: number;
  orders: OperationalOrder[];
}

export type OperationalDeliveryStatus =
  | "CREATED"
  | "WAITING_ASSIGNMENT"
  | "ASSIGNED"
  | "ACCEPTED"
  | "PICKED_UP"
  | "EN_ROUTE"
  | "ARRIVED"
  | "DELIVERED"
  | "FAILED"
  | "CANCELLED";

export interface OperationalDelivery {
  id: string;
  trackingToken: string;
  status: OperationalDeliveryStatus;

  order: {
    id: string;
    orderNumber: string;
    status: OperationalOrderStatus;
    paymentStatus: OrderPaymentStatus;
    total: number;
  };

  assignment: unknown | null;
}

export interface OperationalDeliveriesResponse {
  tenant: string;
  branch: string;
  status: string | null;
  total: number;
  deliveries: OperationalDelivery[];
}

export interface OperationalDeliveryDriver {
  id: string;
  code: string;
  displayName: string;
  phone: string;
  status: string;
  branchStatus: string;
  activeAssignments: number;
}

export interface OperationalDeliveryDriversResponse {
  tenant: string;
  branch: string;
  total: number;
  drivers: OperationalDeliveryDriver[];
}
export interface UpdatedOrderStatus {
  id: string;
  orderNumber: string;
  trackingToken: string;
  previousStatus: OperationalOrderStatus;
  status: OperationalOrderStatus;
  changed: boolean;
  updatedAt?: string;
}

export interface OperationalDiningTableOrder {
  id: string;
  orderNumber: string;
  orderType: "DINE_IN";
  status: OperationalOrderStatus;
  total: number;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalDiningTableSession {
  id: string;
  status: "OPEN";
  openedAt: string;
  occupiedMinutes: number;
}

export interface OperationalDiningTable {
  id: string;
  code: string;
  name: string;
  capacity: number;
  zone: string | null;
  availability: DiningTableAvailability;
  tableSession: OperationalDiningTableSession | null;
  orders: OperationalDiningTableOrder[];
}

export interface OperationalDiningTablesResponse {
  tenant: string;
  branch: string;
  total: number;
  available: number;
  occupied: number;
  tables: OperationalDiningTable[];
}

export interface OperationalTableQrContextResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  validOn: string;
  expiresAt: string;
  contextToken: string;
  menuUrl: string;
  permanentUrl: string;
  tableSession: {
    id: string;
    status: "OPEN";
  } | null;
  currentOrder: {
    orderNumber: string;
    trackingToken: string;
    status: FlashOrderStatus;
  } | null;
  table: DiningTable;
}

export interface OccupiedOperationalTableResponse {
  tenant: string;
  branch: string;

  table: {
    id: string;
    code: string;
    name: string;
    capacity: number;
    zone: string | null;
    availability: "OCCUPIED";
  };

  tableSession: {
    id: string;
    status: "OPEN";
    openedAt: string;
  };
}

export interface ClosedOperationalTableSessionResponse {
  tenant: string;
  branch: string;

  table: {
    id: string;
    code: string;
    name: string;
    availability: "AVAILABLE";
  };

  tableSession: {
    id: string;
    previousStatus: "OPEN";
    status: "CLOSED";
    closedAt: string;
    updatedAt: string;
  };
}

export interface AssignedOperationalOrderTableResponse {
  tenant: string;
  branch: string;

  order: {
    id: string;
    orderNumber: string;
    orderType: "DINE_IN";
    status: OperationalOrderStatus;
    tableCode: string;
    tableSessionId: string;
    changed: true;
  };

  table: {
    id: string;
    code: string;
    name: string;
    capacity: number;
    zone: string | null;
    availability: "OCCUPIED";
  };

  tableSession: {
    id: string;
    status: "OPEN";
    openedAt: string;
    created: boolean;
  };
}

export function getOperationalOrders(
  tenantCode: string,
  branchCode: string,
): Promise<OperationalOrdersResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<OperationalOrdersResponse>(
    `/api/v1/ops/orders?${params.toString()}`,
  );
}

export function getOperationalDeliveries(
  tenantCode: string,
  branchCode: string,
  opsAccessKey: string,
  status?: OperationalDeliveryStatus,
): Promise<OperationalDeliveriesResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  if (status) {
    params.set("status", status);
  }

  return apiRequest<OperationalDeliveriesResponse>(
    `/api/v1/ops/deliveries?${params.toString()}`,
    {
      headers: {
        "X-Ops-Key": opsAccessKey,
      },
    },
  );
}
export function getOperationalDeliveryDrivers(
  tenantCode: string,
  branchCode: string,
  opsAccessKey: string,
): Promise<OperationalDeliveryDriversResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<OperationalDeliveryDriversResponse>(
    `/api/v1/ops/delivery-drivers?${params.toString()}`,
    {
      headers: {
        "X-Ops-Key": opsAccessKey,
      },
    },
  );
}

export function assignOperationalDelivery(
  deliveryId: string,
  driverId: string,
  tenantCode: string,
  branchCode: string,
  opsAccessKey: string,
): Promise<unknown> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<unknown>(
    `/api/v1/ops/deliveries/${encodeURIComponent(deliveryId)}/assignment?${params.toString()}`,
    {
      method: "PATCH",

      headers: {
        "X-Ops-Key": opsAccessKey,
      },

      body: JSON.stringify({
        driverId,
      }),
    },
  );
}
export function updateOperationalOrderStatus(
  orderId: string,
  status: OperationalOrderStatus,
): Promise<UpdatedOrderStatus> {
  return apiRequest<UpdatedOrderStatus>(
    `/api/v1/ops/orders/${orderId}/status`,
    {
      method: "PATCH",

      body: JSON.stringify({
        status,
      }),
    },
  );
}

export function getOperationalTables(
  tenantCode: string,
  branchCode: string,
): Promise<OperationalDiningTablesResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<OperationalDiningTablesResponse>(
    `/api/v1/ops/tables?${params.toString()}`,
  );
}

export function getOperationalTableQrContext(
  tableId: string,
  tenantCode: string,
  branchCode: string,
): Promise<OperationalTableQrContextResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<OperationalTableQrContextResponse>(
    `/api/v1/ops/tables/${tableId}/qr-context?${params.toString()}`,
  );
}

export function occupyOperationalTable(
  tableId: string,
  tenantCode: string,
  branchCode: string,
): Promise<OccupiedOperationalTableResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<OccupiedOperationalTableResponse>(
    `/api/v1/ops/tables/${tableId}/occupy?${params.toString()}`,
    {
      method: "POST",
    },
  );
}

export function closeOperationalTableSession(
  sessionId: string,
  tenantCode: string,
  branchCode: string,
): Promise<ClosedOperationalTableSessionResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<ClosedOperationalTableSessionResponse>(
    `/api/v1/ops/table-sessions/${sessionId}/close?${params.toString()}`,
    {
      method: "PATCH",
    },
  );
}

export function assignOperationalOrderToTable(
  orderId: string,
  tableId: string,
  tenantCode: string,
  branchCode: string,
): Promise<AssignedOperationalOrderTableResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<AssignedOperationalOrderTableResponse>(
    `/api/v1/ops/orders/${orderId}/table-session?${params.toString()}`,
    {
      method: "PATCH",

      body: JSON.stringify({
        tableId,
      }),
    },
  );
}

// =========================================================
// RESERVAS DE MESAS V0.1
// =========================================================

export type TableReservationStatus =
  "PENDING" | "CONFIRMED" | "SEATED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";

export type ReservationSlotAvailability = "AVAILABLE" | "CAPACITY" | "RESERVED";

export interface ReservationTable {
  id: string;
  code: string;
  name: string;
  capacity: number;
  zone: string | null;
}

export interface TableReservation {
  id: string;
  reservationCode: string;
  trackingToken: string;
  status: TableReservationStatus;
  reservedFor: string;
  reservedUntil: string;
  durationMinutes: number;
  partySize: number;
  customerName: string;
  customerPhone: string;
  customerNotes: string | null;
  source: "WEB" | "OPS" | "PHONE";
  table: ReservationTable;
  tableSession: {
    id: string;
    status: "OPEN" | "CLOSED";
    openedAt: string;
    closedAt: string | null;
  } | null;
  preorder: {
    id: string;
    orderNumber: string;
    trackingToken: string;
    status: OperationalOrderStatus;
    currency: string;
    total: number;
    scheduledFor: string | null;
    tableSessionId: string | null;
  } | null;
  confirmedAt: string | null;
  seatedAt: string | null;
  cancelledAt: string | null;
  noShowAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationAvailabilityResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  reservedFor: string;
  reservedUntil: string;
  durationMinutes: number;
  partySize: number;
  total: number;
  available: number;
  tables: Array<
    ReservationTable & {
      currentAvailability: DiningTableAvailability;
      slotAvailability: ReservationSlotAvailability;
      available: boolean;
    }
  >;
}

export interface CreateTableReservationInput {
  tenantCode: string;
  branchCode: string;
  tableId: string;
  reservedFor: string;
  durationMinutes: number;
  partySize: number;
  customerName: string;
  customerPhone: string;
  customerNotes?: string;
}

export interface TableReservationResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  reservation: TableReservation;
}

export interface OperationalReservationsResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  from: string;
  to: string;
  status: TableReservationStatus | null;
  total: number;
  reservations: TableReservation[];
}

export interface UpdatedOperationalReservationResponse extends TableReservationResponse {
  previousStatus: TableReservationStatus;
  changed: boolean;
}

export interface CheckedInReservationResponse extends TableReservationResponse {
  previousStatus: "PENDING" | "CONFIRMED";
  table: {
    id: string;
    code: string;
    name: string;
    availability: "OCCUPIED";
  };
  tableSession: {
    id: string;
    status: "OPEN";
    openedAt: string;
  };
}

export function getReservationAvailability(
  tenantCode: string,
  branchCode: string,
  reservedFor: string,
  durationMinutes: number,
  partySize: number,
): Promise<ReservationAvailabilityResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
    reservedFor,
    durationMinutes: String(durationMinutes),
    partySize: String(partySize),
  });

  return apiRequest<ReservationAvailabilityResponse>(
    `/api/v1/reservations/availability?${params.toString()}`,
  );
}

export function createTableReservation(
  input: CreateTableReservationInput,
): Promise<TableReservationResponse> {
  return apiRequest<TableReservationResponse>("/api/v1/reservations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getTableReservationTracking(
  trackingToken: string,
): Promise<TableReservationResponse> {
  return apiRequest<TableReservationResponse>(
    `/api/v1/reservations/track/${trackingToken}`,
  );
}

export function getOperationalReservations(
  tenantCode: string,
  branchCode: string,
  status?: TableReservationStatus,
): Promise<OperationalReservationsResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  if (status) {
    params.set("status", status);
  }

  return apiRequest<OperationalReservationsResponse>(
    `/api/v1/ops/reservations?${params.toString()}`,
  );
}

export function updateOperationalReservationStatus(
  reservationId: string,
  status: "CONFIRMED" | "CANCELLED" | "NO_SHOW",
  tenantCode: string,
  branchCode: string,
): Promise<UpdatedOperationalReservationResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<UpdatedOperationalReservationResponse>(
    `/api/v1/ops/reservations/${reservationId}/status?${params.toString()}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status }),
    },
  );
}

export function checkInOperationalReservation(
  reservationId: string,
  tenantCode: string,
  branchCode: string,
): Promise<CheckedInReservationResponse> {
  const params = new URLSearchParams({
    tenant: tenantCode,
    branch: branchCode,
  });

  return apiRequest<CheckedInReservationResponse>(
    `/api/v1/ops/reservations/${reservationId}/check-in?${params.toString()}`,
    {
      method: "POST",
    },
  );
}

export interface PublicDeliveryPod {
  delivery: {
    id: string;
    status: "ARRIVED";
  };

  pod: {
    status: "ACTIVE";
    code: string;
  };
}

export function getOrderDeliveryPod(
  trackingToken: string,
): Promise<PublicDeliveryPod> {
  const normalizedTrackingToken =
    trackingToken.trim();

  if (!normalizedTrackingToken) {
    return Promise.reject(
      new Error(
        "trackingToken is required",
      ),
    );
  }

  return apiRequest<PublicDeliveryPod>(
    `/api/v1/orders/track/${encodeURIComponent(
      normalizedTrackingToken,
    )}/delivery-pod`,
  );
}

export interface AdminDevQrPaymentStatus {
  enabled: boolean;
  developmentOnly: true;
  provider: "BCP_QR";
  environment: string;
}

export interface AdminDevQrPaymentResult {
  changed: boolean;
  order: {
    number: string;
    status: string;
    paymentStatus: string;
  };
  payment: {
    attemptNumber: number;
    status: string;
    provider: string;
  };
}

export function getAdminDevQrPaymentStatus(): Promise<AdminDevQrPaymentStatus> {
  return apiRequest<AdminDevQrPaymentStatus>(
    "/api/v1/staff/admin/dev-payments/status",
  );
}

export function simulateAdminDevQrPayment(
  orderNumber: string,
): Promise<AdminDevQrPaymentResult> {
  return apiRequest<AdminDevQrPaymentResult>(
    `/api/v1/staff/admin/dev-payments/orders/${encodeURIComponent(
      orderNumber,
    )}/simulate-qr-paid`,
    {
      method: "POST",
    },
  );
}

export function linkCustomerRecoveryOrders(tenantCode: string, branchCode: string, trackingTokens: string[]) {
  return apiRequest<{linked:number}>("/api/v1/orders/recovery/link", {method:"POST",body:JSON.stringify({tenantCode,branchCode,trackingTokens})});
}

export interface StaffBranchLocation {
  tenantCode:string;branchCode:string;branchName:string;address:string;
  latitude:number|null;longitude:number|null;deliveryEnabled:boolean;revision:string;
}
export function getStaffBranchLocation(signal?:AbortSignal) {
  return apiRequest<StaffBranchLocation>('/api/v1/staff/branch-location',{cache:'no-store',signal});
}
export function saveStaffBranchLocation(input:{address:string;latitude:number;longitude:number;revision:string}) {
  return apiRequest<StaffBranchLocation>('/api/v1/staff/branch-location',{method:'PATCH',body:JSON.stringify(input)});
}

export interface OperationsCapabilities {
  version: 'operations.access.v1';
  tenantCode: string;
  branchCode: string;
  permissions: string[];
  orderStatuses: string[];
}
export function getOperationsCapabilities(): Promise<OperationsCapabilities> {
  return apiRequest<OperationsCapabilities>('/api/v1/ops/access', { cache: 'no-store' });
}

export type BranchServiceKey = 'ORDERING'|'DELIVERY'|'TAKEAWAY'|'PICKUP'|'DINE_IN'|'RESERVATIONS';
export type BranchServiceState = 'ENABLED'|'DRAINING'|'DISABLED';
export interface BranchServices {
  tenantCode:string;branchCode:string;revision:string;
  states:Record<BranchServiceKey,BranchServiceState>;
  labels:Record<BranchServiceKey,string>;active:Record<BranchServiceKey,number>;
  deliveryConfigured:boolean;
}
export interface BranchCatalogProduct {id:string;name:string;category:string;price:string;currency:string;available:boolean;priceLocked:boolean;revision:string;}
export function getBranchServices(signal?:AbortSignal){return apiRequest<BranchServices>('/api/v1/ops/branch-configuration/services',{cache:'no-store',signal});}
export function saveBranchServices(value:{revision:string;states:BranchServices['states'];reason:string}){return apiRequest('/api/v1/ops/branch-configuration/services',{method:'PATCH',body:JSON.stringify(value)});}
export function getBranchCatalog(signal?:AbortSignal){return apiRequest<{products:BranchCatalogProduct[]}>('/api/v1/ops/branch-configuration/products',{cache:'no-store',signal});}
export function saveBranchCatalogProduct(id:string,value:{revision:string;price:string;available:boolean;reason:string}){return apiRequest('/api/v1/ops/branch-configuration/products/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(value)});}
export function getPublicBranchServices(tenant:string,branch:string,signal?:AbortSignal){return apiRequest<{available:Record<BranchServiceKey,boolean>}>('/api/v1/catalog/services?tenant='+encodeURIComponent(tenant)+'&branch='+encodeURIComponent(branch),{cache:'no-store',signal});}

export interface ProductCategoryOption {id:string;name:string;slug:string;}
export interface ProductCreation {requestId:string;name:string;description:string;categoryId:string;price:string;available:boolean;presentations:{label:string;price:string}[];reason:string;}
export interface ProductDeletion {canDelete:boolean;reasons:string[];revision:string;products:{id:string;name:string}[];count:number;}
export function getProductCreationOptions(signal?:AbortSignal){return apiRequest<{categories:ProductCategoryOption[]}>('/api/v1/ops/branch-configuration/product-creation-options',{cache:'no-store',signal});}
export function createBranchProduct(value:ProductCreation){return apiRequest('/api/v1/ops/branch-configuration/products',{method:'POST',body:JSON.stringify(value)});}
export function getProductDeletion(id:string,signal?:AbortSignal){return apiRequest<ProductDeletion>('/api/v1/ops/branch-configuration/products/'+encodeURIComponent(id)+'/deletion',{cache:'no-store',signal});}
export function deleteBranchProduct(id:string,value:{requestId:string;revision:string;reason:string}){return apiRequest('/api/v1/ops/branch-configuration/products/'+encodeURIComponent(id),{method:'DELETE',body:JSON.stringify(value)});}

export interface CashSummary {
 date: string; timezone: string; kind: 'CURRENT_STATE_REPORT';
 totals: Array<{currency: string; category: string; count: string; amount: string}>;
 reviewRequired: Array<{orderNumber: string; status: string; currency: string; total: string}>;
 reviewRequiredCount: string; limit: number; note: string;
}
export function getCashSummary(date: string): Promise<CashSummary> {
 return apiRequest<CashSummary>('/api/v1/ops/payments/summary?date='+encodeURIComponent(date), {cache:'no-store'});
}
export function reconcileCashSummaryOrder(orderNumber: string): Promise<unknown> {
 return apiRequest('/api/v1/ops/payments/'+encodeURIComponent(orderNumber)+'/reconcile', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
}
