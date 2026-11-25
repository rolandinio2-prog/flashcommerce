import { OperationsModule } from '../core/operations/operations.module';
import { Module } from '@nestjs/common';

import { PaymentsModule } from '../payments/payments.module';
import { DeliveryAddressService } from './delivery-address.service';
import { DeliveryController } from './delivery.controller';
import { DeliveryRoutingService } from './delivery-routing.service';
import { DeliveryCheckoutService } from './delivery-checkout.service';
import { CourierService } from './courier/courier.service';
import { CourierController } from './courier/courier.controller';
import { CourierSettlementService } from './courier/courier-settlement.service';
import { CourierSettlementController } from './courier/courier-settlement.controller';
import { DriverDeliveryService } from './driver-delivery.service';
import { DeliveryOpsService } from './delivery-ops.service';
import { DeliveryPublicTrackingService } from './delivery-public-tracking.service';
import { DeliveryDispatchQueueService } from './delivery-dispatch-queue.service';
import { DriverAccessGuard } from './driver-access.guard';
import { DriverAuthController } from './driver-auth.controller';
import { DriverAuthService } from './driver-auth.service';
import { GEOCODING_PROVIDER } from './geocoding-provider';
import { GEO_PROVIDER } from './geo-provider';
import { GoogleGeocodingProvider } from './google-geocoding.provider';
import { GoogleGeoProvider } from './google-geo.provider';
import { GoogleRoutingProvider } from './google-routing.provider';
import { GeoShadowEtaCalibrationService } from './geo-shadow-eta-calibration.service';
import { GeoShadowEtaOrchestratorService } from './geo-shadow-eta-orchestrator.service';
import { ValhallaRoutingProvider } from './valhalla-routing.provider';
import { ROUTING_PROVIDER } from './routing-provider';
import { DriverController } from './driver.controller';
import { OpsAccessGuard } from './ops-access.guard';
import { OpsDeliveryController } from './ops-delivery.controller';
import { GeoProfileResolver } from './geo-profile-resolver.service';
import { GeoUsageMeterService } from './geo-usage-meter.service';

import { DeliveryMonitorController } from './delivery-monitor.controller';
import { DeliveryMonitorService } from './delivery-monitor.service';
import { DeliveryMonitorRealtimeSessionService } from './delivery-monitor-realtime-session.service';

@Module({
  imports: [OperationsModule, PaymentsModule],

  controllers: [
    DeliveryMonitorController,
    DeliveryController,
    OpsDeliveryController,
    DriverController,
    DriverAuthController,
    CourierController,
    CourierSettlementController,
  ],

  providers: [
    CourierService,
    CourierSettlementService,
    DeliveryMonitorService,
    DeliveryMonitorRealtimeSessionService,
    GeoProfileResolver,
    DeliveryRoutingService,
    DeliveryCheckoutService,
    DriverDeliveryService,
    DeliveryOpsService,
    DeliveryPublicTrackingService,
    DeliveryDispatchQueueService,
    DeliveryAddressService,
    GeoUsageMeterService,

    GoogleGeoProvider,
    {
      provide: GEO_PROVIDER,
      useExisting: GoogleGeoProvider,
    },

    GoogleRoutingProvider,
    ValhallaRoutingProvider,
    GeoShadowEtaCalibrationService,
    GeoShadowEtaOrchestratorService,
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
    DriverAuthService,
  ],

  exports: [
    GeoProfileResolver,
    DeliveryRoutingService,
    DeliveryCheckoutService,
    DriverDeliveryService,
    DeliveryOpsService,
    DeliveryPublicTrackingService,
    GEO_PROVIDER,
    ROUTING_PROVIDER,
    GEOCODING_PROVIDER,
  ],
})
export class DeliveryModule {}
