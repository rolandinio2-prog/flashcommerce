import { Controller, Get, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('branches')
  getBranches(@Query('tenant') tenantCode?: string) {
    return this.catalogService.getBranches(tenantCode);
  }

  @Get()
  getCatalog(
    @Query('tenant') tenantCode?: string,
    @Query('branch') branchCode?: string,
  ) {
    return this.catalogService.getCatalog(tenantCode, branchCode);
  }
}
