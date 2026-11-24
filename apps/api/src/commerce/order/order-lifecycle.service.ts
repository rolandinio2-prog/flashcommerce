import { assertDeliveryQrPaid } from '../../payments/delivery-payment-policy';
import { type StaffSessionPrincipal } from '../../core/staff/staff.types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import {
  type OrderType,
  type OrderStatus,
  type OrderPaymentStatus,
  ORDER_STATUS_TRANSITIONS,
  type CloseTableOrderRow,
  type CloseTableSessionRow,
  type ClosedTableSessionRow,
} from './order.types';

@Injectable()
export class OrderLifecycleService {
  constructor(private readonly databaseService: DatabaseService) {}

  // =======================================================
  // 3. ACTUALIZAR ESTADO OPERATIVO
  // =======================================================

  async updateOrderStatus(
    orderId: string,
    requestedStatus: string | undefined,
    principal: Pick<StaffSessionPrincipal, 'tenantId' | 'branchId'>,
  ) {
    if (!requestedStatus?.trim()) {
      throw new BadRequestException('status is required');
    }

    const nextStatus = requestedStatus.trim().toUpperCase() as OrderStatus;

    if (
      !Object.prototype.hasOwnProperty.call(
        ORDER_STATUS_TRANSITIONS,
        nextStatus,
      )
    ) {
      throw new BadRequestException('Invalid order status');
    }

    return this.databaseService.withTransaction(async (client) => {
      const orderResult = await client.query<{
        id: string;
        order_number: string;
        tracking_token: string;
        tenant_id: string;
        branch_id: string;
        order_type: OrderType;
        status: OrderStatus;
        payment_status: OrderPaymentStatus;
        reservation_id: string | null;
        scheduled_for: string | Date | null;
      }>(
        `
              select
                id::text,
                order_number::text,
                tracking_token::text,
                tenant_id::text,
                branch_id::text,
                order_type,
                status,
                payment_status,
                reservation_id::text,
                scheduled_for

              from public.orders

              where id = $1::uuid
                and tenant_id = $2::uuid
                and branch_id = $3::uuid

              for update
            `,
        [orderId, principal.tenantId, principal.branchId],
      );

      const order = orderResult.rows[0];

      if (!order) {
        throw new NotFoundException('Order not found');
      }

      const currentStatus = order.status;

      // Idempotencia: mismo estado, sin UPDATE.
      if (currentStatus === nextStatus) {
        return {
          id: order.id,

          orderNumber: order.order_number,

          trackingToken: order.tracking_token,

          previousStatus: currentStatus,

          status: currentStatus,

          changed: false,
        };
      }

      const allowedTransitions = ORDER_STATUS_TRANSITIONS[currentStatus];

      if (!allowedTransitions.includes(nextStatus)) {
        throw new ConflictException(
          `Invalid order status transition: ${currentStatus} -> ${nextStatus}`,
        );
      }

      // A DELIVERY order can only reach COMPLETED through the
      // driver delivery lifecycle after a valid POD verification.
      // The KDS owns food preparation, but it must not complete
      // the customer order while the delivery is still active.
      if (
        order.order_type === 'DELIVERY' &&
        currentStatus === 'READY' &&
        nextStatus === 'COMPLETED'
      ) {
        throw new ConflictException(
          'Delivery orders are completed only by the driver delivery workflow',
        );
      }

      if (
        order.order_type === 'DELIVERY' &&
        ['CONFIRMED', 'PREPARING', 'READY'].includes(nextStatus)
      ) {
        await assertDeliveryQrPaid(client, {
          tenant_id: order.tenant_id,
          branch_id: order.branch_id,
          order_id: order.id,
        });
      }

      const paymentVerified = ['PAID', 'NOT_REQUIRED'].includes(
        order.payment_status,
      );

      let explicitDriverCod = false;

      if (
        (nextStatus === 'CONFIRMED' || nextStatus === 'PREPARING') &&
        !paymentVerified &&
        order.order_type === 'DELIVERY' &&
        order.payment_status === 'AWAITING_CONFIRMATION'
      ) {
        const codResult = await client.query<{
          eligible: boolean;
        }>(
          `
              select exists (
                select 1

                from public.order_payments p

                where p.tenant_id = $1::uuid
                  and p.branch_id = $2::uuid
                  and p.order_id = $3::uuid
                  and p.method = 'CASH'
                  and p.provider = 'DRIVER_COD'
                  and p.status =
                    'AWAITING_CONFIRMATION'
              ) as eligible
            `,
          [order.tenant_id, order.branch_id, order.id],
        );

        explicitDriverCod = codResult.rows[0]?.eligible ?? false;
      }

      if (
        nextStatus === 'CONFIRMED' &&
        !paymentVerified &&
        !explicitDriverCod
      ) {
        throw new ConflictException(
          'Order cannot advance until payment is verified or explicit cash on delivery is selected',
        );
      }

      if (
        nextStatus === 'PREPARING' &&
        !paymentVerified &&
        !explicitDriverCod
      ) {
        throw new ConflictException(
          'Order cannot advance until payment is verified or explicit cash on delivery is selected',
        );
      }

      if (
        nextStatus === 'PREPARING' &&
        order.reservation_id &&
        order.scheduled_for &&
        new Date(order.scheduled_for).getTime() - Date.now() > 60 * 60 * 1000
      ) {
        throw new ConflictException(
          'Advance order preparation is available starting 60 minutes before the reservation',
        );
      }

      const updateResult = await client.query<{
        id: string;
        order_number: string;
        tracking_token: string;
        status: OrderStatus;
        updated_at: string | Date;
      }>(
        `
              update public.orders

              set
                status = $2,
                updated_at = now()

              where id = $1::uuid

              returning
                id::text,
                order_number::text,
                tracking_token::text,
                status,
                updated_at
            `,
        [orderId, nextStatus],
      );

      const updated = updateResult.rows[0];

      return {
        id: updated.id,

        orderNumber: updated.order_number,

        trackingToken: updated.tracking_token,

        previousStatus: currentStatus,

        status: updated.status,

        changed: true,

        updatedAt: updated.updated_at,
      };
    });
  }

