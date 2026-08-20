import { Module } from '@nestjs/common';

import { PaymentsModule } from '../payments/payments.module';
import { DeliveryAddressService } from './delivery-address.service';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DriverAccessGuard } from './driver-access.guard';
import { GEO_PROVIDER } from './geo-provider';
import { GoogleGeoProvider } from './google-geo.provider';
import { DriverController } from './driver.controller';
import { OpsAccessGuard } from './ops-access.guard';
import { OpsDeliveryController } from './ops-delivery.controller';

@Module({
  imports: [PaymentsModule],

  controllers: [
    DeliveryController,
    OpsDeliveryController,
    DriverController,
  ],

  providers: [
    DeliveryService,
    DeliveryAddressService,

    GoogleGeoProvider,
    {
      provide: GEO_PROVIDER,
      useExisting: GoogleGeoProvider,
    },

    OpsAccessGuard,
    DriverAccessGuard,
  ],

  exports: [
    DeliveryService,
    GEO_PROVIDER,
  ],
})
export class DeliveryModule {}