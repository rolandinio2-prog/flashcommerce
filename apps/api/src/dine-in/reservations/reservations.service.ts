import { lockBranchAdmission } from '../../core/branch-operations/service-policy';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../../core/database/database.service';

export type ReservationStatus =
  'PENDING' | 'CONFIRMED' | 'SEATED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

export type ReservationSlotAvailability = 'AVAILABLE' | 'CAPACITY' | 'RESERVED';

export interface CreateReservationInput {
  tenantCode?: string;
  branchCode?: string;
  tableId?: string;
  reservedFor?: string;
  durationMinutes?: number;
  partySize?: number;
  customerName?: string;
  customerPhone?: string;
  customerNotes?: string;
}

export interface UpdateReservationStatusInput {
  status?: string;
}

export interface ReservationRecord {
  id: string;
  reservationCode: string;
  trackingToken: string;
  status: ReservationStatus;
  reservedFor: string | Date;
  reservedUntil: string | Date;
  durationMinutes: number;
  partySize: number;
  customerName: string;
  customerPhone: string;
  customerNotes: string | null;
  source: 'WEB' | 'OPS' | 'PHONE';
  table: {
    id: string;
    code: string;
    name: string;
    capacity: number;
    zone: string | null;
  };
  tableSession: {
    id: string;
    status: 'OPEN' | 'CLOSED';
    openedAt: string | Date;
    closedAt: string | Date | null;
  } | null;
  preorder: {
    id: string;
    orderNumber: string;
    trackingToken: string;
    status:
      | 'PENDING'
      | 'CONFIRMED'
      | 'PREPARING'
      | 'READY'
      | 'COMPLETED'
      | 'CANCELLED';
    currency: string;
    total: number;
    scheduledFor: string | Date | null;
    tableSessionId: string | null;
  } | null;
  confirmedAt: string | Date | null;
  seatedAt: string | Date | null;
  cancelledAt: string | Date | null;
  noShowAt: string | Date | null;
  completedAt: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface ReservationAvailabilityResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  reservedFor: string;
  reservedUntil: string;
  durationMinutes: number;
  partySize: number;
  total: number;
  available: number;
  tables: Array<{
    id: string;
    code: string;
    name: string;
    capacity: number;
    zone: string | null;
    currentAvailability: 'AVAILABLE' | 'OCCUPIED';
    slotAvailability: ReservationSlotAvailability;
    available: boolean;
  }>;
}

export interface CreateReservationResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  reservation: ReservationRecord;
}

export interface ReservationTrackingResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  reservation: ReservationRecord;
}

export interface OperationalReservationsResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  from: string;
  to: string;
  status: ReservationStatus | null;
  total: number;
  reservations: ReservationRecord[];
}

export interface UpdateReservationStatusResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  previousStatus: ReservationStatus;
  changed: boolean;
  reservation: ReservationRecord;
}

export interface CheckInReservationResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  previousStatus: 'PENDING' | 'CONFIRMED';
  reservation: ReservationRecord;
  table: {
    id: string;
    code: string;
    name: string;
    availability: 'OCCUPIED';
  };
  tableSession: {
    id: string;
    status: 'OPEN';
    openedAt: string | Date;
  };
}

interface BranchRow {
  tenant_id: string;
  branch_id: string;
  time_zone: string;
}

interface ReservationAvailabilityRow {
  id: string;
  code: string;
  name: string;
  capacity: number;
  zone: string | null;
  currently_occupied: boolean;
  slot_availability: ReservationSlotAvailability;
}

