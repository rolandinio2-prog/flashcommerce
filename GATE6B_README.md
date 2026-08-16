# FlashCommerce - Gate 6B - Interfaz de reservas

## Alcance

Gate 6B conecta el frontend con la API de reservas validada en Gate 6A.

### Cliente

- Acceso `Reservar una mesa` desde Flash Menu.
- Seleccion de fecha, hora, duracion y cantidad de personas.
- Consulta de disponibilidad futura por capacidad y cruces de horario.
- Seleccion de mesa y registro de datos de contacto.
- Confirmacion con codigo corto de reserva.
- Seguimiento persistente mediante `trackingToken`.
- Actualizacion automatica del estado cada 5 segundos mientras la reserva
  permanezca activa, con detencion al llegar a un estado final.
- Boton de actualizacion manual conservado como respaldo.

### Operaciones

- Nueva pestana `Reservas` en `/ops`.
- Resumen de pendientes, confirmadas y clientes en mesa.
- Filtros por estado.
- Confirmacion, cancelacion y registro de ausencia.
- Check-in con apertura de `table_session` y ocupacion real de la mesa.
- Actualizacion automatica cada 10 segundos.

## Archivos

- `apps/customer/lib/flash-api.ts`
- `apps/customer/app/components/flash-menu-client.tsx`
- `apps/customer/app/components/table-reservation-client.tsx`
- `apps/customer/app/ops/components/ops-orders-client.tsx`
- `apps/customer/app/ops/components/ops-reservations-panel.tsx`

## Requisitos

- Gate 6A backend v2 instalado.
- Migracion `20260815183000_table_reservations_v1.sql` aplicada.
- `NEXT_PUBLIC_FLASH_API_URL` configurada en `apps/customer/.env.local`.

## Validacion

Los cinco archivos TypeScript/TSX fueron formateados y validados
sintacticamente. El cliente API adicional fue comprobado con TypeScript en
modo estricto. La compilacion de produccion debe ejecutarse despues de instalar
el paquete en el proyecto:

```text
pnpm --filter customer build
```
