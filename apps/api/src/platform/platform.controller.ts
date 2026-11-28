import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import {
  PLATFORM_SESSION_COOKIE,
  PlatformAuthService,
  type PlatformPrincipal,
} from './platform-auth.service';
import {
  AllowPendingPassword,
  PlatformSessionGuard,
  type PlatformRequest,
} from './platform-session.guard';
import {
  PlatformTenantsService,
  type AdminPersonInput,
  type CreateTenantInput,
} from './platform-tenants.service';

function cookieOptions() {
  const local = ['development', 'test'].includes(process.env.NODE_ENV ?? '');
  const https = [
    process.env.FLASH_CUSTOMER_URL ?? '',
    ...(process.env.FLASH_ALLOWED_ORIGINS ?? '').split(','),
  ].some((o) => o.trim().toLowerCase().startsWith('https://'));
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: !local || https,
    path: '/',
  };
}
const who = (req: PlatformRequest): PlatformPrincipal => req.platform!;

/** FlashCommerce Cloud platform console API (operators of the platform, not business staff). */
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly tenants: PlatformTenantsService,
  ) {}

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('auth/bootstrap')
  bootstrap(
    @Headers('x-ops-key') opsKey: string | undefined,
    @Body() body: { email?: unknown; displayName?: unknown },
  ) {
    return this.auth.bootstrap(body, opsKey);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body() body: { email?: unknown; password?: unknown },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, expiresAt, principal } = await this.auth.login(body);
    res.cookie(PLATFORM_SESSION_COOKIE, token, {
      ...cookieOptions(),
      expires: expiresAt,
    });
    return { operator: principal };
  }

  @UseGuards(PlatformSessionGuard)
  @AllowPendingPassword()
  @Get('auth/me')
  me(@Req() req: PlatformRequest) {
    return { operator: who(req) };
  }

  @UseGuards(PlatformSessionGuard)
  @AllowPendingPassword()
  @Post('auth/change-password')
  @HttpCode(200)
  changePassword(
    @Req() req: PlatformRequest,
    @Body() body: { currentPassword?: unknown; newPassword?: unknown },
  ) {
    return this.auth.changePassword(who(req), body);
  }

  @UseGuards(PlatformSessionGuard)
  @AllowPendingPassword()
  @Post('auth/logout')
  @HttpCode(200)
  async logout(
    @Req() req: PlatformRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(who(req).sessionId);
    res.clearCookie(PLATFORM_SESSION_COOKIE, cookieOptions());
    return { ok: true };
  }

  @UseGuards(PlatformSessionGuard)
  @Get('tenants')
  list() {
    return this.tenants.list();
  }

  @UseGuards(PlatformSessionGuard)
  @Post('tenants')
  create(@Req() req: PlatformRequest, @Body() body: CreateTenantInput) {
    return this.tenants.create(who(req), body);
  }

  @UseGuards(PlatformSessionGuard)
  @Get('tenants/:id')
  get(@Param('id') id: string) {
    return this.tenants.get(id);
  }

  @UseGuards(PlatformSessionGuard)
  @Post('tenants/:id/initial-admin')
  initialAdmin(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body() body: AdminPersonInput,
  ) {
    return this.tenants.createInitialAdmin(who(req), id, body ?? {});
  }

  @UseGuards(PlatformSessionGuard)
  @Patch('tenants/:id/status')
  setStatus(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body() body: { status?: unknown; reason?: unknown },
  ) {
    return this.tenants.setStatus(who(req), id, body);
  }

  @UseGuards(PlatformSessionGuard)
  @Put('tenants/:id/products')
  setProducts(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body() body: { products?: unknown },
  ) {
    return this.tenants.setProducts(who(req), id, body);
  }
}
