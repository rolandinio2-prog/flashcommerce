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
import { CheckoutService } from './checkout.service';
import { CustomerRecoveryService } from './customer-recovery.service';
import { OrderTrackingService } from './order-tracking.service';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OpsOrderQueryService } from './ops-order-query.service';
import { StockReservationExpiryService } from './stock-reservation-expiry.service';

@Module({
  imports: [OperationsModule, DeliveryModule, PaymentsModule],

  controllers: [OrderController, OpsOrderController, OpsPosController],

  providers: [
    CheckoutService,
    CustomerRecoveryService,
    OrderTrackingService,
    OrderLifecycleService,
    OpsOrderQueryService,
    OpsPosService,
    CartService,
    CatalogService,
    StockReservationExpiryService,
  ],
})
export class OrderModule {}
