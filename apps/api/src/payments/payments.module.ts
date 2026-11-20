import { CashClosingController } from './cash-closing.controller';
import { CashClosingService } from './cash-closing.service';
import { CashSummaryController } from './cash-summary.controller';
import { CashSummaryService } from './cash-summary.service';
import { OperationsModule } from '../operations/operations.module';
import { Module } from '@nestjs/common';

import { StaffModule } from '../staff/staff.module';
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
  providers: [ CashClosingService, CashSummaryService, PaymentsService, MockQrProvider, BcpQrProvider, OpsAccessGuard, AdminDevQrPaymentService ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
