export type ProviderPaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

export interface CreateQrPaymentInput {
  paymentId: string;
  orderId: string;
  externalReference: string;
  amount: string;
  currency: string;
  expiresAt: Date;
}

export interface CreateQrPaymentResult {
  providerPaymentId: string;
  status: ProviderPaymentStatus;
  qrPayload: string;
  expiresAt: Date;
}

export interface ProviderPaymentStatusResult {
  providerPaymentId: string;
  providerTransactionId: string | null;
  status: ProviderPaymentStatus;
  paidAt: Date | null;
}

export interface PaymentProvider {
  readonly name: string;

  createQrPayment(input: CreateQrPaymentInput): Promise<CreateQrPaymentResult>;

  getPaymentStatus(
    providerPaymentId: string,
  ): Promise<ProviderPaymentStatusResult>;
}
