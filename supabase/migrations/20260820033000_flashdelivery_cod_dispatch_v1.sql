-- ============================================================
-- FLASHDELIVERY
-- DRIVER COD DISPATCH ELIGIBILITY V1
--
-- Extends the existing Order CONFIRMED -> WAITING_ASSIGNMENT
-- synchronization without changing the trigger itself.
--
-- Eligible payment states:
--   1. PAID
--   2. NOT_REQUIRED
--   3. Explicit DRIVER_COD:
--      orders.payment_status = AWAITING_CONFIRMATION
--      order_payments.method = CASH
--      order_payments.provider = DRIVER_COD
--      order_payments.status = AWAITING_CONFIRMATION
--
-- Generic AWAITING_CONFIRMATION is NOT dispatchable.
-- ============================================================

create or replace function public.flashdelivery_sync_waiting_assignment_on_order_confirmed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    v_delivery_id uuid;
    v_explicit_driver_cod boolean := false;
begin

    -- --------------------------------------------------------
    -- Only DELIVERY orders entering CONFIRMED are relevant.
    -- --------------------------------------------------------

    if new.order_type <> 'DELIVERY'
       or new.status <> 'CONFIRMED'
    then
        return new;
    end if;


    -- --------------------------------------------------------
    -- AWAITING_CONFIRMATION is dispatchable only when backed
    -- by the explicit DRIVER_COD payment identity.
    -- --------------------------------------------------------

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


    -- --------------------------------------------------------
    -- Preserve the verified-payment paths.
    --
    -- Generic AWAITING_CONFIRMATION, PENDING, FAILED, EXPIRED,
    -- CANCELLED, REVIEW_REQUIRED, etc. remain non-dispatchable.
    -- --------------------------------------------------------

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


    -- --------------------------------------------------------
    -- Idempotent transition.
    --
    -- Never rewind a delivery that already progressed.
    -- --------------------------------------------------------

    update public.deliveries d
    set
        status = 'WAITING_ASSIGNMENT',
        updated_at = now()
    where d.tenant_id = new.tenant_id
      and d.branch_id = new.branch_id
      and d.order_id = new.id
      and d.status = 'CREATED'
    returning d.id
    into v_delivery_id;


    -- --------------------------------------------------------
    -- Preserve existing historical event contract.
    -- --------------------------------------------------------

    if v_delivery_id is not null then

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
            'ORDER_CONFIRMED',

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

    end if;


    return new;
end;
$$;