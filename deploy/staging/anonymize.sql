-- Staging anonymization for a restored copy of the production database.
-- Run ONLY against a staging/scratch database. Idempotent. Keeps structure,
-- catalog, prices, statuses, GPS trails and relationships; replaces personal
-- data, credentials and every token that could be valid in production.
-- :staging_password_hash must be an scrypt hash (API format) for staff/drivers.
\set ON_ERROR_STOP on
begin;

do $$ begin
  if current_database() <> 'postgres' then raise exception 'unexpected database'; end if;
  if coalesce(current_setting('fastpay.staging', true), '') <> 'yes' then
    raise exception 'refusing to run: set fastpay.staging=yes (staging only)';
  end if;
end $$;

-- Customers
update public.customer_accounts set
  full_name = 'Cliente ' || left(id::text, 8),
  phone_normalized = '5990' || lpad((row_number_id)::text, 7, '0'),
  pin_hash = 'disabled'
from (select id as rid, row_number() over (order by created_at, id) as row_number_id from public.customer_accounts) n
where n.rid = customer_accounts.id;
delete from public.customer_sessions;

-- Orders, deliveries, reservations
update public.orders set
  customer_name = case when customer_name is null then null else 'Cliente ' || left(id::text, 8) end,
  customer_phone = case when customer_phone is null then null else '59900000000' end,
  customer_notes = null,
  delivery_address = case when delivery_address is null then null else 'Dirección de prueba ' || left(id::text, 6) end,
  tracking_token = case when tracking_token is null then null else gen_random_uuid() end;
update public.deliveries set
  recipient_name = 'Destinatario ' || left(id::text, 8),
  recipient_phone = '59900000000',
  address_text = 'Dirección de prueba ' || left(id::text, 6),
  address_reference = null,
  tracking_token = gen_random_uuid();
update public.table_reservations set
  customer_name = 'Cliente ' || left(id::text, 8),
  customer_phone = '59900000000',
  customer_notes = null,
  tracking_token = case when tracking_token is null then null else gen_random_uuid() end;
update public.delivery_events set actor_reference = null;
update public.delivery_cash_settlements set notes = null;
update public.cash_daily_closings set note = null where note is not null;

-- Payments: no bank identifiers or QR payloads from production
update public.order_payments set
  provider_payment_id = case when provider_payment_id is null then null else 'STG-' || left(id::text, 12) end,
  provider_transaction_id = case when provider_transaction_id is null then null else 'STG-' || left(id::text, 12) end,
  external_reference = case when external_reference is null then null else 'STG-' || left(id::text, 12) end,
  qr_payload = case when qr_payload is null then null else 'STAGING' end;
update public.payment_events set payload = '{}'::jsonb, provider_event_id = case when provider_event_id is null then null else 'STG-' || left(id::text, 12) end;

-- Staff and drivers: anonymized identity, staging-only password, all sessions/credentials revoked
update public.staff_users set
  first_name = 'Staff', last_name = user_code, email = null, phone = null, identity_document = null,
  password_hash = :'staging_password_hash', password_change_required = false;
delete from public.staff_sessions;
update public.delivery_drivers set
  first_name = 'Conductor', last_name = code, display_name = 'Conductor ' || code,
  email = null, phone = '59900000000', identity_document = null,
  vehicle_plate = case when vehicle_plate is null then null else 'STG-' || upper(left(id::text, 4)) end,
  password_hash = case when password_hash is null then null else :'staging_password_hash' end,
  password_change_required = false;
-- token_hash is immutable by trigger; revoking makes any production driver token useless here.
update public.delivery_driver_credentials set status = 'REVOKED' where status <> 'REVOKED';

-- Tokens that could otherwise match production links/QRs
update public.carts set cart_token = gen_random_uuid();
delete from public.checkout_drafts;
update public.dining_tables set public_qr_token = gen_random_uuid() where public_qr_token is not null;

-- Realtime transient messages copied from production
truncate realtime.messages;

commit;

-- Summary
select 'customers', count(*) from public.customer_accounts
union all select 'orders', count(*) from public.orders
union all select 'staff_sessions', count(*) from public.staff_sessions
union all select 'staff_users', count(*) from public.staff_users;
