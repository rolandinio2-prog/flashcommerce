import { Controller, Get, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  getCatalog(
    @Query('tenant') tenantCode = 'POLLO001',
    @Query('branch') branchCode = 'SUC001',
  ) {
    return this.catalogService.getCatalog(tenantCode, branchCode);
  }
}
