import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';

import { DeliveryService } from './delivery.service';
import { OpsAccessGuard } from './ops-access.guard';

@Controller('ops')
@UseGuards(OpsAccessGuard)
export class OpsDeliveryController {
  constructor(
    private readonly deliveryService: DeliveryService,
  ) {}

  @Get('deliveries')
  getOperationalDeliveries(
    @Query('tenant')
    tenantCode?: string,

    @Query('branch')
    branchCode?: string,

    @Query('status')
    status?: string,
  ) {
    return this.deliveryService.getOperationalDeliveries(
      tenantCode,
      branchCode,
      status,
    );
  }

  @Get('delivery-drivers')
  getOperationalDrivers(
    @Query('tenant')
    tenantCode?: string,

    @Query('branch')
    branchCode?: string,
  ) {
    return this.deliveryService.getOperationalDrivers(
      tenantCode,
      branchCode,
    );
  }
}