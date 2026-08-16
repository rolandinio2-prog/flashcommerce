import { Module } from '@nestjs/common';

import { OrderController } from './order.controller';
import { OpsOrderController } from './ops-order.controller';
import { OrderService } from './order.service';

@Module({
  controllers: [OrderController, OpsOrderController],

  providers: [OrderService],
})
export class OrderModule {}
