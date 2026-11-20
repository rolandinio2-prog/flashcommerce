-- =========================================================
-- FASTPAY / FLASHCOMMERCE
-- TABLE_PERMANENT_QR_V1
--
-- Permanent public token belongs to the physical dining table.
-- It is intentionally independent from:
--   - orders
--   - order tracking tokens
--   - table sessions
--
-- Scanning the physical QR is read-only. A temporary signed
-- table context is issued by the API after resolving this token.
-- =========================================================

alter table public.dining_tables
  add column if not exists public_qr_token uuid;

update public.dining_tables
set public_qr_token = gen_random_uuid()
where public_qr_token is null;

alter table public.dining_tables
  alter column public_qr_token set default gen_random_uuid(),
  alter column public_qr_token set not null;

create unique index if not exists dining_tables_public_qr_token_unique
  on public.dining_tables (public_qr_token);

comment on column public.dining_tables.public_qr_token is
  'Permanent revocable public token for the physical table QR. Never use order, tracking, or table-session identifiers in the printed QR.';
