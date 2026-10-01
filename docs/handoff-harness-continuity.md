# Prompt de handoff — aceptación operativa del harness de continuidad

Copia este documento como instrucción inicial del siguiente agente. Es un handoff
técnico de trabajo existente, no una certificación de release ni una orden de
reiniciar un runtime activo.

## 1. Rol, objetivo y definición de terminado

Actúa como Staff Software Engineer responsable de cerrar la aceptación operativa
del refactor de continuidad del agente de codificación en `codex-chatgpt-web`.
Continúa desde la implementación verificada; no reinicies el proyecto ni sustituyas
sus autoridades durables por una orquestación nueva.

El objetivo pendiente es demostrar, con un modelo y una sesión ChatGPT reales,
que la compactación conserva la tarea, sus requisitos y la evidencia, que el agente
retoma la siguiente acción correcta, que ejecuta herramientas y verificaciones
reales y que entrega el resultado sin duplicar envíos ni dejar recursos activos.

Para terminar deben existir:

1. Un candidato identificado por commit, artefactos cargados, protocol y generación.
2. Una ventana demostrablemente inactiva para activar ese candidato.
3. Dos sesiones independientes reales, cada una de duración estrictamente mayor
   que 22 minutos, con trabajo efectivo del agente y navegador.
4. Veinte (20) compactaciones reales con continuación, diez por sesión, que cubran
   retained y fallback con rutas observadas, no inferidas.
5. Evaluación independiente de fidelidad, ejecución y cierre para cada checkpoint.
6. Evidencia de limpieza, salud de telemetría y ausencia de reenvíos automáticos
   después de un Send ambiguo o un timeout posterior al envío.
7. Un informe final reproducible que distinga aceptación local, canarios,
   cobertura faltante y decisión de expansión o rollback.

La preparación y lectura pueden avanzar autónomamente. La activación está
condicionada por la inactividad exigida en el plan original. Si no puedes demostrar
esa condición, prepara todo lo revisable y comunica el bloqueo concreto; no mates
trabajo ajeno para fabricar la ventana. No merges ni publiques una release como
consecuencia implícita de que los canarios pasen.

## 2. Estado de partida verificado

### Actualización 2026-10-01 — preflight de canario implementado

El trabajo de continuación añadió el seam mínimo de quiescencia que faltaba y un
preflight reproducible. El candidato local actual es
`98bef093fa2b9614939aae9e164a6a1d416ec74b`, con árbol `src`
`a045530001a0cd714700467a150a67099890b800` y source digest del gate
`4e3e339fb70356634df03d38fa5ae06dcf310366d2a9c0104c47e081b72eb33d`.
Los bundles in-memory medidos son CLI
`fc6d2eab0070738e6b512c8eeef70280e084459d3a4966cd201a59b9e39a3fc3`
y browser helper
`c93bd474d6830bd4750d0a8fb656c4fe71d73a59fd7dc57defafb37d1d153011`.

El helper que estaba cargado al preparar rollback tenía SHA-256
`14af41a053b7c7fed14eefe9dd2b46d19333f68b69c8a83c2bbd5fb5989d16b7`.
El candidato no se activó: el runtime observado seguía atendiendo el turno de esta
sesión y cargaba artefactos anteriores. No drenes, reinicies ni reemplaces ese
runtime para fabricar una ventana inactiva.

`scripts/harness-live-canary.ts` fija veinte checkpoints en dos sesiones, verifica
hashes/candidato/rollback y evalúa la ventana de inactividad de forma fail-closed.
`/healthz` del candidato expone `resource_diagnostics` y `telemetry_health` con
contadores agregados de waiters, timers, transacciones, persistencias, releases
retenidos y cola de telemetría. El runtime antiguo ya cargado no puede exponer esas
claves hasta una activación legítima; esa ausencia debe conservarse como bloqueo,
no reinterpretarse como cero.

- Repositorio esperado: `/home/deuz/projects/codex-chatgpt-web`. Algunas superficies
  muestran `/home/deuz/Proyectos/codex-chatgpt-web`; resuelve `pwd` y el root Git
  antes de usar rutas absolutas. No crees un segundo checkout por esa diferencia.
- Rama: `refactor/harness-continuity`.
- HEAD anterior a la creación de este handoff:
  `a5388acfb6491e5044909f5b25eef6292d51c884`.
