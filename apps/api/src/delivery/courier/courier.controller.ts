import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';

import {
  OperationPermission,
  OperationsAccess,
} from '../../core/operations/operations-access';
import type { StaffAuthenticatedRequest } from '../../core/staff/staff.types';
import {
  CourierService,
  type CourierClientInput,
  type CourierRateInput,
  type CourierRequestInput,
} from './courier.service';

@Controller('ops/courier')
@OperationsAccess()
export class CourierController {
  constructor(private readonly courier: CourierService) {}

  @Get('clients')
  @OperationPermission('courier.read')
  listClients(@Req() req: StaffAuthenticatedRequest) {
    return this.courier.listClients(req.staff);
  }

  @Post('clients')
  @OperationPermission('courier.manage')
  createClient(
    @Req() req: StaffAuthenticatedRequest,
    @Body() body: CourierClientInput,
  ) {
    return this.courier.createClient(req.staff, body);
  }

  @Patch('clients/:clientId')
  @OperationPermission('courier.manage')
  updateClient(
    @Req() req: StaffAuthenticatedRequest,
    @Param('clientId') clientId: string,
    @Body() body: CourierClientInput,
  ) {
    return this.courier.updateClient(req.staff, clientId, body);
  }

  @Get('rates')
  @OperationPermission('courier.read')
  listRates(@Req() req: StaffAuthenticatedRequest) {
    return this.courier.listRates(req.staff);
  }

  @Put('rates')
  @OperationPermission('courier.manage')
  setRate(
    @Req() req: StaffAuthenticatedRequest,
    @Body() body: CourierRateInput,
  ) {
    return this.courier.setRate(req.staff, body);
  }

  @Post('quote')
  @OperationPermission('courier.read')
  quote(
    @Req() req: StaffAuthenticatedRequest,
    @Body() body: CourierRequestInput,
  ) {
    return this.courier.quote(req.staff, body);
  }

  @Get('requests')
  @OperationPermission('courier.read')
  listRequests(
    @Req() req: StaffAuthenticatedRequest,
    @Query('limit') limit?: string,
  ) {
    return this.courier.listRequests(req.staff, limit);
  }

  @Post('requests')
  @OperationPermission('courier.create')
  createRequest(
    @Req() req: StaffAuthenticatedRequest,
    @Body() body: CourierRequestInput,
  ) {
    return this.courier.createRequest(req.staff, body);
  }
}
