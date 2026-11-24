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
