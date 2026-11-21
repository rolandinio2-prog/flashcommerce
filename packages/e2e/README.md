# E2E de seguridad de sesión (gates B10 / B11)

Tests Playwright que reemplazan las aceptaciones manuales de los gates S4:

| Test | Disparador | Qué verifica |
|---|---|---|
| `b10-session-expiry` | `staff_sessions.expires_at` pasa al pasado | Ver criterios abajo |
| `b11-membership-retirement` | `staff_user_branches.status = 'INACTIVE'` | Ver criterios abajo |

Ambos comprueban, para la sesión **SUBJECT**:

1. El monitor muestra la denegación y desaparece el mapa (sin entregas, posiciones ni recorridos).
2. Todos los WebSocket Realtime del navegador se cierran.
3. Durante 30 s no se abre ningún WebSocket nuevo ni llega ningún frame.
4. El API rechaza la cookie (401/403) en `auth/me`, `delivery-monitor/active` y `realtime-session`.

Y para una sesión **CONTROL** paralela: sigue viendo el monitor y conectada a Realtime.

Los WebSocket se observan de forma nativa con Playwright: no se inyectan scripts y no se guarda el contenido de los frames.

## Requisitos

Entorno local levantado (los tests **no** arrancan, detienen ni eliminan contenedores):

- Supabase local (`supabase start`, Postgres en `127.0.0.1:54322`)
- API en `:3001` con `NODE_ENV=development` y `SUPABASE_JWT_SECRET` configurado
- Customer/Ops en `:3000` con `NEXT_PUBLIC_SUPABASE_URL` y la clave pública
- Tenant/sucursal existentes (por defecto `POLLO001` / `SUC001`)

## Ejecución

```bash
pnpm --filter @flashcommerce/e2e exec playwright install chromium   # solo la primera vez
pnpm --filter @flashcommerce/e2e test        # ambos
pnpm --filter @flashcommerce/e2e test:b10    # solo B10
pnpm --filter @flashcommerce/e2e test:b11    # solo B11
```

Variables opcionales: `E2E_BASE_URL`, `E2E_API_URL`, `E2E_DATABASE_URL`, `E2E_TENANT`, `E2E_BRANCH`.

## Datos

Cada ejecución crea dos usuarios temporales `QAE-XXXXXX` (rol MANAGER) con sesión, y los elimina al terminar.
Por seguridad, la suite se niega a usar una base que no sea `localhost`, salvo que se defina `E2E_ALLOW_REMOTE_DB=true` para una base de pruebas desechable.
