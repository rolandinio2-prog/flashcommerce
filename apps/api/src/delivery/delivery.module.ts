import { Module } from '@nestjs/common';

import { PaymentsModule } from '../payments/payments.module';
import { DeliveryAddressService } from './delivery-address.service';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DriverAccessGuard } from './driver-access.guard';
import { GEOCODING_PROVIDER } from './geocoding-provider';
import { GEO_PROVIDER } from './geo-provider';
import { GoogleGeocodingProvider } from './google-geocoding.provider';
import { GoogleGeoProvider } from './google-geo.provider';
import { GoogleRoutingProvider } from './google-routing.provider';
import { ROUTING_PROVIDER } from './routing-provider';
import { DriverController } from './driver.controller';
import { OpsAccessGuard } from './ops-access.guard';
import { OpsDeliveryController } from './ops-delivery.controller';
import { GeoProfileResolver } from './geo-profile-resolver.service';

@Module({
  imports: [PaymentsModule],

  controllers: [
    DeliveryController,
    OpsDeliveryController,
    DriverController,
  ],

  providers: [
    GeoProfileResolver,
    DeliveryService,
    DeliveryAddressService,

    GoogleGeoProvider,
    {
      provide: GEO_PROVIDER,
      useExisting: GoogleGeoProvider,
    },

    GoogleRoutingProvider,
    {
      provide: ROUTING_PROVIDER,
      useExisting: GoogleRoutingProvider,
    },

    GoogleGeocodingProvider,
    {
      provide: GEOCODING_PROVIDER,
      useExisting: GoogleGeocodingProvider,
    },

    OpsAccessGuard,
    DriverAccessGuard,
  ],

  exports: [
    GeoProfileResolver,
    DeliveryService,
    GEO_PROVIDER,
    ROUTING_PROVIDER,
    GEOCODING_PROVIDER,
  ],
})
export class DeliveryModule {}
