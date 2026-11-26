import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../../core/database/database.service';
import type { StaffSessionPrincipal } from '../../core/staff/staff.types';

type Db = Pick<DatabaseService, 'query'>;
type Staff = Pick<StaffSessionPrincipal, 'tenantId' | 'branchId' | 'userId'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = 'BOB';
const cents = (n: number) => Math.round(n * 100) / 100;

export interface CashRemittanceInput {
  driverId?: unknown;
  receivedAmount?: unknown;
  notes?: unknown;
}

/** Unsettled COD cash of the branch: collected by a driver and not yet handed in. */
const PENDING_SQL = `
  from public.delivery_cash_collections c
  join public.order_payments p on p.tenant_id=c.tenant_id and p.branch_id=c.branch_id and p.id=c.payment_id
  join public.orders o on o.tenant_id=c.tenant_id and o.branch_id=c.branch_id and o.id=c.order_id
  join public.deliveries d on d.tenant_id=c.tenant_id and d.branch_id=c.branch_id and d.id=c.delivery_id
  left join public.courier_clients cl on cl.tenant_id=d.tenant_id and cl.id=d.courier_client_id
  where c.tenant_id=$1::uuid and c.branch_id=$2::uuid and c.currency='${CURRENCY}'
    and p.method='CASH' and p.provider='DRIVER_COD' and p.status='PAID'
    and not exists (select 1 from public.delivery_cash_settlement_items si
                     where si.tenant_id=c.tenant_id and si.branch_id=c.branch_id and si.collection_id=c.id)`;

/**
 * Driver cash remittance (rendición) for courier cash on delivery, from Ops with a
 * staff session. Records into the existing delivery_cash_settlements tables, so a
 * collection can be handed in only once whichever flow is used.
 */
@Injectable()
export class CourierCashService {
  constructor(private readonly databaseService: DatabaseService) {}

  private async assertDeliveryProduct(db: Db, staff: Staff) {
    const r = await db.query<{ ok: boolean }>(
      "select exists(select 1 from public.tenant_products where tenant_id=$1::uuid and product='DELIVERY' and status='ACTIVE') as ok",
      [staff.tenantId],
    );
    if (!r.rows[0]?.ok)
      throw new ForbiddenException(
        'El producto Delivery no está activo para este negocio.',
      );
  }

