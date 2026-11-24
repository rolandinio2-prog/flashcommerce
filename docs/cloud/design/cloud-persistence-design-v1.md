# G8 — Diseño de persistencia DEV y contratos de repositorio V1

Estado: DISEÑO LISTO PARA REVISIÓN. No implementa persistencia ni contratos ejecutables. Los tipos de este documento son propuestas, no exports existentes.

Baseline analizado: cb14e426be90657ac67990350b7204302f4d9d5e (checkpoint G7). Entorno: flashcommerce-cloud-dev, clouddev, /srv/flashcommerce-cloud, main.

## 1. Objetivo

Permitir que el estado propio de FlashCommerce Cloud sobreviva a la recreación de sus componentes en un entorno DEV autorizado. Definir primero semántica verificable con repositorios en memoria; seleccionar un motor o conectar almacenamiento será otra autorización.

Esta fase no instala dependencias, elige un motor, crea archivos de base de datos, abre puertos, ejecuta migraciones, inicia servicios ni altera código de G2–G7. Producción permanece excluida sin excepciones.

## 2. Estado actual y decisiones

| Componente | Estado actual | Decisión de diseño |
| --- | --- | --- |
| Módulos y manifests | Registro en memoria | Manifests versionados siguen siendo configuración de código; guardar solo selección por tenant |
| Entitlements | Provider mock; límites descriptivos/evaluados | Guardar configuración versionada de features, límites y vínculo meter-feature |
| Cuotas G5 | Maps de contadores y replays | Contador y recibo idempotente deben confirmarse en una única operación atómica |
| Eventos G6 | Ledger volátil y handlers locales | Persistir evento canónico, plan de entrega y resultados; nunca funciones de handlers |
| Acceso G4 | Sesiones mock e identidades emitidas en WeakMap | No serializar identidades emitidas, roles recibidos del navegador ni referencias como credenciales reales |
| Catálogo/FlashLive G7 | Fuentes fixture read-only | Mantener puertos de origen; no crear otro servicio comercial maestro |
| Demo visual | Borrador y bolsa en memoria | Un borrador de vendedor podrá guardarse por propietario; bolsa excluida inicialmente |

La configuración de módulos y entitlements se propone como un solo agregado por tenant: evita persistir un módulo habilitado con una configuración de features/meters incompatible. La validación usará los manifests y reglas existentes y una versión de catálogo de manifests fijada por la composición DEV.

## 3. Dependencias propuestas

```text
cloud-contracts                 interfaces públicas actuales y repositorios nuevos
       ↑
cloud-persistence-memory       implementaciones de referencia, solo contratos
       ↑
composición DEV                SDK / Core / acceso / entitlements / eventos
```

Un futuro paquete cloud-persistence-<motor> implementará los mismos puertos. Ningún driver ni conexión se incorporará a contracts, SDK o Core. El nombre del paquete futuro y el motor quedan sin seleccionar.

Los consumidores dependen de interfaces. Cada operación de negocio se implementa mediante un método de repositorio con semántica propia; no se propone un CRUD genérico ni un save parcial para contadores.

## 4. Datos, claves y propiedad

| Agregado | Clave lógica | Propiedad y restricción |
| --- | --- | --- |
| TenantConfiguration | tenantId | Configuración Cloud, revisión positiva, módulos/features/meters consistentes |
| UsageCounter | tenantId + limitKey | Uso acumulado entero seguro no negativo |
| UsageReceipt | tenantId + idempotencyKey | Un fingerprint y resultado histórico por operación; incluye la revisión de configuración usada |
| EventJournal | tenantId + eventId | Envelope canónico, fingerprint, estado y revisión |
| EventDelivery | tenantId + eventId + subscriberId | Orden del plan y estado de entrega; referencia al journal del mismo tenant |
| SellerDraft (segunda etapa) | tenantId + ownerSubjectId + draftId | Título, referencias de productos y destacado; no estado comercial live ni contenido de video |

Los IDs iguales en tenants distintos son válidos. Toda clave única, lectura, modificación y relación incluye tenantId. ownerSubjectId y permisos provienen de identidad verificada, no de campos libres del visitante.

Los tenants no habilitados no reciben configuración por defecto. Ausencia devuelve null o una denegación explícita, según el puerto; no concede features, cuotas ilimitadas o acceso.

