import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';

import {
  OperationPermission,
  OperationsAccess,
} from '../../core/operations/operations-access';
import type { StaffAuthenticatedRequest } from '../../core/staff/staff.types';
import {
  CourierSettlementService,
  type ClientStatementInput,
  type DriverPayoutInput,
  type DriverPayRuleInput,
  type SettlementPaymentInput,
} from './courier-settlement.service';

/** D1c settlements: money matters, so ADMIN/MANAGER only (courier.manage). */
@Controller('ops/courier')
@OperationsAccess()
export class CourierSettlementController {
  constructor(private readonly settlements: CourierSettlementService) {}

  // client statements
  @Post('statements/preview')
  @OperationPermission('courier.manage')
  previewStatement(
    @Req() req: StaffAuthenticatedRequest,
    @Body() body: ClientStatementInput,
  ) {
    return this.settlements.previewClientStatement(req.staff, body);
  }

  @Post('statements')
  @OperationPermission('courier.manage')
  createStatement(
    @Req() req: StaffAuthenticatedRequest,
    @Body() body: ClientStatementInput,
  ) {
    return this.settlements.createClientStatement(req.staff, body);
  }

  @Get('statements')
  @OperationPermission('courier.manage')
  listStatements(
    @Req() req: StaffAuthenticatedRequest,
    @Query('courierClientId') clientId?: string,
  ) {
    return this.settlements.listClientStatements(req.staff, clientId);
  }

  @Get('statements/:id')
  @OperationPermission('courier.manage')
  getStatement(@Req() req: StaffAuthenticatedRequest, @Param('id') id: string) {
    return this.settlements.getClientStatement(req.staff, id);
  }

  @Post('statements/:id/pay')
  @OperationPermission('courier.manage')
  payStatement(
    @Req() req: StaffAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: SettlementPaymentInput,
  ) {
    return this.settlements.markPaid(req.staff, 'statement', id, body);
  }

  @Post('statements/:id/void')
  @OperationPermission('courier.manage')
  voidStatement(
    @Req() req: StaffAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.settlements.voidRecord(req.staff, 'statement', id);
  }

  // drivers: pay rules + payouts
  @Get('drivers')
  @OperationPermission('courier.manage')
  listDrivers(@Req() req: StaffAuthenticatedRequest) {
    return this.settlements.listDrivers(req.staff);
  }

  @Patch('drivers/:driverId/pay-rule')
  @OperationPermission('courier.manage')
  setPayRule(
    @Req() req: StaffAuthenticatedRequest,
    @Param('driverId') driverId: string,
    @Body() body: DriverPayRuleInput,
  ) {
    return this.settlements.setDriverPayRule(req.staff, driverId, body);
  }

  @Post('payouts/preview')
  @OperationPermission('courier.manage')
  previewPayout(
    @Req() req: StaffAuthenticatedRequest,
    @Body() body: DriverPayoutInput,
  ) {
    return this.settlements.previewDriverPayout(req.staff, body);
  }

  @Post('payouts')
  @OperationPermission('courier.manage')
  createPayout(
    @Req() req: StaffAuthenticatedRequest,
    @Body() body: DriverPayoutInput,
  ) {
    return this.settlements.createDriverPayout(req.staff, body);
  }

  @Get('payouts')
  @OperationPermission('courier.manage')
  listPayouts(
    @Req() req: StaffAuthenticatedRequest,
    @Query('driverId') driverId?: string,
  ) {
    return this.settlements.listDriverPayouts(req.staff, driverId);
  }

  @Get('payouts/:id')
  @OperationPermission('courier.manage')
  getPayout(@Req() req: StaffAuthenticatedRequest, @Param('id') id: string) {
    return this.settlements.getDriverPayout(req.staff, id);
  }

  @Post('payouts/:id/pay')
  @OperationPermission('courier.manage')
  payPayout(
    @Req() req: StaffAuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: SettlementPaymentInput,
  ) {
    return this.settlements.markPaid(req.staff, 'payout', id, body);
  }

  @Post('payouts/:id/void')
  @OperationPermission('courier.manage')
  voidPayout(@Req() req: StaffAuthenticatedRequest, @Param('id') id: string) {
    return this.settlements.voidRecord(req.staff, 'payout', id);
  }
}
