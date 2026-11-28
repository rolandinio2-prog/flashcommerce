-- R4b: manual subscription billing for FlashCommerce Cloud businesses.
-- A business pays a monthly price per active product (or a negotiated override). Each recorded payment
-- extends paid_until by whole months; 7 days after paid_until the platform suspends it automatically.
-- A business with no tenant_subscriptions row is exempt (never auto-suspended) until one is assigned.

create table public.platform_product_prices (
  product varchar(20) primary key,
  monthly_price numeric(12, 2) not null default 0,
  currency char(3) not null default 'BOB',
  updated_at timestamptz not null default now(),
  constraint platform_product_prices_product_check check (product in ('COMMERCE', 'DELIVERY')),
  constraint platform_product_prices_price_check check (monthly_price >= 0)
);
insert into public.platform_product_prices (product) values ('COMMERCE'), ('DELIVERY');

create table public.tenant_subscriptions (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  paid_until date not null,
  monthly_price_override numeric(12, 2),
  notes varchar(500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_subscriptions_override_check check (monthly_price_override is null or monthly_price_override >= 0)
);

create table public.tenant_subscription_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  amount numeric(12, 2) not null,
  currency char(3) not null default 'BOB',
  months smallint not null,
  method varchar(20) not null,
  reference varchar(120),
  -- The paid_until values around this payment, so voiding the latest payment restores the previous date.
  paid_until_before date not null,
  paid_until_after date not null,
  created_by_platform_user_id uuid references public.platform_users(id) on delete set null,
  voided_at timestamptz,
  void_reason varchar(300),
  created_at timestamptz not null default now(),
  constraint tenant_subscription_payments_amount_check check (amount >= 0),
  constraint tenant_subscription_payments_months_check check (months between 1 and 24),
  constraint tenant_subscription_payments_method_check check (method in ('CASH', 'TRANSFER', 'QR', 'OTHER')),
  constraint tenant_subscription_payments_dates_check check (paid_until_after > paid_until_before)
);
create index idx_tenant_subscription_payments_tenant on public.tenant_subscription_payments (tenant_id, created_at desc);

alter table public.platform_product_prices enable row level security;
alter table public.tenant_subscriptions enable row level security;
alter table public.tenant_subscription_payments enable row level security;
revoke all on public.platform_product_prices, public.tenant_subscriptions, public.tenant_subscription_payments
  from anon, authenticated;
