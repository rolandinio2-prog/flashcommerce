import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { StaffRoleGuard } from './staff-role.guard';
import { StaffRoles } from './staff-roles.decorator';
import { StaffSessionGuard } from './staff-session.guard';
import { StaffService } from './staff.service';
import type { StaffAuthenticatedRequest } from './staff.types';

interface BootstrapAdminBody {
  tenantCode?: string;
  branchCode?: string;
  firstName?: string;
  lastName?: string;
  identityDocument?: string;
  phone?: string;
  email?: string;
}

interface StaffLoginBody {
  tenantCode?: string;
  branchCode?: string;
  userCode?: string;
  password?: string;
}

interface ChangeStaffPasswordBody {
  newPassword?: string;
}

interface RecoverAdminBody {
  tenantCode?: string;
  branchCode?: string;
  userCode?: string;
}

interface CreateStaffUserBody {
  firstName?: string;
  lastName?: string;
  identityDocument?: string;
  phone?: string;
  email?: string;
  role?: string;
}

interface SetStaffStatusBody {
  status?: string;
}

@Controller('staff')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  private sessionCookieOptions() {
    // Only explicitly local development/test may use HTTP cookies.
    // Configured HTTPS always requires Secure; never trust request headers.
    const localMode = ['development', 'test'].includes(process.env.NODE_ENV || '');
    const configuredHttps = [
      process.env.FLASH_CUSTOMER_URL || '',
      ...(process.env.FLASH_ALLOWED_ORIGINS || '').split(','),
    ].some(origin => origin.trim().toLowerCase().startsWith('https://'));
    return { httpOnly: true, sameSite: 'lax' as const, secure: !localMode || configuredHttps, path: '/' };
  }

  @Get('bootstrap-status')
  getBootstrapStatus(
    @Query('tenant') tenantCode?: string,
    @Query('branch') branchCode?: string,
  ) {
    return this.staffService.getBootstrapStatus(tenantCode, branchCode);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('bootstrap-admin')
  bootstrapAdmin(
    @Headers('x-ops-key') opsAccessKey: string | undefined,
    @Body() body: BootstrapAdminBody,
  ) {
    return this.staffService.bootstrapAdmin({
      tenantCode: body?.tenantCode,
      branchCode: body?.branchCode,
      firstName: body?.firstName,
      lastName: body?.lastName,
      identityDocument: body?.identityDocument,
      phone: body?.phone,
      email: body?.email,
      opsAccessKey,
    });
  }

  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('auth/recover-admin')
  recoverAdmin(
    @Headers('x-ops-key') opsAccessKey: string | undefined,
    @Body() body: RecoverAdminBody,
  ) {
    return this.staffService.recoverAdminAccess({
      tenantCode: body?.tenantCode,
      branchCode: body?.branchCode,
      userCode: body?.userCode,
      opsAccessKey,
    });
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/login')
  async login(
    @Body() body: StaffLoginBody,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.staffService.login({
      tenantCode: body?.tenantCode,
      branchCode: body?.branchCode,
      userCode: body?.userCode,
      password: body?.password,
    });

    response.cookie(this.staffService.getSessionCookieName(), result.token, {
      ...this.sessionCookieOptions(),
      maxAge: this.staffService.getSessionDurationMs(),
    });

    return {
      authenticated: true,
      user: result.principal,
    };
  }

  @UseGuards(StaffSessionGuard)
  @Get('auth/me')
  me(@Req() request: StaffAuthenticatedRequest) {
    return {
      authenticated: true,
      user: request.staff,
    };
  }

  @UseGuards(StaffSessionGuard)
  @Post('auth/change-password')
  changePassword(
    @Req() request: StaffAuthenticatedRequest,
    @Body() body: ChangeStaffPasswordBody,
  ) {
    return this.staffService.changePassword(
      request.staff,
      body?.newPassword,
    );
  }

  @UseGuards(StaffSessionGuard)
  @Post('auth/logout')
  async logout(
    @Req() request: StaffAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.staffService.logout(request.staff.sessionId);

    response.clearCookie(this.staffService.getSessionCookieName(), {
      ...this.sessionCookieOptions(),
    });

    return result;
  }

  @UseGuards(StaffSessionGuard, StaffRoleGuard)
  @StaffRoles('ADMIN')
  @Get('users')
  listUsers(@Req() request: StaffAuthenticatedRequest) {
    return this.staffService.listBranchUsers(request.staff);
  }

  @UseGuards(StaffSessionGuard, StaffRoleGuard)
  @StaffRoles('ADMIN')
  @Post('users')
  createUser(
    @Req() request: StaffAuthenticatedRequest,
    @Body() body: CreateStaffUserBody,
  ) {
    return this.staffService.createBranchUser(request.staff, body);
  }

  @UseGuards(StaffSessionGuard, StaffRoleGuard)
  @StaffRoles('ADMIN')
  @Post('users/:userId/reset-credentials')
  resetCredentials(
    @Req() request: StaffAuthenticatedRequest,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.staffService.resetCredentials(request.staff, userId);
  }

  @UseGuards(StaffSessionGuard, StaffRoleGuard)
  @StaffRoles('ADMIN')
  @Patch('users/:userId/status')
  setUserStatus(
    @Req() request: StaffAuthenticatedRequest,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: SetStaffStatusBody,
  ) {
    return this.staffService.setUserStatus(
      request.staff,
      userId,
      body?.status,
    );
  }
}
