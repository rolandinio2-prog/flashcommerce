# FlashCommerce - Gate 6C - Pedido anticipado para reservas

## Objetivo

Gate 6C conserva el flujo validado de **solo reserva** y agrega un segundo flujo
opcional: el cliente puede reservar una mesa y dejar preparado un pedido para
la hora de llegada.

La creación del pedido anticipado no ocupa la mesa. La `table_session` se abre
y el pedido se vincula a ella únicamente cuando Operaciones registra el
check-in de la reserva.

## Flujos cubiertos

### 1. Solo reserva

- El cliente crea y consulta su reserva como en Gate 6B.
- Operaciones confirma, cancela, registra ausencia o realiza el check-in.
- La mesa se ocupa solamente durante el check-in.
- Si la sesión se cierra sin pedidos, la reserva queda completada y la mesa
  vuelve a estar disponible.

### 2. Reserva con pedido anticipado

- Desde el detalle de una reserva `PENDING` o `CONFIRMED`, el cliente puede
  elegir `Agregar pedido anticipado`.
- Flash Menu mantiene visible el contexto de la reserva, la mesa y el horario.
- El checkout queda bloqueado en modalidad `DINE_IN` y utiliza la mesa de la
  reserva.
- Se admite un pedido anticipado por reserva.
- El pedido queda programado para `reservedFor` y todavía no abre una sesión
  física de mesa.
- La confirmación de la reserva confirma automáticamente el pedido si todavía
  está pendiente.
- La cancelación o ausencia cancela el pedido si aún no entró en preparación.
- El check-in abre la sesión, ocupa la mesa y vincula el pedido anticipado a esa
  sesión.

## Regla de preparación

Operaciones puede pasar un pedido anticipado de `CONFIRMED` a `PREPARING` desde
60 minutos antes del horario reservado. La interfaz muestra cuándo se habilita
la acción y la API aplica la misma validación.

## Archivos incluidos

- `apps/api/src/order/order.service.ts`
- `apps/api/src/reservations/reservations.service.ts`
- `apps/customer/lib/flash-api.ts`
- `apps/customer/app/components/flash-menu-client.tsx`
- `apps/customer/app/components/table-reservation-client.tsx`
- `apps/customer/app/ops/components/ops-orders-client.tsx`
- `apps/customer/app/ops/components/ops-reservations-panel.tsx`
- `supabase/migrations/20260815210000_reservation_preorders_v1.sql`

## Instalación

1. Detener los procesos que usan los puertos `3000` y `3001`.
2. Extraer el ZIP en la raíz `C:\Projects\FlashCommerce`.
3. Compilar API y frontend.
4. Aplicar la migración local pendiente.
5. Iniciar primero la API y después el frontend.

Comandos principales:

```powershell
pnpm --filter api build
pnpm --filter customer build
pnpm exec supabase migration list --local
pnpm exec supabase migration up --local
```

## Prueba recomendada

1. Crear una reserva futura desde Flash Menu.
2. En su detalle, seleccionar `Agregar pedido anticipado`.
3. Agregar productos y confirmar el pedido.
4. Verificar en Operaciones > Reservas que la reserva muestre el pedido
   vinculado.
5. Verificar en Operaciones > Pedidos que aparezcan el código y el horario de
   la reserva.
6. Confirmar la reserva y comprobar la actualización automática del cliente.
7. Realizar el check-in dentro de la ventana permitida.
8. Verificar que la mesa quede ocupada y que el pedido comparta la misma
   `table_session`.

## Verificaciones del paquete

- Build de la API NestJS: correcto.
- Formato Prettier de los siete archivos TypeScript/TSX: correcto.
- Análisis sintáctico de los cinco archivos del frontend: correcto.
- El build final de Next.js debe ejecutarse en el proyecto Windows después de
  instalar el paquete, utilizando sus dependencias ya instaladas.
