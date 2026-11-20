import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { StaffDriverService } from './staff-driver.service';
import { StaffRoleGuard } from './staff-role.guard';
import { StaffRoles } from './staff-roles.decorator';
import { StaffSessionGuard } from './staff-session.guard';
import type { StaffAuthenticatedRequest } from './staff.types';

interface DriverProfileBody {
  firstName?: string;
  lastName?: string;
  identityDocument?: string;
  phone?: string;
  email?: string;
  vehiclePlate?: string;
}

interface DriverStatusBody {
  status?: string;
}

@Controller('staff/drivers')
@UseGuards(StaffSessionGuard, StaffRoleGuard)
@StaffRoles('ADMIN', 'MANAGER')
export class StaffDriverController {
  constructor(private readonly staffDriverService: StaffDriverService) {}

  @Get()
  listDrivers(@Req() request: StaffAuthenticatedRequest) {
    return this.staffDriverService.listBranchDrivers(request.staff);
  }

  @Post()
  createDriver(
    @Req() request: StaffAuthenticatedRequest,
    @Body() body: DriverProfileBody,
  ) {
    return this.staffDriverService.createBranchDriver(request.staff, body);
  }

  @Patch(':driverId/profile')
  updateDriverProfile(
    @Req() request: StaffAuthenticatedRequest,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Body() body: DriverProfileBody,
  ) {
    return this.staffDriverService.updateDriverProfile(
      request.staff,
      driverId,
      body,
    );
  }

  @Post(':driverId/reset-credentials')
  resetDriverCredentials(
    @Req() request: StaffAuthenticatedRequest,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
  ) {
    return this.staffDriverService.resetDriverCredentials(
      request.staff,
      driverId,
    );
  }

  @Patch(':driverId/status')
  setDriverStatus(
    @Req() request: StaffAuthenticatedRequest,
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Body() body: DriverStatusBody,
  ) {
    return this.staffDriverService.setDriverStatus(
      request.staff,
      driverId,
      body?.status,
    );
  }
}
