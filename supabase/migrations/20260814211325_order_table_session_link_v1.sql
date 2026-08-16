-- =========================================================
-- FLASH COMMERCE
-- TABLES V0.2
--
-- Vincula pedidos DINE_IN con una sesión de mesa.
--
-- Relación:
--
-- dining_tables
--       ↓
-- table_sessions
--       ↓
-- orders.table_session_id
--
-- Una misma table_session puede tener varios pedidos.
-- =========================================================


-- =========================================================
-- 1. CLAVE COMPUESTA DE TABLE_SESSIONS
--
-- La PK "id" ya es única.
--
-- Esta restricción adicional nos permite crear una FK
-- compuesta desde orders usando:
--
-- tenant_id
-- branch_id
-- table_session_id
--
-- y así proteger la integridad multi-tenant.
-- =========================================================

alter table public.table_sessions
add constraint table_sessions_tenant_branch_id_unique
unique (
    tenant_id,
    branch_id,
    id
);


-- =========================================================
-- 2. AGREGAR TABLE_SESSION_ID A ORDERS
--
-- Se mantiene NULLABLE porque:
--
-- - pedidos TAKEAWAY no utilizan mesa
-- - pedidos PICKUP no utilizan mesa
-- - pedidos DELIVERY no utilizan mesa
-- - pedidos DINE_IN históricos todavía no tienen sesión
--
-- Más adelante podremos endurecer esta regla.
-- =========================================================

alter table public.orders
add column table_session_id uuid;


-- =========================================================
-- 3. FOREIGN KEY MULTI-TENANT
--
-- Un pedido sólo puede apuntar a una sesión perteneciente
-- al MISMO tenant y a la MISMA sucursal.
-- =========================================================

alter table public.orders
add constraint orders_table_session_fk
foreign key (
    tenant_id,
    branch_id,
    table_session_id
)
references public.table_sessions (
    tenant_id,
    branch_id,
    id
);


-- =========================================================
-- 4. REGLA DE CONSISTENCIA
--
-- Si existe table_session_id, el pedido debe ser DINE_IN.
--
-- No exigimos todavía lo contrario:
--
-- DINE_IN -> table_session_id obligatorio
--
-- porque existen pedidos históricos y todavía falta
-- actualizar NestJS para crear las sesiones automáticamente.
-- =========================================================

alter table public.orders
add constraint orders_table_session_order_type_check
check (
    table_session_id is null
    or order_type = 'DINE_IN'
);


-- =========================================================
-- 5. ÍNDICES
--
-- Una table_session puede tener varios pedidos.
-- Por eso este índice NO es UNIQUE.
-- =========================================================

create index idx_orders_table_session
on public.orders (
    tenant_id,
    branch_id,
    table_session_id
)
where table_session_id is not null;


-- =========================================================
-- 6. DOCUMENTACIÓN
-- =========================================================

comment on column public.orders.table_session_id is
'Sesión de mesa asociada al pedido DINE_IN. Una sesión puede contener varios pedidos.';