import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";

import {
  ReservationsService,
  type CheckInReservationResponse,
  type CreateReservationInput,
  type CreateReservationResponse,
  type OperationalReservationsResponse,
  type ReservationAvailabilityResponse,
  type ReservationTrackingResponse,
  type UpdateReservationStatusInput,
  type UpdateReservationStatusResponse,
} from "./reservations.service";

// =========================================================
// PUBLIC RESERVATIONS
// =========================================================

@Controller("reservations")
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  // GET /api/v1/reservations/availability
  @Get("availability")
  getAvailability(
    @Query("tenant")
    tenantCode?: string,

    @Query("branch")
    branchCode?: string,

    @Query("reservedFor")
    reservedFor?: string,

    @Query("durationMinutes")
    durationMinutes?: string,

    @Query("partySize")
    partySize?: string,
  ): Promise<ReservationAvailabilityResponse> {
    return this.reservationsService.getAvailability(
      tenantCode,
      branchCode,
      reservedFor,
      durationMinutes,
      partySize,
    );
  }

  // POST /api/v1/reservations
  @Post()
  createReservation(
    @Body()
    body: CreateReservationInput,
  ): Promise<CreateReservationResponse> {
    return this.reservationsService.createReservation(body);
  }

  // GET /api/v1/reservations/track/:trackingToken
  @Get("track/:trackingToken")
  getReservationTracking(
    @Param("trackingToken", new ParseUUIDPipe())
    trackingToken: string,
  ): Promise<ReservationTrackingResponse> {
    return this.reservationsService.getReservationTracking(trackingToken);
  }
}

// =========================================================
// OPERATIONAL RESERVATIONS
// =========================================================

@Controller("ops/reservations")
export class OpsReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  // GET /api/v1/ops/reservations
  @Get()
  getOperationalReservations(
    @Query("tenant")
    tenantCode?: string,

    @Query("branch")
    branchCode?: string,

    @Query("from")
    from?: string,

    @Query("to")
    to?: string,

    @Query("status")
    status?: string,
  ): Promise<OperationalReservationsResponse> {
    return this.reservationsService.getOperationalReservations(
      tenantCode,
      branchCode,
      from,
      to,
      status,
    );
  }

  // PATCH /api/v1/ops/reservations/:id/status
  @Patch(":reservationId/status")
  updateReservationStatus(
    @Param("reservationId", new ParseUUIDPipe())
    reservationId: string,

    @Body()
    body: UpdateReservationStatusInput,

    @Query("tenant")
    tenantCode?: string,

    @Query("branch")
    branchCode?: string,
  ): Promise<UpdateReservationStatusResponse> {
    return this.reservationsService.updateReservationStatus(
      reservationId,
      body?.status,
      tenantCode,
      branchCode,
    );
  }

  // POST /api/v1/ops/reservations/:id/check-in
  @Post(":reservationId/check-in")
  checkInReservation(
    @Param("reservationId", new ParseUUIDPipe())
    reservationId: string,

    @Query("tenant")
    tenantCode?: string,

    @Query("branch")
    branchCode?: string,
  ): Promise<CheckInReservationResponse> {
    return this.reservationsService.checkInReservation(
      reservationId,
      tenantCode,
      branchCode,
    );
  }
}
