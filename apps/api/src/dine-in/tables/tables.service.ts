import { lockBranchAdmission } from '../../core/branch-operations/service-policy';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { DatabaseService } from '../../core/database/database.service';
import {
  getTableContextExpiration,
  issueTableContext,
  TABLE_CONTEXT_TIME_ZONE,
  verifyTableContextToken,
} from './table-context-token';

// =========================================================
// TABLES V0.1
//
// Servicio encargado de consultar las mesas físicas
// configuradas para una sucursal y calcular su
// disponibilidad actual.
//
// AVAILABLE:
//   no tiene una table_session OPEN.
//
// OCCUPIED:
//   tiene una table_session OPEN.
// =========================================================

export type TableAvailability = 'AVAILABLE' | 'OCCUPIED';

interface DiningTableRow {
  id: string;

  code: string;
  name: string;

  capacity: number;

  zone: string | null;

  availability: TableAvailability;
}

// =========================================================
// TABLES V0.4
// Contrato de lectura para el panel operativo de meseros.
// =========================================================

export type OperationalOrderStatus =
  'PENDING' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED';

export interface OperationalTableOrder {
  id: string;
  orderNumber: string;
  orderType: 'DINE_IN';
  status: OperationalOrderStatus;
  total: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface OperationalTableSession {
  id: string;
  status: 'OPEN';
  openedAt: string | Date;
  occupiedMinutes: number;
}

export interface OperationalTable {
  id: string;
  code: string;
  name: string;
  capacity: number;
  zone: string | null;
  availability: TableAvailability;
  tableSession: OperationalTableSession | null;
  orders: OperationalTableOrder[];
}

export interface OperationalTablesResponse {
  tenant: string;
  branch: string;
  total: number;
  available: number;
  occupied: number;
  tables: OperationalTable[];
}

export interface OccupyOperationalTableResponse {
  tenant: string;
  branch: string;
  table: {
    id: string;
    code: string;
    name: string;
    capacity: number;
    zone: string | null;
    availability: 'OCCUPIED';
  };
  tableSession: {
    id: string;
    status: 'OPEN';
    openedAt: string | Date;
  };
}

export interface CloseOperationalTableSessionResponse {
  tenant: string;
  branch: string;
  table: {
    id: string;
    code: string;
    name: string;
    availability: 'AVAILABLE';
  };
  tableSession: {
    id: string;
    previousStatus: 'OPEN';
    status: 'CLOSED';
    closedAt: string | Date;
    updatedAt: string | Date;
  };
}

export interface AssignOrderTableResponse {
  tenant: string;
  branch: string;
  order: {
    id: string;
    orderNumber: string;
    orderType: 'DINE_IN';
    status: OperationalOrderStatus;
    tableCode: string;
    tableSessionId: string;
    changed: true;
  };
  table: {
    id: string;
    code: string;
    name: string;
    capacity: number;
    zone: string | null;
    availability: 'OCCUPIED';
  };
  tableSession: {
    id: string;
    status: 'OPEN';
    openedAt: string | Date;
    created: boolean;
  };
}

export interface TableContextCurrentOrder {
  orderNumber: string;
  trackingToken: string;
  status: OperationalOrderStatus;
}

export interface OperationalTableQrContextResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  validOn: string;
  expiresAt: string;
  contextToken: string;
  menuUrl: string;
  permanentUrl: string;
  tableSession: {
    id: string;
    status: 'OPEN';
  } | null;
  currentOrder: TableContextCurrentOrder | null;
  table: {
    id: string;
    code: string;
    name: string;
    capacity: number;
    zone: string | null;
    availability: TableAvailability;
  };
}

export interface PublicTableContextResponse {
  tenant: string;
  branch: string;
  timeZone: string;
  validOn: string;
  expiresAt: string;
  sessionBound: boolean;
  table: {
    id: string;
    code: string;
    name: string;
    capacity: number;
    zone: string | null;
    availability: TableAvailability;
  };
}

export interface PermanentTableQrResolutionResponse {
  tenant: string;
  branch: string;
  validOn: string;
  expiresAt: string;
  menuUrl: string;
  table: {
    id: string;
    code: string;
    name: string;
  };
}

interface PermanentQrDiningTableRow {
  id: string;
  code: string;
  name: string;
  tenant_code: string;
  branch_code: string;
}

interface OperationalDiningTableRow {
  id: string;

