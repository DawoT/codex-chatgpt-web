# ADR: continuidad por fases con chat temporal por defecto

Fecha: 2026-10-01. Riesgo/tamaño: **R2 × L**, por capacidades MCP, concurrencia,
persistencia y recuperación. Implementación directa solicitada por el usuario:
sin delegación ni firmas de revisores independientes. La evidencia local acredita
las pruebas descritas; no certifica una publicación ni la campaña extensa de aceptación.

## Decisión y alcance

Se conserva `useSavedChats: false` como valor por defecto. Un chat guardado sigue
siendo una opción explícita; guardar el chat no se utiliza como señal de capacidad
del modelo ni de salud del navegador. Tampoco se impone una duración universal de
20–40 minutos. El cierre por inactividad del launcher conserva su política existente.

Una misión tiene un thread nativo, varias respuestas/fases y, cuando es posible,
una conversación remota reutilizada. Cada capacidad MCP pertenece al turno exacto.
Las revisiones del contexto local y la identidad del chat remoto pueden avanzar
por separado. El journal SQLite existente es la única autoridad durable; los
resultados inmutables guardan checkpoints y fuentes completas localmente.

El número de herramientas sirve para recomendar una frontera segura de fase.
No ordena abrir otro chat ni fuerza compactación. Una llamada y su resultado cuentan
una sola vez en la clasificación de turno pesado. Una solicitud explícita de
compactación conserva la obligación de detener herramientas ordinarias y entregar
el checkpoint.

## Checkpoint y recuperación

Al finalizar una fase sustancial, el modelo puede enviar mediante Codex Native
`codex_tool_call` la operación reservada `codex.control.phase_checkpoint`, usando el
`turn_token` vigente y argumentos `{summary: <estado v2>}`. La operación no crea una
herramienta de trabajo ficticia ni se reenvía al catálogo del runtime exterior.

El flujo es `borrador validado → respuesta final confirmada → resultado inmutable
→ evento phase_checkpoint_committed`. La respuesta debe existir como resultado
completado de navegador en el journal y coincidir por hash. Los controles participan
en el cerco de finalización; una revocación durante el control invalida su respuesta.
Una generación, un turno o un resultado distintos no pueden confirmar el checkpoint.
Se emplea el mismo mailbox del manager, evitando una segunda autoridad concurrente.

La validación reutiliza el contrato de compactación v2 y sus comprobaciones de
procedencia/evidencia. Conserva requisitos literales, decisiones, bloqueos y siguiente
acción. El estado esencial tiene un presupuesto de **4000 tokens estimados**: un
exceso se rechaza, nunca se recorta silenciosamente. Los apéndices con copias del
pedido original/último se excluyen del handoff reducido; la fuente completa permanece
local y recuperable. Un pedido literal muy grande puede impedir este checkpoint
reducido: debe mantenerse la vía canónica, sin inventar una síntesis sustitutiva.

Para aplicar un checkpoint al siguiente turno se exige el mismo namespace/thread,
generación, modelo, esfuerzo/familia y padre assistant nativo exacto. Además debe
coincidir todo el prefijo de mensajes, ignorando exclusivamente timestamps. Se
preservan instrucciones developer, skills y el sufijo nuevo; `_rawBody` permanece
canónico. Un mismatch conserva el contexto original. En un chat remoto sano se
manda el sufijo de continuación. Si se perdió el chat temporal, la preparación
inicial utiliza ese estado reducido y el delta. Esto está comprobado con el
adaptador real y el broker Unix; el transporte de navegador se sustituye en esa
prueba, sin afirmar una ejecución real contra ChatGPT.

La operación reservada `codex.control.checkpoint_evidence` permite recuperar
`original_request`, `manifest`, `message:<índice>` o una referencia de observación.
Los argumentos son `{checkpoint_ref, ref, offset, limit}`. `checkpoint_ref: "current"`
consulta la fuente de la fase activa y proporciona referencias suministradas por el
puente antes de redactar afirmaciones verificadas. Una referencia SHA-256 consulta
un checkpoint confirmado de la misma sesión/generación. Las páginas usan caracteres,
6000 por defecto y como máximo 20000, con tamaño total, hash y siguiente offset.
La existencia de archivos de evidencia por sí sola no confiere autorización.

