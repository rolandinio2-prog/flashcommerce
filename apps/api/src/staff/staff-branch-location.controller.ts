import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Header,
  Injectable,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StaffSessionGuard } from './staff-session.guard';
import { StaffRoleGuard } from './staff-role.guard';
import { StaffRoles } from './staff-roles.decorator';
import type { StaffAuthenticatedRequest } from './staff.types';
import { StaffBranchLocationService } from './staff-branch-location.service';

@Injectable()
export class StaffBranchWriteGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const { headers } = context
      .switchToHttp()
      .getRequest<StaffAuthenticatedRequest>();
    const header = (name: string) =>
      typeof headers[name] === 'string' ? (headers[name] as string) : '';
    const origins = [
      ...(process.env.FLASH_ALLOWED_ORIGINS || '').split(','),
      process.env.FLASH_CUSTOMER_URL || '',
      ...(process.env.NODE_ENV !== 'production'
        ? ['http://localhost:3000']
        : []),
    ]
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      header('content-type').split(';')[0].trim().toLowerCase() !==
        'application/json' ||
      header('sec-fetch-site') === 'cross-site' ||
      (header('origin') && !origins.includes(header('origin')))
    )
      throw new ForbiddenException('Solicitud no permitida.');
    return true;
  }
}
@Controller('staff/branch-location')
@UseGuards(StaffSessionGuard, StaffRoleGuard)
@StaffRoles('ADMIN')
export class StaffBranchLocationController {
  constructor(private readonly location: StaffBranchLocationService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Req() req: StaffAuthenticatedRequest) {
    return this.location.getLocation(req.staff);
  }
  @Patch()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(StaffBranchWriteGuard)
  @Header('Cache-Control', 'no-store')
  save(@Req() req: StaffAuthenticatedRequest, @Body() body: unknown) {
    return this.location.saveLocation(req.staff, body);
  }
}
