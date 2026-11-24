# CommerceCloud — MVP-R0: alcance y diagnóstico

Estado: diagnóstico documental completado; integraciones reales pendientes de documentación y autorización. Fecha: 2026-11-05. Baseline Git: `4677d17e74ccc9d95830c4b5ccf954ccfb3b15ab`.

## Definición vigente del MVP

CommerceCloud gestiona la experiencia de live de un vendedor, selección y destacado de productos, interacción y subastas. Consume catálogo, precio, disponibilidad/reservas, pedidos, checkout/pagos y logística a través de adaptadores cuando existan servicios adecuados. No duplica esos servicios. La existencia, compatibilidad y acceso a servicios reales todavía no están verificados.

La reformulación acordada sustituye el alcance de producto de la demo simulada como objetivo futuro. Los documentos y pruebas anteriores permanecen como evidencias históricas, no como autorización de recursos. La demo sigue siendo un recurso útil para desarrollo.

Incluido: venta directa y subastas, identidad verificable, chat básico/moderación, actualización entre clientes, persistencia y recuperación, errores visibles, confirmación comercial mediante contratos externos. Identidad y video requieren proveedor/adaptador por definir. La interfaz de checkout y seguimiento puede pertenecer a FlashCommerce.

Fuera: multi-vendedor, gamificación, referidos, afiliados, comunidad social, recomendaciones, CRM avanzado, wallet, crédito, motor propio de pagos/logística y funcionalidades avanzadas de subastas. No se compromete el plazo histórico de 6–12 meses.

## Diagnóstico comprobado

| Área | Evidencia local | Decisión |
|---|---|---|
| Contracts/SDK/Core/Registry | `contracts/cloud-contracts`, `modules/cloud-sdk`, `modules/cloud-core`, `modules/cloud-module-registry` | Reutilizar; evolucionar contratos versionados sin imports del FlashCommerce original. |
| Identidad, acceso, límites | `modules/cloud-access`, `modules/cloud-entitlements` | Reutilizar políticas; reemplazar identidades mock en integración real. No afirmar autenticación real. |
| Catálogo y sesión | `contracts/cloud-contracts/src/index.ts`, `source-ports.ts`, `modules/cloud-adapters` | ProductCatalogPort/FlashLivePort son lectores; Product no tiene precio, stock ni variantes. reference-1.0 es sintético. |
| Eventos | `modules/cloud-events`, `contracts/cloud-contracts/src/event-bus.ts` | Reutilizar contratos y bus en memoria; definir transporte, orden, duplicados y recuperación. |
| Demo y persistencia | `apps/commerce-live-demo/src`, `server`, informe `commerce-live-native-dev-v1.json` | Reutilizar HTTP y SQLite DEV. Sesión persiste; bolsa/borradores UI son volátiles; actualización manual. |
| UX/UI | Informe `commerce-live-ux-ui-v1.json`, `docs/design/commerce-live-visual-concepts-v1` | 91 pruebas documentadas; nueva UI pendiente de revisión visual completa. Mockups no implementados como tales. Cambios aún sin commit. |
| Video/chat/subastas | No implementación de producto localizada en apps/contracts/modules revisados | Nuevos módulos y adaptadores; un estado `live` no transmite video. |
| Comercio externo | No especificación de API real identificada en documentación/contratos examinados | Solicitar documentación saneada; no inferir endpoints ni funciones por nombres comerciales. |
| Experimentos nativos | Familia de documentos cloud-seller-drafts-cli; cursor estricto bloqueado | Mantener aislados. No hacerlos requisito del MVP sin dependencia demostrada. |

Las búsquedas locales no prueban que un servicio no exista fuera del workspace. La verificación de hashes prueba integridad de evidencias, no una ejecución actual de tests ni funcionamiento de servicios externos.

## Frontera comercial

CommerceCloud conserva referencias externas y snapshots de presentación con versión/frescura; el sistema comercial conserva autoridad sobre precio, stock, pedido y pago. La UI nunca confirma una compra basándose solo en una respuesta del navegador.

Ganar una subasta, reservar un producto, crear un pedido y confirmar un pago son estados distintos. Debe poder existir ganador con integración comercial pendiente, sin inventar un pago exitoso. Las operaciones con efectos necesitan idempotencia y reconciliación; una respuesta perdida no autoriza repetir automáticamente.

Para video se diseñará un adaptador; no se selecciona WebRTC/SFU/proveedor en R0. Para almacenamiento se conserva SQLite de DEV, sin decidir aún la tecnología del piloto ni acreditar capacidad de carga.

## Criterios de aceptación del nuevo MVP

