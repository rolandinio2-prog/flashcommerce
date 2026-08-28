export type ProviderPaymentStatus =
  'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'CANCELLED';

export type ProviderQrContentType = 'TEXT' | 'IMAGE_BASE64';

export type ProviderQrMimeType = 'image/png' | 'image/jpeg';

export interface CreateQrPaymentInput {
  paymentId: string;
  orderId: string;
  externalReference: string;
  amount: string;
  currency: string;
  customerPhone: string | null;
  branchOffice: string | null;
  expiresAt: Date;
}

export interface CreateQrPaymentResult {
  providerPaymentId: string;
  status: ProviderPaymentStatus;
  qrPayload: string;
  qrContentType: ProviderQrContentType;
  qrMimeType: ProviderQrMimeType | null;
  expiresAt: Date;
}

export interface ProviderPaymentStatusResult {
  providerPaymentId: string;
  providerTransactionId: string | null;
  status: ProviderPaymentStatus;
  paidAt: Date | null;
}

export interface CancelQrPaymentInput {
  providerPaymentId: string;
  reason: string;
}

export interface CancelQrPaymentResult {
  providerPaymentId: string;
  status: 'CANCELLED';
}

export interface PaymentProvider {
  readonly name: string;

  createQrPayment(input: CreateQrPaymentInput): Promise<CreateQrPaymentResult>;

  getPaymentStatus(
    providerPaymentId: string,
  ): Promise<ProviderPaymentStatusResult>;

  cancelQrPayment(input: CancelQrPaymentInput): Promise<CancelQrPaymentResult>;
}
