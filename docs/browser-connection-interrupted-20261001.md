# Diagnóstico de respuestas con conexión interrumpida

Investigación directa, sin agentes delegados ni cambios al servidor activo.
Fecha: 2026-10-01. Las horas de la tabla corresponden a Lima (UTC−05:00).
Esta nota contiene observaciones derivadas; no incorpora historiales, prompts,
credenciales ni logs de usuario.

**Veredicto:** el reporte original es parcialmente verídico. La interrupción y
la incertidumbre durable están acreditadas; sus atribuciones a saturación SSE,
throttling, un límite universal de 40 minutos y un deadlock SQLite no lo están.
Se repararon los defectos reproducibles del puente mediante pruebas de regresión.

## Resultado observado

Las dos sesiones inspeccionadas ejecutaron herramientas y luego terminaron con
error, sin respuesta final confirmada ni compactación. Una sesión marcada como
activa en la interfaz no demuestra que haya una herramienta ejecutándose.

| Observación | Sesión A | Sesión B |
| --- | --- | --- |
| Inicio del turno nativo | 14:22:17 | 14:23:59 |
| Último resultado de herramienta | 14:46:17 | 14:59:11 |
| Resultados de herramientas completados en el journal | 115 | 55 |
| Finalización nativa con error | 15:02:21 | 15:04:04 |
| Duración nativa registrada | 2403942 ms | 2404867 ms |
| Último uso de contexto informado | 232975 tokens | 163926 tokens |
| Compactaciones / checkpoints de fase confirmados | 0 / 0 | 0 / 0 |

La lectura inicial de B registraba 53 resultados hasta las 14:34:25. La lectura
final encontró dos llamadas adicionales a las 14:58:58 y 14:59:06, con sus
resultados completados. No debe confundirse ese intervalo de silencio con una
ausencia definitiva de recuperación.

A las 15:01:15 se observó directamente el DOM de las dos superficies asignadas,
sin pulsar botones, recargar páginas ni crear otra conversación. Ambas mostraban
`Conexión interrumpida. Esperando la respuesta completa` en un elemento visible
con `role="status"`, un botón Detener visible y ninguna acción de finalización
visible en la última respuesta. `navigator.onLine` era verdadero; eso no acredita
la salud del stream remoto. Los documentos medían 678708 y 669042 caracteres.

Los dos registros nativos de finalización contienen el mismo error:

> stream disconnected before completion: ChatGPT stopped responding after the
> task started (Operation failed). Check the ChatGPT tab before continuing.

El journal final conserva todos esos resultados como completados, la operación
de navegador como `uncertain`, ninguna superficie vinculada a esos actores,
`history_revision = 0` y `compaction_epoch = 0`. El evento `task_complete` incluye
un error: no constituye una entrega exitosa. La marca `uncertain` tampoco vuelve
a ejecutar las herramientas ya completadas.

## Runtime y origen del aviso

El daemon y el helper siguieron activos con el mismo artifact-set verificado:
`43079493681aea5d320e87d384865b3a9dd95779afe1b0c420983e09a25b16c9`.
El daemon era PID 320816 y el helper PID 321479; ambos informaron
`paired_manifest_verified`. La consulta final de salud tenía telemetría sana,
cero escrituras fallidas, cero registros descartados y cero reinicios del túnel.
El resto de actividad del servidor no implica actividad de estas dos sesiones.

El aviso se observó en ChatGPT web. No es un aviso de compactación de Codex.
Existen eventos `page_request_failed` alrededor de las 14:52 y 14:53, además de
otros anteriores y posteriores. Se registran sin clase de petición ni causa de
transporte; no permiten identificar cuál corresponde al stream de generación.

Ambos turnos finalizaron aproximadamente a los 40 minutos. No se encontró un
timeout total de 40 minutos en las rutas inspeccionadas del puente, y la
configuración activa no establece `turnTimeoutMs`. La duración es una correlación,
no evidencia de un límite universal de ChatGPT ni de la causa exacta del cierre.

