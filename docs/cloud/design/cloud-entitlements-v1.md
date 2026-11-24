# G5 — Entitlements y límites V1 (DEV)

## Objetivo

Evaluar funcionalidades habilitadas y consumir cuotas simuladas por tenant, sin facturación, inventario, bases de datos ni servicios externos. El consumo es una operación explícita: renderizar Commerce en Vivo o consultar catálogo no consume cuota automáticamente.

## Arquitectura

- `cloud-contracts`: añade UsageMeter, UsageRequest, UsageSnapshot, FeatureDecision, UsageConsumption, EntitlementConsumption, UsageCounterPort, MeteredEntitlementsPort y EntitlementError.
- `cloud-entitlements → cloud-contracts`: EntitlementsEvaluator y InMemoryUsageAdapter.
- `cloud-sdk → cloud-contracts`: añade CloudUsageClient, sin depender de la implementación del evaluador.
- La app compone las implementaciones; las lecturas existentes usan el evaluador como EntitlementsPort compatible.

Se mantienen los exports y contratos G2/G3/G4. No se añaden dependencias externas.

## Evaluación

Cada meter configura un limitKey y su feature correspondiente. La configuración es confiable y se copia al construir el evaluador. La petición no puede elegir otra funcionalidad habilitada para eludir la feature requerida por un límite.

EntitlementsEvaluator valida contexto, tenant de la respuesta, lista de features sin duplicados y límites enteros seguros no negativos. Ausencia de feature, meter o límite produce denegación tipada; un límite cero prohíbe consumo. No existen límites negativos o implícitamente ilimitados.

`consume` admite cantidad entera segura positiva y clave de idempotencia no vacía. Los inputs se copian antes de operaciones asíncronas. El límite enviado al contador proviene exclusivamente del proveedor. `getUsage` devuelve límite, usado y restante (nunca negativo); una reducción de límite conserva el uso acumulado y bloquea nuevo consumo si está agotado.

## Contador en memoria

Counters y registros de idempotencia usan Maps separados por tenant. Los contadores se distinguen por limitKey; las claves de idempotencia se distinguen por tenant y deben ser únicas entre operaciones de ese tenant.

La operación del adaptador no contiene await entre lectura, comprobación y escritura. Esto evita sobreconsumo entre llamadas concurrentes dentro de un proceso; no ofrece coordinación distribuida.

El fingerprint incluye feature, limitKey y amount. La misma clave con otro fingerprint genera IDEMPOTENCY_CONFLICT. Repetir exactamente una operación devuelve su resultado original con replayed=true, sin nuevo consumo. Se conservan tanto éxitos como rechazos por límite.

El límite no forma parte del fingerprint: un replay devuelve la decisión y snapshot históricos aun si el límite cambia. Para consultar el estado actual se utiliza getUsage. La configuración del meter, la feature habilitada y la existencia del límite se comprueban de nuevo antes del replay; deshabilitar la feature bloquea también un replay anterior. Una denegación previa al contador no se registra como operación de consumo.

Los registros duran lo mismo que la instancia; no hay TTL, ventanas periódicas, reinicio automático, reservas o reembolsos. Recrear el adaptador borra la simulación. El uso no representa ventas ni unidades de producto en la bolsa.

## Acceso

CloudUsageClient aplica `usage:consume` o `usage:read`, con limitKey como recurso, antes de invocar al evaluador. En la demo de límites, solo el vendedor tiene política explícita para consumir flashlive.sessions. El comprador se deniega. G4 comprueba identidad, tenant, caducidad y revocación.

El evaluador y el puerto de contadores son componentes internos confiables; no deben exponerse directamente como endpoints que acepten tenant o límite desde un navegador. Autorizar consumo no ejecuta una sesión comercial. No existe transacción entre consumo y una operación de negocio futura.

## Demostración

```sh
pnpm build
pnpm typecheck
pnpm test:g5
pnpm demo:limits
```

La demo usa límite 2: operación session-1 aceptada, replay de session-1 sin gasto extra, session-2 aceptada, session-3 denegada. Solo datos sintéticos y memoria del proceso. La demo HTML conserva su experiencia visual; no incorpora controles de cuotas ni facturación.

## Pendientes

Persistencia y coordinación multiproceso, ventanas de consumo, política de retención de idempotencia, integración transaccional y proveedor de entitlements real requieren alcance DEV separado. No se modificó producción. El siguiente gate propuesto es G6: esquemas runtime y eventos versionados con transporte en memoria. La revisión gráfica en navegador continúa pendiente.
