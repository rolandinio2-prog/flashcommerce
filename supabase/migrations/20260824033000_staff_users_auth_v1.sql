-- ============================================================
-- FLASHCOMMERCE STAFF USERS + AUTH V1
-- ============================================================
-- Purpose:
--   - Administrative creation of system users.
--   - Branch-scoped roles.
--   - Secure staff sessions without storing plaintext passwords.
--   - Attribute in-person cash payments to the authenticated operator.
-- ============================================================

begin;

create table public.staff_users (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null,

  user_code varchar(32) not null,

  first_name varchar(80) not null,
  last_name varchar(80) not null,
  identity_document varchar(40),
  phone varchar(40),
  email varchar(160),

  password_hash text not null,

  status varchar(20) not null default 'ACTIVE',

  last_login_at timestamptz,

  created_by_user_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint staff_users_tenant_fk
    foreign key (tenant_id)
    references public.tenants(id)
    on delete cascade,

  constraint uq_staff_users_tenant_id
    unique (tenant_id, id),

  constraint uq_staff_users_code
    unique (tenant_id, user_code),

  constraint staff_users_code_check
    check (user_code ~ '^[A-Z]{3}-[A-Z0-9]{6}$'),

  constraint staff_users_first_name_check
    check (btrim(first_name) <> ''),

  constraint staff_users_last_name_check
    check (btrim(last_name) <> ''),

  constraint staff_users_identity_document_check
    check (
      identity_document is null
      or btrim(identity_document) <> ''
    ),

  constraint staff_users_phone_check
    check (
      phone is null
      or btrim(phone) <> ''
    ),

  constraint staff_users_email_check
    check (
      email is null
      or btrim(email) <> ''
    ),

  constraint staff_users_password_hash_check
    check (btrim(password_hash) <> ''),

  constraint staff_users_status_check
    check (status in ('ACTIVE', 'INACTIVE')),

  constraint staff_users_created_by_fk
    foreign key (tenant_id, created_by_user_id)
    references public.staff_users(tenant_id, id)
);

create table public.staff_user_branches (
  tenant_id uuid not null,
  branch_id uuid not null,
  user_id uuid not null,

  role varchar(20) not null,
  status varchar(20) not null default 'ACTIVE',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (tenant_id, branch_id, user_id),

  constraint staff_user_branches_branch_fk
    foreign key (tenant_id, branch_id)
    references public.branches(tenant_id, id)
    on delete cascade,

  constraint staff_user_branches_user_fk
    foreign key (tenant_id, user_id)
    references public.staff_users(tenant_id, id)
    on delete cascade,

  constraint staff_user_branches_role_check
    check (
      role in (
        'ADMIN',
        'MANAGER',
        'CASHIER',
        'KITCHEN',
        'WAITER'
      )
    ),

  constraint staff_user_branches_status_check
    check (status in ('ACTIVE', 'INACTIVE'))
);

create table public.staff_sessions (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null,
  branch_id uuid not null,
  user_id uuid not null,

  token_hash char(64) not null,

  expires_at timestamptz not null,
  revoked_at timestamptz,

  created_at timestamptz not null default now(),

  constraint staff_sessions_scope_fk
    foreign key (tenant_id, branch_id, user_id)
    references public.staff_user_branches(tenant_id, branch_id, user_id)
    on delete cascade,

  constraint staff_sessions_token_hash_uq
    unique (token_hash),

  constraint staff_sessions_token_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$'),

  constraint staff_sessions_expiry_check
    check (expires_at > created_at)
);

create index idx_staff_users_tenant_status
  on public.staff_users (tenant_id, status, created_at desc);

create index idx_staff_user_branches_branch_role
  on public.staff_user_branches (
    tenant_id,
    branch_id,
    role,
    status,
    created_at
  );

create index idx_staff_sessions_user_active
  on public.staff_sessions (
    tenant_id,
    branch_id,
    user_id,
    expires_at desc
  )
  where revoked_at is null;

create trigger trg_staff_users_updated_at
before update on public.staff_users
for each row
execute function public.set_updated_at();

create trigger trg_staff_user_branches_updated_at
before update on public.staff_user_branches
for each row
execute function public.set_updated_at();

alter table public.staff_users enable row level security;
alter table public.staff_user_branches enable row level security;
alter table public.staff_sessions enable row level security;

alter table public.order_payments
  add constraint order_payments_confirmed_by_staff_user_fk
  foreign key (tenant_id, confirmed_by_user_id)
  references public.staff_users(tenant_id, id);

create index idx_order_payments_confirmed_by_staff_user
  on public.order_payments (
    tenant_id,
    confirmed_by_user_id,
    created_at desc
  )
  where confirmed_by_user_id is not null;

commit;
