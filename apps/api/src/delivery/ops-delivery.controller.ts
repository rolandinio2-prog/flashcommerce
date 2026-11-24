import {
  OperationsAccess,
  OperationPermission,
} from '../core/operations/operations-access';
import type { StaffAuthenticatedRequest } from '../core/staff/staff.types';
import {
  Body,
  Controller,
  Req,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';

import { DeliveryOpsService } from './delivery-ops.service';

@Controller('ops')
@OperationsAccess()
export class OpsDeliveryController {
  constructor(private readonly deliveryOps: DeliveryOpsService) {}

  @Get('deliveries')
  @OperationPermission('delivery.read')
  getOperationalDeliveries(
    @Req() request: StaffAuthenticatedRequest,

    @Query('status')
    status?: string,
  ) {
    return this.deliveryOps.getOperationalDeliveries(
      request.staff.tenantCode,
      request.staff.branchCode,
      status,
    );
  }

  @Get('delivery-drivers')
  @OperationPermission('delivery.read')
  getOperationalDrivers(@Req() request: StaffAuthenticatedRequest) {
    return this.deliveryOps.getOperationalDrivers(
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }

  @Patch('deliveries/:deliveryId/assignment')
  @OperationPermission('delivery.assign')
  assignOperationalDelivery(
    @Req() request: StaffAuthenticatedRequest,
    @Param('deliveryId')
    deliveryId: string,

    @Body()
    body?: {
      driverId?: unknown;
      expectedAssignmentId?: unknown;
    },
  ) {
    return this.deliveryOps.assignOperationalDelivery(
      deliveryId,
      request.staff.tenantCode,
      request.staff.branchCode,
      body?.driverId,
      body?.expectedAssignmentId,
    );
  }
}