| ID | Criterio verificable | Dependencias |
|---|---|---|
| A01 | Identidad y tenant derivados de fuente verificable; cliente no puede adjudicarse permisos ni operar otra sesión. | I01 |
| A02 | Un vendedor prepara una sesión y un comprador independiente reproduce su transmisión; los fallos de video no se confunden con conexión de datos. | I08 |
| A03 | El vendedor selecciona productos autorizados y cambia el destacado; el comprador recibe la versión y recupera snapshot tras desconexión. | I02, I03, I09 |
| A04 | Chat identificado, moderación mínima y límites; mensajes inválidos/no autorizados rechazados. | I01, I09 |
| A05 | Compra directa produce un único pedido y confirmación verificable de pago en sandbox, incluyendo respuesta perdida o duplicada. | I03–I06 |
| A06 | Pujas validadas por servidor, cierre único persistente y rechazo determinista de pujas tardías/concurrentes; reinicio no duplica ganador. | I01, I03, I04, I09; D01–D05 |
| A07 | Ganador inicia recorrido comercial; reserva/pedido/pago pendientes o fallidos permanecen explícitos y recuperables. | I04–I06; D03–D05 |
| A08 | Vendedor y comprador completan recorridos en escritorio/móvil, con teclado y estados de carga/error sin pérdida de edición. | R2–R6 |
| A09 | Las operaciones comerciales muestran referencias y estado de entrega cuando estén disponibles; incidencias tienen destino y responsable. | I05–I07; D06 |
| A10 | Piloto tiene límites de concurrencia medidos, cierre/recuperación, auditoría sin secretos y procedimiento de respaldo comprobado en recursos autorizados. | D07, R7 |

Ningún criterio comercial puede aprobarse solo con mocks. Estos permiten avanzar contratos y UI mientras la integración se reporta pendiente.

## Secuencia de gates

- R0: este alcance, inventario, matriz de integraciones y decisiones abiertas.
- R1: contratos, invariantes y fakes; no conexiones externas. No fijar reglas comerciales pendientes como decisiones aprobadas.
- R2: recorridos UX/UI de live, chat, compra/subasta, ganador y errores con datos simulados.
- R3: persistencia y transporte DEV con revisión de recursos específica; secuencia, duplicados y recuperación.
- R4: video y chat mediante entorno autorizado; prueba independiente de vendedor y comprador.
- R5: venta directa con contratos confirmados y sandbox comercial.
- R6: integración completa de subastas y traspaso a pedido/pago. Dominio de subastas puede trabajarse antes con fakes.
- R7: aceptación integral del piloto; no implica autorización de producción.

## Decisiones pendientes

| ID | Decisión | Propuesta de trabajo, aún no aprobada | Bloquea |
|---|---|---|---|
| D01 | Cardinalidad de subastas y lotes | Una subasta activa por sesión; un producto/lote explícito. | Modelo definitivo de subasta |
| D02 | Moneda, precisión e incremento | Cantidades exactas, nunca floats monetarios; moneda confirmada por negocio. | Validación de pujas/precios |
| D03 | Momento y duración de reserva | Resolver con dueño del stock; expiración, liberación y falta de disponibilidad. | Compromiso comercial del ganador |
| D04 | Ganador que no paga | Plazo, cancelación, reoferta y responsable por acordar; no adjudicar automáticamente al siguiente. | Cierre comercial |
| D05 | Cancelación, empate y fallo de conexión | Orden autoritativo del servidor, auditoría y reglas explícitas; no decidir por reloj cliente. | Cierre determinista |
| D06 | Incidencias/devoluciones | Delegar a servicio/proceso comercial existente; definir enlace, estados y responsable. | Piloto comercial |
| D07 | Usuarios/carga/retención/video | Objetivos y datos permitidos por definir antes de elegir infraestructura. | Dimensionamiento y aceptación |
| D08 | Versionado de contratos | Mantener compatibilidad de lectores V1; nuevos puertos o versión explícita para cambios incompatibles. | R1 |

## Cierre de R0 y siguiente entrada

R0 se cierra cuando responsabilidades, evidencias locales, brechas, aceptación y decisiones están documentadas. Se admite cerrar el diagnóstico con dependencias desconocidas; no se declara integración lista.

Entrada documental prioritaria: OpenAPI/esquemas/eventos y ejemplos sintéticos de identidad, catálogo/precio, stock/reserva y pedidos/pagos; dueño técnico y disponibilidad de sandbox. No enviar claves, tokens ni información de clientes. Usar archivos entregados o fuentes específicamente autorizadas; no explorar otros servidores.

R1 puede comenzar con puertos/fakes e invariantes independientes. Las decisiones D01–D08 y contratos externos se resolverán antes de implementar comportamiento dependiente. Este gate no inicia R1 automáticamente.
