-- =========================================================
-- FLASH COMMERCE
-- Order Tracking V0.1
--
-- Tracking público de pedidos + historial de estados
-- =========================================================


-- =========================================================
-- 1. TRACKING TOKEN
--
-- UUID público para consultar el pedido.
-- No exponemos el ID interno ni dependemos solamente
-- del order_number secuencial.
-- =========================================================

alter table public.orders
add column tracking_token uuid
not null
default gen_random_uuid();


alter table public.orders
add constraint uq_orders_tracking_token
unique (tracking_token);


-- =========================================================
-- 2. ORDER STATUS HISTORY
--
-- Registra cada cambio de estado del pedido.
-- =========================================================

create table public.order_status_history (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    order_id uuid not null,

    status varchar(20) not null,

    changed_at timestamptz not null default now(),

    constraint fk_order_status_history_order
        foreign key (tenant_id, order_id)
        references public.orders(tenant_id, id)
        on delete cascade,

    constraint chk_order_status_history_status
        check (
            status in (
                'PENDING',
                'CONFIRMED',
                'PREPARING',
                'READY',
                'COMPLETED',
                'CANCELLED'
            )
        )
);


-- =========================================================
-- 3. ÍNDICE PARA HISTORIAL
-- =========================================================

create index idx_order_status_history_order
    on public.order_status_history(
        tenant_id,
        order_id,
        changed_at
    );


-- =========================================================
-- 4. BACKFILL
--
-- Ya existen pedidos creados antes de esta migración.
-- Registramos su estado actual como primer evento.
-- =========================================================

insert into public.order_status_history (
    tenant_id,
    order_id,
    status,
    changed_at
)
select
    tenant_id,
    id,
    status,
    created_at
from public.orders;


-- =========================================================
-- 5. TRIGGER FUNCTION
--
-- A partir de ahora:
--
-- INSERT order
--      ↓
-- historial inicial
--
-- UPDATE status
--      ↓
-- nuevo registro de historial
-- =========================================================

create or replace function public.record_order_status_history()
returns trigger
language plpgsql
as $$
begin

    if tg_op = 'INSERT' then

        insert into public.order_status_history (
            tenant_id,
            order_id,
            status,
            changed_at
        )
        values (
            new.tenant_id,
            new.id,
            new.status,
            now()
        );

    elsif tg_op = 'UPDATE'
      and new.status is distinct from old.status then

        insert into public.order_status_history (
            tenant_id,
            order_id,
            status,
            changed_at
        )
        values (
            new.tenant_id,
            new.id,
            new.status,
            now()
        );

    end if;

    return new;
end;
$$;


-- =========================================================
-- 6. TRIGGER
-- =========================================================

create trigger trg_order_status_history
after insert or update of status
on public.orders
for each row
execute function public.record_order_status_history();


-- =========================================================
-- 7. ROW LEVEL SECURITY
--
-- Seguimos con:
--
-- Customer → NestJS → PostgreSQL
--
-- sin acceso directo desde el navegador.
-- =========================================================

alter table public.order_status_history
enable row level security;