  code: string;
  name: string;

  capacity: number;

  zone: string | null;

  availability: TableAvailability;

  table_session_id: string | null;
  table_session_status: 'OPEN' | null;
  table_session_opened_at: string | Date | null;
  occupied_minutes: number | null;

  orders: OperationalTableOrder[];
}

interface LockedOperationalDiningTableRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  code: string;
  name: string;
  capacity: number;
  zone: string | null;
  is_active: boolean;
}

interface ExistingOperationalTableSessionRow {
  id: string;
}

interface CreatedOperationalTableSessionRow {
  id: string;
  status: 'OPEN';
  opened_at: string | Date;
}

interface LockedOperationalTableSessionRow {
  id: string;
  status: 'OPEN' | 'CLOSED';
  tenant_id: string;
  branch_id: string;
  table_id: string;
  table_code: string;
  table_name: string;
}

interface ClosedOperationalTableSessionRow {
  id: string;
  status: 'CLOSED';
  closed_at: string | Date;
  updated_at: string | Date;
}

interface AssignableOrderRow {
  id: string;
  order_number: string;
  order_type: string;
  status: OperationalOrderStatus;
  tenant_id: string;
  branch_id: string;
  table_code: string | null;
  table_session_id: string | null;
}

interface AssignableOpenTableSessionRow {
  id: string;
  status: 'OPEN';
  opened_at: string | Date;
}

interface UpdatedOrderTableRow {
  id: string;
  order_number: string;
  order_type: 'DINE_IN';
  status: OperationalOrderStatus;
  table_code: string;
  table_session_id: string;
}

interface TableContextRow {
  id: string;
  code: string;
  name: string;
  capacity: number;
  zone: string | null;
  availability: TableAvailability;
  table_session_id: string | null;
}

interface TableContextOrderRow {
  order_number: string;
  tracking_token: string;
  status: OperationalOrderStatus;
}

@Injectable()
export class TablesService {
  constructor(private readonly databaseService: DatabaseService) {}

  // =======================================================
  // 1. LISTAR MESAS DE UNA SUCURSAL
  // =======================================================

  async getTables(
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ) {
    // -----------------------------------------------------
    // Valores por defecto para nuestro laboratorio.
    //
    // Más adelante estos códigos vendrán siempre
    // explícitamente desde la sesión/contexto Flash.
    // -----------------------------------------------------

    const tenant = tenantCode?.trim() || 'POLLO001';

    const branch = branchCode?.trim() || 'SUC001';

    // -----------------------------------------------------
    // Una mesa activa se considera OCCUPIED solamente
    // cuando tiene una table_session OPEN.
    // -----------------------------------------------------

    const result = await this.databaseService.query<DiningTableRow>(
      `
          select
            dt.id::text,
            dt.code,
            dt.name,
            dt.capacity,
            dt.zone,

            case
              when ts.id is null
                then 'AVAILABLE'
              else 'OCCUPIED'
            end as availability

          from public.dining_tables dt

          inner join public.tenants t
            on t.id = dt.tenant_id

          inner join public.branches b
            on b.tenant_id = dt.tenant_id
           and b.id = dt.branch_id

          left join public.table_sessions ts
            on ts.tenant_id = dt.tenant_id
           and ts.branch_id = dt.branch_id
           and ts.table_id = dt.id
           and ts.status = 'OPEN'

          where t.code = $1
            and b.code = $2
            and dt.is_active = true

          order by
            dt.zone nulls last,
            dt.sort_order,
            dt.name
        `,
      [tenant, branch],
    );

    return {
      tenant,
      branch,

      total: result.rows.length,

      available: result.rows.filter(
        (table) => table.availability === 'AVAILABLE',
      ).length,

      occupied: result.rows.filter((table) => table.availability === 'OCCUPIED')
        .length,

      tables: result.rows.map((table) => ({
        id: table.id,

        code: table.code,

        name: table.name,

        capacity: table.capacity,

        zone: table.zone,

        availability: table.availability,
      })),
    };
  }

