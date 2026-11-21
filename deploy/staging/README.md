# Staging privado (droplet de producción, red aislada)

Creado el 2026-11-21 con `setup-staging.py`. Copia **anonimizada** del último respaldo diario de producción,
con secretos propios y sin exposición pública.

| Servicio | Contenedor | IP (red `fastpay-staging-v1-backend`, interna) |
|---|---|---|
| Postgres | `fastpay-staging-postgres-v1` (alias `database-staging-v1`) | 172.30.80.2 |
| API | `fastpay-staging-api-v1` (pagos MOCK, sin credenciales BCP) | 172.30.80.3 |
| Customer/Ops | `fastpay-staging-customer-v1` | 172.30.80.4 |
| Driver | `fastpay-staging-driver-v1` | 172.30.80.5 |
| Realtime | `fastpay-staging-realtime-v1` (alias `realtime-dev`) | 172.30.80.6 |
| Kong | `fastpay-staging-kong-v1` | 172.30.80.7 |

- Secretos: `/etc/fastpay/staging-v1/secrets.private.json` (root 600). Contraseña staff/driver de staging:
  `ssh fastpayadmin@24.144.104.101 sudo /usr/local/sbin/fastpay-staging-password`.
- Usuarios: staff `ADM-B626AF` (ADMIN), `CAJ-740076` (CASHIER) en POLLO001/SUC001; conductores `RSV01`, `DRV-186667`.
- Compose: `/opt/fastpay/staging-v1/compose.json` (proyecto `fastpay-staging-v1`).
- La base de producción **no es alcanzable** desde staging (verificado por `setup-staging.py verify`).
- Los bundles de staging esperan Realtime en `http://localhost:18000` y la app en `http://localhost:13000`.

## Tests automáticos contra staging
```bash
sudo /opt/fastpay/staging-v1/run-e2e.sh            # suite completa (B10/B11)
sudo /opt/fastpay/staging-v1/run-e2e.sh b10        # un test
```
El runner (`e2e-runner/`, imagen `fastpay/staging-e2e:v1`) corre Playwright dentro de la red de staging y
reenvía internamente los puertos localhost que esperan los bundles. Para actualizar los tests: subir
`packages/e2e/{support,tests,...}` a `/opt/fastpay/releases/staging-20261121-v1/e2e-runner` y `docker build`.

## Probar una versión nueva en staging antes de producción
1. Construir imágenes desde el repo (`setup-staging.py images` con la fuente nueva en `SRC`) y re-taggear el API.
2. `docker compose -f /opt/fastpay/staging-v1/compose.json up -d <svc>` para recrear el servicio.
3. Aplicar migraciones nuevas en `fastpay-staging-postgres-v1` y correr `run-e2e.sh`.

## Acceso desde el navegador
El servidor tiene `AllowTcpForwarding no` (no hay túnel SSH). Para usar la UI de staging desde una PC hay que
decidir entre: habilitar el reenvío solo para `fastpayadmin`, o publicar `staging.fastpay.com.bo` en Cloudflare
detrás de Access (y reconstruir customer/driver con esa URL de Realtime).

## Refrescar datos desde producción
Detener/eliminar el stack y el volumen `fastpay-staging-postgres-v1-data` (con autorización) y volver a correr
`setup-staging.py db`, `services`, `verify`.

## Acceso web (Cloudflare Access) — 2026-11-21
- `https://staging.fastpay.com.bo` → `fastpay-staging-customer-web-v1` (172.30.80.8; imagen `customer:staging-web-*`,
  Realtime en `/realtime/v1` del mismo dominio para compartir la cookie de Access).
- `https://staging-driver.fastpay.com.bo` → `fastpay-staging-driver-v1`.
- nginx: `/etc/nginx/fastpay-staging.conf` (copia de `nginx-staging.conf`), incluido al final de `nginx.conf`.
  Sin el encabezado `Cf-Access-Jwt-Assertion` responde 403.
- Cloudflare: hostnames públicos del túnel → `http://localhost:80`; aplicación Access con la política de correo.
- `fastpay-staging-customer-v1` (localhost) sigue existiendo solo para el runner de tests.
