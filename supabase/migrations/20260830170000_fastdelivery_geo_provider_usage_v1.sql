-- =========================================================
-- FASTDELIVERY GEO-3
-- GEO PROVIDER USAGE METERING V1
-- =========================================================
--
-- Daily tenant/provider/operation aggregate.
-- No coordinates, PII, secrets, raw provider request, or
-- raw provider response are persisted in this table.
-- =========================================================

create table public.geo_provider_usage (
  id uuid primary key default gen_random_uuid(),

  usage_date date not null,

  tenant_id uuid not null,

  provider varchar(64) not null,
  operation varchar(64) not null,

  request_count bigint not null default 0,
  cache_hit_count bigint not null default 0,
  latency_ms bigint not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint fk_geo_provider_usage_tenant
    foreign key (tenant_id)
    references public.tenants (id)
    on delete cascade,

  constraint uq_geo_provider_usage_daily
    unique (
      usage_date,
      tenant_id,
      provider,
      operation
    ),

  constraint geo_provider_usage_provider_nonempty
    check (
      char_length(btrim(provider)) >= 1
    ),

  constraint geo_provider_usage_operation_nonempty
    check (
      char_length(btrim(operation)) >= 1
    ),

  constraint geo_provider_usage_request_count_check
    check (
      request_count >= 0
    ),

  constraint geo_provider_usage_cache_hit_count_check
    check (
      cache_hit_count >= 0
    ),

  constraint geo_provider_usage_cache_not_above_requests_check
    check (
      cache_hit_count <= request_count
    ),

  constraint geo_provider_usage_latency_ms_check
    check (
      latency_ms >= 0
    )
);

create index idx_geo_provider_usage_tenant_date
  on public.geo_provider_usage (
    tenant_id,
    usage_date desc
  );

create trigger trg_geo_provider_usage_updated_at
before update
on public.geo_provider_usage
for each row
execute function public.set_updated_at();

alter table public.geo_provider_usage
  enable row level security;