interface ReservationRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  reservation_code: string;
  tracking_token: string;
  status: ReservationStatus;
  reserved_for: string | Date;
  reserved_until: string | Date;
  duration_minutes: number;
  party_size: number;
  customer_name: string;
  customer_phone: string;
  customer_notes: string | null;
  source: 'WEB' | 'OPS' | 'PHONE';
  confirmed_at: string | Date | null;
  seated_at: string | Date | null;
  cancelled_at: string | Date | null;
  no_show_at: string | Date | null;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  tenant_code: string;
  branch_code: string;
  time_zone: string;
  table_id: string;
  table_code: string;
  table_name: string;
  table_capacity: number;
  table_zone: string | null;
  table_is_active: boolean;
  table_session_id: string | null;
  table_session_status: 'OPEN' | 'CLOSED' | null;
  table_session_opened_at: string | Date | null;
  table_session_closed_at: string | Date | null;
  preorder_id: string | null;
  preorder_order_number: string | null;
  preorder_tracking_token: string | null;
  preorder_status:
    | 'PENDING'
    | 'CONFIRMED'
    | 'PREPARING'
    | 'READY'
    | 'COMPLETED'
    | 'CANCELLED'
    | null;
  preorder_currency: string | null;
  preorder_total: string | null;
  preorder_scheduled_for: string | Date | null;
  preorder_table_session_id: string | null;
}

interface LockedTableRow {
  tenant_id: string;
  branch_id: string;
  time_zone: string;
  id: string;
  code: string;
  name: string;
  capacity: number;
  zone: string | null;
  is_active: boolean;
}

interface ExistingSessionRow {
  id: string;
}

interface CreatedSessionRow {
  id: string;
  status: 'OPEN';
  opened_at: string | Date;
}

interface PostgresError {
  code?: string;
  constraint?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TIME_ZONE_PATTERN = /(?:z|[+-]\d{2}:\d{2})$/i;

const RESERVATION_SELECT = `
  select
    r.id::text,
    r.tenant_id::text,
    r.branch_id::text,
    r.reservation_code,
    r.tracking_token::text,
    r.status,
    r.reserved_for,
    r.reserved_until,
    r.duration_minutes,
    r.party_size,
    r.customer_name,
    r.customer_phone,
    r.customer_notes,
    r.source,
    r.confirmed_at,
    r.seated_at,
    r.cancelled_at,
    r.no_show_at,
    r.completed_at,
    r.created_at,
    r.updated_at,

    t.code as tenant_code,
    b.code as branch_code,
    b.timezone as time_zone,

    dt.id::text as table_id,
    dt.code as table_code,
    dt.name as table_name,
    dt.capacity as table_capacity,
    dt.zone as table_zone,
    dt.is_active as table_is_active,

    ts.id::text as table_session_id,
    ts.status as table_session_status,
    ts.opened_at as table_session_opened_at,
    ts.closed_at as table_session_closed_at,

    po.id::text as preorder_id,
    po.order_number::text as preorder_order_number,
    po.tracking_token::text as preorder_tracking_token,
    po.status as preorder_status,
    po.currency as preorder_currency,
    po.total::text as preorder_total,
    po.scheduled_for as preorder_scheduled_for,
    po.table_session_id::text as preorder_table_session_id

  from public.table_reservations r

  inner join public.tenants t
    on t.id = r.tenant_id

  inner join public.branches b
    on b.tenant_id = r.tenant_id
   and b.id = r.branch_id

  inner join public.dining_tables dt
    on dt.tenant_id = r.tenant_id
   and dt.branch_id = r.branch_id
   and dt.id = r.table_id

  left join public.table_sessions ts
    on ts.tenant_id = r.tenant_id
   and ts.branch_id = r.branch_id
   and ts.id = r.table_session_id

  left join public.orders po
    on po.tenant_id = r.tenant_id
   and po.branch_id = r.branch_id
   and po.reservation_id = r.id
`;

@Injectable()
export class ReservationsService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getAvailability(
    tenantCode: string | undefined,
    branchCode: string | undefined,
    reservedForInput: string | undefined,
    durationMinutesInput: string | undefined,
    partySizeInput: string | undefined,
  ): Promise<ReservationAvailabilityResponse> {
    const tenant = this.normalizeCode(tenantCode, 'POLLO001');
    const branch = this.normalizeCode(branchCode, 'SUC001');
    const partySize = this.parseInteger(partySizeInput, 'partySize', 1, 50);
    const durationMinutes = this.parseDuration(durationMinutesInput);
    const window = this.parseFutureWindow(reservedForInput, durationMinutes);

    const branchRow = await this.getBranch(tenant, branch);
    await this.databaseService.withTransaction((c) =>
      lockBranchAdmission(c, branchRow.tenant_id, branchRow.branch_id, [
        'DINE_IN',
        'RESERVATIONS',
      ]),
    );

    const result = await this.databaseService.query<ReservationAvailabilityRow>(
      `
          select
            dt.id::text,
            dt.code,
            dt.name,
            dt.capacity,
            dt.zone,

            exists (
              select 1

              from public.table_sessions ts

              where ts.tenant_id = dt.tenant_id
                and ts.branch_id = dt.branch_id
                and ts.table_id = dt.id
                and ts.status = 'OPEN'
            ) as currently_occupied,

            case
              when dt.capacity < $5::integer
                then 'CAPACITY'

              when exists (
                select 1

                from public.table_reservations r

                where r.tenant_id = dt.tenant_id
                  and r.branch_id = dt.branch_id
                  and r.table_id = dt.id
                  and r.status in (
                    'PENDING',
                    'CONFIRMED',
                    'SEATED'
                  )
                  and tstzrange(
                    r.reserved_for,
                    r.reserved_until,
                    '[)'
                  ) && tstzrange(
                    $3::timestamptz,
                    $4::timestamptz,
                    '[)'
                  )
              )
                then 'RESERVED'

              else 'AVAILABLE'
            end as slot_availability

          from public.dining_tables dt

          where dt.tenant_id = $1::uuid
            and dt.branch_id = $2::uuid
            and dt.is_active = true

          order by
            dt.zone nulls last,
            dt.sort_order,
            dt.name
        `,
      [
        branchRow.tenant_id,
        branchRow.branch_id,
        window.reservedFor,
        window.reservedUntil,
        partySize,
      ],
    );

    const tables = result.rows.map((table) => ({
      id: table.id,
      code: table.code,
      name: table.name,
      capacity: table.capacity,
      zone: table.zone,
      currentAvailability: table.currently_occupied
        ? ('OCCUPIED' as const)
        : ('AVAILABLE' as const),
      slotAvailability: table.slot_availability,
      available: table.slot_availability === 'AVAILABLE',
    }));

    return {
      tenant,
      branch,
      timeZone: branchRow.time_zone,
      reservedFor: window.reservedFor,
      reservedUntil: window.reservedUntil,
      durationMinutes,
      partySize,
      total: tables.length,
      available: tables.filter((table) => table.available).length,
      tables,
    };
  }

