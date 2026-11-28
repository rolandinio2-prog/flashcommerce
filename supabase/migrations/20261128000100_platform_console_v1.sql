-- R4a: FlashCommerce Cloud platform console.
-- Platform operators (the people who run FlashCommerce Cloud, not a business's staff) sign in to a
-- separate console to create businesses and manage their products. They are not tenant users and have
-- no access to tenant operations through the staff API.

create table public.platform_users (
  id uuid primary key default gen_random_uuid(),
  email varchar(160) not null,
  display_name varchar(120) not null,
  password_hash text not null,
  status varchar(20) not null default 'ACTIVE',
  password_change_required boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_users_status_check check (status in ('ACTIVE', 'DISABLED'))
);
create unique index uq_platform_users_email on public.platform_users (lower(email));

create table public.platform_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.platform_users(id) on delete cascade,
  token_hash char(64) not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index uq_platform_sessions_token on public.platform_sessions (token_hash);
create index idx_platform_sessions_user on public.platform_sessions (user_id);

-- Append-only record of what a platform operator changed.
create table public.platform_audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references public.platform_users(id) on delete set null,
  action varchar(60) not null,
  tenant_id uuid references public.tenants(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_platform_audit_tenant on public.platform_audit_events (tenant_id, created_at desc);

alter table public.platform_users enable row level security;
alter table public.platform_sessions enable row level security;
alter table public.platform_audit_events enable row level security;
revoke all on public.platform_users, public.platform_sessions, public.platform_audit_events from anon, authenticated;