- Base del refactor: `main` local en `9c6e02a`. No se hizo pull/rebase ni se
  resolvió la divergencia del remoto. Reinspecciona antes de cualquier integración.
- Candidato previo del reporte final de gates:
  `bedd09464cd5975963c90b422b7387e1b4b63077`. Fue sustituido por `98bef09`
  porque la aceptación operacional requería superficies de quiescencia adicionales.
- El commit `a5388ac` añadió únicamente documentación y reportes; no modificó
  producción, scripts ni tests respecto al candidato medido.
- Árbol de producción previo verificado (`git rev-parse HEAD:src`):
  `a01fd551d77be8105e014cfa70185d0f383c9f68`. El árbol actual medido es
  `a045530001a0cd714700467a150a67099890b800`.
- Source digest previo del gate:
  `f1c77ad7e12fa7b08dc810f46c9d6127298183d68b22d87f53fe431739d2be1f`.
  El digest actual es
  `4e3e339fb70356634df03d38fa5ae06dcf310366d2a9c0104c47e081b72eb33d`.
  La función del gate incluye HEAD en este digest: un commit sólo documental puede
  cambiarlo sin cambiar producción. Comprueba ambas identidades, no confundas eso
  con alteración del código.
- Durante el cierre había un runtime de desarrollo en ejecución. Admission no
  mostraba activos ni esperas; `service status` no identificaba un servicio
  instalado. Esas lecturas no demostraban inactividad física.
- Candidato no activado, canarios reales ejecutados: **0**; sesiones largas reales
  acreditadas: **0**. No se reinició, desplegó ni sustituyó el helper instalado.

No dependas de PIDs, puertos, subagentes anteriores o ficheros `/tmp` de otra
sesión. Todo estado operacional es histórico y requiere lectura nueva.

## 3. Lecturas obligatorias y mapa de código

Primero lee las instrucciones del usuario y las `AGENTS.md` que existan en el
checkout. Usa las skills pertinentes disponibles, especialmente staff-harness,
TDD y Playwright para cambios de concurrencia o navegador. El riesgo del trabajo
es **R2×L** por lifecycle, persistencia y activación.

Lee completos estos documentos y reportes:

- `docs/harness-continuity.md`: arquitectura, revisiones, runbook y límites.
- `docs/evidence/harness-continuity-verification.json`: cobertura y alcance.
- `docs/evidence/harness-continuity-gates.json`: suites, runtime/browser,
  hashes de builds en memoria y muestras p50/p95.
- `docs/evidence/harness-continuity-prompts.json`: comparación real con main.
- `docs/compaction-observability.md`, `docs/release-validation.md` y
  `docs/architecture.md`: operación, evidencia y contratos existentes.

Mapa de superficies de producción que debes comprender antes de instrumentar:

| Responsabilidad | Archivos |
| --- | --- |
| Compilación y provenance | `src/adapters/chatgpt-web/prompt/compiler.ts`, `prompt/types.ts`, `prompt/sanitization.ts`, `src/types.ts` |
| Medición y límites | `input-tokens.ts`, `browser/multipart-plan.ts`, `compaction-repair.ts`, `src/server/host-prompt-preflight.ts` |
| Política única de checkpoint | `compaction-policy.ts`, `compaction-handoff.ts`, `adapter/compaction-flow.ts`, `src/responses/compaction.ts` |
| Persistencia y recuperación | `adapter/compaction-checkpoint.ts`, `session-actor.ts`, `turn-execution/`, `rolling-checkpoint.ts` |
| Turno, documento y despertar | `browser/turn-events.ts`, `turn-page-binding.ts`, `turn-wake.ts`, `turn-completion-loop.ts`, `browser-worker.ts` |
| Cancelación renderer y feeds | `browser/dom-signal.ts`, `dom-events.ts`, `submission-observer.ts`, `turn-execution/feeds.ts`, `compaction-transaction.ts` |
| Causa terminal y observabilidad | `turn-terminal.ts`, `mcp-observation.ts`, `mcp-telemetry.ts`, `telemetry-trace.ts`, `turn-broker.ts`, `turn-broker/tool-queue.ts`, `mcp-server.ts` |
| Identidad cargada | `src/runtime-identity.ts` y las superficies diagnósticas existentes del launcher/helper |
| Gates y evaluación local | `scripts/check-harness-continuity.ts`, `compare-harness-prompts.ts`, `compaction-canary-report.ts`, `tests/fixtures/continuity-replay.ts` |

