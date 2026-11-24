# G3 — Cloud Core y Module Registry V1

## Objetivo: Commerce en Vivo

Preparar los datos que consumirá una experiencia visual de comercio en vivo: sesión FlashLive y productos activos de su catálogo. Este gate entrega composición en memoria y una demostración JSON por consola. No incluye interfaz gráfica, transmisión multimedia, pagos ni pedidos.

## Arquitectura

- `@flashcommerce/cloud-contracts`: conserva exports G2 y añade ModuleRegistryPort, TenantModulesPort, ModuleRegistryError, LiveCommerceReaderPort y LiveCommerceView.
- `@flashcommerce/cloud-module-registry`: valida manifests desconocidos, registra snapshots y resuelve capacidades.
- `@flashcommerce/cloud-core`: obtiene módulos habilitados por tenant y compone una vista de sesión/productos mediante puertos inyectados.
- `@flashcommerce/cloud-sdk`: sigue aplicando autorización y entitlements; satisface estructuralmente LiveCommerceReaderPort sin depender del núcleo.

Los tres paquetes de implementación dependen exclusivamente de contracts. Core no importa el registro concreto ni el SDK. Las pruebas componen las implementaciones. Sin nuevas dependencias externas.

## Reglas V1

1. `requires` contiene nombres de capacidades, no IDs de módulos ni rangos de versiones.
2. `contractVersion` debe ser exactamente `1.0`. La versión del módulo debe tener tres números sin ceros iniciales; rangos, prereleases y metadatos quedan pendientes.
3. Los IDs/capacidades usan minúsculas y separadores `.`, `:` o `-`.
4. Solo una versión por moduleId. Un registro duplicado se rechaza sin reemplazar el existente.
5. El registro permite cargar módulos antes de sus proveedores. La validación de dependencias ocurre al resolver el conjunto seleccionado.
6. Solo los módulos habilitados para el tenant participan en resolución. No se habilitan proveedores implícitamente.
7. Capacidades con varios proveedores, proveedores ausentes, ciclos y autorreferencias se rechazan con errores tipados. Resultado ordenado de forma determinista, proveedores primero.
8. Tenant sin configuración obtiene cero módulos. Esta configuración es un fixture DEV, no una política productiva.
9. Commerce en Vivo requiere `flashlive:read` y `catalog:read`. El lector inyectado debe verificar autorización/entitlements; la demo utiliza CloudClient.
10. La vista verifica tenant e identificadores de respuestas, consulta cada producto una vez y muestra únicamente productos activos. Un error al consultar la sesión o cualquier producto hace fallar la vista completa.
11. Los snapshots son copias defensivas. El contexto y la identidad deben proceder de fuentes confiables.

## Uso y validación

Desde `/srv/flashcommerce-cloud`, con Node 24 y pnpm 11.21.0:

```sh
pnpm build
pnpm typecheck
pnpm test:g3
pnpm check:imports
pnpm demo:live
```

`pnpm test` incluye build, tipos, suites G2/G3 y revisión de imports. La instalación offline realizada para G3 actualizó únicamente los enlaces/lockfile del workspace; no descargó paquetes. Los directorios XDG utilizados permanecen dentro de `.pnpm-local/`.

## Siguiente experiencia visual

Una futura aplicación podrá consumir LiveCommerceView para mostrar el título/estado de la sesión y tarjetas de productos. La selección entre comprador, vendedor o ambas experiencias queda pendiente de preferencia del usuario. Los contratos actuales no contienen URL de streaming, imágenes, precios ni acciones de compra; se definirán en un alcance posterior, con fixtures y sin conexión a producción.

G4 seguirá centrado en contexto confiable, identidad y políticas de acceso. Una interfaz de demostración puede plantearse como gate independiente con recursos sintéticos. Persistencia, proveedores reales y servicios requieren autorización separada.
