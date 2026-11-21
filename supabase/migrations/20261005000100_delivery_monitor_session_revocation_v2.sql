-- Delivery Monitor per-session Realtime + server-side revocation (S4).
-- Source: Codex S4_REALTIME_REVOCATION_CORRECTION_V4 (session-revocation.sql + policy-fix.sql),
-- certified on the S4 acceptance stack (gates B05-B14). Added to repo 2026-11-21.
-- Publishes each location to per-session topics and adds a RESTRICTIVE receive policy,
-- so a revoked/expired session or retired membership stops receiving even with a valid Realtime JWT.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
create function public.delivery_monitor_session_receive_v2()
returns boolean language sql stable security definer set search_path = ''
as $policy$
  select exists (
    select 1 from public.staff_sessions s
    join public.staff_users u on u.id=s.user_id and u.tenant_id=s.tenant_id
    join public.staff_user_branches ub on ub.user_id=s.user_id
      and ub.tenant_id=s.tenant_id and ub.branch_id=s.branch_id
    where s.id::text = (auth.jwt()->>'staff_session_id')
      and s.user_id::text = (auth.jwt()->>'sub')
      and s.tenant_id::text = (auth.jwt()->>'dm_tenant_id')
      and s.branch_id::text = (auth.jwt()->>'dm_branch_id')
      and auth.jwt()->>'iss' = 'flashcommerce-api'
      and auth.jwt()->>'role' = 'authenticated'
      and auth.jwt()->>'aud' = 'authenticated'
      and case when (auth.jwt()->>'exp') ~ '^[0-9]{1,12}$'
        then (auth.jwt()->>'exp')::bigint > extract(epoch from statement_timestamp())
        else false end
      and s.revoked_at is null and s.expires_at > statement_timestamp()
      and u.status='ACTIVE' and not u.password_change_required
      and ub.status='ACTIVE' and ub.role in ('ADMIN','MANAGER','CASHIER')
      and realtime.topic() = auth.jwt()->>'dm_topic'
      and realtime.topic() = 'delivery-monitor:' || s.tenant_id::text || ':'
        || s.branch_id::text || ':session:' || s.id::text
  );
$policy$;
revoke all on function public.delivery_monitor_session_receive_v2() from public;
grant execute on function public.delivery_monitor_session_receive_v2() to authenticated;
create policy delivery_monitor_session_receive_v2 on realtime.messages
as restrictive for select to authenticated using (
  extension = 'broadcast' and topic = realtime.topic()
  and (select public.delivery_monitor_session_receive_v2())
);
create or replace function public.flashdelivery_delivery_monitor_broadcast_location_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient record;
  v_sequence bigint;
  v_payload jsonb;
begin

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

  -- SHARE locks conflict with logout UPDATE and user/membership revocation.
  -- A publication already committed before logout may still be in flight.
  -- No new publication selects a revoked session after logout commits.
  for recipient in
    select s.id, s.expires_at
    from public.staff_sessions s
    join public.staff_users u on u.id = s.user_id and u.tenant_id = s.tenant_id
    join public.staff_user_branches ub on ub.user_id = s.user_id
      and ub.tenant_id = s.tenant_id and ub.branch_id = s.branch_id
    where s.tenant_id = new.tenant_id and s.branch_id = new.branch_id
      and s.revoked_at is null and s.expires_at > clock_timestamp()
      and u.status = 'ACTIVE' and not u.password_change_required
      and ub.status = 'ACTIVE' and ub.role in ('ADMIN','MANAGER','CASHIER')
    order by s.id
    for share of s, u, ub
  loop
    if recipient.expires_at > clock_timestamp() then
      perform realtime.send(v_payload, 'LOCATION_UPDATED',
        'delivery-monitor:' || new.tenant_id::text || ':' || new.branch_id::text
          || ':session:' || recipient.id::text, true);
    end if;
  end loop;

  return new;
end;
$$;


revoke all on function public.flashdelivery_delivery_monitor_broadcast_location_v1() from public;
commit;
