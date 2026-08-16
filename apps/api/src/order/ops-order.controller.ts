import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';

import { OrderService } from './order.service';

interface UpdateOrderStatusBody {
  status?: string;
}

@Controller('ops/orders')
export class OpsOrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  getOperationalOrders(
    @Query('tenant')
    tenantCode?: string,

    @Query('branch')
    branchCode?: string,
  ) {
    return this.orderService.getOperationalOrders(
      tenantCode,
      branchCode,
    );
  }

  @Patch(':orderId/status')
  updateOrderStatus(
    @Param('orderId', new ParseUUIDPipe())
    orderId: string,

    @Body()
    body: UpdateOrderStatusBody,
  ) {
    return this.orderService.updateOrderStatus(
      orderId,
      body?.status,
    );
  }

  // =======================================================
  // TABLES V0.3
  //
  // Cierra la sesión de mesa vinculada al pedido.
  // La disponibilidad pasa a AVAILABLE por derivación.
  // =======================================================

  @Patch(':orderId/table-session/close')
  closeTableSession(
    @Param('orderId', new ParseUUIDPipe())
    orderId: string,

    @Query('tenant')
    tenantCode?: string,

    @Query('branch')
    branchCode?: string,
  ) {
    return this.orderService.closeTableSession(
      orderId,
      tenantCode,
      branchCode,
    );
  }
}