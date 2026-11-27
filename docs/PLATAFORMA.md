# FlashCommerce Cloud — plataforma, productos y nombres

Plan completo: `docs/FlashCommerce_Cloud_Plan_Consolidacion.docx` (v1, 2026-11-24).

## Nombres (confirmados 2026-11-24)

| Nombre | Qué es |
|---|---|
| **FlashCommerce Cloud** | La plataforma SaaS, este repositorio |
| **Comercio** | Producto: tienda/menú, pedidos, Caja, Ops, mesas, reservas, stock |
| **FlashCommerce Delivery** | Producto: envíos, despacho, app del conductor, seguimiento, cobro y liquidación. Se puede contratar solo |
| **Live** | Producto futuro: venta en vivo, subastas, videos cortos |
| **FastPay** | Negocio propio (tenant) dentro de la plataforma, con Comercio y Delivery. También es el dominio y el prefijo de los contenedores de despliegue (`fastpay-*`) |

### Regla de nombres
- Código, paquetes y documentación nueva: `flashcommerce` / FlashCommerce Cloud.
- Nombres de producto en código: `commerce`, `delivery`, `live`.
- `FastDelivery` / `FlashDelivery` son nombres antiguos: no usarlos en código nuevo. Las vistas y tablas
  existentes con ese prefijo se renombran solo cuando se toquen, con migración propia.
- `fastpay` se mantiene en infraestructura (dominios, contenedores, rutas de servidor) hasta una migración planificada.

## Etapas
| Etapa | Contenido | Estado |
|---|---|---|
| R0 | Orden: archivo de parches, import de Cloud a `docs/cloud`, regla de nombres | Hecho |
| R1 | Dividir `order.service.ts` (checkout, ciclo de vida, POS, stock) | Hecho |
| R2 | API por áreas: núcleo, comercio, pagos, delivery, salón; dividir `delivery.service.ts` | Hecho (`payments.service.ts` dividido en QR, callback BCP, efectivo en caja y contra entrega; `checkout` dividido en normalización, sesión de mesa y creación del pedido) |
| D1 | Delivery independiente: solicitud de envío, clientes del courier, tarifas, liquidación, cobro contra entrega | Hecho (piloto en producción, S10) |
| R3 | Apps web: tienda, backoffice, panel de Delivery | Hecho por dentro: `app/(tienda)`, `app/(backoffice)`, `app/(delivery)` y lo común en `lib/` y `app/_shared/`, con límites en ESLint; falta separarlas en apps propias |
| R4 | Base SaaS: alta de negocios, planes por producto, suscripción, dominios | Pendiente |
| R5 | Live: subastas, venta en vivo, videos cortos | Pendiente |

Reglas vigentes: el simulador de QR se mantiene hasta el final; el QR real del BCP es el último paso;
Caja y Operaciones son solo de escritorio; todo cambio pasa por staging antes de producción.

## Estructura de la API (desde R2)
```
apps/api/src/
  core/       database, staff, operations, branch-operations
  commerce/   catalog, cart, order (checkout, tracking, lifecycle, ops-query, customer-recovery, stock)
  dine-in/    tables, reservations
  payments/
  delivery/   delivery-checkout, driver-delivery, delivery-ops, delivery-public-tracking,
              delivery-routing, delivery-helpers, monitor, dispatch-queue, geo
```

## Mapa para D1: qué usa Delivery del pedido
Comercio llama a Delivery solo por `DeliveryCheckoutService` (cotizar, preparar ruta, crear envío) y
`DeliveryPublicTrackingService` (ubicación y POD públicos).

Delivery lee de `public.orders` en 15 consultas (9 en `driver-delivery.service.ts`) y usa solo:
`id, tenant_id, branch_id, order_number, status, payment_status, order_type, tracking_token, total`.
Para Delivery independiente, esos datos pasan a la **solicitud de envío** (número, estado de cobro,
monto a cobrar, token de seguimiento) y `order_id` queda opcional.
