-- =========================================================
-- FLASHCOMMERCE - PAYMENTS CORE V1
-- Gate 7A.1
--
-- Objetivos:
-- - Separar el estado comercial del pedido y el estado del pago.
-- - Conservar pedidos historicos sin marcarlos falsamente como pagados.
-- - Permitir varios intentos de pago, pero uno solo activo por pedido.
-- - Registrar eventos idempotentes para QR, efectivo y conciliacion.
-- - Mantener aislamiento por tenant y sucursal.
--
-- Esta migracion NO conecta todavia ningun proveedor bancario.
-- =========================================================

-- =========================================================
-- 1. RESUMEN DE PAGO Y ORIGEN EN ORDERS
-- =========================================================

alter table public.orders
    add column payment_status varchar(30),
    add column order_origin varchar(30);

-- Los pedidos existentes pertenecen al laboratorio anterior al modulo
-- de pagos. NOT_REQUIRED conserva su operacion sin afirmar que se pagaron.
update public.orders
set
    payment_status = 'NOT_REQUIRED',
    order_origin = 'LEGACY';

-- Todo pedido nuevo requerira pago y, mientras OrderService no determine
-- otro origen firmado, se considerara procedente del menu publico.
alter table public.orders
    alter column payment_status set default 'PENDING',
    alter column payment_status set not null,
    alter column order_origin set default 'PUBLIC_MENU',
    alter column order_origin set not null;

alter table public.orders
    add constraint orders_payment_status_check
        check (
            payment_status in (
                'NOT_REQUIRED',
                'PENDING',
                'AWAITING_CONFIRMATION',
                'PAID',
                'FAILED',
                'EXPIRED',
                'CANCELLED',
                'REFUND_PENDING',
                'REFUNDED',
                'REVIEW_REQUIRED'
            )
        ),

    add constraint orders_origin_check
        check (
            order_origin in (
                'LEGACY',
                'PUBLIC_MENU',
                'TABLE_QR',
                'BRANCH_QR',
                'OPS_STAFF',
                'RESERVATION_PREORDER',
                'RESERVATION_CHECKIN'
            )
        ),

    add constraint uq_orders_tenant_branch_id
        unique (
            tenant_id,
            branch_id,
            id
        );

create index idx_orders_payment_status
    on public.orders (
        tenant_id,
        branch_id,
        payment_status,
        created_at
    );

create index idx_orders_origin
    on public.orders (
        tenant_id,
        branch_id,
        order_origin,
        created_at
    );

-- =========================================================
-- 2. INTENTOS DE PAGO
-- =========================================================

create table public.order_payments (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,
    order_id uuid not null,

    attempt_number integer not null,

    method varchar(20) not null,
    provider varchar(30) not null,
    status varchar(30) not null default 'CREATED',

    amount numeric(12,2) not null,
    currency varchar(3) not null default 'BOB',

    -- Referencia creada por FlashCommerce para el proveedor.
    external_reference varchar(100),

    -- Identificadores devueltos por el proveedor.
    provider_payment_id varchar(255),
    provider_transaction_id varchar(255),

    -- Protege reintentos de una misma operacion interna.
    idempotency_key varchar(100) not null
        default gen_random_uuid()::text,

    -- Contenido utilizado para representar el QR.
    qr_payload text,

    expires_at timestamptz,
    paid_at timestamptz,
    verified_at timestamptz,

    -- Se agregara la FK cuando exista el modulo de usuarios.
    confirmed_by_user_id uuid,

    cash_received_amount numeric(12,2),
    cash_change_amount numeric(12,2),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint order_payments_tenant_fk
        foreign key (tenant_id)
        references public.tenants(id)
        on delete cascade,

    constraint order_payments_branch_fk
        foreign key (
            tenant_id,
            branch_id
        )
        references public.branches(
            tenant_id,
            id
        )
        on delete cascade,

    constraint order_payments_order_fk
        foreign key (
            tenant_id,
            branch_id,
            order_id
        )
        references public.orders(
            tenant_id,
            branch_id,
            id
        )
        on delete cascade,

    constraint uq_order_payments_tenant_branch_id
        unique (
            tenant_id,
            branch_id,
            id
        ),

    constraint uq_order_payments_attempt
        unique (
            tenant_id,
            order_id,
            attempt_number
        ),

    constraint uq_order_payments_idempotency_key
        unique (idempotency_key),

    constraint order_payments_attempt_number_check
        check (attempt_number > 0),

    constraint order_payments_method_check
        check (
            method in (
                'QR',
                'CASH'
            )
        ),

    constraint order_payments_provider_check
        check (btrim(provider) <> ''),

    constraint order_payments_status_check
        check (
            status in (
                'CREATED',
                'AWAITING_CONFIRMATION',
                'PAID',
                'FAILED',
                'EXPIRED',
                'CANCELLED',
                'REFUND_PENDING',
                'REFUNDED',
                'REVIEW_REQUIRED'
            )
        ),

    constraint order_payments_amount_check
        check (amount > 0),

    constraint order_payments_currency_check
        check (currency ~ '^[A-Z]{3}$'),

    constraint order_payments_external_reference_check
        check (
            external_reference is null
            or btrim(external_reference) <> ''
        ),

    constraint order_payments_provider_payment_id_check
        check (
            provider_payment_id is null
            or btrim(provider_payment_id) <> ''
        ),

    constraint order_payments_provider_transaction_id_check
        check (
            provider_transaction_id is null
            or btrim(provider_transaction_id) <> ''
        ),

    constraint order_payments_idempotency_key_check
        check (btrim(idempotency_key) <> ''),

    constraint order_payments_qr_fields_check
        check (
            method = 'CASH'
            or (
                cash_received_amount is null
                and cash_change_amount is null
            )
        ),

    constraint order_payments_cash_amounts_check
        check (
            (
                cash_received_amount is null
                and cash_change_amount is null
            )
            or (
                method = 'CASH'
                and cash_received_amount >= amount
                and cash_change_amount = cash_received_amount - amount
            )
        ),

    constraint order_payments_paid_timestamps_check
        check (
            status not in (
                'PAID',
                'REFUND_PENDING',
                'REFUNDED'
            )
            or (
                paid_at is not null
                and verified_at is not null
            )
        )
);

