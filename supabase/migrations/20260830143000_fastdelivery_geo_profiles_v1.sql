-- =========================================================
-- FASTDELIVERY GEO PLATFORM
-- GEO-2: TENANT GEO PROFILE RESOLVER
--
-- Purpose:
--   Store the technical Geo Profile catalog and optional
--   tenant / branch assignment metadata.
--
-- Important:
--   This migration does NOT switch existing Customer or
--   Driver map/routing behavior.
--   Existing runtime consumers remain on the legacy Google
--   bindings until later Geo Platform milestones.
-- =========================================================

begin;

create table public.geo_profiles (
    id uuid primary key default gen_random_uuid(),

    code varchar(32) not null,

    renderer varchar(32) not null,
    routing_provider varchar(32) not null,
    geocoding_provider varchar(32) not null,
    traffic_provider varchar(32) not null,

    capabilities jsonb not null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint uq_geo_profiles_code
        unique (code),

    constraint geo_profiles_code_check
        check (
            char_length(btrim(code)) >= 3
            and char_length(btrim(code)) <= 32
            and code = upper(code)
            and code ~ '^[A-Z0-9_]+$'
        ),

    constraint geo_profiles_renderer_check
        check (
            renderer in (
                'MAPLIBRE',
                'GOOGLE_MAPS'
            )
        ),

    constraint geo_profiles_routing_provider_check
        check (
            routing_provider in (
                'VALHALLA',
                'GOOGLE'
            )
        ),

    constraint geo_profiles_geocoding_provider_check
        check (
            geocoding_provider in (
                'OPEN',
                'GOOGLE'
            )
        ),

    constraint geo_profiles_traffic_provider_check
        check (
            traffic_provider in (
                'NONE',
                'GOOGLE'
            )
        ),

    constraint geo_profiles_capabilities_check
        check (
            jsonb_typeof(capabilities) = 'object'
        )
);

create table public.tenant_geo_settings (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid null,

    profile_id uuid not null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint fk_tenant_geo_settings_tenant
        foreign key (tenant_id)
        references public.tenants(id)
        on delete cascade,

    constraint fk_tenant_geo_settings_branch
        foreign key (
            tenant_id,
            branch_id
        )
        references public.branches(
            tenant_id,
            id
        )
        on delete cascade,

    constraint fk_tenant_geo_settings_profile
        foreign key (profile_id)
        references public.geo_profiles(id)
        on delete restrict
);

create unique index uq_tenant_geo_settings_tenant_default
on public.tenant_geo_settings (
    tenant_id
)
where branch_id is null;

create unique index uq_tenant_geo_settings_branch_override
on public.tenant_geo_settings (
    tenant_id,
    branch_id
)
where branch_id is not null;

create index idx_tenant_geo_settings_profile
on public.tenant_geo_settings (
    profile_id,
    tenant_id,
    branch_id
);

create trigger trg_geo_profiles_updated_at
before update on public.geo_profiles
for each row
execute function public.set_updated_at();

create trigger trg_tenant_geo_settings_updated_at
before update on public.tenant_geo_settings
for each row
execute function public.set_updated_at();

alter table public.geo_profiles
    enable row level security;

alter table public.tenant_geo_settings
    enable row level security;

insert into public.geo_profiles (
    code,
    renderer,
    routing_provider,
    geocoding_provider,
    traffic_provider,
    capabilities
)
values
(
    'OPEN_STANDARD',
    'MAPLIBRE',
    'VALHALLA',
    'OPEN',
    'NONE',
    '{
      "routing": {
        "route": true,
        "matrix": true,
        "mapMatch": true,
        "trafficAware": false
      },
      "geocoding": {
        "search": true,
        "resolve": true,
        "forward": true,
        "reverse": true
      }
    }'::jsonb
),
(
    'OPEN_ENTERPRISE',
    'MAPLIBRE',
    'VALHALLA',
    'OPEN',
    'NONE',
    '{
      "routing": {
        "route": true,
        "matrix": true,
        "mapMatch": true,
        "trafficAware": false
      },
      "geocoding": {
        "search": true,
        "resolve": true,
        "forward": true,
        "reverse": true
      }
    }'::jsonb
),
(
    'GOOGLE_PREMIUM',
    'GOOGLE_MAPS',
    'GOOGLE',
    'GOOGLE',
    'GOOGLE',
    '{
      "routing": {
        "route": true,
        "matrix": false,
        "mapMatch": false,
        "trafficAware": true
      },
      "geocoding": {
        "search": true,
        "resolve": true,
        "forward": true,
        "reverse": false
      }
    }'::jsonb
);

comment on table public.geo_profiles is
'Technical Geo Platform profile catalog. Product/subscription plans are intentionally separate.';

comment on table public.tenant_geo_settings is
'Optional tenant or branch Geo Profile assignment. Branch assignment overrides tenant default.';

comment on column public.tenant_geo_settings.branch_id is
'NULL means tenant default; non-NULL means branch override.';

commit;