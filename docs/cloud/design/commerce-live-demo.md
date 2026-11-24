# G3.1 — Demostración visual local de Commerce en Vivo

## Alcance

Dos perspectivas en una página: comprador y vendedor. Datos sintéticos, memoria del navegador, sin servidor, credenciales, red ni almacenamiento persistente. La bolsa es una selección de ejemplo, sin precios, pagos o pedidos. La escena ilustrativa está construida con CSS; no representa una transmisión real.

## Estructura

```text
apps/commerce-live-demo/
  package.json
  src/model.mjs          Estado simulado y composición con Cloud Core/SDK
  src/app.mjs            Eventos y renderizado DOM
  src/index.html         Estructura accesible en español
  src/style.css          Diseño responsive y escena ilustrativa
  scripts/build.mjs      Empaquetado offline a un HTML autónomo
  dist/index.html        Artefacto generado e ignorado por Git
```

La aplicación depende de los cuatro paquetes públicos. Las librerías no dependen de la aplicación. `model.view()` instancia puertos mock y utiliza CloudCore.getLiveCommerceView; no copia la lógica de autorización o proyección en la UI. Las mutaciones de vendedor son fixtures locales, no APIs comerciales. Comprador/vendedor son perspectivas de demostración, no roles autenticados.

## Interacciones

- Vistas conjunta, comprador y vendedor.
- Título compartido, editable con validación de longitud.
- Ciclo programada → en vivo → finalizada → programada.
- Selección de productos y producto destacado con fallback al retirarlo.
- Cambios del vendedor reflejados en la vista del comprador de la misma página.
- Añadir productos seleccionados a una bolsa simulada solo durante la sesión en vivo.
- Cantidades, bolsa vacía y reinicio completo de la demo.
- Mensajes de estado accesibles; textos insertados con textContent.

## Construcción y uso

Desde /srv/flashcommerce-cloud:

```sh
pnpm build
pnpm test:visual
```

Abrir `apps/commerce-live-demo/dist/index.html` en un navegador, como archivo local. No hace falta iniciar un servidor. El build usa el TypeScript ya instalado para convertir módulos y un cargador local estático, sin eval. No incorpora dependencias externas nuevas. El HTML contiene CSS y JS inline; su CSP deshabilita conexiones de red. Los fuentes son autoritativos: el artefacto se regenera con el build.

## Validación y límites

Pruebas unitarias del modelo y ejecución del script empaquetado en un harness DOM de Node. El harness comprueba eventos compartidos y errores, pero no sustituye una revisión gráfica y de accesibilidad en navegador. No se abrió un puerto ni se inició un navegador o servidor. Las reglas responsive están implementadas; su apariencia requiere revisión visual posterior.

No hay video real, chat real, métricas inventadas de audiencia, autenticación productiva, pagos ni llamadas a servicios. Las vistas comparten estado solo dentro de la misma página; no hay sincronización entre dispositivos o pestañas. Los datos se reinician al recargar.

G4 (identidad y políticas) sigue pendiente. Streaming, precios/imágenes, autenticación y cualquier adaptador externo requieren su propio alcance DEV. Producción permanece excluida.

## Revisión de usabilidad aprobada

- Controles dinámicos de selección, destacado y bolsa conservan el foco mediante claves estables tras renderizar. Los controles siguen usando botones y checkboxes nativos para navegación con TAB.
- El borrador del título permanece en el input cuando ocurren otras acciones. Guardar publica el título; reiniciar restablece el valor inicial. Las entradas inválidas se identifican con aria-invalid.
- Fuentes de contenido y controles ampliadas; acciones con altura mínima de 44 px y estados de foco visibles. Ajustes responsive para títulos largos, tarjetas y escena móvil.
- Avisos junto a acciones del vendedor/comprador y un aviso fijo con región aria-live para confirmar cambios o errores.
- Escena CSS dinámica: bolso, auriculares o botella según el destacado; estado vacío cuando no hay selección. El nombre del producto también está disponible como texto.

Validación: 7 casos del modelo y 8 del artefacto empaquetado aprobados. Los cinco casos añadidos verifican borrador, foco de vendedor, foco de comprador, escena y avisos. El harness no simula el algoritmo de TAB ni el layout de un navegador; revisión gráfica, contraste renderizado y recorrido real con teclado siguen pendientes.

## Mejoras adicionales de experiencia

- Acceso comprador → estudio: visible en sesión programada o finalizada; cambia a vendedor y enfoca la acción de sesión, sin iniciarla automáticamente.
- Indicador de borrador: refleja los eventos de edición, conserva cambios durante otras acciones y vuelve a «Título guardado» al guardar o reiniciar. Solo el guardado modifica el título publicado al comprador.
- Bolsa por producto: botones para aumentar/disminuir y quitar; contador total sincronizado. Cantidad cero retira el producto. Aumentar exige sesión en vivo y producto seleccionado; disminuir o quitar sigue disponible al finalizar o retirar el producto de la selección.
- Límite de demostración: 99 unidades por producto; no representa inventario ni cuotas comerciales. El modelo rechaza cantidades inválidas. Los clics rápidos consultan la cantidad actual para no perder incrementos.
- Al retirar una fila de la bolsa, el foco vuelve al botón de bolsa. Los controles restantes conservan el foco tras actualizar.

Validación actual de la demo: 10 pruebas de modelo y 12 del artefacto empaquetado, 22 aprobadas, cero fallos. Continúa pendiente la revisión visual/teclado en navegador real.
