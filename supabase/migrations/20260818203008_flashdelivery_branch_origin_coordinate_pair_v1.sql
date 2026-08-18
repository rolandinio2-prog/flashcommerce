-- ============================================================
-- FlashDelivery
-- Branch dispatch origin coordinate pair hardening
--
-- Invariant:
--   * latitude and longitude are both NULL, or
--   * latitude and longitude are both present and WGS84-valid.
--
-- No branch data is modified by this migration.
-- ============================================================

begin;

do $$
begin
    if exists (
        select 1
        from public.branches
        where
            (
                delivery_origin_latitude is null
            )
            <>
            (
                delivery_origin_longitude is null
            )
    ) then
        raise exception
            'Cannot enforce branch delivery origin coordinate pair: partial coordinates exist';
    end if;
end
$$;

alter table public.branches
    drop constraint if exists
        branches_delivery_origin_coordinates_check;

alter table public.branches
    add constraint
        branches_delivery_origin_coordinates_check
    check (
        (
            delivery_origin_latitude is null
            and
            delivery_origin_longitude is null
        )
        or
        (
            delivery_origin_latitude is not null
            and
            delivery_origin_longitude is not null
            and
            delivery_origin_latitude
                between -90 and 90
            and
            delivery_origin_longitude
                between -180 and 180
        )
    );

comment on constraint
    branches_delivery_origin_coordinates_check
    on public.branches
is
    'Requires FlashDelivery dispatch origin latitude/longitude to be both null or both present with valid WGS84 ranges.';

commit;