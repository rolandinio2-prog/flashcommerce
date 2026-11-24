# G8.1 — Repositorios de referencia en memoria

## Alcance implementado

Contratos ejecutables de configuración, cuota atómica y journal de eventos en cloud-contracts. Nuevo paquete @flashcommerce/cloud-persistence-memory con dependencia exclusiva de contracts. No hay archivos de base de datos, drivers, red, procesos persistentes ni almacenamiento durable.

El diseño original cloud-persistence-design-v1.md se conserva como antecedente. Esta implementación cubre G8.1; no habilita G8.2, G8.3 o G8.4.

## Composición

MemoryRepositoryStore recibe un catálogo de manifests con versión fijada, ModuleRegistryPort y una función de validación de eventos. En pruebas/composición se inyectan InMemoryModuleRegistry (G3) y parseCloudEvent (G6). El nuevo paquete no importa esas implementaciones ni duplica sus reglas.

El catálogo se firma al construir el store y un cambio posterior provoca rechazo. Para seleccionar otro catálogo/versionar su contenido se necesita una composición nueva; no se hace un cambio silencioso bajo la misma versión.

`store.repositories()` entrega facades de TenantConfigurationRepository, AtomicQuotaRepository y EventJournalRepository. Todas comparten un estado privado por tenant. Recrear facades sobre el mismo store conserva datos; construir otro store o reiniciar el proceso los pierde.

RepositoryConfigurationAdapter implementa EntitlementsPort y TenantModulesPort para usar la configuración con SDK/Core existentes. Ante tenant ausente deniega entitlements y devuelve cero módulos. No se cambió la composición de la demo HTML para almacenar datos ni se introdujo un coordinador que sustituya automáticamente G5/G6.

## Atomicidad y revisiones

Cada operación prepara un estado nuevo y el resultado antes de confirmar. No contiene await entre lectura, comprobación y sustitución del estado. La confirmación consiste en cambiar una única referencia privada del tenant.

El estado anterior no se modifica: mapas, registros y snapshots se copian antes de actualizar. Un beforeCommit opcional y síncrono sirve únicamente para inyectar fallos DEV; recibe el nombre de operación, no payloads o mapas. Si falla, se lanza STORAGE_UNAVAILABLE sanitizado sin confirmar. Si reentra y cambia el tenant, la operación exterior detecta conflicto en vez de sobrescribir datos nuevos.

Configuración usa creación con expectedRevision=null y actualización con número exacto. Las revisiones son enteros seguros positivos, se incrementan sin wraparound y los conflictos no se reintentan automáticamente.

## Configuración y cuotas

TenantConfiguration valida el tenant propio y el de entitlements, catálogo/versiones, módulos y sus dependencias, features únicas, límites enteros seguros y meters únicos que apuntan a límites existentes. Las features pueden deshabilitarse sin borrar la configuración del módulo.

consumeAtRevision revisa la misma configuración que comparte frontera atómica con el contador y recibo. Rechaza revisiones antiguas antes de mutar datos y usa los límites almacenados, ignorando un límite extra recibido del llamador. Meters fijan la feature: no se puede sustituirla por otra habilitada.

El recibo se identifica por tenant/idempotencyKey y contiene petición canónica, revisión de configuración original y decisión. Repetir con el mismo fingerprint devuelve el resultado histórico; otro amount/meter produce conflicto. Rechazos por cuota agotada guardan recibo sin incrementar uso. Rechazos previos por configuración/feature no crean recibo. Una feature deshabilitada bloquea también un replay anterior. getReceipt es diagnóstico interno, no una operación pública de acceso ni una autorización para repetir consumos.

No hay ventanas, purgas, reembolsos ni consumo implícito en lecturas. Configuración inexistente produce NOT_FOUND. Un límite cero deniega. Una reducción de límite no borra el uso anterior.

## Journal

reserve valida el evento usando G6, fija un plan de subscriberId/handlerVersion/ordinal y crea la fila exclusivamente por tenant/eventId. Con plan vacío se completa inmediatamente. Mismo evento completado devuelve duplicate; processing/failed/interrupted devuelve blocked sin reejecución; mismo ID con otro contenido produce conflicto.

transitionDelivery aplica CAS sobre la revisión del journal y respeta orden: pending→running→completed/failed. Actualiza delivered y estado final en la misma confirmación. No ejecuta funciones de handlers; solo registra decisiones del coordinador futuro. Un fallo conserva éxitos anteriores y bloquea pasos siguientes.

markInterrupted es una operación explícita para una composición administrativa que haya comprobado que el ejecutor anterior se detuvo. Incrementa revisión y bloquea confirmaciones tardías, incluso si el llamador conoce la revisión nueva. No recupera ni reintenta. El repositorio por sí solo no puede demostrar que se detuvo otro ejecutor.

No se promete atomicidad con efectos de negocio o entrega exactamente una vez. Un bus respaldado por journal y recuperación durable siguen pendientes; el bus G6 existente no fue reemplazado.

## Acceso y validación

Repositorios internos: G4 debe autorizar cualquier futura API antes de llamarlos. Se valida TenantContext y pertenencia en los agregados; IDs iguales en tenants distintos tienen namespaces separados. No hay listados globales. No se almacenan identidades WeakMap, credenciales, bolsas, objetos comerciales maestros o funciones de handlers.

Errores RepositoryError: INVALID_RECORD, REVISION_CONFLICT, IDEMPOTENCY_CONFLICT, STORAGE_UNAVAILABLE, OPERATION_INTERRUPTED y NOT_FOUND. La validación de tenant/contexto usa los CloudError existentes; el parser G6 conserva sus errores tipados para eventos de entrada.

Los registros se validan al construir/leer; los mapas privados no se exponen. Los puertos y las opciones inyectadas pertenecen a la composición confiable. Las fronteras de transporte JSON, almacenamiento real y sus límites de retención requieren su propio gate.

## Uso

```sh
pnpm build
pnpm typecheck
pnpm test:g8
pnpm demo:repositories
```

Las suites reutilizables de puertos están en tests/g8/port-contracts.mjs. La demo reconstruye facades sobre el mismo store y muestra cuota y evento sin duplicación; declara explícitamente que no sobrevive al reinicio del proceso.

Siguiente alcance: checkpoint G8.1, o diseño detallado de un adaptador DEV. Ninguna base de datos se conectará/creará sin identificar y autorizar el recurso específico.