## Defectos encontrados antes de la reparación

1. [overlays.ts](../src/adapters/chatgpt-web/browser/overlays.ts) reconoce los
   errores terminales existentes, pero no el estado localizado de conexión
   interrumpida observado. Debe distinguir una interrupción transitoria de un
   fallo sostenido de la respuesta, sin confundir texto citado por el usuario.
2. [turn-completion-loop.ts](../src/adapters/chatgpt-web/browser/turn-completion-loop.ts)
   deriva `running` de la visibilidad del botón Detener.
   [dom-trackers.ts](../src/adapters/chatgpt-web/browser/dom-trackers.ts) reinicia
   sus ventanas de estancamiento mientras `running` sea verdadero. El botón puede
   seguir visible durante la interrupción y mantener la espera sin progreso real.
3. [diagnostics.ts](../src/adapters/chatgpt-web/browser/diagnostics.ts) registra
   `page_request_failed` con motivo genérico. Los errores finales de este incidente
   se serializaron como `operation_failed` / `Operation failed`. Falta información
   estructurada y sanitizada para separar fallo de stream, observación y transporte.

El primer gap no demuestra por sí solo qué disparó finalmente los errores 502.
La evidencia disponible confirma el estado interrumpido y el cierre fallido;
la causa de transporte permanece sin resolver. Las correcciones de estos comportamientos se describen abajo; no se ha
modificado el servidor activo ni repetido los envíos de las sesiones afectadas.

## Compactación y continuación esperadas

El catálogo nativo usado por estas sesiones informa `context_window = 270000`,
`auto_compact_token_limit = 240000` y ventana efectiva de 240300. Está habilitado
`experimentalBiggerContext`. El último uso de ambos turnos estaba por debajo del
umbral de compactación; no se produjo una compactación en estos registros.
Estos valores describen la configuración registrada en esas sesiones; no
acreditan un límite temporal de ChatGPT web.

La política implementada conserva el chat temporal entre fases cuando existe
checkpoint válido y salud remota acreditada. Una recomendación tras 50 resultados
de herramientas no fuerza al modelo a terminar ni programa por sí sola la fase
siguiente. Compactar Codex no vacía el contexto de ChatGPT web.

En estas dos páginas el DOM observado ya superaba el umbral de retención de
600000 caracteres. Sin salud acreditada, la política de
[remote-chat-retention.ts](../src/adapters/chatgpt-web/remote-chat-retention.ts)
no autoriza conservar la conversación física tras compactar. La alternativa
prevista es un chat temporal nuevo con handoff estructurado validado; un envío
incierto exige reconciliación y no permite repetir efectos automáticamente.

## Regresiones necesarias para una corrección

- Reproducir el aviso real en español e inglés, con Detener visible y sin progreso.
- Acreditar una recuperación transitoria y permitir nuevas herramientas; la mera
  presencia momentánea del aviso no debe matar el turno. B reanudó herramientas
  después de un intervalo de silencio, pero no se observó el DOM durante ese
  intervalo y no se acredita que el aviso ya estuviera presente entonces.
- Aplicar una espera acotada ante interrupción sostenida sin progreso acreditado;
  no usar la duración total de una tarea sana como motivo para abortarla.
- Excluir texto citado en mensajes, indicadores ocultos y estados de otro turno.
- Mantener resultados y operación incierta, emitir error tipado y evitar Send,
  regeneración o repetición automática de herramientas tras el fallo.
- Registrar categoría de petición y causa de red sanitizadas, sin URL con tokens,
  cuerpos de mensajes, credenciales ni historiales.

La evidencia del incidente procede de lecturas del DOM, rollouts nativos,
journal durable y telemetría del runtime recogidas durante la investigación
inicial. Las regresiones posteriores prueban el puente local con escenarios
controlados; no equivalen a repetir una sesión real de 40 minutos.

