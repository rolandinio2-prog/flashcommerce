import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { DeliveryPublicTrackingService } from '../../delivery/delivery-public-tracking.service';
import {
  type TrackingOrderRow,
  type TrackingItemRow,
  type TrackingHistoryRow,
} from './order.types';

@Injectable()
export class OrderTrackingService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly deliveryTracking: DeliveryPublicTrackingService,
  ) {}

  // =======================================================
  // 2. TRACKING PÚBLICO DEL PEDIDO
  // =======================================================

  async getOrderTracking(trackingToken: string) {
    const orderResult = await this.databaseService.query<TrackingOrderRow>(
      `
          select
            o.id::text,
            o.order_number::text,
            o.tracking_token::text,
            o.order_group_id::text,
            o.order_type,
            o.status,
            o.payment_status,
            o.order_origin,
            o.currency,

            o.subtotal::text,
            o.discount_total::text,
            o.delivery_fee::text,
            o.total::text,

            -- ===============================================
            -- FULFILLMENT
            -- ===============================================

            o.scheduled_for,

            o.customer_name,
            o.customer_phone,
            o.table_code,
            o.delivery_address,
            o.customer_notes,

            o.reservation_id::text,
            r.reservation_code,
            r.reserved_for as reservation_reserved_for,

            o.created_at,

            t.code as tenant_code,
            t.name as tenant_name,

            b.code as branch_code,
            b.name as branch_name

          from public.orders o

          inner join public.tenants t
            on t.id = o.tenant_id

          inner join public.branches b
            on b.tenant_id = o.tenant_id
           and b.id = o.branch_id

          left join public.table_reservations r
            on r.tenant_id = o.tenant_id
           and r.branch_id = o.branch_id
           and r.id = o.reservation_id

          where o.tracking_token = $1::uuid

          limit 1
        `,
      [trackingToken],
    );

    const order = orderResult.rows[0];

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const itemsResult = await this.databaseService.query<TrackingItemRow>(
      `
          select
            oi.product_id::text,
            oi.sku_snapshot,
            oi.name_snapshot,
            oi.quantity,
            oi.unit_price::text,
            oi.line_total::text,
            oi.currency

          from public.order_items oi

          where oi.order_id = $1::uuid

          order by oi.created_at
        `,
      [order.id],
    );

    const historyResult = await this.databaseService.query<TrackingHistoryRow>(
      `
          select
            h.status,
            h.changed_at

          from public.order_status_history h

          where h.order_id = $1::uuid

          order by
            h.changed_at,
            h.id
        `,
      [order.id],
    );

    return {
      orderNumber: order.order_number,

      trackingToken: order.tracking_token,

      orderGroup: order.order_group_id,

      orderType: order.order_type,

      status: order.status,

      paymentStatus: order.payment_status,

      orderOrigin: order.order_origin,

      currency: order.currency,

      // =======================================================
      // FULFILLMENT
      // =======================================================

      fulfillment: {
        scheduledFor: order.scheduled_for,

        customerName: order.customer_name,

        customerPhone: order.customer_phone,

        tableCode: order.table_code,

        deliveryAddress: order.delivery_address,

        customerNotes: order.customer_notes,
      },

      reservation: order.reservation_id
        ? {
            id: order.reservation_id,
            reservationCode: order.reservation_code,
            reservedFor: order.reservation_reserved_for,
          }
        : null,

      tenant: {
        code: order.tenant_code,

        name: order.tenant_name,
      },

      branch: {
        code: order.branch_code,

        name: order.branch_name,
      },

      items: itemsResult.rows.map((item) => ({
        product: {
          id: item.product_id,

          sku: item.sku_snapshot,

          name: item.name_snapshot,
        },

        quantity: item.quantity,

        unitPrice: Number(item.unit_price),

        lineTotal: Number(item.line_total),

        currency: item.currency,
      })),

      totals: {
        subtotal: Number(order.subtotal),

        discountTotal: Number(order.discount_total),

        deliveryFee: Number(order.delivery_fee),

        total: Number(order.total),
      },

      tracking: historyResult.rows.map((event) => ({
        status: event.status,

        changedAt: event.changed_at,
      })),

      createdAt: order.created_at,
    };
  }
  async getDeliveryLocation(trackingToken: string) {
    return this.deliveryTracking.getPublicDeliveryLocationByOrderTrackingToken(
      trackingToken,
    );
  }
  async getDeliveryPod(trackingToken: string) {
    return this.deliveryTracking.getPublicDeliveryPodByOrderTrackingToken(
      trackingToken,
    );
  }
}
