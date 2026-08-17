import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { PaymentsService } from './payments.service';

interface ConfirmCashPaymentBody {
  tenantCode?: string;
  branchCode?: string;
  cashReceivedAmount?: string | number;
  cashierReference?: string;
  terminalReference?: string;
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // POST /api/v1/payments/orders/:trackingToken/qr
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('orders/:trackingToken/qr')
  createQrPayment(
    @Param('trackingToken', new ParseUUIDPipe())
    trackingToken: string,
  ) {
    return this.paymentsService.createQrPayment(trackingToken);
  }

  // GET /api/v1/payments/orders/:trackingToken
  @Get('orders/:trackingToken')
  getOrderPayment(
    @Param('trackingToken', new ParseUUIDPipe())
    trackingToken: string,
  ) {
    return this.paymentsService.getOrderPayment(trackingToken);
  }
}

@Controller('ops/payments')
export class OpsPaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // SOLO CAJA PRESENCIAL:
  // POST /api/v1/ops/payments/orders/:orderId/cash
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('orders/:orderId/cash')
  confirmCashPayment(
    @Param('orderId', new ParseUUIDPipe())
    orderId: string,

    @Headers('x-cashier-key')
    cashierAccessKey: string | undefined,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Body()
    body: ConfirmCashPaymentBody,
  ) {
    return this.paymentsService.confirmCashPayment(orderId, {
      tenantCode: body?.tenantCode,
      branchCode: body?.branchCode,
      cashReceivedAmount: body?.cashReceivedAmount,
      cashierReference: body?.cashierReference,
      terminalReference: body?.terminalReference,
      idempotencyKey,
      cashierAccessKey,
    });
  }

  // SOLO LABORATORIO:
  // POST /api/v1/ops/payments/:paymentId/mock-confirm
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':paymentId/mock-confirm')
  confirmMockPayment(
    @Param('paymentId', new ParseUUIDPipe())
    paymentId: string,

    @Headers('x-payment-lab-key')
    paymentLabKey: string | undefined,
  ) {
    return this.paymentsService.confirmMockPayment(paymentId, paymentLabKey);
  }
}
