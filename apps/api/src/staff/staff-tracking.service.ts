import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import type { StaffSessionPrincipal } from './staff.types';

type TrackingDeliveryStatus =
  | 'PICKED_UP'
  | 'EN_ROUTE'
  | 'ARRIVED'
  | 'DELIVERED';

interface TrackingDeliveryRow {
  delivery_id: string;
  tracking_token: string;
  delivery_status: TrackingDeliveryStatus;

  recipient_name: string;
  recipient_phone: string;
  address_text: string;
  address_reference: string | null;

  quoted_delivery_fee: string;
  distance_meters: number | null;
  eta_min_minutes: number | null;
  eta_max_minutes: number | null;

  delivery_created_at: string | Date;
  delivery_updated_at: string | Date;

  order_id: string;
  order_number: string;
  order_status: string;
  payment_status: string;
  currency: string;
  order_total: string;

  assignment_id: string | null;
  assignment_number: number | null;
  assignment_status: string | null;
  assigned_at: string | Date | null;
  accepted_at: string | Date | null;
  completed_at: string | Date | null;

  driver_id: string | null;
  driver_code: string | null;
  driver_name: string | null;

  picked_up_at: string | Date | null;
  en_route_at: string | Date | null;
  arrived_at: string | Date | null;
  delivered_at: string | Date | null;

  gps_captured_at: string | Date | null;
  gps_received_at: string | Date | null;
}

@Injectable()
export class StaffTrackingService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getBranchTracking(staff: StaffSessionPrincipal) {
    const active = await this.queryDeliveries(
      staff,
      ['PICKED_UP', 'EN_ROUTE', 'ARRIVED'],
      200,
    );

    const delivered = await this.queryDeliveries(
      staff,
      ['DELIVERED'],
      100,
    );

    return {
      tenant: {
        id: staff.tenantId,
        code: staff.tenantCode,
      },

      branch: {
        id: staff.branchId,
        code: staff.branchCode,
      },

      generatedAt: new Date().toISOString(),

      summary: {
        active: active.length,
        delivered: delivered.length,
      },

      active,
      delivered,
    };
  }

  private async queryDeliveries(
    staff: StaffSessionPrincipal,
    statuses: TrackingDeliveryStatus[],
    limit: number,
  ) {
    const result =
      await this.databaseService.query<TrackingDeliveryRow>(
        `
          select
            d.id::text as delivery_id,
            d.tracking_token::text as tracking_token,
            d.status as delivery_status,

            d.recipient_name,
            d.recipient_phone,
            d.address_text,
            d.address_reference,

            d.quoted_delivery_fee::text,
            d.distance_meters,
            d.eta_min_minutes,
            d.eta_max_minutes,

            d.created_at as delivery_created_at,
            d.updated_at as delivery_updated_at,

            o.id::text as order_id,
            o.order_number::text as order_number,
            o.status as order_status,
            o.payment_status,
            o.currency,
            o.total::text as order_total,

            latest_assignment.id::text as assignment_id,
            latest_assignment.assignment_number,
            latest_assignment.status as assignment_status,
            latest_assignment.assigned_at,
            latest_assignment.accepted_at,
            latest_assignment.completed_at,

            drv.id::text as driver_id,
            drv.code as driver_code,
            drv.display_name as driver_name,

            delivery_times.picked_up_at,
            delivery_times.en_route_at,
            delivery_times.arrived_at,
            delivery_times.delivered_at,

            latest_location.captured_at as gps_captured_at,
            latest_location.received_at as gps_received_at

          from public.deliveries d

          inner join public.orders o
            on o.tenant_id = d.tenant_id
           and o.branch_id = d.branch_id
           and o.id = d.order_id

          left join lateral (
            select
              a.id,
              a.driver_id,
              a.assignment_number,
              a.status,
              a.assigned_at,
              a.accepted_at,
              a.completed_at

            from public.delivery_assignments a

            where a.tenant_id = d.tenant_id
              and a.branch_id = d.branch_id
              and a.delivery_id = d.id

            order by
              a.assignment_number desc,
              a.created_at desc

            limit 1
          ) latest_assignment
            on true

          left join public.delivery_drivers drv
            on drv.tenant_id = d.tenant_id
           and drv.id = latest_assignment.driver_id

          left join lateral (
            select
              max(e.created_at)
                filter (
                  where e.event_type = 'DRIVER_PICKED_UP'
                ) as picked_up_at,

              max(e.created_at)
                filter (
                  where e.event_type = 'DRIVER_EN_ROUTE'
                ) as en_route_at,

              max(e.created_at)
                filter (
                  where e.event_type = 'DRIVER_ARRIVED'
                ) as arrived_at,

              max(e.created_at)
                filter (
                  where e.event_type = 'DRIVER_DELIVERED'
                ) as delivered_at

            from public.delivery_events e

            where e.tenant_id = d.tenant_id
              and e.branch_id = d.branch_id
              and e.delivery_id = d.id
          ) delivery_times
            on true

          left join lateral (
            select
              l.captured_at,
              l.received_at

            from public.delivery_driver_locations l

            where l.tenant_id = d.tenant_id
              and l.branch_id = d.branch_id
              and l.delivery_id = d.id

            order by
              l.captured_at desc,
              l.received_at desc

            limit 1
          ) latest_location
            on true

          where d.tenant_id = $1::uuid
            and d.branch_id = $2::uuid
            and d.status = any($3::varchar[])

          order by
            coalesce(
              delivery_times.delivered_at,
              delivery_times.arrived_at,
              delivery_times.en_route_at,
              delivery_times.picked_up_at,
              d.updated_at
            ) desc,
            d.id desc

          limit $4
        `,
        [
          staff.tenantId,
          staff.branchId,
          statuses,
          limit,
        ],
      );

    return result.rows.map((row) => ({
      id: row.delivery_id,
      trackingToken: row.tracking_token,
      status: row.delivery_status,

      order: {
        id: row.order_id,
        orderNumber: row.order_number,
        status: row.order_status,
        paymentStatus: row.payment_status,
        currency: row.currency,
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

      quote: {
        deliveryFee: Number(row.quoted_delivery_fee),
        distanceMeters: row.distance_meters,
        eta: {
          minMinutes: row.eta_min_minutes,
          maxMinutes: row.eta_max_minutes,
        },
      },

      assignment: row.assignment_id
        ? {
            id: row.assignment_id,
            number: row.assignment_number,
            status: row.assignment_status,
            assignedAt: row.assigned_at,
            acceptedAt: row.accepted_at,
            completedAt: row.completed_at,
            driver: row.driver_id
              ? {
                  id: row.driver_id,
                  code: row.driver_code,
                  name: row.driver_name,
                }
              : null,
          }
        : null,

      timeline: {
        pickedUpAt: row.picked_up_at,
        enRouteAt: row.en_route_at,
        arrivedAt: row.arrived_at,
        deliveredAt: row.delivered_at,
      },

      latestGps:
        row.gps_captured_at || row.gps_received_at
          ? {
              capturedAt: row.gps_captured_at,
              receivedAt: row.gps_received_at,
            }
          : null,

      podVerified:
        row.delivery_status === 'DELIVERED' &&
        row.delivered_at !== null,

      createdAt: row.delivery_created_at,
      updatedAt: row.delivery_updated_at,
    }));
  }
}