-- Un pedido no puede tener simultaneamente QR y efectivo pendientes.
create unique index uq_order_payments_active_attempt
    on public.order_payments (
        tenant_id,
        order_id
    )
    where status in (
        'CREATED',
        'AWAITING_CONFIRMATION'
    );

-- Un segundo abono no puede liberar nuevamente el mismo pedido.
create unique index uq_order_payments_paid_attempt
    on public.order_payments (
        tenant_id,
        order_id
    )
    where status in (
        'PAID',
        'REFUND_PENDING',
        'REVIEW_REQUIRED'
    );

create unique index uq_order_payments_external_reference
    on public.order_payments (
        tenant_id,
        external_reference
    )
    where external_reference is not null;

create unique index uq_order_payments_provider_payment_id
    on public.order_payments (
        tenant_id,
        provider,
        provider_payment_id
    )
    where provider_payment_id is not null;

create unique index uq_order_payments_provider_transaction_id
    on public.order_payments (
        tenant_id,
        provider,
        provider_transaction_id
    )
    where provider_transaction_id is not null;

create index idx_order_payments_order
    on public.order_payments (
        tenant_id,
        branch_id,
        order_id,
        created_at desc
    );

create index idx_order_payments_branch_status
    on public.order_payments (
        tenant_id,
        branch_id,
        status,
        created_at
    );

create index idx_order_payments_expiration
    on public.order_payments (expires_at)
    where status in (
        'CREATED',
        'AWAITING_CONFIRMATION'
    );

create trigger trg_order_payments_updated_at
before update on public.order_payments
for each row
execute function public.set_updated_at();

-- =========================================================
-- 3. EVENTOS Y AUDITORIA DE PAGOS
-- =========================================================

create table public.payment_events (
    id uuid primary key default gen_random_uuid(),

    tenant_id uuid not null,
    branch_id uuid not null,
    payment_id uuid not null,

    event_type varchar(60) not null,
    provider_event_id varchar(255),

    source varchar(30) not null,
    processing_status varchar(20) not null default 'RECEIVED',

    -- Solamente se almacenara informacion saneada.
    payload jsonb not null default '{}'::jsonb,
    error_message text,

    received_at timestamptz not null default now(),
    processed_at timestamptz,
    created_at timestamptz not null default now(),

    constraint payment_events_payment_fk
        foreign key (
            tenant_id,
            branch_id,
            payment_id
        )
        references public.order_payments(
            tenant_id,
            branch_id,
            id
        )
        on delete cascade,

    constraint payment_events_event_type_check
        check (btrim(event_type) <> ''),

    constraint payment_events_provider_event_id_check
        check (
            provider_event_id is null
            or btrim(provider_event_id) <> ''
        ),

    constraint payment_events_source_check
        check (
            source in (
                'SYSTEM',
                'PROVIDER_QUERY',
                'PROVIDER_WEBHOOK',
                'CASHIER',
                'RECONCILIATION'
            )
        ),

    constraint payment_events_processing_status_check
        check (
            processing_status in (
                'RECEIVED',
                'PROCESSED',
                'IGNORED',
                'FAILED'
            )
        ),

    constraint payment_events_processed_at_check
        check (
            processing_status = 'RECEIVED'
            or processed_at is not null
        )
);

create unique index uq_payment_events_provider_event
    on public.payment_events (
        tenant_id,
        payment_id,
        provider_event_id
    )
    where provider_event_id is not null;

create index idx_payment_events_payment_received
    on public.payment_events (
        tenant_id,
        branch_id,
        payment_id,
        received_at desc
    );

create index idx_payment_events_processing
    on public.payment_events (
        processing_status,
        received_at
    );

-- El backend usa una conexion directa a PostgreSQL. RLS queda activado
-- para impedir acceso anonimo directo desde Supabase hasta definir policies.
alter table public.order_payments
    enable row level security;

alter table public.payment_events
    enable row level security;

comment on column public.orders.payment_status is
    'Resumen autoritativo del estado de pago utilizado por pedidos y KDS.';

comment on column public.orders.order_origin is
    'Origen verificado del pedido; no debe aceptarse libremente desde el cliente.';

comment on table public.order_payments is
    'Intentos de pago QR o efectivo asociados a un pedido.';

comment on table public.payment_events is
    'Auditoria idempotente y saneada de eventos del ciclo de pago.';
