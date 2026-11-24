import { Controller, Param, Patch, Req, UseGuards } from '@nestjs/common';

import { StaffDeliveryHandoffService } from './staff-delivery-handoff.service';
import { StaffRoleGuard } from './staff-role.guard';
import { StaffRoles } from './staff-roles.decorator';
import { StaffSessionGuard } from './staff-session.guard';
import type { StaffAuthenticatedRequest } from './staff.types';

@Controller('staff/ops/deliveries')
@UseGuards(StaffSessionGuard, StaffRoleGuard)
@StaffRoles('ADMIN', 'MANAGER', 'CASHIER', 'KITCHEN')
export class StaffDeliveryHandoffController {
  constructor(private readonly handoffService: StaffDeliveryHandoffService) {}

  @Patch(':deliveryId/handoff')
  handoffToDriver(
    @Param('deliveryId') deliveryId: string,
    @Req() request: StaffAuthenticatedRequest,
  ) {
    return this.handoffService.handoffToDriver(request.staff, deliveryId);
  }
}
