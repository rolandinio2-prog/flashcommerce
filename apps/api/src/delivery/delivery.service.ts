import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';
import { GEO_PROVIDER, type GeoProvider } from './geo-provider';
import type { GeoPoint, GeoRouteResult } from './geo.types';
import {
  deriveDeliveryPod,
  verifyDeliveryPod,
} from './delivery-pod';
import type {
  CreatedDelivery,
  DeliveryCheckoutQuote,
  DeliveryCheckoutRouteSnapshot,
  DeliveryQuoteInput,
  DeliveryQuoteResponse,
} from './delivery.types';

interface DeliveryBranchRow {
  tenant_id: string;
  branch_id: string;
  branch_code: string;
  branch_name: string;
  delivery_enabled: boolean;
  delivery_origin_latitude: string | null;
  delivery_origin_longitude: string | null;
  delivery_default_prep_minutes: number;
}

interface DeliveryZoneRow {
  id: string;
  code: string;
  name: string;
  delivery_fee: string;
  minimum_order: string;
  eta_min_minutes: number;
  eta_max_minutes: number;
}

@Injectable()
export class DeliveryService {
  constructor(
    private readonly databaseService: DatabaseService,

    @Inject(GEO_PROVIDER)
    private readonly geoProvider: GeoProvider,
  ) {}

  async quoteDelivery(
    input: DeliveryQuoteInput,
  ): Promise<DeliveryQuoteResponse> {
    const tenantCode = this.requireCode(input.tenantCode, 'tenantCode');

    const branchCode = this.requireCode(input.branchCode, 'branchCode');

    const latitude = this.requireCoordinate(
      input.latitude,
      'latitude',
      -90,
      90,
    );

    const longitude = this.requireCoordinate(
      input.longitude,
      'longitude',
      -180,
      180,
    );

    const subtotal = this.requireSubtotal(input.subtotal);

    const branchResult = await this.databaseService.query<DeliveryBranchRow>(
      `
          select
            t.id::text as tenant_id,
            b.id::text as branch_id,
            b.code as branch_code,
            b.name as branch_name,
            b.delivery_enabled,
            b.delivery_origin_latitude::text,
            b.delivery_origin_longitude::text,
            b.delivery_default_prep_minutes
          from public.tenants t
          inner join public.branches b
            on b.tenant_id = t.id
          where t.code = $1
            and b.code = $2
            and t.status = 'ACTIVE'
            and b.status = 'ACTIVE'
          limit 1
        `,
      [tenantCode, branchCode],
    );

    const branch = branchResult.rows[0];

    if (!branch) {
      throw new NotFoundException(
        `Tenant or branch not found: ${tenantCode}/${branchCode}`,
      );
    }

    if (!branch.delivery_enabled) {
      return this.buildUnavailableResponse(branch, 'DELIVERY_DISABLED');
    }

    const zoneResult = await this.databaseService.query<DeliveryZoneRow>(
      `
          select
            z.id::text,
            z.code,
            z.name,
            z.delivery_fee::text,
            z.minimum_order::text,
            z.eta_min_minutes,
            z.eta_max_minutes
          from public.delivery_zones z
          where z.tenant_id = $1::uuid
            and z.branch_id = $2::uuid
            and z.status = 'ACTIVE'
            and gis.ST_Covers(
              z.area,
              gis.ST_SetSRID(
                gis.ST_MakePoint(
                  $3::double precision,
                  $4::double precision
                ),
                4326
              )
            )
          order by
            z.priority asc,
            z.code asc,
            z.id asc
          limit 1
        `,
      [branch.tenant_id, branch.branch_id, longitude, latitude],
    );

    const zone = zoneResult.rows[0];

    if (!zone) {
      return this.buildUnavailableResponse(branch, 'OUTSIDE_DELIVERY_AREA');
    }

    const deliveryFee = this.databaseMoneyToNumber(
      zone.delivery_fee,
      'delivery_fee',
    );

    const minimumOrder = this.databaseMoneyToNumber(
      zone.minimum_order,
      'minimum_order',
    );

    const minimumOrderMissing = Math.max(
      0,
      this.roundMoney(minimumOrder - subtotal),
    );

    const commonResponse = {
      branch: {
        code: branch.branch_code,
        name: branch.branch_name,
      },

      zone: {
        code: zone.code,
        name: zone.name,
      },

      deliveryFee,
      minimumOrder,

      eta: {
        minMinutes: zone.eta_min_minutes,
        maxMinutes: zone.eta_max_minutes,
      },

      route: null,
    };

    if (minimumOrderMissing > 0) {
      return {
        available: false,
        reason: 'MINIMUM_ORDER_NOT_MET',

        ...commonResponse,

        minimumOrderMissing,
      };
    }

    const route = await this.calculatePublicDeliveryRoute(
      branch,
      {
        latitude,
        longitude,
      },
    );

    const routeAwareEta = this.buildRouteAwareEta(
      branch,
      zone,
      route.durationSeconds,
    );

    return {
      available: true,
      reason: null,

      ...commonResponse,

      eta: routeAwareEta,

      route: {
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
      },

      minimumOrderMissing: 0,
    };
  }

  async prepareDeliveryCheckoutRoute(
    input: {
      tenantId: string;
      branchId: string;
      latitude: unknown;
      longitude: unknown;
      subtotal: number;
    },
  ): Promise<DeliveryCheckoutRouteSnapshot> {
    const tenantId =
      this.requireUuid(
        input.tenantId,
        'tenantId',
      );

    const branchId =
      this.requireUuid(
        input.branchId,
        'branchId',
      );

    const latitude =
      this.requireCoordinate(
        input.latitude,
        'deliveryLatitude',
        -90,
        90,
      );

    const longitude =
      this.requireCoordinate(
        input.longitude,
        'deliveryLongitude',
        -180,
        180,
      );

    const subtotal =
      this.requireSubtotal(
        input.subtotal,
      );

    const branchResult =
      await this.databaseService.query<DeliveryBranchRow>(
        `
          select
            b.tenant_id::text as tenant_id,
            b.id::text as branch_id,
            b.code as branch_code,
            b.name as branch_name,
            b.delivery_enabled,
            b.delivery_origin_latitude::text,
            b.delivery_origin_longitude::text,
            b.delivery_default_prep_minutes
          from public.branches b
          where b.tenant_id = $1::uuid
            and b.id = $2::uuid
            and b.status = 'ACTIVE'
          limit 1
        `,
        [
          tenantId,
          branchId,
        ],
      );

    const branch =
      branchResult.rows[0];

    if (!branch) {
      throw new NotFoundException(
        'Branch not found for delivery checkout',
      );
    }

    if (!branch.delivery_enabled) {
      throw new ConflictException(
        'Delivery is disabled for this branch',
      );
    }

    const zoneResult =
      await this.databaseService.query<DeliveryZoneRow>(
        `
          select
            z.id::text,
            z.code,
            z.name,
            z.delivery_fee::text,
            z.minimum_order::text,
            z.eta_min_minutes,
            z.eta_max_minutes
          from public.delivery_zones z
          where z.tenant_id = $1::uuid
            and z.branch_id = $2::uuid
            and z.status = 'ACTIVE'
            and gis.ST_Covers(
              z.area,
              gis.ST_SetSRID(
                gis.ST_MakePoint(
                  $3::double precision,
                  $4::double precision
                ),
                4326
              )
            )
          order by
            z.priority asc,
            z.code asc,
            z.id asc
          limit 1
        `,
        [
          tenantId,
          branchId,
          longitude,
          latitude,
        ],
      );

    const zone =
      zoneResult.rows[0];

    if (!zone) {
      throw new ConflictException(
        'Delivery address is outside the delivery area',
      );
    }

    const minimumOrder =
      this.databaseMoneyToNumber(
        zone.minimum_order,
        'minimum_order',
      );

    const minimumOrderMissing =
      this.roundMoney(
        minimumOrder -
        subtotal,
      );

    if (minimumOrderMissing > 0) {
      throw new ConflictException(
        `Minimum delivery order not met: ${minimumOrderMissing.toFixed(2)} BOB missing`,
      );
    }

    const origin =
      this.requireDeliveryBranchOrigin(
        branch,
      );

    const destination = {
      latitude,
      longitude,
    };

    const route =
      await this.geoProvider.calculateRoute({
        origin,
        destination,
      });

    this.validateDeliveryRouteMetrics(
      route.distanceMeters,
      route.durationSeconds,
    );

    this.buildRouteAwareEta(
      branch,
      zone,
      route.durationSeconds,
    );

    return {
      tenantId,
      branchId,

      origin,
      destination,

      distanceMeters:
        route.distanceMeters,

      durationSeconds:
        route.durationSeconds,
    };
  }
  async quoteDeliveryForCheckout(
    client: PoolClient,
    input: {
      tenantId: string;
      branchId: string;
      latitude: unknown;
      longitude: unknown;
      subtotal: number;
      routeSnapshot: DeliveryCheckoutRouteSnapshot;
    },
  ): Promise<DeliveryCheckoutQuote> {
    const latitude = this.requireCoordinate(
      input.latitude,
      'deliveryLatitude',
      -90,
      90,
    );

    const longitude = this.requireCoordinate(
      input.longitude,
      'deliveryLongitude',
      -180,
      180,
    );

    const subtotal = this.requireSubtotal(input.subtotal);

    const branchResult = await client.query<DeliveryBranchRow>(
      `
        select
          b.tenant_id::text as tenant_id,
          b.id::text as branch_id,
          b.code as branch_code,
          b.name as branch_name,
          b.delivery_enabled,
          b.delivery_origin_latitude::text,
          b.delivery_origin_longitude::text,
          b.delivery_default_prep_minutes
        from public.branches b
        where b.tenant_id = $1::uuid
          and b.id = $2::uuid
          and b.status = 'ACTIVE'
        for share
      `,
      [input.tenantId, input.branchId],
    );

    const branch = branchResult.rows[0];

    if (!branch) {
      throw new NotFoundException('Branch not found for delivery checkout');
    }

    if (!branch.delivery_enabled) {
      throw new ConflictException('Delivery is disabled for this branch');
    }

    const routeSnapshot =
      this.requireCurrentDeliveryRouteSnapshot(
        input.routeSnapshot,
        branch,
        latitude,
        longitude,
      );

    const zoneResult = await client.query<DeliveryZoneRow>(
      `
          select
            z.id::text,
            z.code,
            z.name,
            z.delivery_fee::text,
            z.minimum_order::text,
            z.eta_min_minutes,
            z.eta_max_minutes
          from public.delivery_zones z
          where z.tenant_id = $1::uuid
            and z.branch_id = $2::uuid
            and z.status = 'ACTIVE'
            and gis.ST_Covers(
              z.area,
              gis.ST_SetSRID(
                gis.ST_MakePoint(
                  $3::double precision,
                  $4::double precision
                ),
                4326
              )
            )
          order by
            z.priority asc,
            z.code asc,
            z.id asc
          limit 1
          for share of z
        `,
      [input.tenantId, input.branchId, longitude, latitude],
    );

    const zone = zoneResult.rows[0];

    if (!zone) {
      throw new ConflictException(
        'Delivery address is outside the delivery area',
      );
    }

    const deliveryFee = this.databaseMoneyToNumber(
      zone.delivery_fee,
      'delivery_fee',
    );

    const minimumOrder = this.databaseMoneyToNumber(
      zone.minimum_order,
      'minimum_order',
    );

    const minimumOrderMissing = this.roundMoney(minimumOrder - subtotal);

    if (minimumOrderMissing > 0) {
      throw new ConflictException(
        `Minimum delivery order not met: ${minimumOrderMissing.toFixed(2)} BOB missing`,
      );
    }

    const routeAwareEta =
      this.buildRouteAwareEta(
        branch,
        zone,
        routeSnapshot.durationSeconds,
      );

    return {
      zoneId: zone.id,

      zone: {
        code: zone.code,
        name: zone.name,
      },

      deliveryFee,
      minimumOrder,

      route: {
        distanceMeters:
          routeSnapshot.distanceMeters,

        durationSeconds:
          routeSnapshot.durationSeconds,
      },

      eta: routeAwareEta,
    };
  }

