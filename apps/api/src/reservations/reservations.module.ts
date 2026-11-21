import { OperationsModule } from '../operations/operations.module';
import { Module } from '@nestjs/common';

import {
  OpsReservationsController,
  ReservationsController,
} from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [OperationsModule],
  controllers: [ReservationsController, OpsReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
