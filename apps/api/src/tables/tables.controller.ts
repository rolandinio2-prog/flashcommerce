import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import {
  TablesService,
  type AssignOrderTableResponse,
  type CloseOperationalTableSessionResponse,
  type OccupyOperationalTableResponse,
  type OperationalTablesResponse,
  type OperationalTableQrContextResponse,
  type PublicTableContextResponse,
} from './tables.service';

// =========================================================
// TABLES V0.1 CONTROLLER
//
// Endpoint público inicial utilizado por Flash Menu
// para consultar la disponibilidad de mesas.
// =========================================================

@Controller('tables')
export class TablesController {
  constructor(
    private readonly tablesService: TablesService,
  ) {}

  // =======================================================
  // GET /api/v1/tables/context?token=...
  // Valida un QR contextual diario y devuelve su mesa.
  // =======================================================

  @Get('context')
  resolveTableContext(
    @Query('token')
    token?: string,
  ): Promise<PublicTableContextResponse> {
    return this.tablesService.resolveTableContext(
      token,
    );
  }

  // =======================================================
  // GET /api/v1/tables
  //
  // Ejemplo:
  //
  // /api/v1/tables?tenant=POLLO001&branch=SUC001
  // =======================================================

  @Get()
  getTables(
    @Query('tenant')
    tenantCode?: string,

    @Query('branch')
    branchCode?: string,
  ) {
    return this.tablesService.getTables(
      tenantCode,
      branchCode,
    );
  }
}

// =========================================================
// TABLES V0.4 OPERATIONS CONTROLLER
//
// Lectura enriquecida para el panel utilizado por meseros.
// Permite tambien marcar una mesa disponible como ocupada.
// =========================================================

@Controller('ops/tables')
export class OpsTablesController {
  constructor(
    private readonly tablesService: TablesService,
  ) {}

  // =======================================================
  // GET /api/v1/ops/tables
  //
  // Ejemplo:
  //
  // /api/v1/ops/tables?tenant=POLLO001&branch=SUC001
  // =======================================================

  @Get()
  getOperationalTables(
    @Query('tenant')
    tenantCode?: string,

    @Query('branch')
    branchCode?: string,
  ): Promise<OperationalTablesResponse> {
    return this.tablesService.getOperationalTables(
      tenantCode,
      branchCode,
    );
  }

  // =======================================================
  // GET /api/v1/ops/tables/:tableId/qr-context
  // Genera el enlace contextual válido para el día actual.
  // =======================================================

  @Get(':tableId/qr-context')
  getTableQrContext(
    @Param('tableId', new ParseUUIDPipe())
    tableId: string,

    @Query('tenant')
    tenantCode?: string,

    @Query('branch')
    branchCode?: string,
  ): Promise<OperationalTableQrContextResponse> {
    return this.tablesService.getOperationalTableQrContext(
      tableId,
      tenantCode,
      branchCode,
    );
  }

  // =======================================================
  // POST /api/v1/ops/tables/:tableId/occupy
  // =======================================================

  @Post(':tableId/occupy')
  occupyTable(
    @Param('tableId', new ParseUUIDPipe())
    tableId: string,

    @Query('tenant')
    tenantCode?: string,

    @Query('branch')
    branchCode?: string,
  ): Promise<OccupyOperationalTableResponse> {
    return this.tablesService.occupyTable(
      tableId,
      tenantCode,
      branchCode,
    );
  }
}

// =========================================================
// TABLES V0.4 SESSION OPERATIONS CONTROLLER
// =========================================================

@Controller('ops/table-sessions')
export class OpsTableSessionsController {
  constructor(
    private readonly tablesService: TablesService,
  ) {}

  // =======================================================
  // PATCH /api/v1/ops/table-sessions/:sessionId/close
  // =======================================================

  @Patch(':sessionId/close')
  closeTableSession(
    @Param('sessionId', new ParseUUIDPipe())
    sessionId: string,

    @Query('tenant')
    tenantCode?: string,

    @Query('branch')
    branchCode?: string,
  ): Promise<CloseOperationalTableSessionResponse> {
    return this.tablesService.closeTableSession(
      sessionId,
      tenantCode,
      branchCode,
    );
  }
}

// =========================================================
// TABLES V0.5 ORDER ASSIGNMENT CONTROLLER
// =========================================================

@Controller('ops/orders')
export class OpsOrderTableAssignmentsController {
  constructor(
    private readonly tablesService: TablesService,
  ) {}

  // =======================================================
  // PATCH /api/v1/ops/orders/:orderId/table-session
  // Body: { "tableId": "uuid" }
  // =======================================================

  @Patch(':orderId/table-session')
  assignOrderToTable(
    @Param('orderId', new ParseUUIDPipe())
    orderId: string,

    @Body('tableId', new ParseUUIDPipe())
    tableId: string,

    @Query('tenant')
    tenantCode?: string,

    @Query('branch')
    branchCode?: string,
  ): Promise<AssignOrderTableResponse> {
    return this.tablesService.assignOrderToTable(
      orderId,
      tableId,
      tenantCode,
      branchCode,
    );
  }
}
