import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../core/database/database.service';
import type { StaffSessionPrincipal } from '../core/staff/staff.types';
import {
  CashSummaryService,
  validateCashSummaryDate,
} from './cash-summary.service';
import {
  closingAmounts,
  decimalAmount,
  minorUnits,
} from './cash-closing-domain';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface CashClosingRow {
  requestId: string;
  snapshotHash: string;
  snapshot: unknown;
  expectedCash: string;
  countedCash: string;
  difference: string;
  note: string | null;
  actorCode: string;
  closedAt: Date;
}

@Injectable()
export class CashClosingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly summary: CashSummaryService,
  ) {}
  private async snapshot(
    client: PoolClient,
    staff: StaffSessionPrincipal,
    date: string,
  ) {
    const report = await this.summary.getSummaryInTransaction(
      client,
      staff,
      date,
    );
    // Include individual receipt identities/states: equal totals must not hide changed receipts.
    const ledger = await client.query<{ fingerprint: string }>(
      `
      select md5(coalesce(jsonb_agg(jsonb_build_array(p.id,p.status,p.amount,p.currency,p.method,p.provider,
        p.paid_at,p.verified_at,o.payment_status,o.total,o.currency,o.order_type) order by p.id)::text,'[]')) as fingerprint
      from public.order_payments p join public.orders o on o.id=p.order_id and o.tenant_id=p.tenant_id and o.branch_id=p.branch_id
      where p.tenant_id=$1::uuid and p.branch_id=$2::uuid
      and p.paid_at >= ($3::date::timestamp at time zone 'America/La_Paz')
      and p.paid_at < (($3::date+1)::timestamp at time zone 'America/La_Paz')`,
      [staff.tenantId, staff.branchId, date],
    );
    const snapshot = {
      date,
      timezone: 'America/La_Paz',
      totals: report.totals,
      ledgerFingerprint: ledger.rows[0].fingerprint,
    };
    const hash = createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex');
    const blocked = report.totals.some(
      (r) =>
        r.currency !== 'BOB' ||
        [
          'REVIEW_REQUIRED',
          'EXCLUDED_LEGACY',
          'REFUND_PENDING',
          'REFUNDED',
        ].includes(r.category),
    );
    const expected = decimalAmount(
      report.totals
        .filter((r) => r.currency === 'BOB' && r.category === 'LOCAL_CASH')
        .reduce((sum, r) => sum + minorUnits(r.amount), 0n),
    );
    return { snapshot, hash, expected, blocked };
  }
  private async existing(
    client: PoolClient,
    staff: StaffSessionPrincipal,
    date: string,
  ): Promise<CashClosingRow | null> {
    const result = await client.query<CashClosingRow>(
      `select request_id::text as "requestId",snapshot_hash as "snapshotHash",snapshot,
      expected_cash::text as "expectedCash",counted_cash::text as "countedCash",difference::text,note,
      actor_code as "actorCode",closed_at as "closedAt" from public.cash_daily_closings
      where tenant_id=$1::uuid and branch_id=$2::uuid and business_date=$3::date`,
      [staff.tenantId, staff.branchId, date],
    );
    return result.rows[0] ?? null;
  }
  async preview(staff: StaffSessionPrincipal, dateInput: unknown) {
    const date = validateCashSummaryDate(dateInput);
    return this.database.withTransaction(async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      const current = await this.snapshot(client, staff, date),
        closing = await this.existing(client, staff, date);
      const day = await client.query<{ today: string }>(
        "select (transaction_timestamp() at time zone 'America/La_Paz')::date::text as today",
      );
      return {
        date,
        expectedCash: current.expected,
        snapshotHash: current.hash,
        totals: current.snapshot.totals,
        closing,
        changedAfterClosing: !!closing && closing.snapshotHash !== current.hash,
        cashChangeAfterClosing: closing
          ? decimalAmount(
              minorUnits(current.expected) - minorUnits(closing.expectedCash),
            )
          : '0.00',
        canClose:
          ['ADMIN', 'MANAGER', 'CASHIER'].includes(staff.role) &&
          date <= day.rows[0].today &&
          !current.blocked &&
          !closing,
        blocked: current.blocked,
        future: date > day.rows[0].today,
      };
    });
  }
  async close(
    staff: StaffSessionPrincipal,
    input: {
      date?: unknown;
      requestId?: unknown;
      snapshotHash?: unknown;
      countedCash?: unknown;
      note?: unknown;
    },
  ) {
    if (!['ADMIN', 'MANAGER', 'CASHIER'].includes(staff.role))
      throw new ForbiddenException('Tu rol no permite cerrar caja.');
    const date = validateCashSummaryDate(input?.date);
    if (
      typeof input.requestId !== 'string' ||
      !UUID.test(input.requestId) ||
      typeof input.snapshotHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.snapshotHash)
    )
      throw new BadRequestException('Solicitud de cierre no valida.');
    try {
      return await this.database.withTransaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        const closing = await this.existing(client, staff, date);
        if (closing) {
          const amounts = closingAmounts(
            closing.expectedCash,
            input.countedCash,
            input.note,
          );
          if (
            closing.requestId === input.requestId &&
            closing.snapshotHash === input.snapshotHash &&
            closing.countedCash === amounts.counted &&
            closing.note === amounts.note
          )
            return closing;
          throw new ConflictException(
            'La caja ya tiene un cierre. Actualiza el resumen.',
          );
        }
        const day = await client.query<{ today: string }>(
          "select (transaction_timestamp() at time zone 'America/La_Paz')::date::text as today",
        );
        if (date > day.rows[0].today)
          throw new BadRequestException('No puedes cerrar una fecha futura.');
        const current = await this.snapshot(client, staff, date);
        if (current.blocked)
          throw new ConflictException(
            'Resuelve las inconsistencias y devoluciones antes del cierre.',
          );
        if (current.hash !== input.snapshotHash)
          throw new ConflictException(
            'Los cobros cambiaron. Actualiza y revisa antes de cerrar.',
          );
        const amounts = closingAmounts(
          current.expected,
          input.countedCash,
          input.note,
        );
        await client.query(
          `insert into public.cash_daily_closings
        (tenant_id,branch_id,business_date,timezone,currency,request_id,snapshot_hash,snapshot,expected_cash,counted_cash,note,actor_id,actor_code)
        values ($1::uuid,$2::uuid,$3::date,'America/La_Paz','BOB',$4::uuid,$5,$6::jsonb,$7::numeric,$8::numeric,$9,$10::uuid,$11)`,
          [
            staff.tenantId,
            staff.branchId,
            date,
            input.requestId,
            current.hash,
            JSON.stringify(current.snapshot),
            amounts.expected,
            amounts.counted,
            amounts.note,
            staff.userId,
            staff.userCode,
          ],
        );
        return this.existing(client, staff, date);
      });
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'MONEY_INVALID',
          'NOTE_INVALID',
          'DIFFERENCE_REASON_REQUIRED',
        ].includes(error.message)
      )
        throw new BadRequestException(
          'Revisa el efectivo contado y explica cualquier diferencia (minimo 5 caracteres).',
        );
      if (['40001', '23505'].includes((error as { code?: string })?.code ?? ''))
        throw new ConflictException(
          'Otra operacion cambio la caja. Consulta el cierre antes de un nuevo intento.',
        );
      throw error;
    }
  }
}
