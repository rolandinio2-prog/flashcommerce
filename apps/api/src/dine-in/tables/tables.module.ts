import { OperationsModule } from '../../core/operations/operations.module';
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
  imports: [OperationsModule],
  controllers: [
    TablesController,
    OpsTablesController,
    OpsTableSessionsController,
    OpsOrderTableAssignmentsController,
  ],

  providers: [TablesService],

  exports: [TablesService],
})
export class TablesModule {}
