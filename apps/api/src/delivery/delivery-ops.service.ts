import { assertDeliveryQrPaid } from '../payments/delivery-payment-policy';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../core/database/database.service';
import { requireUuid, optionalUuid, requireCode } from './delivery-helpers';

@Injectable()
export class DeliveryOpsService {
  constructor(private readonly databaseService: DatabaseService) {}

  async assignOperationalDelivery(
    deliveryIdInput: unknown,
    tenantCodeInput?: string,
    branchCodeInput?: string,
    driverIdInput?: unknown,
    expectedAssignmentIdInput?: unknown,
  ) {
    const deliveryId = requireUuid(deliveryIdInput, 'deliveryId');

    const tenantCode = requireCode(tenantCodeInput, 'tenant');

    const branchCode = requireCode(branchCodeInput, 'branch');

    const driverId = requireUuid(driverIdInput, 'driverId');

    const expectedAssignmentId = optionalUuid(
      expectedAssignmentIdInput,
      'expectedAssignmentId',
    );

    return this.databaseService.withTransaction(async (client) => {
      const branchResult = await client.query<{
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
        [tenantCode, branchCode],
      );

      const branch = branchResult.rows[0];

      if (!branch) {
        throw new NotFoundException('Tenant or branch not found');
      }

      const deliveryResult = await client.query<{
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
        [branch.tenant_id, branch.branch_id, deliveryId],
      );

      const delivery = deliveryResult.rows[0];

      if (!delivery) {
        throw new NotFoundException('Delivery not found');
      }

      if (delivery.order_status !== 'READY') {
        throw new ConflictException(
          `Order ${delivery.order_number} is not dispatchable until READY`,
        );
      }

      await assertDeliveryQrPaid(client, {
        tenant_id: branch.tenant_id,
        branch_id: branch.branch_id,
        order_id: delivery.order_id,
      });

      if (
        delivery.status !== 'WAITING_ASSIGNMENT' &&
        delivery.status !== 'ASSIGNED'
      ) {
        throw new ConflictException(
          `Delivery cannot be assigned from ${delivery.status}`,
        );
      }

      const activeResult = await client.query<{
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
        [branch.tenant_id, branch.branch_id, delivery.id],
      );

      const activeAssignment = activeResult.rows[0] ?? null;

      if (delivery.status === 'WAITING_ASSIGNMENT' && activeAssignment) {
        throw new ConflictException(
          'Delivery assignment state is inconsistent',
        );
      }

      if (delivery.status === 'ASSIGNED' && !activeAssignment) {
        throw new ConflictException(
          'Delivery assignment state is inconsistent',
        );
      }

      if (activeAssignment && activeAssignment.status !== 'ASSIGNED') {
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

      if (activeAssignment && activeAssignment.driver_id === driverId) {
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

            number: activeAssignment.assignment_number,

            status: activeAssignment.status,

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

      if (delivery.status === 'WAITING_ASSIGNMENT' && expectedAssignmentId) {
        throw new BadRequestException(
          'expectedAssignmentId must be omitted for initial assignment',
        );
      }

      if (delivery.status === 'ASSIGNED' && !expectedAssignmentId) {
        throw new ConflictException(
          'expectedAssignmentId is required for reassignment',
        );
      }

      if (activeAssignment && expectedAssignmentId !== activeAssignment.id) {
        throw new ConflictException('Delivery assignment changed concurrently');
      }

      // ----------------------------------------------------
      // Target driver must be ACTIVE and explicitly ENABLED
      // for this tenant + branch.
      // ----------------------------------------------------

      const driverResult = await client.query<{
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

                and not exists (
                  select 1

                  from public.delivery_assignments busy

                  where busy.tenant_id = db.tenant_id
                    and busy.branch_id = db.branch_id
                    and busy.driver_id = drv.id
                    and busy.delivery_id <> $4::uuid
                    and busy.status in (
                      'ASSIGNED',
                      'ACCEPTED'
                    )
                )

              limit 1

              for update of db
            `,
        [branch.tenant_id, branch.branch_id, driverId, delivery.id],
      );

      const driver = driverResult.rows[0];

      if (!driver) {
        throw new ConflictException(
          'Driver is not active and enabled for this branch',
        );
      }

      // ----------------------------------------------------
      // Calculate next immutable history number while the
      // delivery row remains locked.
      // ----------------------------------------------------

      const numberResult = await client.query<{
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
        [branch.tenant_id, branch.branch_id, delivery.id],
      );

      const nextAssignmentNumber = numberResult.rows[0]?.next_number;

      if (!nextAssignmentNumber || nextAssignmentNumber < 1) {
        throw new Error('Could not calculate assignment number');
      }

      const isReassignment = activeAssignment !== null;

      // ----------------------------------------------------
      // Release old assignment first.
      // The partial unique index then permits the new active
      // assignment inside this same transaction.
      // ----------------------------------------------------

      if (activeAssignment) {
        const releasedResult = await client.query(
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
          [branch.tenant_id, branch.branch_id, activeAssignment.id],
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
        const insertResult = await client.query<{
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

        const inserted = insertResult.rows[0];

        if (!inserted) {
          throw new Error('Assignment creation returned no row');
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
        const deliveryUpdate = await client.query(
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
          [branch.tenant_id, branch.branch_id, delivery.id],
        );

        if (deliveryUpdate.rowCount !== 1) {
          throw new ConflictException('Delivery changed concurrently');
        }
      } else {
        const deliveryUpdate = await client.query(
          `
                update public.deliveries

                set updated_at = now()

                where tenant_id = $1::uuid
                  and branch_id = $2::uuid
                  and id = $3::uuid
                  and status = 'ASSIGNED'

                returning id
              `,
          [branch.tenant_id, branch.branch_id, delivery.id],
        );

        if (deliveryUpdate.rowCount !== 1) {
          throw new ConflictException('Delivery changed concurrently');
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

          isReassignment ? 'DRIVER_REASSIGNED' : 'DRIVER_ASSIGNED',

          isReassignment ? 'ASSIGNED' : 'WAITING_ASSIGNMENT',

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

        action: isReassignment ? 'REASSIGNED' : 'ASSIGNED',

        delivery: {
          id: delivery.id,
          status: 'ASSIGNED',
        },

        previousAssignment: activeAssignment
          ? {
              id: activeAssignment.id,

              number: activeAssignment.assignment_number,

              status: 'RELEASED',

              driver: {
                id: activeAssignment.driver_id,

                code: activeAssignment.driver_code,

                name: activeAssignment.driver_name,
              },
            }
          : null,

        assignment: {
          id: newAssignment.id,

          number: newAssignment.assignment_number,

          status: newAssignment.status,

          assignedAt: newAssignment.assigned_at,

          driver: {
            id: driver.id,
            code: driver.code,
            name: driver.display_name,
          },
        },
      };
    });
  }
  async getOperationalDeliveries(
    tenantCodeInput?: string,
    branchCodeInput?: string,
    statusInput?: string,
  ) {
    const tenantCode = requireCode(tenantCodeInput, 'tenant');

    const branchCode = requireCode(branchCodeInput, 'branch');

    const deliveryStatus =
      statusInput?.trim().toUpperCase() || 'WAITING_ASSIGNMENT';

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
      throw new BadRequestException('Invalid delivery status');
    }

    const branchResult = await this.databaseService.query<{
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
      [tenantCode, branchCode],
    );

    const branch = branchResult.rows[0];

    if (!branch) {
      throw new NotFoundException('Tenant or branch not found');
    }

    const result = await this.databaseService.query<{
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
      [branch.tenant_id, branch.branch_id, deliveryStatus],
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

        trackingToken: row.delivery_tracking_token,

        status: row.delivery_status,

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
          deliveryFee: Number(row.quoted_delivery_fee),

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

              driver: {
                id: row.driver_id,
                code: row.driver_code,
                name: row.driver_name,
              },
            }
          : null,

        createdAt: row.delivery_created_at,

        updatedAt: row.delivery_updated_at,
      })),
    };
  }

  async getOperationalDrivers(
    tenantCodeInput?: string,
    branchCodeInput?: string,
  ) {
    const tenantCode = requireCode(tenantCodeInput, 'tenant');

    const branchCode = requireCode(branchCodeInput, 'branch');

    const branchResult = await this.databaseService.query<{
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
      [tenantCode, branchCode],
    );

    const branch = branchResult.rows[0];

    if (!branch) {
      throw new NotFoundException('Tenant or branch not found');
    }

    const result = await this.databaseService.query<{
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
      [branch.tenant_id, branch.branch_id],
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

        displayName: row.display_name,

        phone: row.phone,

        status: row.driver_status,

        branchStatus: row.branch_status,

        activeAssignments: row.active_assignments,
      })),
    };
  }
}