  async createDeliveryForOrder(
    client: PoolClient,
    input: {
      tenantId: string;
      branchId: string;
      orderId: string;

      quote: DeliveryCheckoutQuote;

      recipientName: string;
      recipientPhone: string;

      addressText: string;
      addressReference: string | null;

      latitude: number;
      longitude: number;
    },
  ): Promise<CreatedDelivery> {
    const result = await client.query<{
      id: string;
      tracking_token: string;
      status: 'CREATED';
    }>(
      `
        insert into public.deliveries (
          tenant_id,
          branch_id,
          order_id,
          zone_id,

          status,

          recipient_name,
          recipient_phone,

          address_text,
          address_reference,

          destination,

          quoted_delivery_fee,
          distance_meters,

          eta_min_minutes,
          eta_max_minutes
        )
        values (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::uuid,

          'CREATED',

          $5,
          $6,

          $7,
          $8,

          gis.ST_SetSRID(
            gis.ST_MakePoint(
              $9::double precision,
              $10::double precision
            ),
            4326
          )::gis.geography,

          $11,
          $12::integer,

          $13,
          $14
        )
        returning
          id::text,
          tracking_token::text,
          status
      `,
      [
        input.tenantId,
        input.branchId,
        input.orderId,
        input.quote.zoneId,

        input.recipientName,
        input.recipientPhone,

        input.addressText,
        input.addressReference,

        input.longitude,
        input.latitude,

        input.quote.deliveryFee,
        input.quote.route.distanceMeters,

        input.quote.eta.minMinutes,
        input.quote.eta.maxMinutes,
      ],
    );

    const delivery = result.rows[0];

    if (!delivery) {
      throw new Error('Delivery creation returned no row');
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

          'DELIVERY_CREATED',
          null,
          'CREATED',

          'SYSTEM',
          'ORDER_CHECKOUT',

          jsonb_build_object(
            'zoneCode',
            $4::text,
            'deliveryFee',
            $5::numeric,
            'routeDistanceMeters',
            $6::integer,
            'routeDurationSeconds',
            $7::integer,
            'etaMinMinutes',
            $8::integer,
            'etaMaxMinutes',
            $9::integer
          )
        )
      `,
      [
        input.tenantId,
        input.branchId,
        delivery.id,

        input.quote.zone.code,
        input.quote.deliveryFee,
        input.quote.route.distanceMeters,
        input.quote.route.durationSeconds,
        input.quote.eta.minMinutes,
        input.quote.eta.maxMinutes,
      ],
    );

    return {
      id: delivery.id,
      trackingToken: delivery.tracking_token,
      status: delivery.status,
    };
  }
  async assignOperationalDelivery(
    deliveryIdInput: unknown,
    tenantCodeInput?: string,
    branchCodeInput?: string,
    driverIdInput?: unknown,
    expectedAssignmentIdInput?: unknown,
  ) {
    const deliveryId = this.requireUuid(
      deliveryIdInput,
      'deliveryId',
    );

    const tenantCode = this.requireCode(
      tenantCodeInput,
      'tenant',
    );

    const branchCode = this.requireCode(
      branchCodeInput,
      'branch',
    );

    const driverId = this.requireUuid(
      driverIdInput,
      'driverId',
    );

    const expectedAssignmentId =
      this.optionalUuid(
        expectedAssignmentIdInput,
        'expectedAssignmentId',
      );

    return this.databaseService.withTransaction(
      async (client) => {
        const branchResult =
          await client.query<{
            tenant_id: string;
            branch_id: string;
            branch_name: string;
          }>(
            `
              select
                t.id::text as tenant_id,
                b.id::text as branch_id,
                b.name as branch_name

              from public.tenants t

              inner join public.branches b
                on b.tenant_id = t.id

              where t.code = $1
                and b.code = $2
                and t.status = 'ACTIVE'
                and b.status = 'ACTIVE'

              limit 1

              for share of t, b
            `,
            [
              tenantCode,
              branchCode,
            ],
          );

        const branch = branchResult.rows[0];

        if (!branch) {
          throw new NotFoundException(
            'Tenant or branch not found',
          );
        }

        const deliveryResult =
          await client.query<{
            id: string;
            status: string;

            order_id: string;
            order_number: string;
            order_status: string;
            payment_status: string;
          }>(
            `
              select
                d.id::text,
                d.status,

                o.id::text
                  as order_id,

                o.order_number::text
                  as order_number,

                o.status
                  as order_status,

                o.payment_status

              from public.deliveries d

              inner join public.orders o
                on o.tenant_id = d.tenant_id
               and o.branch_id = d.branch_id
               and o.id = d.order_id

              where d.tenant_id = $1::uuid
                and d.branch_id = $2::uuid
                and d.id = $3::uuid

              for update of d
            `,
            [
              branch.tenant_id,
              branch.branch_id,
              deliveryId,
            ],
          );

        const delivery =
          deliveryResult.rows[0];

        if (!delivery) {
          throw new NotFoundException(
            'Delivery not found',
          );
        }

        if (
          ![
            'CONFIRMED',
            'PREPARING',
            'READY',
          ].includes(delivery.order_status)
        ) {
          throw new ConflictException(
            `Order ${delivery.order_number} is not dispatchable from ${delivery.order_status}`,
          );
        }

        if (
          ![
            'PAID',
            'NOT_REQUIRED',
          ].includes(delivery.payment_status)
        ) {
          throw new ConflictException(
            'Delivery cannot be assigned until payment is verified',
          );
        }

        if (
          delivery.status !== 'WAITING_ASSIGNMENT' &&
          delivery.status !== 'ASSIGNED'
        ) {
          throw new ConflictException(
            `Delivery cannot be assigned from ${delivery.status}`,
          );
        }

        const activeResult =
          await client.query<{
            id: string;
            driver_id: string;
            assignment_number: number;
            status: string;

            driver_code: string;
            driver_name: string;
          }>(
            `
              select
                a.id::text,
                a.driver_id::text,
                a.assignment_number,
                a.status,

                drv.code
                  as driver_code,

                drv.display_name
                  as driver_name

              from public.delivery_assignments a

              inner join public.delivery_drivers drv
                on drv.tenant_id = a.tenant_id
               and drv.id = a.driver_id

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
            [
              branch.tenant_id,
              branch.branch_id,
              delivery.id,
            ],
          );

        const activeAssignment =
          activeResult.rows[0] ?? null;

        if (
          delivery.status ===
            'WAITING_ASSIGNMENT' &&
          activeAssignment
        ) {
          throw new ConflictException(
            'Delivery assignment state is inconsistent',
          );
        }

        if (
          delivery.status === 'ASSIGNED' &&
          !activeAssignment
        ) {
          throw new ConflictException(
            'Delivery assignment state is inconsistent',
          );
        }

        if (
          activeAssignment &&
          activeAssignment.status !== 'ASSIGNED'
        ) {
          throw new ConflictException(
            'Accepted assignment cannot be replaced by operations',
          );
        }