  async createReservation(
    input: CreateReservationInput | undefined,
  ): Promise<CreateReservationResponse> {
    const tenant = this.normalizeCode(input?.tenantCode, 'POLLO001');
    const branch = this.normalizeCode(input?.branchCode, 'SUC001');
    const tableId = this.requireUuid(input?.tableId, 'tableId');
    const partySize = this.parseInteger(input?.partySize, 'partySize', 1, 50);
    const durationMinutes = this.parseDuration(input?.durationMinutes);
    const window = this.parseFutureWindow(input?.reservedFor, durationMinutes);
    const customerName = this.requireText(
      input?.customerName,
      'customerName',
      2,
      120,
    );
    const customerPhone = this.requireText(
      input?.customerPhone,
      'customerPhone',
      6,
      40,
    );
    const customerNotes = this.optionalText(
      input?.customerNotes,
      'customerNotes',
      500,
    );
    const reservationCode = `R${randomUUID()
      .replaceAll('-', '')
      .slice(0, 9)
      .toUpperCase()}`;

    try {
      return await this.databaseService.withTransaction(async (client) => {
        const tableResult = await client.query<LockedTableRow>(
          `
                select
                  dt.tenant_id::text,
                  dt.branch_id::text,
                  b.timezone as time_zone,
                  dt.id::text,
                  dt.code,
                  dt.name,
                  dt.capacity,
                  dt.zone,
                  dt.is_active

                from public.dining_tables dt

                inner join public.tenants t
                  on t.id = dt.tenant_id

                inner join public.branches b
                  on b.tenant_id = dt.tenant_id
                 and b.id = dt.branch_id

                where dt.id = $1::uuid
                  and t.code = $2
                  and b.code = $3

                for update of dt
              `,
          [tableId, tenant, branch],
        );

        const table = tableResult.rows[0];

        if (!table) {
          throw new NotFoundException(
            'Table not found for this tenant and branch',
          );
        }

        await lockBranchAdmission(client, table.tenant_id, table.branch_id, [
          'DINE_IN',
          'RESERVATIONS',
        ]);

        if (!table.is_active) {
          throw new ConflictException(`${table.name} is not active`);
        }

        if (partySize > table.capacity) {
          throw new ConflictException(
            `${table.name} has capacity for ${table.capacity} people`,
          );
        }

        const insertResult = await client.query<{ id: string }>(
          `
                insert into public.table_reservations (
                  tenant_id,
                  branch_id,
                  table_id,
                  reservation_code,
                  status,
                  reserved_for,
                  reserved_until,
                  duration_minutes,
                  party_size,
                  customer_name,
                  customer_phone,
                  customer_notes,
                  source
                )

                values (
                  $1::uuid,
                  $2::uuid,
                  $3::uuid,
                  $4,
                  'PENDING',
                  $5::timestamptz,
                  $6::timestamptz,
                  $7::integer,
                  $8::integer,
                  $9,
                  $10,
                  $11,
                  'WEB'
                )

                returning id::text
              `,
          [
            table.tenant_id,
            table.branch_id,
            table.id,
            reservationCode,
            window.reservedFor,
            window.reservedUntil,
            durationMinutes,
            partySize,
            customerName,
            customerPhone,
            customerNotes,
          ],
        );

        const reservation = await this.loadReservationById(
          client,
          insertResult.rows[0].id,
          tenant,
          branch,
        );

        if (!reservation) {
          throw new NotFoundException(
            'Created reservation could not be loaded',
          );
        }

        return {
          tenant,
          branch,
          timeZone: reservation.time_zone,
          reservation: this.mapReservation(reservation),
        };
      });
    } catch (error) {
      if (this.isOverlapError(error)) {
        throw new ConflictException(
          'The selected table already has a reservation in that time range',
        );
      }

      if (this.isReservationCodeCollision(error)) {
        throw new ConflictException(
          'Reservation could not be created; please retry',
        );
      }

      throw error;
    }
  }

