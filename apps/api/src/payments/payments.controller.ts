import { OperationsAccess, OperationPermission } from '../operations/operations-access';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import type { StaffAuthenticatedRequest } from '../staff/staff.types';

import { PaymentsService } from './payments.service';

interface ConfirmCashPaymentBody {
  cashReceivedAmount?: string | number;
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
    @Body() body?: { customerPhone?: unknown },
  ) {
    return this.paymentsService.createQrPayment(trackingToken, body?.customerPhone);
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
@OperationsAccess()
export class OpsPaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // SOLO CAJA PRESENCIAL:
  // POST /api/v1/ops/payments/orders/:orderId/cash
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('orders/:orderId/cash')
  @OperationPermission('payments.cash')
  confirmCashPayment(
    @Param('orderId', new ParseUUIDPipe())
    orderId: string,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Req()
    request: StaffAuthenticatedRequest,

    @Body()
    body: ConfirmCashPaymentBody,
  ) {
    return this.paymentsService.confirmCashPayment(orderId, {
      tenantCode: request.staff.tenantCode,
      branchCode: request.staff.branchCode,
      cashReceivedAmount: body?.cashReceivedAmount,
      terminalReference: body?.terminalReference,
      idempotencyKey,
      operatorUserId: request.staff.userId,
      operatorCode: request.staff.userCode,
      operatorDisplayName: request.staff.displayName,
    });
  }

  // =====================================================
  // FLASHDELIVERY COD - LIQUIDACION DE EFECTIVO
  // =====================================================

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('cash-settlements/open')
  @OperationPermission('payments.settle')
  openDriverCodCashSettlement(
    @Req() request: StaffAuthenticatedRequest,
    @Headers('x-cashier-key')
    cashierAccessKey: string | undefined,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Body()
    body: OpenDriverCodCashSettlementBody,
  ) {
    return this.paymentsService.openDriverCodCashSettlement({
      tenantCode: request.staff.tenantCode,
      branchCode: request.staff.branchCode,
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
  @OperationPermission('payments.settle')
  settleDriverCodCashSettlement(
    @Req() request: StaffAuthenticatedRequest,
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
        tenantCode: request.staff.tenantCode,
        branchCode: request.staff.branchCode,
        receivedAmount: body?.receivedAmount,
        cashierReference: body?.cashierReference,
        idempotencyKey,
        cashierAccessKey,
      },
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('cash-settlements/:settlementId/cancel')
  @OperationPermission('payments.settle')
  cancelDriverCodCashSettlement(
    @Req() request: StaffAuthenticatedRequest,
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
        tenantCode: request.staff.tenantCode,
        branchCode: request.staff.branchCode,
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
  @OperationPermission('payments.mock')
  confirmMockPayment(
    @Req() request: StaffAuthenticatedRequest,
    @Param('paymentId', new ParseUUIDPipe())
    paymentId: string,

    @Headers('x-payment-lab-key')
    paymentLabKey: string | undefined,
  ) {
    return this.paymentsService.confirmMockPayment(paymentId, paymentLabKey, request.staff);
  }

  // R6.13.4.8.3 - Ops provider-truth reconciliation
  @Post(':orderNumber/reconcile')
  @OperationPermission('payments.reconcile')
  reconcileReviewRequired(
    @Req() request: StaffAuthenticatedRequest,
    @Param('orderNumber') orderNumber: string,
  ) {
    return this.paymentsService.reconcileReviewRequiredByOrderNumber(
      orderNumber,
      request.staff,
    );
  }
}
