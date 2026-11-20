import { CartService } from '../cart/cart.service';
import { CatalogService } from '../catalog/catalog.service';
import { PaymentsModule } from '../payments/payments.module';
import { OpsPosController } from './ops-pos.controller';
import { OpsPosService } from './ops-pos.service';
import { OperationsModule } from '../operations/operations.module';
import { Module } from '@nestjs/common';

import { OrderController } from './order.controller';
import { OpsOrderController } from './ops-order.controller';
import { DeliveryModule } from '../delivery/delivery.module';
import { OrderService } from './order.service';

@Module({
  imports: [OperationsModule, DeliveryModule, PaymentsModule],

  controllers: [OrderController, OpsOrderController, OpsPosController],

  providers: [OrderService, OpsPosService, CartService, CatalogService],
})
export class OrderModule {}
