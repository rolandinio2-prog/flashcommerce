-- =========================================================
-- FLASH COMMERCE
-- Commerce Core V0.2
--
-- Carts + Cart Items + Orders + Order Items
-- =========================================================


-- =========================================================
-- CARTS
--
-- Representa un carrito de compra abierto.
-- En esta etapa todavía no depende de Flash Session.
-- =========================================================

create table public.carts (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,

    -- Token público/temporal que posteriormente podrá
    -- asociarse al Flash Session del cliente.
    cart_token uuid not null default gen_random_uuid(),

    status varchar(20) not null default 'OPEN',

    currency varchar(3) not null default 'BOB',

    expires_at timestamptz not null
        default (now() + interval '24 hours'),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint fk_cart_tenant
        foreign key (tenant_id)
        references public.tenants(id)
        on delete cascade,

    constraint fk_cart_branch
        foreign key (tenant_id, branch_id)
        references public.branches(tenant_id, id)
        on delete cascade,

    constraint uq_cart_tenant_id
        unique (tenant_id, id),

    constraint uq_cart_token
        unique (cart_token),

    constraint chk_cart_status
        check (
            status in (
                'OPEN',
                'CONVERTED',
                'ABANDONED',
                'EXPIRED'
            )
        )
);


-- =========================================================
-- CART ITEMS
--
-- Productos agregados al carrito.
--
-- unit_price representa el precio mostrado/agregado
-- al carrito en ese momento.
--
-- Antes de crear la orden, el backend volverá a validar
-- precio y disponibilidad.
-- =========================================================

create table public.cart_items (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    cart_id uuid not null,
    product_id uuid not null,

    quantity integer not null default 1,

    unit_price numeric(12,2) not null,
    currency varchar(3) not null default 'BOB',

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint fk_cart_item_cart
        foreign key (tenant_id, cart_id)
        references public.carts(tenant_id, id)
        on delete cascade,

    constraint fk_cart_item_product
        foreign key (tenant_id, product_id)
        references public.products(tenant_id, id),

    constraint uq_cart_product
        unique (cart_id, product_id),

    constraint chk_cart_item_quantity
        check (quantity > 0),

    constraint chk_cart_item_price
        check (unit_price >= 0)
);


-- =========================================================
-- ORDERS
--
-- Pedido comercial generado desde un carrito.
-- =========================================================

create table public.orders (
    id uuid primary key default gen_random_uuid(),

    -- Número simple para operación humana / cocina.
    -- Más adelante podremos hacerlo secuencial por tenant.
    order_number bigint generated always as identity,

    tenant_id uuid not null,
    branch_id uuid not null,

    cart_id uuid,

    order_type varchar(20) not null,

    status varchar(20) not null default 'PENDING',

    currency varchar(3) not null default 'BOB',

    subtotal numeric(12,2) not null default 0,
    discount_total numeric(12,2) not null default 0,
    delivery_fee numeric(12,2) not null default 0,
    total numeric(12,2) not null default 0,

    -- Se utilizará principalmente para PICKUP
    -- y posteriormente reservas.
    scheduled_for timestamptz,

    customer_notes text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint fk_order_tenant
        foreign key (tenant_id)
        references public.tenants(id)
        on delete cascade,

    constraint fk_order_branch
        foreign key (tenant_id, branch_id)
        references public.branches(tenant_id, id)
        on delete cascade,

    constraint fk_order_cart
        foreign key (tenant_id, cart_id)
        references public.carts(tenant_id, id),

    constraint uq_order_tenant_id
        unique (tenant_id, id),

    constraint uq_order_number
        unique (order_number),

    constraint chk_order_type
        check (
            order_type in (
                'DINE_IN',
                'TAKEAWAY',
                'PICKUP',
                'DELIVERY'
            )
        ),

    constraint chk_order_status
        check (
            status in (
                'PENDING',
                'CONFIRMED',
                'PREPARING',
                'READY',
                'COMPLETED',
                'CANCELLED'
            )
        ),

    constraint chk_order_subtotal
        check (subtotal >= 0),

    constraint chk_order_discount
        check (discount_total >= 0),

    constraint chk_order_delivery_fee
        check (delivery_fee >= 0),

    constraint chk_order_total
        check (total >= 0)
);


-- Un carrito solamente puede generar una orden.
-- Los pedidos sin cart_id no se ven afectados.
create unique index uq_order_cart
    on public.orders(tenant_id, cart_id)
    where cart_id is not null;


-- =========================================================
-- ORDER ITEMS
--
-- Snapshot histórico de cada producto vendido.
--
-- Guardamos nombre, SKU y precio para que un cambio
-- posterior en el catálogo NO altere pedidos anteriores.
-- =========================================================

create table public.order_items (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    order_id uuid not null,
    product_id uuid not null,

    sku_snapshot varchar(100),
    name_snapshot varchar(150) not null,

    quantity integer not null,

    unit_price numeric(12,2) not null,
    line_total numeric(12,2) not null,

    currency varchar(3) not null default 'BOB',

    created_at timestamptz not null default now(),

    constraint fk_order_item_order
        foreign key (tenant_id, order_id)
        references public.orders(tenant_id, id)
        on delete cascade,

    constraint fk_order_item_product
        foreign key (tenant_id, product_id)
        references public.products(tenant_id, id),

    constraint chk_order_item_quantity
        check (quantity > 0),

    constraint chk_order_item_price
        check (unit_price >= 0),

    constraint chk_order_item_total
        check (line_total >= 0)
);


-- =========================================================
-- INDEXES
-- =========================================================

create index idx_carts_tenant_branch
    on public.carts(tenant_id, branch_id);

create index idx_carts_status
    on public.carts(status);

create index idx_carts_expires_at
    on public.carts(expires_at);

create index idx_cart_items_cart
    on public.cart_items(cart_id);

create index idx_cart_items_product
    on public.cart_items(product_id);

create index idx_orders_tenant_branch
    on public.orders(tenant_id, branch_id);

create index idx_orders_status
    on public.orders(status);

create index idx_orders_created_at
    on public.orders(created_at desc);

create index idx_order_items_order
    on public.order_items(order_id);

create index idx_order_items_product
    on public.order_items(product_id);


-- =========================================================
-- UPDATED_AT TRIGGERS
--
-- Reutilizamos public.set_updated_at()
-- creado en initial_commerce_core.
-- =========================================================

create trigger trg_carts_updated_at
before update on public.carts
for each row
execute function public.set_updated_at();


create trigger trg_cart_items_updated_at
before update on public.cart_items
for each row
execute function public.set_updated_at();


create trigger trg_orders_updated_at
before update on public.orders
for each row
execute function public.set_updated_at();


-- =========================================================
-- ROW LEVEL SECURITY
--
-- Por ahora Customer → NestJS → PostgreSQL.
-- No habilitamos acceso directo del navegador.
-- =========================================================

alter table public.carts
    enable row level security;

alter table public.cart_items
    enable row level security;

alter table public.orders
    enable row level security;

alter table public.order_items
    enable row level security;