Las rutas abreviadas de la tabla pertenecen a `src/adapters/chatgpt-web/` salvo
cuando llevan prefijo explícito `src/`, `scripts/` o `tests/`.

## 4. Invariantes implementados que debes preservar

### 4.1 Compilación y fidelidad

`PromptCompilationResult` v1 acompaña el payload con source hash, payload hash,
hashes de secciones, transformaciones y medición congelada. En multipart la
identidad incluye parts, commit, imágenes y skill files; no basta hashear el commit.
La memoización es local al objeto y se invalida si cambia contenido/modelo/adjuntos.

Se preservan instrucciones system/developer/user, código, rutas, IDs y evidencia.
La retirada de handles sólo opera sobre campos identificados de `broker_metadata`.
La eliminación de contratos superseded exige provenance explícita
`generatedContract`; no puede inferirse de un tag que aparece en texto del usuario.
El pruning heurístico permanece sin cablear en la compilación ordinaria.

El fallback ya no trunca system/user. Se usa staging sin pérdida cuando cabe;
si el transporte no representa el contenido, debe fallar explícitamente antes
de aceptar un checkpoint. No reintroduzcas truncado para hacer pasar un canario.

### 4.2 Compactación y journal

La política compartida es:

`normalize → parse → validate → repair (máximo una vez) → revalidate → persist → accept → deliver`.

Normalización protege strings citados y código y debe ser idempotente. La inspección
strict conserva defectos como `original_request_ref` ausente/incorrecto. No fabrica
requisitos, estados verificados, evidencias ni obligaciones. Algunas exportaciones
legacy de autoheal/canonicalización siguen existiendo para compatibilidad interna;
su disponibilidad no autoriza a reincorporarlas a la política strict productiva.

Retained, rescate y fallback comparten un único presupuesto de reparación por
operación. El rescate devuelve el draft normalizado y lo somete a esa política.
El checkpoint sigue siendo v2. El journal existente conserva autoridad sobre
persistencia y recuperación; no añadas un store competidor.

Si abort llega durante un write local, se journaliza el estado persistido para
recovery y no se acepta nueva historia. No declares ese write inexistente ni una
entrega exitosa. Handoffs recibidos sin consumir mantienen TTL y consumo único.

### 4.3 Lifecycle, identidad y envío

El bus pertenece al turno; expone sequence, documentGeneration y afterSequence.
Waits después de dispose o con señal abortada fallan inmediatamente. Un predicado
defectuoso sólo rechaza a su waiter. Un cursor vencido exige resynchronization.

Las esperas productivas suscriben antes de observar el snapshot. DOM, progreso
externo y red despiertan la FSM; no acreditan finalización. La FSM y el completion
fence conservan esa autoridad. Los perdedores de una carrera se cancelan y liberan.

Rebind desmonta el listener de la Page anterior, incrementa generación y conserva
identidad del turno. La selección depende de identidad estable y submission
demostrado. La ambigüedad permanece explícita. **Un timeout posterior a Send no
autoriza un reenvío automático.**

Las esperas de elementos reclaman ownership del ElementHandle antes del handoff
de su Promise. Abort temprano/tardío dispone el handle y libera observer/timer.
No regreses a una carrera que sólo cancela la Promise Node y deja vivo el renderer.

### 4.4 Telemetría y locks

El resultado funcional y la observabilidad son independientes. `reply_sent` acredita
entrega, no ejecución; `result_received` es un hecho diferente. Cancelación MCP
retira la correlación incluso si no llega una respuesta posterior.

La telemetría tiene límites de cantidad/bytes, flush acotado, health y fallback
estructurado a stderr. Un descarte por file budget degrada health. No ocultes
drops para obtener un reporte verde. Causas terminales: user_cancelled,
handoff_accepted, deadline, transport, internal_failure, además de completed.

Locks nuevos identifican PID, host, generación y owner. La recuperación exige
runtime inactivo y propietario local muerto comprobado; revalida antes de mover
el lock y conserva su diagnóstico. Locks legacy/ambiguos no se eliminan. Un callback
constante `true` usado por un fixture no es evidencia operativa de inactividad.

## 5. Evidencia local existente y sus límites

