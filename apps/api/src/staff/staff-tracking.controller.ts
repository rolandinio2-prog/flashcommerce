import { Controller, Get, Req, UseGuards } from '@nestjs/common';

import { StaffRoleGuard } from './staff-role.guard';
import { StaffRoles } from './staff-roles.decorator';
import { StaffSessionGuard } from './staff-session.guard';
import { StaffTrackingService } from './staff-tracking.service';
import type { StaffAuthenticatedRequest } from './staff.types';

@Controller('staff/tracking')
@UseGuards(StaffSessionGuard, StaffRoleGuard)
@StaffRoles('ADMIN', 'MANAGER', 'CASHIER')
export class StaffTrackingController {
  constructor(private readonly staffTrackingService: StaffTrackingService) {}

  @Get('deliveries')
  getDeliveries(@Req() request: StaffAuthenticatedRequest) {
    return this.staffTrackingService.getBranchTracking(request.staff);
  }
}
