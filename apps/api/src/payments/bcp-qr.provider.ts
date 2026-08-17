import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { isAbsolute } from 'node:path';

import type {
  CancelQrPaymentInput,
  CancelQrPaymentResult,
  CreateQrPaymentInput,
  CreateQrPaymentResult,
  PaymentProvider,
  ProviderPaymentStatusResult,
  ProviderQrMimeType,
} from './payment-provider';

type BcpEnvironment = 'sandbox' | 'production';

interface BcpEndpoints {
  baseUrl: string;
  generatePath: string;
  consultPath: string;
  updateStatusPath: string;
}

interface BcpConfiguration {
  endpoints: BcpEndpoints;
  authorization: string;
  appUserId: string;
  publicToken: string;
  businessCode: string;
  serviceCode: string;
  city: string;
  branchOffice: string;
  teller: string;
  phoneNumber: string;
  enableBank: string;
  requestTimeoutMs: number;
  agent: Agent;
}

interface BcpGenerateResponse {
  state?: unknown;
  message?: unknown;
  data?: {
    id?: unknown;
    qrImage?: unknown;
    expirationDate?: unknown;
  } | null;
}

interface BcpConsultResponse {
  state?: unknown;
  message?: unknown;
  data?: {
    status?: unknown;
    description?: unknown;
    operationNumber?: unknown;
    correlationId?: unknown;
  } | null;
}

interface BcpUpdateStatusResponse {
  state?: unknown;
  message?: unknown;
  status?: unknown;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_QR_IMAGE_BYTES = 5 * 1024 * 1024;

const BCP_ENDPOINTS: Record<BcpEnvironment, BcpEndpoints> = {
  sandbox: {
    baseUrl: 'https://sandbox.openbanking.bcp.com.bo',
    generatePath: '/Web_ApiQr/api/v4/Qr/Generated',
    consultPath: '/Web_ApiQr/api/v3/Qr/Consult',
    updateStatusPath: '/Web_ApiQr/api/v2/Qr/Updated/Status',
  },

  production: {
    baseUrl: 'https://openbanking.bcp.com.bo',
    generatePath: '/Web_ApiQr/api/v4/Qr/Generated',
    consultPath: '/Web_ApiQr/api/v3/Qr/Consult',
    updateStatusPath: '/Web_ApiQr/api/v2/Qr/Updated/Status',
  },
};

@Injectable()
export class BcpQrProvider implements PaymentProvider {
  readonly name = 'BCP_QR';

  private configuration: BcpConfiguration | null = null;

  constructor(private readonly configService: ConfigService) {}

  async createQrPayment(
    input: CreateQrPaymentInput,
  ): Promise<CreateQrPaymentResult> {
    const configuration = this.getConfiguration();

    const amount = this.parseAmount(input.amount);

    const response = await this.postJson<BcpGenerateResponse>(
      configuration.endpoints.generatePath,
      {
        appUserId: configuration.appUserId,
        currency: input.currency.trim().toUpperCase(),
        amount,
        gloss: this.buildGloss(input.externalReference),
        serviceCode: configuration.serviceCode,
        businessCode: configuration.businessCode,
        singleUse: true,
        enableBank: configuration.enableBank,
        city: configuration.city,
        branchOffice: configuration.branchOffice,
        teller: configuration.teller,
        phoneNumber: configuration.phoneNumber,
        publicToken: configuration.publicToken,
        expiration: this.buildExpiration(input.expiresAt),
        collectors: [],
      },
      input.externalReference,
    );

    this.assertSuccessfulState(response.state);

    if (response.data === null || typeof response.data !== 'object') {
      throw new BadGatewayException('BCP QR generation returned invalid data');
    }

    const providerPaymentId = this.normalizeGeneratedId(response.data.id);

    const qrImage = this.normalizeQrImage(response.data.qrImage);

    return {
      providerPaymentId,
      status: 'PENDING',
      qrPayload: qrImage.base64,
      qrContentType: 'IMAGE_BASE64',
      qrMimeType: qrImage.mimeType,
      expiresAt: input.expiresAt,
    };
  }

