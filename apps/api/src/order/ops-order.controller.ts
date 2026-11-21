import {
  OperationsAccess,
  OperationPermission,
} from '../operations/operations-access';
import type { StaffAuthenticatedRequest } from '../staff/staff.types';
import {
  Body,
  Controller,
  Req,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';

import { OrderService } from './order.service';

interface UpdateOrderStatusBody {
  status?: string;
}

@Controller('ops/orders')
@OperationsAccess()
export class OpsOrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  @OperationPermission('orders.read')
  getOperationalOrders(@Req() request: StaffAuthenticatedRequest) {
    return this.orderService.getOperationalOrders(
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
    return this.orderService.updateOrderStatus(
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
    return this.orderService.closeTableSession(
      orderId,
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }
}
