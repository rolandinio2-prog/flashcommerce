import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { type OpsOrderRow } from './order.types';

@Injectable()
export class OpsOrderQueryService {
  constructor(private readonly databaseService: DatabaseService) {}

  // =======================================================
  // 4. LISTAR PEDIDOS ACTIVOS PARA KDS
  // =======================================================

  async getOperationalOrders(
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ) {
    const tenant = tenantCode?.trim() || 'POLLO001';

    const branch = branchCode?.trim() || 'SUC001';

    const result = await this.databaseService.query<OpsOrderRow>(
      `
        select
          o.id::text,
          o.order_number::text,
          o.tracking_token::text,
          o.order_type,
          o.status,
          o.payment_status,
          o.order_origin,
          o.currency,
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

          o.table_session_id::text,
          ts.status as table_session_status,
          ts.closed_at as table_session_closed_at,

          o.created_at,
          o.updated_at,

          max(operational_delivery.id::text)
            as operational_delivery_id,

          max(operational_delivery.status)
            as operational_delivery_status,

          max(operational_assignment.id::text)
            as operational_assignment_id,

          max(operational_assignment.status)
            as operational_assignment_status,

          max(operational_assignment.accepted_at)
            as operational_assignment_accepted_at,

          max(operational_driver.id::text)
            as operational_driver_id,

          max(operational_driver.code)
            as operational_driver_code,

          max(operational_driver.display_name)
            as operational_driver_name,

          max(operational_delivery.membership_role)
            as operational_delivery_role,

          max(operational_delivery.member_count)
            as operational_delivery_member_count,

          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'productId',
                oi.product_id::text,

                'sku',
                oi.sku_snapshot,

                'name',
                oi.name_snapshot,

                'quantity',
                oi.quantity,

                'unitPrice',
                oi.unit_price,

                'lineTotal',
                oi.line_total
              )
              order by oi.created_at
            )
            filter (
              where oi.id is not null
            ),
            '[]'::jsonb
          ) as items

        from public.orders o

        inner join public.tenants t
          on t.id = o.tenant_id

        inner join public.branches b
          on b.tenant_id = o.tenant_id
         and b.id = o.branch_id

        left join public.table_sessions ts
          on ts.tenant_id = o.tenant_id
         and ts.branch_id = o.branch_id
         and ts.id = o.table_session_id

        left join public.table_reservations r
          on r.tenant_id = o.tenant_id
         and r.branch_id = o.branch_id
         and r.id = o.reservation_id

        left join public.order_items oi
          on oi.tenant_id = o.tenant_id
         and oi.order_id = o.id

        left join lateral (
          select
            d.id,
            d.tenant_id,
            d.branch_id,
            d.status,

            m.role as membership_role,

            (
              select count(*)::integer

              from public.delivery_order_memberships bundle_member

              where bundle_member.tenant_id = d.tenant_id
                and bundle_member.branch_id = d.branch_id
                and bundle_member.delivery_id = d.id
                and bundle_member.membership_status in (
                  'PENDING',
                  'ACTIVE'
                )
            ) as member_count

          from public.delivery_order_memberships m

          inner join public.deliveries d
            on d.tenant_id = m.tenant_id
           and d.branch_id = m.branch_id
           and d.id = m.delivery_id

          where m.tenant_id = o.tenant_id
            and m.branch_id = o.branch_id
            and m.order_id = o.id
            and m.membership_status in (
              'PENDING',
              'ACTIVE'
            )

          order by
            case m.role
              when 'PRIMARY' then 0
              else 1
            end,
            m.joined_at

          limit 1
        ) operational_delivery
          on true

        left join lateral (
          select
            a.id,
            a.driver_id,
            a.status,
            a.accepted_at

          from public.delivery_assignments a

          where a.tenant_id = operational_delivery.tenant_id
            and a.branch_id = operational_delivery.branch_id
            and a.delivery_id = operational_delivery.id

          order by
            a.assignment_number desc,
            a.created_at desc

          limit 1
        ) operational_assignment
          on true

        left join public.delivery_drivers operational_driver
          on operational_driver.tenant_id = operational_delivery.tenant_id
         and operational_driver.id = operational_assignment.driver_id

        where t.code = $1
          and b.code = $2

          and o.status in (
            'PENDING',
            'CONFIRMED',
            'PREPARING',
            'READY'
          )

          and (
            o.order_type <> 'DELIVERY'
            or operational_delivery.id is null
            or operational_delivery.status not in (
              'PICKED_UP',
              'EN_ROUTE',
              'ARRIVED',
              'DELIVERED'
            )
          )

        group by
          o.id,
          o.order_number,
          o.tracking_token,
          o.order_type,
          o.status,
          o.payment_status,
          o.order_origin,
          o.currency,
          o.total,

          o.scheduled_for,
          o.customer_name,
          o.customer_phone,
          o.table_code,
          o.delivery_address,
          o.customer_notes,

          o.reservation_id,
          r.reservation_code,
          r.reserved_for,

          o.table_session_id,
          ts.status,
          ts.closed_at,

          o.created_at,
          o.updated_at

        order by
          case o.status
            when 'PENDING' then 1
            when 'CONFIRMED' then 2
            when 'PREPARING' then 3
            when 'READY' then 4
            else 5
          end,

          o.created_at asc
      `,
      [tenant, branch],
    );

    return {
      tenant,
      branch,

      total: result.rows.length,

      orders: result.rows.map((order) => ({
        id: order.id,

        orderNumber: order.order_number,

        trackingToken: order.tracking_token,

        orderType: order.order_type,

        status: order.status,

        paymentStatus: order.payment_status,

        orderOrigin: order.order_origin,

        currency: order.currency,

        total: Number(order.total),

        // ===================================================
        // FULFILLMENT PARA KDS
        // ===================================================

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

        // ===================================================
        // TABLES V0.3
        // Estado autoritativo de la sesión vinculada.
        // ===================================================

        tableSession:
          order.table_session_id === null || order.table_session_status === null
            ? null
            : {
                id: order.table_session_id,

                status: order.table_session_status,

                closedAt: order.table_session_closed_at,
              },

        delivery: order.operational_delivery_id
          ? {
              id: order.operational_delivery_id,
              status: order.operational_delivery_status,

              relationshipRole: order.operational_delivery_role,

              memberCount: order.operational_delivery_member_count ?? 1,

              isShared: (order.operational_delivery_member_count ?? 1) > 1,

              assignment: order.operational_assignment_id
                ? {
                    id: order.operational_assignment_id,
                    status: order.operational_assignment_status,
                    acceptedAt: order.operational_assignment_accepted_at,
                    driver: order.operational_driver_id
                      ? {
                          id: order.operational_driver_id,
                          code: order.operational_driver_code,
                          name: order.operational_driver_name,
                        }
                      : null,
                  }
                : null,
            }
          : null,

        items: order.items,

        createdAt: order.created_at,

        updatedAt: order.updated_at,
      })),
    };
  }
}