  /** Cash each driver of the branch holds (collected, not handed in). */
  async summary(staff: Staff) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const r = await this.databaseService.query<{
      driver_id: string;
      display_name: string;
      code: string;
      collections: number;
      amount: string;
      oldest: string;
    }>(
      `select c.driver_id::text, dr.display_name, dr.code, count(*)::int as collections,
              sum(c.amount)::text as amount, min(c.collected_at)::text as oldest
         ${PENDING_SQL.replace('from public.delivery_cash_collections c', 'from public.delivery_cash_collections c join public.delivery_drivers dr on dr.id=c.driver_id')}
        group by c.driver_id, dr.display_name, dr.code
        order by sum(c.amount) desc`,
      [staff.tenantId, staff.branchId],
    );
    return {
      currency: CURRENCY,
      drivers: r.rows.map((x) => ({
        driverId: x.driver_id,
        displayName: x.display_name,
        code: x.code,
        collections: x.collections,
        amount: Number(x.amount),
        oldestCollectedAt: x.oldest,
      })),
    };
  }

  private async pending(db: Db, staff: Staff, driverId: string, lock: boolean) {
    const r = await db.query<{
      id: string;
      order_number: string;
      recipient_name: string;
      client_name: string | null;
      amount: string;
      collected_at: string;
    }>(
      `select c.id::text, o.order_number::text, d.recipient_name, cl.name as client_name,
              c.amount::text, c.collected_at::text
         ${PENDING_SQL} and c.driver_id=$3::uuid
        order by c.collected_at, c.id
        ${lock ? 'for update of c' : ''}`,
      [staff.tenantId, staff.branchId, driverId],
    );
    return r.rows;
  }

  async driverPending(staff: Staff, driverIdInput: string) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const driverId = this.uuid(driverIdInput, 'driverId');
    const rows = await this.pending(
      this.databaseService,
      staff,
      driverId,
      false,
    );
    return {
      driverId,
      currency: CURRENCY,
      expectedAmount: cents(rows.reduce((s, r) => s + Number(r.amount), 0)),
      collections: rows.map((r) => ({
        id: r.id,
        orderNumber: Number(r.order_number),
        recipientName: r.recipient_name,
        clientName: r.client_name,
        amount: Number(r.amount),
        collectedAt: r.collected_at,
      })),
    };
  }

  /** Hands in all of the driver's pending cash at once and records what was received. */
  async remit(staff: Staff, input: CashRemittanceInput) {
    const driverId = this.uuid(input?.driverId, 'driverId');
    const raw =
      typeof input?.receivedAmount === 'string'
        ? Number(input.receivedAmount)
        : input?.receivedAmount;
    if (
      typeof raw !== 'number' ||
      !Number.isFinite(raw) ||
      raw < 0 ||
      raw > 1_000_000
    )
      throw new BadRequestException('receivedAmount no es válido.');
    const received = cents(raw);
    const notes =
      typeof input?.notes === 'string' && input.notes.trim()
        ? input.notes.trim().slice(0, 500)
        : null;

    return this.databaseService.withTransaction(async (db) => {
      await this.assertDeliveryProduct(db, staff);
      const member = await db.query(
        'select 1 from public.delivery_driver_branches where tenant_id=$1::uuid and branch_id=$2::uuid and driver_id=$3::uuid',
        [staff.tenantId, staff.branchId, driverId],
      );
      if (!member.rowCount)
        throw new NotFoundException('Conductor no encontrado.');
      const rows = await this.pending(db, staff, driverId, true);
      if (!rows.length)
        throw new ConflictException(
          'El conductor no tiene efectivo pendiente de rendir.',
        );
      const expected = cents(rows.reduce((s, r) => s + Number(r.amount), 0));
      const settlement = await db.query<{ id: string; settled_at: string }>(
        `insert into public.delivery_cash_settlements (tenant_id, branch_id, driver_id, status, currency, expected_amount,
                received_amount, difference_amount, idempotency_key, settled_at, notes, settled_by_staff_user_id)
         values ($1::uuid,$2::uuid,$3::uuid,'SETTLED',$4,$5::numeric,$6::numeric,$6::numeric-$5::numeric,$7,now(),$8,$9::uuid)
         returning id::text, settled_at::text`,
        [
          staff.tenantId,
          staff.branchId,
          driverId,
          CURRENCY,
          expected,
          received,
          `courier-remit:${randomUUID()}`,
          notes,
          staff.userId,
        ],
      );
      await db.query(
        `insert into public.delivery_cash_settlement_items (tenant_id, branch_id, settlement_id, collection_id, driver_id, amount, currency)
         select c.tenant_id, c.branch_id, $3::uuid, c.id, c.driver_id, c.amount, c.currency
           from public.delivery_cash_collections c
          where c.tenant_id=$1::uuid and c.branch_id=$2::uuid and c.id = any($4::uuid[])`,
        [
          staff.tenantId,
          staff.branchId,
          settlement.rows[0].id,
          rows.map((r) => r.id),
        ],
      );
      return {
        id: settlement.rows[0].id,
        driverId,
        collections: rows.length,
        expectedAmount: expected,
        receivedAmount: received,
        differenceAmount: cents(received - expected),
        settledAt: settlement.rows[0].settled_at,
      };
    });
  }

  async listRemittances(staff: Staff) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const r = await this.databaseService.query<{
      id: string;
      display_name: string;
      status: string;
      expected_amount: string;
      received_amount: string | null;
      difference_amount: string | null;
      items: number;
      settled_at: string | null;
      notes: string | null;
    }>(
      `select s.id::text, dr.display_name, s.status, s.expected_amount::text, s.received_amount::text,
              s.difference_amount::text, (select count(*)::int from public.delivery_cash_settlement_items i where i.settlement_id=s.id) as items,
              s.settled_at::text, s.notes
         from public.delivery_cash_settlements s join public.delivery_drivers dr on dr.id=s.driver_id
        where s.tenant_id=$1::uuid and s.branch_id=$2::uuid
        order by s.created_at desc limit 100`,
      [staff.tenantId, staff.branchId],
    );
    return {
      remittances: r.rows.map((x) => ({
        id: x.id,
        driverName: x.display_name,
        status: x.status,
        collections: x.items,
        expectedAmount: Number(x.expected_amount),
        receivedAmount:
          x.received_amount === null ? null : Number(x.received_amount),
        differenceAmount:
          x.difference_amount === null ? null : Number(x.difference_amount),
        settledAt: x.settled_at,
        notes: x.notes,
      })),
    };
  }

  private uuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UUID.test(value))
      throw new BadRequestException(`${field} no es válido.`);
    return value;
  }
}