  private async getTableContextCurrentOrder(
    tableSessionId: string | null,
  ): Promise<TableContextCurrentOrder | null> {
    if (!tableSessionId) {
      return null;
    }

    const result = await this.databaseService.query<TableContextOrderRow>(
      `
          select
            o.order_number::text,
            o.tracking_token::text,
            o.status

          from public.orders o

          where o.table_session_id = $1::uuid
            and o.order_type = 'DINE_IN'
            and o.status <> 'CANCELLED'

          order by
            case
              when o.status in (
                'PENDING',
                'CONFIRMED',
                'PREPARING',
                'READY'
              )
                then 0
              else 1
            end,
            o.created_at desc

          limit 1
        `,
      [tableSessionId],
    );

    const order = result.rows[0];

    if (!order) {
      return null;
    }

    return {
      orderNumber: order.order_number,
      trackingToken: order.tracking_token,
      status: order.status,
    };
  }

  // =======================================================
  // 2. QR CONTEXTUAL DIARIO POR MESA
  // =======================================================

  async getOperationalTableQrContext(
    tableId: string,
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ): Promise<OperationalTableQrContextResponse> {
    const tenant = tenantCode?.trim() || 'POLLO001';

    const branch = branchCode?.trim() || 'SUC001';

    const result = await this.databaseService.query<TableContextRow>(
      `
          select
            dt.id::text,
            dt.code,
            dt.name,
            dt.capacity,
            dt.zone,
            dt.public_qr_token::text as public_qr_token,
            ts.id::text as table_session_id,

            case
              when ts.id is null
                then 'AVAILABLE'
              else 'OCCUPIED'
            end as availability

          from public.dining_tables dt

          inner join public.tenants t
            on t.id = dt.tenant_id

          inner join public.branches b
            on b.tenant_id = dt.tenant_id
           and b.id = dt.branch_id

          left join public.table_sessions ts
            on ts.tenant_id = dt.tenant_id
           and ts.branch_id = dt.branch_id
           and ts.table_id = dt.id
           and ts.status = 'OPEN'

          where dt.id = $1::uuid
            and t.code = $2
            and b.code = $3
            and dt.is_active = true

          limit 1
        `,
      [tableId, tenant, branch],
    );

    const table = result.rows[0];

    if (!table) {
      throw new NotFoundException(
        'Active table not found for this tenant and branch',
      );
    }

    const permanentQrToken = (
      table as TableContextRow & {
        public_qr_token: string;
      }
    ).public_qr_token;

    if (!permanentQrToken) {
      throw new NotFoundException(
        'Permanent QR token is not configured for this table',
      );
    }

    const currentOrder = await this.getTableContextCurrentOrder(
      table.table_session_id,
    );

    const context = issueTableContext({
      tenant,
      branch,
      tableId: table.id,
      tableCode: table.code,
      tableSessionId: table.table_session_id ?? undefined,
    });

    const customerUrl = new URL(
      process.env.FLASH_CUSTOMER_URL?.trim() || 'http://localhost:3000',
    );

    customerUrl.pathname = '/';
    customerUrl.search = '';
    customerUrl.hash = '';
    customerUrl.searchParams.set('tableContext', context.token);

    const permanentUrl = new URL(
      process.env.FLASH_TABLE_QR_PUBLIC_BASE_URL?.trim() ||
        'https://q.fastpay.com.bo',
    );

    permanentUrl.pathname = `/t/${permanentQrToken}`;
    permanentUrl.search = '';
    permanentUrl.hash = '';

    return {
      tenant,
      branch,
      timeZone: TABLE_CONTEXT_TIME_ZONE,
      validOn: context.validOn,
      expiresAt: context.expiresAt,
      contextToken: context.token,
      menuUrl: customerUrl.toString(),
      permanentUrl: permanentUrl.toString(),
      tableSession:
        table.table_session_id === null
          ? null
          : {
              id: table.table_session_id,
              status: 'OPEN',
            },
      currentOrder,
      table: {
        id: table.id,
        code: table.code,
        name: table.name,
        capacity: table.capacity,
        zone: table.zone,
        availability: table.availability,
      },
    };
  }