  async getReservationTracking(
    trackingToken: string,
  ): Promise<ReservationTrackingResponse> {
    const result = await this.databaseService.query<ReservationRow>(
      `
          ${RESERVATION_SELECT}

          where r.tracking_token = $1::uuid

          limit 1
        `,
      [trackingToken],
    );

    const reservation = result.rows[0];

    if (!reservation) {
      throw new NotFoundException('Reservation not found');
    }

    return {
      tenant: reservation.tenant_code,
      branch: reservation.branch_code,
      timeZone: reservation.time_zone,
      reservation: this.mapReservation(reservation),
    };
  }

  async getOperationalReservations(
    tenantCode: string | undefined,
    branchCode: string | undefined,
    fromInput: string | undefined,
    toInput: string | undefined,
    statusInput: string | undefined,
  ): Promise<OperationalReservationsResponse> {
    const tenant = this.normalizeCode(tenantCode, 'POLLO001');
    const branch = this.normalizeCode(branchCode, 'SUC001');
    const now = Date.now();
    const from = this.parseOptionalDate(
      fromInput,
      new Date(now - 24 * 60 * 60 * 1000),
      'from',
    );
    const to = this.parseOptionalDate(
      toInput,
      new Date(now + 30 * 24 * 60 * 60 * 1000),
      'to',
    );
    const status = this.parseOptionalStatus(statusInput);

    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('from must be earlier than to');
    }

    const branchRow = await this.getBranch(tenant, branch);

    const result = await this.databaseService.query<ReservationRow>(
      `
          ${RESERVATION_SELECT}

          where r.tenant_id = $1::uuid
            and r.branch_id = $2::uuid
            and r.reserved_for < $4::timestamptz
            and r.reserved_until > $3::timestamptz
            and (
              $5::varchar is null
              or r.status = $5
            )

          order by
            r.reserved_for,
            dt.zone nulls last,
            dt.name
        `,
      [
        branchRow.tenant_id,
        branchRow.branch_id,
        from.toISOString(),
        to.toISOString(),
        status,
      ],
    );

