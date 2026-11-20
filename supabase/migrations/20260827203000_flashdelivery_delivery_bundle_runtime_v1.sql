-- =========================================================
-- FASTPAY / FLASHDELIVERY
-- DELIVERY BUNDLE RUNTIME V1
--
-- Depends on:
--   20260827194500_flashdelivery_delivery_order_memberships_v1.sql
--
-- Responsibilities:
--   * bundle-aware READY auto-dispatch
--   * membership payment activation/release
--   * prevent DRIVER_COD for joined ADDITIONAL members
--   * prevent manual/automatic assignment before every
--     non-released bundle member is READY and dispatchable
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1. Bundle dispatchability contract.
-- ---------------------------------------------------------

create or replace function public.flashdelivery_bundle_dispatchable_v1(
    p_tenant_id uuid,
    p_branch_id uuid,
    p_delivery_id uuid
)
returns boolean
language plpgsql
stable
set search_path to ''
as $function$
declare
    v_open_member_count integer;
    v_blocking_member_count integer;
begin
    select count(*)::integer
    into v_open_member_count
    from public.delivery_order_memberships m
    where m.tenant_id = p_tenant_id
      and m.branch_id = p_branch_id
      and m.delivery_id = p_delivery_id
      and m.membership_status in ('PENDING', 'ACTIVE');

    if v_open_member_count = 0 then
        return false;
    end if;

    select count(*)::integer
    into v_blocking_member_count
    from public.delivery_order_memberships m
    inner join public.orders o
      on o.tenant_id = m.tenant_id
     and o.branch_id = m.branch_id
     and o.id = m.order_id
    where m.tenant_id = p_tenant_id
      and m.branch_id = p_branch_id
      and m.delivery_id = p_delivery_id
      and m.membership_status in ('PENDING', 'ACTIVE')
      and (
          m.membership_status = 'PENDING'
          or o.status <> 'READY'
          or not (
              o.payment_status in ('PAID', 'NOT_REQUIRED')
              or (
                  m.role = 'PRIMARY'
                  and o.payment_status = 'AWAITING_CONFIRMATION'
                  and exists (
                      select 1
                      from public.order_payments p
                      where p.tenant_id = o.tenant_id
                        and p.branch_id = o.branch_id
                        and p.order_id = o.id
                        and p.method = 'CASH'
                        and p.provider = 'DRIVER_COD'
                        and p.status = 'AWAITING_CONFIRMATION'
                  )
              )
          )
      );

    return v_blocking_member_count = 0;
end;
$function$;

-- ---------------------------------------------------------
-- 2. Common auto-dispatch attempt for one physical Delivery.
-- ---------------------------------------------------------

create or replace function public.flashdelivery_attempt_auto_dispatch_v1(
    p_tenant_id uuid,
    p_branch_id uuid,
    p_delivery_id uuid,
    p_actor_order_id uuid,
    p_actor_order_number bigint,
    p_actor_reference text
)
returns void
language plpgsql
set search_path to ''
as $function$
declare
    v_delivery_status text;
    v_driver_id uuid;
    v_driver_code text;
    v_driver_name text;
    v_next_assignment_number integer;
    v_assignment_id uuid;
    v_member_count integer;
