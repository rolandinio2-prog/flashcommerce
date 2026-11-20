-- FASTDELIVERY DM-1 R6P2
-- Secure private Broadcast foundation.
-- This file is created by R6P2 but is NOT applied by R6P2.

create or replace function public.flashdelivery_delivery_monitor_broadcast_location_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_topic text;
  v_sequence bigint;
  v_payload jsonb;
begin
  v_topic :=
    'delivery-monitor:' ||
    new.tenant_id::text ||
    ':' ||
    new.branch_id::text;

  v_sequence :=
    floor(
      extract(
        epoch
        from new.received_at
      ) * 1000000
    )::bigint;

  v_payload :=
    jsonb_build_object(
      'version',
        'delivery-monitor.movement.v1',
      'event',
        'LOCATION_UPDATED',
      'deliveryId',
        new.delivery_id::text,
      'driverId',
        new.driver_id::text,
      'latitude',
        gis.ST_Y(
          new.position::gis.geometry
        ),
      'longitude',
        gis.ST_X(
          new.position::gis.geometry
        ),
      'accuracyM',
        case
          when new.accuracy_meters is null
            then null
          else
            new.accuracy_meters::double precision
        end,
      'capturedAt',
        new.captured_at,
      'sequence',
        v_sequence
    );

  perform realtime.send(
    v_payload,
    'LOCATION_UPDATED',
    v_topic,
    true
  );

  return new;
end;
$$;

drop trigger if exists
  trg_flashdelivery_delivery_monitor_broadcast_location_v1
on public.delivery_driver_locations;

create trigger
  trg_flashdelivery_delivery_monitor_broadcast_location_v1
after insert
on public.delivery_driver_locations
for each row
execute function
  public.flashdelivery_delivery_monitor_broadcast_location_v1();

drop policy if exists
  delivery_monitor_realtime_receive_v1
on realtime.messages;

create policy
  delivery_monitor_realtime_receive_v1
on realtime.messages
for select
to authenticated
using (
  (
    select realtime.topic()
  ) = (
    select auth.jwt()->>'dm_topic'
  )
  and realtime.messages.extension in (
    'broadcast'
  )
);