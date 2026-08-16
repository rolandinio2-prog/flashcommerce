import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  type CreateQrPaymentInput,
  type CreateQrPaymentResult,
  type PaymentProvider,
  type ProviderPaymentStatusResult,
} from './payment-provider';

@Injectable()
export class MockQrProvider implements PaymentProvider {
  readonly name = 'MOCK';

  async createQrPayment(
    input: CreateQrPaymentInput,
  ): Promise<CreateQrPaymentResult> {
    const providerPaymentId = `MOCK-PAY-${randomUUID()}`;

    const qrPayload = [
      'FLASHCOMMERCE-MOCK',
      input.externalReference,
      input.amount,
      input.currency,
      providerPaymentId,
    ].join('|');

    return Promise.resolve({
      providerPaymentId,
      status: 'PENDING',
      qrPayload,
      expiresAt: input.expiresAt,
    });
  }

  async getPaymentStatus(
    providerPaymentId: string,
  ): Promise<ProviderPaymentStatusResult> {
    return Promise.resolve({
      providerPaymentId,
      providerTransactionId: null,
      status: 'PENDING',
      paidAt: null,
    });
  }
}
