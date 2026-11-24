import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { deriveDeliveryPod } from './delivery-pod';
import { trackingBranchOrigin, requireUuid } from './delivery-helpers';
import { DeliveryRoutingService } from './delivery-routing.service';

@Injectable()
export class DeliveryPublicTrackingService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly routing: DeliveryRoutingService,
  ) {}

  async getPublicDeliveryLocationByOrderTrackingToken(
    trackingTokenInput: unknown,
  ) {
    const trackingToken = requireUuid(trackingTokenInput, 'trackingToken');

    const result = await this.databaseService.query<{
      tenant_id: string;

      order_number: string;
      order_status: string;
      order_payment_status: string;

      delivery_status: string;

      branch_name: string;
      branch_latitude: string | null;
      branch_longitude: string | null;
      destination_latitude: number;
      destination_longitude: number;

      latitude: number | null;
      longitude: number | null;

      accuracy_meters: string | null;
      heading_degrees: string | null;
      speed_mps: string | null;

      captured_at: string | Date | null;

      delivery_id: string;
    }>(
      `
          select d.id::text as delivery_id,
            d.tenant_id::text
              as tenant_id,

            o.order_number::text
              as order_number,

            o.status
              as order_status,

            o.payment_status
              as order_payment_status,

            d.status
              as delivery_status,

            coalesce(d.pickup_name, b.name) as branch_name,
            coalesce(d.pickup_latitude, b.delivery_origin_latitude)::text as branch_latitude,
            coalesce(d.pickup_longitude, b.delivery_origin_longitude)::text as branch_longitude,
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

            loc.accuracy_meters,
            loc.heading_degrees,
            loc.speed_mps,

            loc.captured_at

          from public.orders o

          inner join public.deliveries d
            on d.tenant_id = o.tenant_id
           and d.branch_id = o.branch_id
           and d.order_id = o.id

          left join public.branches b
            on b.tenant_id = d.tenant_id
           and b.id = d.branch_id

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
      [trackingToken],
    );

    const row = result.rows[0];

    if (!row) {
      throw new NotFoundException('Delivery not found');
    }

    const hasLocation =
      row.latitude !== null &&
      row.longitude !== null &&
      row.captured_at !== null;

    const destinationVisible = [
      'ASSIGNED',
      'ACCEPTED',
      'PICKED_UP',
      'EN_ROUTE',
      'ARRIVED',
      'DELIVERED',
    ].includes(row.delivery_status);

    const destination = destinationVisible
      ? {
          latitude: row.destination_latitude,

          longitude: row.destination_longitude,
        }
      : null;

    const location = !hasLocation
      ? null
      : {
          latitude: row.latitude as number,

          longitude: row.longitude as number,

          accuracyMeters:
            row.accuracy_meters === null ? null : Number(row.accuracy_meters),

          headingDegrees:
            row.heading_degrees === null ? null : Number(row.heading_degrees),

          speedMps: row.speed_mps === null ? null : Number(row.speed_mps),

          capturedAt: row.captured_at,
        };

    const branchOrigin = trackingBranchOrigin(row);
    const baseRoute = destination
      ? await this.routing.getDeliveryBaseRoute(
          row.tenant_id,
          row.delivery_id,
          branchOrigin,
          destination,
        )
      : { identity: null, status: 'HIDDEN' as const, route: null, path: [] };

    return {
      order: {
        number: row.order_number,

        status: row.order_status,

        paymentStatus: row.order_payment_status,
      },

      delivery: {
        status: row.delivery_status,
      },

      branchOrigin,
      destination,
      location,
      route: baseRoute.route,
      routeIdentity: baseRoute.identity,
      routeStatus: baseRoute.status,
    };
  }
  async getPublicDeliveryPodByOrderTrackingToken(trackingTokenInput: unknown) {
    const trackingToken = requireUuid(trackingTokenInput, 'trackingToken');

    const result = await this.databaseService.query<{
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
      [trackingToken],
    );

    const delivery = result.rows[0];

    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }

    // POD is intentionally unavailable while the delivery
    // is still in transit.
    if (delivery.delivery_status !== 'ARRIVED') {
      throw new ConflictException(
        'Delivery POD is available only after arrival',
      );
    }

    if (!delivery.pod_status) {
      throw new ConflictException('Delivery POD challenge is not available');
    }

    if (delivery.pod_status === 'LOCKED') {
      throw new ConflictException('Delivery POD challenge is locked');
    }

    if (delivery.pod_status === 'VERIFIED') {
      throw new ConflictException('Delivery POD challenge is already verified');
    }

    if (delivery.pod_status !== 'ACTIVE') {
      throw new ConflictException('Delivery POD challenge state is invalid');
    }

    const code = deriveDeliveryPod({
      tenantId: delivery.tenant_id,

      branchId: delivery.branch_id,

      deliveryId: delivery.delivery_id,

      deliveryTrackingToken: delivery.delivery_tracking_token,
    });

    return {
      delivery: {
        id: delivery.delivery_id,

        status: delivery.delivery_status,
      },

      pod: {
        status: 'ACTIVE',

        // Always a string so leading zeroes are preserved.
        code,
      },
    };
  }
}
