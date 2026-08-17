-- FlashDelivery Core V1
-- Gate D1
--
-- Scope:
--   * PostGIS
--   * Branch delivery configuration
--   * Delivery zones
--   * Deliveries
--   * Delivery events
--
-- Intentionally NOT included yet:
--   * drivers
--   * shifts
--   * driver locations
--   * proof of delivery
--   * Google Maps integration
--   * cash on delivery settlement

-- =========================================================
-- 1. POSTGIS
-- =========================================================

create schema if not exists gis;

create extension if not exists postgis
with schema gis;

-- =========================================================
-- 2. BRANCH DELIVERY CONFIGURATION
-- =========================================================

alter table public.branches
    add column if not exists delivery_enabled boolean
        not null default false,
    add column if not exists delivery_origin_address text,
    add column if not exists delivery_origin_latitude numeric(9,6),
    add column if not exists delivery_origin_longitude numeric(9,6),
    add column if not exists delivery_default_prep_minutes integer
        not null default 20;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'branches_delivery_origin_coordinates_check'
          and conrelid = 'public.branches'::regclass
    ) then
        alter table public.branches
            add constraint branches_delivery_origin_coordinates_check
            check (
                (
                    delivery_origin_latitude is null
                    and delivery_origin_longitude is null
                )
                or
                (
                    delivery_origin_latitude between -90 and 90
                    and delivery_origin_longitude between -180 and 180
                )
            );
    end if;
end
$$;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'branches_delivery_prep_minutes_check'
          and conrelid = 'public.branches'::regclass
    ) then
        alter table public.branches
            add constraint branches_delivery_prep_minutes_check
            check (
                delivery_default_prep_minutes between 1 and 240
            );
    end if;
end
$$;

comment on column public.branches.delivery_enabled is
'Enables FlashDelivery for this branch.';

comment on column public.branches.delivery_origin_address is
'Human-readable dispatch origin for the branch.';

comment on column public.branches.delivery_origin_latitude is
'Dispatch origin latitude in WGS84 decimal degrees.';

comment on column public.branches.delivery_origin_longitude is
'Dispatch origin longitude in WGS84 decimal degrees.';

comment on column public.branches.delivery_default_prep_minutes is
'Default preparation time used by FlashDelivery ETA calculations.';

-- =========================================================
-- 3. DELIVERY ZONES
-- =========================================================

create table public.delivery_zones (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,

    code varchar(40) not null,
    name varchar(120) not null,

    status varchar(20) not null default 'ACTIVE',

    area gis.geometry(MultiPolygon, 4326) not null,

    delivery_fee numeric(12,2) not null default 0,
    minimum_order numeric(12,2) not null default 0,

    eta_min_minutes integer not null,
    eta_max_minutes integer not null,

    priority integer not null default 100,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint delivery_zones_status_check
        check (
            status in ('ACTIVE', 'INACTIVE')
        ),

    constraint delivery_zones_fee_check
        check (
            delivery_fee >= 0
        ),

    constraint delivery_zones_minimum_order_check
        check (
            minimum_order >= 0
        ),

    constraint delivery_zones_eta_check
        check (
            eta_min_minutes > 0
            and eta_max_minutes >= eta_min_minutes
            and eta_max_minutes <= 480
        ),

    constraint delivery_zones_priority_check
        check (
            priority >= 0
        ),

    constraint delivery_zones_area_valid_check
        check (
            gis.ST_IsValid(area)
            and not gis.ST_IsEmpty(area)
        ),

    constraint fk_delivery_zones_tenant
        foreign key (tenant_id)
        references public.tenants(id)
        on delete cascade,

    constraint fk_delivery_zones_branch
        foreign key (tenant_id, branch_id)
        references public.branches(tenant_id, id)
        on delete cascade,

    constraint uq_delivery_zones_code
        unique (tenant_id, branch_id, code),

    constraint uq_delivery_zones_tenant_branch_id
        unique (tenant_id, branch_id, id)
);

create index idx_delivery_zones_branch_status
    on public.delivery_zones (
        tenant_id,
        branch_id,
        status,
        priority
    );

create index idx_delivery_zones_area
    on public.delivery_zones
    using gist (area);

comment on table public.delivery_zones is
'FlashDelivery geographic coverage and pricing zones per branch.';

-- =========================================================
-- 4. DELIVERIES
-- =========================================================

