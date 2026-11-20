import { OperationsAccess, OperationPermission } from '../operations/operations-access';
import type { StaffAuthenticatedRequest } from '../staff/staff.types';
import {
  Body,
  Controller,
  Req,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';

import { DeliveryService } from './delivery.service';

@Controller('ops')
@OperationsAccess()
export class OpsDeliveryController {
  constructor(
    private readonly deliveryService: DeliveryService,
  ) {}

  @Get('deliveries')
  @OperationPermission('delivery.read')
  getOperationalDeliveries(
    @Req() request: StaffAuthenticatedRequest,

    @Query('status')
    status?: string,
  ) {
    return this.deliveryService.getOperationalDeliveries(
      request.staff.tenantCode,
      request.staff.branchCode,
      status,
    );
  }

  @Get('delivery-drivers')
  @OperationPermission('delivery.read')
  getOperationalDrivers(
    @Req() request: StaffAuthenticatedRequest,
  ) {
    return this.deliveryService.getOperationalDrivers(
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
    return this.deliveryService.assignOperationalDelivery(
      deliveryId,
      request.staff.tenantCode,
      request.staff.branchCode,
      body?.driverId,
      body?.expectedAssignmentId,
    );
  }
}