import {
  Body,
  Controller,
  Delete,
  Post,
  Get,
  Header,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OperationsModule } from '../operations/operations.module';
import {
  OperationsAccess,
  OperationPermission,
} from '../operations/operations-access';
import type { StaffAuthenticatedRequest } from '../staff/staff.types';
import { BranchOperationsService } from './branch-operations.service';
import { ProductLifecycleService } from './product-lifecycle.service';
@Controller('ops/branch-configuration')
@OperationsAccess()
export class BranchConfigurationController {
  constructor(
    private readonly service: BranchOperationsService,
    private readonly lifecycle: ProductLifecycleService,
  ) {}
  @Get('services')
  @OperationPermission('configuration.read')
  getServices(@Req() r: StaffAuthenticatedRequest) {
    return this.service.getServices(r.staff);
  }
  @Patch('services')
  @OperationPermission('configuration.write')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  saveServices(@Req() r: StaffAuthenticatedRequest, @Body() body: unknown) {
    return this.service.saveServices(r.staff, body);
  }
  @Get('product-creation-options')
  @OperationPermission('configuration.read')
  creationOptions(@Req() r: StaffAuthenticatedRequest) {
    return this.lifecycle.options(r.staff);
  }
  @Post('products')
  @OperationPermission('configuration.write')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  createProduct(@Req() r: StaffAuthenticatedRequest, @Body() body: unknown) {
    return this.lifecycle.create(r.staff, body);
  }
  @Get('products/:id/deletion')
  @OperationPermission('configuration.read')
  deletion(
    @Req() r: StaffAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.lifecycle.eligibility(r.staff, id);
  }
  @Delete('products/:id')
  @OperationPermission('configuration.write')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  removeProduct(
    @Req() r: StaffAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle.remove(r.staff, id, body);
  }
  @Get('products')
  @OperationPermission('configuration.read')
  getProducts(@Req() r: StaffAuthenticatedRequest) {
    return this.service.getProducts(r.staff);
  }
  @Patch('products/:id')
  @OperationPermission('configuration.write')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  saveProduct(
    @Req() r: StaffAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.service.saveProduct(r.staff, id, body);
  }
}
@Controller('catalog/services')
export class PublicBranchServicesController {
  constructor(private readonly service: BranchOperationsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Query('tenant') tenant?: string, @Query('branch') branch?: string) {
    return this.service.publicServices(tenant, branch);
  }
}
@Module({
  imports: [OperationsModule],
  controllers: [BranchConfigurationController, PublicBranchServicesController],
  providers: [BranchOperationsService, ProductLifecycleService],
})
export class BranchOperationsModule {}