  async resolvePermanentTableQr(
    publicQrToken: string,
  ): Promise<PermanentTableQrResolutionResponse> {
    const normalizedToken = publicQrToken.trim();

    if (!normalizedToken) {
      throw new BadRequestException('public table QR token is required');
    }

    const result = await this.databaseService.query<PermanentQrDiningTableRow>(
      `
          select
            dt.id::text,
            dt.code,
            dt.name,
            t.code as tenant_code,
            b.code as branch_code

          from public.dining_tables dt

          inner join public.tenants t
            on t.id = dt.tenant_id

          inner join public.branches b
            on b.tenant_id = dt.tenant_id
           and b.id = dt.branch_id

          where dt.public_qr_token = $1::uuid
            and dt.is_active = true

          limit 1
        `,
      [normalizedToken],
    );

    const table = result.rows[0];

    if (!table) {
      throw new NotFoundException(
        'Permanent table QR does not reference an active table',
      );
    }

    // The permanent QR identifies only the physical table.
    // Do NOT bind this issued context to the current table
    // session. Order checkout may reuse the OPEN session via
    // the validated table context, while the printed QR stays
    // valid across future table sessions.
    const context = issueTableContext({
      tenant: table.tenant_code,
      branch: table.branch_code,
      tableId: table.id,
      tableCode: table.code,
    });

    const customerUrl = new URL(
      process.env.FLASH_CUSTOMER_URL?.trim() || 'http://localhost:3000',
    );

    customerUrl.pathname = '/';
    customerUrl.search = '';
    customerUrl.hash = '';
    customerUrl.searchParams.set('tableContext', context.token);

    return {
      tenant: table.tenant_code,
      branch: table.branch_code,
      validOn: context.validOn,
      expiresAt: context.expiresAt,
      menuUrl: customerUrl.toString(),
      table: {
        id: table.id,
        code: table.code,
        name: table.name,
      },
    };
  }

  async resolveTableContext(
    token: string | undefined,
  ): Promise<PublicTableContextResponse> {
    const normalizedToken = token?.trim();

    if (!normalizedToken) {
      throw new BadRequestException('table context token is required');
    }

    const payload = verifyTableContextToken(normalizedToken);

    if (!payload) {
      throw new BadRequestException(
        'table context token is invalid or expired',
      );
    }

    const result = await this.databaseService.query<TableContextRow>(
      `
          select
            dt.id::text,
            dt.code,
            dt.name,
            dt.capacity,
            dt.zone,
            ts.id::text as table_session_id,

            case
              when ts.id is null
                then 'AVAILABLE'
              else 'OCCUPIED'
            end as availability

          from public.dining_tables dt

          inner join public.tenants t
            on t.id = dt.tenant_id

          inner join public.branches b
            on b.tenant_id = dt.tenant_id
           and b.id = dt.branch_id

          left join public.table_sessions ts
            on ts.tenant_id = dt.tenant_id
           and ts.branch_id = dt.branch_id
           and ts.table_id = dt.id
           and ts.status = 'OPEN'

          where dt.id = $1::uuid
            and dt.code = $2
            and t.code = $3
            and b.code = $4
            and dt.is_active = true

          limit 1
        `,
      [payload.tableId, payload.tableCode, payload.tenant, payload.branch],
    );

    const table = result.rows[0];

    if (!table) {
      throw new NotFoundException(
        'Table context no longer references an active table',
      );
    }

    if (
      payload.tableSessionId &&
      table.table_session_id !== payload.tableSessionId
    ) {
      throw new BadRequestException('table context session is no longer open');
    }

    const sessionBound =
      Boolean(payload.tableSessionId) &&
      table.table_session_id === payload.tableSessionId;

    return {
      tenant: payload.tenant,
      branch: payload.branch,
      timeZone: TABLE_CONTEXT_TIME_ZONE,
      validOn: payload.validOn,
      expiresAt: getTableContextExpiration(payload.validOn),
      sessionBound,
      table: {
        id: table.id,
        code: table.code,
        name: table.name,
        capacity: table.capacity,
        zone: table.zone,
        availability: table.availability,
      },
    };
  }

  // =======================================================
  // 3. LISTAR MESAS PARA OPERACIONES
  //
  // Este contrato es independiente del selector publico.
  // Incluye la sesion OPEN y los pedidos que pertenecen a
  // esa sesion, aunque ya se encuentren COMPLETED.
  // =======================================================

