-- =========================================================
-- FLASH COMMERCE
-- TABLE RESERVATIONS V0.1
--
-- Reserva futura != ocupacion actual.
--
-- - Una reserva bloquea un intervalo horario.
-- - La mesa solo pasa a OCCUPIED cuando se hace check-in.
-- - El check-in crea una table_session OPEN.
-- - Al cerrar esa sesion, la reserva pasa a COMPLETED.
-- =========================================================


-- =========================================================
-- 1. SOPORTE PARA EXCLUSION DE INTERVALOS POR UUID
-- =========================================================

create extension if not exists btree_gist;


-- =========================================================
-- 2. RESERVAS DE MESA
-- =========================================================

create table public.table_reservations (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,
    table_id uuid not null,

    reservation_code varchar(20) not null,
    tracking_token uuid not null default gen_random_uuid(),

    status varchar(20) not null default 'PENDING',

    reserved_for timestamptz not null,
    reserved_until timestamptz not null,
    duration_minutes integer not null default 90,

    party_size integer not null,

    customer_name varchar(120) not null,
    customer_phone varchar(40) not null,
    customer_notes text,

    source varchar(20) not null default 'WEB',

    table_session_id uuid,

    confirmed_at timestamptz,
    seated_at timestamptz,
    cancelled_at timestamptz,
    no_show_at timestamptz,
    completed_at timestamptz,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint table_reservations_branch_fk
        foreign key (
            tenant_id,
            branch_id
        )
        references public.branches (
            tenant_id,
            id
        ),

    constraint table_reservations_table_fk
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

    constraint table_reservations_session_fk
        foreign key (
            tenant_id,
            branch_id,
            table_session_id
        )
        references public.table_sessions (
            tenant_id,
            branch_id,
            id
        ),

    constraint table_reservations_tenant_branch_id_unique
        unique (
            tenant_id,
            branch_id,
            id
        ),

    constraint table_reservations_code_unique
        unique (
            tenant_id,
            branch_id,
            reservation_code
        ),

    constraint table_reservations_tracking_unique
        unique (tracking_token),

    constraint table_reservations_status_check
        check (
            status in (
                'PENDING',
                'CONFIRMED',
                'SEATED',
                'COMPLETED',
                'CANCELLED',
                'NO_SHOW'
            )
        ),

    constraint table_reservations_window_check
        check (
            reserved_until > reserved_for
        ),

    constraint table_reservations_duration_check
        check (
            duration_minutes between 30 and 240
            and mod(duration_minutes, 15) = 0
        ),

    constraint table_reservations_party_size_check
        check (
            party_size > 0
        ),

    constraint table_reservations_customer_name_check
        check (
            length(btrim(customer_name)) >= 2
        ),

    constraint table_reservations_customer_phone_check
        check (
            length(btrim(customer_phone)) >= 6
        ),

    constraint table_reservations_source_check
        check (
            source in (
                'WEB',
                'OPS',
                'PHONE'
            )
        ),

    constraint table_reservations_session_status_check
        check (
            (
                status in (
                    'SEATED',
                    'COMPLETED'
                )
                and table_session_id is not null
            )
            or
            (
                status not in (
                    'SEATED',
                    'COMPLETED'
                )
                and table_session_id is null
            )
        ),

    constraint table_reservations_status_timestamps_check
        check (
            (
                status <> 'CONFIRMED'
                or confirmed_at is not null
            )
            and
            (
                status <> 'SEATED'
                or (
                    confirmed_at is not null
                    and seated_at is not null
                )
            )
            and
            (
                status <> 'COMPLETED'
                or (
                    confirmed_at is not null
                    and seated_at is not null
                    and completed_at is not null
                )
            )
            and
            (
                status <> 'CANCELLED'
                or cancelled_at is not null
            )
            and
            (
                status <> 'NO_SHOW'
                or no_show_at is not null
            )
        )
);


-- =========================================================
-- 3. EVITAR RESERVAS SUPERPUESTAS PARA LA MISMA MESA
--
-- El rango usa [inicio, fin), por lo que una reserva puede
-- comenzar exactamente cuando termina la anterior.
-- =========================================================

alter table public.table_reservations
add constraint table_reservations_no_overlap
exclude using gist (
    tenant_id with =,
    branch_id with =,
    table_id with =,
    tstzrange(
        reserved_for,
        reserved_until,
        '[)'
    ) with &&
)
where (
    status in (
        'PENDING',
        'CONFIRMED',
        'SEATED'
    )
);


-- Una sesion fisica solo puede pertenecer a una reserva.
create unique index table_reservations_one_per_session_idx
on public.table_reservations (
    tenant_id,
    branch_id,
    table_session_id
)
where table_session_id is not null;


-- =========================================================
-- 4. INDICES OPERATIVOS
-- =========================================================

create index table_reservations_branch_schedule_idx
on public.table_reservations (
    tenant_id,
    branch_id,
    reserved_for,
    status
);


create index table_reservations_table_schedule_idx
on public.table_reservations (
    tenant_id,
    branch_id,
    table_id,
    reserved_for
);


create index table_reservations_customer_phone_idx
on public.table_reservations (
    tenant_id,
    branch_id,
    customer_phone
);


-- =========================================================
-- 5. UPDATED_AT
-- =========================================================

create trigger table_reservations_set_updated_at
before update
on public.table_reservations
for each row
execute function public.flash_tables_set_updated_at();


-- =========================================================
-- 6. COMPLETAR LA RESERVA AL CERRAR SU SESION
--
-- Este trigger cubre todos los caminos existentes para
-- liberar mesas, sin duplicar logica en varios servicios.
-- =========================================================

create or replace function public.flash_complete_table_reservation()
returns trigger
language plpgsql
as $$
begin
    if old.status = 'OPEN'
       and new.status = 'CLOSED' then

        update public.table_reservations

        set
            status = 'COMPLETED',
            completed_at = coalesce(
                new.closed_at,
                now()
            ),
            updated_at = now()

        where tenant_id = new.tenant_id
          and branch_id = new.branch_id
          and table_session_id = new.id
          and status = 'SEATED';
    end if;

    return new;
end;
$$;


create trigger table_sessions_complete_reservation
after update of status
on public.table_sessions
for each row
execute function public.flash_complete_table_reservation();


-- =========================================================
-- 7. ROW LEVEL SECURITY
-- =========================================================

alter table public.table_reservations
enable row level security;


-- =========================================================
-- 8. DOCUMENTACION
-- =========================================================

comment on table public.table_reservations is
'Reservas futuras de mesas. Una reserva solo ocupa fisicamente la mesa al crear una table_session mediante check-in.';


comment on column public.table_reservations.reservation_code is
'Codigo corto visible para el cliente y el personal operativo.';


comment on column public.table_reservations.tracking_token is
'Token no predecible utilizado para consultar publicamente una reserva.';


comment on column public.table_reservations.reserved_for is
'Inicio del intervalo reservado.';


comment on column public.table_reservations.reserved_until is
'Fin exclusivo del intervalo reservado.';


comment on column public.table_reservations.table_session_id is
'Sesion de ocupacion creada durante el check-in de la reserva.';
