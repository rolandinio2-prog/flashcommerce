export type DeliveryQuoteUnavailableReason =
  | 'DELIVERY_DISABLED'
  | 'OUTSIDE_DELIVERY_AREA'
  | 'MINIMUM_ORDER_NOT_MET';

export interface DeliveryQuoteInput {
  tenantCode?: unknown;
  branchCode?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  subtotal?: unknown;
}

export interface DeliveryQuoteZone {
  code: string;
  name: string;
}

export interface DeliveryQuoteEta {
  minMinutes: number;
  maxMinutes: number;
}

export interface DeliveryQuoteResponse {
  available: boolean;
  reason: DeliveryQuoteUnavailableReason | null;

  branch: {
    code: string;
    name: string;
  };

  zone: DeliveryQuoteZone | null;

  deliveryFee: number | null;
  minimumOrder: number | null;
  minimumOrderMissing: number | null;

  eta: DeliveryQuoteEta | null;
}