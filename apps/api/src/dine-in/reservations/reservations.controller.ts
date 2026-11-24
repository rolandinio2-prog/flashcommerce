import {
  OperationsAccess,
  OperationPermission,
} from '../../core/operations/operations-access';
import type { StaffAuthenticatedRequest } from '../../core/staff/staff.types';
import {
  Body,
  Controller,
  Req,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

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
} from './reservations.service';

// =========================================================
// PUBLIC RESERVATIONS
// =========================================================

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  // GET /api/v1/reservations/availability
  @Get('availability')
  getAvailability(
    @Query('tenant')
    tenantCode?: string,

    @Query('branch')
    branchCode?: string,

    @Query('reservedFor')
    reservedFor?: string,

    @Query('durationMinutes')
    durationMinutes?: string,

    @Query('partySize')
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
  @Get('track/:trackingToken')
  getReservationTracking(
    @Param('trackingToken', new ParseUUIDPipe())
    trackingToken: string,
  ): Promise<ReservationTrackingResponse> {
    return this.reservationsService.getReservationTracking(trackingToken);
  }
}

// =========================================================
// OPERATIONAL RESERVATIONS
// =========================================================

@Controller('ops/reservations')
@OperationsAccess()
export class OpsReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  // GET /api/v1/ops/reservations
  @Get()
  @OperationPermission('reservations.read')
  getOperationalReservations(
    @Req() request: StaffAuthenticatedRequest,

    @Query('from')
    from?: string,

    @Query('to')
    to?: string,

    @Query('status')
    status?: string,
  ): Promise<OperationalReservationsResponse> {
    return this.reservationsService.getOperationalReservations(
      request.staff.tenantCode,
      request.staff.branchCode,
      from,
      to,
      status,
    );
  }

  // PATCH /api/v1/ops/reservations/:id/status
  @Patch(':reservationId/status')
  @OperationPermission('reservations.manage')
  updateReservationStatus(
    @Req() request: StaffAuthenticatedRequest,
    @Param('reservationId', new ParseUUIDPipe())
    reservationId: string,

    @Body()
    body: UpdateReservationStatusInput,
  ): Promise<UpdateReservationStatusResponse> {
    return this.reservationsService.updateReservationStatus(
      reservationId,
      body?.status,
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }

  // POST /api/v1/ops/reservations/:id/check-in
  @Post(':reservationId/check-in')
  @OperationPermission('reservations.manage')
  checkInReservation(
    @Req() request: StaffAuthenticatedRequest,
    @Param('reservationId', new ParseUUIDPipe())
    reservationId: string,
  ): Promise<CheckInReservationResponse> {
    return this.reservationsService.checkInReservation(
      reservationId,
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }
}
