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


interface OpenDriverCodCashSettlementBody {
  tenantCode?: string;
  branchCode?: string;
  driverId?: string;
  currency?: string;
  cashierReference?: string;
  notes?: string;
}

interface SettleDriverCodCashSettlementBody {
  tenantCode?: string;
  branchCode?: string;
  receivedAmount?: string | number;
  cashierReference?: string;
}

interface CancelDriverCodCashSettlementBody {
  tenantCode?: string;
  branchCode?: string;
  cashierReference?: string;
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

  // POST /api/v1/payments/orders/:trackingToken/cod
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('orders/:trackingToken/cod')
  createDriverCodPayment(
    @Param('trackingToken', new ParseUUIDPipe())
    trackingToken: string,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,
  ) {
    return this.paymentsService.createDriverCodPayment(
      trackingToken,
      idempotencyKey,
    );
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

  // =====================================================
  // FLASHDELIVERY COD - LIQUIDACION DE EFECTIVO
  // =====================================================

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('cash-settlements/open')
  openDriverCodCashSettlement(
    @Headers('x-cashier-key')
    cashierAccessKey: string | undefined,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Body()
    body: OpenDriverCodCashSettlementBody,
  ) {
    return this.paymentsService.openDriverCodCashSettlement({
      tenantCode: body?.tenantCode,
      branchCode: body?.branchCode,
      driverId: body?.driverId,
      currency: body?.currency,
      cashierReference: body?.cashierReference,
      notes: body?.notes,
      idempotencyKey,
      cashierAccessKey,
    });
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('cash-settlements/:settlementId/settle')
  settleDriverCodCashSettlement(
    @Param('settlementId', new ParseUUIDPipe())
    settlementId: string,

    @Headers('x-cashier-key')
    cashierAccessKey: string | undefined,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Body()
    body: SettleDriverCodCashSettlementBody,
  ) {
    return this.paymentsService.settleDriverCodCashSettlement(
      settlementId,
      {
        tenantCode: body?.tenantCode,
        branchCode: body?.branchCode,
        receivedAmount: body?.receivedAmount,
        cashierReference: body?.cashierReference,
        idempotencyKey,
        cashierAccessKey,
      },
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('cash-settlements/:settlementId/cancel')
  cancelDriverCodCashSettlement(
    @Param('settlementId', new ParseUUIDPipe())
    settlementId: string,

    @Headers('x-cashier-key')
    cashierAccessKey: string | undefined,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Body()
    body: CancelDriverCodCashSettlementBody,
  ) {
    return this.paymentsService.cancelDriverCodCashSettlement(
      settlementId,
      {
        tenantCode: body?.tenantCode,
        branchCode: body?.branchCode,
        cashierReference: body?.cashierReference,
        idempotencyKey,
        cashierAccessKey,
      },
    );
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