## Compactación local y conversación remota

El handoff de compactación se valida y persiste antes de decidir conservar el chat.
Para hacerlo se requiere una ruta retenida automática, actor durable y observación
del helper de la misma conversación: DOM conocido por debajo de 600000 caracteres,
sin recuperación/compactación pendiente y estimación remota conservadora por debajo
del 85% del umbral interno de 55000 tokens. Estos umbrales son heurísticos del puente,
no límites garantizados de OpenAI. Sin prueba de salud se mantiene la rotación segura.

`conversation_binding_recorded` vincula el checkpoint persistido con la clave remota,
su hash, modelo/esfuerzo/familia y estimación de contexto. Sólo un checkpoint
posteriormente aceptado habilita la reutilización. Un resumen alterado, otro modo o
una generación revocada no puede resolver ese vínculo. La continuación posterior a
compactación funciona incluso cuando Codex conserva únicamente el resumen y ya no
incluye ningún mensaje assistant: el vínculo aceptado autoriza enviar el delta.

El helper informa `context_health` con validación estricta. Al continuar la misma
conversación se limpia sólo la ráfaga de herramientas de esa respuesta y se acumula
el presupuesto físico enviado. Compactar no resetea DOM, latencia ni contexto remoto.
Únicamente una conversación física nueva reinicia esa presión antes de medir su DOM.
La decisión incorpora también el contexto canónico y el presupuesto previo; puede
sobreestimar deliberadamente para evitar que sucesivas compactaciones simulen espacio
remoto libre. Un chat perdido no permite repetir automáticamente efectos inciertos:
se conservan los gates de reconciliación del actor existente.

Sin checkpoint aplicable, las rutas de recuperación/compactación existentes conservan
el historial canónico. La compactación fresca sigue preservando los registros y puede
usar transporte multipart o rechazar el presupuesto antes de Send; no se afirma que
cualquier historial arbitrario pueda convertirse siempre en un handoff de 4000 tokens.
Luna mantiene su checkpoint propio y Zero Risk su contrato manual. El broker remoto
de DEV y los turnos host-only/subagent no adquieren los nuevos controles locales.

## Archivos y validación

- `phase-checkpoints.ts`: validación, fuente durable, reducción y lectura paginada.
- `phase-checkpoint-instruction.ts`: contrato de checkpoint y referencias para el modelo.
- `retained-conversation-binding.ts` y `remote-chat-retention.ts`: autorización durable
  y decisión conservadora de reutilización.
- `index.ts`, `adapter/compaction-flow.ts`, `conversation-key.ts`: integración con turnos,
  compactación y continuación, conservando la separación entre contenido local y chat.
- `session-actor/`, `turn-broker/`, `mcp/host-registry-tools.ts`: eventos, controles,
  aislamiento y confirmaciones bajo concurrencia.
- `browser-worker.ts`, `browser/context-pressure.ts`, helper/client/protocol:
  observación física y conservación de presión entre respuestas.

Pruebas focalizadas reproducibles desde la raíz:

```bash
bun test tests/phase-checkpoints.test.ts tests/phase-checkpoint-broker.test.ts \
  tests/retained-context-revision.test.ts tests/remote-chat-retention.test.ts \
  tests/browser-context-pressure.test.ts tests/browser-worker-defects.test.ts \
  tests/compaction-policy.test.ts tests/compaction-fast-path-budget.test.ts \
  tests/graceful-yield-compaction.test.ts tests/retained-compaction.test.ts
bun run typecheck
bun run lint
bun run check:refactor-gates
bun test ./tests
bun run launcher:test
bun run test:browser-contracts
bun run scripts/build-development-runtime.ts
```

Los resultados exactos, hashes, intentos fallidos y artefacto candidato se registran
separadamente en `docs/evidence/temporary-chat-continuity-20261001/verification.json`.
Las pruebas del navegador usan fixtures locales; las omitidas por plataforma y los
warnings preexistentes no se presentan como una aceptación de cuenta real.

## Activación y límites de la entrega

