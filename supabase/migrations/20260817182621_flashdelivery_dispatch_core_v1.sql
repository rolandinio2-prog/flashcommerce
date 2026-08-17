-- ============================================================
-- FLASHDELIVERY - DISPATCH CORE V1
--
-- D4:
-- - tenant-level drivers
-- - branch authorization
-- - delivery assignment / reassignment history
--
-- Driver shifts, authentication and GPS remain outside D4.
-- ============================================================


-- ============================================================
-- 1. DELIVERY DRIVERS
--
-- Driver is tenant-level.
-- Branch access is modeled separately so the same driver can
-- operate in more than one branch without duplicate identities.
-- ============================================================

create table public.delivery_drivers (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,

    code varchar(40) not null,

    display_name varchar(120) not null,

    phone varchar(40) not null,

    status varchar(20) not null default 'ACTIVE',

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint delivery_drivers_code_check
        check (
            char_length(btrim(code)) between 2 and 40
            and code = upper(code)
            and code ~ '^[A-Z0-9_-]+$'
        ),

    constraint delivery_drivers_name_check
        check (
            char_length(btrim(display_name))
            between 2 and 120
        ),

    constraint delivery_drivers_phone_check
        check (
            char_length(btrim(phone))
            between 5 and 40
        ),

    constraint delivery_drivers_status_check
        check (
            status in (
                'ACTIVE',
                'INACTIVE'
            )
        ),

    constraint fk_delivery_drivers_tenant
        foreign key (
            tenant_id
        )
        references public.tenants(
            id
        )
        on delete cascade,

    constraint uq_delivery_drivers_tenant_id
        unique (
            tenant_id,
            id
        ),

    constraint uq_delivery_drivers_code
        unique (
            tenant_id,
            code
        )
);


create index idx_delivery_drivers_status
    on public.delivery_drivers (
        tenant_id,
        status,
        display_name
    );


-- ============================================================
-- 2. DRIVER -> BRANCH AUTHORIZATION
--
-- A driver can be enabled for one or several branches.
-- Assignment must point to one of these authorized mappings.
-- ============================================================

create table public.delivery_driver_branches (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,
    driver_id uuid not null,

    status varchar(20) not null default 'ENABLED',

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint delivery_driver_branches_status_check
        check (
            status in (
                'ENABLED',
                'DISABLED'
            )
        ),

    constraint fk_delivery_driver_branches_tenant
        foreign key (
            tenant_id
        )
        references public.tenants(
            id
        )
        on delete cascade,

    constraint fk_delivery_driver_branches_branch
        foreign key (
            tenant_id,
            branch_id
        )
        references public.branches(
            tenant_id,
            id
        )
        on delete cascade,

    constraint fk_delivery_driver_branches_driver
        foreign key (
            tenant_id,
            driver_id
        )
        references public.delivery_drivers(
            tenant_id,
            id
        )
        on delete cascade,

    constraint uq_delivery_driver_branches_driver
        unique (
            tenant_id,
            branch_id,
            driver_id
        )
);


create index idx_delivery_driver_branches_ops
    on public.delivery_driver_branches (
        tenant_id,
        branch_id,
        status,
        driver_id
    );


-- ============================================================
-- 3. DELIVERY ASSIGNMENTS
--
-- This is historical by design.
--
-- Reassignment DOES NOT overwrite a previous assignment.
-- The previous row is RELEASED and a new assignment_number
-- is created.
--
-- Assignment status remains ACCEPTED while the driver is
-- PICKED_UP / EN_ROUTE / ARRIVED. It becomes COMPLETED when
-- delivery itself reaches DELIVERED.
-- ============================================================

create table public.delivery_assignments (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,

    delivery_id uuid not null,
    driver_id uuid not null,

    assignment_number integer not null,

    status varchar(20) not null default 'ASSIGNED',

    assigned_at timestamptz not null default now(),

    accepted_at timestamptz,

    released_at timestamptz,

    completed_at timestamptz,

    release_reason varchar(500),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint delivery_assignments_number_check
        check (
            assignment_number > 0
        ),

    constraint delivery_assignments_status_check
        check (
            status in (
                'ASSIGNED',
                'ACCEPTED',
                'RELEASED',
                'COMPLETED',
                'CANCELLED'
            )
        ),

    constraint delivery_assignments_accepted_at_check
        check (
            accepted_at is null
            or accepted_at >= assigned_at
        ),

    constraint delivery_assignments_released_at_check
        check (
            released_at is null
            or released_at >= assigned_at
        ),

    constraint delivery_assignments_completed_at_check
        check (
            completed_at is null
            or completed_at >= assigned_at
        ),

    constraint delivery_assignments_release_reason_check
        check (
            release_reason is null
            or char_length(btrim(release_reason))
                between 1 and 500
        ),

    constraint fk_delivery_assignments_tenant
        foreign key (
            tenant_id
        )
        references public.tenants(
            id
        )
        on delete cascade,

    constraint fk_delivery_assignments_branch
        foreign key (
            tenant_id,
            branch_id
        )
        references public.branches(
            tenant_id,
            id
        )
        on delete cascade,

    constraint fk_delivery_assignments_delivery
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

    constraint fk_delivery_assignments_driver_branch
        foreign key (
            tenant_id,
            branch_id,
            driver_id
        )
        references public.delivery_driver_branches(
            tenant_id,
            branch_id,
            driver_id
        ),

    constraint uq_delivery_assignments_tenant_branch_id
        unique (
            tenant_id,
            branch_id,
            id
        ),

    constraint uq_delivery_assignments_number
        unique (
            tenant_id,
            branch_id,
            delivery_id,
            assignment_number
        )
);


-- One delivery can have only one active assignment.
--
-- ACCEPTED remains active during PICKED_UP / EN_ROUTE /
-- ARRIVED, therefore another driver cannot silently replace it.

create unique index uq_delivery_assignments_active_delivery
    on public.delivery_assignments (
        tenant_id,
        branch_id,
        delivery_id
    )
    where status in (
        'ASSIGNED',
        'ACCEPTED'
    );


create index idx_delivery_assignments_delivery_history
    on public.delivery_assignments (
        tenant_id,
        branch_id,
        delivery_id,
        assignment_number desc
    );


create index idx_delivery_assignments_driver_ops
    on public.delivery_assignments (
        tenant_id,
        branch_id,
        driver_id,
        status,
        assigned_at desc
    );


create index idx_delivery_assignments_status
    on public.delivery_assignments (
        tenant_id,
        branch_id,
        status,
        assigned_at
    );