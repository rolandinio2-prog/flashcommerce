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
| R0 | Orden: archivo de parches, import de Cloud a `docs/cloud`, regla de nombres | En curso |
| R1 | Dividir `order.service.ts` (checkout, ciclo de vida, POS, stock) | Pendiente |
| R2 | API por áreas: núcleo, comercio, pagos, delivery, salón; `packages/domain` | Pendiente |
| D1 | Delivery independiente: solicitud de envío, clientes del courier, tarifas, liquidación | Pendiente |
| R3 | Apps web: tienda, backoffice, panel de Delivery | Pendiente |
| R4 | Base SaaS: alta de negocios, planes por producto, suscripción, dominios | Pendiente |
| R5 | Live: subastas, venta en vivo, videos cortos | Pendiente |

Reglas vigentes: el simulador de QR se mantiene hasta el final; el QR real del BCP es el último paso;
Caja y Operaciones son solo de escritorio; todo cambio pasa por staging antes de producción.