El build de desarrollo publica un directorio nuevo e inmutable en `.launcher-runtime/`
y verifica el par CLI/helper. Prepararlo no cambia el proceso ya abierto. El launcher
fija su snapshot durante su propia vida: para aplicar cambios de fuente hay que cerrar
y volver a abrir el launcher completo después de terminar las sesiones activas; reiniciar
solamente su servidor puede volver a arrancar el snapshot anterior. Verificar `/healthz`
y la identidad del par al reabrir antes de atribuirle estas mejoras.

El usuario reinició el launcher/servidor durante esta implementación. La observación
posterior comprobó el candidato vigente: daemon PID `320816`, generación
`33b0137b-f863-431c-8c77-30b98184d99e`, artifact-set
`43079493681aea5d320e87d384865b3a9dd95779afe1b0c420983e09a25b16c9`.
CLI y helper informaron `paired_manifest_verified` y sus hashes coincidieron con
el manifiesto congelado. No se reinició ni drenó ese proceso mediante las pruebas.

Se ejecutó además un canary breve real contra ChatGPT mediante la API del daemon
y el navegador del launcher, con un thread y workspace temporales de prueba.
No se lanzó otro agente Codex ni se ejecutaron herramientas ordinarias. Tres
respuestas conservaron un marcador alfanumérico; el journal registró tres operaciones
completadas, tres activaciones Send y dos checkpoints confirmados. Los turnos uno
y dos compartieron superficie. Después de liberar exclusivamente el chat de prueba,
el tercer turno adquirió una superficie nueva y mantuvo el marcador. Un replay local
del contexto canónico persistido de ese turno comprobó que el checkpoint anterior
era aplicable y reducía siete mensajes a tres; ese replay no es una medición del DOM
real enviado. Las dos conversaciones propias quedaron liberadas al terminar.

Dos intentos de construcción del canary quedan declarados: el primero usó contenido
string para el entorno, que no acredita el envelope nativo confiable; el segundo
comparó literalmente un marcador con guion bajo escapado por Markdown. Este segundo
intento ya confirmó un checkpoint real. Se corrigió el fixture, sin modificar el
candidato. Los probes HTTP comprobaron salud 200, modelo no habilitado 400 y drain
sin credencial válida 401; el servicio siguió aceptando turnos y su telemetría
reportó cero escrituras fallidas y cero registros descartados.

El canary breve no acredita la campaña de dos sesiones de más de 22 minutos y
veinte compactaciones del handoff histórico, ni un benchmark de sesiones largas.
La compactación local conservando chat se valida con pruebas de integración locales,
no con este canary. La aprobación independiente de release sigue sin acreditarse.
No se promete una mejora de rendimiento que aún no se ha medido.

## Revisión upstream y evolución propuesta: interrupción sin perder conversación

Revisión directa del 2026-10-01, sin delegación. **Esta sección es una propuesta;
no modifica el runtime ni acredita la implementación de pausa/reanudación.**
La corrección completa afecta capacidades, persistencia y recuperación: R2 × L.
La actualización documental y la caracterización aislada no publican un candidato.

### Fuente y comportamiento comprobado

Se descargó `openai/codex` fuera del proyecto, en
`/tmp/cgw-upstream-codex-20261001-sVr1X8`. Los rollouts afectados identifican
Codex **0.159.3**; el binario `codex` disponible en el shell informa **0.159.2**.
La referencia principal es `rust-v0.159.3`, commit
`01fc69f4026735edfdf6789820549727a4867b11`. También se contrastaron
`rust-v0.159.2` (`ff6aec96948b70d94983af2641a6b67c94faeff5`) y `main`
(`960e878df4bf87b9d7fa0849f14561d7cdcca942`), sin ejecutar otro agente ni compilar
el cliente Rust. Las conclusiones siguientes describen la versión 0.159.3;
la comparación con main no acredita compatibilidad completa con versiones futuras.

