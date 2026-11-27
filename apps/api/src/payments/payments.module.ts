import { CashClosingController } from './cash-closing.controller';
import { CashClosingService } from './cash-closing.service';
import { CashSummaryController } from './cash-summary.controller';
import { CashSummaryService } from './cash-summary.service';
import { OperationsModule } from '../core/operations/operations.module';
import { Module } from '@nestjs/common';

import { StaffModule } from '../core/staff/staff.module';
import { AdminDevQrPaymentController } from './admin-dev-qr-payment.controller';
import { AdminDevQrPaymentService } from './admin-dev-qr-payment.service';
import { BcpPaymentCallbackController } from './bcp-payment-callback.controller';
import { BcpQrProvider } from './bcp-qr.provider';
import { MockQrProvider } from './mock-qr.provider';
import {
  OpsPaymentsController,
  PaymentsController,
} from './payments.controller';
import { OpsAccessGuard } from '../delivery/ops-access.guard';
import { PaymentsService } from './payments.service';
import { BcpQrCallbackService } from './bcp-qr-callback.service';
import { CashPaymentService } from './cash-payment.service';
import { DriverCodCashService } from './driver-cod-cash.service';

@Module({
  imports: [OperationsModule, StaffModule],
  controllers: [
    CashClosingController,
    CashSummaryController,
    PaymentsController,
    OpsPaymentsController,
    BcpPaymentCallbackController,
    AdminDevQrPaymentController,
  ],
  providers: [
    CashClosingService,
    CashSummaryService,
    PaymentsService,
    BcpQrCallbackService,
    CashPaymentService,
    DriverCodCashService,
    MockQrProvider,
    BcpQrProvider,
    OpsAccessGuard,
    AdminDevQrPaymentService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
