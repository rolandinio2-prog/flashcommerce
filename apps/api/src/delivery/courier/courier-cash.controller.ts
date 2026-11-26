import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';

import {
  OperationPermission,
  OperationsAccess,
} from '../../core/operations/operations-access';
import type { StaffAuthenticatedRequest } from '../../core/staff/staff.types';
import {
  CourierCashService,
  type CashRemittanceInput,
} from './courier-cash.service';

/** Courier COD: drivers hand in the cash they collected (Admin, Manager, Cashier). */
@Controller('ops/courier/cash')
@OperationsAccess()
export class CourierCashController {
  constructor(private readonly cash: CourierCashService) {}

  @Get()
  @OperationPermission('courier.cash')
  summary(@Req() req: StaffAuthenticatedRequest) {
    return this.cash.summary(req.staff);
  }

  @Get('drivers/:driverId')
  @OperationPermission('courier.cash')
  driverPending(
    @Req() req: StaffAuthenticatedRequest,
    @Param('driverId') driverId: string,
  ) {
    return this.cash.driverPending(req.staff, driverId);
  }

  @Get('remittances')
  @OperationPermission('courier.cash')
  listRemittances(@Req() req: StaffAuthenticatedRequest) {
    return this.cash.listRemittances(req.staff);
  }

  @Post('remittances')
  @OperationPermission('courier.cash')
  remit(
    @Req() req: StaffAuthenticatedRequest,
    @Body() body: CashRemittanceInput,
  ) {
    return this.cash.remit(req.staff, body);
  }
}