Fuera del modelo inicial: precios, inventario, pagos, pedidos, entregas, credenciales, video, datos de clientes reales y copia autoritativa del catálogo. No se guardará la bolsa bajo una clave compartida por tenant: necesitaría un diseño propio de propietario/identidad.

## 5. Reglas transversales

- Validar y copiar inputs antes de await, y devolver snapshots separados del almacenamiento.
- Revision es un entero seguro positivo. Crear usa expectedRevision=null; actualizar exige revisión exacta existente y genera la siguiente.
- Un conflicto o desbordamiento de revisión se rechaza sin modificar estado. No hay last-write-wins implícito ni reintentos automáticos.
- Los repositorios no autentican visitantes. G4 y una composición confiable autorizan antes de invocarlos; los repositorios también verifican el ámbito tenant.
- Una fila de otro tenant no se descubre por búsquedas globales de ID.
- Listados futuros requieren cursor y límite de resultados; no se propone un listAll de todos los tenants.
- Errores nuevos propuestos: REVISION_CONFLICT, IDEMPOTENCY_CONFLICT, INVALID_RECORD, STORAGE_UNAVAILABLE y OPERATION_INTERRUPTED. Se mantendrán mensajes sin payloads, conexión o excepciones internas.
- Datos de almacenamiento leídos deben validarse; un registro corrupto no se reconstruye con permisos o valores por defecto.

## 6. Contratos propuestos: configuración y cuota

Estos nombres y firmas se revisarán en G8.1 antes de añadirlos a cloud-contracts. TenantContext, Entitlements, UsageMeter, UsageRequest, UsageConsumption y EntitlementConsumption ya existen.

```ts
interface Versioned<T> {
  readonly revision: number;
  readonly value: T;
}

interface TenantConfiguration {
  readonly tenantId: string;
  readonly manifestCatalogVersion: string;
  readonly enabledModuleIds: readonly string[];
  readonly entitlements: Entitlements;
  readonly meters: readonly UsageMeter[];
}

interface TenantConfigurationRepository {
  get(context: TenantContext): Promise<Versioned<TenantConfiguration> | null>;
  put(
    context: TenantContext,
    command: {
      readonly expectedRevision: number | null;
      readonly value: TenantConfiguration;
    },
  ): Promise<Versioned<TenantConfiguration>>;
}

interface UsageReceipt {
  readonly tenantId: string;
  readonly request: UsageRequest;
  readonly configurationRevision: number;
  readonly result: UsageConsumption;
}

interface AtomicQuotaRepository {
  getReceipt(context: TenantContext, idempotencyKey: string):
    Promise<UsageReceipt | null>;
  getUsed(context: TenantContext, limitKey: string): Promise<number>;
  consumeAtRevision(
    context: TenantContext,
    command: UsageRequest & {
      readonly expectedConfigurationRevision: number;
    },
  ): Promise<EntitlementConsumption>;
}
```

TenantConfigurationRepository y AtomicQuotaRepository compartirán la misma frontera transaccional y la revisión autoritativa de configuración. En memoria deberán usar un contenedor de estado compartido; con almacenamiento real no bastan dos repositorios independientes.

TenantConfiguration.tenantId y entitlements.tenantId deben coincidir con context. Los meters son únicos por limitKey, referencian límites definidos y fijan su feature. Los módulos se validan/resuelven contra el catálogo de manifests confiable de la versión indicada. Una configuración no puede apuntar a un catálogo desconocido. Se permite guardar un límite cero o deshabilitar una feature: habilitación de módulo y concesión de acceso siguen siendo decisiones distintas.

No se añadirá AtomicQuotaRepository directamente al SDK como endpoint. Un coordinador futuro lee la configuración versionada y lo invoca usando esa revisión; el repositorio vuelve a validar la revisión y configuración almacenadas en la operación atómica. El visitante no aporta ni altera límites.

### Operación atómica de cuota

1. Leer/bloquear la configuración del tenant y comprobar expectedConfigurationRevision.
2. Comprobar vínculo meter-feature, feature habilitada y límite definido según esa misma configuración.
3. Consultar el recibo por tenant/idempotencyKey. Si existe, comparar fingerprint canónico de feature/limitKey/amount.
4. Si coincide, devolver el resultado original como replay, sin incremento; si difiere, rechazar conflicto.
5. Leer/crear contador del mismo tenant/limitKey y decidir por resta segura si admite amount.
6. Guardar resultado (incluido rechazo por cuota agotada) y, si se permite, incremento, en una única confirmación.