create table public.deliveries (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,
    order_id uuid not null,
    zone_id uuid not null,

    status varchar(30) not null default 'CREATED',

    recipient_name varchar(160) not null,
    recipient_phone varchar(40) not null,

    address_text text not null,
    address_reference text,

    destination gis.geography(Point, 4326) not null,

    quoted_delivery_fee numeric(12,2) not null,

    distance_meters integer,
    eta_min_minutes integer,
    eta_max_minutes integer,

    tracking_token uuid not null default gen_random_uuid(),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint deliveries_status_check
        check (
            status in (
                'CREATED',
                'WAITING_ASSIGNMENT',
                'ASSIGNED',
                'ACCEPTED',
                'PICKED_UP',
                'EN_ROUTE',
                'ARRIVED',
                'DELIVERED',
                'FAILED',
                'CANCELLED'
            )
        ),

    constraint deliveries_fee_check
        check (
            quoted_delivery_fee >= 0
        ),

    constraint deliveries_distance_check
        check (
            distance_meters is null
            or distance_meters >= 0
        ),

    constraint deliveries_eta_check
        check (
            (
                eta_min_minutes is null
                and eta_max_minutes is null
            )
            or
            (
                eta_min_minutes is not null
                and eta_max_minutes is not null
                and eta_min_minutes > 0
                and eta_max_minutes >= eta_min_minutes
                and eta_max_minutes <= 480
            )
        ),

    constraint fk_deliveries_tenant
        foreign key (tenant_id)
        references public.tenants(id)
        on delete cascade,

    constraint fk_deliveries_branch
        foreign key (tenant_id, branch_id)
        references public.branches(tenant_id, id)
        on delete cascade,

    constraint fk_deliveries_order
        foreign key (
            tenant_id,
            branch_id,
            order_id
        )
        references public.orders(
            tenant_id,
            branch_id,
            id
        )
        on delete cascade,

    constraint fk_deliveries_zone
        foreign key (
            tenant_id,
            branch_id,
            zone_id
        )
        references public.delivery_zones(
            tenant_id,
            branch_id,
            id
        ),

    constraint uq_deliveries_order
        unique (
            tenant_id,
            branch_id,
            order_id
        ),

    constraint uq_deliveries_tracking_token
        unique (tracking_token),

    constraint uq_deliveries_tenant_branch_id
        unique (
            tenant_id,
            branch_id,
            id
        )
);

create index idx_deliveries_ops
    on public.deliveries (
        tenant_id,
        branch_id,
        status,
        created_at
    );

create index idx_deliveries_zone
    on public.deliveries (
        tenant_id,
        branch_id,
        zone_id,
        status
    );

create index idx_deliveries_destination
    on public.deliveries
    using gist (destination);

comment on table public.deliveries is
'Logistics record associated one-to-one with a DELIVERY order.';

-- =========================================================
-- 5. DATABASE INVARIANT:
--    deliveries can reference only DELIVERY orders
-- =========================================================

create or replace function public.flashdelivery_validate_order_type()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    v_order_type text;
begin
    select o.order_type::text
      into v_order_type
      from public.orders o
     where o.tenant_id = new.tenant_id
       and o.branch_id = new.branch_id
       and o.id = new.order_id;

    if v_order_type is null then
        raise exception
            'FlashDelivery order does not exist for tenant/branch';
    end if;

    if v_order_type <> 'DELIVERY' then
        raise exception
            'FlashDelivery can only reference DELIVERY orders';
    end if;

    return new;
end;
$$;

drop trigger if exists trg_flashdelivery_validate_order_type
    on public.deliveries;

create trigger trg_flashdelivery_validate_order_type
before insert
or update of tenant_id, branch_id, order_id
on public.deliveries
for each row
execute function public.flashdelivery_validate_order_type();

-- =========================================================
-- 6. DELIVERY EVENTS
-- =========================================================

create table public.delivery_events (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,
    delivery_id uuid not null,

    event_type varchar(60) not null,

    from_status varchar(30),
    to_status varchar(30),

    actor_type varchar(20) not null default 'SYSTEM',
    actor_reference text,

    payload jsonb not null default '{}'::jsonb,

    created_at timestamptz not null default now(),

    constraint delivery_events_actor_type_check
        check (
            actor_type in (
                'SYSTEM',
                'OPS',
                'DRIVER',
                'CUSTOMER'
            )
        ),

    constraint fk_delivery_events_tenant
        foreign key (tenant_id)
        references public.tenants(id)
        on delete cascade,

    constraint fk_delivery_events_branch
        foreign key (tenant_id, branch_id)
        references public.branches(tenant_id, id)
        on delete cascade,

    constraint fk_delivery_events_delivery
        foreign key (
            tenant_id,
            branch_id,
            delivery_id
        )
        references public.deliveries(
            tenant_id,
            branch_id,
            id
        )
        on delete cascade
);

create index idx_delivery_events_delivery_created
    on public.delivery_events (
        tenant_id,
        branch_id,
        delivery_id,
        created_at
    );

create index idx_delivery_events_type
    on public.delivery_events (
        tenant_id,
        branch_id,
        event_type,
        created_at
    );

comment on table public.delivery_events is
'Immutable operational audit trail for FlashDelivery lifecycle events.';

-- =========================================================
-- 7. NO HISTORICAL BACKFILL IN D1
-- =========================================================
--
-- Existing DELIVERY orders are intentionally preserved as-is.
-- Coordinates and delivery zones were not captured historically,
-- therefore D1 does not fabricate geographic information.