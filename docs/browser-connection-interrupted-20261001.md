# Diagnóstico de respuestas con conexión interrumpida

Investigación directa, sin agentes delegados ni cambios al servidor activo.
Fecha: 2026-10-01. Las horas de la tabla corresponden a Lima (UTC−05:00).
Esta nota contiene observaciones derivadas; no incorpora historiales, prompts,
credenciales ni logs de usuario.

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

## Gaps del observador

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
la causa de transporte permanece sin resolver. Esta investigación no modifica
todavía esos tres comportamientos de producción.

## Compactación y continuación esperadas

El catálogo nativo usado por estas sesiones informa `context_window = 270000`,
`auto_compact_token_limit = 240000` y ventana efectiva de 240300. Está habilitado
`experimentalBiggerContext`. El último uso de ambos turnos estaba por debajo del
umbral de compactación; no se produjo una compactación en estos registros.
La [referencia oficial de Codex](https://learn.chatgpt.com/docs/config-file/config-reference)
define `model_auto_compact_token_limit` como umbral de tokens. No establece un
corte por haber transcurrido 30 minutos.

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

La validación de este diagnóstico consiste en correlacionar lecturas del DOM,
rollouts nativos, journal durable y telemetría del runtime. No se presenta como
un test RED/GREEN de una corrección, ni como aceptación de sesiones largas.