| Verificación | Resultado registrado |
| --- | --- |
| Suite completa con cobertura | 2.225 pass, 14 skip, 0 fail; 12.294 assertions; 210,04 s |
| Cobertura impresa por Bun | Funciones 82,87 %; líneas 82,88 % |
| Contratos Chrome obligatorios | 37 pass, 0 fail; 228 assertions; 261,54 s |
| Gates finales seriales | 242 pass, cero skips/fallos; 12 suites; stableBuild true |
| Contrato worker | 1.754,8 ms; presupuesto inferior a 5.000 ms |
| Checks | Typecheck y gates estructurales verdes; lint cero errores y 88 warnings |
| Revisión | Dos revisiones semánticas independientes; sin aislamiento mecánico ni aprobación humana de merge acreditados |

La cobertura completa precede al test adicional de recuperación de owner muerto;
producción no cambió. Ese test pasó en su suite y en el gate final. No atribuyas
su cobertura a una ejecución completa que no lo incluyó. Las cifras impresas de
cobertura y los totales lcov usan agregaciones distintas; cita la medida utilizada.

De los 14 skips, doce contratos opcionales de Chrome se ejecutaron después en el
gate obligatorio de navegador. Los otros dos son plataforma/servicio opcionales.
Una ejecución conjunta con Chrome explícito tuvo fallos esperando navegación tras
clic; los casos aislados pasaron en main y después los 37 contratos pasaron en el
candidato. La causa de esa variabilidad no quedó demostrada. Evita concurrencia
de suites pesadas, no reduzcas asserts ni escondas fallos mediante reruns sin razón.

El replay ejercita Chromium real, hidratación, virtualización, ACK tardío/perdido,
Send ambiguo, persist/reload y 100 ciclos de recursos Node y otros 100 renderer.
Usa fixtures controlados; no reconstruye el incidente remoto original ni acredita
roundtrip real daemon/helper/MCP/ChatGPT. Sus contadores no son prueba universal de
ausencia de fugas de heap, timers o conexiones de todo el proceso.

La evaluación coding local ejecutó un baseline en Bun y preservó resultados,
requisitos y próxima acción a través de un checkpoint v2 escrito para el escenario.
No demuestra que un modelo produjera ese checkpoint o resolviera la tarea después
de compactar. Esa evaluación end-to-end está pendiente.

La comparación real del compilador con `9c6e02a` pasó de 8/12 a 12/12 literales
preservados. Los payloads crecieron +16/+75/+262/+16 bytes y los tokens estimados
+0/+16/+67/+10. Son cuatro escenarios, cinco muestras y latencia del compilador
más medición, no latencia de ChatGPT, facturación, tokens reportados ni cache hits.
Los builds del gate son CLI/helper en memoria, packages external, minify false;
no son prueba de que esos artefactos estén instalados o cargados.

## 6. Secuencia de trabajo pendiente

### Fase A — Reconocimiento sin mutar el runtime

1. Relee Git, archivos, runtimes, browser instalado, package scripts y puertos.
   Detecta cambios del usuario; no reset, force checkout ni pull/rebase implícitos.
2. Resuelve la ruta real del launcher, helper, daemon y Codex CLI. Descubre modelo,
   cuenta y capabilities disponibles sin volcar credenciales. No asumas que una
   capacidad documentada de Responses API existe en ChatGPT web.
3. Localiza journals, JSONL, stderr y locks actuales en el entorno realmente usado.
   Verifica permisos/owners y salud. La existencia de un lock sin JSONL no demuestra
   dónde falló MCP. No elimines journals o locks ambiguos.
4. Comprueba el source tree contra el recibo y decide qué checks necesitan repetir
   por cambios reales. No reclames equivalencia sólo porque coincide el branch name.

