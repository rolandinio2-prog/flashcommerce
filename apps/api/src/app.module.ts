import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { DatabaseModule } from './core/database/database.module';
import { CatalogModule } from './commerce/catalog/catalog.module';
import { CartModule } from './commerce/cart/cart.module';
import { OrderModule } from './commerce/order/order.module';

import { TablesModule } from './dine-in/tables/tables.module';
import { ReservationsModule } from './dine-in/reservations/reservations.module';
import { PaymentsModule } from './payments/payments.module';
import { DeliveryModule } from './delivery/delivery.module';
import { StaffModule } from './core/staff/staff.module';
import { BranchOperationsModule } from './core/branch-operations/branch-operations.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 120,
        blockDuration: 60_000,
      },
    ]),

    DatabaseModule,
    CatalogModule,
    CartModule,
    OrderModule,
    TablesModule,
    ReservationsModule,
    PaymentsModule,
    DeliveryModule,
    StaffModule,
    BranchOperationsModule,
  ],

  controllers: [AppController],

  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
