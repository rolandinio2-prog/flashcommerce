import {
  OperationsAccess,
  OperationPermission,
} from '../../core/operations/operations-access';
import type { StaffAuthenticatedRequest } from '../../core/staff/staff.types';
import {
  Body,
  Controller,
  Req,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';

import { OrderLifecycleService } from './order-lifecycle.service';
import { OpsOrderQueryService } from './ops-order-query.service';

interface UpdateOrderStatusBody {
  status?: string;
}

@Controller('ops/orders')
@OperationsAccess()
export class OpsOrderController {
  constructor(
    private readonly lifecycle: OrderLifecycleService,
    private readonly opsQuery: OpsOrderQueryService,
  ) {}

  @Get()
  @OperationPermission('orders.read')
  getOperationalOrders(@Req() request: StaffAuthenticatedRequest) {
    return this.opsQuery.getOperationalOrders(
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }

  @Patch(':orderId/status')
  @OperationPermission('orders.status')
  updateOrderStatus(
    @Req() request: StaffAuthenticatedRequest,
    @Param('orderId', new ParseUUIDPipe())
    orderId: string,

    @Body()
    body: UpdateOrderStatusBody,
  ) {
    return this.lifecycle.updateOrderStatus(
      orderId,
      body?.status,
      request.staff,
    );
  }

  // =======================================================
  // TABLES V0.3
  //
  // Cierra la sesión de mesa vinculada al pedido.
  // La disponibilidad pasa a AVAILABLE por derivación.
  // =======================================================

  @Patch(':orderId/table-session/close')
  @OperationPermission('tables.manage')
  closeTableSession(
    @Req() request: StaffAuthenticatedRequest,
    @Param('orderId', new ParseUUIDPipe())
    orderId: string,
  ) {
    return this.lifecycle.closeTableSession(
      orderId,
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }
}
