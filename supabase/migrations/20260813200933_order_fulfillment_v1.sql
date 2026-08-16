-- =========================================================
-- FLASH COMMERCE
-- Order Fulfillment V0.1
--
-- Agrega al pedido la información mínima necesaria
-- para cumplir cada modalidad:
--
-- DINE_IN  -> mesa/contexto de consumo
-- TAKEAWAY -> retiro inmediato
-- PICKUP   -> retiro programado
-- DELIVERY -> datos básicos de entrega
-- =========================================================


-- =========================================================
-- 1. INFORMACIÓN DEL CLIENTE
--
-- Los campos permanecen NULL cuando la modalidad
-- del pedido no los necesita.
-- =========================================================

alter table public.orders
add column customer_name varchar(120);

alter table public.orders
add column customer_phone varchar(40);


-- =========================================================
-- 2. CONSUMO EN LOCAL
--
-- table_code identifica la mesa o posición del cliente.
--
-- Ejemplos futuros:
-- M01
-- M02
-- TERRAZA-03
--
-- Más adelante podrá provenir directamente del QR.
-- =========================================================

alter table public.orders
add column table_code varchar(50);


-- =========================================================
-- 3. DELIVERY
--
-- En V0.1 guardamos la dirección como texto.
-- Más adelante podremos evolucionar a:
--
-- latitude
-- longitude
-- delivery_zone
-- delivery_fee calculado
-- instrucciones
-- =========================================================

alter table public.orders
add column delivery_address text;


-- =========================================================
-- 4. ÍNDICES OPERATIVOS
--
-- scheduled_for ya existe en orders y será utilizado
-- inicialmente por PICKUP.
-- =========================================================

create index idx_orders_scheduled_for
on public.orders (
    tenant_id,
    branch_id,
    scheduled_for
)
where scheduled_for is not null;


create index idx_orders_table_code
on public.orders (
    tenant_id,
    branch_id,
    table_code
)
where table_code is not null;


-- =========================================================
-- 5. COMENTARIOS DE ESQUEMA
-- =========================================================

comment on column public.orders.customer_name is
'Nombre opcional del cliente asociado al cumplimiento del pedido.';

comment on column public.orders.customer_phone is
'Teléfono de contacto del cliente, principalmente para delivery o pickup.';

comment on column public.orders.table_code is
'Código de mesa o ubicación para pedidos DINE_IN.';

comment on column public.orders.delivery_address is
'Dirección de entrega para pedidos DELIVERY.';

comment on column public.orders.scheduled_for is
'Fecha/hora programada del pedido, inicialmente utilizada para PICKUP.';