Lecturas auxiliares conocidas, sin reinicio:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git rev-parse HEAD:src
bun run src/cli.ts --help
bun run src/cli.ts admission status --json
bun run src/cli.ts service status
```

### Fase B — Preparar evaluación e instrumentación revisables

Antes de activar nada, prepara un manifiesto de canario y una matriz de evaluación.
Usa un workspace de evaluación aislado; fija requisitos antes de ejecutar la tarea.
Cada caso debe incluir IDs estables, tests funcionales reales, archivos previstos,
restricciones, evidencia previa y siguiente acción. Incluye continuidad de una
tarea de código, una obligación pendiente y una verificación aún no realizada;
no reduzcas todos los casos a comprobar el formato del resumen.

Para cada una de las veinte compactaciones registra al menos:

- Session/thread/turn/trace/operation IDs y ruta observada retained/fallback.
- Commit, artifact SHA-256, protocol y generación realmente cargados.
- Inicio/fin UTC y duración monotónica de la sesión y operación.
- Modelo/cuenta/capabilities seleccionados y límites efectivamente utilizados.
- Input, requisitos antes/después, original request, latest request y checkpoint v2.
- Estado de cada requisito, referencias de evidencia y resultados reales de tools.
- Próxima acción prevista y primera acción efectiva después de compactar.
- Comandos finales ejecutados, exit codes y resultado funcional de la tarea.
- Estados received/validated/persisted/accepted/delivered y outcome de cada fase.
- Submission evidence, número de Sends, secuencias/generación y causa terminal.
- Baseline/final de waiters, listeners, timers, transacciones y conexiones observables.
- Health, pending records/bytes, drops, flush y destino de fallback de telemetría.

Guarda el contenido de evaluación sólo en evidencia local privada apropiada;
mantén la telemetría productiva libre de prompts/secretos. En reportes compartibles
usa referencias o hashes y extractos sanitizados que sigan siendo auditables.

Si falta una superficie para demostrar un requisito, implementa primero un seam
interno mínimo y verificable. Conserva nombres/esquemas públicos MCP y checkpoint
v2. No abras un endpoint privilegiado para facilitar el test. Bugs RED→GREEN;
extracciones con caracterización; commits atómicos y checks afectados. Reevalúa
riesgo y actualiza evidencia si cambia producción.

Scripts de smoke existentes pueden usar mocks, modificar integración o asumir rutas
macOS. Léelos antes de invocarlos. `smoke:interrupt`, `smoke:cancel` o el replay
coding no sustituyen una compactación real. No inventes un comando de canario que
el repo todavía no proporciona.

### Fase C — Demostrar inactividad y congelar candidato/rollback

No uses admission vacío como único gate. Debes comprobar ausencia de requests y
streams abiertos, ejecuciones y esperas admitidas, ownership de browser/helper,
teardown físico, retained releases y persistencias pendientes. Flush debe terminar
con cola vacía. Un proceso idle puede existir; su mera existencia o inexistencia
tampoco prueba por sí sola que las autoridades del runtime estén libres.

Registra cómo se verificó cada condición y sobre qué runtime/generación. Si no
existen superficies suficientes, explicita lo que falta y pide sólo la intervención
necesaria del operador después de preparar el candidato y el plan concretos.

Conserva el artefacto previo y el procedimiento de rollback antes de instalar.
Valida hashes y compatibilidad. No borres journals, sesiones o configuración para
hacer que el candidato arranque. Inspecciona el procedimiento de instalación real;
no ejecutes ciegamente `deploy`.

**`build:bundles` copia el helper a `.launcher-runtime`; `deploy` instala y reinicia.**
No los ejecutes con runtime activo. El gate de continuidad construye en memoria
y no necesita esa copia. El empaquetador existente puede requerir árbol limpio y
produce artefactos distintos de los builds sin minificar del gate; registra los
hashes efectivamente instalados, no reutilices hashes de otro tipo de build.

Tras instalar dentro de la ventana inactiva, verifica la identidad de procesos
realmente cargados. Un `buildCommit` puede ser null fuera del layout con manifest;
no lo fabriques. Cruza artifact hash y generación con el candidato preparado.

### Fase D — Ejecutar sesiones reales y evaluar continuidad

Realiza dos sesiones independientes de más de 22 minutos, diez compactaciones por
sesión, con actividad efectiva del agente. No cuentan sleep, relojes virtuales ni
timestamps de fixtures. No conviertas las mismas veinte operaciones en muestras
adicionales mediante duplicación de logs. Registra rutas observadas y distribución.

En cada compactación verifica persistencia antes de aceptación y que la continuación
retome la tarea correcta. Comprueba requisitos completos, evidencias conservadas,
obligaciones pendientes y ausencia de logros inventados. Observa ejecución de tools
y tests finales reales; formato v2 válido es necesario pero insuficiente.

Mide resultado y eficiencia por separado. Reporta éxito de tarea, fidelidad y fallos
independientemente de tokens/bytes/latencias. Para comparar usa los mismos casos y
runtime identificado; no aceptes reducción de contexto que empeore éxito/fidelidad.
P50/p95 deben derivarse de muestras guardadas, con población y método explícitos.

La cobertura de incidentes debe registrar hidratación/virtualización, ACK tardío o
perdido y submission ambiguo cuando se observen realmente o exista fault injection
soportado y autorizado. Conserva la incertidumbre si no ocurre un caso. No fuerces
reenvíos para salir de un timeout y no cuentes el fixture local como incidente real.

### Fase E — Analizar, decidir y cerrar

El acumulador existente se usa sobre el log real exclusivo de canario:

```bash
bun run scripts/compaction-canary-report.ts /ruta/local/continuity-live-canary.log
```

Exige veinte traces distintos durables, cobertura retained/fallback y cero failed,
rejected, incomplete, malformedEvents, mixedBuildTraces y
deliveredWithoutLocalPersistence. Revisa raw events y journal además del agregado:
el acumulador comprueba hechos de fases/outcomes e identidad; no valida duración
de sesión, causalidad completa, fidelidad, éxito de tarea ni Send único.

Si un canario falla, detén expansión, guarda diagnóstico y conserva journals. Si
corresponde rollback, ejecuta únicamente con runtime nuevamente inactivo y valida
el artefacto previo cargado. No marques el plan completo porque sólo pasó el gate
local. Identifica acceptance achieved/pending/failed y causas con evidencia.

## 7. Verificación local y trabajo con dos agentes

La organización original usa dos ownerships:

- A: kernel/productivo — prompt, compaction, worker, bus, feeds y lifecycle, con
  regresiones específicas declaradas en cada dispatch.
- B: tests/infra — fixtures, replay, evaluación, gates, evidencia y revisión readonly
  de producción, con lista de archivos exclusiva declarada antes de editar.

Los agentes anteriores no son recursos disponibles garantizados. Si delegas,
recrea briefs y ownership explícitos. No atribuyas aislamiento mecánico a una
instrucción de no editar archivos. No ejecutes suites pesadas concurrentemente.
La revisión humana previa al merge exigida por el runbook sigue pendiente.

Comandos locales conocidos, en serie:

```bash
bun run typecheck
bun run lint
bun run check:refactor-gates
bun test ./tests --coverage
CHATGPT_DOM_TEST_BROWSER=/usr/bin/google-chrome bun run test:browser-contracts
bun run scripts/check-harness-continuity.ts --samples=5 --report=/tmp/continuity-candidate.json
```

El browser del último gate de continuidad fue Chromium instalado por Playwright;
el gate obligatorio de browser usó `/usr/bin/google-chrome`. Lee los reportes para
atribuir resultados al ejecutable correcto. Revalida disponibilidad en el entorno
nuevo. El gate exige browser ejecutable y cero skips en sus suites focalizadas.

Para comparación del compilador existe `scripts/compare-harness-prompts.ts` con
`--baseline-root=`. Un worktree temporal en `/tmp/continuity-baseline-9c6e02a` pudo
existir; comprueba `git worktree list`. No supongas que sigue presente ni borres
checkouts desconocidos. La comparación del gate con `--compare=` exige mismo
fixture, runtime, escenarios y sample count, ambos reportes verdes y estables.

## 8. Entregables y siguiente acción concreta

Produce un manifiesto del canario, matriz de tareas/criterios, evidencia por sesión
y checkpoint, reportes agregados, inventario de recursos y una decisión operacional
con rollback documentado. Versiona scripts/tests y documentación útiles, sin
credenciales ni prompts privados. Mantén commits convencionales y atómicos.

El informe final debe distinguir:

1. Qué cambió desde el candidato local y por qué, con archivos/commits.
2. Qué se probó realmente y qué sigue siendo fixture o inferencia.
3. Resultado de las veinte continuaciones y duración efectiva de ambas sesiones.
4. Éxito funcional/fidelidad y costes, con muestras y denominadores.
5. Estado de recursos/telemetría, incidencias y acciones de recuperación.
6. Decisión de expansión, bloqueo o rollback, sin merge/release implícitos.

**Tu primera acción:** reconoce Git y runtime en modo lectura, lee el runbook y los
tres JSON de evidencia, y prepara la matriz de canarios y el gate de inactividad.
La primera compactación real sólo empieza después de congelar el candidato,
preparar rollback y demostrar la ventana inactiva.
