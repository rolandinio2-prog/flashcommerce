import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { DatabaseService } from '../../core/database/database.service';
import type { StaffSessionPrincipal } from '../../core/staff/staff.types';
import {
  DRIVER_PAY_MODES,
  driverPay,
  parsePeriod,
  type DriverPayMode,
} from './courier-settlement';

type Db = Pick<DatabaseService, 'query'>;
type Staff = Pick<StaffSessionPrincipal, 'tenantId' | 'branchId' | 'userId'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ['CASH', 'TRANSFER', 'QR', 'OTHER'];

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new BadRequestException(`${field} no es válido.`);
  return value;
}
function period(input: { from?: unknown; to?: unknown }) {
  const p = parsePeriod(input?.from, input?.to);
  if (!p)
    throw new BadRequestException(
      'El periodo no es válido (desde/hasta en formato AAAA-MM-DD, máximo 92 días).',
    );
  return p;
}
function shortText(value: unknown, field: string, max: number) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max)
    throw new BadRequestException(`${field} no es válido.`);
  return value.trim() || null;
}

export interface SettlementPeriodInput {
  from?: unknown;
  to?: unknown;
}
export interface ClientStatementInput extends SettlementPeriodInput {
  courierClientId?: unknown;
  notes?: unknown;
}
export interface DriverPayoutInput extends SettlementPeriodInput {
  driverId?: unknown;
  notes?: unknown;
}
export interface SettlementPaymentInput {
  paymentMethod?: unknown;
  paymentReference?: unknown;
}
export interface DriverPayRuleInput {
  payMode?: unknown;
  payValue?: unknown;
}

interface PendingRow {
  delivery_id: string;
  order_number: string;
  delivered_at: string;
  recipient_name: string;
  client_name: string | null;
  order_origin: string;
  fee: string;
  /** Cash the driver collected for the client (COD), 0 when nothing was collected. */
  collected?: string;
}
const cents = (n: number) => Math.round(n * 100) / 100;
const sum = (rows: PendingRow[], pick: (r: PendingRow) => string | undefined) =>
  cents(rows.reduce((s, r) => s + Number(pick(r) ?? 0), 0));

/**
 * D1c: settlements of FlashCommerce Delivery.
 * - Client statements bill a courier client for its delivered requests in a period.
 * - Driver payouts pay a driver for the deliveries they completed in a period,
 *   using the driver's pay rule, snapshotted at creation.
 * A delivery belongs to at most one live statement and one live payout; voiding
 * releases it. Periods are calendar days in the branch's time zone.
 */
@Injectable()
export class CourierSettlementService {
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

  /** Completed deliveries of the branch in [from, to] (branch-local dates). */
  private completedSql(extra: string) {
    return `
      select d.id::text as delivery_id, o.order_number::text, a.completed_at::text as delivered_at,
             d.recipient_name, c.name as client_name, o.order_origin, d.quoted_delivery_fee::text as fee,
             coalesce(cc.amount, 0)::text as collected
        from public.delivery_assignments a
        join public.deliveries d on d.tenant_id=a.tenant_id and d.branch_id=a.branch_id and d.id=a.delivery_id
        join public.orders o on o.tenant_id=d.tenant_id and o.branch_id=d.branch_id and o.id=d.order_id
        join public.branches b on b.id=a.branch_id
        left join public.courier_clients c on c.tenant_id=d.tenant_id and c.id=d.courier_client_id
        left join public.delivery_cash_collections cc on cc.tenant_id=d.tenant_id and cc.branch_id=d.branch_id and cc.delivery_id=d.id
       where a.tenant_id=$1::uuid and a.branch_id=$2::uuid and a.status='COMPLETED' and d.status='DELIVERED'
         and (a.completed_at at time zone coalesce(b.timezone,'America/La_Paz'))::date between $3::date and $4::date
         ${extra}
       order by a.completed_at`;
  }

