import { Module } from '@nestjs/common';

import { BcpQrProvider } from './bcp-qr.provider';
import { MockQrProvider } from './mock-qr.provider';
import {
  OpsPaymentsController,
  PaymentsController,
} from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [PaymentsController, OpsPaymentsController],
  providers: [PaymentsService, MockQrProvider, BcpQrProvider],
  exports: [PaymentsService],
})
export class PaymentsModule {}
