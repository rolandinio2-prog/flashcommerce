import { assertDeliveryQrPaid } from '../payments/delivery-payment-policy';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import type { StaffSessionPrincipal } from './staff.types';

interface HandoffDeliveryRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  order_id: string;
  order_number: string;
  delivery_status: string;
  order_status: string;
  payment_status: string;
}

interface HandoffAssignmentRow {
  id: string;
  assignment_number: number;
  driver_id: string;
  status: string;
  assigned_at: string | Date;
  accepted_at: string | Date | null;
  driver_code: string;
  driver_name: string;
}

@Injectable()
export class StaffDeliveryHandoffService {
  constructor(private readonly databaseService: DatabaseService) {}

  async handoffToDriver(
    staff: StaffSessionPrincipal,
    deliveryIdInput: unknown,
  ) {
    const deliveryId = String(deliveryIdInput ?? '').trim();

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        deliveryId,
      )
    ) {
      throw new BadRequestException('Invalid deliveryId');
    }

    return this.databaseService.withTransaction(async (client) => {
      const deliveryResult = await client.query<HandoffDeliveryRow>(
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
              and d.branch_id = $2::uuid
              and d.id = $3::uuid

            for update of d, o
          `,
        [staff.tenantId, staff.branchId, deliveryId],
      );

      const delivery = deliveryResult.rows[0];

      if (!delivery) {
        throw new NotFoundException('Delivery not found');
      }

      if (
        delivery.delivery_status !== 'ACCEPTED' &&
        delivery.delivery_status !== 'PICKED_UP'
      ) {
        throw new ConflictException(
          `Delivery cannot be handed off from ${delivery.delivery_status}`,
        );
      }

      const assignmentResult = await client.query<HandoffAssignmentRow>(
        `
              select
                a.id::text,
                a.assignment_number,
                a.driver_id::text,
                a.status,
                a.assigned_at,
                a.accepted_at,
                drv.code as driver_code,
                drv.display_name as driver_name

              from public.delivery_assignments a

              inner join public.delivery_drivers drv
                on drv.tenant_id = a.tenant_id
               and drv.id = a.driver_id

              inner join public.delivery_driver_branches db
                on db.tenant_id = a.tenant_id
               and db.branch_id = a.branch_id
               and db.driver_id = a.driver_id
               and db.status = 'ENABLED'

              where a.tenant_id = $1::uuid
                and a.branch_id = $2::uuid
                and a.delivery_id = $3::uuid
                and a.status = 'ACCEPTED'

              order by
                a.assignment_number desc,
                a.created_at desc

              limit 1

              for update of a
            `,
        [delivery.tenant_id, delivery.branch_id, delivery.id],
      );

      const assignment = assignmentResult.rows[0];

      if (!assignment) {
        throw new ConflictException(
          'Driver must accept the delivery before handoff',
        );
      }

      if (delivery.delivery_status === 'PICKED_UP') {
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
            status: assignment.status,
            acceptedAt: assignment.accepted_at,
            driver: {
              id: assignment.driver_id,
              code: assignment.driver_code,
              name: assignment.driver_name,
            },
          },
        };
      }

      if (delivery.order_status !== 'READY') {
        throw new ConflictException(
          `Delivery cannot be handed off while order is ${delivery.order_status}`,
        );
      }

      if (!assignment.accepted_at) {
        throw new ConflictException('Driver acceptance timestamp is missing');
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

      if (deliveryUpdate.rowCount !== 1) {
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
              'OPS',
              $4,
              jsonb_build_object(
                'driverId', $5::text,
                'driverCode', $6::text,
                'driverName', $7::text,
                'assignmentId', $8::text,
                'assignmentNumber', $9::integer,
                'orderId', $10::text,
                'orderNumber', $11::text,
                'handoffStaffUserId', $12::text,
                'handoffStaffUserCode', $4::text,
                'handoffStaffDisplayName', $13::text
              )
            )
            returning created_at
          `,
        [
          delivery.tenant_id,
          delivery.branch_id,
          delivery.id,
          staff.userCode,
          assignment.driver_id,
          assignment.driver_code,
          assignment.driver_name,
          assignment.id,
          assignment.assignment_number,
          delivery.order_id,
          delivery.order_number,
          staff.userId,
          staff.displayName,
        ],
      );

      const handoffEvent = eventResult.rows[0];

      if (!handoffEvent) {
        throw new ConflictException('Delivery handoff event was not created');
      }

      return {
        changed: true,
        action: 'PICKED_UP',
        handoffBy: {
          userId: staff.userId,
          userCode: staff.userCode,
          displayName: staff.displayName,
        },
        delivery: {
          id: delivery.id,
          status: 'PICKED_UP',
          pickedUpAt: handoffEvent.created_at,
        },
        order: {
          id: delivery.order_id,
          number: delivery.order_number,
          status: delivery.order_status,
        },
        assignment: {
          id: assignment.id,
          number: assignment.assignment_number,
          status: assignment.status,
          acceptedAt: assignment.accepted_at,
          driver: {
            id: assignment.driver_id,
            code: assignment.driver_code,
            name: assignment.driver_name,
          },
        },
      };
    });
  }
}
