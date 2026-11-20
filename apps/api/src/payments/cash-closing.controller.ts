import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { OperationsAccess, OperationPermission } from '../operations/operations-access';
import type { StaffAuthenticatedRequest } from '../staff/staff.types';
import { CashClosingService } from './cash-closing.service';
@Controller('ops/payments/closing')
@OperationsAccess()
export class CashClosingController {
  constructor(private readonly closing:CashClosingService){}
  @Get()
  @OperationPermission('payments.read')
  preview(@Req() request:StaffAuthenticatedRequest,@Query('date') date:unknown){return this.closing.preview(request.staff,date);}
  @Post()
  @OperationPermission('payments.close')
  close(@Req() request:StaffAuthenticatedRequest,@Body() input:{date?:unknown;requestId?:unknown;snapshotHash?:unknown;countedCash?:unknown;note?:unknown}){return this.closing.close(request.staff,input);}
}