## Plan de reparación TDD

La reparación se ejecuta por comportamiento observable, no por duración total
del turno. Cada fila debe empezar con una regresión que falle contra el código
actual y quedar verde antes de continuar con el siguiente cambio.

| ID | Defecto | Test RED | Criterio GREEN |
| --- | --- | --- | --- |
| TDD-1 | El estado visible `Conexión interrumpida` / `Connection interrupted` no se clasifica | Un `role="status"` visible con ese texto debe reconocerse; texto equivalente fuera de `role="status"` no debe contar | El observador expone una señal tipada de interrupción limitada a la superficie de estado |
| TDD-2 | El botón Detener mantiene falsamente el turno sano durante una interrupción | Con aviso de interrupción visible, Detener visible y sin progreso corroborado, la ventana de interrupción debe avanzar | Una interrupción transitoria se recupera; una interrupción sostenida produce un error tipado y acotado |
| TDD-3 | Los timeouts de observación se suprimen por `isRunning` aunque el stream esté interrumpido | Un probe timeout con Detener visible + interrupción no debe tratarse como generación sana | Se permite rebind/fallo controlado; no se espera indefinidamente por el botón |
| TDD-4 | Ráfaga urgente de herramientas desconectada de `compactionRequired` | Una ráfaga de 70 resultados debe marcar presión; un prompt nuevo estimado en 50000 tokens no debe forzar compactación | La política ve la ráfaga urgente sin convertir las heurísticas de DOM/tokens en un límite obligatorio de entrada |
| TDD-5 | `page_request_failed` pierde toda causalidad útil | Un fallo del endpoint de conversación debe guardar solo categoría allowlisted y clase de transporte sanitizada | El diagnóstico distingue conversación/otro recurso y causa de transporte sin URL, cuerpo ni texto arbitrario |
| TDD-6 | Fallos conocidos de stream terminan como `operation_failed` | El error tipado de stream debe sobrevivir serialización helper/diagnostics | El usuario y el journal reciben un código estable, sin texto privado arbitrario |

### Invariantes de seguridad

- Nunca reenviar automáticamente un prompt cuyo `Send` ya fue activado o
  aceptado.
- Nunca regenerar una respuesta como mecanismo de recuperación automática.
- Nunca descartar resultados de herramientas ya completados.
- La presencia momentánea del aviso no es terminal si existe progreso posterior
  corroborado.
- Los diagnósticos nuevos solo admiten vocabulario cerrado; no persisten URL
  completas, cuerpos, prompts, cookies, credenciales ni mensajes de error
  arbitrarios.
- El estado `uncertain` de un `browser_send` aceptado continúa siendo
  fail-closed. La reconciliación remota es una mejora separada y no se resuelve
  reintentando el efecto externo.


## Veredicto sobre el reporte original

El aviso de conexión interrumpida, la terminación sin respuesta confirmada y el
estado durable `uncertain` están respaldados por las observaciones registradas.
Las siguientes afirmaciones exceden esa evidencia:

- **Saturación del DOM como causa raíz:** el DOM grande indica presión potencial,
  pero no prueba agotamiento de memoria ni saturación de un buffer SSE.
- **Límite universal de 30–40 minutos o 50 herramientas:** no está demostrado.
  Los contadores del journal incluyen resultados, mientras que otros contadores
  agrupan ejecuciones; no son unidades equivalentes. El puente utiliza
  recomendaciones de fase y heurísticas de presión, no un límite remoto probado.
- **WebSocket/SSE colapsado:** el banner acredita una interrupción percibida por
  la interfaz. Sin una captura correlacionada del transporte no identifica el
  protocolo, la petición concreta ni quién cerró la conexión.
- **Moderación/throttling como causa:** el texto de revisión mencionado en el
  reporte original no basta para atribuir throttling ni enlazar causalmente las
  dos sesiones. No se incorporó evidencia adicional que lo demuestre.