    return {
      tenant,
      branch,
      timeZone: branchRow.time_zone,
      from: from.toISOString(),
      to: to.toISOString(),
      status,
      total: result.rows.length,
      reservations: result.rows.map((reservation) =>
        this.mapReservation(reservation),
      ),
    };
  }

  async updateReservationStatus(
    reservationId: string,
    statusInput: string | undefined,
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ): Promise<UpdateReservationStatusResponse> {
    const tenant = this.normalizeCode(tenantCode, 'POLLO001');
    const branch = this.normalizeCode(branchCode, 'SUC001');
    const targetStatus = this.parseOperationalTargetStatus(statusInput);

    return this.databaseService.withTransaction(async (client) => {
      const current = await this.loadReservationById(
        client,
        reservationId,
        tenant,
        branch,
        true,
      );

      if (!current) {
        throw new NotFoundException(
          'Reservation not found for this tenant and branch',
        );
      }

      const previousStatus = current.status;

      if (previousStatus === targetStatus) {
        return {
          tenant,
          branch,
          timeZone: current.time_zone,
          previousStatus,
          changed: false,
          reservation: this.mapReservation(current),
        };
      }

      const allowedTransitions: Partial<
        Record<ReservationStatus, ReservationStatus[]>
      > = {
        PENDING: ['CONFIRMED', 'CANCELLED'],
        CONFIRMED: ['CANCELLED', 'NO_SHOW'],
      };

      if (!allowedTransitions[previousStatus]?.includes(targetStatus)) {
        throw new ConflictException(
          `Reservation cannot transition from ${previousStatus} to ${targetStatus}`,
        );
      }

      const preorderResult = await client.query<{
        id: string;
        status:
          | 'PENDING'
          | 'CONFIRMED'
          | 'PREPARING'
          | 'READY'
          | 'COMPLETED'
          | 'CANCELLED';
        payment_status:
          | 'NOT_REQUIRED'
          | 'PENDING'
          | 'AWAITING_CONFIRMATION'
          | 'PAID'
          | 'FAILED'
          | 'EXPIRED'
          | 'CANCELLED'
          | 'REFUND_PENDING'
          | 'REFUNDED'
          | 'REVIEW_REQUIRED';
      }>(
        `
            select
              o.id::text,
              o.status,
              o.payment_status

            from public.orders o

            where o.tenant_id = $1::uuid
              and o.branch_id = $2::uuid
              and o.reservation_id = $3::uuid

            limit 1

            for update
          `,
        [current.tenant_id, current.branch_id, current.id],
      );

      const preorder = preorderResult.rows[0] ?? null;

      if (
        (targetStatus === 'CANCELLED' || targetStatus === 'NO_SHOW') &&
        preorder &&
        ['PREPARING', 'READY', 'COMPLETED'].includes(preorder.status)
      ) {
        throw new ConflictException(
          `Reservation cannot be ${targetStatus.toLowerCase()} because its advance order is ${preorder.status}`,
        );
      }

      await client.query(
        `
            update public.table_reservations

            set
              status = $4::varchar,

              confirmed_at = case
                when $4::varchar = 'CONFIRMED'
                  then coalesce(
                    confirmed_at,
                    now()
                  )
                else confirmed_at
              end,

              cancelled_at = case
                when $4::varchar = 'CANCELLED'
                  then now()
                else cancelled_at
              end,

              no_show_at = case
                when $4::varchar = 'NO_SHOW'
                  then now()
                else no_show_at
              end,

              updated_at = now()

            where id = $1::uuid
              and tenant_id = $2::uuid
              and branch_id = $3::uuid
          `,
        [current.id, current.tenant_id, current.branch_id, targetStatus],
      );

      if (preorder && targetStatus === 'CONFIRMED') {
        await client.query(
          `
              update public.orders

              set
                status = 'CONFIRMED',
                updated_at = now()

              where id = $1::uuid
                and status = 'PENDING'
                and payment_status in (
                  'PAID',
                  'NOT_REQUIRED'
                )
            `,
          [preorder.id],
        );
      }

      if (
        preorder &&
        (targetStatus === 'CANCELLED' || targetStatus === 'NO_SHOW')
      ) {
        await client.query(
          `
              update public.orders

              set
                status = 'CANCELLED',
                updated_at = now()

              where id = $1::uuid
                and status in (
                  'PENDING',
                  'CONFIRMED'
                )
            `,
          [preorder.id],
        );
      }

      const updated = await this.loadReservationById(
        client,
        current.id,
        tenant,
        branch,
      );

      if (!updated) {
        throw new NotFoundException('Updated reservation could not be loaded');
      }

      return {
        tenant,
        branch,
        timeZone: updated.time_zone,
        previousStatus,
        changed: true,
        reservation: this.mapReservation(updated),
      };
    });
  }

  async checkInReservation(
    reservationId: string,
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ): Promise<CheckInReservationResponse> {
    const tenant = this.normalizeCode(tenantCode, 'POLLO001');
    const branch = this.normalizeCode(branchCode, 'SUC001');

    return this.databaseService.withTransaction(async (client) => {
      const reservation = await this.loadReservationById(
        client,
        reservationId,
        tenant,
        branch,
        true,
      );

      if (!reservation) {
        throw new NotFoundException(
          'Reservation not found for this tenant and branch',
        );
      }

      if (
        reservation.status !== 'PENDING' &&
        reservation.status !== 'CONFIRMED'
      ) {
        throw new ConflictException(
          `Reservation cannot be checked in from ${reservation.status}`,
        );
      }

      if (!reservation.table_is_active) {
        throw new ConflictException(`${reservation.table_name} is not active`);
      }

      const previousStatus = reservation.status;
      const now = Date.now();
      const reservedFor = new Date(reservation.reserved_for).getTime();
      const reservedUntil = new Date(reservation.reserved_until).getTime();
      const earliestCheckIn = reservedFor - 60 * 60 * 1000;

      if (now < earliestCheckIn) {
        throw new ConflictException(
          'Check-in is available starting 60 minutes before the reservation',
        );
      }

      if (now >= reservedUntil) {
        throw new ConflictException('The reservation window has already ended');
      }

      const currentSessionResult = await client.query<ExistingSessionRow>(
        `
              select ts.id::text

              from public.table_sessions ts

              where ts.tenant_id = $1::uuid
                and ts.branch_id = $2::uuid
                and ts.table_id = $3::uuid
                and ts.status = 'OPEN'

              limit 1
            `,
        [reservation.tenant_id, reservation.branch_id, reservation.table_id],
      );

      if (currentSessionResult.rows[0]) {
        throw new ConflictException(
          `${reservation.table_name} is currently occupied`,
        );
      }

      const sessionResult = await client.query<CreatedSessionRow>(
        `
              insert into public.table_sessions (
                tenant_id,
                branch_id,
                table_id,
                status,
                opened_at
              )

              select
                r.tenant_id,
                r.branch_id,
                r.table_id,
                'OPEN',
                now()

              from public.table_reservations r

              where r.id = $1::uuid

              returning
                id::text,
                status,
                opened_at
            `,
        [reservation.id],
      );

      const session = sessionResult.rows[0];

      await client.query(
        `
            update public.table_reservations

            set
              status = 'SEATED',
              confirmed_at = coalesce(
                confirmed_at,
                now()
              ),
              seated_at = now(),
              table_session_id = $2::uuid,
              updated_at = now()

            where id = $1::uuid
              and status in (
                'PENDING',
                'CONFIRMED'
              )
          `,
        [reservation.id, session.id],
      );

      await client.query(
        `
            update public.orders

            set
              status = case
                when status = 'PENDING'
                  and payment_status in (
                    'PAID',
                    'NOT_REQUIRED'
                  )
                  then 'CONFIRMED'
                else status
              end,
              table_code = $3,
              table_session_id = $2::uuid,
              updated_at = now()

            where reservation_id = $1::uuid
              and tenant_id = $4::uuid
              and branch_id = $5::uuid
              and table_session_id is null
              and status <> 'CANCELLED'
          `,
        [
          reservation.id,
          session.id,
          reservation.table_code,
          reservation.tenant_id,
          reservation.branch_id,
        ],
      );

      const updated = await this.loadReservationById(
        client,
        reservation.id,
        tenant,
        branch,
      );

      if (!updated) {
        throw new NotFoundException(
          'Checked-in reservation could not be loaded',
        );
      }

      return {
        tenant,
        branch,
        timeZone: updated.time_zone,
        previousStatus,
        reservation: this.mapReservation(updated),
        table: {
          id: updated.table_id,
          code: updated.table_code,
          name: updated.table_name,
          availability: 'OCCUPIED',
        },
        tableSession: {
          id: session.id,
          status: session.status,
          openedAt: session.opened_at,
        },
      };
    });
  }

  private async getBranch(tenant: string, branch: string): Promise<BranchRow> {
    const result = await this.databaseService.query<BranchRow>(
      `
          select
            t.id::text as tenant_id,
            b.id::text as branch_id,
            b.timezone as time_zone

          from public.tenants t

          inner join public.branches b
            on b.tenant_id = t.id

          where t.code = $1
            and b.code = $2
            and t.status = 'ACTIVE'
            and b.status = 'ACTIVE'

          limit 1
        `,
      [tenant, branch],
    );

    const branchRow = result.rows[0];

    if (!branchRow) {
      throw new NotFoundException('Active tenant and branch not found');
    }

    return branchRow;
  }

  private async loadReservationById(
    client: PoolClient,
    reservationId: string,
    tenant: string,
    branch: string,
    lock = false,
  ): Promise<ReservationRow | null> {
    const result = await client.query<ReservationRow>(
      `
          ${RESERVATION_SELECT}

          where r.id = $1::uuid
            and t.code = $2
            and b.code = $3

          limit 1

          ${lock ? 'for update of r, dt' : ''}
        `,
      [reservationId, tenant, branch],
    );

    return result.rows[0] ?? null;
  }

  private mapReservation(reservation: ReservationRow): ReservationRecord {
    return {
      id: reservation.id,
      reservationCode: reservation.reservation_code,
      trackingToken: reservation.tracking_token,
      status: reservation.status,
      reservedFor: reservation.reserved_for,
      reservedUntil: reservation.reserved_until,
      durationMinutes: reservation.duration_minutes,
      partySize: reservation.party_size,
      customerName: reservation.customer_name,
      customerPhone: reservation.customer_phone,
      customerNotes: reservation.customer_notes,
      source: reservation.source,
      table: {
        id: reservation.table_id,
        code: reservation.table_code,
        name: reservation.table_name,
        capacity: reservation.table_capacity,
        zone: reservation.table_zone,
      },
      tableSession:
        reservation.table_session_id === null ||
        reservation.table_session_status === null ||
        reservation.table_session_opened_at === null
          ? null
          : {
              id: reservation.table_session_id,
              status: reservation.table_session_status,
              openedAt: reservation.table_session_opened_at,
              closedAt: reservation.table_session_closed_at,
            },
      preorder:
        reservation.preorder_id === null ||
        reservation.preorder_order_number === null ||
        reservation.preorder_tracking_token === null ||
        reservation.preorder_status === null ||
        reservation.preorder_currency === null ||
        reservation.preorder_total === null
          ? null
          : {
              id: reservation.preorder_id,
              orderNumber: reservation.preorder_order_number,
              trackingToken: reservation.preorder_tracking_token,
              status: reservation.preorder_status,
              currency: reservation.preorder_currency,
              total: Number(reservation.preorder_total),
              scheduledFor: reservation.preorder_scheduled_for,
              tableSessionId: reservation.preorder_table_session_id,
            },
      confirmedAt: reservation.confirmed_at,
      seatedAt: reservation.seated_at,
      cancelledAt: reservation.cancelled_at,
      noShowAt: reservation.no_show_at,
      completedAt: reservation.completed_at,
      createdAt: reservation.created_at,
      updatedAt: reservation.updated_at,
    };
  }

  private normalizeCode(value: string | undefined, fallback: string): string {
    return value?.trim() || fallback;
  }

  private requireUuid(value: string | undefined, field: string): string {
    const normalized = value?.trim();

    if (!normalized || !UUID_PATTERN.test(normalized)) {
      throw new BadRequestException(`${field} must be a valid UUID`);
    }

    return normalized;
  }

  private requireText(
    value: string | undefined,
    field: string,
    minLength: number,
    maxLength: number,
  ): string {
    const normalized = value?.trim();

    if (!normalized || normalized.length < minLength) {
      throw new BadRequestException(`${field} is required`);
    }

    if (normalized.length > maxLength) {
      throw new BadRequestException(
        `${field} must have at most ${maxLength} characters`,
      );
    }

    return normalized;
  }

  private optionalText(
    value: string | undefined,
    field: string,
    maxLength: number,
  ): string | null {
    const normalized = value?.trim();

    if (!normalized) {
      return null;
    }

    if (normalized.length > maxLength) {
      throw new BadRequestException(
        `${field} must have at most ${maxLength} characters`,
      );
    }

    return normalized;
  }

  private parseInteger(
    value: unknown,
    field: string,
    min: number,
    max: number,
  ): number {
    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException(
        `${field} must be an integer between ${min} and ${max}`,
      );
    }

    return parsed;
  }

  private parseDuration(value: unknown): number {
    const duration =
      value === undefined || value === null || value === ''
        ? 90
        : this.parseInteger(value, 'durationMinutes', 30, 240);

    if (duration % 15 !== 0) {
      throw new BadRequestException(
        'durationMinutes must use 15-minute increments',
      );
    }

    return duration;
  }

  private parseFutureWindow(
    reservedForInput: string | undefined,
    durationMinutes: number,
  ): {
    reservedFor: string;
    reservedUntil: string;
  } {
    const reservedFor = this.parseDate(reservedForInput, 'reservedFor');
    const now = Date.now();
    const minimum = now + 5 * 60 * 1000;
    const maximum = now + 365 * 24 * 60 * 60 * 1000;

    if (reservedFor.getTime() < minimum) {
      throw new BadRequestException(
        'reservedFor must be at least 5 minutes in the future',
      );
    }

    if (reservedFor.getTime() > maximum) {
      throw new BadRequestException(
        'reservedFor cannot be more than 365 days in the future',
      );
    }

    const reservedUntil = new Date(
      reservedFor.getTime() + durationMinutes * 60 * 1000,
    );

    return {
      reservedFor: reservedFor.toISOString(),
      reservedUntil: reservedUntil.toISOString(),
    };
  }

  private parseDate(value: string | undefined, field: string): Date {
    const normalized = value?.trim();

    if (!normalized || !TIME_ZONE_PATTERN.test(normalized)) {
      throw new BadRequestException(
        `${field} must be an ISO date with timezone`,
      );
    }

    const parsed = new Date(normalized);

    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${field} must be a valid date`);
    }

    return parsed;
  }

  private parseOptionalDate(
    value: string | undefined,
    fallback: Date,
    field: string,
  ): Date {
    if (!value?.trim()) {
      return fallback;
    }

    return this.parseDate(value, field);
  }

  private parseOptionalStatus(
    value: string | undefined,
  ): ReservationStatus | null {
    if (!value?.trim()) {
      return null;
    }

    const normalized = value.trim().toUpperCase();

    if (!this.isReservationStatus(normalized)) {
      throw new BadRequestException('status is not valid');
    }

    return normalized;
  }

  private parseOperationalTargetStatus(
    value: string | undefined,
  ): 'CONFIRMED' | 'CANCELLED' | 'NO_SHOW' {
    const normalized = value?.trim().toUpperCase();

    if (
      normalized !== 'CONFIRMED' &&
      normalized !== 'CANCELLED' &&
      normalized !== 'NO_SHOW'
    ) {
      throw new BadRequestException(
        'status must be CONFIRMED, CANCELLED or NO_SHOW',
      );
    }

    return normalized;
  }

  private isReservationStatus(value: string): value is ReservationStatus {
    return [
      'PENDING',
      'CONFIRMED',
      'SEATED',
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ].includes(value);
  }

  private isOverlapError(error: unknown): boolean {
    const postgresError = error as PostgresError;

    return (
      postgresError?.code === '23P01' ||
      postgresError?.constraint === 'table_reservations_no_overlap'
    );
  }

  private isReservationCodeCollision(error: unknown): boolean {
    const postgresError = error as PostgresError;

    return (
      postgresError?.code === '23505' &&
      postgresError?.constraint === 'table_reservations_code_unique'
    );
  }
}
