import { Controller, Get, Module, Req } from '@nestjs/common';
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
  @Get()
  @OperationPermission('access.read')
  get(@Req() request: StaffAuthenticatedRequest) {
    return {
      version: 'operations.access.v1',
      tenantCode: request.staff.tenantCode,
      branchCode: request.staff.branchCode,
      ...getOperationsCapabilities(request.staff.role),
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
