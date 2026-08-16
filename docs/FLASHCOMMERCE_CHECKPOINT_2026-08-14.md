# Flash Commerce / Venta de Pollos — CHECKPOINT DE CONTINUIDAD

Fecha: 2026-08-14
Proyecto local: C:\Projects\FlashCommerce
Proyecto ChatGPT: Venta de pollos

## 1. Objetivo del producto
Flash Commerce es una plataforma SaaS multi-negocio, iniciando con un restaurante de venta de pollos.

Modalidades de pedido:
- DINE_IN
- TAKEAWAY
- PICKUP
- DELIVERY

Arquitectura:
- Next.js frontend
- NestJS backend
- PostgreSQL/Supabase
- API-first
- Modular monolith
- Multi-tenant desde el inicio
- Backend autoritativo para precio, disponibilidad y reglas.

## 2. Entorno actual
Workspace: C:\Projects\FlashCommerce
Frontend: apps/customer
Backend: apps/api
Supabase: supabase

Puertos:
- Frontend: http://localhost:3000
- Backend: http://localhost:3001
- Supabase API: http://127.0.0.1:54321
- PostgreSQL: 127.0.0.1:54322
- Studio: http://127.0.0.1:54323

Tenant laboratorio: POLLO001
Sucursal: SUC001
Zona horaria: America/La_Paz

## 3. Estado funcional validado
- Catálogo: funcionando
- Carrito: funcionando con persistencia PostgreSQL + localStorage
- Creación de pedidos: funcionando
- Tracking por trackingToken: funcionando
- Historial de estados: funcionando
- KDS: funcionando con polling cada 5 segundos
- Production build frontend: limpio
- Production build backend: limpio

Estados:
PENDING -> CONFIRMED -> PREPARING -> READY -> COMPLETED
CANCELLED permitido desde PENDING / CONFIRMED.

## 4. Fulfillment
Campos en public.orders:
- scheduled_for
- customer_name
- customer_phone
- table_code
- delivery_address
- customer_notes

Validado de extremo a extremo:
- PICKUP
- DELIVERY
- DINE_IN
- TAKEAWAY

Reglas backend:
DINE_IN:
- tableCode obligatorio

TAKEAWAY:
- sin campos adicionales obligatorios

PICKUP:
- scheduledFor obligatorio
- scheduledFor futuro
- customerName obligatorio
- customerPhone obligatorio

DELIVERY:
- customerName obligatorio
- customerPhone obligatorio
- deliveryAddress obligatorio

## 5. Tables V0.1
Migración:
20260814193437_dining_tables_v1.sql

Tablas:
- public.dining_tables
- public.table_sessions

Mesas laboratorio:
M01 | Mesa 1 | 4 | Interior
M02 | Mesa 2 | 4 | Interior
M03 | Mesa 3 | 2 | Interior
M04 | Mesa 4 | 6 | Interior
M05 | Mesa 5 | 4 | Terraza
M06 | Mesa 6 | 4 | Terraza
M07 | Mesa 7 | 2 | Terraza
M08 | Mesa 8 | 6 | Terraza

Regla:
Mesa activa sin table_session OPEN = AVAILABLE.
Mesa con table_session OPEN = OCCUPIED.

Existe una sesión OPEN manual en M02 para pruebas.
Estado esperado:
- M01 AVAILABLE
- M02 OCCUPIED
- M03 AVAILABLE
- M04 AVAILABLE
- M05 AVAILABLE
- M06 AVAILABLE
- M07 AVAILABLE
- M08 AVAILABLE

Endpoint:
GET /api/v1/tables?tenant=POLLO001&branch=SUC001

Validado:
- total = 8
- available = 7
- occupied = 1
- M02 = OCCUPIED

## 6. Selector visual de mesas
Frontend actualizado.

DINE_IN:
- ya no escribe mesa manualmente
- usa popup “Selecciona tu mesa”
- agrupa Interior / Terraza
- AVAILABLE seleccionable
- OCCUPIED visible pero deshabilitada
- botón Actualizar
- frontend vuelve a consultar disponibilidad antes de enviar

Popup validado visualmente con M02 ocupada.

## 7. Tables V0.2 — Pedido ↔ sesión
Migración real:
20260814211325_order_table_session_link_v1.sql

Aplicada correctamente.

Agrega:
public.orders.table_session_id uuid nullable

