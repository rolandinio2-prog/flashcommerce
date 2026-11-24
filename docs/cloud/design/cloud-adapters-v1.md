# G7 — Adaptadores DEV de catálogo y FlashLive

## Objetivo y límites

Proporcionar adaptadores de referencia que transformen payloads externos decodificados en ProductCatalogPort y FlashLivePort, usando exclusivamente fixtures. El esquema reference-1.0 es sintético: no describe las APIs reales de FlashCommerce, FlashLive o proveedores comerciales. No se consultaron esos sistemas.

## Arquitectura

`cloud-adapters → cloud-contracts`

Nuevos CatalogSourcePort y LiveSessionSourcePort devuelven unknown/null: los payloads se consideran no confiables; null indica ausencia. ReferenceProductCatalogAdapter y ReferenceFlashLiveAdapter implementan los puertos públicos existentes. FixtureCatalogSource y FixtureFlashLiveSource implementan las fuentes locales.

La aplicación compone los adaptadores, SDK, Core, acceso y entitlements. Ninguna librería importa la aplicación ni módulos del FlashCommerce original. No hay nuevas dependencias externas.

## Esquema de referencia

Producto: schemaVersion=1.0, tenantKey, externalId, label y lifecycle. lifecycle enabled → active, disabled → inactive.

Sesión: schemaVersion=1.0, tenantKey, externalId, label, state y products (lista de externalProductId). state planned → scheduled, broadcasting → live, closed → ended. Se conserva orden y duplicados de referencias; Cloud Core ya deduplica la consulta de productos al componer la vista.

Los parsers requieren campos exactos, identificadores no vacíos sin espacios extremos, estados conocidos y versión string exacta. Campos adicionales se rechazan en vez de propagarse. Las salidas contienen solo los campos públicos declarados; no se incorporan precios, inventario, pagos o lógica de entrega.

## Fronteras y errores

Cada adapter captura contexto antes de await, valida el identificador solicitado y consulta la fuente una sola vez. Después valida payload, tenant e identificador de respuesta.

- Contexto/ID inválido: CloudError INVALID_ARGUMENT antes de llamar a la fuente.
- Fuente devuelve null: CloudError NOT_FOUND.
- Tenant incorrecto: CloudError TENANT_MISMATCH.
- Payload o ID de respuesta inválido: AdapterError INVALID_SOURCE_PAYLOAD.
- Versión incompatible: AdapterError UNSUPPORTED_SOURCE_VERSION.
- Excepción de fuente: AdapterError SOURCE_UNAVAILABLE sin exponer mensaje original/payload.
- Fixture duplicado por tenant/ID: AdapterError DUPLICATE_FIXTURE.

Sin reintentos. Las fuentes de fixtures usan Maps por tenant e identificador, copian entradas/salidas y aceptan el mismo ID en tenants diferentes. Los adapters no autentican por sí mismos: acceso G4 y entitlements G5 siguen aplicándose en SDK.

## Compatibilidad y pruebas

`tests/g7/port-contracts.mjs` exporta suites reutilizables de ProductCatalogPort y FlashLivePort. Se ejecutan contra los mocks G2 y los adaptadores G7 con el mismo dataset observable: formato público, namespace tenant, ausencias, copias y contexto inválido.

Pruebas adicionales cubren mapeos/estados, versiones, respuestas corruptas, excepciones, duplicados de fixtures, contexto capturado, autorización, features, eventos G6 y proyección de Commerce en Vivo. Consultar fuentes no consume cuotas implícitamente.

## Demostración

```sh
pnpm build
pnpm typecheck
pnpm test:g7
pnpm demo:adapters
```

El HTML local se regenera con los nuevos adaptadores. Su modelo convierte exclusivamente sus fixtures sintéticos al esquema reference-1.0; se mantienen las interacciones de comprador/vendedor y no se inicia un servidor. La demo de consola compone una sesión con un producto activo.

## Pendientes

Un adaptador real requiere conocer una API DEV autorizada, su esquema y autenticación, y definir errores/timeouts sin tocar producción. Este gate no implementa HTTP, escritura, credenciales ni acceso a servicios reales. Los fixtures no persisten entre reinicios. El parser recibe objetos JSON decodificados, no objetos arbitrarios con getters. La revisión gráfica en navegador sigue pendiente.

G8 propuesto: diseño de persistencia exclusivamente DEV y contratos de repositorio. Cualquier base de datos o servicio requiere identificar y autorizar recursos específicos antes de conectarlos. No iniciado.
