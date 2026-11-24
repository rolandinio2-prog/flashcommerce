import { assertDeliveryQrPaid } from '../payments/delivery-payment-policy';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { PaymentsService } from '../payments/payments.service';
import { GEO_PROVIDER, type GeoProvider } from './geo-provider';
import { GeoUsageMeterService } from './geo-usage-meter.service';
import {
  buildJourney,
  DriverJourneyNavigation,
  JOURNEY_SAMPLE_LIMIT,
  type JourneySample,
} from './driver-journey';
import { verifyDeliveryPod } from './delivery-pod';
import { trackingBranchOrigin, requireUuid } from './delivery-helpers';
import { DeliveryRoutingService } from './delivery-routing.service';

@Injectable()
export class DriverDeliveryService {
  private readonly driverJourneyNavigation = new DriverJourneyNavigation();

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly paymentsService: PaymentsService,
    private readonly geoUsageMeter: GeoUsageMeterService,
    @Inject(GEO_PROVIDER) private readonly geoProvider: GeoProvider,
    private readonly routing: DeliveryRoutingService,
  ) {}

  async getDriverActiveDeliveries(
    tenantIdInput: unknown,
    driverIdInput: unknown,
  ) {
    const tenantId = requireUuid(tenantIdInput, 'tenantId');

    const driverId = requireUuid(driverIdInput, 'driverId');

    const result = await this.databaseService.query<{
      delivery_id: string;
      delivery_status: string;

      order_number: string;
      order_status: string;
      order_payment_status: string;

      relationship_role: 'PRIMARY' | 'ADDITIONAL';

      member_count: number;

      member_orders: Array<{
        number: string;
        status: string;
        paymentStatus: string;
        relationshipRole: 'PRIMARY' | 'ADDITIONAL';
      }>;

      payment_method: string | null;
      payment_provider: string | null;
      payment_attempt_status: string | null;
      payment_amount: string | null;
      payment_currency: string | null;

      assignment_id: string;
      assignment_number: number;
      assignment_status: string;

      recipient_name: string;
      recipient_phone: string;

      address_text: string;
      address_reference: string | null;

      branch_name: string;
      branch_latitude: string | null;
      branch_longitude: string | null;
      destination_latitude: number;
      destination_longitude: number;

      eta_min_minutes: number | null;
      eta_max_minutes: number | null;
    }>(
      `
          select
            d.id::text
              as delivery_id,

            d.status
              as delivery_status,

            o.order_number::text
              as order_number,

            o.status
              as order_status,

            o.payment_status
              as order_payment_status,

            coalesce(
              (
                select m0.role
                from public.delivery_order_memberships m0
                where m0.tenant_id = d.tenant_id
                  and m0.branch_id = d.branch_id
                  and m0.delivery_id = d.id
                  and m0.order_id = o.id
                  and m0.membership_status in (
                    'PENDING',
                    'ACTIVE'
                  )
                order by
                  case m0.role
                    when 'PRIMARY' then 0
                    else 1
                  end,
                  m0.joined_at
                limit 1
              ),
              'PRIMARY'
            ) as relationship_role,

            (
              select count(*)::integer
              from public.delivery_order_memberships mc
              where mc.tenant_id = d.tenant_id
                and mc.branch_id = d.branch_id
                and mc.delivery_id = d.id
                and mc.membership_status in (
                  'PENDING',
                  'ACTIVE'
                )
            ) as member_count,

            coalesce(
              (
                select jsonb_agg(
                  jsonb_build_object(
                    'number',
                    mo.order_number::text,
                    'status',
                    mo.status,
                    'paymentStatus',
                    mo.payment_status,
                    'relationshipRole',
                    mm.role
                  )
                  order by
                    case mm.role
                      when 'PRIMARY' then 0
                      else 1
                    end,
                    mm.joined_at,
                    mo.order_number
                )
                from public.delivery_order_memberships mm
                inner join public.orders mo
                  on mo.tenant_id = mm.tenant_id
                 and mo.branch_id = mm.branch_id
                 and mo.id = mm.order_id
                where mm.tenant_id = d.tenant_id
                  and mm.branch_id = d.branch_id
                  and mm.delivery_id = d.id
                  and mm.membership_status in (
                    'PENDING',
                    'ACTIVE'
                  )
              ),
              '[]'::jsonb
            ) as member_orders,

            p.method
              as payment_method,

            p.provider
              as payment_provider,

            p.status
              as payment_attempt_status,

            p.amount::text
              as payment_amount,

            p.currency
              as payment_currency,

            a.id::text
              as assignment_id,

            a.assignment_number,

            a.status
              as assignment_status,

            d.recipient_name,
            d.recipient_phone,

            d.address_text,
            d.address_reference,

            b.name as branch_name,
            b.delivery_origin_latitude::text as branch_latitude,
            b.delivery_origin_longitude::text as branch_longitude,
            gis.ST_Y(
              d.destination::gis.geometry
            )::double precision
              as destination_latitude,

            gis.ST_X(
              d.destination::gis.geometry
            )::double precision
              as destination_longitude,

            d.eta_min_minutes,
            d.eta_max_minutes

          from public.delivery_assignments a

          inner join public.deliveries d
            on d.tenant_id = a.tenant_id
           and d.branch_id = a.branch_id
           and d.id = a.delivery_id

          inner join public.orders o
            on o.tenant_id = d.tenant_id
           and o.branch_id = d.branch_id
           and o.id = d.order_id

          left join public.branches b
            on b.tenant_id = d.tenant_id
           and b.id = d.branch_id

          inner join public.delivery_driver_branches db
            on db.tenant_id = a.tenant_id
           and db.branch_id = a.branch_id
           and db.driver_id = a.driver_id

          left join public.order_payments p
            on p.tenant_id = o.tenant_id
           and p.branch_id = o.branch_id
           and p.order_id = o.id
           and p.method = 'CASH'
           and p.provider = 'DRIVER_COD'
           and p.status = o.payment_status
           and p.status in (
             'AWAITING_CONFIRMATION',
             'PAID'
           )

          where a.tenant_id = $1::uuid
            and a.driver_id = $2::uuid

            and a.status in (
              'ASSIGNED',
              'ACCEPTED'
            )

            and d.status in (
              'ASSIGNED',
              'ACCEPTED',
              'PICKED_UP',
              'EN_ROUTE',
              'ARRIVED'
            )

            and db.status = 'ENABLED'

          order by
            a.assigned_at asc,
            a.assignment_number asc,
            d.id asc
        `,
      [tenantId, driverId],
    );

    for (const row of result.rows) {
      const assignmentMatchesDelivery =
        (row.delivery_status === 'ASSIGNED' &&
          row.assignment_status === 'ASSIGNED') ||
        (['ACCEPTED', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED'].includes(
          row.delivery_status,
        ) &&
          row.assignment_status === 'ACCEPTED');

      if (!assignmentMatchesDelivery) {
        throw new ConflictException(
          'Delivery assignment state is inconsistent',
        );
      }
    }

    return {
      total: result.rows.length,

      deliveries: result.rows.map((row) => ({
        delivery: {
          id: row.delivery_id,
          status: row.delivery_status,

          relationshipRole: row.relationship_role,

          memberCount: row.member_count,

          isShared: row.member_count > 1,

          memberOrders: row.member_orders,
        },

        order: {
          number: row.order_number,
          status: row.order_status,

          paymentStatus: row.order_payment_status,
        },

        payment:
          row.payment_method === 'CASH' &&
          row.payment_provider === 'DRIVER_COD' &&
          row.payment_attempt_status !== null &&
          row.payment_amount !== null &&
          row.payment_currency !== null
            ? {
                method: 'CASH' as const,

                provider: 'DRIVER_COD' as const,

                status: row.payment_attempt_status,

                amount: Number(row.payment_amount),

                currency: row.payment_currency,

                cashOnDelivery: true as const,

                cashCollectionRequired:
                  row.payment_attempt_status === 'AWAITING_CONFIRMATION',
              }
            : null,

        assignment: {
          id: row.assignment_id,
          number: row.assignment_number,
          status: row.assignment_status,
        },

        recipient: {
          name: row.recipient_name,
          phone: row.recipient_phone,
        },

        branchOrigin: trackingBranchOrigin(row),

        destination: {
          address: row.address_text,
          reference: row.address_reference,

          location: {
            latitude: row.destination_latitude,

            longitude: row.destination_longitude,
          },
        },

        eta: {
          minMinutes: row.eta_min_minutes,
          maxMinutes: row.eta_max_minutes,
        },
      })),
    };
  }
  async getDriverDeliveryMapRoute(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
  ) {
    const deliveryId = requireUuid(deliveryIdInput, 'deliveryId');

    const tenantId = requireUuid(tenantIdInput, 'tenantId');

    const driverId = requireUuid(driverIdInput, 'driverId');

    const result = await this.databaseService.query<{
      delivery_id: string;
      delivery_status: string;
      branch_name: string;
      branch_latitude: string | null;
      branch_longitude: string | null;

      destination_latitude: number;
      destination_longitude: number;

      latitude: number | null;
      longitude: number | null;
      captured_at: string | Date | null;
    }>(
      `
          select
            b.name as branch_name,
            b.delivery_origin_latitude::text as branch_latitude,
            b.delivery_origin_longitude::text as branch_longitude,
            d.id::text
              as delivery_id,

            d.status
              as delivery_status,

            gis.ST_Y(
              d.destination::gis.geometry
            )::double precision
              as destination_latitude,

            gis.ST_X(
              d.destination::gis.geometry
            )::double precision
              as destination_longitude,

            loc.latitude,
            loc.longitude,
            loc.captured_at

          from public.deliveries d

          left join public.branches b
            on b.tenant_id = d.tenant_id
           and b.id = d.branch_id

          inner join public.delivery_assignments a
            on a.tenant_id = d.tenant_id
           and a.branch_id = d.branch_id
           and a.delivery_id = d.id
           and a.driver_id = $3::uuid
           and a.status = 'ACCEPTED'

          inner join public.delivery_driver_branches db
            on db.tenant_id = a.tenant_id
           and db.branch_id = a.branch_id
           and db.driver_id = a.driver_id
           and db.status = 'ENABLED'

          left join lateral (
            select
              gis.ST_Y(
                l.position::gis.geometry
              )::double precision
                as latitude,

              gis.ST_X(
                l.position::gis.geometry
              )::double precision
                as longitude,

              l.captured_at

            from public.delivery_driver_locations l

            where l.tenant_id = d.tenant_id
              and l.branch_id = d.branch_id
              and l.delivery_id = d.id
              and l.driver_id = a.driver_id
              and l.captured_at <= l.received_at + interval '5 minutes'
              and l.captured_at >= l.received_at - interval '24 hours'

            order by
              l.received_at desc,
              l.captured_at desc

            limit 1
          ) loc
            on true

          where d.tenant_id = $1::uuid
            and d.id = $2::uuid
            and d.status in (
              'ACCEPTED',
              'PICKED_UP',
              'EN_ROUTE',
              'ARRIVED'
            )

          limit 1
        `,
      [tenantId, deliveryId, driverId],
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException('Active delivery route not found');
    }

    const location =
      row.latitude !== null &&
      row.longitude !== null &&
      row.captured_at !== null
        ? {
            latitude: row.latitude,
            longitude: row.longitude,
            capturedAt: row.captured_at,
          }
        : null;

    const destination = {
      latitude: row.destination_latitude,

      longitude: row.destination_longitude,
    };

    // Authorization above is unchanged; history is restricted to this tenant, delivery and driver.
    const history = await this.databaseService.query<JourneySample>(
      `
      select gis.ST_Y(l.position::gis.geometry)::double precision as latitude,
             gis.ST_X(l.position::gis.geometry)::double precision as longitude,
             l.accuracy_meters::double precision as "accuracyMeters",
             l.captured_at::text as "capturedAt", l.received_at::text as "receivedAt"
      from public.delivery_driver_locations l
      where l.tenant_id = $1::uuid and l.delivery_id = $2::uuid and l.driver_id = $3::uuid
      order by l.received_at asc, l.id asc
      limit $4
    `,
      [tenantId, deliveryId, driverId, JOURNEY_SAMPLE_LIMIT + 1],
    );
    const journey = buildJourney(history.rows);
    const navigation = await this.driverJourneyNavigation.get(
      JSON.stringify([tenantId, deliveryId, driverId]),
      journey.latest,
      destination,
      (origin, target) =>
        this.geoUsageMeter.measure(
          { tenantId, provider: 'GOOGLE', operation: 'ROUTE', cacheHit: false },
          () =>
            this.geoProvider.calculateRoute({ origin, destination: target }),
        ),
    );
    const baseRoute = await this.routing.getDeliveryBaseRoute(
      tenantId,
      row.delivery_id,
      trackingBranchOrigin(row),
      destination,
    );
    const route = navigation.route;

    return {
      delivery: {
        id: row.delivery_id,
        status: row.delivery_status,
      },

      location,
      baseRoute,

      destination,
      route,
      journey,
      navigation,
    };
  }
  async acceptDriverDelivery(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    driverCode: string,
  ) {
    const deliveryId = requireUuid(deliveryIdInput, 'deliveryId');

    const tenantId = requireUuid(tenantIdInput, 'tenantId');

    const driverId = requireUuid(driverIdInput, 'driverId');

    const safeDriverCode = driverCode?.trim() || 'DRIVER';

    return this.databaseService.withTransaction(async (client) => {
      const deliveryResult = await client.query<{
        id: string;

        tenant_id: string;
        branch_id: string;

        order_id: string;
        order_number: string;

        delivery_status: string;

        order_status: string;
        payment_status: string;
      }>(
        `
              select
                d.id::text,

                d.tenant_id::text,
                d.branch_id::text,

                d.order_id::text,

                o.order_number::text,

                d.status
                  as delivery_status,

                o.status
                  as order_status,

                o.payment_status

              from public.deliveries d

              inner join public.orders o
                on o.tenant_id = d.tenant_id
               and o.branch_id = d.branch_id
               and o.id = d.order_id

              where d.tenant_id = $1::uuid
                and d.id = $2::uuid

              for update of d
            `,
        [tenantId, deliveryId],
      );

      const delivery = deliveryResult.rows[0];

      if (!delivery) {
        throw new NotFoundException('Delivery not found');
      }

      // ----------------------------------------------------
      // Branch authorization is evaluated inside the same
      // transaction as the driver action.
      //
      // A valid bearer identifies the driver globally, but
      // the driver must still be ENABLED for the specific
      // branch that owns this delivery.
      //
      // FOR SHARE prevents the branch authorization row from
      // being concurrently changed while this transaction
      // advances the delivery state.
      // ----------------------------------------------------

      const branchAuthorizationResult = await client.query<{
        id: string;
      }>(
        `
              select
                db.id::text

              from public.delivery_driver_branches db

              where db.tenant_id = $1::uuid
                and db.branch_id = $2::uuid
                and db.driver_id = $3::uuid
                and db.status = 'ENABLED'

              limit 1

              for share of db
            `,
        [delivery.tenant_id, delivery.branch_id, driverId],
      );

      if (!branchAuthorizationResult.rows[0]) {
        throw new ConflictException(
          'Driver is not enabled for delivery branch',
        );
      }

      if (delivery.order_status !== 'READY') {
        throw new ConflictException(
          `Delivery cannot be accepted while order is ${delivery.order_status}; READY is required`,
        );
      }

      await assertDeliveryQrPaid(client, delivery);

      if (
        delivery.delivery_status !== 'ASSIGNED' &&
        delivery.delivery_status !== 'ACCEPTED'
      ) {
        throw new ConflictException(
          `Delivery cannot be accepted from ${delivery.delivery_status}`,
        );
      }

      const assignmentResult = await client.query<{
        id: string;
        assignment_number: number;

        driver_id: string;

        status: string;

        assigned_at: string | Date;
        accepted_at: string | Date | null;
      }>(
        `
              select
                a.id::text,

                a.assignment_number,

                a.driver_id::text,

                a.status,

                a.assigned_at,
                a.accepted_at

              from public.delivery_assignments a

              where a.tenant_id = $1::uuid
                and a.branch_id = $2::uuid
                and a.delivery_id = $3::uuid

                and a.status in (
                  'ASSIGNED',
                  'ACCEPTED'
                )

              order by
                a.assignment_number desc

              limit 1

              for update of a
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      const assignment = assignmentResult.rows[0];

      if (!assignment) {
        throw new ConflictException(
          'Delivery assignment state is inconsistent',
        );
      }

      if (assignment.driver_id !== driverId) {
        throw new ConflictException('Delivery is assigned to another driver');
      }

      // ----------------------------------------------------
      // Idempotent retry:
      //
      // The authenticated driver already accepted this exact
      // active assignment. No duplicate event is produced.
      // ----------------------------------------------------

      if (
        delivery.delivery_status === 'ACCEPTED' &&
        assignment.status === 'ACCEPTED'
      ) {
        return {
          changed: false,
          action: 'UNCHANGED',

          delivery: {
            id: delivery.id,
            status: 'ACCEPTED',
          },

          order: {
            id: delivery.order_id,
            number: delivery.order_number,
            status: delivery.order_status,
          },

          assignment: {
            id: assignment.id,
            number: assignment.assignment_number,

            status: 'ACCEPTED',

            assignedAt: assignment.assigned_at,

            acceptedAt: assignment.accepted_at,

            driver: {
              id: driverId,
              code: safeDriverCode,
            },
          },
        };
      }

      // Any mixed ASSIGNED/ACCEPTED state is inconsistent.
      if (
        delivery.delivery_status !== 'ASSIGNED' ||
        assignment.status !== 'ASSIGNED'
      ) {
        throw new ConflictException(
          'Delivery acceptance state is inconsistent',
        );
      }

      const assignmentUpdate = await client.query<{
        id: string;

        assignment_number: number;

        assigned_at: string | Date;
        accepted_at: string | Date;
      }>(
        `
              update public.delivery_assignments

              set
                status = 'ACCEPTED',
                accepted_at = now(),
                updated_at = now()

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and delivery_id = $3::uuid
                and id = $4::uuid
                and driver_id = $5::uuid

                and status = 'ASSIGNED'

              returning
                id::text,
                assignment_number,
                assigned_at,
                accepted_at
            `,
        [
          delivery.tenant_id,
          delivery.branch_id,
          delivery.id,
          assignment.id,
          driverId,
        ],
      );

      const acceptedAssignment = assignmentUpdate.rows[0];

      if (!acceptedAssignment) {
        throw new ConflictException('Delivery assignment changed concurrently');
      }

      const deliveryUpdate = await client.query<{
        id: string;
      }>(
        `
              update public.deliveries

              set
                status = 'ACCEPTED',
                updated_at = now()

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid

                and status = 'ASSIGNED'

              returning
                id::text
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      if (deliveryUpdate.rowCount !== 1) {
        throw new ConflictException('Delivery status changed concurrently');
      }

      await client.query(
        `
            insert into public.delivery_events (
              tenant_id,
              branch_id,
              delivery_id,

              event_type,

              from_status,
              to_status,

              actor_type,
              actor_reference,

              payload
            )
            values (
              $1::uuid,
              $2::uuid,
              $3::uuid,

              'DRIVER_ACCEPTED',

              'ASSIGNED',
              'ACCEPTED',

              'DRIVER',
              $4,

              jsonb_build_object(
                'driverId',
                $5::text,

                'driverCode',
                $4::text,

                'assignmentId',
                $6::text,

                'assignmentNumber',
                $7::integer,

                'orderId',
                $8::text,

                'orderNumber',
                $9::text
              )
            )
          `,
        [
          delivery.tenant_id,
          delivery.branch_id,
          delivery.id,

          safeDriverCode,
          driverId,

          acceptedAssignment.id,
          acceptedAssignment.assignment_number,

          delivery.order_id,
          delivery.order_number,
        ],
      );

      return {
        changed: true,
        action: 'ACCEPTED',

        delivery: {
          id: delivery.id,
          status: 'ACCEPTED',
        },

        order: {
          id: delivery.order_id,
          number: delivery.order_number,
          status: delivery.order_status,
        },

        assignment: {
          id: acceptedAssignment.id,

          number: acceptedAssignment.assignment_number,

          status: 'ACCEPTED',

          assignedAt: acceptedAssignment.assigned_at,

          acceptedAt: acceptedAssignment.accepted_at,

          driver: {
            id: driverId,
            code: safeDriverCode,
          },
        },
      };
    });
  }
  async pickupDriverDelivery(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    driverCode: string,
  ) {
    const deliveryId = requireUuid(deliveryIdInput, 'deliveryId');

    const tenantId = requireUuid(tenantIdInput, 'tenantId');

    const driverId = requireUuid(driverIdInput, 'driverId');

    const safeDriverCode = driverCode?.trim() || 'DRIVER';

    return this.databaseService.withTransaction(async (client) => {
      const deliveryResult = await client.query<{
        id: string;

        tenant_id: string;
        branch_id: string;

        order_id: string;
        order_number: string;

        delivery_status: string;

        order_status: string;
        payment_status: string;
      }>(
        `
              select
                d.id::text,

                d.tenant_id::text,
                d.branch_id::text,

                d.order_id::text,

                o.order_number::text,

                d.status
                  as delivery_status,

                o.status
                  as order_status,

                o.payment_status

              from public.deliveries d

              inner join public.orders o
                on o.tenant_id = d.tenant_id
               and o.branch_id = d.branch_id
               and o.id = d.order_id

              where d.tenant_id = $1::uuid
                and d.id = $2::uuid

              for update of d, o
            `,
        [tenantId, deliveryId],
      );

      const delivery = deliveryResult.rows[0];

      if (!delivery) {
        throw new NotFoundException('Delivery not found');
      }

      // ----------------------------------------------------
      // Branch authorization is evaluated inside the same
      // transaction as the driver action.
      //
      // A valid bearer identifies the driver globally, but
      // the driver must still be ENABLED for the specific
      // branch that owns this delivery.
      //
      // FOR SHARE prevents the branch authorization row from
      // being concurrently changed while this transaction
      // advances the delivery state.
      // ----------------------------------------------------

      const branchAuthorizationResult = await client.query<{
        id: string;
      }>(
        `
              select
                db.id::text

              from public.delivery_driver_branches db

              where db.tenant_id = $1::uuid
                and db.branch_id = $2::uuid
                and db.driver_id = $3::uuid
                and db.status = 'ENABLED'

              limit 1

              for share of db
            `,
        [delivery.tenant_id, delivery.branch_id, driverId],
      );

      if (!branchAuthorizationResult.rows[0]) {
        throw new ConflictException(
          'Driver is not enabled for delivery branch',
        );
      }

      if (
        delivery.delivery_status !== 'ACCEPTED' &&
        delivery.delivery_status !== 'PICKED_UP'
      ) {
        throw new ConflictException(
          `Delivery cannot be picked up from ${delivery.delivery_status}`,
        );
      }

      const assignmentResult = await client.query<{
        id: string;

        assignment_number: number;

        driver_id: string;

        status: string;

        assigned_at: string | Date;
        accepted_at: string | Date | null;
      }>(
        `
              select
                a.id::text,

                a.assignment_number,

                a.driver_id::text,

                a.status,

                a.assigned_at,
                a.accepted_at

              from public.delivery_assignments a

              where a.tenant_id = $1::uuid
                and a.branch_id = $2::uuid
                and a.delivery_id = $3::uuid

                and a.status in (
                  'ASSIGNED',
                  'ACCEPTED'
                )

              order by
                a.assignment_number desc

              limit 1

              for update of a
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      const assignment = assignmentResult.rows[0];

      if (!assignment) {
        throw new ConflictException(
          'Delivery assignment state is inconsistent',
        );
      }

      if (assignment.driver_id !== driverId) {
        throw new ConflictException('Delivery is assigned to another driver');
      }

      // ----------------------------------------------------
      // Idempotent retry.
      //
      // A previously completed pickup remains successful for
      // the same authenticated driver. The assignment stays
      // ACCEPTED and no duplicate event is produced.
      // ----------------------------------------------------

      if (
        delivery.delivery_status === 'PICKED_UP' &&
        assignment.status === 'ACCEPTED'
      ) {
        return {
          changed: false,
          action: 'UNCHANGED',

          delivery: {
            id: delivery.id,
            status: 'PICKED_UP',
          },

          order: {
            id: delivery.order_id,
            number: delivery.order_number,
            status: delivery.order_status,
          },

          assignment: {
            id: assignment.id,

            number: assignment.assignment_number,

            status: 'ACCEPTED',

            assignedAt: assignment.assigned_at,

            acceptedAt: assignment.accepted_at,

            driver: {
              id: driverId,
              code: safeDriverCode,
            },
          },
        };
      }

      if (
        delivery.delivery_status !== 'ACCEPTED' ||
        assignment.status !== 'ACCEPTED' ||
        !assignment.accepted_at
      ) {
        throw new ConflictException('Delivery pickup state is inconsistent');
      }

      // ----------------------------------------------------
      // Initial pickup requires the kitchen / operations
      // order state to be READY.
      // ----------------------------------------------------

      if (delivery.order_status !== 'READY') {
        throw new ConflictException(
          `Delivery cannot be picked up while order is ${delivery.order_status}`,
        );
      }

      await assertDeliveryQrPaid(client, delivery);

      const deliveryUpdate = await client.query<{
        id: string;
        updated_at: string | Date;
      }>(
        `
              update public.deliveries

              set
                status = 'PICKED_UP',
                updated_at = now()

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid

                and status = 'ACCEPTED'

              returning
                id::text,
                updated_at
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      const pickedUpDelivery = deliveryUpdate.rows[0];

      if (!pickedUpDelivery) {
        throw new ConflictException('Delivery status changed concurrently');
      }

      const eventResult = await client.query<{
        created_at: string | Date;
      }>(
        `
              insert into public.delivery_events (
                tenant_id,
                branch_id,
                delivery_id,

                event_type,

                from_status,
                to_status,

                actor_type,
                actor_reference,

                payload
              )
              values (
                $1::uuid,
                $2::uuid,
                $3::uuid,

                'DRIVER_PICKED_UP',

                'ACCEPTED',
                'PICKED_UP',

                'DRIVER',
                $4,

                jsonb_build_object(
                  'driverId',
                  $5::text,

                  'driverCode',
                  $4::text,

                  'assignmentId',
                  $6::text,

                  'assignmentNumber',
                  $7::integer,

                  'orderId',
                  $8::text,

                  'orderNumber',
                  $9::text
                )
              )

              returning
                created_at
            `,
        [
          delivery.tenant_id,
          delivery.branch_id,
          delivery.id,

          safeDriverCode,
          driverId,

          assignment.id,
          assignment.assignment_number,

          delivery.order_id,
          delivery.order_number,
        ],
      );

      const pickupEvent = eventResult.rows[0];

      if (!pickupEvent) {
        throw new ConflictException('Delivery pickup event was not created');
      }

      return {
        changed: true,
        action: 'PICKED_UP',

        delivery: {
          id: delivery.id,
          status: 'PICKED_UP',

          pickedUpAt: pickupEvent.created_at,
        },

        order: {
          id: delivery.order_id,
          number: delivery.order_number,
          status: delivery.order_status,
        },

        assignment: {
          id: assignment.id,

          number: assignment.assignment_number,

          // Intentionally remains ACCEPTED during
          // PICKED_UP / EN_ROUTE / ARRIVED.
          status: 'ACCEPTED',

          assignedAt: assignment.assigned_at,

          acceptedAt: assignment.accepted_at,

          driver: {
            id: driverId,
            code: safeDriverCode,
          },
        },
      };
    });
  }
  async startDriverDelivery(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    driverCode: string,
  ) {
    const deliveryId = requireUuid(deliveryIdInput, 'deliveryId');

    const tenantId = requireUuid(tenantIdInput, 'tenantId');

    const driverId = requireUuid(driverIdInput, 'driverId');

    const safeDriverCode = driverCode?.trim() || 'DRIVER';

    return this.databaseService.withTransaction(async (client) => {
      const deliveryResult = await client.query<{
        id: string;

        tenant_id: string;
        branch_id: string;

        order_id: string;
        order_number: string;

        delivery_status: string;

        order_status: string;
        payment_status: string;
      }>(
        `
              select
                d.id::text,

                d.tenant_id::text,
                d.branch_id::text,

                d.order_id::text,

                o.order_number::text,

                d.status
                  as delivery_status,

                o.status
                  as order_status,

                o.payment_status

              from public.deliveries d

              inner join public.orders o
                on o.tenant_id = d.tenant_id
               and o.branch_id = d.branch_id
               and o.id = d.order_id

              where d.tenant_id = $1::uuid
                and d.id = $2::uuid

              for update of d, o
            `,
        [tenantId, deliveryId],
      );

      const delivery = deliveryResult.rows[0];

      if (!delivery) {
        throw new NotFoundException('Delivery not found');
      }

      // ----------------------------------------------------
      // Branch authorization is evaluated inside the same
      // transaction as the driver action.
      //
      // A valid bearer identifies the driver globally, but
      // the driver must still be ENABLED for the specific
      // branch that owns this delivery.
      //
      // FOR SHARE prevents the branch authorization row from
      // being concurrently changed while this transaction
      // advances the delivery state.
      // ----------------------------------------------------

      const branchAuthorizationResult = await client.query<{
        id: string;
      }>(
        `
              select
                db.id::text

              from public.delivery_driver_branches db

              where db.tenant_id = $1::uuid
                and db.branch_id = $2::uuid
                and db.driver_id = $3::uuid
                and db.status = 'ENABLED'

              limit 1

              for share of db
            `,
        [delivery.tenant_id, delivery.branch_id, driverId],
      );

      if (!branchAuthorizationResult.rows[0]) {
        throw new ConflictException(
          'Driver is not enabled for delivery branch',
        );
      }

      if (
        delivery.delivery_status !== 'PICKED_UP' &&
        delivery.delivery_status !== 'EN_ROUTE'
      ) {
        throw new ConflictException(
          `Delivery cannot start route from ${delivery.delivery_status}`,
        );
      }

      const assignmentResult = await client.query<{
        id: string;

        assignment_number: number;

        driver_id: string;

        status: string;

        assigned_at: string | Date;
        accepted_at: string | Date | null;
      }>(
        `
              select
                a.id::text,

                a.assignment_number,

                a.driver_id::text,

                a.status,

                a.assigned_at,
                a.accepted_at

              from public.delivery_assignments a

              where a.tenant_id = $1::uuid
                and a.branch_id = $2::uuid
                and a.delivery_id = $3::uuid

                and a.status in (
                  'ASSIGNED',
                  'ACCEPTED'
                )

              order by
                a.assignment_number desc

              limit 1

              for update of a
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      const assignment = assignmentResult.rows[0];

      if (!assignment) {
        throw new ConflictException(
          'Delivery assignment state is inconsistent',
        );
      }

      if (assignment.driver_id !== driverId) {
        throw new ConflictException('Delivery is assigned to another driver');
      }

      // ----------------------------------------------------
      // Idempotent retry.
      //
      // If this same authenticated driver already started
      // the route, return the current state without creating
      // another DRIVER_EN_ROUTE event.
      // ----------------------------------------------------

      if (
        delivery.delivery_status === 'EN_ROUTE' &&
        assignment.status === 'ACCEPTED'
      ) {
        return {
          changed: false,
          action: 'UNCHANGED',

          delivery: {
            id: delivery.id,
            status: 'EN_ROUTE',
          },

          order: {
            id: delivery.order_id,
            number: delivery.order_number,
            status: delivery.order_status,
          },

          assignment: {
            id: assignment.id,

            number: assignment.assignment_number,

            status: 'ACCEPTED',

            assignedAt: assignment.assigned_at,

            acceptedAt: assignment.accepted_at,

            driver: {
              id: driverId,
              code: safeDriverCode,
            },
          },
        };
      }

      if (
        delivery.delivery_status !== 'PICKED_UP' ||
        assignment.status !== 'ACCEPTED' ||
        !assignment.accepted_at
      ) {
        throw new ConflictException('Delivery route state is inconsistent');
      }

      // ----------------------------------------------------
      // PICKED_UP already proves that the kitchen handed the
      // order to the driver. We still verify READY and payment
      // to protect against inconsistent external DB changes.
      // ----------------------------------------------------

      if (delivery.order_status !== 'READY') {
        throw new ConflictException(
          `Delivery cannot start route while order is ${delivery.order_status}`,
        );
      }

      await assertDeliveryQrPaid(client, delivery);

      const deliveryUpdate = await client.query<{
        id: string;
        updated_at: string | Date;
      }>(
        `
              update public.deliveries

              set
                status = 'EN_ROUTE',
                updated_at = now()

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid

                and status = 'PICKED_UP'

              returning
                id::text,
                updated_at
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      const enRouteDelivery = deliveryUpdate.rows[0];

      if (!enRouteDelivery) {
        throw new ConflictException('Delivery status changed concurrently');
      }

      const eventResult = await client.query<{
        created_at: string | Date;
      }>(
        `
              insert into public.delivery_events (
                tenant_id,
                branch_id,
                delivery_id,

                event_type,

                from_status,
                to_status,

                actor_type,
                actor_reference,

                payload
              )
              values (
                $1::uuid,
                $2::uuid,
                $3::uuid,

                'DRIVER_EN_ROUTE',

                'PICKED_UP',
                'EN_ROUTE',

                'DRIVER',
                $4,

                jsonb_build_object(
                  'driverId',
                  $5::text,

                  'driverCode',
                  $4::text,

                  'assignmentId',
                  $6::text,

                  'assignmentNumber',
                  $7::integer,

                  'orderId',
                  $8::text,

                  'orderNumber',
                  $9::text
                )
              )

              returning
                created_at
            `,
        [
          delivery.tenant_id,
          delivery.branch_id,
          delivery.id,

          safeDriverCode,
          driverId,

          assignment.id,
          assignment.assignment_number,

          delivery.order_id,
          delivery.order_number,
        ],
      );

      const enRouteEvent = eventResult.rows[0];

      if (!enRouteEvent) {
        throw new ConflictException('Delivery route event was not created');
      }

      return {
        changed: true,
        action: 'EN_ROUTE',

        delivery: {
          id: delivery.id,
          status: 'EN_ROUTE',

          enRouteAt: enRouteEvent.created_at,
        },

        order: {
          id: delivery.order_id,
          number: delivery.order_number,
          status: delivery.order_status,
        },

        assignment: {
          id: assignment.id,

          number: assignment.assignment_number,

          // Assignment intentionally remains ACCEPTED during
          // PICKED_UP / EN_ROUTE / ARRIVED.
          status: 'ACCEPTED',

          assignedAt: assignment.assigned_at,

          acceptedAt: assignment.accepted_at,

          driver: {
            id: driverId,
            code: safeDriverCode,
          },
        },
      };
    });
  }
  async arriveDriverDelivery(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    driverCode: string,
  ) {
    const deliveryId = requireUuid(deliveryIdInput, 'deliveryId');

    const tenantId = requireUuid(tenantIdInput, 'tenantId');

    const driverId = requireUuid(driverIdInput, 'driverId');

    const safeDriverCode = driverCode?.trim() || 'DRIVER';

    return this.databaseService.withTransaction(async (client) => {
      const deliveryResult = await client.query<{
        id: string;

        tenant_id: string;
        branch_id: string;

        order_id: string;
        order_number: string;

        delivery_status: string;

        order_status: string;
        payment_status: string;
      }>(
        `
              select
                d.id::text,

                d.tenant_id::text,
                d.branch_id::text,

                d.order_id::text,

                o.order_number::text,

                d.status
                  as delivery_status,

                o.status
                  as order_status,

                o.payment_status

              from public.deliveries d

              inner join public.orders o
                on o.tenant_id = d.tenant_id
               and o.branch_id = d.branch_id
               and o.id = d.order_id

              where d.tenant_id = $1::uuid
                and d.id = $2::uuid

              for update of d, o
            `,
        [tenantId, deliveryId],
      );

      const delivery = deliveryResult.rows[0];

      if (!delivery) {
        throw new NotFoundException('Delivery not found');
      }

      // ----------------------------------------------------
      // The bearer authenticates the driver globally.
      //
      // The driver must also still be ENABLED for the branch
      // that owns this delivery.
      //
      // The branch mapping remains locked FOR SHARE until the
      // transaction completes.
      // ----------------------------------------------------

      const branchAuthorizationResult = await client.query<{
        id: string;
      }>(
        `
              select
                db.id::text

              from public.delivery_driver_branches db

              where db.tenant_id = $1::uuid
                and db.branch_id = $2::uuid
                and db.driver_id = $3::uuid
                and db.status = 'ENABLED'

              limit 1

              for share of db
            `,
        [delivery.tenant_id, delivery.branch_id, driverId],
      );

      if (!branchAuthorizationResult.rows[0]) {
        throw new ConflictException(
          'Driver is not enabled for delivery branch',
        );
      }

      if (
        delivery.delivery_status !== 'EN_ROUTE' &&
        delivery.delivery_status !== 'ARRIVED'
      ) {
        throw new ConflictException(
          `Delivery cannot arrive from ${delivery.delivery_status}`,
        );
      }

      const assignmentResult = await client.query<{
        id: string;

        assignment_number: number;

        driver_id: string;

        status: string;

        assigned_at: string | Date;
        accepted_at: string | Date | null;
      }>(
        `
              select
                a.id::text,

                a.assignment_number,

                a.driver_id::text,

                a.status,

                a.assigned_at,
                a.accepted_at

              from public.delivery_assignments a

              where a.tenant_id = $1::uuid
                and a.branch_id = $2::uuid
                and a.delivery_id = $3::uuid

                and a.status in (
                  'ASSIGNED',
                  'ACCEPTED'
                )

              order by
                a.assignment_number desc

              limit 1

              for update of a
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      const assignment = assignmentResult.rows[0];

      if (!assignment) {
        throw new ConflictException(
          'Delivery assignment state is inconsistent',
        );
      }

      if (assignment.driver_id !== driverId) {
        throw new ConflictException('Delivery is assigned to another driver');
      }

      // ----------------------------------------------------
      // Same-driver retry is idempotent.
      // ----------------------------------------------------

      if (
        delivery.delivery_status === 'ARRIVED' &&
        assignment.status === 'ACCEPTED'
      ) {
        return {
          changed: false,
          action: 'UNCHANGED',

          delivery: {
            id: delivery.id,
            status: 'ARRIVED',
          },

          order: {
            id: delivery.order_id,
            number: delivery.order_number,
            status: delivery.order_status,
          },

          assignment: {
            id: assignment.id,

            number: assignment.assignment_number,

            status: 'ACCEPTED',

            assignedAt: assignment.assigned_at,

            acceptedAt: assignment.accepted_at,

            driver: {
              id: driverId,
              code: safeDriverCode,
            },
          },
        };
      }

      if (
        delivery.delivery_status !== 'EN_ROUTE' ||
        assignment.status !== 'ACCEPTED' ||
        !assignment.accepted_at
      ) {
        throw new ConflictException('Delivery arrival state is inconsistent');
      }

      // ----------------------------------------------------
      // ARRIVED does not complete the order.
      //
      // The order remains READY until proof-of-delivery /
      // final DELIVERED confirmation is implemented.
      // ----------------------------------------------------

      if (delivery.order_status !== 'READY') {
        throw new ConflictException(
          `Delivery cannot arrive while order is ${delivery.order_status}`,
        );
      }

      await assertDeliveryQrPaid(client, delivery);

      const deliveryUpdate = await client.query<{
        id: string;
        updated_at: string | Date;
      }>(
        `
              update public.deliveries

              set
                status = 'ARRIVED',
                updated_at = now()

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid

                and status = 'EN_ROUTE'

              returning
                id::text,
                updated_at
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      const arrivedDelivery = deliveryUpdate.rows[0];

      if (!arrivedDelivery) {
        throw new ConflictException('Delivery status changed concurrently');
      }

      // ----------------------------------------------------
      // POD challenge becomes available only after ARRIVED.
      //
      // The raw four-digit POD is NOT stored here.
      // PostgreSQL stores only challenge state / attempts.
      //
      // If a concurrent request already inserted the
      // challenge, validate the existing row instead of
      // creating a duplicate.
      // ----------------------------------------------------

      const podChallengeInsert = await client.query<{
        status: string;
      }>(
        `
              insert into public.delivery_pod_challenges (
                tenant_id,
                branch_id,
                delivery_id
              )
              values (
                $1::uuid,
                $2::uuid,
                $3::uuid
              )

              on conflict (delivery_id)
              do nothing

              returning
                status
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      let podChallengeStatus = podChallengeInsert.rows[0]?.status;

      if (!podChallengeStatus) {
        const existingPodChallenge = await client.query<{
          status: string;
        }>(
          `
                select
                  p.status

                from public.delivery_pod_challenges p

                where p.tenant_id = $1::uuid
                  and p.branch_id = $2::uuid
                  and p.delivery_id = $3::uuid

                limit 1

                for update of p
              `,
          [delivery.tenant_id, delivery.branch_id, delivery.id],
        );

        podChallengeStatus = existingPodChallenge.rows[0]?.status;
      }

      if (podChallengeStatus !== 'ACTIVE') {
        throw new ConflictException(
          'Delivery POD challenge state is inconsistent',
        );
      }

      const eventResult = await client.query<{
        created_at: string | Date;
      }>(
        `
              insert into public.delivery_events (
                tenant_id,
                branch_id,
                delivery_id,

                event_type,

                from_status,
                to_status,

                actor_type,
                actor_reference,

                payload
              )
              values (
                $1::uuid,
                $2::uuid,
                $3::uuid,

                'DRIVER_ARRIVED',

                'EN_ROUTE',
                'ARRIVED',

                'DRIVER',
                $4,

                jsonb_build_object(
                  'driverId',
                  $5::text,

                  'driverCode',
                  $4::text,

                  'assignmentId',
                  $6::text,

                  'assignmentNumber',
                  $7::integer,

                  'orderId',
                  $8::text,

                  'orderNumber',
                  $9::text
                )
              )

              returning
                created_at
            `,
        [
          delivery.tenant_id,
          delivery.branch_id,
          delivery.id,

          safeDriverCode,
          driverId,

          assignment.id,
          assignment.assignment_number,

          delivery.order_id,
          delivery.order_number,
        ],
      );

      const arrivedEvent = eventResult.rows[0];

      if (!arrivedEvent) {
        throw new ConflictException('Delivery arrival event was not created');
      }

      return {
        changed: true,
        action: 'ARRIVED',

        delivery: {
          id: delivery.id,
          status: 'ARRIVED',

          arrivedAt: arrivedEvent.created_at,
        },

        order: {
          id: delivery.order_id,
          number: delivery.order_number,

          // Order remains READY until DELIVERED.
          status: delivery.order_status,
        },

        assignment: {
          id: assignment.id,

          number: assignment.assignment_number,

          // Assignment intentionally remains ACCEPTED during
          // PICKED_UP / EN_ROUTE / ARRIVED.
          status: 'ACCEPTED',

          assignedAt: assignment.assigned_at,

          acceptedAt: assignment.accepted_at,

          driver: {
            id: driverId,
            code: safeDriverCode,
          },
        },
      };
    });
  }
  async recordDriverLocation(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    locationInput:
      | {
          latitude?: unknown;
          longitude?: unknown;

          accuracyMeters?: unknown;
          headingDegrees?: unknown;
          speedMps?: unknown;

          capturedAt?: unknown;
        }
      | undefined,
  ) {
    const deliveryId = requireUuid(deliveryIdInput, 'deliveryId');

    const tenantId = requireUuid(tenantIdInput, 'tenantId');

    const driverId = requireUuid(driverIdInput, 'driverId');

    if (
      !locationInput ||
      typeof locationInput !== 'object' ||
      Array.isArray(locationInput)
    ) {
      throw new BadRequestException('location body is required');
    }

    const requireFiniteNumber = (value: unknown, field: string): number => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new BadRequestException(`${field} must be a finite number`);
      }

      return value;
    };

    const optionalFiniteNumber = (
      value: unknown,
      field: string,
    ): number | null => {
      if (value === undefined || value === null) {
        return null;
      }

      return requireFiniteNumber(value, field);
    };

    const latitude = requireFiniteNumber(locationInput.latitude, 'latitude');

    const longitude = requireFiniteNumber(locationInput.longitude, 'longitude');

    if (latitude < -90 || latitude > 90) {
      throw new BadRequestException('latitude must be between -90 and 90');
    }

    if (longitude < -180 || longitude > 180) {
      throw new BadRequestException('longitude must be between -180 and 180');
    }

    const accuracyMeters = optionalFiniteNumber(
      locationInput.accuracyMeters,
      'accuracyMeters',
    );

    if (
      accuracyMeters !== null &&
      (accuracyMeters < 0 || accuracyMeters > 999999.99)
    ) {
      throw new BadRequestException(
        'accuracyMeters is outside the supported range',
      );
    }

    const headingDegrees = optionalFiniteNumber(
      locationInput.headingDegrees,
      'headingDegrees',
    );

    if (
      headingDegrees !== null &&
      (headingDegrees < 0 || headingDegrees >= 360)
    ) {
      throw new BadRequestException(
        'headingDegrees must be between 0 and less than 360',
      );
    }

    const speedMps = optionalFiniteNumber(locationInput.speedMps, 'speedMps');

    if (speedMps !== null && (speedMps < 0 || speedMps > 99999.999)) {
      throw new BadRequestException('speedMps is outside the supported range');
    }

    const serverNowMs = Date.now();

    let capturedAt = new Date(serverNowMs).toISOString();

    if (
      locationInput.capturedAt !== undefined &&
      locationInput.capturedAt !== null
    ) {
      if (
        typeof locationInput.capturedAt !== 'string' ||
        !locationInput.capturedAt.trim()
      ) {
        throw new BadRequestException('capturedAt must be a valid timestamp');
      }

      const parsedCapturedAt = new Date(locationInput.capturedAt);

      const parsedCapturedAtMs = parsedCapturedAt.getTime();

      if (!Number.isFinite(parsedCapturedAtMs)) {
        throw new BadRequestException('capturedAt must be a valid timestamp');
      }

      const maxFutureCapturedAtMs = serverNowMs + 5 * 60 * 1000;

      if (parsedCapturedAtMs > maxFutureCapturedAtMs) {
        throw new BadRequestException(
          'capturedAt must not be more than 5 minutes in the future',
        );
      }

      const minCapturedAtMs = serverNowMs - 24 * 60 * 60 * 1000;

      if (parsedCapturedAtMs < minCapturedAtMs) {
        throw new BadRequestException(
          'capturedAt must not be older than 24 hours',
        );
      }

      capturedAt = parsedCapturedAt.toISOString();
    }

    return this.databaseService.withTransaction(async (client) => {
      // ----------------------------------------------------
      // Lock order intentionally follows existing driver
      // mutations:
      //
      // 1. delivery
      // 2. driver-branch authorization
      // 3. active assignment
      //
      // GPS does not mutate delivery/assignment state, so
      // SHARE locks are sufficient while authorization and
      // the append-only insert occur atomically.
      // ----------------------------------------------------

      const deliveryResult = await client.query<{
        id: string;
        tenant_id: string;
        branch_id: string;
        status: string;
      }>(
        `
              select
                d.id::text,
                d.tenant_id::text,
                d.branch_id::text,
                d.status

              from public.deliveries d

              where d.tenant_id = $1::uuid
                and d.id = $2::uuid

              for share of d
            `,
        [tenantId, deliveryId],
      );

      const delivery = deliveryResult.rows[0];

      if (!delivery) {
        throw new NotFoundException('Delivery not found');
      }

      const branchAuthorizationResult = await client.query<{
        id: string;
      }>(
        `
              select
                db.id::text

              from public.delivery_driver_branches db

              where db.tenant_id = $1::uuid
                and db.branch_id = $2::uuid
                and db.driver_id = $3::uuid
                and db.status = 'ENABLED'

              limit 1

              for share of db
            `,
        [delivery.tenant_id, delivery.branch_id, driverId],
      );

      if (!branchAuthorizationResult.rows[0]) {
        throw new ConflictException(
          'Driver is not enabled for delivery branch',
        );
      }

      if (!['ACCEPTED', 'PICKED_UP', 'EN_ROUTE'].includes(delivery.status)) {
        throw new ConflictException(
          `Delivery location cannot be recorded from ${delivery.status}`,
        );
      }

      const assignmentResult = await client.query<{
        id: string;
        assignment_number: number;
        driver_id: string;
        status: string;
      }>(
        `
              select
                a.id::text,
                a.assignment_number,
                a.driver_id::text,
                a.status

              from public.delivery_assignments a

              where a.tenant_id = $1::uuid
                and a.branch_id = $2::uuid
                and a.delivery_id = $3::uuid

                and a.status in (
                  'ASSIGNED',
                  'ACCEPTED'
                )

              order by
                a.assignment_number desc

              limit 1

              for share of a
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      const assignment = assignmentResult.rows[0];

      if (!assignment) {
        throw new ConflictException(
          'Delivery assignment state is inconsistent',
        );
      }

      if (assignment.driver_id !== driverId) {
        throw new ConflictException('Delivery is assigned to another driver');
      }

      if (assignment.status !== 'ACCEPTED') {
        throw new ConflictException(
          'Delivery location requires accepted assignment',
        );
      }

      const locationResult = await client.query<{
        id: string;

        latitude: number;
        longitude: number;

        accuracy_meters: string | null;
        heading_degrees: string | null;
        speed_mps: string | null;

        captured_at: string | Date;
        received_at: string | Date;
      }>(
        `
              insert into public.delivery_driver_locations (
                tenant_id,
                branch_id,

                delivery_id,
                driver_id,

                position,

                accuracy_meters,
                heading_degrees,
                speed_mps,

                captured_at
              )
              values (
                $1::uuid,
                $2::uuid,

                $3::uuid,
                $4::uuid,

                gis.ST_SetSRID(
                  gis.ST_MakePoint(
                    $5::double precision,
                    $6::double precision
                  ),
                  4326
                )::gis.geography,

                $7::numeric,
                $8::numeric,
                $9::numeric,

                $10::timestamptz
              )
              returning
                id::text,

                gis.ST_Y(
                  position::gis.geometry
                )::double precision
                  as latitude,

                gis.ST_X(
                  position::gis.geometry
                )::double precision
                  as longitude,

                accuracy_meters::text,
                heading_degrees::text,
                speed_mps::text,

                captured_at,
                received_at
            `,
        [
          delivery.tenant_id,
          delivery.branch_id,

          delivery.id,
          driverId,

          longitude,
          latitude,

          accuracyMeters,
          headingDegrees,
          speedMps,

          capturedAt,
        ],
      );

      const location = locationResult.rows[0];

      return {
        recorded: true,

        delivery: {
          id: delivery.id,
          status: delivery.status,
        },

        assignment: {
          id: assignment.id,
          number: assignment.assignment_number,
          status: assignment.status,

          driver: {
            id: driverId,
          },
        },

        location: {
          id: location.id,

          latitude: location.latitude,

          longitude: location.longitude,

          accuracyMeters:
            location.accuracy_meters === null
              ? null
              : Number(location.accuracy_meters),

          headingDegrees:
            location.heading_degrees === null
              ? null
              : Number(location.heading_degrees),

          speedMps:
            location.speed_mps === null ? null : Number(location.speed_mps),

          capturedAt: location.captured_at,

          receivedAt: location.received_at,
        },
      };
    });
  }
  async collectDriverCodCash(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    driverCode: string,
    cashReceivedAmount: unknown,
    idempotencyKey: string | undefined,
  ) {
    const deliveryId = requireUuid(deliveryIdInput, 'deliveryId');

    const tenantId = requireUuid(tenantIdInput, 'tenantId');

    const driverId = requireUuid(driverIdInput, 'driverId');

    const safeDriverCode = driverCode?.trim() || 'DRIVER';

    return this.databaseService.withTransaction(async (client) => {
      const deliveryResult = await client.query<{
        id: string;
        tenant_id: string;
        branch_id: string;
        order_id: string;
        order_number: string;
        delivery_status: string;
        order_status: string;
        payment_status: string;
      }>(
        `
              select
                d.id::text,
                d.tenant_id::text,
                d.branch_id::text,
                d.order_id::text,
                o.order_number::text,
                d.status as delivery_status,
                o.status as order_status,
                o.payment_status

              from public.deliveries d

              inner join public.orders o
                on o.tenant_id = d.tenant_id
               and o.branch_id = d.branch_id
               and o.id = d.order_id

              where d.tenant_id = $1::uuid
                and d.id = $2::uuid

              for update of d, o
            `,
        [tenantId, deliveryId],
      );

      const delivery = deliveryResult.rows[0];

      if (!delivery) {
        throw new NotFoundException('Delivery not found');
      }

      const branchAuthorizationResult = await client.query<{
        id: string;
      }>(
        `
              select
                db.id::text

              from public.delivery_driver_branches db

              where db.tenant_id = $1::uuid
                and db.branch_id = $2::uuid
                and db.driver_id = $3::uuid
                and db.status = 'ENABLED'

              limit 1

              for share of db
            `,
        [delivery.tenant_id, delivery.branch_id, driverId],
      );

      if (!branchAuthorizationResult.rows[0]) {
        throw new ConflictException(
          'Driver is not enabled for delivery branch',
        );
      }

      if (
        delivery.delivery_status !== 'ARRIVED' &&
        delivery.delivery_status !== 'DELIVERED'
      ) {
        throw new ConflictException(
          `Cash collection is unavailable from ${delivery.delivery_status}`,
        );
      }

      const assignmentResult = await client.query<{
        id: string;
        assignment_number: number;
        driver_id: string;
        status: string;
        assigned_at: string | Date;
        accepted_at: string | Date | null;
        completed_at: string | Date | null;
      }>(
        `
              select
                a.id::text,
                a.assignment_number,
                a.driver_id::text,
                a.status,
                a.assigned_at,
                a.accepted_at,
                a.completed_at

              from public.delivery_assignments a

              where a.tenant_id = $1::uuid
                and a.branch_id = $2::uuid
                and a.delivery_id = $3::uuid
                and a.status in (
                  'ACCEPTED',
                  'COMPLETED'
                )

              order by
                a.assignment_number desc

              limit 1

              for update of a
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      const assignment = assignmentResult.rows[0];

      if (!assignment) {
        throw new ConflictException(
          'Delivery assignment state is inconsistent',
        );
      }

      if (assignment.driver_id !== driverId) {
        throw new ConflictException('Delivery is assigned to another driver');
      }

      if (!assignment.accepted_at) {
        throw new ConflictException(
          'Delivery assignment state is inconsistent',
        );
      }

      if (delivery.delivery_status === 'ARRIVED') {
        if (
          delivery.order_status !== 'READY' ||
          assignment.status !== 'ACCEPTED' ||
          assignment.completed_at
        ) {
          throw new ConflictException(
            'Arrived cash collection state is inconsistent',
          );
        }
      } else {
        if (
          delivery.order_status !== 'COMPLETED' ||
          assignment.status !== 'COMPLETED' ||
          !assignment.completed_at ||
          delivery.payment_status !== 'PAID'
        ) {
          throw new ConflictException(
            'Delivered cash collection replay state is inconsistent',
          );
        }
      }

      if (
        delivery.payment_status !== 'AWAITING_CONFIRMATION' &&
        delivery.payment_status !== 'PAID'
      ) {
        throw new ConflictException(
          'Delivery does not have a collectible cash-on-delivery payment',
        );
      }

      const collection = await this.paymentsService.collectDriverCodCash(
        client,
        {
          tenantId: delivery.tenant_id,

          branchId: delivery.branch_id,

          orderId: delivery.order_id,

          deliveryId: delivery.id,

          assignmentId: assignment.id,

          driverId,

          cashReceivedAmount,

          idempotencyKey,
        },
      );

      return {
        changed: collection.changed,

        action: collection.changed ? 'CASH_COLLECTED' : 'UNCHANGED',

        delivery: {
          id: delivery.id,

          status: delivery.delivery_status,
        },

        order: {
          id: delivery.order_id,

          number: delivery.order_number,

          status: delivery.order_status,

          paymentStatus: 'PAID',
        },

        assignment: {
          id: assignment.id,

          number: assignment.assignment_number,

          status: assignment.status,

          assignedAt: assignment.assigned_at,

          acceptedAt: assignment.accepted_at,

          completedAt: assignment.completed_at,

          driver: {
            id: driverId,

            code: safeDriverCode,
          },
        },

        payment: collection.payment,

        collection: collection.collection,
      };
    });
  }
  async deliverDriverDelivery(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    driverCode: string,
    podInput: unknown,
  ) {
    const deliveryId = requireUuid(deliveryIdInput, 'deliveryId');

    const tenantId = requireUuid(tenantIdInput, 'tenantId');

    const driverId = requireUuid(driverIdInput, 'driverId');

    // ------------------------------------------------------
    // Malformed POD input is rejected before the transaction.
    //
    // Only a string containing exactly four decimal digits
    // is an online verification attempt.
    //
    // Therefore malformed input never consumes an attempt.
    // ------------------------------------------------------

    if (typeof podInput !== 'string' || !/^[0-9]{4}$/.test(podInput)) {
      throw new BadRequestException('pod must be exactly four digits');
    }

    const submittedPod = podInput;

    const safeDriverCode = driverCode?.trim() || 'DRIVER';

    // ------------------------------------------------------
    // IMPORTANT:
    //
    // Wrong but syntactically valid POD attempts must COMMIT
    // their failed_attempts update.
    //
    // Therefore INVALID_POD / LOCKED are returned from the
    // transaction as structured outcomes. HTTP exceptions are
    // thrown only AFTER withTransaction has committed.
    // ------------------------------------------------------

    const outcome = await this.databaseService.withTransaction(
      async (client) => {
        const deliveryResult = await client.query<{
          id: string;

          tenant_id: string;
          branch_id: string;

          order_id: string;
          order_number: string;

          delivery_tracking_token: string;

          delivery_status: string;

          order_status: string;
          payment_status: string;
        }>(
          `
                select
                  d.id::text,

                  d.tenant_id::text,
                  d.branch_id::text,

                  d.order_id::text,

                  o.order_number::text,

                  d.tracking_token::text
                    as delivery_tracking_token,

                  d.status
                    as delivery_status,

                  o.status
                    as order_status,

                  o.payment_status

                from public.deliveries d

                inner join public.orders o
                  on o.tenant_id = d.tenant_id
                 and o.branch_id = d.branch_id
                 and o.id = d.order_id

                where d.tenant_id = $1::uuid
                  and d.id = $2::uuid

                for update of d, o
              `,
          [tenantId, deliveryId],
        );

        const delivery = deliveryResult.rows[0];

        if (!delivery) {
          throw new NotFoundException('Delivery not found');
        }

        // --------------------------------------------------
        // Driver must still be ENABLED for the branch.
        // This is intentionally checked on every mutation,
        // including an idempotent delivered retry.
        // --------------------------------------------------

        const branchAuthorizationResult = await client.query<{
          id: string;
        }>(
          `
                select
                  db.id::text

                from public.delivery_driver_branches db

                where db.tenant_id = $1::uuid
                  and db.branch_id = $2::uuid
                  and db.driver_id = $3::uuid
                  and db.status = 'ENABLED'

                limit 1

                for share of db
              `,
          [delivery.tenant_id, delivery.branch_id, driverId],
        );

        if (!branchAuthorizationResult.rows[0]) {
          throw new ConflictException(
            'Driver is not enabled for delivery branch',
          );
        }

        if (
          delivery.delivery_status !== 'ARRIVED' &&
          delivery.delivery_status !== 'DELIVERED'
        ) {
          throw new ConflictException(
            'Delivery cannot be delivered from ' + delivery.delivery_status,
          );
        }

        const assignmentResult = await client.query<{
          id: string;

          assignment_number: number;

          driver_id: string;

          status: string;

          assigned_at: string | Date;
          accepted_at: string | Date | null;
          completed_at: string | Date | null;
        }>(
          `
                select
                  a.id::text,

                  a.assignment_number,

                  a.driver_id::text,

                  a.status,

                  a.assigned_at,
                  a.accepted_at,
                  a.completed_at

                from public.delivery_assignments a

                where a.tenant_id = $1::uuid
                  and a.branch_id = $2::uuid
                  and a.delivery_id = $3::uuid

                  and a.status in (
                    'ACCEPTED',
                    'COMPLETED'
                  )

                order by
                  a.assignment_number desc

                limit 1

                for update of a
              `,
          [delivery.tenant_id, delivery.branch_id, delivery.id],
        );

        const assignment = assignmentResult.rows[0];

        if (!assignment) {
          throw new ConflictException(
            'Delivery assignment state is inconsistent',
          );
        }

        if (assignment.driver_id !== driverId) {
          throw new ConflictException('Delivery is assigned to another driver');
        }

        const challengeResult = await client.query<{
          id: string;

          status: string;

          failed_attempts: number;

          locked_at: string | Date | null;

          verified_at: string | Date | null;

          verified_by_driver_id: string | null;
        }>(
          `
                select
                  p.id::text,

                  p.status,

                  p.failed_attempts,

                  p.locked_at,
                  p.verified_at,

                  p.verified_by_driver_id::text

                from public.delivery_pod_challenges p

                where p.tenant_id = $1::uuid
                  and p.branch_id = $2::uuid
                  and p.delivery_id = $3::uuid

                limit 1

                for update of p
              `,
          [delivery.tenant_id, delivery.branch_id, delivery.id],
        );

        const challenge = challengeResult.rows[0];

        if (!challenge) {
          throw new ConflictException(
            'Delivery POD challenge is not available',
          );
        }

        await assertDeliveryQrPaid(client, delivery);

        // --------------------------------------------------
        // Same authenticated owner may retry an already
        // completed delivery idempotently.
        //
        // The POD is NOT revalidated because VERIFIED is
        // terminal and the assignment owner is already known.
        // --------------------------------------------------

        if (delivery.delivery_status === 'DELIVERED') {
          if (
            delivery.order_status !== 'COMPLETED' ||
            assignment.status !== 'COMPLETED' ||
            !assignment.completed_at ||
            challenge.status !== 'VERIFIED' ||
            !challenge.verified_at ||
            challenge.verified_by_driver_id !== driverId
          ) {
            throw new ConflictException('Delivered state is inconsistent');
          }

          return {
            kind: 'SUCCESS' as const,

            response: {
              changed: false,
              action: 'UNCHANGED',

              delivery: {
                id: delivery.id,
                status: 'DELIVERED',
              },

              order: {
                id: delivery.order_id,
                number: delivery.order_number,

                status: 'COMPLETED',
              },

              assignment: {
                id: assignment.id,

                number: assignment.assignment_number,

                status: 'COMPLETED',

                assignedAt: assignment.assigned_at,

                acceptedAt: assignment.accepted_at,

                completedAt: assignment.completed_at,

                driver: {
                  id: driverId,
                  code: safeDriverCode,
                },
              },

              pod: {
                status: 'VERIFIED',

                verifiedAt: challenge.verified_at,
              },
            },
          };
        }

        if (delivery.order_status !== 'READY') {
          throw new ConflictException(
            'Delivery cannot be completed while order is ' +
              delivery.order_status,
          );
        }

        if (
          assignment.status !== 'ACCEPTED' ||
          !assignment.accepted_at ||
          assignment.completed_at
        ) {
          throw new ConflictException(
            'Delivery assignment state is inconsistent',
          );
        }

        // --------------------------------------------------
        // LOCKED is terminal.
        // Return rather than throw inside the transaction.
        // --------------------------------------------------

        if (challenge.status === 'LOCKED') {
          return {
            kind: 'LOCKED' as const,

            failedAttempts: challenge.failed_attempts,
          };
        }

        if (challenge.status !== 'ACTIVE') {
          throw new ConflictException(
            'Delivery POD challenge state is inconsistent',
          );
        }

        const podMatches = verifyDeliveryPod(
          {
            tenantId: delivery.tenant_id,

            branchId: delivery.branch_id,

            deliveryId: delivery.id,

            deliveryTrackingToken: delivery.delivery_tracking_token,
          },
          submittedPod,
        );

        // --------------------------------------------------
        // WRONG POD
        //
        // Commit failed_attempts before returning HTTP error.
        // The fifth failed attempt becomes terminal LOCKED.
        // --------------------------------------------------

        if (!podMatches) {
          const nextFailedAttempts = challenge.failed_attempts + 1;

          if (nextFailedAttempts < 1 || nextFailedAttempts > 5) {
            throw new ConflictException(
              'Delivery POD attempt state is inconsistent',
            );
          }

          const attemptUpdate = await client.query<{
            status: string;

            failed_attempts: number;

            locked_at: string | Date | null;
          }>(
            `
                  update public.delivery_pod_challenges

                  set
                    failed_attempts =
                      $4::integer,

                    status =
                      case
                        when $4::integer = 5
                          then 'LOCKED'
                        else 'ACTIVE'
                      end,

                    locked_at =
                      case
                        when $4::integer = 5
                          then now()
                        else null
                      end,

                    updated_at = now()

                  where tenant_id = $1::uuid
                    and branch_id = $2::uuid
                    and delivery_id = $3::uuid

                    and status = 'ACTIVE'

                  returning
                    status,
                    failed_attempts,
                    locked_at
                `,
            [
              delivery.tenant_id,
              delivery.branch_id,
              delivery.id,

              nextFailedAttempts,
            ],
          );

          const updatedAttempt = attemptUpdate.rows[0];

          if (!updatedAttempt) {
            throw new ConflictException(
              'Delivery POD challenge changed concurrently',
            );
          }

          return {
            kind: 'INVALID_POD' as const,

            failedAttempts: updatedAttempt.failed_attempts,

            locked: updatedAttempt.status === 'LOCKED',
          };
        }

        // --------------------------------------------------
        // CORRECT POD
        //
        // Everything below must commit or roll back together:
        //
        // challenge -> VERIFIED
        // delivery  -> DELIVERED
        // assignment -> COMPLETED
        // order -> COMPLETED
        // DRIVER_DELIVERED event
        //
        // order_status_history is generated by DB trigger.
        // --------------------------------------------------

        const challengeUpdate = await client.query<{
          verified_at: string | Date;
        }>(
          `
                update public.delivery_pod_challenges

                set
                  status = 'VERIFIED',

                  verified_at = now(),

                  verified_by_driver_id =
                    $4::uuid,

                  updated_at = now()

                where tenant_id = $1::uuid
                  and branch_id = $2::uuid
                  and delivery_id = $3::uuid

                  and status = 'ACTIVE'

                returning
                  verified_at
              `,
          [delivery.tenant_id, delivery.branch_id, delivery.id, driverId],
        );

        const verifiedChallenge = challengeUpdate.rows[0];

        if (!verifiedChallenge) {
          throw new ConflictException(
            'Delivery POD challenge changed concurrently',
          );
        }

        const deliveryUpdate = await client.query<{
          id: string;
        }>(
          `
                update public.deliveries

                set
                  status = 'DELIVERED',
                  updated_at = now()

                where tenant_id = $1::uuid
                  and branch_id = $2::uuid
                  and id = $3::uuid

                  and status = 'ARRIVED'

                returning
                  id::text
              `,
          [delivery.tenant_id, delivery.branch_id, delivery.id],
        );

        if (!deliveryUpdate.rows[0]) {
          throw new ConflictException('Delivery status changed concurrently');
        }

        const assignmentUpdate = await client.query<{
          completed_at: string | Date;
        }>(
          `
                update public.delivery_assignments

                set
                  status = 'COMPLETED',

                  completed_at = now(),

                  updated_at = now()

                where tenant_id = $1::uuid
                  and branch_id = $2::uuid
                  and id = $3::uuid

                  and driver_id = $4::uuid
                  and status = 'ACCEPTED'

                returning
                  completed_at
              `,
          [delivery.tenant_id, delivery.branch_id, assignment.id, driverId],
        );

        const completedAssignment = assignmentUpdate.rows[0];

        if (!completedAssignment) {
          throw new ConflictException(
            'Delivery assignment changed concurrently',
          );
        }

        const orderUpdate = await client.query<{
          status: string;
        }>(
          `
                update public.orders

                set
                  status = 'COMPLETED',
                  updated_at = now()

                where tenant_id = $1::uuid
                  and branch_id = $2::uuid
                  and id = $3::uuid

                  and status = 'READY'

                returning
                  status
              `,
          [delivery.tenant_id, delivery.branch_id, delivery.order_id],
        );

        if (!orderUpdate.rows[0]) {
          throw new ConflictException('Order status changed concurrently');
        }

        const eventResult = await client.query<{
          created_at: string | Date;
        }>(
          `
                insert into public.delivery_events (
                  tenant_id,
                  branch_id,
                  delivery_id,

                  event_type,

                  from_status,
                  to_status,

                  actor_type,
                  actor_reference,

                  payload
                )
                values (
                  $1::uuid,
                  $2::uuid,
                  $3::uuid,

                  'DRIVER_DELIVERED',

                  'ARRIVED',
                  'DELIVERED',

                  'DRIVER',
                  $4,

                  jsonb_build_object(
                    'driverId',
                    $5::text,

                    'driverCode',
                    $4::text,

                    'assignmentId',
                    $6::text,

                    'assignmentNumber',
                    $7::integer,

                    'orderId',
                    $8::text,

                    'orderNumber',
                    $9::text
                  )
                )

                returning
                  created_at
              `,
          [
            delivery.tenant_id,
            delivery.branch_id,
            delivery.id,

            safeDriverCode,
            driverId,

            assignment.id,
            assignment.assignment_number,

            delivery.order_id,
            delivery.order_number,
          ],
        );

        const deliveredEvent = eventResult.rows[0];

        if (!deliveredEvent) {
          throw new ConflictException(
            'Delivery completion event was not created',
          );
        }

        return {
          kind: 'SUCCESS' as const,

          response: {
            changed: true,
            action: 'DELIVERED',

            delivery: {
              id: delivery.id,
              status: 'DELIVERED',

              deliveredAt: deliveredEvent.created_at,
            },

            order: {
              id: delivery.order_id,
              number: delivery.order_number,

              status: 'COMPLETED',
            },

            assignment: {
              id: assignment.id,

              number: assignment.assignment_number,

              status: 'COMPLETED',

              assignedAt: assignment.assigned_at,

              acceptedAt: assignment.accepted_at,

              completedAt: completedAssignment.completed_at,

              driver: {
                id: driverId,
                code: safeDriverCode,
              },
            },

            pod: {
              status: 'VERIFIED',

              verifiedAt: verifiedChallenge.verified_at,
            },
          },
        };
      },
    );

    // ------------------------------------------------------
    // These exceptions are intentionally OUTSIDE the DB
    // transaction so failed attempt updates are committed.
    // ------------------------------------------------------

    if (outcome.kind === 'LOCKED') {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,

          message: 'Delivery POD challenge is locked',

          failedAttempts: outcome.failedAttempts,

          attemptsRemaining: 0,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (outcome.kind === 'INVALID_POD') {
      if (outcome.locked) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,

            message: 'Delivery POD challenge is locked',

            failedAttempts: outcome.failedAttempts,

            attemptsRemaining: 0,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new ConflictException({
        message: 'Invalid delivery POD',

        failedAttempts: outcome.failedAttempts,

        attemptsRemaining: 5 - outcome.failedAttempts,
      });
    }

    return outcome.response;
  }
}