- [Interrupción nativa](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/core/src/tasks/mod.rs#L922):
  cancela el trabajo del turno, ejecuta su hook y emite `TurnAborted`. Conserva
  el hilo y su historial; según configuración, persiste también un marcador de
  interrupción antes del evento. Detener no equivale a suspender una generación
  para continuar exactamente el mismo stream: la continuación será otro turno.
- [Herramientas durante la cancelación](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/core/src/tools/parallel.rs#L250):
  conserva un resultado que ya terminó; en otro caso cancela el despacho y puede
  producir un resultado de interrupción con el mismo `call_id`. Cancelar no prueba
  que un efecto externo se haya revertido ni que un proceso secundario haya parado.
- [Compactación por presión local](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/core/src/session/turn.rs#L565):
  se evalúa dentro del turno según uso de contexto y necesidad de continuación.
  Cambia la ventana de contexto del mismo hilo. No implica crear otro chat web.
- [Contrato de compactación remota](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/core/src/compact_remote_v2.rs#L444):
  requiere exactamente un item de compactación y `response.completed`. Un stream
  cerrado antes no constituye un checkpoint aceptado. El puente debe mantener
  ese contrato aunque conserve la conversación física de ChatGPT.

### Gaps que condicionan la propuesta

La ruta actual de interrupción revoca la generación del actor y cancela el turno.
El browser orchestrator y `browser-host.cjs` retienen una conversación sólo tras
`completed`; un abort libera la superficie. La pulsación de Detener es best effort
y no aporta un recibo durable de generación realmente detenida.

El journal puede reconciliar una operación incierta como `not_sent` o `completed`.
Un Send aceptado, sin respuesta final, no satisface ninguna de esas condiciones.
Después de ESC puede quedar bloqueando nuevos efectos, aunque el navegador ya
se haya cerrado. Así se explica el error de reconciliación observado y el fallo
posterior de compactación. No debe resolverse borrando el journal, declarando un
éxito inexistente ni repitiendo Send.

Además, una caracterización aislada de `TurnBroker` reprodujo esta secuencia:
registrar token A → revocarlo con `AbortError` → registrar B para el mismo thread,
con otro trace y sin alias explícito → resolver y reclamar A. Ambos pasos finales
se aceptaron contra B. No se invocó ninguna herramienta, se utilizó un socket y
workspace propios de prueba y no se conectó al navegador ni al daemon real.
La causa está en la recuperación por thread de `turn-broker/admission.ts` y la
conservación de esa filiación en `TurnBroker.revoke`. Esto demuestra readmisión
de una capacidad interrumpida en el broker; no acredita un efecto duplicado real.
Los alias necesarios para continuaciones válidas deben conservarse sólo dentro
del alcance autorizado; una revocación por interrupción debe ser terminal.

### Arquitectura objetivo sobre las autoridades existentes

Mantener Responses/SSE como interfaz con Codex y el actor/journal existente como
autoridad de operaciones. El runtime MCP propio de Codex y el conector MCP que
utiliza ChatGPT web tienen ciclos de vida distintos: no equiparar sus sesiones.
El túnel y los servicios pueden seguir vivos mientras cambian turnos y capacidades.

Separar explícitamente cuatro identidades dentro del mismo actor: hilo nativo,
época de ejecución del turno, conversación/superficie remota y operación con sus
`call_id` y recibos. La conversación puede sobrevivir a una época; su supervivencia
no conserva permisos del turno anterior. Codex conserva el historial canónico;
el journal conserva evidencia y checkpoints; el chat web es una superficie de
ejecución reutilizable, cuya permanencia no debe ser requisito de recuperación.

Flujo propuesto para ESC:

1. Persistir la solicitud de interrupción y cerrar la admisión de nuevas llamadas
   de esa época. El hook acusa recibo pronto; la confirmación física sucede de
   forma asíncrona y no exige generar un resumen con el modelo durante ESC.
2. Solicitar Detener sobre la respuesta/superficie exacta y recoger confirmación.
   Registrar separadamente qué herramientas terminaron, cuáles se interrumpieron
   y cuáles siguen teniendo efectos o entrega inciertos. Una respuesta tardía
   sólo puede actualizar su operación original.
3. Asentar un resultado durable de interrupción confirmada, distinto de éxito
   y de `not_sent`. Retener la conversación como interrumpida. Hasta acreditar
   la detención y resolver incertidumbres pertinentes, no admitir otra generación.
4. Al continuar, crear una época y capacidad nuevas dentro del mismo hilo. Si la
   conversación sigue sana y coincide cuenta/modelo/esfuerzo/entorno autorizado,
   enviar el delta y el recibo de interrupción a esa conversación. No reutilizar
   el token anterior ni ejecutar nuevamente llamadas ya completadas.

Si Detener falla, conservar la superficie y la evidencia como pendientes de
reconciliación. Si se perdió el chat, preparar otro mediante checkpoint válido y
delta después de resolver efectos ambiguos. Cerrar conversación debe ser una
acción explícita y distinta de Detener. No prometer que un chat temporal sobreviva
al cierre del navegador o al reinicio del helper.

La continuación después de ESC necesita un cursor durable nuevo: padre/prefijo
nativo, revisión, época, identidad de respuesta remota y recibos por llamada.
El último assistant final por sí solo no acredita una respuesta parcial interrumpida.
Una transcripción parcial puede conservarse como evidencia, sin convertirla en
un checkpoint confirmado ni en autoridad para repetir efectos.

Mantener tres controles independientes de presión:

- Contexto local de Codex: informar uso veraz y respetar su compactación. Se puede
  compactar ese contexto y seguir en el mismo chat web cuando haya vínculo válido.
- Contexto remoto: contabilizar lo efectivamente añadido al chat, incluidos prompts
  y resultados MCP. Un delta reenviado cuenta otra vez si realmente se entrega;
  una compactación local no pone este contador en cero. La política actual es
  conservadora y puede sobreestimar: calibrar antes de sustituir sus límites.
- Salud de superficie: progreso de la respuesta y herramientas, latencia y DOM
  observado. Detener visible, `navigator.onLine` o un servidor saludable no prueban
  progreso. El aviso localizado de conexión interrumpida requiere una ventana
  acotada de recuperación; no rotar una tarea sana sólo por su duración.

El chat temporal sigue siendo el valor por defecto. Guardar chats puede facilitar
recuperar una conversación después de perder su superficie, pero no amplía por sí
solo la ventana de contexto ni acredita una mejora de rendimiento. Requiere opción
explícita por sus implicaciones de retención y privacidad.

El handoff reducido conserva objetivo/requisitos, decisiones, estado verificable,
bloqueos y siguiente paso, con referencias de evidencia recuperables. No copiar el
historial completo entre chats por defecto. El presupuesto existente de 4000 tokens
es un límite de validación, no una excusa para truncar instrucciones esenciales.
Ante incompatibilidad o pérdida de procedencia, conservar la vía canónica segura.

### Orden de implementación y aceptación con TDD

1. **Interrupción y aislamiento.** RED de revocación terminal frente al alias por
   thread; RED de ESC con Send aceptado y sin final. Incorporar el resultado durable
   de interrupción, confirmación de Detener y retención. Mantener verdes los alias
   legítimos, el aislamiento entre hilos y los gates de efectos inciertos.
2. **Continuación y observación.** RED de nueva época en el mismo chat con delta,
   respuesta parcial sin final, resultados tardíos y aviso de conexión interrumpida
   con Detener visible. Cubrir recuperación transitoria, interrupción sostenida,
   pérdida de superficie y discrepancias de identidad. No introducir regeneración
   automática como solución al fallo de red.
3. **Presión y compatibilidad.** Verificar compactación local retenida, rotación con
   handoff validado, contadores físicos sin reset falso y contrato SSE. Añadir pruebas
   de reinicio entre solicitud/confirmación, replay y pérdida de conexión. Validar
   las versiones objetivo de Codex; leer main no sustituye esas pruebas.

En cada corte: RED verificable → cambio mínimo → GREEN → typecheck/lint/gates
proporcionales. Si cambia la persistencia, probar migración y recuperación del
journal existente. Favorecer evolución interna negociada; un cambio de ABI público
MCP necesita el versionado e identidad de conector previstos por el proyecto.
Antes de activar un candidato, comprobar el par CLI/helper y ausencia de trabajo
activo. La aceptación real debe medir continuación tras ESC, ninguna llamada
duplicada, ninguna readmisión de tokens revocados y retorno de recursos al baseline.
La campaña extensa del handoff permanece pendiente; esta investigación no la cumple.
