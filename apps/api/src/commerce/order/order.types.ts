// =========================================================
// ORDER TYPES
// =========================================================

export type OrderType = 'DINE_IN' | 'TAKEAWAY' | 'PICKUP' | 'DELIVERY';

// =========================================================
// DATOS PARA CREAR UN PEDIDO
//
// Este contrato también es utilizado por OrderController.
// Los campos de fulfillment siguen siendo opcionales en V0.1.
// =========================================================

export interface CreateOrderInput {
  requireRecoveryProfile?: boolean;
  deliveryQuoteToken?: string;
  cartToken?: string;
  orderType?: string;

  scheduledFor?: string;

  customerName?: string;
  customerPhone?: string;

  tableCode?: string;
  tableContextToken?: string;
  reservationTrackingToken?: string;
  additionalToTrackingToken?: string;

  deliveryAddress?: string;
  deliveryLatitude?: unknown;
  deliveryLongitude?: unknown;
  deliveryReference?: string;

  customerNotes?: string;
}

export interface CustomerRecoveryEnrollInput {
  trackingToken?: string;
  phone?: string;
  pin?: string;
}

export interface CustomerRecoveryLoginInput {
  tenantCode?: string;
  phone?: string;
  pin?: string;
}

// =========================================================
// ORDER STATUS
// =========================================================

export type OrderStatus =
  'PENDING' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED';

export type OrderPaymentStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'AWAITING_CONFIRMATION'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'REVIEW_REQUIRED';

export type OrderOrigin =
  | 'LEGACY'
  | 'PUBLIC_MENU'
  | 'TABLE_QR'
  | 'BRANCH_QR'
  | 'OPS_STAFF'
  | 'RESERVATION_PREORDER'
  | 'RESERVATION_CHECKIN';

export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY'],
  READY: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const ORDER_TYPES: OrderType[] = [
  'DINE_IN',
  'TAKEAWAY',
  'PICKUP',
  'DELIVERY',
];

// =========================================================
// DATABASE ROW TYPES
// =========================================================

export interface CartRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  status: string;
  currency: string;
  expires_at: string | Date;
  tenant_code: string;
  branch_code: string;
}

export interface CheckoutItemRow {
  sauce_included_quantity: number | null;
  rice_choice: string;
  requires_rice: boolean;
  product_id: string;
  sku: string | null;
  name: string;
  quantity: number;
  price: string | null;
  currency: string | null;
  is_available: boolean | null;
  available_quantity: number | null;
}

export interface CreatedOrderRow {
  id: string;
  order_number: string;
  tracking_token: string;
  order_group_id: string | null;

  order_type: OrderType;
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  order_origin: OrderOrigin;
  currency: string;

  subtotal: string;
  discount_total: string;
  delivery_fee: string;
  total: string;

  // Fulfillment V0.1
  scheduled_for: string | Date | null;
  customer_name: string | null;
  customer_phone: string | null;
  table_code: string | null;
  delivery_address: string | null;
  customer_notes: string | null;

  reservation_id: string | null;

  created_at: string | Date;
}

export interface TrackingOrderRow {
  id: string;
  order_number: string;
  tracking_token: string;
  order_group_id: string | null;
  order_type: OrderType;
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  order_origin: OrderOrigin;
  currency: string;

  subtotal: string;
  discount_total: string;
  delivery_fee: string;
  total: string;

  scheduled_for: string | Date | null;
  customer_name: string | null;
  customer_phone: string | null;
  table_code: string | null;
  delivery_address: string | null;
  customer_notes: string | null;

  reservation_id: string | null;
  reservation_code: string | null;
  reservation_reserved_for: string | Date | null;

  created_at: string | Date;

  tenant_code: string;
  tenant_name: string;

  branch_code: string;
  branch_name: string;
}

export interface TrackingItemRow {
  product_id: string | null;
  sku_snapshot: string | null;
  name_snapshot: string;
  quantity: number;
  unit_price: string;
  line_total: string;
  currency: string;
}

export interface TrackingHistoryRow {
  status: OrderStatus;
  changed_at: string | Date;
}

export interface OpsOrderRow {
  id: string;
  order_number: string;
  tracking_token: string;
  order_type: OrderType;
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  order_origin: OrderOrigin;
  currency: string;
  total: string;

  // =======================================================
  // FULFILLMENT PARA KDS
  // =======================================================

  scheduled_for: string | Date | null;
  customer_name: string | null;
  customer_phone: string | null;
  table_code: string | null;
  delivery_address: string | null;
  customer_notes: string | null;

  reservation_id: string | null;
  reservation_code: string | null;
  reservation_reserved_for: string | Date | null;

  // =======================================================
  // TABLES V0.3 PARA KDS
  // =======================================================

  table_session_id: string | null;

  table_session_status: 'OPEN' | 'CLOSED' | null;

  table_session_closed_at: string | Date | null;

  operational_delivery_id: string | null;
  operational_delivery_status: string | null;
  operational_assignment_id: string | null;
  operational_assignment_status: string | null;
  operational_assignment_accepted_at: string | Date | null;
  operational_driver_id: string | null;
  operational_driver_code: string | null;
  operational_driver_name: string | null;

  operational_delivery_role: 'PRIMARY' | 'ADDITIONAL' | null;

  operational_delivery_member_count: number | null;

  created_at: string | Date;
  updated_at: string | Date;

  items: Array<{
    productId: string | null;
    sku: string | null;
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }>;
}

// =========================================================
// TABLES V0.2
// Tipos internos utilizados durante checkout DINE_IN.
//
// IMPORTANTE:
// Estas interfaces deben estar FUERA de OpsOrderRow.
// =========================================================

export interface CheckoutDiningTableRow {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}

export interface OpenTableSessionRow {
  id: string;
}

export interface AdditionalOrderContextRow {
  id: string;
  order_group_id: string;
  table_session_id: string;
  table_code: string;
}

export interface AdditionalDeliveryPreflightRow {
  tenant_id: string;
  branch_id: string;
  order_id: string;
  order_group_id: string;

  customer_name: string | null;
  customer_phone: string | null;

  delivery_id: string;
  delivery_tracking_token: string;
  delivery_status: string;

  address_text: string;
  address_reference: string | null;

  destination_latitude: string;
  destination_longitude: string;
}

export interface AdditionalDeliveryOrderContextRow extends AdditionalDeliveryPreflightRow {
  has_active_assignment: boolean;
}

export interface CreatedTableSessionRow {
  id: string;
}

export interface ReservationOrderContextRow {
  id: string;
  reservation_code: string;
  tracking_token: string;
  status: 'PENDING' | 'CONFIRMED';
  reserved_for: string | Date;
  reserved_until: string | Date;
  customer_name: string;
  customer_phone: string;
  table_id: string;
  table_code: string;
  table_name: string;
  table_is_active: boolean;
}

// =========================================================
// TABLES V0.3
// Tipos utilizados para cerrar una sesión desde Operaciones.
// =========================================================

export interface CloseTableOrderRow {
  id: string;
  order_number: string;
  order_type: OrderType;

  tenant_id: string;
  branch_id: string;

  table_session_id: string | null;
}

export interface CloseTableSessionRow {
  id: string;
  status: 'OPEN' | 'CLOSED';

  table_id: string;
  table_code: string;
  table_name: string;
}

export interface ClosedTableSessionRow {
  id: string;
  status: 'OPEN' | 'CLOSED';

  closed_at: string | Date;
  updated_at: string | Date;
}