  async getOperationalTables(
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ): Promise<OperationalTablesResponse> {
    const tenant = tenantCode?.trim() || 'POLLO001';

    const branch = branchCode?.trim() || 'SUC001';

    const result = await this.databaseService.query<OperationalDiningTableRow>(
      `
          select
            dt.id::text,
            dt.code,
            dt.name,
            dt.capacity,
            dt.zone,

            case
              when ts.id is null
                then 'AVAILABLE'
              else 'OCCUPIED'
            end as availability,

            ts.id::text as table_session_id,
            ts.status as table_session_status,
            ts.opened_at as table_session_opened_at,

            case
              when ts.id is null
                then null
              else greatest(
                floor(
                  extract(
                    epoch from (now() - ts.opened_at)
                  ) / 60
                )::integer,
                0
              )
            end as occupied_minutes,

            coalesce(
              session_orders.orders,
              '[]'::jsonb
            ) as orders

          from public.dining_tables dt

          inner join public.tenants t
            on t.id = dt.tenant_id

          inner join public.branches b
            on b.tenant_id = dt.tenant_id
           and b.id = dt.branch_id

          left join public.table_sessions ts
            on ts.tenant_id = dt.tenant_id
           and ts.branch_id = dt.branch_id
           and ts.table_id = dt.id
           and ts.status = 'OPEN'

          left join lateral (
            select
              jsonb_agg(
                jsonb_build_object(
                  'id',
                  o.id::text,

                  'orderNumber',
                  o.order_number::text,

                  'orderType',
                  o.order_type,

                  'status',
                  o.status,

                  'total',
                  o.total,

                  'createdAt',
                  o.created_at,

                  'updatedAt',
                  o.updated_at
                )
                order by o.created_at
              ) as orders

            from public.orders o

            where o.tenant_id = dt.tenant_id
              and o.branch_id = dt.branch_id
              and o.table_session_id = ts.id
          ) session_orders
            on ts.id is not null

          where t.code = $1
            and b.code = $2
            and dt.is_active = true

          order by
            dt.zone nulls last,
            dt.sort_order,
            dt.name
        `,
      [tenant, branch],
    );

    return {
      tenant,
      branch,

      total: result.rows.length,

      available: result.rows.filter(
        (table) => table.availability === 'AVAILABLE',
      ).length,

      occupied: result.rows.filter((table) => table.availability === 'OCCUPIED')
        .length,

      tables: result.rows.map((table) => ({
        id: table.id,

        code: table.code,

        name: table.name,

        capacity: table.capacity,

        zone: table.zone,

        availability: table.availability,

        tableSession:
          table.table_session_id === null ||
          table.table_session_status === null ||
          table.table_session_opened_at === null
            ? null
            : {
                id: table.table_session_id,

                status: table.table_session_status,

                openedAt: table.table_session_opened_at,

                occupiedMinutes: table.occupied_minutes ?? 0,
              },

        orders: table.orders,
      })),
    };
  }

  // =======================================================
  // 3. MARCAR UNA MESA COMO OCUPADA
  //
  // La mesa se bloquea antes de comprobar la sesion OPEN.
  // Este bloqueo se coordina con el checkout DINE_IN y evita
  // que un cliente y un mesero ocupen la misma mesa a la vez.
  // =======================================================

  async occupyTable(
    tableId: string,
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ): Promise<OccupyOperationalTableResponse> {
    const tenant = tenantCode?.trim() || 'POLLO001';

    const branch = branchCode?.trim() || 'SUC001';

    return this.databaseService.withTransaction(async (client) => {
      const tableResult = await client.query<LockedOperationalDiningTableRow>(
        `
              select
                dt.id::text,
                dt.tenant_id::text,
                dt.branch_id::text,
                dt.code,
                dt.name,
                dt.capacity,
                dt.zone,
                dt.is_active

              from public.dining_tables dt

              inner join public.tenants t
                on t.id = dt.tenant_id

              inner join public.branches b
                on b.tenant_id = dt.tenant_id
               and b.id = dt.branch_id

              where dt.id = $1::uuid
                and t.code = $2
                and b.code = $3

              for update of dt
            `,
        [tableId, tenant, branch],
      );

      const table = tableResult.rows[0];

      if (!table) {
        throw new NotFoundException(
          'Table not found for this tenant and branch',
        );
      }

      await lockBranchAdmission(client, table.tenant_id, table.branch_id, [
        'DINE_IN',
      ]);

      if (!table.is_active) {
        throw new ConflictException(`${table.name} is not active`);
      }

      const openSessionResult =
        await client.query<ExistingOperationalTableSessionRow>(
          `
              select
                ts.id::text

              from public.table_sessions ts

              where ts.tenant_id = $1::uuid
                and ts.branch_id = $2::uuid
                and ts.table_id = $3::uuid
                and ts.status = 'OPEN'

              limit 1
            `,
          [table.tenant_id, table.branch_id, table.id],
        );

      if (openSessionResult.rows[0]) {
        throw new ConflictException(`${table.name} is already occupied`);
      }

      const sessionResult =
        await client.query<CreatedOperationalTableSessionRow>(
          `
              insert into public.table_sessions (
                tenant_id,
                branch_id,
                table_id,
                status
              )
              values (
                $1::uuid,
                $2::uuid,
                $3::uuid,
                'OPEN'
              )
              returning
                id::text,
                status,
                opened_at
            `,
          [table.tenant_id, table.branch_id, table.id],
        );

      const session = sessionResult.rows[0];

      const response: OccupyOperationalTableResponse = {
        tenant,
        branch,

        table: {
          id: table.id,

          code: table.code,

          name: table.name,

          capacity: table.capacity,

          zone: table.zone,

          availability: 'OCCUPIED',
        },

        tableSession: {
          id: session.id,

          status: session.status,

          openedAt: session.opened_at,
        },
      };

      return response;
    });
  }

