-- ============================================================
-- FLASHDELIVERY
-- ORDER CONFIRMATION -> WAITING_ASSIGNMENT V1
--
-- Guarantees that a paid/verified DELIVERY order entering
-- CONFIRMED moves its delivery from CREATED to
-- WAITING_ASSIGNMENT in the SAME PostgreSQL transaction.
-- ============================================================


create function public.flashdelivery_sync_waiting_assignment_on_order_confirmed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
    v_delivery_id uuid;
begin

    -- --------------------------------------------------------
    -- Only verified DELIVERY orders entering CONFIRMED.
    -- --------------------------------------------------------

    if new.order_type <> 'DELIVERY'
       or new.status <> 'CONFIRMED'
       or new.payment_status not in (
           'PAID',
           'NOT_REQUIRED'
       )
    then
        return new;
    end if;


    -- --------------------------------------------------------
    -- Idempotent transition.
    --
    -- Only CREATED is eligible. A delivery already assigned,
    -- accepted, in transit, completed, etc. is never rewound.
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
    -- Historical event only when transition really occurred.
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


create trigger trg_flashdelivery_order_confirmed_waiting_assignment
after update of status
on public.orders
for each row
when (
    old.status is distinct from new.status
)
execute function public.flashdelivery_sync_waiting_assignment_on_order_confirmed();