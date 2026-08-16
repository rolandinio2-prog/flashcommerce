import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // POST /api/v1/payments/orders/:trackingToken/qr
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

  // SOLO LABORATORIO:
  // POST /api/v1/ops/payments/:paymentId/mock-confirm
  @Post(':paymentId/mock-confirm')
  confirmMockPayment(
    @Param('paymentId', new ParseUUIDPipe())
    paymentId: string,
  ) {
    return this.paymentsService.confirmMockPayment(paymentId);
  }
}
