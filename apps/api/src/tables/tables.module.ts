import { Module } from '@nestjs/common';

import {
  OpsOrderTableAssignmentsController,
  OpsTableSessionsController,
  OpsTablesController,
  TablesController,
} from './tables.controller';
import { TablesService } from './tables.service';

// =========================================================
// TABLES MODULE
// =========================================================

@Module({
  controllers: [
    TablesController,
    OpsTablesController,
    OpsTableSessionsController,
    OpsOrderTableAssignmentsController,
  ],

  providers: [
    TablesService,
  ],

  exports: [
    TablesService,
  ],
})
export class TablesModule {}