  // =======================================================
  // 4. LIBERAR MANUALMENTE UNA MESA POR SU SESION
  //
  // La operacion pertenece a table_sessions, no a orders.
  // Por eso funciona con sesiones sin pedido y con sesiones
  // cuyos pedidos ya se encuentran COMPLETED.
  // =======================================================

  async closeTableSession(
    sessionId: string,
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ): Promise<CloseOperationalTableSessionResponse> {
    const tenant = tenantCode?.trim() || 'POLLO001';

    const branch = branchCode?.trim() || 'SUC001';

    return this.databaseService.withTransaction(async (client) => {
      const sessionResult =
        await client.query<LockedOperationalTableSessionRow>(
          `
              select
                ts.id::text,
                ts.status,
                ts.tenant_id::text,
                ts.branch_id::text,

                dt.id::text as table_id,
                dt.code as table_code,
                dt.name as table_name

              from public.table_sessions ts

              inner join public.dining_tables dt
                on dt.tenant_id = ts.tenant_id
               and dt.branch_id = ts.branch_id
               and dt.id = ts.table_id

              inner join public.tenants t
                on t.id = ts.tenant_id

              inner join public.branches b
                on b.tenant_id = ts.tenant_id
               and b.id = ts.branch_id

              where ts.id = $1::uuid
                and t.code = $2
                and b.code = $3

              for update of dt, ts
            `,
          [sessionId, tenant, branch],
        );

      const session = sessionResult.rows[0];

      if (!session) {
        throw new NotFoundException(
          'Table session not found for this tenant and branch',
        );
      }

      if (session.status !== 'OPEN') {
        throw new ConflictException('Table session is already closed');
      }

      const updateResult = await client.query<ClosedOperationalTableSessionRow>(
        `
              update public.table_sessions

              set
                status = 'CLOSED',
                closed_at = now(),
                updated_at = now()

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid
                and status = 'OPEN'

              returning
                id::text,
                status,
                closed_at,
                updated_at
            `,
        [session.tenant_id, session.branch_id, session.id],
      );

      const closedSession = updateResult.rows[0];

      if (!closedSession) {
        throw new ConflictException('Table session is no longer open');
      }

      const response: CloseOperationalTableSessionResponse = {
        tenant,
        branch,

        table: {
          id: session.table_id,

          code: session.table_code,

          name: session.table_name,

          availability: 'AVAILABLE',
        },

        tableSession: {
          id: closedSession.id,

          previousStatus: 'OPEN',

          status: closedSession.status,

          closedAt: closedSession.closed_at,

          updatedAt: closedSession.updated_at,
        },
      };

      return response;
    });
  }

  // =======================================================
  // 5. ASIGNAR UN PEDIDO DINE_IN A UNA MESA
  //
  // Si la mesa ya tiene una sesion OPEN, el pedido se
  // vincula a esa sesion. Si esta disponible, se crea una
  // sesion OPEN y se vincula el pedido dentro de la misma
  // transaccion.
  // =======================================================

