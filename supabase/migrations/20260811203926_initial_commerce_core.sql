-- =========================================================
-- FLASH COMMERCE - INITIAL COMMERCE CORE
-- Version: 0.1
-- =========================================================

-- ---------------------------------------------------------
-- Helper: automatically update updated_at
-- ---------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =========================================================
-- TENANTS
-- Cada empresa que utiliza Flash Commerce
-- =========================================================

create table public.tenants (
  id uuid primary key default gen_random_uuid(),

  code varchar(50) not null unique,
  name varchar(150) not null,
  slug varchar(150) not null unique,

  status varchar(20) not null default 'ACTIVE',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chk_tenant_status
    check (status in ('ACTIVE', 'INACTIVE', 'SUSPENDED'))
);

-- =========================================================
-- BRANCHES
-- Sucursales pertenecientes a un Tenant
-- =========================================================

create table public.branches (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null,

  code varchar(50) not null,
  name varchar(150) not null,
  slug varchar(150) not null,

  timezone varchar(100) not null default 'America/La_Paz',

  status varchar(20) not null default 'ACTIVE',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint fk_branch_tenant
    foreign key (tenant_id)
    references public.tenants(id)
    on delete cascade,

  constraint uq_branch_tenant_id
    unique (tenant_id, id),

  constraint uq_branch_code
    unique (tenant_id, code),

  constraint uq_branch_slug
    unique (tenant_id, slug),

  constraint chk_branch_status
    check (status in ('ACTIVE', 'INACTIVE'))
);

-- =========================================================
-- PRODUCT CATEGORIES
-- Categorías genéricas: Pollos, Guarniciones, Bebidas...
-- =========================================================

create table public.product_categories (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null,

  name varchar(100) not null,
  slug varchar(100) not null,

  sort_order integer not null default 0,
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint fk_category_tenant
    foreign key (tenant_id)
    references public.tenants(id)
    on delete cascade,

  constraint uq_category_tenant_id
    unique (tenant_id, id),

  constraint uq_category_slug
    unique (tenant_id, slug),

  constraint chk_category_sort_order
    check (sort_order >= 0)
);

-- =========================================================
-- PRODUCTS
-- Producto general del negocio.
-- No contiene precio específico de sucursal.
-- =========================================================

create table public.products (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null,
  category_id uuid,

  sku varchar(100),

  name varchar(150) not null,
  description text,

  image_url text,

  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint fk_product_tenant
    foreign key (tenant_id)
    references public.tenants(id)
    on delete cascade,

  constraint fk_product_category
    foreign key (tenant_id, category_id)
    references public.product_categories(tenant_id, id)
    on delete set null,

  constraint uq_product_tenant_id
    unique (tenant_id, id),

  constraint uq_product_sku
    unique (tenant_id, sku)
);

-- =========================================================
-- BRANCH PRODUCTS
-- Precio y disponibilidad del producto por sucursal.
-- =========================================================

create table public.branch_products (
  tenant_id uuid not null,
  branch_id uuid not null,
  product_id uuid not null,

  price numeric(12,2) not null,

  currency varchar(3) not null default 'BOB',

  is_available boolean not null default true,

  -- NULL significa que todavía no estamos controlando
  -- inventario por cantidad para ese producto.
  available_quantity integer,

  preparation_minutes integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (
    tenant_id,
    branch_id,
    product_id
  ),

  constraint fk_branch_product_branch
    foreign key (tenant_id, branch_id)
    references public.branches(tenant_id, id)
    on delete cascade,

  constraint fk_branch_product_product
    foreign key (tenant_id, product_id)
    references public.products(tenant_id, id)
    on delete cascade,

  constraint chk_branch_product_price
    check (price >= 0),

  constraint chk_branch_product_quantity
    check (
      available_quantity is null
      or available_quantity >= 0
    ),

  constraint chk_branch_product_preparation
    check (preparation_minutes >= 0)
);

-- =========================================================
-- INDEXES
-- =========================================================

create index idx_branches_tenant
  on public.branches(tenant_id);

create index idx_product_categories_tenant
  on public.product_categories(tenant_id);

create index idx_products_tenant
  on public.products(tenant_id);

create index idx_products_category
  on public.products(category_id);

create index idx_branch_products_branch
  on public.branch_products(branch_id);

create index idx_branch_products_product
  on public.branch_products(product_id);

-- =========================================================
-- UPDATED_AT TRIGGERS
-- =========================================================

create trigger trg_tenants_updated_at
before update on public.tenants
for each row
execute function public.set_updated_at();

create trigger trg_branches_updated_at
before update on public.branches
for each row
execute function public.set_updated_at();

create trigger trg_product_categories_updated_at
before update on public.product_categories
for each row
execute function public.set_updated_at();

create trigger trg_products_updated_at
before update on public.products
for each row
execute function public.set_updated_at();

create trigger trg_branch_products_updated_at
before update on public.branch_products
for each row
execute function public.set_updated_at();

-- =========================================================
-- ROW LEVEL SECURITY
-- Bloqueamos acceso directo inicialmente.
-- El acceso de V1 será mediante Flash API / NestJS.
-- =========================================================

alter table public.tenants
  enable row level security;

alter table public.branches
  enable row level security;

alter table public.product_categories
  enable row level security;

alter table public.products
  enable row level security;

alter table public.branch_products
  enable row level security;