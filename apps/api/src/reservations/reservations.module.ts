import { Module } from "@nestjs/common";

import {
  OpsReservationsController,
  ReservationsController,
} from "./reservations.controller";
import { ReservationsService } from "./reservations.service";

@Module({
  controllers: [ReservationsController, OpsReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
