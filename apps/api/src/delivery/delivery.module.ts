import { Module } from '@nestjs/common';

import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { OpsAccessGuard } from './ops-access.guard';
import { OpsDeliveryController } from './ops-delivery.controller';

@Module({
  controllers: [
    DeliveryController,
    OpsDeliveryController,
  ],
  providers: [
    DeliveryService,
    OpsAccessGuard,
  ],
  exports: [DeliveryService],
})
export class DeliveryModule {}