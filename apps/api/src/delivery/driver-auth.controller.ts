import {
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { DriverAccessGuard } from './driver-access.guard';
import type { DriverAuthenticatedRequest } from './driver-access.guard';
import { DriverAuthService } from './driver-auth.service';

@Controller('driver/auth')
export class DriverAuthController {
  constructor(private readonly driverAuthService: DriverAuthService) {}

  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post('login')
  login(
    @Body()
    body: {
      tenantCode?: unknown;
      driverCode?: unknown;
      password?: unknown;
    },
  ) {
    return this.driverAuthService.login(body);
  }

  @UseGuards(DriverAccessGuard)
  @Post('change-password')
  changePassword(
    @Req() request: DriverAuthenticatedRequest,
    @Body() body: { newPassword?: unknown },
  ) {
    return this.driverAuthService.changePassword(
      this.requireIdentity(request),
      body,
    );
  }

  @UseGuards(DriverAccessGuard)
  @Post('logout')
  logout(@Req() request: DriverAuthenticatedRequest) {
    return this.driverAuthService.logout(this.requireIdentity(request));
  }

  private requireIdentity(request: DriverAuthenticatedRequest) {
    if (!request.driverAuth) {
      throw new UnauthorizedException('Invalid driver credentials');
    }

    return request.driverAuth;
  }
}
