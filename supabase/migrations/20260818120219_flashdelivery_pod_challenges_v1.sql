-- ============================================================
-- FLASHDELIVERY POD CHALLENGES V1
-- ============================================================
--
-- Proof-of-delivery security model:
--
--   * The customer-facing POD is exactly four decimal digits.
--   * The raw POD is NEVER persisted.
--   * A plain SHA-256 hash of the POD is NEVER persisted.
--   * The API derives the POD with a server-side HMAC secret.
--   * PostgreSQL stores only challenge state and failed attempts.
--   * Maximum failed attempts in V1: 5.
--   * A LOCKED challenge cannot be reactivated in V1.
--   * A VERIFIED challenge cannot be reverted in V1.
--
-- The server secret is intentionally NOT part of this migration.
-- Application configuration will use:
--
--   FLASH_DELIVERY_POD_SECRET
--
-- ============================================================


-- ============================================================
-- 1. POD CHALLENGE
-- ============================================================

create table public.delivery_pod_challenges (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,

    delivery_id uuid not null,

    status varchar(20) not null
        default 'ACTIVE',

    failed_attempts integer not null
        default 0,

    locked_at timestamptz,

    verified_at timestamptz,

    verified_by_driver_id uuid,

    created_at timestamptz not null
        default now(),

    updated_at timestamptz not null
        default now(),


    constraint delivery_pod_challenges_status_check
        check (
            status in (
                'ACTIVE',
                'LOCKED',
                'VERIFIED'
            )
        ),


    constraint delivery_pod_challenges_attempts_check
        check (
            failed_attempts between 0 and 5
        ),


    constraint delivery_pod_challenges_state_check
        check (
            (
                status = 'ACTIVE'
                and failed_attempts between 0 and 4
                and locked_at is null
                and verified_at is null
                and verified_by_driver_id is null
            )
            or
            (
                status = 'LOCKED'
                and failed_attempts = 5
                and locked_at is not null
                and verified_at is null
                and verified_by_driver_id is null
            )
            or
            (
                status = 'VERIFIED'
                and failed_attempts between 0 and 4
                and locked_at is null
                and verified_at is not null
                and verified_by_driver_id is not null
            )
        ),


    constraint delivery_pod_challenges_locked_at_check
        check (
            locked_at is null
            or locked_at >= created_at
        ),


    constraint delivery_pod_challenges_verified_at_check
        check (
            verified_at is null
            or verified_at >= created_at
        ),


    constraint fk_delivery_pod_challenges_delivery
        foreign key (
            tenant_id,
            branch_id,
            delivery_id
        )
        references public.deliveries (
            tenant_id,
            branch_id,
            id
        )
        on delete cascade,


    constraint fk_delivery_pod_challenges_verified_driver
        foreign key (
            verified_by_driver_id
        )
        references public.delivery_drivers (
            id
        )
        on delete restrict,


    constraint uq_delivery_pod_challenges_delivery
        unique (
            delivery_id
        )
);


-- ============================================================
-- 2. LOOKUP INDEX
-- ============================================================

create index idx_delivery_pod_challenges_state
    on public.delivery_pod_challenges (
        tenant_id,
        branch_id,
        status,
        created_at
    );


-- ============================================================
-- 3. IMMUTABILITY / SECURITY GUARD
-- ============================================================

create or replace function
public.flashdelivery_protect_pod_challenge_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin

    -- Challenge ownership is immutable.
    if new.tenant_id is distinct from old.tenant_id
       or new.branch_id is distinct from old.branch_id
       or new.delivery_id is distinct from old.delivery_id
    then
        raise exception
            'POD challenge identity is immutable';
    end if;


    -- Failed attempts may never be reduced.
    if new.failed_attempts < old.failed_attempts
    then
        raise exception
            'POD failed attempts cannot decrease';
    end if;


    -- LOCKED is terminal in V1.
    if old.status = 'LOCKED'
       and new.status <> 'LOCKED'
    then
        raise exception
            'Locked POD challenge cannot be reactivated';
    end if;


    -- VERIFIED is terminal in V1.
    if old.status = 'VERIFIED'
       and new.status <> 'VERIFIED'
    then
        raise exception
            'Verified POD challenge cannot be reverted';
    end if;


    -- Once VERIFIED, attempt count and verification identity
    -- are immutable.
    if old.status = 'VERIFIED'
       and (
            new.failed_attempts is distinct from old.failed_attempts
            or new.verified_at is distinct from old.verified_at
            or new.verified_by_driver_id
                is distinct from old.verified_by_driver_id
       )
    then
        raise exception
            'Verified POD challenge is immutable';
    end if;


    return new;
end;
$function$;


create trigger trg_delivery_pod_challenges_protect
before update
on public.delivery_pod_challenges
for each row
execute function
public.flashdelivery_protect_pod_challenge_v1();


-- ============================================================
-- 4. UPDATED_AT
-- ============================================================

create trigger trg_delivery_pod_challenges_updated_at
before update
on public.delivery_pod_challenges
for each row
execute function public.set_updated_at();


-- ============================================================
-- 5. RLS / DIRECT ACCESS
-- ============================================================

alter table public.delivery_pod_challenges
    enable row level security;

revoke all privileges
on table public.delivery_pod_challenges
from anon, authenticated;


-- ============================================================
-- 6. DOCUMENTATION
-- ============================================================

comment on table
public.delivery_pod_challenges is
'FlashDelivery proof-of-delivery challenge state. Raw four-digit POD values are never persisted.';


comment on column
public.delivery_pod_challenges.failed_attempts is
'Number of failed online POD verification attempts. V1 permanently locks the challenge at 5.';


comment on column
public.delivery_pod_challenges.status is
'ACTIVE accepts POD verification, LOCKED blocks further attempts, VERIFIED means final POD verification succeeded.';


comment on column
public.delivery_pod_challenges.verified_by_driver_id is
'Authenticated FlashDelivery driver that successfully verified the POD.';


comment on column
public.delivery_pod_challenges.delivery_id is
'One POD challenge exists per delivery. The POD itself is derived server-side and is not stored in this table.';