begin
    select d.status
    into v_delivery_status
    from public.deliveries d
    where d.tenant_id = p_tenant_id
      and d.branch_id = p_branch_id
      and d.id = p_delivery_id
    limit 1
    for update of d;

    if v_delivery_status is null then
        return;
    end if;

    if v_delivery_status not in ('CREATED', 'WAITING_ASSIGNMENT') then
        return;
    end if;

    if not public.flashdelivery_bundle_dispatchable_v1(
        p_tenant_id,
        p_branch_id,
        p_delivery_id
    ) then
        return;
    end if;

    if exists (
        select 1
        from public.delivery_assignments a
        where a.tenant_id = p_tenant_id
          and a.branch_id = p_branch_id
          and a.delivery_id = p_delivery_id
          and a.status in ('ASSIGNED', 'ACCEPTED')
    ) then
        return;
    end if;

    select count(*)::integer
    into v_member_count
    from public.delivery_order_memberships m
    where m.tenant_id = p_tenant_id
      and m.branch_id = p_branch_id
      and m.delivery_id = p_delivery_id
      and m.membership_status = 'ACTIVE';

    if v_delivery_status = 'CREATED' then
        update public.deliveries
        set
            status = 'WAITING_ASSIGNMENT',
            updated_at = now()
        where tenant_id = p_tenant_id
          and branch_id = p_branch_id
          and id = p_delivery_id
          and status = 'CREATED';

        if found then
            insert into public.delivery_events (
                tenant_id,
                branch_id,
                delivery_id,
                event_type,
                from_status,
                to_status,
                actor_type,
                actor_reference,
                payload
            )
            values (
                p_tenant_id,
                p_branch_id,
                p_delivery_id,
                'DELIVERY_WAITING_ASSIGNMENT',
                'CREATED',
                'WAITING_ASSIGNMENT',
                'SYSTEM',
                coalesce(p_actor_reference, 'BUNDLE_READY'),
                jsonb_build_object(
                    'orderId',
                    p_actor_order_id::text,
                    'orderNumber',
                    p_actor_order_number::text,
                    'bundleMemberCount',
                    v_member_count
                )
            );

            v_delivery_status := 'WAITING_ASSIGNMENT';
        end if;
    end if;

    if v_delivery_status <> 'WAITING_ASSIGNMENT' then
        return;
    end if;

    select
        drv.id,
        drv.code,
        drv.display_name
    into
        v_driver_id,
        v_driver_code,
        v_driver_name
    from public.delivery_driver_branches db
    inner join public.delivery_drivers drv
      on drv.tenant_id = db.tenant_id
     and drv.id = db.driver_id
    where db.tenant_id = p_tenant_id
      and db.branch_id = p_branch_id
      and db.status = 'ENABLED'
      and drv.status = 'ACTIVE'
      and not exists (
          select 1
          from public.delivery_assignments busy
          where busy.tenant_id = db.tenant_id
            and busy.branch_id = db.branch_id
            and busy.driver_id = drv.id
            and busy.status in ('ASSIGNED', 'ACCEPTED')
      )
    order by
        (
            select max(history.assigned_at)
            from public.delivery_assignments history
            where history.tenant_id = db.tenant_id
              and history.branch_id = db.branch_id
              and history.driver_id = drv.id
        ) asc nulls first,
        drv.code asc,
        drv.id asc
    limit 1
    for update of db
    skip locked;

    if v_driver_id is null then
        return;
    end if;

    select (
        coalesce(max(a.assignment_number), 0) + 1
    )::integer
    into v_next_assignment_number
    from public.delivery_assignments a
    where a.tenant_id = p_tenant_id
      and a.branch_id = p_branch_id
      and a.delivery_id = p_delivery_id;

    insert into public.delivery_assignments (
        tenant_id,
        branch_id,
        delivery_id,
        driver_id,
        assignment_number,
        status
    )
    values (
        p_tenant_id,
        p_branch_id,
        p_delivery_id,
        v_driver_id,
        v_next_assignment_number,
        'ASSIGNED'
    )
    returning id
    into v_assignment_id;

    update public.deliveries
    set
        status = 'ASSIGNED',
        updated_at = now()
    where tenant_id = p_tenant_id
      and branch_id = p_branch_id
      and id = p_delivery_id
      and status = 'WAITING_ASSIGNMENT';

    if not found then
        raise exception
            'Delivery changed concurrently during bundle auto dispatch';
    end if;

    insert into public.delivery_events (
        tenant_id,
        branch_id,
        delivery_id,
        event_type,
        from_status,
        to_status,
        actor_type,
        actor_reference,
        payload
    )
    values (
        p_tenant_id,
        p_branch_id,
        p_delivery_id,
        'DRIVER_ASSIGNED',
        'WAITING_ASSIGNMENT',
        'ASSIGNED',
        'SYSTEM',
        'AUTO_DISPATCH',
        jsonb_build_object(
            'assignmentId',
            v_assignment_id::text,
            'assignmentNumber',
            v_next_assignment_number,
            'driverId',
            v_driver_id::text,
            'driverCode',
            v_driver_code,
            'driverName',
            v_driver_name,
            'orderId',
            p_actor_order_id::text,
            'orderNumber',
            p_actor_order_number::text,
            'bundleMemberCount',
            v_member_count
        )
    );
end;
$function$;

-- ---------------------------------------------------------
-- 3. Replace order READY trigger implementation.
-- ---------------------------------------------------------

create or replace function public.flashdelivery_ready_auto_dispatch()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
    v_delivery_id uuid;
begin
    if new.order_type <> 'DELIVERY'
       or new.status <> 'READY'
    then
        return new;
    end if;

    select m.delivery_id
    into v_delivery_id
    from public.delivery_order_memberships m
    where m.tenant_id = new.tenant_id
      and m.branch_id = new.branch_id
      and m.order_id = new.id
      and m.membership_status in ('PENDING', 'ACTIVE')
    order by
        case m.role
            when 'PRIMARY' then 0
            else 1
        end,
        m.joined_at
    limit 1;

    if v_delivery_id is null then
        select d.id
        into v_delivery_id
        from public.deliveries d
        where d.tenant_id = new.tenant_id
          and d.branch_id = new.branch_id
          and d.order_id = new.id
        limit 1;
    end if;

    if v_delivery_id is null then
        return new;
    end if;

    perform public.flashdelivery_attempt_auto_dispatch_v1(
        new.tenant_id,
        new.branch_id,
        v_delivery_id,
        new.id,
        new.order_number,
        'ORDER_READY'
    );

    return new;
end;
$function$;

-- ---------------------------------------------------------
-- 4. Payment status drives ADDITIONAL membership lifecycle.
-- ---------------------------------------------------------

