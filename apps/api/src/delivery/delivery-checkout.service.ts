import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type PoolClient } from 'pg';
import { DatabaseService } from '../core/database/database.service';
import { GEO_PROVIDER, type GeoProvider } from './geo-provider';
import { GeoUsageMeterService } from './geo-usage-meter.service';
import {
  type CreatedDelivery,
  type DeliveryCheckoutQuote,
  type DeliveryCheckoutRouteSnapshot,
  type DeliveryQuoteInput,
  type DeliveryQuoteResponse,
} from './delivery.types';
import { DeliveryBranchRow, DeliveryZoneRow } from './delivery-internal.types';
import {
  requireDeliveryBranchOrigin,
  validateDeliveryRouteMetrics,
  requireCurrentDeliveryRouteSnapshot,
  buildRouteAwareEta,
  buildUnavailableResponse,
  requireUuid,
  requireCode,
  requireCoordinate,
  requireSubtotal,
  databaseMoneyToNumber,
  roundMoney,
} from './delivery-helpers';
import { DeliveryRoutingService } from './delivery-routing.service';

@Injectable()
export class DeliveryCheckoutService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly geoUsageMeter: GeoUsageMeterService,
    @Inject(GEO_PROVIDER) private readonly geoProvider: GeoProvider,
    private readonly routing: DeliveryRoutingService,
  ) {}

  async quoteDelivery(
    input: DeliveryQuoteInput,
  ): Promise<DeliveryQuoteResponse> {
    const tenantCode = requireCode(input.tenantCode, 'tenantCode');

    const branchCode = requireCode(input.branchCode, 'branchCode');

    const latitude = requireCoordinate(input.latitude, 'latitude', -90, 90);

    const longitude = requireCoordinate(
      input.longitude,
      'longitude',
      -180,
      180,
    );

    const subtotal = requireSubtotal(input.subtotal);

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
      return buildUnavailableResponse(branch, 'DELIVERY_DISABLED');
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
      return buildUnavailableResponse(branch, 'OUTSIDE_DELIVERY_AREA');
    }

    const deliveryFee = databaseMoneyToNumber(
      zone.delivery_fee,
      'delivery_fee',
    );

    const minimumOrder = databaseMoneyToNumber(
      zone.minimum_order,
      'minimum_order',
    );

    const minimumOrderMissing = Math.max(
      0,
      roundMoney(minimumOrder - subtotal),
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

    const route = await this.routing.calculatePublicDeliveryRoute(branch, {
      latitude,
      longitude,
    });

    const routeAwareEta = buildRouteAwareEta(
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

  async prepareDeliveryCheckoutRoute(input: {
    tenantId: string;
    branchId: string;
    latitude: unknown;
    longitude: unknown;
    subtotal: number;
  }): Promise<DeliveryCheckoutRouteSnapshot> {
    const tenantId = requireUuid(input.tenantId, 'tenantId');

    const branchId = requireUuid(input.branchId, 'branchId');

    const latitude = requireCoordinate(
      input.latitude,
      'deliveryLatitude',
      -90,
      90,
    );

    const longitude = requireCoordinate(
      input.longitude,
      'deliveryLongitude',
      -180,
      180,
    );

    const subtotal = requireSubtotal(input.subtotal);

    const branchResult = await this.databaseService.query<DeliveryBranchRow>(
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
      [tenantId, branchId],
    );

    const branch = branchResult.rows[0];

    if (!branch) {
      throw new NotFoundException('Branch not found for delivery checkout');
    }

    if (!branch.delivery_enabled) {
      throw new ConflictException('Delivery is disabled for this branch');
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
      [tenantId, branchId, longitude, latitude],
    );

    const zone = zoneResult.rows[0];

    if (!zone) {
      throw new ConflictException(
        'Delivery address is outside the delivery area',
      );
    }

    const minimumOrder = databaseMoneyToNumber(
      zone.minimum_order,
      'minimum_order',
    );

    const minimumOrderMissing = roundMoney(minimumOrder - subtotal);

    if (minimumOrderMissing > 0) {
      throw new ConflictException(
        `Minimum delivery order not met: ${minimumOrderMissing.toFixed(2)} BOB missing`,
      );
    }

    const origin = requireDeliveryBranchOrigin(branch);

    const destination = {
      latitude,
      longitude,
    };

    const route = await this.geoUsageMeter.measure(
      { tenantId, provider: 'GOOGLE', operation: 'ROUTE', cacheHit: false },
      () =>
        this.geoProvider.calculateRoute({
          origin,
          destination,
        }),
    );

    validateDeliveryRouteMetrics(route.distanceMeters, route.durationSeconds);

    buildRouteAwareEta(branch, zone, route.durationSeconds);

    return {
      tenantId,
      branchId,

      origin,
      destination,

      distanceMeters: route.distanceMeters,

      durationSeconds: route.durationSeconds,
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
    const latitude = requireCoordinate(
      input.latitude,
      'deliveryLatitude',
      -90,
      90,
    );

    const longitude = requireCoordinate(
      input.longitude,
      'deliveryLongitude',
      -180,
      180,
    );

    const subtotal = requireSubtotal(input.subtotal);

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

    const routeSnapshot = requireCurrentDeliveryRouteSnapshot(
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

    const deliveryFee = databaseMoneyToNumber(
      zone.delivery_fee,
      'delivery_fee',
    );

    const minimumOrder = databaseMoneyToNumber(
      zone.minimum_order,
      'minimum_order',
    );

    const minimumOrderMissing = roundMoney(minimumOrder - subtotal);

    if (minimumOrderMissing > 0) {
      throw new ConflictException(
        `Minimum delivery order not met: ${minimumOrderMissing.toFixed(2)} BOB missing`,
      );
    }

    const routeAwareEta = buildRouteAwareEta(
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
        distanceMeters: routeSnapshot.distanceMeters,

        durationSeconds: routeSnapshot.durationSeconds,
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
}
