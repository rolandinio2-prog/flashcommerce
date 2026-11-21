#!/bin/bash
# Removes the 27 Codex gate test databases (fastpay_s2_* / fastpay_s3_*) and their roles from the
# production Postgres instance, after a verified per-database backup. Never touches postgres/_supabase/
# storage_vectors. Authorized by the owner on 2026-11-21 (cleanup group G3 only).
set -uo pipefail
C=fastpay-postgres-prod-v1
B=/var/backups/fastpay/TEST_DBS_REMOVED_20261121
mkdir -m 700 -p "$B"
P(){ docker exec "$C" psql -U supabase_admin -d postgres -At -v ON_ERROR_STOP=1 -c "$1" </dev/null; }

before=$(P "select (select count(*) from public.orders)||'|'||(select count(*) from supabase_migrations.schema_migrations)||'|'||(select count(*) from pg_database)")
echo "BEFORE orders|migrations|databases = $before"
DBS=$(P "select datname from pg_database where datname ~ '^fastpay_s[23]_' order by 1")
ROLES=$(P "select rolname from pg_roles where rolname ~ '^fastpay_s[23]_' order by 1")
echo "$DBS" > "$B/databases.txt"; echo "$ROLES" > "$B/roles.txt"
docker exec "$C" pg_dumpall -U supabase_admin --globals-only </dev/null > "$B/globals-before.sql"

fail=0
for db in $DBS; do
  docker exec "$C" pg_dump -U supabase_admin -d "$db" -Fc </dev/null > "$B/$db.dump" || fail=1
  docker exec -i "$C" pg_restore --list < "$B/$db.dump" > /dev/null || fail=1
  [ -s "$B/$db.dump" ] || fail=1
done
(cd "$B" && sha256sum ./*.dump globals-before.sql > SHA256SUMS)
echo "BACKUPS dbs=$(ls "$B"/*.dump | wc -l) size=$(du -sh "$B" | cut -f1) verify_fail=$fail"
[ "$fail" = 0 ] || { echo ABORT_BACKUP_FAILED; exit 2; }

dropped=0
for db in $DBS; do P "drop database \"$db\"" >/dev/null && dropped=$((dropped+1)); done
echo "DROPPED_DATABASES=$dropped"
rdropped=0
for r in $ROLES; do
  if P "drop role \"$r\"" >/dev/null 2>"$B/drop-role-err.txt"; then rdropped=$((rdropped+1))
  else echo "ROLE_KEPT $r: $(head -c 150 "$B/drop-role-err.txt")"; fi
done
echo "DROPPED_ROLES=$rdropped"

after=$(P "select (select count(*) from public.orders)||'|'||(select count(*) from supabase_migrations.schema_migrations)||'|'||(select count(*) from pg_database)")
echo "AFTER  orders|migrations|databases = $after"
echo "databases now: $(P "select string_agg(datname, ', ' order by datname) from pg_database where not datistemplate")"
echo "login roles now: $(P "select count(*) from pg_roles where rolcanlogin")"
