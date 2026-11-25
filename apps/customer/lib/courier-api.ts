import { apiRequest } from "./flash-api";

export type CourierBillingMode = "PER_DELIVERY" | "PERIODIC";
export type CourierPricingMode = "ZONE" | "DISTANCE";

export interface CourierClient {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  taxId: string | null;
  pickupAddress: string | null;
  pickupReference: string | null;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  billingMode: CourierBillingMode;
  status: "ACTIVE" | "INACTIVE";
}

export interface CourierRate {
  courierClientId: string | null;
  pricingMode: CourierPricingMode;
  baseFee: number;
  perKmFee: number;
  minFee: number;
}

export interface CourierQuote {
  zone: { code: string; name: string };
  distanceMeters: number;
  eta: { minMinutes: number; maxMinutes: number };
  pricingMode: CourierPricingMode;
  fee: number;
}

export interface CourierRequestSummary {
  orderNumber: number;
  trackingToken: string;
  deliveryId: string;
  deliveryStatus: string;
  clientName: string | null;
  recipientName: string;
  addressText: string;
  fee: number;
  collectAmount: number;
  createdAt: string;
}

export interface CourierRequestInput {
  courierClientId?: string;
  pickupName?: string;
  pickupPhone?: string;
  pickupAddress?: string;
  pickupLatitude?: number;
  pickupLongitude?: number;
  recipientName: string;
  recipientPhone: string;
  addressText: string;
  addressReference?: string;
  latitude: number;
  longitude: number;
  packageDescription?: string;
  feeOverride?: number;
  notes?: string;
}

export type SettlementStatus = "ISSUED" | "PAID" | "VOID";
export type PaymentMethod = "CASH" | "TRANSFER" | "QR" | "OTHER";
export type DriverPayMode = "NONE" | "FIXED_PER_DELIVERY" | "PERCENT_OF_FEE" | "SALARY";

export interface SettlementDelivery {
  deliveryId: string;
  orderNumber: number;
  deliveredAt: string;
  recipientName: string;
  clientName: string | null;
  fee: number;
  amount?: number;
}

export interface StatementSummary {
  id: string;
  number: number;
  clientName: string;
  periodFrom: string;
  periodTo: string;
  deliveryCount: number;
  totalFee: number;
  status: SettlementStatus;
  paymentMethod: PaymentMethod | null;
  paidAt: string | null;
  createdAt: string;
}
export interface StatementDetail extends Omit<StatementSummary, "clientName"> {
  client: { id: string; name: string; taxId: string | null };
  paymentReference: string | null;
  notes: string | null;
  deliveries: SettlementDelivery[];
}

export interface CourierDriver {
  id: string;
  code: string;
  displayName: string;
  status: string;
  payMode: DriverPayMode;
  payValue: number;
}
export interface PayoutSummary {
  id: string;
  number: number;
  driverName: string;
  periodFrom: string;
  periodTo: string;
  payMode: DriverPayMode;
  deliveryCount: number;
  amount: number;
  status: SettlementStatus;
  paymentMethod: PaymentMethod | null;
  paidAt: string | null;
  createdAt: string;
}
export interface PayoutDetail extends Omit<PayoutSummary, "driverName"> {
  driver: { id: string; name: string };
  payValue: number;
  feeTotal: number;
  paymentReference: string | null;
  notes: string | null;
  deliveries: SettlementDelivery[];
}
export interface StatementPreview {
  deliveries: SettlementDelivery[];
  deliveryCount: number;
  totalFee: number;
}
export interface PayoutPreview {
  payMode: DriverPayMode;
  payValue: number;
  deliveries: SettlementDelivery[];
  deliveryCount: number;
  feeTotal: number;
  amount: number;
}