Un error al confirmar no puede dejar incremento sin recibo ni recibo sin incremento. El adaptador persistentemente respaldado deberá resolver qué ocurrió tras un resultado de confirmación incierto mediante getReceipt autorizado y diagnóstico del estado de la transacción, no mediante una repetición automática a ciegas. Un null por sí solo no demuestra que una confirmación todavía en curso no vaya a completarse y no autoriza a repetir el consumo.

Se preserva la semántica G5: denegaciones previas por configuración/feature no se almacenan como consumo; el replay conserva la decisión y el snapshot originales; deshabilitar la feature impide acceder a un replay previo. La revisión se contrasta con la configuración actual, pero no se incluye en el fingerprint de la operación. getUsed permite consultar uso actual.

El uso inicial seguirá siendo acumulado sin ventanas ni reinicio automático. Borrar recibos permitiría consumir de nuevo una operación antigua: no habrá purga/TTL hasta definir y autorizar la política de retención. Repositorios en memoria no proporcionarán durabilidad al reiniciar.

### Compatibilidad con G5

UsageCounterPort.consume recibe actualmente un límite calculado antes de llamar al adaptador. Sustituir su Map por almacenamiento durable no basta para garantizar consistencia si otra operación cambia la configuración.

La propuesta es añadir los nuevos contratos y un coordinador compatible con MeteredEntitlementsPort, manteniendo intactos los exports y la implementación G5 hasta validar la nueva semántica. El coordinador utilizará la operación atómica con revisión; no se simulará atomicidad repartiendo pasos entre repositorios independientes.

## 7. Contratos propuestos: journal de eventos

```ts
type JournalState = 'processing' | 'completed' | 'failed' | 'interrupted';
type DeliveryState = 'pending' | 'running' | 'completed' | 'failed';

interface DeliveryPlanItem {
  readonly subscriberId: string;
  readonly handlerVersion: string;
  readonly ordinal: number;
}

interface EventJournalSnapshot {
  readonly event: CloudEventV1;
  readonly state: JournalState;
  readonly plan: readonly DeliveryPlanItem[];
  readonly deliveries: readonly {
    readonly subscriberId: string;
    readonly state: DeliveryState;
  }[];
  readonly delivered: number;
}

type EventClaim =
  | { readonly outcome: 'new'; readonly snapshot: Versioned<EventJournalSnapshot> }
  | { readonly outcome: 'duplicate'; readonly snapshot: Versioned<EventJournalSnapshot> }
  | { readonly outcome: 'blocked'; readonly snapshot: Versioned<EventJournalSnapshot> };

interface EventJournalRepository {
  get(context: TenantContext, eventId: string):
    Promise<Versioned<EventJournalSnapshot> | null>;
  reserve(
    context: TenantContext,
    command: {
      readonly event: CloudEventV1;
      readonly plan: readonly DeliveryPlanItem[];
    },
  ): Promise<EventClaim>;
  transitionDelivery(
    context: TenantContext,
    command: {
      readonly eventId: string;
      readonly expectedRevision: number;
      readonly subscriberId: string;
      readonly next: 'running' | 'completed' | 'failed';
    },
  ): Promise<Versioned<EventJournalSnapshot>>;
  markInterrupted(
    context: TenantContext,
    command: { readonly eventId: string; readonly expectedRevision: number },
  ): Promise<Versioned<EventJournalSnapshot>>;
}
```

reserve valida de nuevo el evento con reglas G6 y calcula el fingerprint canónico de todos sus campos. La ausencia se crea de forma exclusiva por tenant/eventId; el mismo ID con otro evento lanza conflicto. Un ID completado devuelve duplicate con su resultado original. processing, failed e interrupted devuelven blocked sin ejecutar handlers. Repetir reserve con el mismo evento no cambia el plan original.

Un plan vacío se guarda completed con cero entregas y outcome=new en la primera reserva; una reserva posterior devuelve duplicate. Se conserva la semántica G6 de no entregar historia a suscriptores nuevos.

transitionDelivery exige revisión exacta, estado processing del journal y orden del plan: solo pending→running, running→completed o running→failed. Mantiene delivered y estado del journal en la misma operación; la última entrega completada cierra el evento. Un fallo marca el journal failed y deja los siguientes pendientes sin ejecutarlos. Los IDs del plan son únicos y los ordinales forman la secuencia 0..n-1 sin duplicados; handlerVersion se resuelve desde configuración confiable, no contiene código ni funciones serializadas.