  // =======================================================
  // 4. TABLES V0.3
  // CERRAR Y LIBERAR LA MESA VINCULADA A UN PEDIDO
  // =======================================================

  async closeTableSession(
    orderId: string,
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ) {
    const tenant = tenantCode?.trim() || 'POLLO001';

    const branch = branchCode?.trim() || 'SUC001';

    return this.databaseService.withTransaction(async (client) => {
      // -------------------------------------------------
      // 1. Buscar y bloquear el pedido.
      //
      // Los filtros tenant + branch impiden operar sobre
      // pedidos pertenecientes a otra organización.
      // -------------------------------------------------

      const orderResult = await client.query<CloseTableOrderRow>(
        `
              select
                o.id::text,
                o.order_number::text,
                o.order_type,

                o.tenant_id::text,
                o.branch_id::text,

                o.table_session_id::text

              from public.orders o

              inner join public.tenants t
                on t.id = o.tenant_id

              inner join public.branches b
                on b.tenant_id = o.tenant_id
               and b.id = o.branch_id

              where o.id = $1::uuid
                and t.code = $2
                and b.code = $3

              for update of o
            `,
        [orderId, tenant, branch],
      );

      const order = orderResult.rows[0];

      if (!order) {
        throw new NotFoundException(
          'Order not found for this tenant and branch',
        );
      }

      if (order.order_type !== 'DINE_IN' || !order.table_session_id) {
        throw new ConflictException('Order does not have a table session');
      }

      // -------------------------------------------------
      // 2. Buscar y bloquear la sesión y la mesa.
      //
      // El bloqueo de dining_tables se coordina con el
      // bloqueo utilizado durante checkout DINE_IN.
      // -------------------------------------------------

      const sessionResult = await client.query<CloseTableSessionRow>(
        `
              select
                ts.id::text,
                ts.status,

                dt.id::text as table_id,
                dt.code as table_code,
                dt.name as table_name

              from public.table_sessions ts

              inner join public.dining_tables dt
                on dt.tenant_id = ts.tenant_id
               and dt.branch_id = ts.branch_id
               and dt.id = ts.table_id

              where ts.tenant_id = $1::uuid
                and ts.branch_id = $2::uuid
                and ts.id = $3::uuid

              for update of dt, ts
            `,
        [order.tenant_id, order.branch_id, order.table_session_id],
      );

      const session = sessionResult.rows[0];

      if (!session) {
        throw new NotFoundException('Table session not found');
      }

      if (session.status !== 'OPEN') {
        throw new ConflictException('Table session is already closed');
      }

      // -------------------------------------------------
      // 3. Cerrar la sesión.
      //
      // No actualizamos dining_tables. TablesService
      // derivará AVAILABLE al no encontrar una sesión OPEN.
      // -------------------------------------------------

      const updateResult = await client.query<ClosedTableSessionRow>(
        `
              update public.table_sessions

              set
                status = 'CLOSED',
                closed_at = now()

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid
                and status = 'OPEN'

              returning
                id::text,
                status,
                closed_at,
                updated_at
            `,
        [order.tenant_id, order.branch_id, session.id],
      );

      const closedSession = updateResult.rows[0];

      if (!closedSession) {
        throw new ConflictException('Table session is no longer open');
      }

      return {
        tenant,
        branch,

        order: {
          id: order.id,
          orderNumber: order.order_number,
        },

        table: {
          id: session.table_id,
          code: session.table_code,
          name: session.table_name,
          availability: 'AVAILABLE',
        },

        tableSession: {
          id: closedSession.id,
          previousStatus: 'OPEN',
          status: closedSession.status,
          closedAt: closedSession.closed_at,
          updatedAt: closedSession.updated_at,
        },
      };
    });
  }
}
