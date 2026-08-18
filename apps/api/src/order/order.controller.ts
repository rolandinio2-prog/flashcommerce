import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { OrderService, type CreateOrderInput } from './order.service';

@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  // =======================================================
  // CREAR PEDIDO
  //
  // Recibe cartToken + orderType y, opcionalmente,
  // los datos de Fulfillment V0.1.
  // =======================================================

  @Post()
  createOrder(@Body() body: CreateOrderInput) {
    return this.orderService.createOrder(body);
  }

  // =======================================================
  // TRACKING PÚBLICO DEL PEDIDO
  // =======================================================

  @Get('track/:trackingToken')
  getOrderTracking(
    @Param('trackingToken', new ParseUUIDPipe())
    trackingToken: string,
  ) {
    return this.orderService.getOrderTracking(trackingToken);
  }
  // =======================================================
  // POD PUBLICO DE DELIVERY
  // =======================================================

  @Get('track/:trackingToken/delivery-pod')
  getDeliveryPod(
    @Param('trackingToken', new ParseUUIDPipe())
    trackingToken: string,
  ) {
    return this.orderService.getDeliveryPod(
      trackingToken,
    );
  }
}
