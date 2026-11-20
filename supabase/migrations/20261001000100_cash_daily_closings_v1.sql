begin;
create table public.cash_daily_closings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  branch_id uuid not null,
  business_date date not null,
  timezone text not null check (timezone = 'America/La_Paz'),
  currency text not null check (currency = 'BOB'),
  request_id uuid not null,
  snapshot_hash varchar(64) not null check (snapshot_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  expected_cash numeric(18,2) not null check (expected_cash >= 0),
  counted_cash numeric(18,2) not null check (counted_cash >= 0),
  difference numeric(18,2) generated always as (counted_cash - expected_cash) stored,
  note varchar(500) not null,
  actor_id uuid not null,
  actor_code varchar(32) not null,
  closed_at timestamptz not null default transaction_timestamp(),
  constraint cash_close_branch_fk foreign key (tenant_id, branch_id) references public.branches(tenant_id,id),
  constraint cash_close_actor_fk foreign key (tenant_id, actor_id) references public.staff_users(tenant_id,id),
  constraint cash_close_day_unique unique (tenant_id,branch_id,business_date),
  constraint cash_close_request_unique unique (tenant_id,branch_id,request_id),
  constraint cash_close_note_check check (expected_cash = counted_cash or length(trim(note)) >= 5)
);
create function public.prevent_cash_close_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'Cash closing is immutable' using errcode='55000';
end;
$$;
create trigger cash_close_immutable before update or delete on public.cash_daily_closings
for each row execute function public.prevent_cash_close_mutation();
create trigger cash_close_no_truncate before truncate on public.cash_daily_closings
for each statement execute function public.prevent_cash_close_mutation();
alter table public.cash_daily_closings enable row level security;
revoke all on public.cash_daily_closings from public, anon, authenticated;
comment on table public.cash_daily_closings is 'Immutable branch/day snapshot. Late changes are reported separately, never rewrite a closing. API only.';
commit;