create or replace function public.flashdelivery_sync_additional_membership_payment_v1()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
    if new.order_type <> 'DELIVERY'
       or new.payment_status is not distinct from old.payment_status
    then
        return new;
    end if;

    if new.payment_status in ('PAID', 'NOT_REQUIRED') then
        update public.delivery_order_memberships
        set
            membership_status = 'ACTIVE',
            updated_at = now()
        where tenant_id = new.tenant_id
          and branch_id = new.branch_id
          and order_id = new.id
          and role = 'ADDITIONAL'
          and membership_status = 'PENDING';
    elsif new.payment_status in (
        'FAILED',
        'EXPIRED',
        'CANCELLED',
        'REFUNDED'
    ) then
        update public.delivery_order_memberships
        set
            membership_status = 'RELEASED',
            released_at = now(),
            release_reason =
                'PAYMENT_' || new.payment_status,
            updated_at = now()
        where tenant_id = new.tenant_id
          and branch_id = new.branch_id
          and order_id = new.id
          and role = 'ADDITIONAL'
          and membership_status = 'PENDING';
    end if;

    return new;
end;
$function$;

drop trigger if exists
    trg_flashdelivery_sync_additional_membership_payment_v1
on public.orders;

create trigger trg_flashdelivery_sync_additional_membership_payment_v1
after update of payment_status
on public.orders
for each row
execute function public.flashdelivery_sync_additional_membership_payment_v1();

-- ---------------------------------------------------------
-- 5. Membership changes can unblock a READY primary Order.
-- ---------------------------------------------------------

create or replace function public.flashdelivery_membership_dispatch_reevaluate_v1()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
    v_anchor_order_id uuid;
    v_anchor_order_number bigint;
begin
    if new.membership_status is not distinct from old.membership_status then
        return new;
    end if;

    if new.membership_status not in ('ACTIVE', 'RELEASED') then
        return new;
    end if;

    select
        d.order_id,
        o.order_number
    into
        v_anchor_order_id,
        v_anchor_order_number
    from public.deliveries d
    inner join public.orders o
      on o.tenant_id = d.tenant_id
     and o.branch_id = d.branch_id
     and o.id = d.order_id
    where d.tenant_id = new.tenant_id
      and d.branch_id = new.branch_id
      and d.id = new.delivery_id
      and d.status in ('CREATED', 'WAITING_ASSIGNMENT')
    limit 1;

    if v_anchor_order_id is null then
        return new;
    end if;

    perform public.flashdelivery_attempt_auto_dispatch_v1(
        new.tenant_id,
        new.branch_id,
        new.delivery_id,
        v_anchor_order_id,
        v_anchor_order_number,
        'MEMBERSHIP_REEVALUATION'
    );

    return new;
end;
$function$;

drop trigger if exists
    trg_flashdelivery_membership_dispatch_reevaluate_v1
on public.delivery_order_memberships;

create trigger trg_flashdelivery_membership_dispatch_reevaluate_v1
after update of membership_status
on public.delivery_order_memberships
for each row
execute function public.flashdelivery_membership_dispatch_reevaluate_v1();

-- ---------------------------------------------------------
-- 6. Joined ADDITIONAL members cannot use DRIVER_COD in V1.
--    A separate additional Order owns a PRIMARY membership
--    on its own Delivery and remains compatible with COD.
-- ---------------------------------------------------------

create or replace function public.flashdelivery_guard_additional_driver_cod_v1()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
    if new.method = 'CASH'
       and new.provider = 'DRIVER_COD'
       and new.status in ('CREATED', 'AWAITING_CONFIRMATION')
       and exists (
           select 1
           from public.delivery_order_memberships m
           where m.tenant_id = new.tenant_id
             and m.branch_id = new.branch_id
             and m.order_id = new.order_id
             and m.role = 'ADDITIONAL'
             and m.membership_status in ('PENDING', 'ACTIVE')
       )
    then
        raise exception
            'DRIVER_COD is not available for a joined additional delivery order';
    end if;

    return new;
end;
$function$;

drop trigger if exists
    trg_flashdelivery_guard_additional_driver_cod_v1
on public.order_payments;

create trigger trg_flashdelivery_guard_additional_driver_cod_v1
before insert or update
on public.order_payments
for each row
execute function public.flashdelivery_guard_additional_driver_cod_v1();

-- ---------------------------------------------------------
-- 7. DB-level assignment guard.
--    Protects auto-dispatch and manual Ops fallback.
-- ---------------------------------------------------------

create or replace function public.flashdelivery_guard_bundle_assignment_v1()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
    if new.status in ('ASSIGNED', 'ACCEPTED')
       and not public.flashdelivery_bundle_dispatchable_v1(
           new.tenant_id,
           new.branch_id,
           new.delivery_id
       )
    then
        raise exception
            'Delivery bundle is not dispatchable yet';
    end if;

    return new;
end;
$function$;

drop trigger if exists
    trg_flashdelivery_guard_bundle_assignment_v1
on public.delivery_assignments;

create trigger trg_flashdelivery_guard_bundle_assignment_v1
before insert or update
on public.delivery_assignments
for each row
execute function public.flashdelivery_guard_bundle_assignment_v1();

commit;