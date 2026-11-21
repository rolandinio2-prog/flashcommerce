# Despliegue de producción

## Release S5 (2026-11-21) — `main` @ b30f1cf
1. Subir el código (`git archive HEAD apps/api apps/customer apps/driver supabase/migrations/<nueva>.sql`) a `/opt/fastpay/releases/<tag>`.
2. Construir imágenes en el servidor con la imagen base fijada (`/var/backups/fastpay/FLASHCOMMERCE_LINUX_BUILD_V1/node-image.txt`)
   y el secreto BuildKit `public_env` (`/etc/fastpay/build/linux-20260928-v2/{customer,driver}-public.env`).
3. `production/cutover-s5.py --dry-run` (sin cambios) y luego `--execute`:
   respaldo de BD, migración, cambio API → Customer → Driver con healthcheck, verificación pública;
   reversión automática si algo falla. Los contenedores anteriores quedan detenidos (no se borran).

Para un nuevo release: copiar el script, actualizar `TAG`, rutas de compose (las del release vigente) y la migración.

## Respaldos
`server/fastpay-db-backup.sh` instalado como `/usr/local/sbin/fastpay-db-backup.sh` + `fastpay-db-backup.timer`
(diario 07:30 UTC, 14 días, `/var/backups/fastpay/db-daily`). Copia a la PC: `FlashCommerce_Scripts/pull-prod-db-backup.sh`.

## Rotación de secretos JWT (2026-11-21)
Producción usaba los secretos demo públicos de Supabase. `production/rotate-jwt-20261121.py` rotó:
secreto de clientes (tenant Realtime + `SUPABASE_JWT_SECRET` del API), `API_JWT_SECRET` y `METRICS_JWT_SECRET` de Realtime,
re-firmó el token anon de Kong y eliminó el mapeo `sb_secret` demo → service_role.
Los secretos nuevos solo existen en el servidor (`/etc/fastpay/prod-runtime-v1/*.env`, copia en
`/var/backups/fastpay/PROD_JWT_ROTATION_20261121_V1/`, root 600). Pendiente: `DB_ENC_KEY` de Realtime sigue en valor demo.
