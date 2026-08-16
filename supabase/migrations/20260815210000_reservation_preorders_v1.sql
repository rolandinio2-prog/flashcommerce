-- =========================================================
-- FLASH COMMERCE
-- RESERVATION PREORDERS V0.1
--
-- Vincula un pedido DINE_IN programado con una reserva.
-- El pedido no abre una sesion fisica al crearse; la sesion
-- se asigna durante el check-in de la reserva.
-- =========================================================


-- =========================================================
-- 1. VINCULO RESERVA -> PEDIDO
-- =========================================================

alter table public.orders
add column reservation_id uuid;


alter table public.orders
add constraint orders_reservation_fk
foreign key (
    tenant_id,
    branch_id,
    reservation_id
)
references public.table_reservations (
    tenant_id,
    branch_id,
    id
);


-- Un pedido vinculado a una reserva siempre es DINE_IN.

alter table public.orders
add constraint orders_reservation_order_type_check
check (
    reservation_id is null
    or order_type = 'DINE_IN'
);


-- Gate 6C admite un pedido anticipado por reserva. Los
-- pedidos adicionales se realizan despues del check-in y
-- se vinculan directamente a la table_session.

create unique index orders_one_preorder_per_reservation_idx
on public.orders (
    tenant_id,
    branch_id,
    reservation_id
)
where reservation_id is not null;


create index orders_reservation_schedule_idx
on public.orders (
    tenant_id,
    branch_id,
    scheduled_for
)
where reservation_id is not null;


comment on column public.orders.reservation_id is
'Reserva que origino el pedido anticipado DINE_IN. La table_session se asigna durante el check-in.';

