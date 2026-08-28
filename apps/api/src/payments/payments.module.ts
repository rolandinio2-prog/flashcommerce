import { Module } from '@nestjs/common';

import { StaffModule } from '../staff/staff.module';
import { BcpPaymentCallbackController } from './bcp-payment-callback.controller';
import { BcpQrProvider } from './bcp-qr.provider';
import { MockQrProvider } from './mock-qr.provider';
import {
  OpsPaymentsController,
  PaymentsController,
} from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [StaffModule],
  controllers: [
    PaymentsController,
    OpsPaymentsController,
    BcpPaymentCallbackController,
  ],
  providers: [PaymentsService, MockQrProvider, BcpQrProvider],
  exports: [PaymentsService],
})
export class PaymentsModule {}
