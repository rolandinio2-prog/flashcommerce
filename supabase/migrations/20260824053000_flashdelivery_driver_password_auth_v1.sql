-- ============================================================
-- FLASHDELIVERY - DRIVER PASSWORD AUTH V1
--
-- Human login:
--   tenant code + driver code + password
--
-- Internal API transport remains:
--   Authorization: Bearer <short-lived driver session token>
--
-- Raw passwords and raw session tokens are never persisted.
-- ============================================================

alter table public.delivery_drivers
    add column password_hash text,
    add column password_change_required boolean not null default true,
    add column password_changed_at timestamptz,
    add column last_login_at timestamptz;

comment on column public.delivery_drivers.password_hash is
'Scrypt password hash for human Driver-app login. Plaintext passwords must never be persisted.';

comment on column public.delivery_drivers.password_change_required is
'True when the driver must replace an administrator-generated temporary password before operating deliveries.';

comment on column public.delivery_drivers.password_changed_at is
'Timestamp when the driver last established a personal password.';

comment on column public.delivery_drivers.last_login_at is
'Timestamp of the latest successful Driver-app username/password login.';