- **Deadlock SQLite:** la consulta sobre operaciones inciertas es una barrera
  lógica deliberada. No se acreditó un deadlock de transacciones SQLite.
  El defecto reproducible era modificar la titularidad del turno antes de
  rechazar un nuevo efecto bloqueado por esa barrera.

## Reparaciones realizadas

| Prioridad | Defecto reproducible | Cambio y evidencia |
| --- | --- | --- |
| Alta | Detener visible ocultaba el estancamiento durante la interrupción | Se separa visibilidad de Detener de generación sana. El aviso persistente, sin progreso corroborado, produce `chatgpt_stream_interrupted` (502, no reintentable) tras la gracia inicial de 180 s fijada por el plan de continuidad. La regresión del bucle confirma que no se entrega una respuesta parcial como final. |
| Alta | `claimed` se interpretaba como una llamada activa indefinidamente | La actividad multicanal depende de llamadas realmente en vuelo o eventos recientes. Una reclamación de hace una hora, sin llamadas activas, ahora devuelve las tres señales de actividad en falso. |
| Alta | Un nuevo envío bloqueado reemplazaba al propietario del turno incierto | El manager verifica la incertidumbre antes de admitir el turno nuevo. La prueba con journal SQLite real acredita que tanto reemplazo como duplicado se rechazan sin ejecutar el callback de envío y que el turno original conserva la titularidad. |
| Media | La detección global del aviso confundía contenido y estado de otros turnos | Se filtran avisos visibles antes de elegir el último; se excluye contenido de usuario/Markdown/citas/código y se limita el estado de conversación al turno vinculado. Dos pruebas con Chromium real reproducen duplicados ocultos, mensajes citados y avisos históricos. |
| Media | El aviso podía abortar una respuesta que seguía creciendo | Los cambios en texto de respuesta/comentarios y el progreso externo corroborado reinician la gracia; las etiquetas de estado no cuentan como avance. La prueba hace crecer la respuesta mientras persiste el aviso y confirma la finalización tras su recuperación. |
| Media | Una respuesta vacía interrumpida perdía el error de stream a los 10 s | La ventana de respuesta vacía ya no afirma finalización durante la interrupción. La prueba avanza en pasos de 6 s y obtiene el error tipado a los 181 s de observación, al agotarse la gracia de 180 s. |
| Media | Fallos conocidos se reducían a `Operation failed` | Se incorporan códigos de stream y reconciliación al catálogo sanitizado. La barrera de reconciliación devuelve `session_reconciliation_required` (409, no reintentable). El fallback para errores desconocidos conserva su sanitización. |
| Media | Fallos de petición no conservaban categoría ni causa útil | Se registran solo `requestClass`, `resourceType` y `transportFailure` allowlisted. La prueba verifica categoría de conversación y `connection_reset`, sin URL privada ni mensaje crudo. |
| Media | La ráfaga urgente no llegaba a la decisión de presión | `compactionRequired` incorpora la ráfaga urgente. Los umbrales conservadores de DOM/tokens permanecen como heurísticas de retención; un prompt nuevo válido no se bloquea únicamente por esas estimaciones. |

### Arquitectura y transiciones

La separación existente se mantiene: overlays lee el estado de la página,
los trackers acumulan evidencia temporal, el bucle decide finalización y el actor
protege efectos durables. No se agrega un segundo mecanismo de envío.

La observación recorre `generación sana → interrupción observada → recuperación`
si desaparece el aviso o aparece progreso corroborado; alcanza un fallo tipado si
el aviso persiste sin progreso durante la gracia. El contador mide esa condición
local, no el tiempo total de una tarea sana. La actividad real de herramientas
mantiene la espera; una marca antigua de reclamación no lo hace.

En el actor, `aceptado → resultado durable → completado` continúa siendo la ruta
normal. `aceptado → desconexión sin resultado → uncertain` requiere evidencia de
reconciliación. Un intento de reemplazo se rechaza antes de modificar su
propietario. Los resultados durables existentes y la evidencia explícita de
`not_sent` conservan sus rutas de recuperación y reintento seguro.