Restricciones:
- orders_table_session_fk
- orders_table_session_order_type_check

Índice:
- idx_orders_table_session

Regla:
Si table_session_id no es NULL, order_type debe ser DINE_IN.

IMPORTANTE:
table_session_id NO es UNIQUE. Una sesión puede tener varios pedidos.

## 8. Migración vacía accidental
Existe y debe mantenerse:
20260814210459_order_table_sessions_v1.sql

Fue aplicada vacía accidentalmente.
NO BORRAR.
NO MODIFICAR.

## 9. Estado actual de order.service.ts
Se corrigieron:
- interfaces Tables V0.2 que habían quedado dentro de OpsOrderRow
- INSERT de orders con table_session_id
- placeholders SQL hasta $16

Último build:
pnpm --filter api build
Resultado:
$ nest build
SIN ERRORES.

Lógica DINE_IN dentro de la transacción:
1. recuperar/bloquear carrito
2. buscar mesa por tenant + branch + tableCode
3. bloquear dining_tables con FOR UPDATE
4. validar existencia e is_active
5. buscar table_session OPEN
6. si existe -> ConflictException
7. si no existe -> crear table_session OPEN
8. guardar tableSessionId
9. revalidar productos
10. crear order incluyendo table_session_id
11. crear order_items
12. convertir carrito
13. COMMIT
Si algo falla -> ROLLBACK, incluida la sesión.

## 10. PUNTO EXACTO PARA CONTINUAR
NO crear nuevas migraciones todavía.
NO modificar tablas todavía.

Próxima prueba:

A. Confirmar M05 disponible:
GET http://localhost:3001/api/v1/tables?tenant=POLLO001&branch=SUC001
Esperado: M05 = AVAILABLE

B. Desde Flash Menu:
1. http://localhost:3000
2. Agregar productos
3. Ver carrito
4. Continuar pedido
5. Comer aquí
6. Seleccionar Mesa 5 / M05
7. Confirmar pedido

C. Volver a consultar mesas.
Esperado:
M05 = OCCUPIED

D. Verificar PostgreSQL:

select
    dt.code,
    dt.name,
    ts.id as session_id,
    ts.status,
    o.order_number,
    o.order_type,
    o.table_code,
    o.table_session_id
from public.table_sessions ts
inner join public.dining_tables dt
    on dt.tenant_id = ts.tenant_id
   and dt.branch_id = ts.branch_id
   and dt.id = ts.table_id
left join public.orders o
    on o.tenant_id = ts.tenant_id
   and o.branch_id = ts.branch_id
   and o.table_session_id = ts.id
where ts.status = 'OPEN'
order by dt.code, o.order_number;

Esperado conceptualmente:
M02 | Mesa 2 | session-A | OPEN | NULL | NULL | NULL | NULL
M05 | Mesa 5 | session-B | OPEN | #N | DINE_IN | M05 | session-B

Condición clave:
table_sessions.id = orders.table_session_id

## 11. Siguiente desarrollo después de validar M05
Construir cierre/liberación de mesa desde operaciones:

M05 OCCUPIED
 -> Cerrar mesa
 -> table_session.status = CLOSED
 -> table_session.closed_at = now()
 -> M05 AVAILABLE

Después:
- varios pedidos por una misma sesión
- QR contextual por mesa
- reservas futuras como módulo separado
- PICKUP con tiempo mínimo real de preparación

## 12. Rutina de arranque
1. Abrir Docker Desktop
2. docker info
3. cd C:\Projects\FlashCommerce
4. pnpm exec supabase status
5. si está apagado: pnpm exec supabase start
6. backend: pnpm --filter api start:dev
7. frontend: pnpm --filter customer dev

URLs:
- http://localhost:3000
- http://localhost:3000/ops
- http://localhost:3001/api/v1/catalog
- http://localhost:3001/api/v1/tables?tenant=POLLO001&branch=SUC001

## 13. Forma de trabajo acordada
- Español
- Paso a paso
- Un gate de validación a la vez
- Comandos PowerShell exactos
- Para archivos grandes: reemplazo completo cuando sea más seguro
- Backups fuera de src/app: C:\Projects\FlashCommerce_Backups
- No guardar backups .ts/.tsx dentro del árbol compilado
- Depuración general de warnings después de estabilizar funcionalidad
