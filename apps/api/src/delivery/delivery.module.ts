import { Module } from '@nestjs/common';

import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DriverAccessGuard } from './driver-access.guard';
import { DriverController } from './driver.controller';
import { OpsAccessGuard } from './ops-access.guard';
import { OpsDeliveryController } from './ops-delivery.controller';

@Module({
  controllers: [
    DeliveryController,
    OpsDeliveryController,
    DriverController,
  ],

  providers: [
    DeliveryService,
    OpsAccessGuard,
    DriverAccessGuard,
  ],

  exports: [
    DeliveryService,
  ],
})
export class DeliveryModule {}