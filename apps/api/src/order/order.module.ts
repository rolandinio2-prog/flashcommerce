import { Module } from '@nestjs/common';

import { OrderController } from './order.controller';
import { OpsOrderController } from './ops-order.controller';
import { DeliveryModule } from '../delivery/delivery.module';
import { OrderService } from './order.service';

@Module({
  imports: [DeliveryModule],

  controllers: [OrderController, OpsOrderController],

  providers: [OrderService],
})
export class OrderModule {}
