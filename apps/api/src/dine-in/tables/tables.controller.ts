import {
  OperationsAccess,
  OperationPermission,
} from '../../core/operations/operations-access';
import type { StaffAuthenticatedRequest } from '../../core/staff/staff.types';
import {
  Body,
  Controller,
  Req,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Redirect,
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
  constructor(private readonly tablesService: TablesService) {}

  // =======================================================
  // GET /api/v1/tables/public-qr/:publicQrToken
  //
  // Resolves the permanent physical-table QR into a fresh
  // signed daily table context and redirects to Customer.
  // Scanning is read-only and never creates a table session.
  // =======================================================

  @Get('public-qr/:publicQrToken')
  @Redirect()
  async resolvePermanentTableQr(
    @Param('publicQrToken', new ParseUUIDPipe())
    publicQrToken: string,
  ): Promise<{ url: string; statusCode: number }> {
    const resolution =
      await this.tablesService.resolvePermanentTableQr(publicQrToken);

    return {
      url: resolution.menuUrl,
      statusCode: 307,
    };
  }

  // =======================================================
  // GET /api/v1/tables/context?token=...
  // Valida un QR contextual diario y devuelve su mesa.
  // =======================================================

  @Get('context')
  resolveTableContext(
    @Query('token')
    token?: string,
  ): Promise<PublicTableContextResponse> {
    return this.tablesService.resolveTableContext(token);
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
    return this.tablesService.getTables(tenantCode, branchCode);
  }
}

// =========================================================
// TABLES V0.4 OPERATIONS CONTROLLER
//
// Lectura enriquecida para el panel utilizado por meseros.
// Permite tambien marcar una mesa disponible como ocupada.
// =========================================================

@Controller('ops/tables')
@OperationsAccess()
export class OpsTablesController {
  constructor(private readonly tablesService: TablesService) {}

  // =======================================================
  // GET /api/v1/ops/tables
  //
  // Ejemplo:
  //
  // /api/v1/ops/tables?tenant=POLLO001&branch=SUC001
  // =======================================================

  @Get()
  @OperationPermission('tables.read')
  getOperationalTables(
    @Req() request: StaffAuthenticatedRequest,
  ): Promise<OperationalTablesResponse> {
    return this.tablesService.getOperationalTables(
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }

  // =======================================================
  // GET /api/v1/ops/tables/:tableId/qr-context
  // Genera el enlace contextual válido para el día actual.
  // =======================================================

  @Get(':tableId/qr-context')
  @OperationPermission('tables.read')
  getTableQrContext(
    @Req() request: StaffAuthenticatedRequest,
    @Param('tableId', new ParseUUIDPipe())
    tableId: string,
  ): Promise<OperationalTableQrContextResponse> {
    return this.tablesService.getOperationalTableQrContext(
      tableId,
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }

  // =======================================================
  // POST /api/v1/ops/tables/:tableId/occupy
  // =======================================================

  @Post(':tableId/occupy')
  @OperationPermission('tables.manage')
  occupyTable(
    @Req() request: StaffAuthenticatedRequest,
    @Param('tableId', new ParseUUIDPipe())
    tableId: string,
  ): Promise<OccupyOperationalTableResponse> {
    return this.tablesService.occupyTable(
      tableId,
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }
}

// =========================================================
// TABLES V0.4 SESSION OPERATIONS CONTROLLER
// =========================================================

@Controller('ops/table-sessions')
@OperationsAccess()
export class OpsTableSessionsController {
  constructor(private readonly tablesService: TablesService) {}

  // =======================================================
  // PATCH /api/v1/ops/table-sessions/:sessionId/close
  // =======================================================

  @Patch(':sessionId/close')
  @OperationPermission('tables.manage')
  closeTableSession(
    @Req() request: StaffAuthenticatedRequest,
    @Param('sessionId', new ParseUUIDPipe())
    sessionId: string,
  ): Promise<CloseOperationalTableSessionResponse> {
    return this.tablesService.closeTableSession(
      sessionId,
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }
}

// =========================================================
// TABLES V0.5 ORDER ASSIGNMENT CONTROLLER
// =========================================================

@Controller('ops/orders')
@OperationsAccess()
export class OpsOrderTableAssignmentsController {
  constructor(private readonly tablesService: TablesService) {}

  // =======================================================
  // PATCH /api/v1/ops/orders/:orderId/table-session
  // Body: { "tableId": "uuid" }
  // =======================================================

  @Patch(':orderId/table-session')
  @OperationPermission('tables.manage')
  assignOrderToTable(
    @Req() request: StaffAuthenticatedRequest,
    @Param('orderId', new ParseUUIDPipe())
    orderId: string,

    @Body('tableId', new ParseUUIDPipe())
    tableId: string,
  ): Promise<AssignOrderTableResponse> {
    return this.tablesService.assignOrderToTable(
      orderId,
      tableId,
      request.staff.tenantCode,
      request.staff.branchCode,
    );
  }
}
