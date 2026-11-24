import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../core/database/database.service';
import type { StaffSessionPrincipal } from '../core/staff/staff.types';
import { PaymentsService, type BcpQrCallbackInput } from './payments.service';

interface DevQrCandidateRow {
  payment_id: string | null;
  order_number: string;
  order_status: string;
  order_payment_status: string;
  total: string;
  order_currency: string;
  attempt_number: number | null;
  method: string | null;
  provider: string | null;
  payment_status: string | null;
  amount: string | null;
  payment_currency: string | null;
  external_reference: string | null;
  provider_payment_id: string | null;
  expires_at: string | Date | null;
}

@Injectable()
export class AdminDevQrPaymentService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    private readonly paymentsService: PaymentsService,
  ) {}

  getStatus() {
    this.assertEnabled();

    return {
      enabled: true as const,
      developmentOnly: true as const,
      // MOCK only when this environment (e.g. staging) is configured without a bank.
      provider: this.simulatedProvider(),
      environment: 'sandbox' as const,
    };
  }

  async simulateQrPaid(staff: StaffSessionPrincipal, orderNumberInput: string) {
    this.assertEnabled();

    const orderNumber = String(orderNumberInput ?? '').trim();

    if (!/^[1-9]\d{0,9}$/.test(orderNumber)) {
      throw new BadRequestException('orderNumber is invalid');
    }

    const before = await this.loadCandidate(staff, orderNumber);

    if (!before) {
      throw new NotFoundException(
        'Order was not found in the authenticated branch',
      );
    }

    if (
      before.order_payment_status === 'PAID' &&
      before.payment_status === 'PAID' &&
      before.method === 'QR' &&
      (before.provider === 'BCP_QR' || before.provider === 'MOCK')
    ) {
      return this.mapResult(false, before);
    }

    if (
      before.order_status !== 'PENDING' ||
      before.order_payment_status !== 'AWAITING_CONFIRMATION'
    ) {
      throw new ConflictException(
        'Order is not eligible for a fresh QR payment simulation',
      );
    }

    if (
      before.method !== 'QR' ||
      before.provider !== this.simulatedProvider() ||
      before.payment_status !== 'AWAITING_CONFIRMATION'
    ) {
      throw new ConflictException(
        `Latest payment is not an awaiting ${this.simulatedProvider()} attempt`,
      );
    }

    if (before.provider === 'MOCK') {
      if (!before.payment_id)
        throw new ConflictException('MOCK payment data is incomplete');
      if (
        before.expires_at &&
        new Date(before.expires_at).getTime() <= Date.now()
      ) {
        throw new ConflictException(
          'QR attempt expired; generate a fresh QR first',
        );
      }
      // Same normal MOCK confirmation used by the payment core (no lab key: guarded here).
      await this.paymentsService.confirmMockPaymentForDevTools(
        before.payment_id,
        staff,
      );
      const paid = await this.loadCandidate(staff, orderNumber);
      if (
        !paid ||
        paid.order_payment_status !== 'PAID' ||
        paid.payment_status !== 'PAID' ||
        paid.provider !== 'MOCK'
      ) {
        throw new ConflictException(
          'Payment core did not finish in PAID state',
        );
      }
      return this.mapResult(true, paid);
    }

    if (
      !before.external_reference ||
      !before.provider_payment_id ||
      !before.amount ||
      !before.payment_currency
    ) {
      throw new ConflictException('BCP_QR payment data is incomplete');
    }

    if (
      before.expires_at &&
      new Date(before.expires_at).getTime() <= Date.now()
    ) {
      throw new ConflictException(
        'BCP_QR attempt expired; generate a fresh QR first',
      );
    }

    const providerPaymentId = before.provider_payment_id.trim();

    if (
      !/^[1-9]\d{0,15}$/.test(providerPaymentId) ||
      !Number.isSafeInteger(Number(providerPaymentId))
    ) {
      throw new ConflictException(
        'BCP sandbox payment identifier is not callback compatible',
      );
    }

    const username = this.requireConfig('BCP_QR_USERNAME');
    const publicToken = this.requireConfig('BCP_QR_PUBLIC_TOKEN');
    const serviceCode = this.requireConfig('BCP_QR_SERVICE_CODE');
    const businessCode = this.requireConfig('BCP_QR_BUSINESS_CODE');

    const authorization =
      'Basic ' +
      Buffer.from(`${username}:${publicToken}`, 'utf8').toString('base64');

    const callback: BcpQrCallbackInput = {
      Id: Number(providerPaymentId),
      ServiceCode: serviceCode,
      BusinessCode: businessCode,
      IdCorrelation: before.external_reference,
      Amount: before.amount,
      Currency: before.payment_currency,
      ResponseCode: '000',
      Status: 'P',
      OperationNumber: `DEVQR-${randomUUID()}`,
    };

    const callbackResult = await this.paymentsService.handleBcpQrCallback(
      authorization,
      callback,
    );

    if (String(callbackResult.State ?? '') !== '000') {
      throw new ConflictException(
        'The normal BCP callback flow rejected the simulated payment',
      );
    }

    const after = await this.loadCandidate(staff, orderNumber);

    if (
      !after ||
      after.order_payment_status !== 'PAID' ||
      after.payment_status !== 'PAID' ||
      after.method !== 'QR' ||
      after.provider !== 'BCP_QR'
    ) {
      throw new ConflictException('Payment core did not finish in PAID state');
    }

    return this.mapResult(true, after);
  }

  private async loadCandidate(
    staff: StaffSessionPrincipal,
    orderNumber: string,
  ): Promise<DevQrCandidateRow | null> {
    const result = await this.databaseService.query<DevQrCandidateRow>(
      `
          select
            o.order_number::text,
            o.status as order_status,
            o.payment_status
              as order_payment_status,
            o.total::text,
            o.currency as order_currency,
            p.payment_id,
            p.attempt_number,
            p.method,
            p.provider,
            p.status as payment_status,
            p.amount::text,
            p.currency as payment_currency,
            p.external_reference,
            p.provider_payment_id,
            p.expires_at
          from public.orders o
          left join lateral (
            select
              op.id::text as payment_id,
              op.attempt_number,
              op.method,
              op.provider,
              op.status,
              op.amount,
              op.currency,
              op.external_reference,
              op.provider_payment_id,
              op.expires_at
            from public.order_payments op
            where op.tenant_id = o.tenant_id
              and op.branch_id = o.branch_id
              and op.order_id = o.id
            order by op.attempt_number desc
            limit 1
          ) p on true
          where o.tenant_id = $1::uuid
            and o.branch_id = $2::uuid
            and o.order_number::text = $3
          limit 2
        `,
      [staff.tenantId, staff.branchId, orderNumber],
    );

    if (result.rows.length > 1) {
      throw new ConflictException(
        'Order number is ambiguous in the authenticated branch',
      );
    }

    return result.rows[0] ?? null;
  }

  private mapResult(changed: boolean, row: DevQrCandidateRow) {
    if (row.attempt_number === null || !row.payment_status || !row.provider) {
      throw new ConflictException('Payment result is incomplete');
    }

    return {
      changed,
      order: {
        number: row.order_number,
        status: row.order_status,
        paymentStatus: row.order_payment_status,
      },
      payment: {
        attemptNumber: row.attempt_number,
        status: row.payment_status,
        provider: row.provider,
      },
    };
  }

  /** Provider the simulator acts on: the environment payment provider (MOCK or BCP_QR). */
  private simulatedProvider(): 'MOCK' | 'BCP_QR' {
    return this.readConfig('PAYMENT_PROVIDER').toUpperCase() === 'MOCK'
      ? 'MOCK'
      : 'BCP_QR';
  }

  private assertEnabled() {
    const environment = this.readConfig('BCP_QR_ENVIRONMENT').toLowerCase();

    if (!this.devToolsEnabled() || environment !== 'sandbox') {
      throw new NotFoundException('Development payment tools are unavailable');
    }
  }

  private devToolsEnabled() {
    return (
      this.readConfig('PAYMENT_DEV_TOOLS_ENABLED').toLowerCase() === 'true'
    );
  }

  private readConfig(name: string) {
    return String(this.configService.get<string>(name) ?? '').trim();
  }

  private requireConfig(name: string) {
    const value = this.readConfig(name);

    if (!value) {
      throw new ServiceUnavailableException(
        'BCP sandbox callback configuration is incomplete',
      );
    }

    return value;
  }
}
