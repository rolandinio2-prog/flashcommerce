# G8.2 — Requisitos y opciones de almacenamiento DEV

Estado: DISEÑO, SIN MOTOR SELECCIONADO NI AUTORIZACIÓN DE CONEXIÓN.

Baseline: 0b40a57b9c49bc30867c14993a00ba461f6cd3d6, checkpoint G8.1. Entorno verificado: flashcommerce-cloud-dev, clouddev, /srv/flashcommerce-cloud. No se creó ni abrió una base de datos.

## 1. Recomendación condicionada

Proponer SQLite para el primer experimento durable de un solo host DEV. Es una decisión de diseño para este alcance pequeño, no una elección para producción ni una aprobación para crear el archivo. PostgreSQL sigue siendo alternativa si se define una carga concurrente o un recurso servidor DEV dedicado.

SQLite admite varios lectores pero solo un escritor simultáneo; BEGIN IMMEDIATE puede fallar por contención. Esto encaja con una prueba local de transacciones cortas y errores explícitos, no con una promesa de escritura concurrente ilimitada. [Documentación oficial de aislamiento](https://www.sqlite.org/isolation.html), [control de transacciones](https://www.sqlite.org/lang_transaction.html).

PostgreSQL usa arquitectura cliente/servidor y admite conexiones concurrentes; requiere un recurso servidor explícito. Sus bloqueos de filas pueden apoyar las operaciones por tenant. No hay servidor identificado ni permiso para usar uno. [Arquitectura oficial](https://www.postgresql.org/docs/current/tutorial-arch.html), [bloqueos](https://www.postgresql.org/docs/current/explicit-locking.html).

## 2. Comparación para este proyecto

| Opción | Ajuste a G8.1 | Operación necesaria | Decisión propuesta |
| --- | --- | --- | --- |
| Memoria actual | Semántica ya verificada; no conserva estado tras reinicio | Ninguna infraestructura adicional | Mantener como referencia de contratos |
| SQLite local | Transacciones para configuración/cuota/recibo/journal; escritura serializada | Autorizar archivo y directorio DEV concretos, driver y bootstrap inicial | Primera opción experimental recomendada |
| PostgreSQL DEV dedicado | Adecuado si se necesita probar varias conexiones/escritores con bloqueos por fila | Identificar host, base, esquema, rol y permisos; driver y conexión autorizados | Alternativa, sin conexión en este gate |
| Archivos JSON simples | Exigirían diseñar bloqueo, recuperación y confirmación conjunta de varios registros | Implementar un protocolo de almacenamiento propio | No proponer como reemplazo de repositorios transaccionales |

Las decisiones de ajuste/coste operativo son inferencias para el contexto de este repositorio, no resultados de benchmarks o pruebas de almacenamiento. No se compararon precios ni servicios alojados.

## 3. Driver y compatibilidad Node

Comprobación local sin abrir conexiones: Node v24.22.1, process.versions.sqlite=3.53.4 e isBuiltin('node:sqlite')=true. No se importó el módulo de SQLite ni se instanció una conexión, ni siquiera :memory:.

Driver candidato: node:sqlite, para evitar añadir un driver externo antes de necesitarlo. La documentación oficial de la rama v24.x muestra DatabaseSync y clasifica el módulo como release candidate; sus operaciones son síncronas. Esto exige verificar las APIs exactas de la versión instalada y aceptar esa estabilidad para DEV antes de implementar. No se afirma que esté declarado estable ni se trasladan las APIs de Node 26 a Node 24. [Fuente oficial rama v24.x](https://github.com/nodejs/node/blob/v24.x/doc/api/sqlite.md).

La URL renderizada latest-v24.x no fue accesible durante la consulta; se utilizó la fuente oficial de la rama v24.x, sin repetir la apertura fallida. El primer spike autorizado deberá comprobar exportaciones/opciones del runtime concreto sin cambiar la versión de Node ni instalar herramientas del sistema.

Si el driver no cumple la semántica requerida, se detendrá la implementación y se documentará la discrepancia. No habrá actualización de Node ni sustitución automática de driver.

## 4. Recurso SQLite propuesto, todavía inexistente

| Elemento | Ruta/valor propuesto |
| --- | --- |
| Host / usuario | flashcommerce-cloud-dev / clouddev |
| Workspace | /srv/flashcommerce-cloud |
| Directorio de datos | /srv/flashcommerce-cloud/.cloud-dev-data/g8-2/ |
| Archivo principal | /srv/flashcommerce-cloud/.cloud-dev-data/g8-2/flashcommerce-dev.sqlite |
| Journal auxiliar permitido inicialmente | mismo archivo con sufijo -journal, dentro del mismo directorio |
| Datos de prueba | /srv/flashcommerce-cloud/.cloud-dev-data/g8-2/tests/ |
| Copias de prueba | /srv/flashcommerce-cloud/.cloud-dev-data/g8-2/backups/ |
| storageId | flashcommerce-cloud-dev-g8-2 |
| Entorno / esquema inicial | DEV / 1 |

No se crearon estas rutas ni archivos y no se consultó su contenido. No se modificó .gitignore. Antes de implementar, habrá que excluir .cloud-dev-data/ y verificarlo ANTES de crear cualquier dato; el diseño de esa exclusión no implica permiso para crear la base.

La autorización futura debe cubrir el archivo principal, auxiliares y subdirectorios de pruebas/copias expresos. No habilita otra ruta, una URI de SQLite arbitraria, ATTACH, carga de extensiones, un servidor de red, archivos en /tmp o acceso a una base existente de otro proyecto.

La aplicación debe resolver rutas canónicas, rechazar enlaces simbólicos en el destino/ancestros y exigir el workspace autorizado. La creación inicial necesita una opción explícita; abrir no debe crear silenciosamente un archivo en una ruta mal escrita. Si el recurso ya existe y no tiene identidad/schema esperados, detenerse sin migrarlo ni sobrescribirlo.

## 5. Esquema lógico propuesto

DDL por redactar y revisar antes de ejecutar. Esta tabla no crea tablas ni altera contratos públicos.

| Tabla | Clave / campos principales | Restricciones relevantes |
| --- | --- | --- |
| storage_metadata | singleton; storageId, environment, workspace, schema_version | Identidad DEV exacta; versión desconocida bloquea apertura de repositorios |
| tenant_configuration | tenant_id PK; revision, configuration_json, manifest_catalog_version | Revisión positiva segura; value/entitlements.tenantId deben coincidir con clave y contexto |
| usage_counter | PK(tenant_id, limit_key); used | Entero 0..Number.MAX_SAFE_INTEGER; FK de tenant a configuración |
| usage_receipt | PK(tenant_id, idempotency_key); request_json, fingerprint, original_configuration_revision, result_json | Recibo inmutable, mismo tenant; FK solo al tenant actual, no a la revisión actual |
| event_journal | PK(tenant_id, event_id); revision, fingerprint, envelope_json, state, delivered | Envelope G6 validado; CAS y estados conocidos |
| event_delivery | PK(tenant_id, event_id, subscriber_id); handler_version, ordinal, state | FK compuesta al journal, ordinal único por evento y secuencia validada |

Las claves compuestas y constraints son parte del diseño de aislamiento; además se validarán los registros al leer. [Referencia oficial de constraints SQL en PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html).

Dos compatibilidades importantes con G8.1:

1. EventJournalRepository puede reservar eventos antes de que exista TenantConfiguration. Por tanto NO se añadirá una FK event_journal→tenant_configuration que cambie ese comportamiento; sigue siendo un puerto interno con autorización anterior.
2. Un UsageReceipt conserva una revisión histórica aunque se actualice la configuración. NO se añadirá una FK desde original_configuration_revision a la única fila/revisión actual. La pertenencia del tenant y los rangos se comprueban por separado.

No hay tablas de credenciales, catálogo comercial maestro, inventario, pagos, pedidos, sesiones de streaming o bolsa de compradores. Los manifests y funciones de handlers no se serializan como código.

Los documentos se guardarán en representación JSON canónica de versión conocida; los tipos numéricos se comprobarán antes de convertirlos a number. No se dependerá de que el motor convierta cadenas o valores fuera del rango seguro. SQL parametrizado para valores y nombres de esquema fijos de la aplicación, sin SQL suministrado por visitantes.

## 6. Protocolo transaccional

### SQLite experimental

Propuesta inicial: rollback journal (DELETE) y synchronous=FULL, con un archivo local y transacciones breves. Confirmar valores efectivos al abrir, sin asumir defaults. WAL queda para otra evaluación si es necesario; crea archivos -wal/-shm y depende de almacenamiento del mismo host, por lo que ampliaría el footprint autorizado. [Modo journal y limitaciones WAL](https://www.sqlite.org/wal.html).

Usar BEGIN IMMEDIATE para las operaciones de escritura, sin awaits de red ni ejecución de handlers dentro de la transacción. La captura de contexto y validación de estructura se realizan antes; la revisión autoritativa se comprueba dentro. busy_timeout=0 como propuesta de fallo explícito por contención; no instalar un busy-handler de reintento.

Ante error: no repetir BEGIN, COMMIT o el comando de negocio automáticamente. Ejecutar el cierre/rollback necesario según el estado de transacción; rollback es limpieza de la operación, no un nuevo intento. Un commit fallido puede dejar una transacción activa, por lo que el adaptador debe controlar su estado antes de reutilizar la conexión. [Semántica oficial de errores de transacción](https://www.sqlite.org/lang_transaction.html).

### Configuración y cuotas

- Crear configuración mediante inserción exclusiva; actualizar por tenant_id y revisión esperada y exigir exactamente una fila afectada.
- En una transacción de consumo: leer configuración, comparar revisión, validar meter/feature/límite, consultar recibo, contrastar fingerprint y decidir consumo.
- Guardar incremento y recibo en la misma confirmación. La denegación por cuota agotada guarda recibo sin incremento; las denegaciones anteriores mantienen la semántica G5/G8.1.
- Replays devuelven resultado original; no se actualiza el snapshot histórico con el límite nuevo.
- Nunca separar recibo y contador en conexiones o bases distintas.

### Journal

Reserva exclusiva por tenant/eventId; transitions y delivered cambian juntos mediante revisión esperada. Lecturas y escrituras de plan siempre quedan en el namespace del mismo tenant/evento. No se llaman handlers dentro de SQL.

Reabrir un journal processing no inicia una entrega. Se mantiene bloqueado hasta diagnóstico y una operación administrativa explícita que confirme que el ejecutor anterior se detuvo. Una transición tardía con revisión anterior falla. No hay timeout que vuelva a entregar automáticamente.

### Alternativa PostgreSQL

Propuesta a validar si se elige: transacción con bloqueo de la fila de configuración del tenant antes de actualizar configuración/cuota/recibo, siempre en el mismo orden; bloqueo del journal para sus transiciones. Constraints únicas y CAS siguen siendo necesarios. No basta un SELECT previo fuera de la transacción. [Bloqueos oficiales](https://www.postgresql.org/docs/current/explicit-locking.html).

Serializable también puede abortar transacciones por conflictos; la documentación contempla que la aplicación gestione esos abortos. La regla del proyecto se conserva: no se implementará un retry automático; se propagará un error explícito tras rollback. [Aislamiento PostgreSQL](https://www.postgresql.org/docs/current/transaction-iso.html).

## 7. Errores y confirmación incierta

Mantener RepositoryError y los errores de dominio actuales. Mapear revisión/CAS/creación duplicada a REVISION_CONFLICT cuando corresponda; fingerprints distintos a IDEMPOTENCY_CONFLICT; payloads inválidos a INVALID_RECORD. Contención del motor, I/O y fallos de conexión no se convertirán en éxito: STORAGE_UNAVAILABLE sanitizado. No registrar SQL con valores, payloads o credenciales.

Si el resultado de confirmación es incierto, no asumir que no hubo consumo. La operación necesita diagnóstico del estado de la conexión/transacción y getReceipt bajo el mismo tenant/idempotencyKey. Un null aislado no demuestra que una confirmación en curso no vaya a terminar y no autoriza repetir el consumo.

Un rollback de almacenamiento no deshace efectos externos de un handler. No se promete exactamente una vez ni se añade un outbox implícito.

## 8. Bootstrap, versiones y copias

- Bootstrap explícito solo de un recurso DEV nuevo autorizado, con metadatos y esquema inicial en una transacción revisada.
- Sin auto-migrations al importar el paquete o abrir repositorios. Esquema desconocido: rechazo, sin reset.
- Migraciones posteriores requieren plan revisado, copia verificable y autorización específica. No se diseñan DROP/TRUNCATE o restauraciones destructivas automáticas.
- Las copias de una base abierta deben usar un mecanismo consistente del motor; no copiar a ciegas el archivo principal mientras puede cambiar. La API de backup SQLite ofrece snapshots consistentes. [Backup oficial](https://www.sqlite.org/backup.html).
- Probar restauración solo en un archivo DEV nuevo de la allowlist, manteniendo intacto el original. No borrar archivos existentes para que una prueba pase.
- No purgar recibos o eventos automáticamente: la retención afecta la idempotencia. Límites de crecimiento, tamaño y política de retención deben fijarse antes de uso prolongado.

## 9. Paquete y fases propuestas

```text
cloud-contracts                       contratos actuales sin driver
cloud-persistence-memory → contracts   referencia de comportamiento
cloud-persistence-sqlite → contracts   candidato futuro, aún no creado
composición DEV                        inyecta validadores G3/G6 y adaptador elegido
```

La infraestructura no se importa en SDK/Core ni en el HTML. Un coordinador de cuotas y un bus respaldados por repositorios siguen siendo alcances separados: persistir repositorios no conecta automáticamente G5/G6 ni guarda borradores de la demo.

1. Seleccionar motor y validar driver/API exactos, sin abrir base todavía.
2. Preparar código y DDL revisables, con destinos explícitos y cero auto-creación en import.
3. Autorizar por separado bootstrap, lecturas/escrituras y datos de prueba de las rutas DEV indicadas (o definir otro recurso de forma expresa).
4. Implementar y probar el adaptador sobre ese recurso; detenerse ante operación fallida sin reintentos automáticos.
5. Checkpoint local solamente si se autoriza. Ninguna fase incluye push o despliegue.

## 10. Criterios de aceptación para implementación futura

| Área | Evidencia requerida |
| --- | --- |
| Recurso | Rechazo de rutas no autorizadas, symlinks, metadatos/env/schema incorrectos y creación accidental |
| Contratos | Suites reutilizables G8.1 ejecutadas sobre adaptador nuevo y referencia en memoria |
| Durabilidad | Cerrar y abrir conexiones; proceso nuevo recupera configuración, contadores, recibos y journal |
| Concurrencia | Dos procesos compiten por revisión/unidad final; no sobreconsumo; contención reportada sin retry |
| Atomicidad | Fallos antes de confirmar no dejan incremento sin recibo ni delivered incoherente |
| Tenants | Mismos IDs entre tenants, claves compuestas y FKs de entregas sin cruces |
| Recuperación | Registro processing permanece bloqueado tras reinicio; interrupción manual cerca confirmaciones tardías |
| Configuración | Cambiar revisión bloquea consumo con límite antiguo; recibos históricos permanecen válidos |
| Corrupción | JSON/valores fuera de rango o esquema desconocido rechazan sin defaults permisivos |
| Copia | Snapshot consistente y restauración verificada en archivo nuevo autorizado |
| Regresión | Build/tipos y suites G2–G8.1; revisión de imports, secretos y exclusiones |

No se atribuyen resultados de estas pruebas a este gate de diseño. La última ejecución del código sigue siendo G8.1: 181 pruebas aprobadas.

## 11. Decisiones que faltan antes de ejecutar

Seleccionar SQLite/PostgreSQL, aceptar el driver/versionado para DEV, autorizar rutas o identificar servidor/esquema/rol, fijar tamaño/retención y aprobar el bootstrap concreto. No se requieren credenciales para revisar este documento ni se deben pegar secretos en el chat.

La recomendación SQLite sigue condicionada a esos puntos. Producción, FastPay, Docker, Cloudflare, bases existentes de otros proyectos, servicios persistentes y despliegues quedan fuera del alcance.
