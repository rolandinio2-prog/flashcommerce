import {
  Controller,
  Get,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import { DriverAccessGuard } from './driver-access.guard';
import type { DriverAuthenticatedRequest } from './driver-access.guard';

@Controller('driver')
@UseGuards(DriverAccessGuard)
export class DriverController {
  @Get('me')
  getAuthenticatedDriver(
    @Req()
    request: DriverAuthenticatedRequest,
  ) {
    const identity =
      request.driverAuth;

    if (!identity) {
      throw new UnauthorizedException(
        'Invalid driver credentials',
      );
    }

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
}