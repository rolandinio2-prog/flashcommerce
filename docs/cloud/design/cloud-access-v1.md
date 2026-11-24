# G4 — Contexto, identidad y políticas de acceso V1 (DEV)

## Objetivo

Componer Commerce en Vivo con contexto de tenant e identidad resueltos desde un proveedor simulado y políticas explícitas. No conectar sistemas de autenticación, credenciales, servidores ni datos reales. La identidad de la interfaz no constituye una fuente confiable de roles.

## Paquetes

`cloud-access → cloud-contracts`

La aplicación demo compone access, SDK, Core y Registry. Las librerías no dependen de la aplicación ni de implementaciones de FlashCommerce. Sin nuevas dependencias externas.

Contratos añadidos: AccessRequest, IdentitySession, IdentitySessionPort, ResolvedAccess, IdentityVerificationPort, AccessPolicy y AccessError. Los exports G2/G3 permanecen disponibles.

## Flujo

1. Un adaptador recibe tenantId, requestId, correlationId y una referencia de sesión.
2. AccessContextResolver consulta IdentitySessionPort, valida su respuesta y caducidad, y comprueba el tenant de la identidad.
3. Devuelve únicamente contexto e identidad canónicos, congelados. Ignora roles/identidades adicionales suministrados por el llamador.
4. Conserva en WeakMap la relación entre el objeto de identidad emitido y su referencia de sesión. Una copia, JSON serializado u objeto fabricado no pasa verificación.
5. CloudClient solicita autorización a PolicyAuthorizationAdapter.
6. La política verifica la identidad con el mismo resolver, vuelve a consultar el proveedor y revisa revocación, expiración y pertenencia del sujeto. Usa los roles actuales del proveedor, no los roles recibidos en la petición.
7. Solo después de autorización, SDK aplica entitlements y consulta los puertos de catálogo/FlashLive. Cloud Core compone la vista como antes.

## Políticas

Cada regla contiene ruleId único, tenant exacto, rol exacto, acción exacta, recurso y efecto allow/deny. Un recurso puede ser un identificador exacto o `*`. No hay globs parciales ni comodines de tenant, rol o acción. Un deny coincidente tiene prioridad sobre cualquier allow; sin allow coincidente se deniega.

La política es una configuración confiable de composición, no una configuración editable por el visitante. Conceder una acción de administración solo evalúa el permiso: no implementa comandos comerciales ni modifica servicios.

## Mocks

MockIdentitySessionAdapter copia fixtures, rechaza referencias duplicadas y permite revocarlas en memoria. Las referencias usadas en ejemplos (buyer-demo, seller-demo, demo-buyer) son etiquetas sintéticas, no tokens ni credenciales. Los tests inyectan reloj para verificar los límites de caducidad. La demo HTML usa reloj lógico fijo y una identidad de comprador simulada.

La demo incorpora la nueva autorización en sus lecturas. Los botones comprador/vendedor siguen siendo perspectivas de prueba; las mutaciones del vendedor son cambios de fixtures en memoria y no representan endpoints protegidos. No existe una frontera de seguridad dentro de un HTML que controla el propio visitante.

## Uso

```sh
pnpm build
pnpm typecheck
pnpm test:g4
pnpm demo:access
```

La demo de acceso imprime dos decisiones para flashlive:manage: comprador denegado, vendedor permitido. No ejecuta la acción. El HTML local se sigue generando en apps/commerce-live-demo/dist/index.html.

## Límites y siguiente alcance

La verificación con WeakMap es deliberadamente local al proceso y al resolver. Una integración HTTP futura deberá resolver la identidad en cada petición del servidor; no debe confiar en objetos enviados por el navegador ni serializar handles para reutilizarlos. Se necesita un proveedor autenticado real en un alcance DEV separado. No se implementan JWT, cookies, login, logout remoto, persistencia, auditoría durable o gestión comercial de usuarios.

El reloj y el proveedor son dependencias confiables; un error del proveedor bloquea la operación. No hay caché de autorización que omita la verificación. La revocación impide la siguiente autorización, pero no cancela una operación ya autorizada/en curso.

G5 propuesto: evaluación de entitlements y límites con consumo simulado y pruebas de aislamiento, sin facturación ni acceso externo. La revisión gráfica del HTML permanece pendiente.