  async getPaymentStatus(
    providerPaymentId: string,
  ): Promise<ProviderPaymentStatusResult> {
    const configuration = this.getConfiguration();

    const numericPaymentId = this.parseProviderPaymentId(providerPaymentId);

    const response = await this.postJson<BcpConsultResponse>(
      configuration.endpoints.consultPath,
      {
        appUserId: configuration.appUserId,
        id: numericPaymentId,
        serviceCode: configuration.serviceCode,
        businessCode: configuration.businessCode,
        publicToken: configuration.publicToken,
      },
      randomUUID(),
    );

    this.assertSuccessfulState(response.state);

    if (response.data === null || typeof response.data !== 'object') {
      throw new BadGatewayException(
        'BCP QR consultation returned invalid data',
      );
    }

    const status = this.normalizeString(response.data.status).toUpperCase();

    const operationNumber = this.normalizeOptionalString(
      response.data.operationNumber,
    );

    switch (status) {
      case 'C':
        return {
          providerPaymentId,
          providerTransactionId: null,
          status: 'PENDING',
          paidAt: null,
        };

      case 'P':
        if (operationNumber === null) {
          throw new BadGatewayException(
            'BCP confirmed a payment without an operation number',
          );
        }

        return {
          providerPaymentId,
          providerTransactionId: operationNumber,
          status: 'PAID',
          paidAt: null,
        };

      case 'V':
        return {
          providerPaymentId,
          providerTransactionId: null,
          status: 'EXPIRED',
          paidAt: null,
        };

      case 'A':
      case 'U':
        return {
          providerPaymentId,
          providerTransactionId: operationNumber,
          status: 'CANCELLED',
          paidAt: null,
        };

      default:
        throw new BadGatewayException(
          'BCP QR consultation returned an unknown status',
        );
    }
  }

  async cancelQrPayment(
    input: CancelQrPaymentInput,
  ): Promise<CancelQrPaymentResult> {
    const configuration = this.getConfiguration();

    const numericPaymentId = this.parseProviderPaymentId(
      input.providerPaymentId,
    );

    const response = await this.postJson<BcpUpdateStatusResponse>(
      configuration.endpoints.updateStatusPath,
      {
        appUserId: configuration.appUserId,
        id: numericPaymentId,
        status: 'A',
        detail: this.sanitizeCancellationReason(input.reason),
        serviceCode: configuration.serviceCode,
        businessCode: configuration.businessCode,
        publicToken: configuration.publicToken,
      },
      randomUUID(),
    );

    this.assertSuccessfulState(response.state);

    const status = this.normalizeString(response.status).toUpperCase();

    if (status !== 'A') {
      throw new BadGatewayException('BCP did not confirm QR cancellation');
    }

    return {
      providerPaymentId: input.providerPaymentId,
      status: 'CANCELLED',
    };
  }

  private getConfiguration(): BcpConfiguration {
    if (this.configuration !== null) {
      return this.configuration;
    }

    const environmentValue =
      this.requiredValue('BCP_QR_ENVIRONMENT').toLowerCase();

    if (environmentValue !== 'sandbox' && environmentValue !== 'production') {
      throw new ServiceUnavailableException(
        'BCP_QR_ENVIRONMENT must be sandbox or production',
      );
    }

    const environment = environmentValue as BcpEnvironment;

    const pfxPath = this.requiredValue('BCP_QR_PFX_PATH');

    if (!isAbsolute(pfxPath)) {
      throw new ServiceUnavailableException(
        'BCP_QR_PFX_PATH must be an absolute path',
      );
    }

    if (!existsSync(pfxPath)) {
      throw new ServiceUnavailableException(
        'BCP QR client certificate was not found',
      );
    }

    let certificate: Buffer;

    try {
      certificate = readFileSync(pfxPath);
    } catch {
      throw new ServiceUnavailableException(
        'BCP QR client certificate could not be read',
      );
    }

    if (certificate.length === 0) {
      throw new ServiceUnavailableException(
        'BCP QR client certificate is empty',
      );
    }

    const username = this.requiredValue('BCP_QR_USERNAME');

    const password = this.requiredSecret('BCP_QR_PASSWORD');

    const pfxPassphrase = this.requiredSecret('BCP_QR_PFX_PASSPHRASE');

    const requestTimeoutMs = this.readRequestTimeout();

    const authorization = Buffer.from(
      `${username}:${password}`,
      'utf8',
    ).toString('base64');

    this.configuration = {
      endpoints: BCP_ENDPOINTS[environment],
      authorization: `Basic ${authorization}`,
      appUserId: this.requiredValue('BCP_QR_APP_USER_ID'),
      publicToken: this.requiredValue('BCP_QR_PUBLIC_TOKEN'),
      businessCode: this.requiredValue('BCP_QR_BUSINESS_CODE'),
      serviceCode: this.optionalValue('BCP_QR_SERVICE_CODE') || '050',
      city: this.requiredValue('BCP_QR_CITY'),
      branchOffice: this.requiredValue('BCP_QR_BRANCH_OFFICE'),
      teller: this.requiredValue('BCP_QR_TELLER'),
      phoneNumber: this.requiredValue('BCP_QR_PHONE_NUMBER'),
      enableBank: this.optionalValue('BCP_QR_ENABLE_BANK') || 'ALL',
      requestTimeoutMs,
      agent: new Agent({
        pfx: certificate,
        passphrase: pfxPassphrase,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        keepAlive: true,
        maxSockets: 20,
      }),
    };

    return this.configuration;
  }