const BASE = "/api/v1/ops/courier";
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const courierApi = {
  listClients: () => apiRequest<{ clients: CourierClient[] }>(`${BASE}/clients`),
  createClient: (input: Partial<CourierClient>) => apiRequest<CourierClient>(`${BASE}/clients`, json("POST", input)),
  updateClient: (id: string, input: Partial<CourierClient>) =>
    apiRequest<CourierClient>(`${BASE}/clients/${encodeURIComponent(id)}`, json("PATCH", input)),
  listRates: () => apiRequest<{ rates: CourierRate[] }>(`${BASE}/rates`),
  setRate: (input: CourierRate) => apiRequest<CourierRate>(`${BASE}/rates`, json("PUT", input)),
  quote: (input: Partial<CourierRequestInput>) => apiRequest<CourierQuote>(`${BASE}/quote`, json("POST", input)),
  listRequests: () => apiRequest<{ requests: CourierRequestSummary[] }>(`${BASE}/requests`),
  createRequest: (input: CourierRequestInput) =>
    apiRequest<{ orderNumber: number; trackingToken: string; fee: number; eta: { minMinutes: number; maxMinutes: number } }>(
      `${BASE}/requests`,
      json("POST", input),
    ),

  // D1c settlements
  previewStatement: (input: { courierClientId: string; from: string; to: string }) =>
    apiRequest<StatementPreview>(`${BASE}/statements/preview`, json("POST", input)),
  createStatement: (input: { courierClientId: string; from: string; to: string; notes?: string }) =>
    apiRequest<StatementDetail>(`${BASE}/statements`, json("POST", input)),
  listStatements: () => apiRequest<{ statements: StatementSummary[] }>(`${BASE}/statements`),
  getStatement: (id: string) => apiRequest<StatementDetail>(`${BASE}/statements/${encodeURIComponent(id)}`),
  payStatement: (id: string, input: { paymentMethod: PaymentMethod; paymentReference?: string }) =>
    apiRequest<StatementDetail>(`${BASE}/statements/${encodeURIComponent(id)}/pay`, json("POST", input)),
  voidStatement: (id: string) => apiRequest<StatementDetail>(`${BASE}/statements/${encodeURIComponent(id)}/void`, json("POST", {})),

  listDrivers: () => apiRequest<{ drivers: CourierDriver[] }>(`${BASE}/drivers`),
  setPayRule: (driverId: string, input: { payMode: DriverPayMode; payValue: number }) =>
    apiRequest<{ driverId: string; payMode: DriverPayMode; payValue: number }>(
      `${BASE}/drivers/${encodeURIComponent(driverId)}/pay-rule`,
      json("PATCH", input),
    ),
  previewPayout: (input: { driverId: string; from: string; to: string }) =>
    apiRequest<PayoutPreview>(`${BASE}/payouts/preview`, json("POST", input)),
  createPayout: (input: { driverId: string; from: string; to: string; notes?: string }) =>
    apiRequest<PayoutDetail>(`${BASE}/payouts`, json("POST", input)),
  listPayouts: () => apiRequest<{ payouts: PayoutSummary[] }>(`${BASE}/payouts`),
  getPayout: (id: string) => apiRequest<PayoutDetail>(`${BASE}/payouts/${encodeURIComponent(id)}`),
  payPayout: (id: string, input: { paymentMethod: PaymentMethod; paymentReference?: string }) =>
    apiRequest<PayoutDetail>(`${BASE}/payouts/${encodeURIComponent(id)}/pay`, json("POST", input)),
  voidPayout: (id: string) => apiRequest<PayoutDetail>(`${BASE}/payouts/${encodeURIComponent(id)}/void`, json("POST", {})),
};

export const PAY_MODE_LABEL: Record<DriverPayMode, string> = {
  NONE: "Sin regla",
  FIXED_PER_DELIVERY: "Monto fijo por entrega",
  PERCENT_OF_FEE: "Porcentaje de la tarifa",
  SALARY: "Sueldo por periodo",
};
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  QR: "QR",
  OTHER: "Otro",
};
export const SETTLEMENT_STATUS_LABEL: Record<SettlementStatus, string> = {
  ISSUED: "Pendiente de pago",
  PAID: "Pagada",
  VOID: "Anulada",
};

export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  CREATED: "Creado",
  WAITING_ASSIGNMENT: "Esperando conductor",
  ASSIGNED: "Asignado",
  ACCEPTED: "Aceptado",
  PICKED_UP: "Recogido",
  EN_ROUTE: "En camino",
  ARRIVED: "En destino",
  DELIVERED: "Entregado",
  FAILED: "Fallido",
  CANCELLED: "Cancelado",
};
