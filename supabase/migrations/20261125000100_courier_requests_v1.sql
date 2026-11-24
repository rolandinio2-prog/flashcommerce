-- D1a: standalone Delivery (FlashCommerce Delivery) on the existing delivery engine.
-- A courier request is stored as a DELIVERY order with origin COURIER_REQUEST (no items),
-- so dispatch, driver app, POD, tracking and cash settlement keep working unchanged.

-- 1. Products contracted per tenant (minimal; full plans come in R4).
create table public.tenant_products (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product varchar(20) not null,
  status varchar(20) not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, product),
  constraint tenant_products_product_check check (product in ('COMMERCE', 'DELIVERY')),
  constraint tenant_products_status_check check (status in ('ACTIVE', 'INACTIVE'))
);
insert into public.tenant_products (tenant_id, product)
select t.id, p.product from public.tenants t cross join (values ('COMMERCE'), ('DELIVERY')) as p(product)
on conflict do nothing;

-- 2. Courier clients: the merchants a fleet delivers for.
create table public.courier_clients (
  id uuid not null default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code varchar(32) not null,
  name varchar(120) not null,
  phone varchar(32),
  tax_id varchar(32),
  pickup_address text,
  pickup_reference text,
  pickup_latitude numeric(9, 6),
  pickup_longitude numeric(9, 6),
  billing_mode varchar(20) not null default 'PER_DELIVERY',
  status varchar(20) not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  constraint uq_courier_clients_tenant_id unique (tenant_id, id),
  constraint uq_courier_clients_tenant_code unique (tenant_id, code),
  constraint courier_clients_billing_check check (billing_mode in ('PER_DELIVERY', 'PERIODIC')),
  constraint courier_clients_status_check check (status in ('ACTIVE', 'INACTIVE')),
  constraint courier_clients_pickup_pair_check check ((pickup_latitude is null) = (pickup_longitude is null)),
  constraint courier_clients_pickup_range_check check (
    pickup_latitude is null or (pickup_latitude between -90 and 90 and pickup_longitude between -180 and 180))
);

-- 3. Rates: tenant default (courier_client_id null) and per-client overrides.
--    ZONE uses the coverage zone fee; DISTANCE = greatest(min_fee, base_fee + per_km_fee * km).
create table public.courier_rates (
  id uuid not null default gen_random_uuid() primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  courier_client_id uuid,
  pricing_mode varchar(20) not null default 'ZONE',
  base_fee numeric(12, 2) not null default 0,
  per_km_fee numeric(12, 2) not null default 0,
  min_fee numeric(12, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_courier_rates_client foreign key (tenant_id, courier_client_id)
    references public.courier_clients(tenant_id, id) on delete cascade,
  constraint courier_rates_mode_check check (pricing_mode in ('ZONE', 'DISTANCE')),
  constraint courier_rates_amounts_check check (base_fee >= 0 and per_km_fee >= 0 and min_fee >= 0)
);
create unique index uq_courier_rates_scope on public.courier_rates
  (tenant_id, coalesce(courier_client_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- 4. Delivery: courier client, pickup point (null = branch origin), package, amount to collect.
alter table public.deliveries
  add column courier_client_id uuid,
  add column pickup_name varchar(120),
  add column pickup_phone varchar(32),
  add column pickup_address text,
  add column pickup_reference text,
  add column pickup_latitude numeric(9, 6),
  add column pickup_longitude numeric(9, 6),
  add column package_description text,
  add column collect_amount numeric(12, 2) not null default 0,
  add constraint fk_deliveries_courier_client foreign key (tenant_id, courier_client_id)
    references public.courier_clients(tenant_id, id),
  add constraint deliveries_pickup_pair_check check ((pickup_latitude is null) = (pickup_longitude is null)),
  add constraint deliveries_collect_amount_check check (collect_amount >= 0);
create index idx_deliveries_courier_client on public.deliveries (tenant_id, courier_client_id, created_at)
  where courier_client_id is not null;

-- 5. Driver pay rule (configurable per driver).
alter table public.delivery_drivers
  add column pay_mode varchar(20) not null default 'NONE',
  add column pay_value numeric(12, 2) not null default 0,
  add constraint delivery_drivers_pay_mode_check check (pay_mode in ('NONE', 'FIXED_PER_DELIVERY', 'PERCENT_OF_FEE', 'SALARY')),
  add constraint delivery_drivers_pay_value_check check (
    pay_value >= 0 and (pay_mode <> 'PERCENT_OF_FEE' or pay_value <= 100));

-- 6. New order origin for courier requests (always DELIVERY, no items).
alter table public.orders drop constraint orders_origin_check;
alter table public.orders add constraint orders_origin_check check (order_origin in (
  'LEGACY', 'PUBLIC_MENU', 'TABLE_QR', 'BRANCH_QR', 'OPS_STAFF',
  'RESERVATION_PREORDER', 'RESERVATION_CHECKIN', 'COURIER_REQUEST'));
alter table public.orders add constraint orders_courier_request_type_check
  check (order_origin <> 'COURIER_REQUEST' or order_type = 'DELIVERY');

-- 7. updated_at + lockdown (API only, as the rest of the schema).
create trigger trg_tenant_products_updated_at before update on public.tenant_products
  for each row execute function public.set_updated_at();
create trigger trg_courier_clients_updated_at before update on public.courier_clients
  for each row execute function public.set_updated_at();
create trigger trg_courier_rates_updated_at before update on public.courier_rates
  for each row execute function public.set_updated_at();
alter table public.tenant_products enable row level security;
alter table public.courier_clients enable row level security;
alter table public.courier_rates enable row level security;
revoke all on public.tenant_products, public.courier_clients, public.courier_rates from public, anon, authenticated;
