import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { StaffRoleGuard } from '../staff/staff-role.guard';
import { StaffRoles } from '../staff/staff-roles.decorator';
import { StaffSessionGuard } from '../staff/staff-session.guard';
import type { StaffAuthenticatedRequest } from '../staff/staff.types';
import { AdminDevQrPaymentService } from './admin-dev-qr-payment.service';

@Controller('staff/admin/dev-payments')
@UseGuards(StaffSessionGuard, StaffRoleGuard)
@StaffRoles('ADMIN')
export class AdminDevQrPaymentController {
  constructor(private readonly service: AdminDevQrPaymentService) {}

  @Get('status')
  getStatus() {
    return this.service.getStatus();
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('orders/:orderNumber/simulate-qr-paid')
  simulateQrPaid(
    @Param('orderNumber')
    orderNumber: string,

    @Req()
    request: StaffAuthenticatedRequest,
  ) {
    return this.service.simulateQrPaid(request.staff, orderNumber);
  }
}
