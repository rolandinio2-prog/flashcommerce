import {
  OperationsAccess,
  OperationPermission,
} from '../operations/operations-access';
import type { StaffAuthenticatedRequest } from '../staff/staff.types';
import {
  Controller,
  Req,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';

import { DeliveryMonitorRealtimeSessionService } from './delivery-monitor-realtime-session.service';
import { DeliveryMonitorService } from './delivery-monitor.service';

@Controller('ops/delivery-monitor')
@OperationsAccess()
export class DeliveryMonitorController {
  constructor(
    private readonly deliveryMonitorService: DeliveryMonitorService,

    private readonly realtimeSessionService: DeliveryMonitorRealtimeSessionService,
  ) {}

  @Get('active')
  @OperationPermission('delivery.monitor')
  getActiveDeliveries(@Req() request: StaffAuthenticatedRequest) {
    return this.deliveryMonitorService.getActiveSnapshot(
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }
  @Get('state')
  @OperationPermission('delivery.monitor')
  getActiveDeliveryState(@Req() request: StaffAuthenticatedRequest) {
    return this.deliveryMonitorService.getActiveSnapshot(
      request.staff.tenantCode,
      request.staff.branchCode,
      undefined,
      false,
    );
  }

  @Get('deliveries/:deliveryId/route')
  @OperationPermission('delivery.monitor')
  getActiveDeliveryRoute(
    @Req() request: StaffAuthenticatedRequest,
    @Param('deliveryId', new ParseUUIDPipe())
    deliveryId: string,
  ) {
    return this.deliveryMonitorService.getActiveDeliveryRoute(
      request.staff.tenantCode,
      request.staff.branchCode,
      deliveryId,
    );
  }

  @Post('realtime-session')
  @OperationPermission('delivery.monitor')
  createRealtimeSession(@Req() request: StaffAuthenticatedRequest) {
    return this.realtimeSessionService.createSession(request.staff);
  }
}
