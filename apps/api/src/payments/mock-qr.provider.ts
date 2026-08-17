import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type {
  CancelQrPaymentInput,
  CancelQrPaymentResult,
  CreateQrPaymentInput,
  CreateQrPaymentResult,
  PaymentProvider,
  ProviderPaymentStatusResult,
} from './payment-provider';

@Injectable()
export class MockQrProvider implements PaymentProvider {
  readonly name = 'MOCK';

  async createQrPayment(
    input: CreateQrPaymentInput,
  ): Promise<CreateQrPaymentResult> {
    const providerPaymentId = `MOCK-${randomUUID()}`;

    const qrPayload = [
      'FLASHCOMMERCE-MOCK',
      input.externalReference,
      input.amount,
      input.currency,
      providerPaymentId,
    ].join('|');

    return {
      providerPaymentId,
      status: 'PENDING',
      qrPayload,
      qrContentType: 'TEXT',
      qrMimeType: null,
      expiresAt: input.expiresAt,
    };
  }

  async getPaymentStatus(
    providerPaymentId: string,
  ): Promise<ProviderPaymentStatusResult> {
    return {
      providerPaymentId,
      providerTransactionId: null,
      status: 'PENDING',
      paidAt: null,
    };
  }

  async cancelQrPayment(
    input: CancelQrPaymentInput,
  ): Promise<CancelQrPaymentResult> {
    return {
      providerPaymentId: input.providerPaymentId,
      status: 'CANCELLED',
    };
  }
}
