import { Controller, Get, Module, Req } from '@nestjs/common';
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
    return {
      version: 'operations.access.v1',
      tenantCode: request.staff.tenantCode,
      branchCode: request.staff.branchCode,
      ...getOperationsCapabilities(request.staff.role),
      products: products.rows.map((r) => r.product),
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
