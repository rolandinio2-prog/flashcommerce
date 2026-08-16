# FlashCommerce - Gate 6A - Reservas de mesas

## Alcance

Gate 6A incorpora la base de datos y la API para reservas futuras de mesas.

- Una reserva futura no cambia la disponibilidad fisica de la mesa.
- Los horarios superpuestos para la misma mesa se bloquean en PostgreSQL.
- El check-in crea una `table_session` con estado `OPEN`.
- Al cerrar esa sesion, la reserva cambia automaticamente a `COMPLETED`.

## Archivos

- `supabase/migrations/20260815183000_table_reservations_v1.sql`
- `apps/api/src/reservations/reservations.controller.ts`
- `apps/api/src/reservations/reservations.module.ts`
- `apps/api/src/reservations/reservations.service.ts`
- `apps/api/src/app.module.ts`

## Estados

```text
PENDING -> CONFIRMED -> SEATED -> COMPLETED
   |           |
   v           +------> CANCELLED
CANCELLED      +------> NO_SHOW
```

El check-in admite `PENDING` o `CONFIRMED` y convierte la reserva en `SEATED`.

## Endpoints publicos

### Consultar disponibilidad para un horario

```http
GET /api/v1/reservations/availability
  ?tenant=POLLO001
  &branch=SUC001
  &reservedFor=2026-08-16T19:00:00-04:00
  &durationMinutes=90
  &partySize=4
```

### Crear reserva

```http
POST /api/v1/reservations
Content-Type: application/json

{
  "tenantCode": "POLLO001",
  "branchCode": "SUC001",
  "tableId": "UUID-DE-LA-MESA",
  "reservedFor": "2026-08-16T19:00:00-04:00",
  "durationMinutes": 90,
  "partySize": 4,
  "customerName": "Cliente de prueba",
  "customerPhone": "70000000",
  "customerNotes": "Cumpleanos"
}
```

### Consultar una reserva con token

```http
GET /api/v1/reservations/track/:trackingToken
```

## Endpoints operativos

### Listar reservas

```http
GET /api/v1/ops/reservations?tenant=POLLO001&branch=SUC001
```

Filtros opcionales: `from`, `to` y `status`.

### Confirmar, cancelar o marcar ausencia

```http
PATCH /api/v1/ops/reservations/:reservationId/status
  ?tenant=POLLO001
  &branch=SUC001

{
  "status": "CONFIRMED"
}
```

Estados admitidos por esta operacion: `CONFIRMED`, `CANCELLED`, `NO_SHOW`.

### Check-in

```http
POST /api/v1/ops/reservations/:reservationId/check-in
  ?tenant=POLLO001
  &branch=SUC001
```

El check-in se habilita desde 60 minutos antes del inicio y hasta el final del intervalo reservado.

## Validaciones principales

- `reservedFor` debe incluir zona horaria y estar entre 5 minutos y 365 dias en el futuro.
- Duracion entre 30 y 240 minutos, en incrementos de 15 minutos.
- La cantidad de personas no puede superar la capacidad de la mesa.
- Una reserva `PENDING`, `CONFIRMED` o `SEATED` bloquea cruces de horario.
- El check-in falla si la mesa ya tiene una sesion `OPEN`.

## Validacion realizada antes de empaquetar

```text
pnpm --filter api build
$ nest build
Resultado: sin errores
```
