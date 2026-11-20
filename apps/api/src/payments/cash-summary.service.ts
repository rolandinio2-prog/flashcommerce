import type { PoolClient } from 'pg';
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { StaffSessionPrincipal } from '../staff/staff.types';

export function validateCashSummaryDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException('Indica una fecha valida (AAAA-MM-DD).');
  }
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value || value < '2000-01-01' || value > '2100-12-31') {
    throw new BadRequestException('La fecha no es valida.');
  }
  return value;
}

// Report only. No closing, reconciliation or provider call is performed here.
@Injectable()
export class CashSummaryService {
  constructor(private readonly database: DatabaseService) {}

  async getSummary(principal: Pick<StaffSessionPrincipal, 'tenantId' | 'branchId'>, date: unknown) {
    const day = validateCashSummaryDate(date);
    return this.database.withTransaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return this.getSummaryInTransaction(client, principal, day);
    });
  }

  async getSummaryInTransaction(client: PoolClient, principal: Pick<StaffSessionPrincipal, 'tenantId' | 'branchId'>, day: string) {
      const totals = await client.query<{currency: string; category: string; count: string; amount: string}>(`
        with scoped as (
          select p.*, o.total as order_total, o.currency as order_currency,
                 o.order_type, o.payment_status as order_payment_status,
                 count(*) filter (where p.status in ('PAID','REFUND_PENDING')) over (partition by p.order_id) as paid_attempts
          from public.order_payments p
          join public.orders o on o.id=p.order_id and o.tenant_id=p.tenant_id and o.branch_id=p.branch_id
          where p.tenant_id=$1::uuid and p.branch_id=$2::uuid
        ), classified as (
          select currency, amount,
            case
              when status in ('REFUND_PENDING','REFUNDED') then status
              when paid_attempts<>1 or order_payment_status<>'PAID' or amount<>order_total or currency<>order_currency
                or paid_at is null or verified_at is null then 'REVIEW_REQUIRED'
              when method='QR' and provider='BCP_QR' then 'QR'
              when method='CASH' and provider='CASHIER' and order_type in ('DINE_IN','TAKEAWAY','PICKUP') then 'LOCAL_CASH'
              else 'EXCLUDED_LEGACY'
            end as category
          from scoped
          where status in ('PAID','REFUND_PENDING','REFUNDED')
            and paid_at >= ($3::date::timestamp at time zone 'America/La_Paz')
            and paid_at < (($3::date+1)::timestamp at time zone 'America/La_Paz')
        )
        select currency, category, count(*)::text as count, sum(amount)::text as amount
        from classified group by currency, category order by currency, category
      `, [principal.tenantId, principal.branchId, day]);
      const review = await client.query<{orderNumber: string; status: string; currency: string; total: string; totalRows: string}>(`
        select order_number::text as "orderNumber", payment_status as status, currency, total::text,
               count(*) over ()::text as "totalRows"
        from public.orders
        where tenant_id=$1::uuid and branch_id=$2::uuid and payment_status='REVIEW_REQUIRED'
        order by created_at, id limit 200
      `, [principal.tenantId, principal.branchId]);
      return {
        date: day, timezone: 'America/La_Paz', kind: 'CURRENT_STATE_REPORT' as const,
        totals: totals.rows,
        reviewRequired: review.rows.map(({totalRows: _count, ...row}) => row),
        reviewRequiredCount: review.rows[0]?.totalRows ?? '0',
        limit: 200,
        note: 'Estado actual de los cobros realizados en la fecha. No constituye un cierre de caja. Revisiones pendientes incluyen otras fechas.',
      };
  }
}
