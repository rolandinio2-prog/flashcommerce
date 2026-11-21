#!/bin/bash
# FastPay production database backup (daily, via fastpay-db-backup.timer).
# Read-only on the database: pg_dump/pg_dumpall only. Never stops or modifies containers.
set -euo pipefail
umask 077

CONTAINER=fastpay-postgres-prod-v1
ROOT=/var/backups/fastpay/db-daily
KEEP_DAYS=14
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DIR="$ROOT/$STAMP"
LOG="$ROOT/backup.log"

mkdir -p "$DIR"
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
trap 'log "FAIL $STAMP line $LINENO"; exit 1' ERR

for db in postgres _supabase storage_vectors; do
  docker exec "$CONTAINER" pg_dump -U supabase_admin -d "$db" -Fc --no-password > "$DIR/$db.dump"
  # Verify the archive is readable and not empty.
  docker exec -i "$CONTAINER" pg_restore --list < "$DIR/$db.dump" > /dev/null
  [ -s "$DIR/$db.dump" ]
done
docker exec "$CONTAINER" pg_dumpall -U supabase_admin --globals-only --no-password > "$DIR/globals.sql"
[ -s "$DIR/globals.sql" ]

docker exec "$CONTAINER" psql -U supabase_admin -d postgres -At -c \
  "select json_build_object('orders',(select count(*) from public.orders),'last_order',(select max(created_at) from public.orders),'migrations',(select count(*) from supabase_migrations.schema_migrations))" \
  > "$DIR/summary.json"
(cd "$DIR" && sha256sum *.dump globals.sql summary.json > SHA256SUMS)

ln -sfn "$DIR" "$ROOT/latest"
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime +"$KEEP_DAYS" -exec rm -rf {} +
log "OK $STAMP $(du -sh "$DIR" | cut -f1)"
