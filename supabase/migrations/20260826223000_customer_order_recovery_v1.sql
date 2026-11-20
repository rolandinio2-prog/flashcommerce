begin;

create table if not exists public.customer_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references public.tenants(id)
    on delete cascade,
  phone_normalized varchar(32) not null,
  pin_hash text not null,
  status varchar(16) not null default 'ACTIVE'
    check (status in ('ACTIVE', 'DISABLED')),
  failed_attempts integer not null default 0
    check (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_customer_accounts_tenant_phone
    unique (tenant_id, phone_normalized)
);

create table if not exists public.customer_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references public.tenants(id)
    on delete cascade,
  customer_account_id uuid not null
    references public.customer_accounts(id)
    on delete cascade,
  token_hash char(64) not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint uq_customer_sessions_token_hash
    unique (token_hash)
);

create index if not exists idx_customer_sessions_account_active
  on public.customer_sessions (customer_account_id, expires_at)
  where revoked_at is null;

alter table public.orders
  add column if not exists customer_account_id uuid
    references public.customer_accounts(id)
    on delete set null;

create index if not exists idx_orders_customer_account_created
  on public.orders (customer_account_id, created_at desc)
  where customer_account_id is not null;

drop trigger if exists trg_customer_accounts_updated_at
  on public.customer_accounts;

create trigger trg_customer_accounts_updated_at
before update on public.customer_accounts
for each row
execute function public.set_updated_at();

alter table public.customer_accounts enable row level security;
alter table public.customer_sessions enable row level security;

commit;