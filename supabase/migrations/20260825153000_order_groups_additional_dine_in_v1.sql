-- =========================================================
-- FlashCommerce I5B
-- ORDER GROUP + ADDITIONAL DINE-IN V1
--
-- Contract:
-- - Every order belongs to one order_group_id.
-- - Existing orders receive independent groups.
-- - New ordinary orders receive a new group automatically.
-- - Additional DINE_IN orders inherit the source order group.
-- - Paid orders are never mutated to add products.
-- =========================================================

alter table public.orders
  add column if not exists order_group_id uuid;

update public.orders
set order_group_id = gen_random_uuid()
where order_group_id is null;

alter table public.orders
  alter column order_group_id set default gen_random_uuid();

alter table public.orders
  alter column order_group_id set not null;

create index if not exists idx_orders_tenant_branch_order_group_created
  on public.orders (
    tenant_id,
    branch_id,
    order_group_id,
    created_at,
    id
  );

comment on column public.orders.order_group_id is
  'Stable commercial group. The original order and its additional orders share this id; each order keeps its own order number, items, total, payment and tracking token.';
