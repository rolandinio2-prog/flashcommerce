import { StaffBranchLocationController } from './staff-branch-location.controller';
import { StaffBranchLocationService } from './staff-branch-location.service';
import { StaffCommercialLinksController } from './staff-commercial-links.controller';
import { StaffCommercialLinksService } from './staff-commercial-links.service';
import { Module } from '@nestjs/common';

import { StaffController } from './staff.controller';
import { StaffDeliveryHandoffController } from './staff-delivery-handoff.controller';
import { StaffDeliveryHandoffService } from './staff-delivery-handoff.service';
import { StaffDriverController } from './staff-driver.controller';
import { StaffRoleGuard } from './staff-role.guard';
import { StaffSessionGuard } from './staff-session.guard';
import { StaffTrackingController } from './staff-tracking.controller';
import { StaffTrackingService } from './staff-tracking.service';
import { StaffService } from './staff.service';
import { StaffDriverService } from './staff-driver.service';

@Module({
  controllers: [
    StaffBranchLocationController,
    StaffCommercialLinksController,
    StaffController,
    StaffDriverController,
    StaffTrackingController,
    StaffDeliveryHandoffController,
  ],
  providers: [
    StaffBranchLocationService,
    StaffCommercialLinksService,
    StaffService,
    StaffDriverService,
    StaffSessionGuard,
    StaffRoleGuard,
    StaffTrackingService,
    StaffDeliveryHandoffService,
  ],
  exports: [StaffService, StaffSessionGuard, StaffRoleGuard],
})
export class StaffModule {}
