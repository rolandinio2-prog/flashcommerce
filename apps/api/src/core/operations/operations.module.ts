import { Controller, Get, Module, Req } from '@nestjs/common';
import {
  GRACE_DAYS,
  addDays,
  subscriptionState,
  todayIn,
} from '../../platform/billing-rules';
import { DatabaseService } from '../database/database.service';
import { StaffModule } from '../staff/staff.module';
import type { StaffAuthenticatedRequest } from '../staff/staff.types';
import {
  OperationsAccess,
  OperationsGuard,
  OperationsAuditInterceptor,
  OperationPermission,
} from './operations-access';
import { getOperationsCapabilities } from './operations-policy';

@Controller('ops/access')
@OperationsAccess()
export class OperationsCapabilitiesController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @OperationPermission('access.read')
  async get(@Req() request: StaffAuthenticatedRequest) {
    // Products the business has contracted (R4), so the UI can hide areas it cannot use.
    const products = await this.db.query<{ product: string }>(
      "select product from public.tenant_products where tenant_id=$1::uuid and status='ACTIVE' order by product",
      [request.staff.tenantId],
    );
    // Subscription notice (R4b): only shown while due soon or in grace; exempt businesses get null.
    const sub = await this.db.query<{ paid_until: string }>(
      'select paid_until::text from public.tenant_subscriptions where tenant_id=$1::uuid',
      [request.staff.tenantId],
    );
    const paidUntil = sub.rows[0]?.paid_until;
    const status = paidUntil ? subscriptionState(paidUntil, todayIn()) : null;
    return {
      version: 'operations.access.v1',
      tenantCode: request.staff.tenantCode,
      branchCode: request.staff.branchCode,
      ...getOperationsCapabilities(request.staff.role),
      products: products.rows.map((r) => r.product),
      subscription:
        paidUntil && status && status.state !== 'ACTIVE'
          ? {
              ...status,
              paidUntil,
              suspendsOn: addDays(paidUntil, GRACE_DAYS + 1),
            }
          : null,
    };
  }
}
@Module({
  imports: [StaffModule],
  controllers: [OperationsCapabilitiesController],
  providers: [OperationsGuard, OperationsAuditInterceptor],
  exports: [StaffModule, OperationsGuard, OperationsAuditInterceptor],
})
export class OperationsModule {}