  async assignOrderToTable(
    orderId: string,
    tableId: string,
    tenantCode: string | undefined,
    branchCode: string | undefined,
  ): Promise<AssignOrderTableResponse> {
    const tenant = tenantCode?.trim() || 'POLLO001';

    const branch = branchCode?.trim() || 'SUC001';

    return this.databaseService.withTransaction(async (client) => {
      const orderResult = await client.query<AssignableOrderRow>(
        `
              select
                o.id::text,
                o.order_number::text,
                o.order_type,
                o.status,
                o.tenant_id::text,
                o.branch_id::text,
                o.table_code,
                o.table_session_id::text

              from public.orders o

              inner join public.tenants t
                on t.id = o.tenant_id

              inner join public.branches b
                on b.tenant_id = o.tenant_id
               and b.id = o.branch_id

              where o.id = $1::uuid
                and t.code = $2
                and b.code = $3

              for update of o
            `,
        [orderId, tenant, branch],
      );

      const order = orderResult.rows[0];

      if (!order) {
        throw new NotFoundException(
          'Order not found for this tenant and branch',
        );
      }

      if (order.order_type !== 'DINE_IN') {
        throw new ConflictException(
          'Only DINE_IN orders can be assigned to a table',
        );
      }

      if (order.status === 'CANCELLED') {
        throw new ConflictException(
          'A cancelled order cannot be assigned to a table',
        );
      }

      if (order.table_session_id !== null) {
        throw new ConflictException('Order already has a table session');
      }

      const tableResult = await client.query<LockedOperationalDiningTableRow>(
        `
              select
                dt.id::text,
                dt.tenant_id::text,
                dt.branch_id::text,
                dt.code,
                dt.name,
                dt.capacity,
                dt.zone,
                dt.is_active

              from public.dining_tables dt

              where dt.id = $1::uuid
                and dt.tenant_id = $2::uuid
                and dt.branch_id = $3::uuid

              for update of dt
            `,
        [tableId, order.tenant_id, order.branch_id],
      );

      const table = tableResult.rows[0];

      if (!table) {
        throw new NotFoundException(
          'Table not found for this tenant and branch',
        );
      }

      if (!table.is_active) {
        throw new ConflictException(`${table.name} is not active`);
      }

      const openSessionResult =
        await client.query<AssignableOpenTableSessionRow>(
          `
              select
                ts.id::text,
                ts.status,
                ts.opened_at

              from public.table_sessions ts

              where ts.tenant_id = $1::uuid
                and ts.branch_id = $2::uuid
                and ts.table_id = $3::uuid
                and ts.status = 'OPEN'

              limit 1
            `,
          [order.tenant_id, order.branch_id, table.id],
        );

      let session = openSessionResult.rows[0];

      let sessionCreated = false;

      if (!session) {
        const sessionResult =
          await client.query<CreatedOperationalTableSessionRow>(
            `
                insert into public.table_sessions (
                  tenant_id,
                  branch_id,
                  table_id,
                  status
                )
                values (
                  $1::uuid,
                  $2::uuid,
                  $3::uuid,
                  'OPEN'
                )
                returning
                  id::text,
                  status,
                  opened_at
              `,
            [order.tenant_id, order.branch_id, table.id],
          );

        session = sessionResult.rows[0];

        sessionCreated = true;
      }

      const updateResult = await client.query<UpdatedOrderTableRow>(
        `
              update public.orders

              set
                table_code = $4,
                table_session_id = $5::uuid,
                updated_at = now()

              where tenant_id = $1::uuid
                and branch_id = $2::uuid
                and id = $3::uuid
                and table_session_id is null

              returning
                id::text,
                order_number::text,
                order_type,
                status,
                table_code,
                table_session_id::text
            `,
        [order.tenant_id, order.branch_id, order.id, table.code, session.id],
      );

      const updatedOrder = updateResult.rows[0];

      if (!updatedOrder) {
        throw new ConflictException(
          'Order table assignment changed during this operation',
        );
      }

      const response: AssignOrderTableResponse = {
        tenant,
        branch,

        order: {
          id: updatedOrder.id,

          orderNumber: updatedOrder.order_number,

          orderType: updatedOrder.order_type,

          status: updatedOrder.status,

          tableCode: updatedOrder.table_code,

          tableSessionId: updatedOrder.table_session_id,

          changed: true,
        },

        table: {
          id: table.id,

          code: table.code,

          name: table.name,

          capacity: table.capacity,

          zone: table.zone,

          availability: 'OCCUPIED',
        },

        tableSession: {
          id: session.id,

          status: session.status,

          openedAt: session.opened_at,

          created: sessionCreated,
        },
      };

      return response;
    });
  }
}
