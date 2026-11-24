import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  OperationsAccess,
  OperationPermission,
} from '../core/operations/operations-access';
import type { StaffAuthenticatedRequest } from '../core/staff/staff.types';
import { CashSummaryService } from './cash-summary.service';

@Controller('ops/payments')
@OperationsAccess()
export class CashSummaryController {
  constructor(private readonly summary: CashSummaryService) {}

  @Get('summary')
  @OperationPermission('payments.read')
  getSummary(
    @Req() request: StaffAuthenticatedRequest,
    @Query('date') date: unknown,
  ) {
    return this.summary.getSummary(request.staff, date);
  }
}
