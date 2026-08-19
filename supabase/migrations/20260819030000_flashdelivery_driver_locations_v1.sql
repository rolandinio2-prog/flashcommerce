begin;

-- ============================================================
-- FlashDelivery V1
-- Driver location history for customer delivery tracking.
--
-- Design:
-- - append-only location samples
-- - authoritative tenant / branch / delivery / driver ownership
-- - PostGIS geography(Point,4326)
-- - server received timestamp separate from device capture time
-- - no Supabase Realtime publication in V1
-- ============================================================

create table public.delivery_driver_locations (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,

    delivery_id uuid not null,
    driver_id uuid not null,

    position gis.geography(Point,4326) not null,

    accuracy_meters numeric(8,2),
    heading_degrees numeric(6,2),
    speed_mps numeric(8,3),

    captured_at timestamptz not null,
    received_at timestamptz not null default now(),

    constraint delivery_driver_locations_accuracy_check
        check (
            accuracy_meters is null
            or accuracy_meters >= 0
        ),

    constraint delivery_driver_locations_heading_check
        check (
            heading_degrees is null
            or (
                heading_degrees >= 0
                and heading_degrees < 360
            )
        ),

    constraint delivery_driver_locations_speed_check
        check (
            speed_mps is null
            or speed_mps >= 0
        ),

    constraint fk_delivery_driver_locations_tenant
        foreign key (
            tenant_id
        )
        references public.tenants(
            id
        )
        on delete cascade,

    constraint fk_delivery_driver_locations_branch
        foreign key (
            tenant_id,
            branch_id
        )
        references public.branches(
            tenant_id,
            id
        )
        on delete cascade,

    constraint fk_delivery_driver_locations_delivery
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
        on delete cascade,

    constraint fk_delivery_driver_locations_driver_branch
        foreign key (
            tenant_id,
            branch_id,
            driver_id
        )
        references public.delivery_driver_branches(
            tenant_id,
            branch_id,
            driver_id
        )
);

-- Customer tracking reads the newest point for one delivery.
create index idx_delivery_driver_locations_delivery_latest
    on public.delivery_driver_locations (
        tenant_id,
        branch_id,
        delivery_id,
        captured_at desc,
        received_at desc
    );

-- Driver-side diagnostics / operations may inspect recent
-- positions produced by one driver.
create index idx_delivery_driver_locations_driver_latest
    on public.delivery_driver_locations (
        tenant_id,
        branch_id,
        driver_id,
        captured_at desc,
        received_at desc
    );

-- Spatial index retained for future proximity / route analysis.
create index idx_delivery_driver_locations_position
    on public.delivery_driver_locations
    using gist (
        position
    );

-- API access remains server-side in V1.
-- No public RLS policies are created.
alter table public.delivery_driver_locations
    enable row level security;

comment on table public.delivery_driver_locations is
    'Append-only FlashDelivery driver GPS samples used for delivery tracking.';

comment on column public.delivery_driver_locations.position is
    'Driver location as PostGIS geography Point SRID 4326.';

comment on column public.delivery_driver_locations.captured_at is
    'Timestamp reported by the driver device for the location sample.';

comment on column public.delivery_driver_locations.received_at is
    'Timestamp assigned by PostgreSQL when the API receives the location sample.';

commit;