  private pendingView(rows: PendingRow[]) {
    return rows.map((r) => ({
      deliveryId: r.delivery_id,
      orderNumber: Number(r.order_number),
      deliveredAt: r.delivered_at,
      recipientName: r.recipient_name,
      clientName: r.client_name,
      /** true for courier requests (with or without client); false for store orders. */
      courierRequest: r.order_origin === 'COURIER_REQUEST',
      fee: Number(r.fee),
      collected: Number(r.collected ?? 0),
    }));
  }

  private async nextNumber(
    db: Db,
    table: string,
    column: string,
    tenantId: string,
  ) {
    await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${table}:${tenantId}`,
    ]);
    const r = await db.query<{ n: number }>(
      `select coalesce(max(${column}),0)+1 as n from public.${table} where tenant_id=$1::uuid`,
      [tenantId],
    );
    return Number(r.rows[0].n);
  }

  // ---------------- client statements ----------------

  private async clientPending(
    db: Db,
    staff: Staff,
    clientId: string,
    p: { from: string; to: string },
  ) {
    const r = await db.query<PendingRow>(
      this.completedSql(`and d.courier_client_id=$5::uuid
         and not exists (select 1 from public.courier_client_statement_items i where i.delivery_id=d.id)`),
      [staff.tenantId, staff.branchId, p.from, p.to, clientId],
    );
    return r.rows;
  }

  async previewClientStatement(staff: Staff, input: ClientStatementInput) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const clientId = id(input?.courierClientId, 'courierClientId');
    const p = period(input);
    const rows = await this.clientPending(
      this.databaseService,
      staff,
      clientId,
      p,
    );
    const deliveries = this.pendingView(rows);
    const totalFee = sum(rows, (r) => r.fee);
    const collectedTotal = sum(rows, (r) => r.collected);
    return {
      period: p,
      deliveries,
      deliveryCount: deliveries.length,
      totalFee,
      collectedTotal,
      /** > 0: the fleet pays the client; < 0: the client pays the fleet. */
      netAmount: cents(collectedTotal - totalFee),
    };
  }

  async createClientStatement(staff: Staff, input: ClientStatementInput) {
    const clientId = id(input?.courierClientId, 'courierClientId');
    const p = period(input);
    const notes = shortText(input?.notes, 'notes', 500);
    return this.databaseService.withTransaction(async (db) => {
      await this.assertDeliveryProduct(db, staff);
      const client = await db.query<{ name: string }>(
        'select name from public.courier_clients where tenant_id=$1::uuid and id=$2::uuid for update',
        [staff.tenantId, clientId],
      );
      if (!client.rows[0])
        throw new NotFoundException('Cliente no encontrado.');
      const rows = await this.clientPending(db, staff, clientId, p);
      if (!rows.length)
        throw new ConflictException(
          'No hay envíos entregados sin liquidar en ese periodo.',
        );
      const total = sum(rows, (r) => r.fee);
      const collected = sum(rows, (r) => r.collected);
      const number = await this.nextNumber(
        db,
        'courier_client_statements',
        'statement_number',
        staff.tenantId,
      );
      const st = await db.query<{ id: string }>(
        `insert into public.courier_client_statements (tenant_id, branch_id, courier_client_id, statement_number, period_from, period_to,
                delivery_count, total_fee, notes, created_by_staff_user_id, collected_total, net_amount)
         values ($1::uuid,$2::uuid,$3::uuid,$4,$5::date,$6::date,$7,$8,$9,$10::uuid,$11,$12) returning id::text`,
        [
          staff.tenantId,
          staff.branchId,
          clientId,
          number,
          p.from,
          p.to,
          rows.length,
          total,
          notes,
          staff.userId,
          collected,
          cents(collected - total),
        ],
      );
      await db.query(
        `insert into public.courier_client_statement_items (statement_id, tenant_id, delivery_id, fee, collected_amount)
         select $1::uuid, $2::uuid, x.delivery_id, x.fee, x.collected
           from unnest($3::uuid[], $4::numeric[], $5::numeric[]) as x(delivery_id, fee, collected)`,
        [
          st.rows[0].id,
          staff.tenantId,
          rows.map((r) => r.delivery_id),
          rows.map((r) => r.fee),
          rows.map((r) => r.collected ?? '0'),
        ],
      );
      return this.getClientStatement(staff, st.rows[0].id, db);
    });
  }

  async listClientStatements(staff: Staff, clientIdInput?: unknown) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const clientId =
      clientIdInput === undefined || clientIdInput === ''
        ? null
        : id(clientIdInput, 'courierClientId');
    const r = await this.databaseService.query<{
      id: string;
      statement_number: number;
      client_name: string;
      period_from: string;
      period_to: string;
      delivery_count: number;
      total_fee: string;
      collected_total: string;
      net_amount: string;
      status: string;
      payment_method: string | null;
      paid_at: string | null;
      created_at: string;
    }>(
      `select s.id::text, s.statement_number, c.name as client_name, s.period_from::text, s.period_to::text,
              s.delivery_count, s.total_fee::text, s.collected_total::text, s.net_amount::text,
              s.status, s.payment_method, s.paid_at::text, s.created_at::text
         from public.courier_client_statements s
         join public.courier_clients c on c.tenant_id=s.tenant_id and c.id=s.courier_client_id
        where s.tenant_id=$1::uuid and s.branch_id=$2::uuid and ($3::uuid is null or s.courier_client_id=$3::uuid)
        order by s.created_at desc limit 100`,
      [staff.tenantId, staff.branchId, clientId],
    );
    return {
      statements: r.rows.map((x) => ({
        id: x.id,
        number: x.statement_number,
        clientName: x.client_name,
        periodFrom: x.period_from,
        periodTo: x.period_to,
        deliveryCount: x.delivery_count,
        totalFee: Number(x.total_fee),
        collectedTotal: Number(x.collected_total),
        netAmount: Number(x.net_amount),
        status: x.status,
        paymentMethod: x.payment_method,
        paidAt: x.paid_at,
        createdAt: x.created_at,
      })),
    };
  }

  async getClientStatement(
    staff: Staff,
    statementId: string,
    db: Db = this.databaseService,
  ) {
    const sid = id(statementId, 'statementId');
    const s = await db.query<{
      id: string;
      statement_number: number;
      client_id: string;
      client_name: string;
      client_tax_id: string | null;
      period_from: string;
      period_to: string;
      delivery_count: number;
      total_fee: string;
      collected_total: string;
      net_amount: string;
      status: string;
      payment_method: string | null;
      payment_reference: string | null;
      notes: string | null;
      paid_at: string | null;
      created_at: string;
    }>(
      `select s.id::text, s.statement_number, c.id::text as client_id, c.name as client_name, c.tax_id as client_tax_id,
              s.period_from::text, s.period_to::text, s.delivery_count, s.total_fee::text,
              s.collected_total::text, s.net_amount::text, s.status,
              s.payment_method, s.payment_reference, s.notes, s.paid_at::text, s.created_at::text
         from public.courier_client_statements s
         join public.courier_clients c on c.tenant_id=s.tenant_id and c.id=s.courier_client_id
        where s.tenant_id=$1::uuid and s.branch_id=$2::uuid and s.id=$3::uuid`,
      [staff.tenantId, staff.branchId, sid],
    );
    const x = s.rows[0];
    if (!x) throw new NotFoundException('Liquidación no encontrada.');
    const items = await db.query<PendingRow>(
      `select d.id::text as delivery_id, o.order_number::text, a.completed_at::text as delivered_at,
              d.recipient_name, null::text as client_name, o.order_origin, i.fee::text,
              i.collected_amount::text as collected
         from public.courier_client_statement_items i
         join public.deliveries d on d.id=i.delivery_id
         join public.orders o on o.id=d.order_id
         left join public.delivery_assignments a on a.delivery_id=d.id and a.status='COMPLETED'
        where i.statement_id=$1::uuid order by a.completed_at`,
      [sid],
    );
    return {
      id: x.id,
      number: x.statement_number,
      client: { id: x.client_id, name: x.client_name, taxId: x.client_tax_id },
      periodFrom: x.period_from,
      periodTo: x.period_to,
      deliveryCount: x.delivery_count,
      totalFee: Number(x.total_fee),
      collectedTotal: Number(x.collected_total),
      netAmount: Number(x.net_amount),
      status: x.status,
      paymentMethod: x.payment_method,
      paymentReference: x.payment_reference,
      notes: x.notes,
      paidAt: x.paid_at,
      createdAt: x.created_at,
      deliveries: this.pendingView(items.rows),
    };
  }

  // ---------------- driver pay rules + payouts ----------------

  async listDrivers(staff: Staff) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const r = await this.databaseService.query<{
      id: string;
      code: string;
      display_name: string;
      status: string;
      pay_mode: DriverPayMode;
      pay_value: string;
    }>(
      `select dr.id::text, dr.code, dr.display_name, dr.status, dr.pay_mode, dr.pay_value::text
         from public.delivery_drivers dr
         join public.delivery_driver_branches db on db.tenant_id=dr.tenant_id and db.driver_id=dr.id
        where dr.tenant_id=$1::uuid and db.branch_id=$2::uuid and db.status='ENABLED'
        order by dr.display_name`,
      [staff.tenantId, staff.branchId],
    );
    return {
      drivers: r.rows.map((x) => ({
        id: x.id,
        code: x.code,
        displayName: x.display_name,
        status: x.status,
        payMode: x.pay_mode,
        payValue: Number(x.pay_value),
      })),
    };
  }

  async setDriverPayRule(
    staff: Staff,
    driverId: string,
    input: DriverPayRuleInput,
  ) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const did = id(driverId, 'driverId');
    const mode = input?.payMode as DriverPayMode;
    if (!DRIVER_PAY_MODES.includes(mode))
      throw new BadRequestException('payMode no es válido.');
    const raw =
      typeof input?.payValue === 'string'
        ? Number(input.payValue)
        : input?.payValue;
    if (
      typeof raw !== 'number' ||
      !Number.isFinite(raw) ||
      raw < 0 ||
      raw > 1_000_000
    )
      throw new BadRequestException('payValue no es válido.');
    if (mode === 'PERCENT_OF_FEE' && raw > 100)
      throw new BadRequestException('El porcentaje no puede superar 100.');
    const value = mode === 'NONE' ? 0 : Math.round(raw * 100) / 100;
    const r = await this.databaseService.query(
      `update public.delivery_drivers dr set pay_mode=$3, pay_value=$4
        where dr.tenant_id=$1::uuid and dr.id=$5::uuid
          and exists (select 1 from public.delivery_driver_branches db
                       where db.tenant_id=dr.tenant_id and db.driver_id=dr.id and db.branch_id=$2::uuid)`,
      [staff.tenantId, staff.branchId, mode, value, did],
    );
    if (!r.rowCount) throw new NotFoundException('Conductor no encontrado.');
    return { driverId: did, payMode: mode, payValue: value };
  }

  private async driverPending(
    db: Db,
    staff: Staff,
    driverId: string,
    p: { from: string; to: string },
  ) {
    const r = await db.query<PendingRow>(
      this.completedSql(`and a.driver_id=$5::uuid
         and not exists (select 1 from public.courier_driver_payout_items i where i.delivery_id=d.id)`),
      [staff.tenantId, staff.branchId, p.from, p.to, driverId],
    );
    return r.rows;
  }

  private async driverRule(
    db: Db,
    staff: Staff,
    driverId: string,
    lock = false,
  ) {
    const r = await db.query<{
      display_name: string;
      pay_mode: DriverPayMode;
      pay_value: string;
    }>(
      `select dr.display_name, dr.pay_mode, dr.pay_value::text from public.delivery_drivers dr
        where dr.tenant_id=$1::uuid and dr.id=$2::uuid
          and exists (select 1 from public.delivery_driver_branches db
                       where db.tenant_id=dr.tenant_id and db.driver_id=dr.id and db.branch_id=$3::uuid)
        ${lock ? 'for update' : ''}`,
      [staff.tenantId, driverId, staff.branchId],
    );
    if (!r.rows[0]) throw new NotFoundException('Conductor no encontrado.');
    return {
      name: r.rows[0].display_name,
      mode: r.rows[0].pay_mode,
      value: Number(r.rows[0].pay_value),
    };
  }

  private payoutFigures(
    rule: { mode: DriverPayMode; value: number },
    rows: PendingRow[],
  ) {
    const fees = rows.map((r) => Number(r.fee));
    const pay = driverPay(rule.mode, rule.value, fees);
    return {
      fees,
      pay,
      feeTotal: Math.round(fees.reduce((s, f) => s + f, 0) * 100) / 100,
    };
  }

  async previewDriverPayout(staff: Staff, input: DriverPayoutInput) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const driverId = id(input?.driverId, 'driverId');
    const p = period(input);
    const rule = await this.driverRule(this.databaseService, staff, driverId);
    const rows = await this.driverPending(
      this.databaseService,
      staff,
      driverId,
      p,
    );
    const f = this.payoutFigures(rule, rows);
    return {
      period: p,
      payMode: rule.mode,
      payValue: rule.value,
      deliveries: this.pendingView(rows).map((d, i) => ({
        ...d,
        amount: f.pay.items[i],
      })),
      deliveryCount: rows.length,
      feeTotal: f.feeTotal,
      amount: f.pay.amount,
    };
  }

  async createDriverPayout(staff: Staff, input: DriverPayoutInput) {
    const driverId = id(input?.driverId, 'driverId');
    const p = period(input);
    const notes = shortText(input?.notes, 'notes', 500);
    return this.databaseService.withTransaction(async (db) => {
      await this.assertDeliveryProduct(db, staff);
      const rule = await this.driverRule(db, staff, driverId, true);
      if (rule.mode === 'NONE')
        throw new ConflictException(
          'El conductor no tiene una regla de pago configurada.',
        );
      const rows = await this.driverPending(db, staff, driverId, p);
      if (!rows.length && rule.mode !== 'SALARY')
        throw new ConflictException(
          'No hay entregas sin liquidar de este conductor en ese periodo.',
        );
      if (rule.mode === 'SALARY') {
        const overlap = await db.query(
          `select 1 from public.courier_driver_payouts where tenant_id=$1::uuid and driver_id=$2::uuid and status<>'VOID'
              and pay_mode='SALARY' and period_from<=$4::date and period_to>=$3::date limit 1`,
          [staff.tenantId, driverId, p.from, p.to],
        );
        if (overlap.rowCount)
          throw new ConflictException(
            'Ya existe un pago de sueldo que cubre parte de ese periodo.',
          );
      }
      const f = this.payoutFigures(rule, rows);
      const number = await this.nextNumber(
        db,
        'courier_driver_payouts',
        'payout_number',
        staff.tenantId,
      );
      const po = await db.query<{ id: string }>(
        `insert into public.courier_driver_payouts (tenant_id, branch_id, driver_id, payout_number, period_from, period_to,
                pay_mode, pay_value, delivery_count, fee_total, amount, notes, created_by_staff_user_id)
         values ($1::uuid,$2::uuid,$3::uuid,$4,$5::date,$6::date,$7,$8,$9,$10,$11,$12,$13::uuid) returning id::text`,
        [
          staff.tenantId,
          staff.branchId,
          driverId,
          number,
          p.from,
          p.to,
          rule.mode,
          rule.value,
          rows.length,
          f.feeTotal,
          f.pay.amount,
          notes,
          staff.userId,
        ],
      );
      if (rows.length)
        await db.query(
          `insert into public.courier_driver_payout_items (payout_id, tenant_id, delivery_id, fee, amount)
           select $1::uuid, $2::uuid, x.delivery_id, x.fee, x.amount
             from unnest($3::uuid[], $4::numeric[], $5::numeric[]) as x(delivery_id, fee, amount)`,
          [
            po.rows[0].id,
            staff.tenantId,
            rows.map((r) => r.delivery_id),
            f.fees,
            f.pay.items,
          ],
        );
      return this.getDriverPayout(staff, po.rows[0].id, db);
    });
  }

  async listDriverPayouts(staff: Staff, driverIdInput?: unknown) {
    await this.assertDeliveryProduct(this.databaseService, staff);
    const driverId =
      driverIdInput === undefined || driverIdInput === ''
        ? null
        : id(driverIdInput, 'driverId');
    const r = await this.databaseService.query<{
      id: string;
      payout_number: number;
      driver_name: string;
      period_from: string;
      period_to: string;
      pay_mode: string;
      delivery_count: number;
      amount: string;
      status: string;
      payment_method: string | null;
      paid_at: string | null;
      created_at: string;
    }>(
      `select p.id::text, p.payout_number, dr.display_name as driver_name, p.period_from::text, p.period_to::text, p.pay_mode,
              p.delivery_count, p.amount::text, p.status, p.payment_method, p.paid_at::text, p.created_at::text
         from public.courier_driver_payouts p join public.delivery_drivers dr on dr.id=p.driver_id
        where p.tenant_id=$1::uuid and p.branch_id=$2::uuid and ($3::uuid is null or p.driver_id=$3::uuid)
        order by p.created_at desc limit 100`,
      [staff.tenantId, staff.branchId, driverId],
    );
    return {
      payouts: r.rows.map((x) => ({
        id: x.id,
        number: x.payout_number,
        driverName: x.driver_name,
        periodFrom: x.period_from,
        periodTo: x.period_to,
        payMode: x.pay_mode,
        deliveryCount: x.delivery_count,
        amount: Number(x.amount),
        status: x.status,
        paymentMethod: x.payment_method,
        paidAt: x.paid_at,
        createdAt: x.created_at,
      })),
    };
  }

  async getDriverPayout(
    staff: Staff,
    payoutId: string,
    db: Db = this.databaseService,
  ) {
    const pid = id(payoutId, 'payoutId');
    const s = await db.query<{
      id: string;
      payout_number: number;
      driver_id: string;
      driver_name: string;
      period_from: string;
      period_to: string;
      pay_mode: string;
      pay_value: string;
      delivery_count: number;
      fee_total: string;
      amount: string;
      status: string;
      payment_method: string | null;
      payment_reference: string | null;
      notes: string | null;
      paid_at: string | null;
      created_at: string;
    }>(
      `select p.id::text, p.payout_number, dr.id::text as driver_id, dr.display_name as driver_name, p.period_from::text, p.period_to::text,
              p.pay_mode, p.pay_value::text, p.delivery_count, p.fee_total::text, p.amount::text, p.status,
              p.payment_method, p.payment_reference, p.notes, p.paid_at::text, p.created_at::text
         from public.courier_driver_payouts p join public.delivery_drivers dr on dr.id=p.driver_id
        where p.tenant_id=$1::uuid and p.branch_id=$2::uuid and p.id=$3::uuid`,
      [staff.tenantId, staff.branchId, pid],
    );
    const x = s.rows[0];
    if (!x) throw new NotFoundException('Pago no encontrado.');
    const items = await db.query<PendingRow & { amount: string }>(
      `select d.id::text as delivery_id, o.order_number::text, a.completed_at::text as delivered_at,
              d.recipient_name, c.name as client_name, o.order_origin, i.fee::text, i.amount::text
         from public.courier_driver_payout_items i
         join public.deliveries d on d.id=i.delivery_id
         join public.orders o on o.id=d.order_id
         left join public.courier_clients c on c.tenant_id=d.tenant_id and c.id=d.courier_client_id
         left join public.delivery_assignments a on a.delivery_id=d.id and a.status='COMPLETED'
        where i.payout_id=$1::uuid order by a.completed_at`,
      [pid],
    );
    return {
      id: x.id,
      number: x.payout_number,
      driver: { id: x.driver_id, name: x.driver_name },
      periodFrom: x.period_from,
      periodTo: x.period_to,
      payMode: x.pay_mode,
      payValue: Number(x.pay_value),
      deliveryCount: x.delivery_count,
      feeTotal: Number(x.fee_total),
      amount: Number(x.amount),
      status: x.status,
      paymentMethod: x.payment_method,
      paymentReference: x.payment_reference,
      notes: x.notes,
      paidAt: x.paid_at,
      createdAt: x.created_at,
      deliveries: this.pendingView(items.rows).map((d, i) => ({
        ...d,
        amount: Number(items.rows[i].amount),
      })),
    };
  }

  // ---------------- pay / void (both kinds) ----------------

  private table(kind: 'statement' | 'payout') {
    return kind === 'statement'
      ? {
          table: 'courier_client_statements',
          items: 'courier_client_statement_items',
          fk: 'statement_id',
        }
      : {
          table: 'courier_driver_payouts',
          items: 'courier_driver_payout_items',
          fk: 'payout_id',
        };
  }

  async markPaid(
    staff: Staff,
    kind: 'statement' | 'payout',
    recordId: string,
    input: SettlementPaymentInput,
  ) {
    const rid = id(recordId, 'id');
    const method = input?.paymentMethod;
    if (typeof method !== 'string' || !METHODS.includes(method))
      throw new BadRequestException(
        'paymentMethod debe ser CASH, TRANSFER, QR u OTHER.',
      );
    const reference = shortText(
      input?.paymentReference,
      'paymentReference',
      120,
    );
    const t = this.table(kind);
    return this.databaseService.withTransaction(async (db) => {
      await this.assertDeliveryProduct(db, staff);
      const r = await db.query(
        `update public.${t.table} set status='PAID', paid_at=now(), payment_method=$4, payment_reference=$5
          where tenant_id=$1::uuid and branch_id=$2::uuid and id=$3::uuid and status='ISSUED'`,
        [staff.tenantId, staff.branchId, rid, method, reference],
      );
      if (!r.rowCount) await this.explainNotChanged(db, staff, t.table, rid);
      return kind === 'statement'
        ? this.getClientStatement(staff, rid, db)
        : this.getDriverPayout(staff, rid, db);
    });
  }

  async voidRecord(
    staff: Staff,
    kind: 'statement' | 'payout',
    recordId: string,
  ) {
    const rid = id(recordId, 'id');
    const t = this.table(kind);
    return this.databaseService.withTransaction(async (db) => {
      await this.assertDeliveryProduct(db, staff);
      const r = await db.query(
        `update public.${t.table} set status='VOID', voided_at=now()
          where tenant_id=$1::uuid and branch_id=$2::uuid and id=$3::uuid and status='ISSUED'`,
        [staff.tenantId, staff.branchId, rid],
      );
      if (!r.rowCount) await this.explainNotChanged(db, staff, t.table, rid);
      // Release the deliveries so they can be settled again.
      await db.query(`delete from public.${t.items} where ${t.fk}=$1::uuid`, [
        rid,
      ]);
      return kind === 'statement'
        ? this.getClientStatement(staff, rid, db)
        : this.getDriverPayout(staff, rid, db);
    });
  }

  private async explainNotChanged(
    db: Db,
    staff: Staff,
    table: string,
    rid: string,
  ): Promise<never> {
    const r = await db.query<{ status: string }>(
      `select status from public.${table} where tenant_id=$1::uuid and branch_id=$2::uuid and id=$3::uuid`,
      [staff.tenantId, staff.branchId, rid],
    );
    if (!r.rows[0]) throw new NotFoundException('Liquidación no encontrada.');
    throw new ConflictException(
      r.rows[0].status === 'PAID' ? 'Ya está pagada.' : 'Está anulada.',
    );
  }
}
