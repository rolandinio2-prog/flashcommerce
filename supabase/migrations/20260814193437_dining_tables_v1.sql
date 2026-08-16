-- =========================================================
-- FLASH COMMERCE
-- TABLES V0.1
--
-- Gestión inicial de:
-- - mesas físicas por sucursal
-- - sesiones de ocupación de mesa
--
-- Una mesa está DISPONIBLE cuando:
--   1. está activa
--   2. no tiene una table_session con status = 'OPEN'
--
-- IMPORTANTE:
-- Reserva futura de mesas será otro módulo.
-- =========================================================


-- =========================================================
-- 1. DINING TABLES
--
-- Representa las mesas físicas existentes
-- dentro de una sucursal.
-- =========================================================

create table public.dining_tables (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,

    code varchar(50) not null,
    name varchar(120) not null,

    capacity integer not null,

    zone varchar(80),

    is_active boolean not null default true,

    sort_order integer not null default 0,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- ---------------------------------------------
    -- Una mesa debe pertenecer a una sucursal
    -- del mismo tenant.
    -- ---------------------------------------------

    constraint dining_tables_branch_fk
        foreign key (
            tenant_id,
            branch_id
        )
        references public.branches (
            tenant_id,
            id
        ),

    -- ---------------------------------------------
    -- Capacidad válida.
    -- ---------------------------------------------

    constraint dining_tables_capacity_check
        check (
            capacity > 0
        ),

    -- ---------------------------------------------
    -- Código de mesa único dentro de la sucursal.
    -- Ej:
    -- M01, M02, TERRAZA-01
    -- ---------------------------------------------

    constraint dining_tables_code_unique
        unique (
            tenant_id,
            branch_id,
            code
        ),

    -- ---------------------------------------------
    -- Necesario para permitir FK compuesta desde
    -- table_sessions.
    -- ---------------------------------------------

    constraint dining_tables_tenant_branch_id_unique
        unique (
            tenant_id,
            branch_id,
            id
        )
);


-- =========================================================
-- 2. TABLE SESSIONS
--
-- Representa una ocupación real de una mesa.
--
-- Ejemplo:
--
-- Mesa M05
--    ↓
-- Session OPEN
--    ├── pedido #20
--    ├── pedido #24
--    └── pedido #27
--
-- Al retirarse el cliente:
-- Session CLOSED
-- =========================================================

create table public.table_sessions (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,

    table_id uuid not null,

    status varchar(20) not null default 'OPEN',

    opened_at timestamptz not null default now(),

    closed_at timestamptz,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- ---------------------------------------------
    -- La mesa debe pertenecer al mismo tenant
    -- y sucursal de la sesión.
    -- ---------------------------------------------

    constraint table_sessions_table_fk
        foreign key (
            tenant_id,
            branch_id,
            table_id
        )
        references public.dining_tables (
            tenant_id,
            branch_id,
            id
        ),

    -- ---------------------------------------------
    -- Estados iniciales.
    --
    -- Más adelante podremos evolucionar a:
    -- CLEANING
    -- BLOCKED
    -- RESERVED
    --
    -- pero no los necesitamos todavía.
    -- ---------------------------------------------

    constraint table_sessions_status_check
        check (
            status in (
                'OPEN',
                'CLOSED'
            )
        ),

    -- ---------------------------------------------
    -- Consistencia temporal.
    --
    -- OPEN   -> closed_at debe ser null
    -- CLOSED -> closed_at debe tener valor
    -- ---------------------------------------------

    constraint table_sessions_closed_at_check
        check (
            (
                status = 'OPEN'
                and closed_at is null
            )
            or
            (
                status = 'CLOSED'
                and closed_at is not null
            )
        )
);


-- =========================================================
-- 3. UNA SOLA SESIÓN ABIERTA POR MESA
--
-- Evita que dos grupos diferentes ocupen simultáneamente
-- la misma mesa.
-- =========================================================

create unique index table_sessions_one_open_per_table
on public.table_sessions (
    tenant_id,
    branch_id,
    table_id
)
where status = 'OPEN';


-- =========================================================
-- 4. ÍNDICES PARA CONSULTA DE MESAS
-- =========================================================

create index dining_tables_branch_active_idx
on public.dining_tables (
    tenant_id,
    branch_id,
    is_active,
    sort_order
);


create index dining_tables_zone_idx
on public.dining_tables (
    tenant_id,
    branch_id,
    zone
);


create index table_sessions_branch_status_idx
on public.table_sessions (
    tenant_id,
    branch_id,
    status
);


create index table_sessions_table_status_idx
on public.table_sessions (
    tenant_id,
    branch_id,
    table_id,
    status
);


-- =========================================================
-- 5. UPDATED_AT
--
-- Usamos una función propia de este módulo para no depender
-- del nombre de funciones existentes en otras migraciones.
-- =========================================================

create or replace function public.flash_tables_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();

    return new;
end;
$$;


create trigger dining_tables_set_updated_at
before update
on public.dining_tables
for each row
execute function public.flash_tables_set_updated_at();


create trigger table_sessions_set_updated_at
before update
on public.table_sessions
for each row
execute function public.flash_tables_set_updated_at();


-- =========================================================
-- 6. ROW LEVEL SECURITY
--
-- Igual que el resto de Flash Commerce:
-- habilitamos RLS, pero el navegador NO tendrá acceso
-- directo a estas tablas.
--
-- El acceso se realizará mediante NestJS.
-- =========================================================

alter table public.dining_tables
enable row level security;


alter table public.table_sessions
enable row level security;


-- =========================================================
-- 7. DOCUMENTACIÓN
-- =========================================================

comment on table public.dining_tables is
'Mesas físicas configuradas por sucursal para consumo en local.';


comment on column public.dining_tables.code is
'Código interno único de la mesa dentro de la sucursal, por ejemplo M01.';


comment on column public.dining_tables.name is
'Nombre visible de la mesa, por ejemplo Mesa 1.';


comment on column public.dining_tables.capacity is
'Cantidad máxima nominal de personas de la mesa.';


comment on column public.dining_tables.zone is
'Zona física opcional de la mesa, por ejemplo Interior o Terraza.';


comment on table public.table_sessions is
'Sesiones de ocupación de mesas. Una sesión OPEN representa una mesa actualmente ocupada.';


comment on column public.table_sessions.status is
'Estado operativo de la sesión: OPEN o CLOSED.';


comment on column public.table_sessions.opened_at is
'Momento en que comenzó la ocupación de la mesa.';


comment on column public.table_sessions.closed_at is
'Momento en que terminó la ocupación de la mesa.';