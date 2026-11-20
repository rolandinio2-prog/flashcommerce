begin;

-- ============================================================
-- FLASHDELIVERY - DRIVER ADMIN PROFILE V1
--
-- Extends the existing tenant-level delivery driver identity so
-- administrators can register real drivers from FlashCommerce.
-- Existing drivers remain valid; new profile fields are nullable
-- at schema level for backward compatibility and are required by
-- the administrative API for new registrations.
-- ============================================================

alter table public.delivery_drivers
  add column first_name varchar(80),
  add column last_name varchar(80),
  add column identity_document varchar(40),
  add column email varchar(160),
  add column vehicle_plate varchar(20),
  add column created_by_staff_user_id uuid;

alter table public.delivery_drivers
  add constraint delivery_drivers_first_name_check
    check (
      first_name is null
      or char_length(btrim(first_name)) between 2 and 80
    ),
  add constraint delivery_drivers_last_name_check
    check (
      last_name is null
      or char_length(btrim(last_name)) between 2 and 80
    ),
  add constraint delivery_drivers_identity_document_check
    check (
      identity_document is null
      or char_length(btrim(identity_document)) between 3 and 40
    ),
  add constraint delivery_drivers_email_check
    check (
      email is null
      or char_length(btrim(email)) between 5 and 160
    ),
  add constraint delivery_drivers_vehicle_plate_check
    check (
      vehicle_plate is null
      or (
        char_length(btrim(vehicle_plate)) between 3 and 20
        and vehicle_plate = upper(vehicle_plate)
        and vehicle_plate ~ '^[A-Z0-9 -]+$'
      )
    ),
  add constraint delivery_drivers_created_by_staff_user_fk
    foreign key (
      tenant_id,
      created_by_staff_user_id
    )
    references public.staff_users(
      tenant_id,
      id
    );

create unique index uq_delivery_drivers_identity_document
  on public.delivery_drivers (
    tenant_id,
    upper(btrim(identity_document))
  )
  where identity_document is not null;

create unique index uq_delivery_drivers_vehicle_plate
  on public.delivery_drivers (
    tenant_id,
    upper(btrim(vehicle_plate))
  )
  where vehicle_plate is not null;

comment on column public.delivery_drivers.first_name is
'Personal first name captured by the administrative driver registry.';

comment on column public.delivery_drivers.last_name is
'Personal last name captured by the administrative driver registry.';

comment on column public.delivery_drivers.identity_document is
'Personal identity document for administrative driver registration.';

comment on column public.delivery_drivers.vehicle_plate is
'Current vehicle plate used by the delivery driver.';

comment on column public.delivery_drivers.created_by_staff_user_id is
'Staff operator that created the delivery driver profile.';

commit;
