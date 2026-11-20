-- =========================================================
-- FASTPAY / FLASHDELIVERY
-- DELIVERY ORDER MEMBERSHIPS V1
--
-- Goal:
--   Preserve public.deliveries as the physical delivery
--   entity while allowing multiple independent DELIVERY
--   orders to belong to one physical delivery before
--   dispatch begins.
--
-- Important:
--   This migration introduces membership storage,
--   validation, automatic PRIMARY membership creation
--   for future Deliveries, and backfill for existing rows.
--   Runtime/API bundle adoption is applied separately.
-- =========================================================

begin;

create table public.delivery_order_memberships (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,

    delivery_id uuid not null,
    order_id uuid not null,

    role varchar(16) not null,
    membership_status varchar(16) not null default 'ACTIVE',

    joined_at timestamptz not null default now(),
    released_at timestamptz null,
    release_reason varchar(64) null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint delivery_order_memberships_role_check
        check (role in ('PRIMARY', 'ADDITIONAL')),

    constraint delivery_order_memberships_status_check
        check (
            membership_status in (
                'PENDING',
                'ACTIVE',
                'RELEASED'
            )
        ),

    constraint delivery_order_memberships_release_state_check
        check (
            (
                membership_status in ('PENDING', 'ACTIVE')
                and released_at is null
                and release_reason is null
            )
            or
            (
                membership_status = 'RELEASED'
                and released_at is not null
                and release_reason is not null
                and btrim(release_reason) <> ''
            )
        ),

    constraint fk_delivery_order_memberships_tenant
        foreign key (tenant_id)
        references public.tenants(id)
        on delete cascade,

    constraint fk_delivery_order_memberships_branch
        foreign key (tenant_id, branch_id)
        references public.branches(tenant_id, id)
        on delete cascade,

    constraint fk_delivery_order_memberships_delivery
        foreign key (tenant_id, branch_id, delivery_id)
        references public.deliveries(tenant_id, branch_id, id)
        on delete cascade,

    constraint fk_delivery_order_memberships_order
        foreign key (tenant_id, branch_id, order_id)
        references public.orders(tenant_id, branch_id, id)
        on delete cascade,

    constraint uq_delivery_order_memberships_delivery_order
        unique (tenant_id, branch_id, delivery_id, order_id)
);

create unique index uq_delivery_order_memberships_open_order
on public.delivery_order_memberships (
    tenant_id,
    branch_id,
    order_id
)
where membership_status in ('PENDING', 'ACTIVE');

create unique index uq_delivery_order_memberships_open_primary
on public.delivery_order_memberships (
    tenant_id,
    branch_id,
    delivery_id
)
where role = 'PRIMARY'
  and membership_status in ('PENDING', 'ACTIVE');

create index idx_delivery_order_memberships_delivery
on public.delivery_order_memberships (
    tenant_id,
    branch_id,
    delivery_id,
    membership_status,
    joined_at
);

create index idx_delivery_order_memberships_order
on public.delivery_order_memberships (
    tenant_id,
    branch_id,
    order_id,
    membership_status
);

create or replace function public.flashdelivery_validate_order_membership_v1()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
    v_delivery_anchor_order_id uuid;
    v_delivery_status text;
    v_order_type text;
    v_order_group_id uuid;
    v_anchor_order_group_id uuid;
