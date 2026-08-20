begin;

-- ============================================================
-- FlashDelivery D9 - Cash on Delivery operational cash model
-- V1
--
-- Financial ledger remains public.order_payments.
--
-- This migration adds:
--   1. DRIVER as a payment-event source.
--   2. Composite key scopes required for strong COD FKs.
--   3. Driver cash collection audit records.
--   4. Driver cash settlement batches.
--   5. Settlement-to-collection items.
--
-- COD payment-method switching behavior is implemented in the
-- application layer, not in this migration.
--
-- No Supabase Realtime publication is added.
-- ============================================================


-- ============================================================
-- 1. PAYMENT EVENT SOURCE
-- ============================================================

alter table public.payment_events
  drop constraint payment_events_source_check;

alter table public.payment_events
  add constraint payment_events_source_check
  check (
    source in (
      'SYSTEM',
      'PROVIDER_QUERY',
      'PROVIDER_WEBHOOK',
      'CASHIER',
      'DRIVER',
      'RECONCILIATION'
    )
  );


-- ============================================================
-- 2. COMPOSITE COD REFERENCE SCOPES
--
-- These redundant unique constraints exist intentionally.
-- They allow the cash collection row to prove at the database
-- layer that:
--
--   assignment -> same delivery + same driver
--   delivery   -> same order
--   payment    -> same order + same amount + same currency
--
-- This prevents independently valid foreign keys from being
-- combined into an invalid cross-entity cash collection.
-- ============================================================

alter table public.delivery_assignments
  add constraint uq_delivery_assignments_cod_collection_scope
  unique (
    tenant_id,
    branch_id,
    id,
    delivery_id,
    driver_id
  );

alter table public.deliveries
  add constraint uq_deliveries_cod_collection_scope
  unique (
    tenant_id,
    branch_id,
    id,
    order_id
  );

alter table public.order_payments
  add constraint uq_order_payments_cod_collection_scope
  unique (
    tenant_id,
    branch_id,
    id,
    order_id,
    amount,
    currency
  );


-- ============================================================
-- 3. DRIVER CASH COLLECTIONS
-- ============================================================

create table public.delivery_cash_collections (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null,
  branch_id uuid not null,

  order_id uuid not null,
  delivery_id uuid not null,
  assignment_id uuid not null,
  driver_id uuid not null,
  payment_id uuid not null,

  amount numeric(12, 2) not null,
  currency varchar(3) not null,

  cash_received_amount numeric(12, 2) not null,
  cash_change_amount numeric(12, 2) not null,

  idempotency_key varchar(200) not null,

  collected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint dcc_amount_check
    check (
      amount > 0
    ),

  constraint dcc_currency_check
    check (
      currency ~ '^[A-Z]{3}$'
    ),

  constraint dcc_cash_check
    check (
      cash_received_amount >= amount
      and cash_change_amount =
        cash_received_amount - amount
    ),

  constraint dcc_idempotency_check
    check (
      btrim(idempotency_key) <> ''
    ),

  constraint dcc_tenant_fk
    foreign key (
      tenant_id
    )
    references public.tenants (
      id
    ),

  constraint dcc_branch_fk
    foreign key (
      tenant_id,
      branch_id
    )
    references public.branches (
      tenant_id,
      id
    ),

  constraint dcc_delivery_order_fk
    foreign key (
      tenant_id,
      branch_id,
      delivery_id,
      order_id
    )
    references public.deliveries (
      tenant_id,
      branch_id,
      id,
      order_id
    ),

  constraint dcc_assignment_scope_fk
    foreign key (
      tenant_id,
      branch_id,
      assignment_id,
      delivery_id,
      driver_id
    )
    references public.delivery_assignments (
      tenant_id,
      branch_id,
      id,
      delivery_id,
      driver_id
    ),

  constraint dcc_driver_branch_fk
    foreign key (
      tenant_id,
      branch_id,
      driver_id
    )
    references public.delivery_driver_branches (
      tenant_id,
      branch_id,
      driver_id
    ),

  constraint dcc_payment_order_amount_currency_fk
    foreign key (
      tenant_id,
      branch_id,
      payment_id,
      order_id,
      amount,
      currency
    )
    references public.order_payments (
      tenant_id,
      branch_id,
      id,
      order_id,
      amount,
      currency
    ),

  constraint uq_dcc_payment
    unique (
      tenant_id,
      branch_id,
      payment_id
    ),

  constraint uq_dcc_delivery
    unique (
      tenant_id,
      branch_id,
      delivery_id
    ),

  constraint uq_dcc_idempotency
    unique (
      idempotency_key
    ),

  constraint uq_dcc_item_scope
    unique (
      tenant_id,
      branch_id,
      id,
      driver_id,
      currency,
      amount
    )
);

create index idx_dcc_driver_collected
  on public.delivery_cash_collections (
    tenant_id,
    branch_id,
    driver_id,
    collected_at desc
  );

create index idx_dcc_branch_collected
  on public.delivery_cash_collections (
    tenant_id,
    branch_id,
    collected_at desc
  );


-- ============================================================
-- 4. DRIVER CASH SETTLEMENTS
-- ============================================================

