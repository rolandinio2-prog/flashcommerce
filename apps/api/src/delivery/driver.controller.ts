import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

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
      },

      credential: {
        expiresAt:
          identity.expiresAt,
      },
    };
  }

  @Patch('deliveries/:deliveryId/accept')
  acceptDelivery(
    @Param('deliveryId')
    deliveryId: string,

    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      this.requireIdentity(request);

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
      this.requireIdentity(request);

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
      this.requireIdentity(request);

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
      this.requireIdentity(request);

    return this.deliveryService.arriveDriverDelivery(
      deliveryId,
      identity.tenantId,
      identity.driverId,
      identity.driverCode,
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
      this.requireIdentity(request);

    return this.deliveryService.deliverDriverDelivery(
      deliveryId,
      identity.tenantId,
      identity.driverId,
      identity.driverCode,
      body?.pod,
    );
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