markInterrupted es una operación administrativa explícita, autorizada y condicionada a confirmar que el ejecutor anterior ya no continúa. Solo cambia processing→interrupted, incrementa revisión y bloquea confirmaciones tardías. No genera otro ejecutor ni reintenta handlers. Un crash no demuestra que el handler no produjo efectos: nunca se volverá a entregar automáticamente por vencimiento de una espera.

Compatibilidad G6: el bus futuro traduce estados bloqueados a los errores públicos apropiados; interrupted se presenta como fallo de entrega sin reintento (HANDLER_FAILED) y se conserva el detalle solo en diagnóstico interno. No se cambia EventPublication ni se promete exactamente una vez.

La reserva y el journal no son una transacción con un servicio comercial. Outbox, efectos de negocio idempotentes, recuperación manual y coordinación distribuida necesitarán diseño y autorización adicionales.

## 8. Borrador de vendedor, segunda etapa

No es parte del mínimo inicial de repositorios. Su contrato propuesto separará TenantContext y ownerSubjectId verificado, draftId, expectedRevision y un valor que contenga título, selectedProductIds y featuredProductId.

El borrador no almacenará objetos completos de productos ni declarará que la sesión comercial está en vivo. Al cargar se comprobarán de nuevo permisos, catálogo y disponibilidad. No se incluirán contraseña, roles arbitrarios, bolsa de otro usuario ni URLs de media privadas. La primera implementación podrá seguir usando memoria, con prueba de recreación del servicio sobre el mismo repositorio; eso no equivale a persistencia tras reinicio del proceso.

## 9. Fases de implementación propuestas

| Fase | Trabajo | Autorización necesaria |
| --- | --- | --- |
| G8.1 | Contratos ejecutables, repositorios en memoria y suites contractuales; composición opcional sin alterar puertos anteriores | Nueva autorización de implementación; sin DB |
| G8.2 | Elegir motor/driver y adaptador DEV, definir esquemas y procedimiento de migración/recuperación | Identificar recurso DEV y autorizar conexión/archivos/operaciones específicos antes de ejecutarlos |
| G8.3 | Probar durabilidad, concurrencia entre procesos, confirmación incierta y recuperación controlada | Solo recursos DEV ya autorizados; sin migraciones destructivas ni retry automático |
| G8.4 | Guardado/carga de borradores de demo y validación integral | Alcance específico de UI/identidad; sin producción |

No hay fase de despliegue en esta propuesta. No se instalará ningún motor del sistema operativo ni se recurrirá a Docker. Una futura configuración DEV debe fallar si el recurso no coincide con el destino autorizado; NODE_ENV por sí solo no será la protección.

## 10. Matriz de aceptación propuesta

| Área | Casos obligatorios |
| --- | --- |
| Aislamiento | Mismos IDs en dos tenants; lecturas/escrituras y relaciones cruzadas rechazadas |
| Revisiones | Dos escritores con la misma revisión: solo uno confirma; creación duplicada rechazada |
| Configuración | Catálogo de manifests desconocido, módulos incompatibles y meters inválidos rechazados |
| Cuotas | Límite cero/ausente, agotamiento, enteros seguros, competencia por última unidad |
| Cuotas + configuración | Cambio de revisión durante consumo no usa un límite antiguo ni muta contador/recibo |
| Idempotencia | Mismo fingerprint no duplica; conflicto no muta; snapshots históricos conservados |
| Atomicidad | Fallo simulado antes de confirmar no deja escrituras parciales; resultado incierto exige diagnóstico |
| Eventos | Duplicados/conflictos, fallo parcial, proceso interrumpido y confirmación tardía; cero reintentos automáticos |
| Rehidratación | Recrear el servicio con el mismo repositorio conserva semántica, sin confundirlo con durabilidad de proceso |
| Compatibilidad | Suites G2–G7 y demo actuales siguen pasando; adaptadores de repositorio comparten contrato |

Para cerrar G8.1 se requerirán build/tipos, resultados por suite, revisión de dependencias, secretos y diferencias. La prueba de durabilidad real solo pertenece a una fase con almacenamiento explícitamente autorizado.

## 11. Decisiones pendientes

Motor y ubicación DEV, límites de retención, operador autorizado para recuperación, catálogo de manifests y su versión, ownership de borradores y política de autorización de configuración. Ninguna requiere una decisión ahora para revisar o implementar contratos/mocks G8.1; sí deberán resolverse antes de almacenamiento real.