create table public.delivery_cash_settlements (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null,
  branch_id uuid not null,
  driver_id uuid not null,

  status varchar(20) not null default 'OPEN',

  currency varchar(3) not null,

  expected_amount numeric(12, 2) not null default 0,
  received_amount numeric(12, 2),
  difference_amount numeric(12, 2),

  idempotency_key varchar(200) not null,

  opened_at timestamptz not null default now(),
  settled_at timestamptz,
  cancelled_at timestamptz,

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint dcs_status_check
    check (
      status in (
        'OPEN',
        'SETTLED',
        'CANCELLED'
      )
    ),

  constraint dcs_currency_check
    check (
      currency ~ '^[A-Z]{3}$'
    ),

  constraint dcs_idempotency_check
    check (
      btrim(idempotency_key) <> ''
    ),

  constraint dcs_amounts_check
    check (
      expected_amount >= 0
      and (
        received_amount is null
        or received_amount >= 0
      )
      and (
        (
          received_amount is null
          and difference_amount is null
        )
        or
        (
          received_amount is not null
          and difference_amount =
            received_amount - expected_amount
        )
      )
    ),

  constraint dcs_lifecycle_check
    check (
      (
        status = 'OPEN'
        and settled_at is null
        and cancelled_at is null
        and received_amount is null
        and difference_amount is null
      )
      or
      (
        status = 'SETTLED'
        and settled_at is not null
        and cancelled_at is null
        and received_amount is not null
        and difference_amount is not null
      )
      or
      (
        status = 'CANCELLED'
        and settled_at is null
        and cancelled_at is not null
        and received_amount is null
        and difference_amount is null
      )
    ),

  constraint dcs_tenant_fk
    foreign key (
      tenant_id
    )
    references public.tenants (
      id
    ),

  constraint dcs_branch_fk
    foreign key (
      tenant_id,
      branch_id
    )
    references public.branches (
      tenant_id,
      id
    ),

  constraint dcs_driver_branch_fk
    foreign key (
      tenant_id,
      branch_id,
      driver_id
    )
    references public.delivery_driver_branches (
      tenant_id,
      branch_id,
      driver_id
    ),

  constraint uq_dcs_idempotency
    unique (
      idempotency_key
    ),

  constraint uq_dcs_item_scope
    unique (
      tenant_id,
      branch_id,
      id,
      driver_id,
      currency
    )
);

create unique index uq_dcs_open_driver_currency
  on public.delivery_cash_settlements (
    tenant_id,
    branch_id,
    driver_id,
    currency
  )
  where status = 'OPEN';

create index idx_dcs_driver_status
  on public.delivery_cash_settlements (
    tenant_id,
    branch_id,
    driver_id,
    status,
    created_at desc
  );

create index idx_dcs_branch_status
  on public.delivery_cash_settlements (
    tenant_id,
    branch_id,
    status,
    created_at desc
  );


-- ============================================================
-- 5. SETTLEMENT ITEMS
--
-- A collection is linked to at most one settlement item in V1.
-- Application logic must only cancel an empty settlement batch.
-- This keeps a collected payment from silently moving between
-- reconciliation batches after financial review has started.
-- ============================================================

create table public.delivery_cash_settlement_items (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null,
  branch_id uuid not null,

  settlement_id uuid not null,
  collection_id uuid not null,
  driver_id uuid not null,

  amount numeric(12, 2) not null,
  currency varchar(3) not null,

  created_at timestamptz not null default now(),

  constraint dcsi_amount_check
    check (
      amount > 0
    ),

  constraint dcsi_currency_check
    check (
      currency ~ '^[A-Z]{3}$'
    ),

  constraint dcsi_tenant_fk
    foreign key (
      tenant_id
    )
    references public.tenants (
      id
    ),

  constraint dcsi_branch_fk
    foreign key (
      tenant_id,
      branch_id
    )
    references public.branches (
      tenant_id,
      id
    ),

  constraint dcsi_settlement_scope_fk
    foreign key (
      tenant_id,
      branch_id,
      settlement_id,
      driver_id,
      currency
    )
    references public.delivery_cash_settlements (
      tenant_id,
      branch_id,
      id,
      driver_id,
      currency
    ),

  constraint dcsi_collection_scope_fk
    foreign key (
      tenant_id,
      branch_id,
      collection_id,
      driver_id,
      currency,
      amount
    )
    references public.delivery_cash_collections (
      tenant_id,
      branch_id,
      id,
      driver_id,
      currency,
      amount
    ),

  constraint uq_dcsi_collection
    unique (
      tenant_id,
      branch_id,
      collection_id
    )
);

create index idx_dcsi_settlement
  on public.delivery_cash_settlement_items (
    tenant_id,
    branch_id,
    settlement_id
  );

create index idx_dcsi_driver
  on public.delivery_cash_settlement_items (
    tenant_id,
    branch_id,
    driver_id,
    created_at desc
  );


-- ============================================================
-- 6. RLS
-- ============================================================

alter table public.delivery_cash_collections
  enable row level security;

alter table public.delivery_cash_settlements
  enable row level security;

alter table public.delivery_cash_settlement_items
  enable row level security;


-- No public RLS policies are intentionally created in V1.
-- No Supabase Realtime publication is intentionally added.


comment on table public.delivery_cash_collections is
  'Immutable operational record of cash collected by a FlashDelivery driver for a DRIVER_COD payment.';

comment on table public.delivery_cash_settlements is
  'Driver cash reconciliation batch. Delivery completion does not imply settlement.';

comment on table public.delivery_cash_settlement_items is
  'Links one collected COD payment to one driver cash settlement batch.';


commit;