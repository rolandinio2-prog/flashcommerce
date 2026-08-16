-- =========================================================
-- FLASH COMMERCE
-- Seed inicial - Tenant #001
-- Negocio piloto de venta de pollos
-- =========================================================

do $$
declare
    v_tenant uuid;
    v_branch uuid;

    v_cat_pollos uuid;
    v_cat_guarniciones uuid;
    v_cat_bebidas uuid;

    v_broaster uuid;
    v_espiedo uuid;
    v_parrilla uuid;
    v_papas uuid;
    v_arroz uuid;
    v_bebida uuid;

begin

-- =========================================================
-- TENANT #001
-- =========================================================

insert into public.tenants (
    code,
    name,
    slug,
    status
)
values (
    'POLLO001',
    'Venta de Pollos Piloto',
    'venta-pollos-piloto',
    'ACTIVE'
)
on conflict (code)
do update set
    name = excluded.name,
    slug = excluded.slug,
    status = 'ACTIVE'
returning id into v_tenant;


-- =========================================================
-- SUCURSAL PILOTO
-- =========================================================

insert into public.branches (
    tenant_id,
    code,
    name,
    slug,
    status
)
values (
    v_tenant,
    'SUC001',
    'Sucursal Piloto',
    'sucursal-piloto',
    'ACTIVE'
)
on conflict (tenant_id, code)
do update set
    name = excluded.name,
    slug = excluded.slug,
    status = 'ACTIVE'
returning id into v_branch;


-- =========================================================
-- CATEGORÍAS
-- =========================================================

insert into public.product_categories (
    tenant_id,
    name,
    slug,
    sort_order
)
values (
    v_tenant,
    'Pollos',
    'pollos',
    1
)
on conflict (tenant_id, slug)
do update set
    name = excluded.name,
    sort_order = excluded.sort_order
returning id into v_cat_pollos;


insert into public.product_categories (
    tenant_id,
    name,
    slug,
    sort_order
)
values (
    v_tenant,
    'Guarniciones',
    'guarniciones',
    2
)
on conflict (tenant_id, slug)
do update set
    name = excluded.name,
    sort_order = excluded.sort_order
returning id into v_cat_guarniciones;


insert into public.product_categories (
    tenant_id,
    name,
    slug,
    sort_order
)
values (
    v_tenant,
    'Bebidas',
    'bebidas',
    3
)
on conflict (tenant_id, slug)
do update set
    name = excluded.name,
    sort_order = excluded.sort_order
returning id into v_cat_bebidas;


-- =========================================================
-- PRODUCTOS
-- =========================================================

insert into public.products (
    tenant_id,
    category_id,
    sku,
    name,
    description
)
values (
    v_tenant,
    v_cat_pollos,
    'POL-BROASTER',
    'Pollo Broaster',
    'Pollo preparado al estilo broaster'
)
on conflict (tenant_id, sku)
do update set
    name = excluded.name,
    description = excluded.description,
    category_id = excluded.category_id
returning id into v_broaster;


insert into public.products (
    tenant_id,
    category_id,
    sku,
    name,
    description
)
values (
    v_tenant,
    v_cat_pollos,
    'POL-ESPIEDO',
    'Pollo al Espiedo',
    'Pollo preparado al espiedo'
)
on conflict (tenant_id, sku)
do update set
    name = excluded.name,
    description = excluded.description,
    category_id = excluded.category_id
returning id into v_espiedo;


insert into public.products (
    tenant_id,
    category_id,
    sku,
    name,
    description
)
values (
    v_tenant,
    v_cat_pollos,
    'POL-PARRILLA',
    'Pollo a la Parrilla',
    'Pollo preparado a la parrilla'
)
on conflict (tenant_id, sku)
do update set
    name = excluded.name,
    description = excluded.description,
    category_id = excluded.category_id
returning id into v_parrilla;


insert into public.products (
    tenant_id,
    category_id,
    sku,
    name
)
values (
    v_tenant,
    v_cat_guarniciones,
    'GUAR-PAPAS',
    'Papas'
)
on conflict (tenant_id, sku)
do update set
    name = excluded.name,
    category_id = excluded.category_id
returning id into v_papas;


insert into public.products (
    tenant_id,
    category_id,
    sku,
    name
)
values (
    v_tenant,
    v_cat_guarniciones,
    'GUAR-ARROZ',
    'Arroz'
)
on conflict (tenant_id, sku)
do update set
    name = excluded.name,
    category_id = excluded.category_id
returning id into v_arroz;


insert into public.products (
    tenant_id,
    category_id,
    sku,
    name
)
values (
    v_tenant,
    v_cat_bebidas,
    'BEB-GENERICA',
    'Bebida'
)
on conflict (tenant_id, sku)
do update set
    name = excluded.name,
    category_id = excluded.category_id
returning id into v_bebida;


-- =========================================================
-- PRODUCTOS POR SUCURSAL
-- Valores iniciales de LABORATORIO
-- No representan todavía precios comerciales definitivos.
-- =========================================================

insert into public.branch_products (
    tenant_id,
    branch_id,
    product_id,
    price,
    currency,
    is_available,
    available_quantity,
    preparation_minutes
)
values
    (
        v_tenant,
        v_branch,
        v_broaster,
        60.00,
        'BOB',
        true,
        null,
        25
    ),
    (
        v_tenant,
        v_branch,
        v_espiedo,
        65.00,
        'BOB',
        true,
        null,
        35
    ),
    (
        v_tenant,
        v_branch,
        v_parrilla,
        70.00,
        'BOB',
        true,
        null,
        30
    ),
    (
        v_tenant,
        v_branch,
        v_papas,
        15.00,
        'BOB',
        true,
        null,
        10
    ),
    (
        v_tenant,
        v_branch,
        v_arroz,
        10.00,
        'BOB',
        true,
        null,
        10
    ),
    (
        v_tenant,
        v_branch,
        v_bebida,
        12.00,
        'BOB',
        true,
        null,
        0
    )

on conflict (
    tenant_id,
    branch_id,
    product_id
)
do update set
    price = excluded.price,
    currency = excluded.currency,
    is_available = excluded.is_available,
    available_quantity = excluded.available_quantity,
    preparation_minutes = excluded.preparation_minutes,
    updated_at = now();

end $$;