        // ----------------------------------------------------
        // Idempotency.
        //
        // A retry of the same assignment does not create
        // another assignment or another event.
        // ----------------------------------------------------

        if (
          activeAssignment &&
          activeAssignment.driver_id === driverId
        ) {
          return {
            tenant: tenantCode,

            branch: {
              code: branchCode,
              name: branch.branch_name,
            },

            changed: false,
            action: 'UNCHANGED',

            delivery: {
              id: delivery.id,
              status: delivery.status,
            },

            assignment: {
              id: activeAssignment.id,

              number:
                activeAssignment.assignment_number,

              status:
                activeAssignment.status,

              driver: {
                id: activeAssignment.driver_id,
                code: activeAssignment.driver_code,
                name: activeAssignment.driver_name,
              },
            },
          };
        }

        // ----------------------------------------------------
        // Reassignment stale-write protection.
        //
        // First assignment has no expectedAssignmentId.
        // Reassignment requires the exact active assignment
        // observed by the operator.
        // ----------------------------------------------------

        if (
          delivery.status ===
            'WAITING_ASSIGNMENT' &&
          expectedAssignmentId
        ) {
          throw new BadRequestException(
            'expectedAssignmentId must be omitted for initial assignment',
          );
        }

        if (
          delivery.status === 'ASSIGNED' &&
          !expectedAssignmentId
        ) {
          throw new ConflictException(
            'expectedAssignmentId is required for reassignment',
          );
        }

        if (
          activeAssignment &&
          expectedAssignmentId !==
            activeAssignment.id
        ) {
          throw new ConflictException(
            'Delivery assignment changed concurrently',
          );
        }

        // ----------------------------------------------------
        // Target driver must be ACTIVE and explicitly ENABLED
        // for this tenant + branch.
        // ----------------------------------------------------

        const driverResult =
          await client.query<{
            id: string;
            code: string;
            display_name: string;
          }>(
            `
              select
                drv.id::text,
                drv.code,
                drv.display_name

              from public.delivery_driver_branches db

              inner join public.delivery_drivers drv
                on drv.tenant_id = db.tenant_id
               and drv.id = db.driver_id

              where db.tenant_id = $1::uuid
                and db.branch_id = $2::uuid
                and db.driver_id = $3::uuid

                and db.status = 'ENABLED'
                and drv.status = 'ACTIVE'

              limit 1

              for share of db, drv
            `,
            [
              branch.tenant_id,
              branch.branch_id,
              driverId,
            ],
          );

        const driver =
          driverResult.rows[0];

        if (!driver) {
          throw new ConflictException(
            'Driver is not active and enabled for this branch',
          );
        }

        // ----------------------------------------------------
        // Calculate next immutable history number while the
        // delivery row remains locked.
        // ----------------------------------------------------

        const numberResult =
          await client.query<{
            next_number: number;
          }>(
            `
              select
                (
                  coalesce(
                    max(a.assignment_number),
                    0
                  ) + 1
                )::integer as next_number

              from public.delivery_assignments a

              where a.tenant_id = $1::uuid
                and a.branch_id = $2::uuid
                and a.delivery_id = $3::uuid
            `,
            [
              branch.tenant_id,
              branch.branch_id,
              delivery.id,
            ],
          );

        const nextAssignmentNumber =
          numberResult.rows[0]?.next_number;

        if (
          !nextAssignmentNumber ||
          nextAssignmentNumber < 1
        ) {
          throw new Error(
            'Could not calculate assignment number',
          );
        }

        const isReassignment =
          activeAssignment !== null;

        // ----------------------------------------------------
        // Release old assignment first.
        // The partial unique index then permits the new active
        // assignment inside this same transaction.
        // ----------------------------------------------------

        if (activeAssignment) {
          const releasedResult =
            await client.query(
              `
                update public.delivery_assignments

                set
                  status = 'RELEASED',
                  released_at = now(),
                  release_reason =
                    'Reassigned by operations',
                  updated_at = now()

                where tenant_id = $1::uuid
                  and branch_id = $2::uuid
                  and id = $3::uuid
                  and status = 'ASSIGNED'

                returning id
              `,
              [
                branch.tenant_id,
                branch.branch_id,
                activeAssignment.id,
              ],
            );

          if (releasedResult.rowCount !== 1) {
            throw new ConflictException(
              'Delivery assignment changed concurrently',
            );
          }
        }

        let newAssignment: {
          id: string;
          assignment_number: number;
          status: string;
          assigned_at: string | Date;
        };

        try {
          const insertResult =
            await client.query<{
              id: string;
              assignment_number: number;
              status: string;
              assigned_at: string | Date;
            }>(
              `
                insert into public.delivery_assignments (
                  tenant_id,
                  branch_id,
                  delivery_id,
                  driver_id,

                  assignment_number,
                  status
                )
                values (
                  $1::uuid,
                  $2::uuid,
                  $3::uuid,
                  $4::uuid,

                  $5::integer,
                  'ASSIGNED'
                )
                returning
                  id::text,
                  assignment_number,
                  status,
                  assigned_at
              `,
              [
                branch.tenant_id,
                branch.branch_id,
                delivery.id,
                driver.id,
                nextAssignmentNumber,
              ],
            );

          const inserted =
            insertResult.rows[0];

          if (!inserted) {
            throw new Error(
              'Assignment creation returned no row',
            );
          }

          newAssignment = inserted;
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (
              error as {
                code?: string;
              }
            ).code === '23505'
          ) {
            throw new ConflictException(
              'Delivery assignment changed concurrently',
            );
          }

