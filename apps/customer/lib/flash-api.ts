export interface FlashCartProduct {
  id: string;
  sku: string | null;
  name: string;
}

export interface FlashCartItem {
  product: FlashCartProduct;
  quantity: number;
  unitPrice: number;
  currency: string;
  lineTotal: number;
}

export interface FlashCart {
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
  scheduledFor?: string;
  customerName?: string;
  customerPhone?: string;
  tableCode?: string;
  tableContextToken?: string;
  reservationTrackingToken?: string;
  deliveryAddress?: string;
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
  table: DiningTable;
}

export interface CreatedOrder {
  id: string;
  orderNumber: string;
  trackingToken: string;
  orderType: FlashOrderType;
  status: FlashOrderStatus;
  paymentStatus: OrderPaymentStatus;
  orderOrigin: OrderOrigin;
  currency: string;

  fulfillment: FlashOrderFulfillment;

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

function getApiUrl(): string {
  const apiUrl = process.env.NEXT_PUBLIC_FLASH_API_URL;

  if (!apiUrl) {
    throw new Error("NEXT_PUBLIC_FLASH_API_URL is not configured");
  }

  return apiUrl;
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiUrl()}${path}`, {
    ...options,

    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let message = `Flash API error: ${response.status}`;

    try {
      const error = await response.json();

      if (typeof error?.message === "string") {
        message = error.message;
      }
    } catch {
      // Conservamos el mensaje HTTP.
    }

    throw new Error(message);
  }

  return response.json() as Promise<T>;
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
): Promise<CartMutationItem> {
  return apiRequest<CartMutationItem>(`/api/v1/carts/${cartToken}/items`, {
    method: "POST",

    body: JSON.stringify({
      productId,
      quantity,
    }),
  });
}

export function updateCartItem(
  cartToken: string,
  productId: string,
  quantity: number,
): Promise<CartMutationItem> {
  return apiRequest<CartMutationItem>(
    `/api/v1/carts/${cartToken}/items/${productId}`,
    {
      method: "PATCH",

      body: JSON.stringify({
        quantity,
      }),
    },
  );
}

export function removeCartItem(
  cartToken: string,
  productId: string,
): Promise<{
  removed: boolean;
  productId: string;
}> {
  return apiRequest<{
    removed: boolean;
    productId: string;
  }>(`/api/v1/carts/${cartToken}/items/${productId}`, {
    method: "DELETE",
  });
}

// =========================================================
// CREAR PEDIDO
// =========================================================

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

export function getOrderTracking(trackingToken: string): Promise<CreatedOrder> {
  return apiRequest<CreatedOrder>(`/api/v1/orders/track/${trackingToken}`);
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
): Promise<CreateQrPaymentResponse> {
  return apiRequest<CreateQrPaymentResponse>(
    `/api/v1/payments/orders/${encodeURIComponent(trackingToken)}/qr`,
    {
      method: "POST",
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
// PAGO EN EFECTIVO - SOLO OPERACIONES
// =========================================================

export interface ConfirmOperationalCashPaymentInput {
  tenantCode: string;
  branchCode: string;
  cashReceivedAmount: string;
  cashierReference: string;
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
  cashierAccessKey: string,
): Promise<ConfirmOperationalCashPaymentResponse> {
  return apiRequest<ConfirmOperationalCashPaymentResponse>(
    `/api/v1/ops/payments/orders/${encodeURIComponent(orderId)}/cash`,
    {
      method: "POST",

      headers: {
        "X-Cashier-Key": cashierAccessKey,
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
