# G6 — Validación runtime y eventos V1 (DEV)

## Alcance y arquitectura

`cloud-events → cloud-contracts`; `cloud-sdk → cloud-contracts`. CloudEventClient publica mediante EventBusPort, sin depender de la implementación del bus. Los exports previos permanecen disponibles. Sin nuevas dependencias externas.

Solo los eventos ya definidos en G2:

- flashlive.session.started.v1: data.sessionId.
- catalog.product.updated.v1: data.productId.

Este gate no valida todos los modelos comerciales ni implementa un broker, transporte HTTP, streaming de video, base de datos o integración externa.

## Frontera runtime

parseCloudEvent recibe un objeto JSON ya decodificado y valida envelope, contexto y payload. Requiere exactamente los campos V1 conocidos, contractVersion 1.0, eventVersion numérico 1 y discriminante conocido. Rechaza campos adicionales; su incorporación futura requiere definir explícitamente una versión compatible del parser/contrato.

Todos los identificadores deben ser strings no vacíos sin espacios al inicio/final. occurredAt admite UTC con segundos o milisegundos (tres dígitos), valida fecha real por roundtrip y normaliza a milisegundos. No se aplican ventanas de antigüedad o rechazo de fechas futuras.

El resultado contiene solo campos públicos canónicos y está congelado también en context/data. El parser no acepta texto JSON crudo; una futura entrada HTTP deberá decodificar JSON y aplicar este validador. No debe utilizar objetos JavaScript arbitrarios con getters como frontera de transporte.

## Suscripciones

Configuración interna confiable: tenantId, tipo exacto y subscriberId. Sin comodines de tenant o tipo. El subscriberId es único por tenant/tipo. subscribe devuelve un callback de baja idempotente; uno antiguo no elimina una suscripción nueva con el mismo ID.

La publicación usa un snapshot de suscriptores al comenzar. Una baja durante la entrega se aplica a publicaciones posteriores. Los handlers se ejecutan secuencialmente, en orden de registro, y reciben snapshots canónicos independientes e inmutables. Publicaciones de eventos distintos no tienen un orden global garantizado.

## Idempotencia y errores

El registro usa (tenantId,eventId) y un fingerprint del evento canónico completo, incluidos tipo, timestamp y metadata de contexto. Orden de propiedades JSON y precisión equivalente de timestamp no producen conflicto.

- Un evento completado devuelve outcome=duplicate sin nuevas entregas.
- Mismo ID y otro contenido: EVENT_CONFLICT.
- Mismo evento aún en curso: DELIVERY_IN_PROGRESS, sin espera/coalescencia ni reintentos.
- Un handler fallido interrumpe los siguientes, marca el evento failed y devuelve HANDLER_FAILED sin revelar el error original ni el payload.
- Repetir un evento failed conserva HANDLER_FAILED y no ejecuta handlers.
- Publicar sin suscriptores completa con delivered=0. Los suscriptores añadidos después no reciben ese evento al repetirlo.

No se promete entrega exactamente una vez ni atomicidad entre handlers. Puede haber efectos parciales antes de un fallo. Se requiere idempotencia de negocio en los consumidores reales futuros. Cambiar eventId crea una operación distinta y puede repetir efectos.

## Autorización

CloudEventClient aplica la acción events:publish y utiliza el tipo de evento como recurso. G4 verifica identidad, pertenencia, caducidad y revocación. El SDK copia contexto y envelope antes de await. El bus siempre valida runtime y comprueba que el tenant del envelope coincida con el contexto de publicación.

El bus directo es un puerto interno confiable, no un endpoint autenticado. El contexto no sustituye la autenticación. Los handlers y suscripciones no pueden proceder de visitantes del HTML. El gate no consume cuotas G5 implícitamente ni conecta la bolsa/sesión mock a una operación comercial real.

## Uso y demostración

```sh
pnpm build
pnpm typecheck
pnpm test:g6
pnpm demo:events
```

La demo publica una sesión iniciada con identidad de vendedor simulada, procesa un handler y publica un duplicado sin nueva ejecución. La integración de prueba compone una proyección Commerce en Vivo una sola vez usando los puertos mock existentes.

## Límites

Memoria de un solo proceso: al recrear el bus se pierde el registro; no hay TTL, retención limitada, outbox, replay histórico, recuperación automática o coordinación distribuida. Un handler que no finaliza mantiene su evento en processing; no hay timeout ni cancelación en V1. El patrón de eventos de sesión/catálogo es independiente de la transmisión multimedia.

La apariencia de la demo HTML sigue pendiente de revisión real en navegador. G7 propuesto: adaptadores DEV de referencia para aplicaciones externas, fixtures y pruebas contractuales, sin conectar producción ni servicios comerciales reales. No iniciado.