### Evidencia RED → GREEN

Además de las regresiones iniciales de detección, diagnóstico y presión, se
observaron fallos de comportamiento antes de cada corrección adicional:

1. Una reclamación antigua devolvía actividad multicanal verdadera.
2. El rechazo de un envío incierto era genérico; al comprobar también un
   reemplazo seguido de un duplicado, el segundo intento fallaba por titularidad
   modificada. La corrección conserva `turn-1` y bloquea ambos callbacks.
3. Una respuesta en crecimiento fallaba prematuramente con el error de stream.
4. Un prompt nuevo de 50000 tokens estimados exigía compactación sin otra señal.
5. Chromium devolvía falso ante un aviso visible seguido de otro oculto, y
   verdadero ante texto citado o un aviso perteneciente al turno anterior.
6. Una respuesta vacía interrumpida emitía un error genérico antes de la gracia.
7. Una etiqueta de espera que cambiaba continuamente impedía expirar la gracia
   aun sin nuevos comentarios ni texto de respuesta; solo se alcanzaba el timeout
   general. La regresión confirma ahora el fallo de stream al agotarse la gracia
   de 180 s sin progreso corroborado.
8. Al alinear la gracia con los 180 s del plan de continuidad, la ventana de 60 s
   de la acción de finalización concluía «el DOM puede haber cambiado» durante una
   interrupción sostenida con respuesta parcial visible, precediendo al error
   tipado de stream y dejando la gracia inalcanzable. La regresión del bucle
   reproduce el fallo; la corrección difiere esa conclusión al tracker de
   interrupción mientras el aviso es visible, y la ventana de respuesta ausente
   sigue cargando aunque Detener permanezca visible.

Los escenarios corregidos quedaron verdes en sus ejecuciones focalizadas.
Las pruebas observan resultados, errores, contenido entregado y titularidad a
través de las interfaces del bucle/actor y la frontera Page; no buscan texto en
los archivos fuente ni invocan prototipos privados del worker.

## Alcance y límites de aceptación

- La detección cubre los avisos observados en español e inglés y las estructuras
  de turno soportadas por el adaptador. Otros textos/estructuras de ChatGPT
  necesitan su propia evidencia y regresión.
- Para acreditar progreso DOM durante una interrupción se utiliza texto de
  respuesta y comentarios; las etiquetas de estado pueden contener temporizadores
  del renderer y no se consideran prueba suficiente por sí solas.
- La telemetría nueva ayuda a investigar futuros fallos; no reconstruye la
  petición perdida del incidente original ni acredita saturación del servicio.
- Un resultado remoto no confirmado conserva `uncertain`. No se implementa una
  reconciliación remota ciega ni se desbloquea el actor por expiración temporal.
- El aviso de yield y `yieldRecommended` continúan siendo recomendaciones; no
  sustituyen la evidencia de finalización ni fuerzan un corte por 50 herramientas.
- Las reparaciones están en el árbol de trabajo. No se despliegan ni se reinicia
  el daemon activo; las sesiones históricas no se declaran recuperadas.

## Archivos y responsabilidades

- Observación y progreso: [overlays.ts](../src/adapters/chatgpt-web/browser/overlays.ts),
  [dom-trackers.ts](../src/adapters/chatgpt-web/browser/dom-trackers.ts),
  [turn-liveness.ts](../src/adapters/chatgpt-web/browser/turn-liveness.ts) y
  [turn-completion-loop.ts](../src/adapters/chatgpt-web/browser/turn-completion-loop.ts).
- Presión: [context-pressure.ts](../src/adapters/chatgpt-web/browser/context-pressure.ts).
- Efectos durables: [manager.ts](../src/adapters/chatgpt-web/session-actor/manager.ts) y
  [journal.ts](../src/adapters/chatgpt-web/session-actor/journal.ts).
