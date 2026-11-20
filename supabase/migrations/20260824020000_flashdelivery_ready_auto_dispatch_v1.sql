-- =========================================================
-- FLASHDELIVERY READY AUTO DISPATCH V1
--
-- New operational contract:
--
-- CONFIRMED  -> Delivery remains CREATED
-- PREPARING  -> Delivery remains CREATED
-- READY      -> WAITING_ASSIGNMENT -> automatic assignment
--
-- If no eligible driver exists, READY remains valid and the
-- Delivery stays WAITING_ASSIGNMENT for retry/manual fallback.
-- =========================================================

begin;

drop trigger if exists
    trg_flashdelivery_order_confirmed_waiting_assignment
on public.orders;

drop function if exists
    public.flashdelivery_sync_waiting_assignment_on_order_confirmed();

create or replace function
    public.flashdelivery_ready_auto_dispatch()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
    v_delivery_id uuid;
    v_delivery_status text;

    v_explicit_driver_cod boolean := false;

    v_driver_id uuid;
    v_driver_code text;
    v_driver_name text;

    v_next_assignment_number integer;
    v_assignment_id uuid;
begin
    -- -----------------------------------------------------
    -- Dispatch begins ONLY when a DELIVERY order enters READY.
    -- -----------------------------------------------------

    if new.order_type <> 'DELIVERY'
       or new.status <> 'READY'
    then
        return new;
    end if;

    -- -----------------------------------------------------
    -- Preserve explicit DRIVER_COD eligibility.
    -- -----------------------------------------------------

    if new.payment_status = 'AWAITING_CONFIRMATION'
    then
        select exists (
            select 1
            from public.order_payments p
            where p.tenant_id = new.tenant_id
              and p.branch_id = new.branch_id
              and p.order_id = new.id
              and p.method = 'CASH'
              and p.provider = 'DRIVER_COD'
              and p.status = 'AWAITING_CONFIRMATION'
        )
        into v_explicit_driver_cod;
    end if;

    if not (
        coalesce(
            new.payment_status in (
                'PAID',
                'NOT_REQUIRED'
            ),
            false
        )
        or v_explicit_driver_cod
    )
    then
        return new;
    end if;

    -- -----------------------------------------------------
    -- Lock the Delivery row.
    --
    -- Legacy/pilot rows already in WAITING_ASSIGNMENT are
    -- intentionally compatible with this function.
    -- -----------------------------------------------------

    select
        d.id,
        d.status
    into
        v_delivery_id,
        v_delivery_status
    from public.deliveries d
    where d.tenant_id = new.tenant_id
      and d.branch_id = new.branch_id
      and d.order_id = new.id
    limit 1
    for update of d;

    if v_delivery_id is null
    then
        return new;
    end if;

    -- -----------------------------------------------------
    -- CREATED -> WAITING_ASSIGNMENT exactly at READY.
    -- -----------------------------------------------------

    if v_delivery_status = 'CREATED'
    then
        update public.deliveries
        set
            status = 'WAITING_ASSIGNMENT',
            updated_at = now()
        where tenant_id = new.tenant_id
          and branch_id = new.branch_id
          and id = v_delivery_id
          and status = 'CREATED';

        if found
        then
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
                new.tenant_id,
                new.branch_id,
                v_delivery_id,

                'DELIVERY_WAITING_ASSIGNMENT',
                'CREATED',
                'WAITING_ASSIGNMENT',

                'SYSTEM',
                'ORDER_READY',

                jsonb_build_object(
                    'orderId',
                    new.id::text,

                    'orderNumber',
                    new.order_number::text,

                    'orderStatus',
                    new.status,

                    'paymentStatus',
                    new.payment_status
                )
            );

            v_delivery_status :=
                'WAITING_ASSIGNMENT';
        end if;
    end if;

    -- -----------------------------------------------------
    -- Never rewind or duplicate a Delivery that already
    -- progressed beyond WAITING_ASSIGNMENT.
    -- -----------------------------------------------------

    if v_delivery_status <> 'WAITING_ASSIGNMENT'
    then
        return new;
    end if;

    -- -----------------------------------------------------
    -- WAITING_ASSIGNMENT must not already have an active
    -- assignment.
    -- -----------------------------------------------------

    if exists (
        select 1
        from public.delivery_assignments a
        where a.tenant_id = new.tenant_id
          and a.branch_id = new.branch_id
          and a.delivery_id = v_delivery_id
          and a.status in (
              'ASSIGNED',
              'ACCEPTED'
          )
    )
    then
        raise exception
            'Delivery assignment state is inconsistent';
    end if;

    -- -----------------------------------------------------
    -- Pick one eligible driver.
    --
    -- Eligibility V1:
    --   Driver ACTIVE
    --   Branch mapping ENABLED
    --   Zero ASSIGNED/ACCEPTED work
    --
    -- FOR UPDATE SKIP LOCKED serializes competing READY
    -- orders by driver branch row.
    --
    -- Never-assigned / least-recently-assigned drivers are
    -- preferred for basic fairness.
    -- -----------------------------------------------------

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
    where db.tenant_id = new.tenant_id
      and db.branch_id = new.branch_id
      and db.status = 'ENABLED'
      and drv.status = 'ACTIVE'

      and not exists (
          select 1
          from public.delivery_assignments busy
          where busy.tenant_id = db.tenant_id
            and busy.branch_id = db.branch_id
            and busy.driver_id = drv.id
            and busy.status in (
                'ASSIGNED',
                'ACCEPTED'
            )
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

    -- No driver is not a transaction failure.
    -- The delivery remains WAITING_ASSIGNMENT.

    if v_driver_id is null
    then
        return new;
    end if;

    -- -----------------------------------------------------
    -- Immutable assignment sequence.
    -- -----------------------------------------------------

    select
        (
            coalesce(
                max(a.assignment_number),
                0
            ) + 1
        )::integer
    into v_next_assignment_number
    from public.delivery_assignments a
    where a.tenant_id = new.tenant_id
      and a.branch_id = new.branch_id
      and a.delivery_id = v_delivery_id;

    insert into public.delivery_assignments (
        tenant_id,
        branch_id,
        delivery_id,
        driver_id,

        assignment_number,
        status
    )
    values (
        new.tenant_id,
        new.branch_id,
        v_delivery_id,
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
    where tenant_id = new.tenant_id
      and branch_id = new.branch_id
      and id = v_delivery_id
      and status = 'WAITING_ASSIGNMENT';

    if not found
    then
        raise exception
            'Delivery changed concurrently during auto dispatch';
    end if;

    -- -----------------------------------------------------
    -- Immutable assignment event.
    -- -----------------------------------------------------

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
        new.tenant_id,
        new.branch_id,
        v_delivery_id,

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
            new.id::text,

            'orderNumber',
            new.order_number::text
        )
    );

    return new;
end;
$function$;

create trigger
    trg_flashdelivery_order_ready_auto_dispatch
after update of status
on public.orders
for each row
when (
    old.status::text
        is distinct from
    new.status::text
)
execute function
    public.flashdelivery_ready_auto_dispatch();

commit;