          throw error;
        }

        // ----------------------------------------------------
        // First assignment changes delivery status.
        // Reassignment keeps ASSIGNED but refreshes updated_at.
        // ----------------------------------------------------

        if (!isReassignment) {
          const deliveryUpdate =
            await client.query(
              `
                update public.deliveries

                set
                  status = 'ASSIGNED',
                  updated_at = now()

                where tenant_id = $1::uuid
                  and branch_id = $2::uuid
                  and id = $3::uuid
                  and status =
                    'WAITING_ASSIGNMENT'

                returning id
              `,
              [
                branch.tenant_id,
                branch.branch_id,
                delivery.id,
              ],
            );

          if (deliveryUpdate.rowCount !== 1) {
            throw new ConflictException(
              'Delivery changed concurrently',
            );
          }
        } else {
          const deliveryUpdate =
            await client.query(
              `
                update public.deliveries

                set updated_at = now()

                where tenant_id = $1::uuid
                  and branch_id = $2::uuid
                  and id = $3::uuid
                  and status = 'ASSIGNED'

                returning id
              `,
              [
                branch.tenant_id,
                branch.branch_id,
                delivery.id,
              ],
            );

          if (deliveryUpdate.rowCount !== 1) {
            throw new ConflictException(
              'Delivery changed concurrently',
            );
          }
        }

        // ----------------------------------------------------
        // Immutable delivery event.
        // ----------------------------------------------------

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

              $4,
              $5,
              'ASSIGNED',

              'OPS',
              'OPS_DISPATCH',

              jsonb_build_object(
                'assignmentId',
                  $6::text,

                'assignmentNumber',
                  $7::integer,

                'driverId',
                  $8::text,

                'driverCode',
                  $9::text,

                'previousAssignmentId',
                  $10::text,

                'previousDriverId',
                  $11::text,

                'previousDriverCode',
                  $12::text
              )
            )
          `,
          [
            branch.tenant_id,
            branch.branch_id,
            delivery.id,

            isReassignment
              ? 'DRIVER_REASSIGNED'
              : 'DRIVER_ASSIGNED',

            isReassignment
              ? 'ASSIGNED'
              : 'WAITING_ASSIGNMENT',

            newAssignment.id,
            newAssignment.assignment_number,

            driver.id,
            driver.code,

            activeAssignment?.id ?? null,
            activeAssignment?.driver_id ?? null,
            activeAssignment?.driver_code ?? null,
          ],
        );

        return {
          tenant: tenantCode,

          branch: {
            code: branchCode,
            name: branch.branch_name,
          },

          changed: true,

          action:
            isReassignment
              ? 'REASSIGNED'
              : 'ASSIGNED',

          delivery: {
            id: delivery.id,
            status: 'ASSIGNED',
          },

          previousAssignment:
            activeAssignment
              ? {
                  id: activeAssignment.id,

                  number:
                    activeAssignment.assignment_number,

                  status: 'RELEASED',

                  driver: {
                    id:
                      activeAssignment.driver_id,

                    code:
                      activeAssignment.driver_code,

                    name:
                      activeAssignment.driver_name,
                  },
                }
              : null,

          assignment: {
            id: newAssignment.id,

            number:
              newAssignment.assignment_number,

            status:
              newAssignment.status,

            assignedAt:
              newAssignment.assigned_at,

            driver: {
              id: driver.id,
              code: driver.code,
              name: driver.display_name,
            },
          },
        };
      },
    );
  }
  async acceptDriverDelivery(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    driverCode: string,
  ) {
    const deliveryId =
      this.requireUuid(
        deliveryIdInput,
        'deliveryId',
      );

    const tenantId =
      this.requireUuid(
        tenantIdInput,
        'tenantId',
      );

    const driverId =
      this.requireUuid(
        driverIdInput,
        'driverId',
      );

    const safeDriverCode =
      driverCode?.trim() || 'DRIVER';

    return this.databaseService.withTransaction(
      async (client) => {
        const deliveryResult =
          await client.query<{
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
            [
              tenantId,
              deliveryId,
            ],
          );

        const delivery =
          deliveryResult.rows[0];

        if (!delivery) {
          throw new NotFoundException(
            'Delivery not found',
          );
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

        const branchAuthorizationResult =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              driverId,
            ],
          );

        if (!branchAuthorizationResult.rows[0]) {
          throw new ConflictException(
            'Driver is not enabled for delivery branch',
          );
        }

        if (
          ![
            'CONFIRMED',
            'PREPARING',
            'READY',
          ].includes(delivery.order_status)
        ) {
          throw new ConflictException(
            `Delivery cannot be accepted while order is ${delivery.order_status}`,
          );
        }

        if (
          ![
            'PAID',
            'NOT_REQUIRED',
          ].includes(delivery.payment_status)
        ) {
          throw new ConflictException(
            'Delivery cannot be accepted until payment is verified',
          );
        }

        if (
          delivery.delivery_status !== 'ASSIGNED' &&
          delivery.delivery_status !== 'ACCEPTED'
        ) {
          throw new ConflictException(
            `Delivery cannot be accepted from ${delivery.delivery_status}`,
          );
        }

        const assignmentResult =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              delivery.id,
            ],
          );

        const assignment =
          assignmentResult.rows[0];

        if (!assignment) {
          throw new ConflictException(
            'Delivery assignment state is inconsistent',
          );
        }

        if (
          assignment.driver_id !== driverId
        ) {
          throw new ConflictException(
            'Delivery is assigned to another driver',
          );
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
              number:
                assignment.assignment_number,

              status: 'ACCEPTED',

              assignedAt:
                assignment.assigned_at,

              acceptedAt:
                assignment.accepted_at,

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

        const assignmentUpdate =
          await client.query<{
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

        const acceptedAssignment =
          assignmentUpdate.rows[0];

        if (!acceptedAssignment) {
          throw new ConflictException(
            'Delivery assignment changed concurrently',
          );
        }

        const deliveryUpdate =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              delivery.id,
            ],
          );

        if (deliveryUpdate.rowCount !== 1) {
          throw new ConflictException(
            'Delivery status changed concurrently',
          );
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

            number:
              acceptedAssignment.assignment_number,

            status: 'ACCEPTED',

            assignedAt:
              acceptedAssignment.assigned_at,

            acceptedAt:
              acceptedAssignment.accepted_at,

            driver: {
              id: driverId,
              code: safeDriverCode,
            },
          },
        };
      },
    );
  }
  async pickupDriverDelivery(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    driverCode: string,
  ) {
    const deliveryId =
      this.requireUuid(
        deliveryIdInput,
        'deliveryId',
      );

    const tenantId =
      this.requireUuid(
        tenantIdInput,
        'tenantId',
      );

    const driverId =
      this.requireUuid(
        driverIdInput,
        'driverId',
      );

    const safeDriverCode =
      driverCode?.trim() || 'DRIVER';

    return this.databaseService.withTransaction(
      async (client) => {
        const deliveryResult =
          await client.query<{
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
            [
              tenantId,
              deliveryId,
            ],
          );

        const delivery =
          deliveryResult.rows[0];

        if (!delivery) {
          throw new NotFoundException(
            'Delivery not found',
          );
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

        const branchAuthorizationResult =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              driverId,
            ],
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

        const assignmentResult =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              delivery.id,
            ],
          );

        const assignment =
          assignmentResult.rows[0];

        if (!assignment) {
          throw new ConflictException(
            'Delivery assignment state is inconsistent',
          );
        }

        if (
          assignment.driver_id !== driverId
        ) {
          throw new ConflictException(
            'Delivery is assigned to another driver',
          );
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

              number:
                assignment.assignment_number,

              status: 'ACCEPTED',

              assignedAt:
                assignment.assigned_at,

              acceptedAt:
                assignment.accepted_at,

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
          throw new ConflictException(
            'Delivery pickup state is inconsistent',
          );
        }

        // ----------------------------------------------------
        // Initial pickup requires the kitchen / operations
        // order state to be READY.
        // ----------------------------------------------------

        if (
          delivery.order_status !== 'READY'
        ) {
          throw new ConflictException(
            `Delivery cannot be picked up while order is ${delivery.order_status}`,
          );
        }

        if (
          ![
            'PAID',
            'NOT_REQUIRED',
          ].includes(delivery.payment_status)
        ) {
          throw new ConflictException(
            'Delivery cannot be picked up until payment is verified',
          );
        }

        const deliveryUpdate =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              delivery.id,
            ],
          );

        const pickedUpDelivery =
          deliveryUpdate.rows[0];

        if (!pickedUpDelivery) {
          throw new ConflictException(
            'Delivery status changed concurrently',
          );
        }

        const eventResult =
          await client.query<{
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

        const pickupEvent =
          eventResult.rows[0];

        if (!pickupEvent) {
          throw new ConflictException(
            'Delivery pickup event was not created',
          );
        }

        return {
          changed: true,
          action: 'PICKED_UP',

          delivery: {
            id: delivery.id,
            status: 'PICKED_UP',

            pickedUpAt:
              pickupEvent.created_at,
          },

          order: {
            id: delivery.order_id,
            number: delivery.order_number,
            status: delivery.order_status,
          },

          assignment: {
            id: assignment.id,

            number:
              assignment.assignment_number,

            // Intentionally remains ACCEPTED during
            // PICKED_UP / EN_ROUTE / ARRIVED.
            status: 'ACCEPTED',

            assignedAt:
              assignment.assigned_at,

            acceptedAt:
              assignment.accepted_at,

            driver: {
              id: driverId,
              code: safeDriverCode,
            },
          },
        };
      },
    );
  }
  async startDriverDelivery(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    driverCode: string,
  ) {
    const deliveryId =
      this.requireUuid(
        deliveryIdInput,
        'deliveryId',
      );

    const tenantId =
      this.requireUuid(
        tenantIdInput,
        'tenantId',
      );

    const driverId =
      this.requireUuid(
        driverIdInput,
        'driverId',
      );

    const safeDriverCode =
      driverCode?.trim() || 'DRIVER';

    return this.databaseService.withTransaction(
      async (client) => {
        const deliveryResult =
          await client.query<{
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
            [
              tenantId,
              deliveryId,
            ],
          );

        const delivery =
          deliveryResult.rows[0];

        if (!delivery) {
          throw new NotFoundException(
            'Delivery not found',
          );
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

        const branchAuthorizationResult =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              driverId,
            ],
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

        const assignmentResult =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              delivery.id,
            ],
          );

        const assignment =
          assignmentResult.rows[0];

        if (!assignment) {
          throw new ConflictException(
            'Delivery assignment state is inconsistent',
          );
        }

        if (
          assignment.driver_id !== driverId
        ) {
          throw new ConflictException(
            'Delivery is assigned to another driver',
          );
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

              number:
                assignment.assignment_number,

              status: 'ACCEPTED',

              assignedAt:
                assignment.assigned_at,

              acceptedAt:
                assignment.accepted_at,

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
          throw new ConflictException(
            'Delivery route state is inconsistent',
          );
        }

        // ----------------------------------------------------
        // PICKED_UP already proves that the kitchen handed the
        // order to the driver. We still verify READY and payment
        // to protect against inconsistent external DB changes.
        // ----------------------------------------------------

        if (
          delivery.order_status !== 'READY'
        ) {
          throw new ConflictException(
            `Delivery cannot start route while order is ${delivery.order_status}`,
          );
        }

        if (
          ![
            'PAID',
            'NOT_REQUIRED',
          ].includes(delivery.payment_status)
        ) {
          throw new ConflictException(
            'Delivery cannot start route until payment is verified',
          );
        }

        const deliveryUpdate =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              delivery.id,
            ],
          );

        const enRouteDelivery =
          deliveryUpdate.rows[0];

        if (!enRouteDelivery) {
          throw new ConflictException(
            'Delivery status changed concurrently',
          );
        }

        const eventResult =
          await client.query<{
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

        const enRouteEvent =
          eventResult.rows[0];

        if (!enRouteEvent) {
          throw new ConflictException(
            'Delivery route event was not created',
          );
        }

        return {
          changed: true,
          action: 'EN_ROUTE',

          delivery: {
            id: delivery.id,
            status: 'EN_ROUTE',

            enRouteAt:
              enRouteEvent.created_at,
          },

          order: {
            id: delivery.order_id,
            number: delivery.order_number,
            status: delivery.order_status,
          },

          assignment: {
            id: assignment.id,

            number:
              assignment.assignment_number,

            // Assignment intentionally remains ACCEPTED during
            // PICKED_UP / EN_ROUTE / ARRIVED.
            status: 'ACCEPTED',

            assignedAt:
              assignment.assigned_at,

            acceptedAt:
              assignment.accepted_at,

            driver: {
              id: driverId,
              code: safeDriverCode,
            },
          },
        };
      },
    );
  }
  async arriveDriverDelivery(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    driverCode: string,
  ) {
    const deliveryId =
      this.requireUuid(
        deliveryIdInput,
        'deliveryId',
      );

    const tenantId =
      this.requireUuid(
        tenantIdInput,
        'tenantId',
      );

    const driverId =
      this.requireUuid(
        driverIdInput,
        'driverId',
      );

    const safeDriverCode =
      driverCode?.trim() || 'DRIVER';

    return this.databaseService.withTransaction(
      async (client) => {
        const deliveryResult =
          await client.query<{
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
            [
              tenantId,
              deliveryId,
            ],
          );

        const delivery =
          deliveryResult.rows[0];

        if (!delivery) {
          throw new NotFoundException(
            'Delivery not found',
          );
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

        const branchAuthorizationResult =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              driverId,
            ],
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

        const assignmentResult =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              delivery.id,
            ],
          );

        const assignment =
          assignmentResult.rows[0];

        if (!assignment) {
          throw new ConflictException(
            'Delivery assignment state is inconsistent',
          );
        }

        if (
          assignment.driver_id !== driverId
        ) {
          throw new ConflictException(
            'Delivery is assigned to another driver',
          );
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

              number:
                assignment.assignment_number,

              status: 'ACCEPTED',

              assignedAt:
                assignment.assigned_at,

              acceptedAt:
                assignment.accepted_at,

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
          throw new ConflictException(
            'Delivery arrival state is inconsistent',
          );
        }

        // ----------------------------------------------------
        // ARRIVED does not complete the order.
        //
        // The order remains READY until proof-of-delivery /
        // final DELIVERED confirmation is implemented.
        // ----------------------------------------------------

        if (
          delivery.order_status !== 'READY'
        ) {
          throw new ConflictException(
            `Delivery cannot arrive while order is ${delivery.order_status}`,
          );
        }

        if (
          ![
            'PAID',
            'NOT_REQUIRED',
          ].includes(delivery.payment_status)
        ) {
          throw new ConflictException(
            'Delivery cannot arrive until payment is verified',
          );
        }

        const deliveryUpdate =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              delivery.id,
            ],
          );

        const arrivedDelivery =
          deliveryUpdate.rows[0];

        if (!arrivedDelivery) {
          throw new ConflictException(
            'Delivery status changed concurrently',
          );
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

        const podChallengeInsert =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              delivery.id,
            ],
          );

        let podChallengeStatus =
          podChallengeInsert.rows[0]?.status;

        if (!podChallengeStatus) {
          const existingPodChallenge =
            await client.query<{
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
              [
                delivery.tenant_id,
                delivery.branch_id,
                delivery.id,
              ],
            );

          podChallengeStatus =
            existingPodChallenge.rows[0]?.status;
        }

        if (
          podChallengeStatus !== 'ACTIVE'
        ) {
          throw new ConflictException(
            'Delivery POD challenge state is inconsistent',
          );
        }

        const eventResult =
          await client.query<{
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

        const arrivedEvent =
          eventResult.rows[0];

        if (!arrivedEvent) {
          throw new ConflictException(
            'Delivery arrival event was not created',
          );
        }

        return {
          changed: true,
          action: 'ARRIVED',

          delivery: {
            id: delivery.id,
            status: 'ARRIVED',

            arrivedAt:
              arrivedEvent.created_at,
          },

          order: {
            id: delivery.order_id,
            number: delivery.order_number,

            // Order remains READY until DELIVERED.
            status: delivery.order_status,
          },

          assignment: {
            id: assignment.id,

            number:
              assignment.assignment_number,

            // Assignment intentionally remains ACCEPTED during
            // PICKED_UP / EN_ROUTE / ARRIVED.
            status: 'ACCEPTED',

            assignedAt:
              assignment.assigned_at,

            acceptedAt:
              assignment.accepted_at,

            driver: {
              id: driverId,
              code: safeDriverCode,
            },
          },
        };
      },
    );
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
    const deliveryId =
      this.requireUuid(
        deliveryIdInput,
        'deliveryId',
      );

    const tenantId =
      this.requireUuid(
        tenantIdInput,
        'tenantId',
      );

    const driverId =
      this.requireUuid(
        driverIdInput,
        'driverId',
      );

    if (
      !locationInput ||
      typeof locationInput !== 'object' ||
      Array.isArray(locationInput)
    ) {
      throw new BadRequestException(
        'location body is required',
      );
    }

    const requireFiniteNumber = (
      value: unknown,
      field: string,
    ): number => {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value)
      ) {
        throw new BadRequestException(
          `${field} must be a finite number`,
        );
      }

      return value;
    };

    const optionalFiniteNumber = (
      value: unknown,
      field: string,
    ): number | null => {
      if (
        value === undefined ||
        value === null
      ) {
        return null;
      }

      return requireFiniteNumber(
        value,
        field,
      );
    };

    const latitude =
      requireFiniteNumber(
        locationInput.latitude,
        'latitude',
      );

    const longitude =
      requireFiniteNumber(
        locationInput.longitude,
        'longitude',
      );

    if (
      latitude < -90 ||
      latitude > 90
    ) {
      throw new BadRequestException(
        'latitude must be between -90 and 90',
      );
    }

    if (
      longitude < -180 ||
      longitude > 180
    ) {
      throw new BadRequestException(
        'longitude must be between -180 and 180',
      );
    }

    const accuracyMeters =
      optionalFiniteNumber(
        locationInput.accuracyMeters,
        'accuracyMeters',
      );

    if (
      accuracyMeters !== null &&
      (
        accuracyMeters < 0 ||
        accuracyMeters > 999999.99
      )
    ) {
      throw new BadRequestException(
        'accuracyMeters is outside the supported range',
      );
    }

    const headingDegrees =
      optionalFiniteNumber(
        locationInput.headingDegrees,
        'headingDegrees',
      );

    if (
      headingDegrees !== null &&
      (
        headingDegrees < 0 ||
        headingDegrees >= 360
      )
    ) {
      throw new BadRequestException(
        'headingDegrees must be between 0 and less than 360',
      );
    }

    const speedMps =
      optionalFiniteNumber(
        locationInput.speedMps,
        'speedMps',
      );

    if (
      speedMps !== null &&
      (
        speedMps < 0 ||
        speedMps > 99999.999
      )
    ) {
      throw new BadRequestException(
        'speedMps is outside the supported range',
      );
    }

    let capturedAt =
      new Date().toISOString();

    if (
      locationInput.capturedAt !== undefined &&
      locationInput.capturedAt !== null
    ) {
      if (
        typeof locationInput.capturedAt !== 'string' ||
        !locationInput.capturedAt.trim()
      ) {
        throw new BadRequestException(
          'capturedAt must be a valid timestamp',
        );
      }

      const parsedCapturedAt =
        new Date(
          locationInput.capturedAt,
        );

      if (
        !Number.isFinite(
          parsedCapturedAt.getTime(),
        )
      ) {
        throw new BadRequestException(
          'capturedAt must be a valid timestamp',
        );
      }

      capturedAt =
        parsedCapturedAt.toISOString();
    }

    return this.databaseService.withTransaction(
      async (client) => {
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

        const deliveryResult =
          await client.query<{
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
            [
              tenantId,
              deliveryId,
            ],
          );

        const delivery =
          deliveryResult.rows[0];

        if (!delivery) {
          throw new NotFoundException(
            'Delivery not found',
          );
        }

        const branchAuthorizationResult =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              driverId,
            ],
          );

        if (
          !branchAuthorizationResult.rows[0]
        ) {
          throw new ConflictException(
            'Driver is not enabled for delivery branch',
          );
        }

        if (
          ![
            'ACCEPTED',
            'PICKED_UP',
            'EN_ROUTE',
            'ARRIVED',
          ].includes(delivery.status)
        ) {
          throw new ConflictException(
            `Delivery location cannot be recorded from ${delivery.status}`,
          );
        }

        const assignmentResult =
          await client.query<{
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
            [
              delivery.tenant_id,
              delivery.branch_id,
              delivery.id,
            ],
          );

        const assignment =
          assignmentResult.rows[0];

        if (!assignment) {
          throw new ConflictException(
            'Delivery assignment state is inconsistent',
          );
        }

        if (
          assignment.driver_id !== driverId
        ) {
          throw new ConflictException(
            'Delivery is assigned to another driver',
          );
        }

        if (
          assignment.status !== 'ACCEPTED'
        ) {
          throw new ConflictException(
            'Delivery location requires accepted assignment',
          );
        }

        const locationResult =
          await client.query<{
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

        const location =
          locationResult.rows[0];

        return {
          recorded: true,

          delivery: {
            id: delivery.id,
            status: delivery.status,
          },

          assignment: {
            id: assignment.id,
            number:
              assignment.assignment_number,
            status: assignment.status,

            driver: {
              id: driverId,
            },
          },

          location: {
            id: location.id,

            latitude:
              location.latitude,

            longitude:
              location.longitude,

            accuracyMeters:
              location.accuracy_meters === null
                ? null
                : Number(
                    location.accuracy_meters,
                  ),

            headingDegrees:
              location.heading_degrees === null
                ? null
                : Number(
                    location.heading_degrees,
                  ),

            speedMps:
              location.speed_mps === null
                ? null
                : Number(
                    location.speed_mps,
                  ),

            capturedAt:
              location.captured_at,

            receivedAt:
              location.received_at,
          },
        };
      },
    );
  }
  async deliverDriverDelivery(
    deliveryIdInput: unknown,
    tenantIdInput: unknown,
    driverIdInput: unknown,
    driverCode: string,
    podInput: unknown,
  ) {
    const deliveryId =
      this.requireUuid(
        deliveryIdInput,
        'deliveryId',
      );

    const tenantId =
      this.requireUuid(
        tenantIdInput,
        'tenantId',
      );

    const driverId =
      this.requireUuid(
        driverIdInput,
        'driverId',
      );

    // ------------------------------------------------------
    // Malformed POD input is rejected before the transaction.
    //
    // Only a string containing exactly four decimal digits
    // is an online verification attempt.
    //
    // Therefore malformed input never consumes an attempt.
    // ------------------------------------------------------

    if (
      typeof podInput !== 'string' ||
      !/^[0-9]{4}$/.test(podInput)
    ) {
      throw new BadRequestException(
        'pod must be exactly four digits',
      );
    }

    const submittedPod =
      podInput;

    const safeDriverCode =
      driverCode?.trim() || 'DRIVER';

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

    const outcome =
      await this.databaseService.withTransaction(
        async (client) => {
          const deliveryResult =
            await client.query<{
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
              [
                tenantId,
                deliveryId,
              ],
            );

          const delivery =
            deliveryResult.rows[0];

          if (!delivery) {
            throw new NotFoundException(
              'Delivery not found',
            );
          }

          // --------------------------------------------------
          // Driver must still be ENABLED for the branch.
          // This is intentionally checked on every mutation,
          // including an idempotent delivered retry.
          // --------------------------------------------------

          const branchAuthorizationResult =
            await client.query<{
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
              [
                delivery.tenant_id,
                delivery.branch_id,
                driverId,
              ],
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
              'Delivery cannot be delivered from ' +
                delivery.delivery_status,
            );
          }

          const assignmentResult =
            await client.query<{
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
              [
                delivery.tenant_id,
                delivery.branch_id,
                delivery.id,
              ],
            );

          const assignment =
            assignmentResult.rows[0];

          if (!assignment) {
            throw new ConflictException(
              'Delivery assignment state is inconsistent',
            );
          }

          if (
            assignment.driver_id !==
            driverId
          ) {
            throw new ConflictException(
              'Delivery is assigned to another driver',
            );
          }

          const challengeResult =
            await client.query<{
              id: string;

              status: string;

              failed_attempts: number;

              locked_at:
                | string
                | Date
                | null;

              verified_at:
                | string
                | Date
                | null;

              verified_by_driver_id:
                | string
                | null;
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
              [
                delivery.tenant_id,
                delivery.branch_id,
                delivery.id,
              ],
            );

          const challenge =
            challengeResult.rows[0];

          if (!challenge) {
            throw new ConflictException(
              'Delivery POD challenge is not available',
            );
          }

          if (
            ![
              'PAID',
              'NOT_REQUIRED',
            ].includes(
              delivery.payment_status,
            )
          ) {
            throw new ConflictException(
              'Delivery cannot be completed until payment is verified',
            );
          }

          // --------------------------------------------------
          // Same authenticated owner may retry an already
          // completed delivery idempotently.
          //
          // The POD is NOT revalidated because VERIFIED is
          // terminal and the assignment owner is already known.
          // --------------------------------------------------

          if (
            delivery.delivery_status ===
            'DELIVERED'
          ) {
            if (
              delivery.order_status !==
                'COMPLETED' ||
              assignment.status !==
                'COMPLETED' ||
              !assignment.completed_at ||
              challenge.status !==
                'VERIFIED' ||
              !challenge.verified_at ||
              challenge.verified_by_driver_id !==
                driverId
            ) {
              throw new ConflictException(
                'Delivered state is inconsistent',
              );
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
                  number:
                    delivery.order_number,

                  status: 'COMPLETED',
                },

                assignment: {
                  id: assignment.id,

                  number:
                    assignment.assignment_number,

                  status: 'COMPLETED',

                  assignedAt:
                    assignment.assigned_at,

                  acceptedAt:
                    assignment.accepted_at,

                  completedAt:
                    assignment.completed_at,

                  driver: {
                    id: driverId,
                    code: safeDriverCode,
                  },
                },

                pod: {
                  status: 'VERIFIED',

                  verifiedAt:
                    challenge.verified_at,
                },
              },
            };
          }

          if (
            delivery.order_status !==
            'READY'
          ) {
            throw new ConflictException(
              'Delivery cannot be completed while order is ' +
                delivery.order_status,
            );
          }

          if (
            assignment.status !==
              'ACCEPTED' ||
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

          if (
            challenge.status ===
            'LOCKED'
          ) {
            return {
              kind: 'LOCKED' as const,

              failedAttempts:
                challenge.failed_attempts,
            };
          }

          if (
            challenge.status !==
            'ACTIVE'
          ) {
            throw new ConflictException(
              'Delivery POD challenge state is inconsistent',
            );
          }

          const podMatches =
            verifyDeliveryPod(
              {
                tenantId:
                  delivery.tenant_id,

                branchId:
                  delivery.branch_id,

                deliveryId:
                  delivery.id,

                deliveryTrackingToken:
                  delivery.delivery_tracking_token,
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
            const nextFailedAttempts =
              challenge.failed_attempts + 1;

            if (
              nextFailedAttempts < 1 ||
              nextFailedAttempts > 5
            ) {
              throw new ConflictException(
                'Delivery POD attempt state is inconsistent',
              );
            }

            const attemptUpdate =
              await client.query<{
                status: string;

                failed_attempts: number;

                locked_at:
                  | string
                  | Date
                  | null;
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

            const updatedAttempt =
              attemptUpdate.rows[0];

            if (!updatedAttempt) {
              throw new ConflictException(
                'Delivery POD challenge changed concurrently',
              );
            }

            return {
              kind: 'INVALID_POD' as const,

              failedAttempts:
                updatedAttempt.failed_attempts,

              locked:
                updatedAttempt.status ===
                'LOCKED',
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

          const challengeUpdate =
            await client.query<{
              verified_at:
                | string
                | Date;
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
              [
                delivery.tenant_id,
                delivery.branch_id,
                delivery.id,

                driverId,
              ],
            );

          const verifiedChallenge =
            challengeUpdate.rows[0];

          if (!verifiedChallenge) {
            throw new ConflictException(
              'Delivery POD challenge changed concurrently',
            );
          }

          const deliveryUpdate =
            await client.query<{
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
              [
                delivery.tenant_id,
                delivery.branch_id,
                delivery.id,
              ],
            );

          if (!deliveryUpdate.rows[0]) {
            throw new ConflictException(
              'Delivery status changed concurrently',
            );
          }

          const assignmentUpdate =
            await client.query<{
              completed_at:
                | string
                | Date;
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
              [
                delivery.tenant_id,
                delivery.branch_id,
                assignment.id,

                driverId,
              ],
            );

          const completedAssignment =
            assignmentUpdate.rows[0];

          if (!completedAssignment) {
            throw new ConflictException(
              'Delivery assignment changed concurrently',
            );
          }

          const orderUpdate =
            await client.query<{
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
              [
                delivery.tenant_id,
                delivery.branch_id,
                delivery.order_id,
              ],
            );

          if (!orderUpdate.rows[0]) {
            throw new ConflictException(
              'Order status changed concurrently',
            );
          }

          const eventResult =
            await client.query<{
              created_at:
                | string
                | Date;
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

          const deliveredEvent =
            eventResult.rows[0];

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

                deliveredAt:
                  deliveredEvent.created_at,
              },

              order: {
                id: delivery.order_id,
                number:
                  delivery.order_number,

                status: 'COMPLETED',
              },

              assignment: {
                id: assignment.id,

                number:
                  assignment.assignment_number,

                status: 'COMPLETED',

                assignedAt:
                  assignment.assigned_at,

                acceptedAt:
                  assignment.accepted_at,

                completedAt:
                  completedAssignment.completed_at,

                driver: {
                  id: driverId,
                  code: safeDriverCode,
                },
              },

              pod: {
                status: 'VERIFIED',

                verifiedAt:
                  verifiedChallenge.verified_at,
              },
            },
          };
        },
      );

    // ------------------------------------------------------
    // These exceptions are intentionally OUTSIDE the DB
    // transaction so failed attempt updates are committed.
    // ------------------------------------------------------

    if (
      outcome.kind ===
      'LOCKED'
    ) {
      throw new HttpException(
        {
          statusCode:
            HttpStatus.TOO_MANY_REQUESTS,

          message:
            'Delivery POD challenge is locked',

          failedAttempts:
            outcome.failedAttempts,

          attemptsRemaining: 0,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (
      outcome.kind ===
      'INVALID_POD'
    ) {
      if (outcome.locked) {
        throw new HttpException(
          {
            statusCode:
              HttpStatus.TOO_MANY_REQUESTS,

            message:
              'Delivery POD challenge is locked',

            failedAttempts:
              outcome.failedAttempts,

            attemptsRemaining: 0,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new ConflictException({
        message:
          'Invalid delivery POD',

        failedAttempts:
          outcome.failedAttempts,

        attemptsRemaining:
          5 - outcome.failedAttempts,
      });
    }

    return outcome.response;
  }
  async getPublicDeliveryLocationByOrderTrackingToken(
    trackingToken: string,
  ) {
    const result =
      await this.databaseService.query<{
        delivery_status: string;

        latitude: number | null;
        longitude: number | null;

        accuracy_meters: string | null;
        heading_degrees: string | null;
        speed_mps: string | null;

        captured_at: string | Date | null;
      }>(
        `
          select
            d.status
              as delivery_status,

            loc.latitude,
            loc.longitude,

            loc.accuracy_meters,
            loc.heading_degrees,
            loc.speed_mps,

            loc.captured_at

          from public.orders o

          inner join public.deliveries d
            on d.tenant_id = o.tenant_id
           and d.branch_id = o.branch_id
           and d.order_id = o.id

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

              l.accuracy_meters::text,
              l.heading_degrees::text,
              l.speed_mps::text,

              l.captured_at

            from public.delivery_driver_locations l

            where l.tenant_id = d.tenant_id
              and l.branch_id = d.branch_id
              and l.delivery_id = d.id
              and l.captured_at <= l.received_at + interval '5 minutes'
              and l.captured_at >= l.received_at - interval '24 hours'

            order by
              l.received_at desc,
              l.captured_at desc

            limit 1
          ) loc
            on d.status in (
              'ACCEPTED',
              'PICKED_UP',
              'EN_ROUTE',
              'ARRIVED'
            )

          where o.tracking_token = $1::uuid
            and o.order_type = 'DELIVERY'

          limit 1
        `,
        [
          trackingToken,
        ],
      );

    const row =
      result.rows[0];

    if (!row) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    const hasLocation =
      row.latitude !== null &&
      row.longitude !== null &&
      row.captured_at !== null;

    return {
      delivery: {
        status:
          row.delivery_status,
      },

      location:
        !hasLocation
          ? null
          : {
              latitude:
                row.latitude,

              longitude:
                row.longitude,

              accuracyMeters:
                row.accuracy_meters === null
                  ? null
                  : Number(
                      row.accuracy_meters,
                    ),

              headingDegrees:
                row.heading_degrees === null
                  ? null
                  : Number(
                      row.heading_degrees,
                    ),

              speedMps:
                row.speed_mps === null
                  ? null
                  : Number(
                      row.speed_mps,
                    ),

              capturedAt:
                row.captured_at,
            },
    };
  }
  async getPublicDeliveryPodByOrderTrackingToken(
    trackingTokenInput: unknown,
  ) {
    const trackingToken =
      this.requireUuid(
        trackingTokenInput,
        'trackingToken',
      );

    const result =
      await this.databaseService.query<{
        tenant_id: string;
        branch_id: string;

        delivery_id: string;
        delivery_tracking_token: string;

        delivery_status: string;

        pod_status: string | null;
      }>(
        `
          select
            d.tenant_id::text,
            d.branch_id::text,

            d.id::text
              as delivery_id,

            d.tracking_token::text
              as delivery_tracking_token,

            d.status
              as delivery_status,

            p.status
              as pod_status

          from public.orders o

          inner join public.deliveries d
            on d.tenant_id = o.tenant_id
           and d.branch_id = o.branch_id
           and d.order_id = o.id

          left join public.delivery_pod_challenges p
            on p.tenant_id = d.tenant_id
           and p.branch_id = d.branch_id
           and p.delivery_id = d.id

          where o.tracking_token = $1::uuid
            and o.order_type = 'DELIVERY'

          limit 1
        `,
        [
          trackingToken,
        ],
      );

    const delivery =
      result.rows[0];

    if (!delivery) {
      throw new NotFoundException(
        'Delivery not found',
      );
    }

    // POD is intentionally unavailable while the delivery
    // is still in transit.
    if (
      delivery.delivery_status !== 'ARRIVED'
    ) {
      throw new ConflictException(
        'Delivery POD is available only after arrival',
      );
    }

    if (!delivery.pod_status) {
      throw new ConflictException(
        'Delivery POD challenge is not available',
      );
    }

    if (
      delivery.pod_status === 'LOCKED'
    ) {
      throw new ConflictException(
        'Delivery POD challenge is locked',
      );
    }

    if (
      delivery.pod_status === 'VERIFIED'
    ) {
      throw new ConflictException(
        'Delivery POD challenge is already verified',
      );
    }

    if (
      delivery.pod_status !== 'ACTIVE'
    ) {
      throw new ConflictException(
        'Delivery POD challenge state is invalid',
      );
    }

    const code =
      deriveDeliveryPod({
        tenantId:
          delivery.tenant_id,

        branchId:
          delivery.branch_id,

        deliveryId:
          delivery.delivery_id,

        deliveryTrackingToken:
          delivery.delivery_tracking_token,
      });

    return {
      delivery: {
        id:
          delivery.delivery_id,

        status:
          delivery.delivery_status,
      },

      pod: {
        status:
          'ACTIVE',

        // Always a string so leading zeroes are preserved.
        code,
      },
    };
  }
  async getOperationalDeliveries(
    tenantCodeInput?: string,
    branchCodeInput?: string,
    statusInput?: string,
  ) {
    const tenantCode = this.requireCode(
      tenantCodeInput,
      'tenant',
    );

    const branchCode = this.requireCode(
      branchCodeInput,
      'branch',
    );

    const deliveryStatus = (
      statusInput?.trim().toUpperCase() ||
      'WAITING_ASSIGNMENT'
    );

    const allowedStatuses = new Set([
      'CREATED',
      'WAITING_ASSIGNMENT',
      'ASSIGNED',
      'ACCEPTED',
      'PICKED_UP',
      'EN_ROUTE',
      'ARRIVED',
      'DELIVERED',
      'FAILED',
      'CANCELLED',
    ]);

    if (!allowedStatuses.has(deliveryStatus)) {
      throw new BadRequestException(
        'Invalid delivery status',
      );
    }

    const branchResult =
      await this.databaseService.query<{
        tenant_id: string;
        branch_id: string;
        branch_name: string;
      }>(
        `
          select
            t.id::text as tenant_id,
            b.id::text as branch_id,
            b.name as branch_name

          from public.tenants t

          inner join public.branches b
            on b.tenant_id = t.id

          where t.code = $1
            and b.code = $2
            and t.status = 'ACTIVE'
            and b.status = 'ACTIVE'

          limit 1
        `,
        [
          tenantCode,
          branchCode,
        ],
      );

    const branch = branchResult.rows[0];

    if (!branch) {
      throw new NotFoundException(
        'Tenant or branch not found',
      );
    }

    const result =
      await this.databaseService.query<{
        delivery_id: string;
        delivery_tracking_token: string;
        delivery_status: string;

        recipient_name: string;
        recipient_phone: string;

        address_text: string;
        address_reference: string | null;

        quoted_delivery_fee: string;

        eta_min_minutes: number | null;
        eta_max_minutes: number | null;

        delivery_created_at: string | Date;
        delivery_updated_at: string | Date;

        zone_code: string;
        zone_name: string;

        order_id: string;
        order_number: string;
        order_status: string;
        payment_status: string;
        order_total: string;

        assignment_id: string | null;
        assignment_number: number | null;
        assignment_status: string | null;

        driver_id: string | null;
        driver_code: string | null;
        driver_name: string | null;
      }>(
        `
          select
            d.id::text
              as delivery_id,

            d.tracking_token::text
              as delivery_tracking_token,

            d.status
              as delivery_status,

            d.recipient_name,
            d.recipient_phone,

            d.address_text,
            d.address_reference,

            d.quoted_delivery_fee::text,

            d.eta_min_minutes,
            d.eta_max_minutes,

            d.created_at
              as delivery_created_at,

            d.updated_at
              as delivery_updated_at,

            z.code
              as zone_code,

            z.name
              as zone_name,

            o.id::text
              as order_id,

            o.order_number::text
              as order_number,

            o.status
              as order_status,

            o.payment_status,

            o.total::text
              as order_total,

            active_assignment.id::text
              as assignment_id,

            active_assignment.assignment_number,

            active_assignment.status
              as assignment_status,

            drv.id::text
              as driver_id,

            drv.code
              as driver_code,

            drv.display_name
              as driver_name

          from public.deliveries d

          inner join public.orders o
            on o.tenant_id = d.tenant_id
           and o.branch_id = d.branch_id
           and o.id = d.order_id

          inner join public.delivery_zones z
            on z.tenant_id = d.tenant_id
           and z.branch_id = d.branch_id
           and z.id = d.zone_id

          left join lateral (
            select
              a.id,
              a.driver_id,
              a.assignment_number,
              a.status

            from public.delivery_assignments a

            where a.tenant_id = d.tenant_id
              and a.branch_id = d.branch_id
              and a.delivery_id = d.id
              and a.status in (
                'ASSIGNED',
                'ACCEPTED'
              )

            order by
              a.assignment_number desc

            limit 1
          ) active_assignment
            on true

          left join public.delivery_drivers drv
            on drv.tenant_id = d.tenant_id
           and drv.id =
              active_assignment.driver_id

          where d.tenant_id = $1::uuid
            and d.branch_id = $2::uuid
            and d.status = $3

          order by
            d.created_at asc,
            d.id asc
        `,
        [
          branch.tenant_id,
          branch.branch_id,
          deliveryStatus,
        ],
      );

    return {
      tenant: tenantCode,

      branch: {
        code: branchCode,
        name: branch.branch_name,
      },

      status: deliveryStatus,

      total: result.rows.length,

      deliveries: result.rows.map((row) => ({
        id: row.delivery_id,

        trackingToken:
          row.delivery_tracking_token,

        status:
          row.delivery_status,

        order: {
          id: row.order_id,
          orderNumber: row.order_number,
          status: row.order_status,
          paymentStatus: row.payment_status,
          total: Number(row.order_total),
        },

        recipient: {
          name: row.recipient_name,
          phone: row.recipient_phone,
        },

        destination: {
          address: row.address_text,
          reference: row.address_reference,
        },

        zone: {
          code: row.zone_code,
          name: row.zone_name,
        },

        quote: {
          deliveryFee:
            Number(row.quoted_delivery_fee),

          eta: {
            minMinutes:
              row.eta_min_minutes,

            maxMinutes:
              row.eta_max_minutes,
          },
        },

        assignment:
          row.assignment_id
            ? {
                id: row.assignment_id,

                number:
                  row.assignment_number,

                status:
                  row.assignment_status,

                driver: {
                  id: row.driver_id,
                  code: row.driver_code,
                  name: row.driver_name,
                },
              }
            : null,

        createdAt:
          row.delivery_created_at,

        updatedAt:
          row.delivery_updated_at,
      })),
    };
  }

  async getOperationalDrivers(
    tenantCodeInput?: string,
    branchCodeInput?: string,
  ) {
    const tenantCode = this.requireCode(
      tenantCodeInput,
      'tenant',
    );

    const branchCode = this.requireCode(
      branchCodeInput,
      'branch',
    );

    const branchResult =
      await this.databaseService.query<{
        tenant_id: string;
        branch_id: string;
        branch_name: string;
      }>(
        `
          select
            t.id::text as tenant_id,
            b.id::text as branch_id,
            b.name as branch_name

          from public.tenants t

          inner join public.branches b
            on b.tenant_id = t.id

          where t.code = $1
            and b.code = $2
            and t.status = 'ACTIVE'
            and b.status = 'ACTIVE'

          limit 1
        `,
        [
          tenantCode,
          branchCode,
        ],
      );

    const branch = branchResult.rows[0];

    if (!branch) {
      throw new NotFoundException(
        'Tenant or branch not found',
      );
    }

    const result =
      await this.databaseService.query<{
        id: string;
        code: string;
        display_name: string;
        phone: string;
        driver_status: string;
        branch_status: string;
        active_assignments: number;
      }>(
        `
          select
            drv.id::text,
            drv.code,
            drv.display_name,
            drv.phone,

            drv.status
              as driver_status,

            db.status
              as branch_status,

            coalesce(
              active_work.active_assignments,
              0
            )::integer
              as active_assignments

          from public.delivery_driver_branches db

          inner join public.delivery_drivers drv
            on drv.tenant_id = db.tenant_id
           and drv.id = db.driver_id

          left join lateral (
            select
              count(*)::integer
                as active_assignments

            from public.delivery_assignments a

            where a.tenant_id = db.tenant_id
              and a.branch_id = db.branch_id
              and a.driver_id = drv.id
              and a.status in (
                'ASSIGNED',
                'ACCEPTED'
              )
          ) active_work
            on true

          where db.tenant_id = $1::uuid
            and db.branch_id = $2::uuid

            and drv.status = 'ACTIVE'
            and db.status = 'ENABLED'

          order by
            drv.display_name,
            drv.code,
            drv.id
        `,
        [
          branch.tenant_id,
          branch.branch_id,
        ],
      );

    return {
      tenant: tenantCode,

      branch: {
        code: branchCode,
        name: branch.branch_name,
      },

      total: result.rows.length,

      drivers: result.rows.map((row) => ({
        id: row.id,
        code: row.code,

        displayName:
          row.display_name,

        phone:
          row.phone,

        status:
          row.driver_status,

        branchStatus:
          row.branch_status,

        activeAssignments:
          row.active_assignments,
      })),
    };
  }
  private async calculatePublicDeliveryRoute(
    branch: DeliveryBranchRow,
    destination: GeoPoint,
  ): Promise<GeoRouteResult> {
    const origin =
      this.requireDeliveryBranchOrigin(
        branch,
      );

    return this.geoProvider.calculateRoute({
      origin,
      destination,
    });
  }

  private requireDeliveryBranchOrigin(
    branch: DeliveryBranchRow,
  ): GeoPoint {
    const latitudeValue =
      branch.delivery_origin_latitude;

    const longitudeValue =
      branch.delivery_origin_longitude;

    if (
      latitudeValue === null ||
      longitudeValue === null
    ) {
      throw new ServiceUnavailableException(
        'Delivery branch origin coordinates are not configured',
      );
    }

    const latitude =
      Number(latitudeValue);

    const longitude =
      Number(longitudeValue);

    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new ServiceUnavailableException(
        'Delivery branch origin coordinates are invalid',
      );
    }

    return {
      latitude,
      longitude,
    };
  }

  private validateDeliveryRouteMetrics(
    distanceMeters: number,
    durationSeconds: number,
  ): void {
    if (
      !Number.isSafeInteger(distanceMeters) ||
      distanceMeters < 0 ||
      distanceMeters > 2147483647
    ) {
      throw new ServiceUnavailableException(
        'Delivery route distance is invalid',
      );
    }

    if (
      !Number.isSafeInteger(durationSeconds) ||
      durationSeconds < 0
    ) {
      throw new ServiceUnavailableException(
        'Delivery route duration is invalid',
      );
    }
  }

  private requireCurrentDeliveryRouteSnapshot(
    snapshot: DeliveryCheckoutRouteSnapshot,
    branch: DeliveryBranchRow,
    latitude: number,
    longitude: number,
  ): DeliveryCheckoutRouteSnapshot {
    if (
      !snapshot ||
      typeof snapshot !== 'object'
    ) {
      throw new ConflictException(
        'Delivery route snapshot is missing',
      );
    }

    if (
      snapshot.tenantId !== branch.tenant_id ||
      snapshot.branchId !== branch.branch_id
    ) {
      throw new ConflictException(
        'Delivery route snapshot belongs to another branch',
      );
    }

    const origin =
      this.requireDeliveryBranchOrigin(
        branch,
      );

    if (
      snapshot.origin.latitude !== origin.latitude ||
      snapshot.origin.longitude !== origin.longitude
    ) {
      throw new ConflictException(
        'Delivery route snapshot is stale; branch origin changed',
      );
    }

    if (
      snapshot.destination.latitude !== latitude ||
      snapshot.destination.longitude !== longitude
    ) {
      throw new ConflictException(
        'Delivery route snapshot destination changed',
      );
    }

    this.validateDeliveryRouteMetrics(
      snapshot.distanceMeters,
      snapshot.durationSeconds,
    );

    return snapshot;
  }
  private buildRouteAwareEta(
    branch: DeliveryBranchRow,
    zone: DeliveryZoneRow,
    durationSeconds: number,
  ): {
    minMinutes: number;
    maxMinutes: number;
  } {
    const prepMinutes =
      branch.delivery_default_prep_minutes;

    if (
      !Number.isSafeInteger(prepMinutes) ||
      prepMinutes < 0 ||
      prepMinutes > 480
    ) {
      throw new ServiceUnavailableException(
        'Delivery branch preparation time is invalid',
      );
    }

    if (
      !Number.isSafeInteger(durationSeconds) ||
      durationSeconds < 0
    ) {
      throw new ServiceUnavailableException(
        'Delivery route duration is invalid',
      );
    }

    if (
      !Number.isSafeInteger(zone.eta_min_minutes) ||
      !Number.isSafeInteger(zone.eta_max_minutes) ||
      zone.eta_min_minutes < 1 ||
      zone.eta_max_minutes < zone.eta_min_minutes ||
      zone.eta_max_minutes > 480
    ) {
      throw new ServiceUnavailableException(
        'Delivery zone ETA configuration is invalid',
      );
    }

    const travelMinutes =
      Math.max(
        1,
        Math.ceil(
          durationSeconds / 60,
        ),
      );

    const routeReadyMinutes =
      prepMinutes +
      travelMinutes;

    const minMinutes =
      Math.max(
        zone.eta_min_minutes,
        routeReadyMinutes,
      );

    const maxMinutes =
      Math.max(
        zone.eta_max_minutes,
        minMinutes,
      );

    if (
      !Number.isSafeInteger(minMinutes) ||
      !Number.isSafeInteger(maxMinutes) ||
      minMinutes > 480 ||
      maxMinutes > 480
    ) {
      throw new ServiceUnavailableException(
        'Calculated delivery ETA exceeds supported range',
      );
    }

    return {
      minMinutes,
      maxMinutes,
    };
  }
  private buildUnavailableResponse(
    branch: DeliveryBranchRow,
    reason: 'DELIVERY_DISABLED' | 'OUTSIDE_DELIVERY_AREA',
  ): DeliveryQuoteResponse {
    return {
      available: false,
      reason,

      branch: {
        code: branch.branch_code,
        name: branch.branch_name,
      },

      zone: null,

      deliveryFee: null,
      minimumOrder: null,
      minimumOrderMissing: null,

      eta: null,
      route: null,
    };
  }

  private requireUuid(
    value: unknown,
    field: string,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(
        `${field} is required`,
      );
    }

    const normalized =
      value.trim().toLowerCase();

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        normalized,
      )
    ) {
      throw new BadRequestException(
        `${field} is invalid`,
      );
    }

    return normalized;
  }

  private optionalUuid(
    value: unknown,
    field: string,
  ): string | null {
    if (
      value === undefined ||
      value === null ||
      value === ''
    ) {
      return null;
    }

    return this.requireUuid(
      value,
      field,
    );
  }
  private requireCode(value: unknown, field: string): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }

    const normalized = value.trim();

    if (
      normalized.length < 2 ||
      normalized.length > 40 ||
      !/^[A-Za-z0-9_-]+$/.test(normalized)
    ) {
      throw new BadRequestException(`${field} is invalid`);
    }

    return normalized;
  }

  private requireCoordinate(
    value: unknown,
    field: string,
    minimum: number,
    maximum: number,
  ): number {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new BadRequestException(`${field} is invalid`);
    }

    return value;
  }

  private requireSubtotal(value: unknown): number {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 999_999_999.99
    ) {
      throw new BadRequestException('subtotal is invalid');
    }

    return this.roundMoney(value);
  }

  private databaseMoneyToNumber(value: string, field: string): number {
    const normalized = Number(value);

    if (!Number.isFinite(normalized) || normalized < 0) {
      throw new Error(`Invalid ${field} stored in database`);
    }

    return this.roundMoney(normalized);
  }

  private roundMoney(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