- Contrato de error y telemetría: [adapter-error.ts](../src/adapters/chatgpt-web/adapter-error.ts),
  [diagnostics.ts](../src/adapters/chatgpt-web/browser/diagnostics.ts),
  [errors.ts](../src/diagnostics/errors.ts) y [events.ts](../src/diagnostics/events.ts).
- Pruebas creadas: [browser-stream-interruption.test.ts](../tests/browser-stream-interruption.test.ts)
  y [browser-stream-interruption-dom.test.ts](../tests/browser-stream-interruption-dom.test.ts).
- Pruebas ampliadas: [turn-completion-loop.test.ts](../tests/turn-completion-loop.test.ts),
  [turn-liveness.test.ts](../tests/turn-liveness.test.ts),
  [session-actor.test.ts](../tests/session-actor.test.ts),
  [continuity-diagnostics-browser.test.ts](../tests/continuity-diagnostics-browser.test.ts) y
  [predictive-context-pressure.test.ts](../tests/predictive-context-pressure.test.ts).

## Validación de la reparación

Validación final ejecutada sobre el árbol con la gracia de 180 s y la conclusión
de la acción de finalización diferida al tracker de interrupción:

| Verificación | Resultado observado |
| --- | --- |
| Suite completa sobre el árbol final | 2374 aprobadas, 14 omitidas, 0 fallidas; 234.97 s, 13383 aserciones |
| Regresiones focalizadas finales (7 archivos) | 110 aprobadas, 0 fallidas; 12,2 s |
| Contratos obligatorios de navegador con Chromium real | 37 aprobados, 0 fallidos; 257.47 s |
| `bun run typecheck` | Código de salida 0 |
| `bun run lint` | Código de salida 0; 88 advertencias del repositorio, 0 errores |
| `bun run check:refactor-gates` | PASS; cero casts dobles en los módulos auditados, prototipos privados o tests que leen fuente |
| Compilación aislada de CLI y helper, seguida de `node --check` | Ambos artefactos compilados y válidos; fuera del runtime activo |
| `git diff --check` | Código de salida 0 |

Durante la sesión de reparación, una corrida intermedia recibió SIGTERM
(salida 143) sin resumen final y no se considera aprobada; la prueba de IPC
correspondiente pasó de forma aislada. No se atribuye una causa al SIGTERM sin
evidencia adicional. La corrida completa registrada en la tabla se ejecutó en
serie sobre el árbol final.

### Cómo reproducir las comprobaciones

Desde la raíz del repositorio, con Bun 1.4.2 y las dependencias instaladas:

```sh
bun test ./tests
bun run typecheck
bun run lint
bun run check:refactor-gates
CHATGPT_DOM_TEST_BROWSER=/usr/bin/google-chrome bun run test:browser-contracts
```

El path de Chromium puede sustituirse por otro ejecutable instalado. Las 14
omisiones de la suite general incluyen contratos DOM optativos; la ejecución
obligatoria de contratos con Chromium se realiza por separado y no los omite.
Las dos regresiones nuevas del detector también usan Chromium real dentro de la
suite general.

Los bundles se verificaron con `bun build` en `/tmp/stream-fix-build`, sin copiar
archivos a `.launcher-runtime` ni sustituir los binarios del daemon. Esta
comprobación verifica compilación/sintaxis de los artefactos locales.

Para reproducir esa compilación aislada:

```sh
bun build ./src/cli.ts \
  --outfile=/tmp/stream-fix-build/cli.js --target=bun
bun build ./src/adapters/chatgpt-web/browser-helper-main.ts \
  --outfile=/tmp/stream-fix-build/browser-helper.cjs \
  --target=node --format=cjs --packages=external --external=playwright-core
node --check /tmp/stream-fix-build/cli.js
node --check /tmp/stream-fix-build/browser-helper.cjs
```
