# Material heredado de FlashCommerce Cloud

Importado el 2026-11-24 desde el repositorio `rolandinio2-prog/flashcommerce-cloud`
(commit `0443382`), que queda solo como archivo histórico.

| Carpeta | Contenido | Uso previsto |
|---|---|---|
| `contracts/` | Contratos TypeScript: subastas (`auction-*`), venta en vivo (`live-commerce`), acceso, planes y uso (`entitlement-usage`), registro de módulos, eventos | Referencia para R4 (planes por producto) y R5 (Live). **No es código compilado**: se reescribirá dentro de `apps/api` |
| `design/` | Documentos de arquitectura de Cloud (núcleo, acceso, entitlements, eventos, persistencia, MVP R0, demo Live) | Referencia de diseño |
| `visual-live/` | Conceptos visuales de venta en vivo (comprador y vendedor, móvil y escritorio) | Referencia para la etapa L2 |

Lo que **no** se importó: los experimentos `cloud-seller-drafts-cli`, la persistencia SQLite,
los reportes de Codex y las pruebas de esas piezas. Siguen disponibles en el repositorio archivado.