  private async postJson<TResponse>(
    path: string,
    body: Record<string, unknown>,
    correlationId: string,
  ): Promise<TResponse> {
    const configuration = this.getConfiguration();

    const normalizedCorrelationId = correlationId.trim();

    if (!/^[A-Za-z0-9-]{1,128}$/.test(normalizedCorrelationId)) {
      throw new BadRequestException('Invalid BCP correlation identifier');
    }

    const payload = Buffer.from(JSON.stringify(body), 'utf8');

    const url = new URL(path, configuration.endpoints.baseUrl);

    return new Promise<TResponse>((resolve, reject) => {
      let settled = false;
      let timedOut = false;

      const succeed = (value: TResponse): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(value);
      };

      const fail = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      };

      const outboundRequest = request(
        url,
        {
          method: 'POST',
          agent: configuration.agent,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Content-Length': payload.byteLength,
            'Correlation-Id': normalizedCorrelationId,
            Authorization: configuration.authorization,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let responseSize = 0;

          response.on('data', (chunk: Buffer) => {
            if (settled) {
              return;
            }

            responseSize += chunk.length;

            if (responseSize > MAX_RESPONSE_BYTES) {
              response.destroy();

              fail(
                new BadGatewayException(
                  'BCP QR response exceeded the allowed size',
                ),
              );

              return;
            }

            chunks.push(chunk);
          });

          response.on('error', () => {
            fail(new BadGatewayException('BCP QR response stream failed'));
          });

          response.on('end', () => {
            if (settled) {
              return;
            }

            const statusCode = response.statusCode || 0;

            if (statusCode < 200 || statusCode >= 300) {
              fail(
                new BadGatewayException('BCP QR service rejected the request'),
              );

              return;
            }

            const responseBody = Buffer.concat(chunks).toString('utf8');

            if (responseBody.trim().length === 0) {
              fail(
                new BadGatewayException(
                  'BCP QR service returned an empty response',
                ),
              );

              return;
            }

            let parsedResponse: unknown;

            try {
              parsedResponse = JSON.parse(responseBody);
            } catch {
              fail(
                new BadGatewayException('BCP QR service returned invalid JSON'),
              );

              return;
            }

            if (
              parsedResponse === null ||
              typeof parsedResponse !== 'object' ||
              Array.isArray(parsedResponse)
            ) {
              fail(
                new BadGatewayException(
                  'BCP QR service returned an invalid response',
                ),
              );

              return;
            }

            succeed(parsedResponse as TResponse);
          });
        },
      );

      outboundRequest.setTimeout(configuration.requestTimeoutMs, () => {
        timedOut = true;

        outboundRequest.destroy(new Error('BCP request timed out'));
      });

      outboundRequest.on('error', () => {
        if (timedOut) {
          fail(new GatewayTimeoutException('BCP QR service timed out'));

          return;
        }

        fail(new BadGatewayException('BCP QR service request failed'));
      });

      outboundRequest.end(payload);
    });
  }

  private assertSuccessfulState(state: unknown): void {
    if (this.normalizeString(state) !== '00') {
      throw new BadGatewayException(
        'BCP QR service did not complete the request',
      );
    }
  }

  private normalizeGeneratedId(value: unknown): string {
    const numericValue =
      typeof value === 'number' ? value : Number(this.normalizeString(value));

    if (!Number.isSafeInteger(numericValue) || numericValue <= 0) {
      throw new BadGatewayException(
        'BCP QR generation returned an invalid identifier',
      );
    }

    return numericValue.toString();
  }

  private parseProviderPaymentId(providerPaymentId: string): number {
    const normalized = providerPaymentId.trim();

    if (!/^[0-9]+$/.test(normalized)) {
      throw new ServiceUnavailableException(
        'Stored BCP payment identifier is invalid',
      );
    }

    const numericValue = Number(normalized);

    if (!Number.isSafeInteger(numericValue) || numericValue <= 0) {
      throw new ServiceUnavailableException(
        'Stored BCP payment identifier is invalid',
      );
    }

    return numericValue;
  }

  private parseAmount(value: string): number {
    const amount = Number(value);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Payment amount must be greater than zero');
    }

    const roundedAmount = Number(amount.toFixed(2));

    if (Math.abs(amount - roundedAmount) > Number.EPSILON) {
      throw new BadRequestException(
        'Payment amount must have at most two decimals',
      );
    }

    return roundedAmount;
  }

  private buildGloss(externalReference: string): string {
    const sanitizedReference = externalReference
      .replace(/[^A-Za-z0-9 -]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const gloss = `Pago ${sanitizedReference}`.trim();

    if (gloss.length === 0) {
      throw new BadRequestException('Payment gloss cannot be empty');
    }

    return gloss.slice(0, 60);
  }

  private buildExpiration(expiresAt: Date): string {
    const expirationTimestamp = expiresAt.getTime();

    if (!Number.isFinite(expirationTimestamp)) {
      throw new BadRequestException('Payment expiration is invalid');
    }

    const remainingMilliseconds = expirationTimestamp - Date.now();

    if (remainingMilliseconds <= 0) {
      throw new BadRequestException('Payment expiration must be in the future');
    }

    const totalMinutes = Math.max(1, Math.ceil(remainingMilliseconds / 60_000));

    const maximumMinutes = 730 * 24 * 60;

    if (totalMinutes > maximumMinutes) {
      throw new BadRequestException('Payment expiration exceeds the BCP limit');
    }

    const days = Math.floor(totalMinutes / (24 * 60));

    const remainingAfterDays = totalMinutes - days * 24 * 60;

    const hours = Math.floor(remainingAfterDays / 60);

    const minutes = remainingAfterDays - hours * 60;

    return [
      days.toString().padStart(2, '0'),
      '/',
      hours.toString().padStart(2, '0'),
      ':',
      minutes.toString().padStart(2, '0'),
    ].join('');
  }

  private normalizeQrImage(value: unknown): {
    base64: string;
    mimeType: ProviderQrMimeType;
  } {
    let encodedImage = this.normalizeString(value);

    const dataUriMatch = /^data:(image\/png|image\/jpeg);base64,(.+)$/is.exec(
      encodedImage,
    );

    if (dataUriMatch !== null) {
      encodedImage = dataUriMatch[2];
    }

    encodedImage = encodedImage.replace(/\s+/g, '');

    if (
      encodedImage.length === 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedImage)
    ) {
      throw new BadGatewayException(
        'BCP QR service returned invalid image data',
      );
    }

    const remainder = encodedImage.length % 4;

    if (remainder === 1) {
      throw new BadGatewayException(
        'BCP QR service returned invalid Base64 data',
      );
    }

    if (remainder > 0) {
      encodedImage += '='.repeat(4 - remainder);
    }

    const image = Buffer.from(encodedImage, 'base64');

    if (image.length === 0 || image.length > MAX_QR_IMAGE_BYTES) {
      throw new BadGatewayException('BCP QR image size is invalid');
    }

    const isPng =
      image.length >= 8 &&
      image[0] === 0x89 &&
      image[1] === 0x50 &&
      image[2] === 0x4e &&
      image[3] === 0x47 &&
      image[4] === 0x0d &&
      image[5] === 0x0a &&
      image[6] === 0x1a &&
      image[7] === 0x0a;

    if (isPng) {
      return {
        base64: encodedImage,
        mimeType: 'image/png',
      };
    }

    const isJpeg =
      image.length >= 3 &&
      image[0] === 0xff &&
      image[1] === 0xd8 &&
      image[2] === 0xff;

    if (isJpeg) {
      return {
        base64: encodedImage,
        mimeType: 'image/jpeg',
      };
    }

    throw new BadGatewayException(
      'BCP QR service returned an unsupported image format',
    );
  }

  private sanitizeCancellationReason(reason: string): string {
    const sanitized = reason
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);

    return sanitized || 'Anulado por FlashCommerce';
  }

  private normalizeString(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return '';
    }

    return String(value).trim();
  }

  private normalizeOptionalString(value: unknown): string | null {
    const normalized = this.normalizeString(value);

    return normalized.length > 0 ? normalized : null;
  }

  private requiredValue(name: string): string {
    const value = this.configService.get<string>(name)?.trim() || '';

    if (value.length === 0) {
      throw new ServiceUnavailableException(`${name} is not configured`);
    }

    return value;
  }

  private requiredSecret(name: string): string {
    const value = this.configService.get<string>(name);

    if (typeof value !== 'string' || value.length === 0) {
      throw new ServiceUnavailableException(`${name} is not configured`);
    }

    return value;
  }

  private optionalValue(name: string): string {
    return this.configService.get<string>(name)?.trim() || '';
  }

  private readRequestTimeout(): number {
    const configuredValue =
      this.optionalValue('BCP_QR_REQUEST_TIMEOUT_MS') || '15000';

    const timeout = Number(configuredValue);

    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 60_000) {
      throw new ServiceUnavailableException(
        'BCP_QR_REQUEST_TIMEOUT_MS must be between 1000 and 60000',
      );
    }

    return timeout;
  }
}
