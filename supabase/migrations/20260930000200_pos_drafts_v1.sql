-- POS checkout drafts (S3). Applied in production on 2026-09-30; added to repo 2026-11-21.
begin;
create table public.pos_drafts (
  cart_id uuid primary key references public.carts(id),
  tenant_id uuid not null references public.tenants(id),
  branch_id uuid not null references public.branches(id),
  staff_user_id uuid not null references public.staff_users(id),
  request_id uuid not null,
  order_id uuid unique references public.orders(id),
  checkout_hash varchar(64),
  created_at timestamptz not null default now(),
  unique(tenant_id,branch_id,staff_user_id,request_id),
  foreign key(tenant_id,branch_id) references public.branches(tenant_id,id),
  foreign key(tenant_id,staff_user_id) references public.staff_users(tenant_id,id),
  foreign key(tenant_id,cart_id) references public.carts(tenant_id,id),
  foreign key(tenant_id,branch_id,staff_user_id) references public.staff_user_branches(tenant_id,branch_id,user_id),
  foreign key(tenant_id,branch_id,order_id) references public.orders(tenant_id,branch_id,id),
  check ((order_id is null and checkout_hash is null) or (order_id is not null and checkout_hash is not null))
);
alter table public.pos_drafts enable row level security;
revoke all on public.pos_drafts from public, anon, authenticated;
create index pos_drafts_staff_recent on public.pos_drafts(tenant_id,branch_id,staff_user_id,created_at desc);
commit;