begin
    -- Serialize membership joins with dispatch and other
    -- membership changes by locking the physical Delivery.
    select
        d.order_id,
        d.status
    into
        v_delivery_anchor_order_id,
        v_delivery_status
    from public.deliveries d
    where d.tenant_id = new.tenant_id
      and d.branch_id = new.branch_id
      and d.id = new.delivery_id
    for update of d;

    if v_delivery_anchor_order_id is null then
        raise exception 'Delivery membership references an unknown delivery';
    end if;

    select
        o.order_type,
        o.order_group_id
    into
        v_order_type,
        v_order_group_id
    from public.orders o
    where o.tenant_id = new.tenant_id
      and o.branch_id = new.branch_id
      and o.id = new.order_id;

    if v_order_type is null then
        raise exception 'Delivery membership references an unknown order';
    end if;

    if v_order_type <> 'DELIVERY' then
        raise exception 'Delivery memberships require DELIVERY orders';
    end if;

    select o.order_group_id
    into v_anchor_order_group_id
    from public.orders o
    where o.tenant_id = new.tenant_id
      and o.branch_id = new.branch_id
      and o.id = v_delivery_anchor_order_id;

    if new.role = 'PRIMARY' then
        if new.order_id <> v_delivery_anchor_order_id then
            raise exception 'PRIMARY membership must match deliveries.order_id';
        end if;

        if new.membership_status <> 'ACTIVE' then
            raise exception 'PRIMARY membership must remain ACTIVE';
        end if;
    else
        if new.order_id = v_delivery_anchor_order_id then
            raise exception 'ADDITIONAL membership cannot be the delivery anchor order';
        end if;

        if v_order_group_id is distinct from v_anchor_order_group_id then
            raise exception 'Delivery members must share order_group_id';
        end if;

        if tg_op = 'INSERT'
           and new.membership_status in ('PENDING', 'ACTIVE')
           and v_delivery_status <> 'CREATED'
        then
            raise exception 'Additional order can join only while delivery is CREATED';
        end if;

        if new.membership_status in ('PENDING', 'ACTIVE')
           and exists (
               select 1
               from public.delivery_assignments a
               where a.tenant_id = new.tenant_id
                 and a.branch_id = new.branch_id
                 and a.delivery_id = new.delivery_id
                 and a.status in ('ASSIGNED', 'ACCEPTED')
           )
        then
            raise exception 'Additional order cannot join a delivery with an active assignment';
        end if;

        if tg_op = 'UPDATE'
           and old.membership_status = 'RELEASED'
           and new.membership_status <> 'RELEASED'
        then
            raise exception 'Released delivery membership cannot be reactivated';
        end if;
    end if;

    return new;
end;
$function$;

create trigger trg_flashdelivery_validate_order_membership_v1
before insert or update
on public.delivery_order_memberships
for each row
execute function public.flashdelivery_validate_order_membership_v1();

create trigger trg_delivery_order_memberships_updated_at
before update
on public.delivery_order_memberships
for each row
execute function public.set_updated_at();

alter table public.delivery_order_memberships
enable row level security;

comment on table public.delivery_order_memberships is
'Maps independent DELIVERY orders to one physical delivery. PRIMARY preserves deliveries.order_id compatibility; ADDITIONAL supports pre-dispatch bundling.';

comment on column public.delivery_order_memberships.membership_status is
'PENDING while an additional order is not yet payment-ready, ACTIVE when it participates in physical dispatch readiness, RELEASED when it no longer blocks or belongs to the physical bundle.';

-- ---------------------------------------------------------
-- Future Delivery compatibility.
--
-- Every newly created physical Delivery automatically gets
-- its PRIMARY membership in the same transaction. This
-- avoids a migration/runtime adoption window in which new
-- Deliveries could exist without a bundle anchor.
-- ---------------------------------------------------------

create or replace function public.flashdelivery_create_primary_order_membership_v1()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
    insert into public.delivery_order_memberships (
        tenant_id,
        branch_id,
        delivery_id,
        order_id,
        role,
        membership_status,
        joined_at,
        created_at,
        updated_at
    )
    values (
        new.tenant_id,
        new.branch_id,
        new.id,
        new.order_id,
        'PRIMARY',
        'ACTIVE',
        new.created_at,
        new.created_at,
        new.updated_at
    );

    return new;
end;
$function$;

create trigger trg_flashdelivery_create_primary_order_membership_v1
after insert
on public.deliveries
for each row
execute function public.flashdelivery_create_primary_order_membership_v1();

-- ---------------------------------------------------------
-- Existing Delivery backfill.
-- ---------------------------------------------------------

insert into public.delivery_order_memberships (
    tenant_id,
    branch_id,
    delivery_id,
    order_id,
    role,
    membership_status,
    joined_at,
    created_at,
    updated_at
)
select
    d.tenant_id,
    d.branch_id,
    d.id,
    d.order_id,
    'PRIMARY',
    'ACTIVE',
    d.created_at,
    d.created_at,
    d.updated_at
from public.deliveries d;

commit;