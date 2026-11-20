begin;
set local lock_timeout = '5s';
-- One draft per existing cart. No order, payment, or cart expiry is changed.
create table public.checkout_drafts (
  cart_id uuid primary key,
  tenant_id uuid not null,
  branch_id uuid not null,
  secret_hash char(64) not null unique,
  form jsonb not null check (jsonb_typeof(form) = 'object'),
  revision integer not null check (revision > 0),
  customer_account_id uuid references public.customer_accounts(id) on delete set null,
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, cart_id) references public.carts(tenant_id, id) on delete cascade,
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id)
);
create index checkout_drafts_account on public.checkout_drafts(tenant_id, customer_account_id, updated_at desc);
alter table public.checkout_drafts enable row level security;
-- No public policies: access only through the API's existing database role.
commit;
