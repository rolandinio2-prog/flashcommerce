-- ============================================================
-- FLASHCOMMERCE STAFF PASSWORD LIFECYCLE V1
-- ============================================================
-- Purpose:
--   - Every generated temporary password must be replaced by the user.
--   - Record when the personal password was established.
--   - Existing staff users enter the same first-login password-change flow.
-- ============================================================

begin;

alter table public.staff_users
  add column password_change_required boolean not null default true,
  add column password_changed_at timestamptz;

comment on column public.staff_users.password_change_required is
  'True while the operator is using a generated/reset temporary password.';

comment on column public.staff_users.password_changed_at is
  'Timestamp of the latest successful personal password setup.';

commit;
