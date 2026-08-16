import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { DatabaseModule } from './database/database.module';
import { CatalogModule } from './catalog/catalog.module';
import { CartModule } from './cart/cart.module';
import { OrderModule } from './order/order.module';

import { TablesModule } from './tables/tables.module';
import { ReservationsModule } from './reservations/reservations.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    DatabaseModule,
    CatalogModule,
    CartModule,
    OrderModule,
    TablesModule,
    ReservationsModule,
    PaymentsModule,
  ],

  controllers: [AppController],

  providers: [AppService],
})
export class AppModule {}
