import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
  ForbiddenException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { DeliveryService } from './delivery.service';
import { DriverAccessGuard } from './driver-access.guard';
import type { DriverAuthenticatedRequest } from './driver-access.guard';

@Controller('driver')
@UseGuards(DriverAccessGuard)
export class DriverController {
  constructor(
    private readonly deliveryService: DeliveryService,
  ) {}

  @Get('me')
  getAuthenticatedDriver(
    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      this.requireIdentity(request);

    return {
      authenticated: true,

      tenant: {
        id: identity.tenantId,
        code: identity.tenantCode,
      },

      driver: {
        id: identity.driverId,
        code: identity.driverCode,

        displayName:
          identity.displayName,

        phone:
          identity.phone,

        status: 'ACTIVE',
        passwordChangeRequired: identity.passwordChangeRequired,
      },

      credential: {
        expiresAt:
          identity.expiresAt,
      },
    };
  }

  @Get('deliveries/active')
  getActiveDeliveries(
    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      this.requireOperationalIdentity(request);

    return this.deliveryService.getDriverActiveDeliveries(
      identity.tenantId,
      identity.driverId,
    );
  }
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('deliveries/:deliveryId/map-route')
  getDeliveryMapRoute(
    @Param('deliveryId')
    deliveryId: string,

    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      this.requireOperationalIdentity(request);

    return this.deliveryService.getDriverDeliveryMapRoute(
      deliveryId,
      identity.tenantId,
      identity.driverId,
    );
  }
  @Patch('deliveries/:deliveryId/accept')
  acceptDelivery(
    @Param('deliveryId')
    deliveryId: string,

    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      this.requireOperationalIdentity(request);

    return this.deliveryService.acceptDriverDelivery(
      deliveryId,
      identity.tenantId,
      identity.driverId,
      identity.driverCode,
    );
  }

  @Patch('deliveries/:deliveryId/pickup')
  pickupDelivery(
    @Param('deliveryId')
    deliveryId: string,

    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      this.requireOperationalIdentity(request);

    return this.deliveryService.pickupDriverDelivery(
      deliveryId,
      identity.tenantId,
      identity.driverId,
      identity.driverCode,
    );
  }
  @Patch('deliveries/:deliveryId/en-route')
  startDeliveryRoute(
    @Param('deliveryId')
    deliveryId: string,

    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      this.requireOperationalIdentity(request);

    return this.deliveryService.startDriverDelivery(
      deliveryId,
      identity.tenantId,
      identity.driverId,
      identity.driverCode,
    );
  }
  @Patch('deliveries/:deliveryId/arrive')
  arriveDelivery(
    @Param('deliveryId')
    deliveryId: string,

    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      this.requireOperationalIdentity(request);

    return this.deliveryService.arriveDriverDelivery(
      deliveryId,
      identity.tenantId,
      identity.driverId,
      identity.driverCode,
    );
  }
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('deliveries/:deliveryId/location')
  recordLocation(
    @Param('deliveryId')
    deliveryId: string,

    @Body()
    body: {
      latitude?: unknown;
      longitude?: unknown;

      accuracyMeters?: unknown;
      headingDegrees?: unknown;
      speedMps?: unknown;

      capturedAt?: unknown;
    },

    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      this.requireOperationalIdentity(request);

    return this.deliveryService.recordDriverLocation(
      deliveryId,
      identity.tenantId,
      identity.driverId,
      body,
    );
  }
  @Throttle({
    default: {
      limit: 10,
      ttl: 60_000,
    },
  })
  @Post('deliveries/:deliveryId/cash-collection')
  collectCash(
    @Param('deliveryId')
    deliveryId: string,

    @Headers('idempotency-key')
    idempotencyKey: string | undefined,

    @Body()
    body: {
      cashReceivedAmount?: unknown;
    },

    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity = this.requireOperationalIdentity(request);

    return this.deliveryService.collectDriverCodCash(
      deliveryId,
      identity.tenantId,
      identity.driverId,
      identity.driverCode,
      body?.cashReceivedAmount,
      idempotencyKey,
    );
  }
  @Patch('deliveries/:deliveryId/deliver')
  deliverDelivery(
    @Param('deliveryId')
    deliveryId: string,

    @Body()
    body: {
      pod?: unknown;
    },

    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      this.requireOperationalIdentity(request);

    return this.deliveryService.deliverDriverDelivery(
      deliveryId,
      identity.tenantId,
      identity.driverId,
      identity.driverCode,
      body?.pod,
    );
  }
  private requireOperationalIdentity(
    request: DriverAuthenticatedRequest,
  ) {
    const identity = this.requireIdentity(request);

    if (identity.passwordChangeRequired) {
      throw new ForbiddenException(
        'Driver password change is required',
      );
    }

    return identity;
  }

  private requireIdentity(
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      request.driverAuth;

    if (!identity) {
      throw new UnauthorizedException(
        'Invalid driver credentials',
      );
    }

    return identity;
  }
}
