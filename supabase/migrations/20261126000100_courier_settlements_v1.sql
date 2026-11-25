-- D1c: settlements for FlashCommerce Delivery.
--  * Client statements: what a courier client owes for delivered requests in a period.
--  * Driver payouts: what the fleet owes a driver for completed deliveries in a period,
--    computed from the driver's pay rule (delivery_drivers.pay_mode / pay_value) and snapshotted.
-- Each delivery can sit in at most one live (non-void) statement and one live payout; voiding
-- releases its items so the deliveries can be settled again.

create table public.courier_client_statements (
  id uuid not null default gen_random_uuid() primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null,
  courier_client_id uuid not null,
  statement_number integer not null,
  period_from date not null,
  period_to date not null,
  delivery_count integer not null,
  total_fee numeric(12, 2) not null,
  status varchar(20) not null default 'ISSUED',
  payment_method varchar(20),
  payment_reference varchar(120),
  notes text,
  created_by_staff_user_id uuid,
  paid_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_courier_statements_client foreign key (tenant_id, courier_client_id)
    references public.courier_clients(tenant_id, id),
  constraint fk_courier_statements_branch foreign key (branch_id) references public.branches(id),
  constraint uq_courier_statements_number unique (tenant_id, statement_number),
  constraint courier_statements_period_check check (period_to >= period_from),
  constraint courier_statements_amounts_check check (delivery_count > 0 and total_fee >= 0),
  constraint courier_statements_status_check check (status in ('ISSUED', 'PAID', 'VOID')),
  constraint courier_statements_method_check check (
    payment_method is null or payment_method in ('CASH', 'TRANSFER', 'QR', 'OTHER')),
  constraint courier_statements_paid_check check ((status = 'PAID') = (paid_at is not null))
);

create table public.courier_client_statement_items (
  statement_id uuid not null references public.courier_client_statements(id) on delete cascade,
  tenant_id uuid not null,
  delivery_id uuid not null references public.deliveries(id),
  fee numeric(12, 2) not null,
  primary key (statement_id, delivery_id),
  constraint courier_statement_items_fee_check check (fee >= 0)
);
-- Items are deleted when a statement is voided, so a plain unique index guarantees one live statement per delivery.
create unique index uq_courier_statement_items_delivery on public.courier_client_statement_items (delivery_id);

create table public.courier_driver_payouts (
  id uuid not null default gen_random_uuid() primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null,
  driver_id uuid not null references public.delivery_drivers(id),
  payout_number integer not null,
  period_from date not null,
  period_to date not null,
  pay_mode varchar(20) not null,
  pay_value numeric(12, 2) not null,
  delivery_count integer not null,
  fee_total numeric(12, 2) not null,
  amount numeric(12, 2) not null,
  status varchar(20) not null default 'ISSUED',
  payment_method varchar(20),
  payment_reference varchar(120),
  notes text,
  created_by_staff_user_id uuid,
  paid_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_courier_payouts_branch foreign key (branch_id) references public.branches(id),
  constraint uq_courier_payouts_number unique (tenant_id, payout_number),
  constraint courier_payouts_period_check check (period_to >= period_from),
  constraint courier_payouts_amounts_check check (delivery_count >= 0 and fee_total >= 0 and amount >= 0),
  constraint courier_payouts_mode_check check (pay_mode in ('NONE', 'FIXED_PER_DELIVERY', 'PERCENT_OF_FEE', 'SALARY')),
  constraint courier_payouts_status_check check (status in ('ISSUED', 'PAID', 'VOID')),
  constraint courier_payouts_method_check check (
    payment_method is null or payment_method in ('CASH', 'TRANSFER', 'QR', 'OTHER')),
  constraint courier_payouts_paid_check check ((status = 'PAID') = (paid_at is not null))
);

create table public.courier_driver_payout_items (
  payout_id uuid not null references public.courier_driver_payouts(id) on delete cascade,
  tenant_id uuid not null,
  delivery_id uuid not null references public.deliveries(id),
  fee numeric(12, 2) not null,
  amount numeric(12, 2) not null,
  primary key (payout_id, delivery_id),
  constraint courier_payout_items_amount_check check (fee >= 0 and amount >= 0)
);
create unique index uq_courier_payout_items_delivery on public.courier_driver_payout_items (delivery_id);

create index idx_courier_statements_client on public.courier_client_statements (tenant_id, courier_client_id, created_at desc);
create index idx_courier_payouts_driver on public.courier_driver_payouts (tenant_id, driver_id, created_at desc);
-- Settlement queries look up completed assignments by branch and completion time.
create index if not exists idx_delivery_assignments_completed on public.delivery_assignments (tenant_id, branch_id, completed_at)
  where status = 'COMPLETED';

create trigger trg_courier_statements_updated_at before update on public.courier_client_statements
  for each row execute function public.set_updated_at();
create trigger trg_courier_payouts_updated_at before update on public.courier_driver_payouts
  for each row execute function public.set_updated_at();

alter table public.courier_client_statements enable row level security;
alter table public.courier_client_statement_items enable row level security;
alter table public.courier_driver_payouts enable row level security;
alter table public.courier_driver_payout_items enable row level security;
revoke all on public.courier_client_statements, public.courier_client_statement_items,
  public.courier_driver_payouts, public.courier_driver_payout_items from public, anon, authenticated;
