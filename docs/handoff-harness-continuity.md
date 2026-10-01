# Handoff Staff Engineer — roadmap completo de continuidad y aceptación

Actualizado: 2026-10-01. Rama esperada: `refactor/harness-continuity`.
HEAD leído antes de esta actualización documental: `2e75c3a`.

Este documento es el prompt de continuidad para el siguiente agente. Sustituye las
secciones operativas y métricas históricas del handoff anterior. Es una instrucción
para completar trabajo existente, no una aprobación de release ni autorización
para interrumpir turnos ajenos. Relee HEAD y salud al comenzar: las identidades y
lecturas de abajo son evidencia histórica, no estado vivo garantizado.

## 1. Mandato, alcance y definición de terminado

Actúa como Staff Software Engineer responsable de cerrar la continuidad fiable del
agente de codificación desde el arranque de Codex/ChatGPT Web hasta ejecución de
herramientas, checkpoint, recuperación, entrega y liberación de recursos.

El usuario autorizó implementar el plan, investigar incidentes, mejorar logs,
trabajar con TDD y corregir gaps relacionados que aparezcan durante la ejecución.
El usuario pidió este handoff **antes de compactaciones reales**. La implementación
local está integrada; falta demostrar su comportamiento con integración real.
No rehagas el adaptador ni sustituyas sus autoridades por una arquitectura nueva.

El cierre requiere TODOS estos resultados:

- Candidato ejecutable congelado e identificado, con CLI/helper/dependencias
  compatibles y evidencia de identidad realmente cargada.
- Revisión/validación independiente y controles R2 satisfechos, incluyendo SAST,
  secretos, procedencia de tests y firmas válidas; limitaciones resueltas o
  declaradas mediante el proceso aplicable, nunca escondidas.
- Rollback completo, probado en aislamiento, y procedimiento operativo revisable.
- Ventana inactiva demostrada antes de activar o restaurar artefactos.
- Dos sesiones reales independientes, cada una estrictamente mayor de 22 minutos,
  con trabajo efectivo y diez compactaciones con continuación por sesión.
- Veinte checkpoints distintos, durables, con rutas retained/fallback observadas,
  requisitos conservados, herramientas realmente ejecutadas y checks finales reales.
- Retorno de recursos observables al baseline, salud diagnóstica comprobada y
  ausencia de reenvíos automáticos tras efectos enviados o ambiguos.
- Análisis causal de incidentes y métricas de fidelidad, resultado y eficiencia
  separados; incertidumbre residual explícita.
- Informe final y decisión operacional: aceptación, bloqueo o rollback.

Merge, publicación de release, actualización de conectores de terceros y mensajes
externos no forman parte de una autorización implícita de este handoff. Preparar
lo necesario para revisión sí está dentro del alcance.

## 2. Fuentes de autoridad y reglas del proyecto

### 2.1 Orden de lectura y precedencia

1. Instrucciones vigentes del usuario y del entorno de ejecución.
2. `AGENTS.md` aplicables al checkout y directorios afectados. En la revisión de
   esta entrega no se encontró un archivo local; el usuario aportó las reglas
   AGENTS en la conversación. Reinspecciona: podrían existir en la siguiente sesión.
3. [CONTRIBUTING](../CONTRIBUTING.md), [arquitectura](architecture.md),
   [validación de release](release-validation.md) y package scripts reales.
4. Este handoff, [revisión causal](harness-causal-diagnostics.md),
   [operación de continuidad](harness-continuity.md) y
   [observabilidad de compactación](compaction-observability.md).
5. [Recibo vigente](evidence/harness-continuity-verification.json),
   [gates vigentes](evidence/harness-continuity-gates.json),
   [preflight observado](evidence/continuity-causal-20261001/live-preflight.json),
   [índice de evidencia](evidence/continuity-causal-20261001/log-index.json) y
   [ledger local](../.shs/ledger/b025-FEAT-0001.json).
6. Skills pertinentes disponibles: staff-harness-standard, TDD,
   staff-orchestration y Playwright para concurrencia/navegador. Usa su ubicación
   real del catálogo, no una ruta heredada de otra máquina.

Los documentos y recibos `98bef09` son históricos/baseline. No activarlos como
esta entrega. `docs/harness-continuity.md` también contiene historia: sus cifras
anteriores no reemplazan los recibos vigentes.

### 2.2 Reglas funcionales y de arquitectura

- Mantener foco en modelos Codex respaldados por ChatGPT Web. Sin proveedores
  genéricos ni superficies ajenas a esta tarea.
- Seleccionar modelo y esfuerzo explícitamente y verificarlos antes de Send.
  Un fallo no autoriza cambiar de modelo, cuenta, esfuerzo o familia silenciosamente.
- Resolver capacidades/límites desde cuenta y modelo realmente seleccionados.
  No asumir funciones de Responses API disponibles en la superficie web.
- Full mode usa el registro activo del Codex exterior y el túnel MCP oficial,
  con capacidad ligada al turno. Browser-only no crea broker/túnel/conector.
- Conservar nombres/esquemas públicos MCP, identidades de conectores, checkpoint
  v2 y semántica abort de `close()`. No cambiar ABI para facilitar un test.
- Reutilizar session actor, retirement y journal. El journal es autoridad durable;
  no crear un store de recuperación competidor.
- Fallar de forma explícita ante identidad, selector, capacidad, protocolo o
  transporte inválidos. Ausencia de evidencia nunca equivale a éxito.
- No reinterpretar DEV como integración real: sus recibos de herramientas son
  simulados y declaran ausencia de efectos. No cuentan para aceptación end-to-end.
- Preservar packaging de macOS/Windows/Linux. Los paquetes se construyen en su
  sistema correspondiente; pruebas Linux no acreditan aceptación de otras plataformas.
- La arquitectura y publicación siguen bajo responsabilidad del maintainer.
  El refactor actual fue encargado por el usuario; eso no autoriza ampliarlo a
  una reescritura ni enviar una PR externa sin alcance acordado.

### 2.3 Reglas de implementación y calidad

- Aplicar el ciclo entender → diseñar → construir → observar → criticar → iterar.
  Inspeccionar filesystem, runtimes, gestores, herramientas y puertos antes de editar.
- Separar responsabilidades; código fuente legible, multilínea, con indentación
  de dos espacios. Sin stubs, TODOs de implementación ni código colapsado.
- Bugs: test de comportamiento RED → cambio mínimo GREEN → refactor con checks.
  Extracciones: caracterización antes de mover código. No tests que lean source
  para demostrar comportamiento ni asserts triviales que reflejen la implementación.
- Registrar comando, commit/snapshot, exit code, assertions y motivo del RED.
  Si sólo existe un overlay, declararlo; no fabricar un SHA de commit RED.
- Commits convencionales y atómicos. Revisar cambios del usuario antes de staging.
  No reset, force checkout, rebase, borrado de worktrees o pull implícitos.
- Usar `rg` para búsquedas. Paralelizar lecturas independientes; ejecutar suites
  pesadas serialmente. No borrar asserts, ampliar selectores especulativamente,
  ocultar skips ni repetir hasta verde sin explicar el fallo.
- Typecheck, lint, tests afectados y gates adecuados al cambio. Suite completa
  antes de aceptar un candidato de producción nuevo. Contrato worker <5 segundos.
- Si se modifica UI: leer skills pertinentes, preservar accesibilidad y validar
  visualmente en preview. Paleta/Code Arena del AGENTS aportado sólo aplican a
  nuevas interfaces o plataformas de evaluación, no obligan a introducirlas aquí.
- UI de producto explica acciones al usuario; detalles de harness se mantienen
  en diagnósticos salvo que ayuden a una decisión real.
- Corregir gaps relacionados bajo demanda con alcance/evidencia claros. Si cambia
  arquitectura, ABI o riesgo, revisar el diseño antes de integrar.

### 2.4 Reglas operativas, privacidad y gobernanza

- No activar, reiniciar, drenar, cerrar o sustituir un runtime con trabajo activo.
  Admission vacío no prueba inactividad. No cerrar la sesión propia desde ella misma.
- No usar `build:bundles`, `deploy`, setup/update/restart/stop como preparación
  inocua: algunos copian artefactos, cambian integración o reinician servicios.
- Preparar candidato, rollback y plan concreto antes de solicitar intervención
  del operador que sea imprescindible. No pedir de nuevo autorización ya otorgada;
  sí coordinar una ventana real cuando la acción depende de trabajo ajeno.
- No eliminar journals, browser state o configuración para fabricar un arranque
  limpio. Locks ambiguos se conservan; recuperación exige owner muerto comprobado
  y runtime inactivo, con revalidación antes de mover el lock.
- Nunca publicar cookies, claves, bearer/capability tokens, tunnel IDs, historial
  Codex, prompts privados, outputs privados, browser state ni paths personales.
  Los logs nuevos se revisan/redactan; preferir recibos estructurados sanitizados.
- Los logs versionados ya existentes en la carpeta de evidencia son fixtures y
  ejecuciones locales con redacción documentada, no permiso general para subir logs.
- Screenshots opt-in y revisión de contenido antes de compartir. Sin tracing global
  del BrowserContext de una cuenta real.
- SHS de esta implementación: R2×L por concurrencia, efectos y persistencia.
  Documentar aislamiento real R/A/V; instrucciones de rol no son enforcement.
- Ledger append-only: no editar `b025-FEAT-0001.json`, sus hashes o recibos
  referenciados para hacer que parezcan aprobados. Añadir entradas posteriores.
- Hash canónico verificado no equivale a firma. No inventar claves, firmas,
  sesiones independientes, coverage, comandos ejecutados o duración real.
- No declarar captura universal de todos los errores: presupuestos, drops,
  truncado y causas desconocidas deben quedar visibles.

## 3. Estado vigente de implementación y evidencia

### 3.1 Identidad del candidato preparado

| Campo | Valor registrado |
| --- | --- |
| Source tree `src` verificado | `afe3bc270f4a43a75d2dd54e07b67714b5bee35d` |
| Commit de gates completos | `5479f97a7766c80b3fcc64df89b75b556744f978` |
| Commit capturado por builder | `a25e1ef9c5e3c9488fc47952b6d9176bb8a3b301` |
| Bun de la medición | `1.4.2` |
| Source-input digest | `31467e0365b1fd849153ce88de48035ea54e6876c68aa13bd3c0a01b646ed2b1` |
| Artifact-set SHA-256 | `0d84b435ab0459319019e596aaf5ee94c68dfcf8c5f4032659b2bc818ae1ae7f` |
| CLI SHA-256 | `6fe17b7f0cb2f042c27dec4e545126455446030dfc2f8400b58e8445b05b3e20` |
| Helper SHA-256 | `f9329682a068756bafa42fa1196b94265f8da0d003d89dd771d7f381b67f28c6` |
| Dependencias | `frozen-lockfile-copy`, sin symlink al checkout mutable |
| Directorio relativo | `.launcher-runtime/31467e0365b1fd849153ce88de48035ea54e6876c68aa13bd3c0a01b646ed2b1/app` |

Los commits posteriores a `a25e1ef` del recibo cambiaron gates/tests/docs, no sus
inputs capturados `src`, `package.json`, `bun.lock`, `tsconfig.json`. Verifica esto
otra vez. HEAD, source tree, source-input digest y hashes de artefactos son
identidades diferentes. Un commit documental no demuestra alteración del build.

El builder produce un snapshot y no activa servicios. Un árbol sucio puede generar
`buildCommit: null`; no atribuirle un commit inventado. Para esta aceptación usa
un candidato limpio, reproducible y revisado. Si el directorio desapareció,
reconstruye y mide el artefacto nuevo: no recuperes hashes de un bundle distinto.
El builder sólo atribuye commit cuando el checkout completo está limpio, incluso
si los únicos cambios pendientes son documentales. No descartar trabajo ajeno para
cumplirlo: integrar lo propio o preparar un checkout aislado del snapshot aprobado.

### 3.2 Trabajo integrado que no debe rehacerse

| Slice | Commits principales | Comportamiento conservado |
| --- | --- | --- |
| Checkpoint/procedencia | `fe203a8`, `e501998` | Contrato v2 explícito, origen host fuera del cache compartido, reparación con origen privado |
| Send/recuperación | `d648f39` | Preparación/activación durables, incertidumbre sin final y recovery exacto por journal |
| Transporte | `02f79ea` | Selección inline → 2 → 6, fragments UTF-8 con offsets/hashes, reconstrucción host |
| Diagnóstico | `b7e9f2c`, `f32b8d9`, `3f70d7d` | Identidad productora, DAG causal, timeline, fronteras IPC/MCP y flush al cierre |
| HTTP/lifecycle | `9c0d2a8`, `506f8c8` | Causas tipadas, retirada de listeners y regresiones de aislamiento |
| Startup/build | `8ed2157`, `50c9f87`, `ff6a729` | Par congelado, dependencias físicas y gate del build realmente ejecutable |
| Preflight | `d2f4827`, `1dd10e1`, `5479f97` | Bootstrap legacy acotado, health causal validado y rollback de par verificado |
| Dependencias | `ba4c802`, `bfbc053` | Pins corregidos sin cambiar los módulos instalados del runtime activo |
| Evidencia/handoff | `a25e1ef`, `ac4fc55`, `2e75c3a` | Recibos, historia archivada, preflight bloqueado y ledger sin aprobación |

### 3.3 Verificación registrada y límites

| Check | Resultado |
| --- | --- |
| Suite completa serial | 2.338 pass, 14 skip, 0 fail; 13.230 assertions; 220 archivos; 268,70 s |
| Cobertura agregada lcov | Funciones 81,575 %; líneas 76,364 %; SHA en el recibo |
| Launcher | 368 pass, 1 skip de plataforma, 0 fail |
| Contratos Chrome real | 37 pass, 0 fail; 228 assertions; 257,02 s |
| Gates continuidad | 12 suites, 242 pass, sin fallos; stableBuild true |
| Contrato worker | 2.279,052 ms, presupuesto 5.000 ms |
| Typecheck / gates estructurales | Verdes en root/launcher y cuatro gates strict |
| Lint | 0 errores; 88 warnings existentes, no ocultados |
| Audits de lock | Root 0 hallazgos/118 packages; launcher 0/351 |
| Smoke del par físico | CLI version, helper ready/shutdown y MCP initialize/tools-list: 14 herramientas; sin navegador ni Send |
| Build launcher aislado | Lock congelado, typecheck y renderer Vite; 441 módulos |
| Secret scanning | Gitleaks con checksum verificado y control positivo sintético; evidencia final redactada sin hallazgos |
| Lifecycle | Loops locales de 100 ciclos por scopes declarados, no 100 sesiones completas de producción |

La cobertura es lcov, no una cifra intercambiable con la agregación impresa por
Bun. Los skips se conservan y el recibo distingue la ejecución separada de browser.
Auditar el lock nuevo no prueba las dependencias cargadas por el daemon anterior.
Sus módulos instalados permanecieron intactos deliberadamente.

Replay usa navegador real sobre fixtures controlados. No demuestra obediencia del
modelo, continuidad semántica real, túnel autenticado ni ejecución del Codex exterior.
La comparación final tiene cinco muestras por caso; nearest-rank p95 es el máximo.
ACK tardío aumentó p95 unos 31,686 ms. Bytes/tokens de esos payloads no se redujeron;
no hay evidencia de tokens facturados o cache hits. No vender estos datos como
mejora estadística de producción.

### 3.4 Invariantes ya implementados: condiciones de no regresión

- `PromptCompilationResult` acompaña el payload con hashes de fuente, payload y
  secciones, transformaciones y medición congelada. Multipart incluye todas las
  partes y adjuntos, no sólo el commit final. Reutilizar la medición seleccionada
  en preflight, planificación y telemetría; invalidarla si cambia el input.
- Preservar literalmente system/developer/user, código, IDs, paths, resultados
  y evidencia. Retirar handles sólo en campos explícitos de `broker_metadata`.
  Dedupe sólo contratos generados con provenance y sustitución demostrables;
  pruning heurístico de historial sigue sin cablear.
- Mantener instrucciones/capacidades estables donde corresponda y procedencia
  específica de tarea fuera de la LRU de contratos. No hashear la solicitud de
  reparación como si fuera la solicitud original.
- Transporte sin pérdida: inline → dos → seis partes, con selección sobre payload
  físico. Fragmentos UTF-8 reconstruidos/verificados por el host antes de Send;
  negociación de capacidad explícita. No truncar system/user ni aceptar checkpoint
  cuando el transporte no puede representar el contenido.
- Política compartida retained/rescate/fallback:
  `normalize → parse → validate → repair → revalidate → persist → accept → deliver`.
  Normalización idempotente protege strings citados y código; reparación semántica
  máximo una vez por operación, con issues y revalidación. Sin inventar requisitos,
  evidencia, estado verificado ni referencia original ausente para ocultar un defecto.
- Abort durante persistencia conserva el write real en journal para recovery y
  no acepta nueva historia. Handoffs recibidos sin consumir conservan TTL,
  consumo único y carreras de cancelación. Recovery requiere owner, generación,
  source y hash exactos; Send activado sin final continúa incierto.
- Bus/feeds cerrados rechazan nuevas esperas; señal abortada gana al replay.
  Predicado defectuoso rechaza sólo su waiter. Cursor fuera de historial exige
  resincronización con snapshot, no espera indefinida ni evento inventado.
- Suscribir antes de leer snapshot. DOM/progreso/red despiertan la FSM; sólo
  FSM/completion fence acredita finalización. Cancelar y liberar perdedores de
  carreras. Rebind retira listeners de Page anterior, incrementa generación y
  conserva identidad del turno.
- Cancelación DOM retira recursos físicos del renderer, observers/timers y
  ElementHandles incluso en abort temprano/tardío; cancelar una Promise Node
  sin settlement del renderer es insuficiente.
- Correlación MCP se retira tras cancelación aunque no llegue respuesta: el
  transporte puede terminar una solicitud cancelada sin responder. No contar
  delivery como ejecución ni aceptación de checkpoint como continuación correcta.
- Clasificar terminal por hechos: completed, user_cancelled, handoff_accepted,
  deadline, transport, internal_failure. Conservar causa tipada por IPC/HTTP/MCP;
  una cadena genérica de error no permite inferir automáticamente otra causa.

## 4. Pendientes completos y orden de dependencias

| ID | Trabajo pendiente | Dependencia | Criterio para cerrar |
| --- | --- | --- | --- |
| M0 | Reconocimiento y actualización de inventario vivo | Ninguna | Rutas, procesos, cuenta/modelo, fuentes y owners identificados sin secretos |
| M1 | Gobernanza R2, revisión final, SAST y procedencia TDD | M0 | Controles/firma/aislamiento verificables; gaps tratados con decisión explícita |
| M2 | Recuperar y probar rollback completo | M0 | Par + deps + config + source graph verificados y smoke aislado verde |
| M3 | Preparar runner/matriz/evidencia de canarios reales | M0 | 20 casos, evaluadores y capturas listos; ninguna herramienta simulada contada |
| M4 | Congelar/revalidar candidato final | M1, M2, M3 y fixes | Snapshot limpio, gates seriales y hashes exactos del artefacto que se activará |
| M5 | Coordinar/demostrar ventana inactiva | M4 | Gate estricto o transición legacy válida; cero actividad y teardown acreditado |
| M6 | Activar par completo y verificar readiness | M5 | Identidades cargadas coinciden, salud válida, sin owners heredados |
| M7 | Revisar startup → Codex → web → MCP de extremo a extremo | M6 | Herramienta local real y entrega final correlacionadas; modos preservados |
| M8 | Ejecutar 2 sesiones >22 min / 20 compactaciones | M7 | Continuaciones reales, rutas observadas y requisitos/checks conservados |
| M9 | Cerrar diagnóstico de incidentes y gaps nuevos | M8 | Causalidad demostrada o desconocido explícito; fixes con TDD cuando proceda |
| M10 | Evaluar recursos, fidelidad y eficiencia | M8, M9 | Baselines, muestras y outcomes auditables, sin regresión funcional |
| M11 | Decisión operacional y cierre de documentación | M1–M10 | Informe aprobado, ledger posterior y runbook de expansión/rollback |
| M12 | Integración/publicación/plataformas, si se encarga | M11 + alcance explícito | Gates de maintainer/CI/cuentas/plataformas satisfechos |

M1, M2 y M3 pueden avanzar en paralelo con ownership exclusivo. No paralelizar
mutaciones dependientes ni suites pesadas. M4 se repite si cambia producción,
lockfile o build. Un fallo durante M6–M10 detiene expansión; analizar/fijar y volver
a medir el candidato afectado, sin elegir sólo intentos exitosos del mismo build.

## 5. M0 — Reconocimiento read-only y blockers iniciales

Primero leer Git/archivos, browser instalado, runtimes/gestores, procesos, puertos,
launcher, Codex CLI, integración Responses, connector y homes reales. No depender
de PIDs, `/tmp`, aliases o subagentes de la sesión anterior.

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git rev-parse HEAD:src
git worktree list
bun --version
node --version
python3 --version
bun run src/cli.ts --help
bun run src/cli.ts admission status --json
bun run src/cli.ts service status
```

Descubrir ubicación real de journals, JSONL, stderr, locks, browser partition y
config. Comprobar permisos, owners, generaciones y clocks. Inspeccionar salud por
la URL configurada; `service status` puede no representar al daemon del launcher.
No imprimir dumps completos de configuración o environment con credenciales.

Último preflight: `2026-10-01T15:39:23.024Z`, commit limpio `ac4fc55`, exit 2.
Source tree y artefactos coincidían; admission estaba vacío. Bloqueos observados:

| Código | Hecho observado | Acción pendiente |
| --- | --- | --- |
| `rollback_missing` | Rollback completo no preparado | M2; no aceptar helper suelto |
| `runtime_accepting_turns` | Daemon todavía admitía turnos | Coordinar cierre de admisión en ventana segura |
| `active_http_turns` | Dos turnos HTTP | Esperar finalización/cancelación por sus owners |
| `active_browser_turns` | Dos turnos de navegador | Demostrar settlement físico, no sólo Promise resuelta |
| `helper_runtime_present` | Un helper anterior observado | Teardown por ruta soportada después del settlement |
| `resource_evidence_missing` | Predecesor sin seam de recursos | Transición legacy acotada o evidencia adicional revisada |
| `telemetry_evidence_missing` | Predecesor sin seam de health | No convertir ausencia en cero; transición legacy acotada |

Daemon anterior: artifact `289e6ace…025c`; helper `14af41a0…16b7`; commits no
identificados. La actividad puede haber cambiado: nueva lectura obligatoria.
Salida M0: inventario sanitizado y lista actual de blockers con timestamp/identidad.

## 6. M1 — Cerrar evidencia y gobernanza R2

La entrada `b025-FEAT-0001` está vigente como registro local, **sin firmas A/V**.
No hay claves registradas ni aislamiento mecánico R/A/V acreditado. Las revisiones
readonly encontraron/corrigieron seis bugs, pero leyeron fuentes mutables; no son
aprobación formal del snapshot final. El ledger no es un bootstrap SHS completo.

Trabajo concreto:

1. Fijar snapshot del candidato para revisión. Approver y Verifier distintos del
   implementador; declarar responsabilidades y evidenciar aislamiento contra el
   harness real, incluyendo delegación anidada cuando aplique. Worktree separado
   por sí solo no prueba bloqueo de escrituras al checkout principal.
2. Si el control técnico no está verificado, aplicar la ruta conservadora de SHS:
   separación de agentes más revisión humana real y control demostrado aplicable.
   Documentar el gap y el veredicto; no autoaprobar ni crear identidades ficticias.
3. Revisar fronteras de confianza: provenance host, capability por owner/turno,
   parser remoto, getters/ciclos/DAG compartido, readback, recuperación durable,
   lifecycle, locks, flush y cambio de artefactos.
4. Ejecutar SAST dedicado pendiente. Elegir herramienta compatible, fijar versión,
   origen/checksum cuando corresponda y ruleset identificado; escanear código
   relevante root/launcher y gates. Capturar archivos/reglas analizados, exclusiones,
   resultados, exit code y control positivo seguro que compruebe el detector.
   Typecheck, lint, audit y Gitleaks no sustituyen SAST. Triage con evidencia de
   explotabilidad/alcance, sin allowlists genéricas para forzar verde.
5. Repetir secret scan sobre los artefactos que se vayan a compartir, con redacción.
   Mantener raw privado, hash del original y transformaciones documentadas.
6. Resolver la procedencia RED incompleta: los logs históricos son overlays sin
   commit RED separado ni digest exacto del overlay. No reescribir Git ni el ledger.
   Reproducir, si hace falta, en una rama/worktree aislado desde un parent conocido:
   añadir sólo la regresión, ejecutar y commitear RED; aplicar la corrección,
   ejecutar GREEN y comprobar ancestry. Eso acredita una reproducción nueva,
   nunca un commit RED histórico inexistente. A/V deben decidir si satisface el
   gate; si no, conservar NO-GO y registrar la acción requerida.
7. Inventariar controles SHS realmente instalados: U-00 autotest; U-01 ledger;
   U-02 referencias; U-03 firmas; U-04 ancestry; U-05 aislamiento; U-06 tests
   auténticos/patrones; U-07 catálogo/ratchet si existe; U-08 sello de gates si existe.
   Distinguir aprobado, fallido, pendiente o no aplicable con motivo. Los cuatro
   gates de refactor no equivalen al pipeline completo SHS. No afirmar que existen
   scripts/hooks/catálogos/sellos que no están instalados.
8. Añadir nueva entrada de ledger referenciando el ID/hash anterior y snapshot
   evaluado. Firmas criptográficas con identidades/keys verificadas y sin acceso
   del implementador a claves ajenas. No modificar recibos ya hasheados por la
   entrada original; emitir recibos nuevos y enlazarlos.

Salida M1: revisión del snapshot final, SAST/secretos triados, declaración de
aislamiento, matriz de controles y decisión formal verificable. Los umbrales de
cobertura sugeridos por una skill no son mínimos adoptados automáticamente:
revisar cobertura por dominio, no inventar un threshold legal de release.

## 7. M2 — Rollback completo y seguro

El material histórico del helper no identifica el CLI/dependencias/config/source
graph del runtime vivo. Está pendiente recuperar procedencia por manifiestos,
instalación, artifacts y configuración realmente usados. No fabricar
`source-commit.txt` a partir del branch actual.

Preparar layout esperado por el gate:

```text
rollback-root/
  manifest.json
  app/
    cli.js
    browser-helper.cjs
    source-commit.txt
    node_modules/             (si declara frozen-lockfile-copy)
```

Exigir archivos regulares, hashes del par y artifact-set concordantes, commit
exacto del manifiesto y dependencias físicas correspondientes. El gate comprueba
presencia de la copia declarada: no verifica todos sus bytes ni su ejecutabilidad.
Completar por fuera su inventario/checksums, resolución de módulos y smoke.
Preservar configuración, rutas de arranque, protocolo, partición y compatibilidad
con journals existentes. Almacenar snapshots sensibles sólo en ubicación privada.

Ejecutar smoke aislado del rollback: CLI, handshake helper, MCP initialize/list,
shutdown y lectura compatible de journal-fixture, sin puerto/connector/home de
producción. Registrar los comandos reales soportados tras leer scripts. No lanzar
herramientas mutantes contra el workspace del usuario para comprobar readiness.

Documentar selección del rollback, parada segura, restauración del par/config,
readiness posterior y verificación de identidad cargada. No downgrade de journal
por truncado. Si el artefacto anterior no es identificable/compatible, bloquear
activación y resolverlo con el operador; no aceptar una copia especulativa.

## 8. M3 — Preparar campaña, runner y evaluadores

Existe `scripts/harness-live-canary.ts`: colecta preflight y genera una matriz de
20 entradas. **No ejecuta las sesiones, no fuerza compaction y no demuestra
continuidad.** `compaction-canary-report.ts` agrega logs; tampoco es un runner.
Falta preparar una ruta reproducible de ejecución real y evidencia semántica.

Crear en workspace aislado una campaña con manifest versionado/sanitizado que fije:

- ID de campaña/build; dos IDs de sesión/thread; 20 IDs de checkpoint únicos.
- Cuenta/plan/modelo/esfuerzo/capacidades observados y límites usados, sin secretos.
- Requisitos con IDs, solicitud original, último steering, restricciones y oracle.
- Baseline de tarea, archivos esperados, tests reales, obligación pendiente y
  siguiente acción aún no ejecutada antes de compactar.
- Disparador de compaction soportado, scheduling y captura de ruta efectiva.
- Reloj monotónico, referencias privadas de evidencia y hashes compartibles.
- Evaluador de fidelidad/ejecución/cierre independiente y política de fallo.

Matriz actual: A-CP-01..10 y B-CP-01..10, con tres requisitos por checkpoint.
ExpectedRoute alterna retained/fallback; es una expectativa, no evidencia de ruta.
Usar escenarios como cobertura inicial, adaptando tareas a un workspace benchmark
con trabajo genuinamente pendiente; no fingir que un bug ya corregido sigue abierto.

| CP por sesión | Caso del generador | Obligación que debe cruzar la compactación |
| --- | --- | --- |
| 01 | `unicode-regression` | Literal Unicode/escapes y test focalizado pendiente |
| 02 | `abort-settlement` | Listener/renderer settlement aún por verificar |
| 03 | `multipart-digest` | Identidad completa de payload y comparación real |
| 04 | `checkpoint-reference` | Procedencia original strict sin estado fabricado |
| 05 | `telemetry-budget` | Límites/drops/flush con comandos reales |
| 06 | `deadline-classification` | Causa tipada preservada hasta terminal |
| 07 | `retained-release` | Ownership/liberación antes del reemplazo |
| 08 | `tool-delivery` | Ejecución de tool distinguida de respuesta transportada |
| 09 | `browser-rebind` | Nueva generación y cleanup de página anterior |
| 10 | `single-send` | Incertidumbre tras Send sin reenvío automático |

Estas tareas no deben modificar silenciosamente el harness activado. Copiar o
preparar fixtures de trabajo aisladas y congelar el harness de la campaña.
DEV puede ayudar a preparar datos; sus herramientas simuladas no cuentan.
Usar Codex instalado real y connector correcto para la aceptación Full.

Si se necesita un runner/evaluador nuevo, declararlo como trabajo pendiente, con
brief, archivos exclusivos, TDD y schemas internos. No documentar un comando como
existente hasta que se implemente. Evitar endpoints privilegiados o nuevos ABI.

Gap de preparación para candidatos futuros: el collector de preflight lee hoy
las rutas fijas `docs/evidence/harness-continuity-verification.json` y
`docs/evidence/harness-continuity-gates.json`. Esos archivos están hasheados por el
ledger original. Si cambia el candidato, preparar primero selección explícita de
recibos nuevos en el collector, con regresiones de mismatch/provenance, o un
mecanismo equivalente revisado. No sobrescribir recibos históricos para conseguir
que el preflight acepte un build nuevo. Esa selección todavía no tiene flags
implementados; no inventarlos al ejecutar los comandos actuales.

Por checkpoint capturar en evidencia privada/referenciada:

| Grupo | Datos mínimos |
| --- | --- |
| Correlación | campaign/session/thread/turn/trace/operation/checkpoint IDs, owner, generation, sequence/documentGeneration |
| Runtime | Commit verificado cuando existe, SHA CLI/helper/set, protocol, capacidades realmente negociadas |
| Tiempo | UTC inicio/fin/ocurrencia/escritura y duración monotónica real |
| Tarea | Original/latest request, requisitos antes/después, checkpoint v2 y siguiente acción esperada/efectiva |
| Ejecución | Tool name/call/result IDs, recepción/claim/emisión/resultado/entrega, exit codes y archivos/commit resultantes |
| Compactación | prepared/received/validated/repair_started/persisted/accepted/delivered, issues, reparación y ruta observada |
| Browser | Composer/readback/adjuntos/pills, submission evidence, Sends físicos, ACK, fence, rebind y terminal |
| Recursos | Baseline/final de waiters/listeners/timers/transacciones/persistencias/releases/conexiones observables |
| Diagnóstico | DAG/error IDs, queue/bytes/drops/truncado/flush/status y fallback de sink |
| Evaluación | Fidelidad, próxima acción correcta, resultado de tarea, checks finales y motivos de fallo/incompletitud |

No pedir que la telemetría pública contenga prompts o IDs privados excluidos por
su schema. Correlacionar los hashes diagnósticos con un manifiesto privado local.
Preservar el schema de compaction events v1 y el causal v2; no mezclarlos.

## 9. M4 — Congelar candidato final y ejecutar gates

Si M1–M3 revelan un bug, corregir primero con TDD, revisar y crear un candidato
nuevo. Nueva fuente/lock/receta exige nueva identidad y nueva campaña. No mezclar
resultados de builds distintos ni actualizar sólo un helper.

En checkout/staging aislado, instalar root y launcher con locks congelados. No
mutar módulos que consume el runtime activo. `bun run verify` es el gate de
contribución: incluye audits/typecheck/lint/gates/coverage/launcher/build/smoke.
Leer su script y correrlo aislado, pues también escribe renderer/dist y artefactos.
La última entrega tiene checks separados; no hay recibo de un `verify` completo
que permita atribuirle packaging/smoke de release no ejecutados.

Secuencia local conocida, sin suites pesadas simultáneas:

```bash
bun run typecheck
bun run lint
bun run check:refactor-gates
bun test ./tests --coverage --coverage-reporter=lcov --coverage-dir=/tmp/cgw-coverage-new
bun run launcher:typecheck
node --test launcher/tests/*.test.cjs
CHATGPT_DOM_TEST_BROWSER=/usr/bin/google-chrome bun run test:browser-contracts
bun run scripts/build-development-runtime.ts
bun run scripts/check-harness-continuity.ts --samples=5 --report=/tmp/cgw-gates-new.json
```

Revalidar el browser ejecutable antes de usar esa ruta. Gates de continuidad
usaron Chromium Playwright; contratos separados usaron Chrome del sistema.
Para comparación emplear `--compare=` sólo con baseline compatible: mismo fixture,
scenarios, Bun/browser, sample count y reportes passing/stable. Reportar población
real, warmup/outliers/método y límites; no repetir para elegir una latencia favorable.

Conservar manifest, captured inputs, pair hashes, dependencias y smoke del par
físico. Código/reports de evidencia nuevos se guardan con IDs nuevos; los recibos
hasheados por el ledger anterior quedan históricos e inmutables.
Confirmar que A/V evaluaron ese mismo snapshot y recipe. Si M4 cambia la fuente,
lock o composición del artefacto, renovar revisión/firma; no heredar aprobación de
otro par por tener el mismo nombre de rama.

## 10. M5–M6 — Inactividad, transición legacy y activación

Ejecutar preflight read-only usando los directorios reales de la campaña:

```bash
bun run scripts/harness-live-canary.ts \
  --candidate-dir=<candidate-root>/app \
  --rollback-dir=<rollback-root>/app \
  --require-ready \
  --report=/tmp/cgw-preflight-new.json
```

Los marcadores `<...>` requieren sustitución por rutas verificadas; no copiar esa
plantilla como comando listo. La herramienta no drena ni instala. Exit 2 significa
NO-GO del gate, no licencia para matar procesos o ignorar blockers.

La ventana debe demostrar admisión cerrada, cero ejecuciones/esperas, cero HTTP/
browser/subagents, ausencia de helpers/owners pendientes, teardown físico,
waiters/timers/transacciones/persistencias/releases resueltos y colas flush/vacías.
Revisar `telemetry_health` **y** `diagnostic_health`; contadores ausentes son
inobservados, no cero. Health malformado o degradado debe bloquear.

Para predecesor identificado anterior al seam existe
`--legacy-bootstrap-shutdown`. Sólo calcula elegibilidad de su apagado y tolera
seams ausentes dentro de esa transición; no elude actividad, helper presente,
rollback/artifacts inválidos o health anunciado malformado. No acredita instalar
el candidato. Coordinar shutdown por la ruta soportada una vez que los owners
hayan terminado y conservar la evidencia de salida/settlement.

Inspeccionar launcher supervisor/servicio y su método real de selección de
artefactos antes de activar. No hay aquí un comando universal de instalación.
Evitar TOCTOU: identificar generación evaluada, impedir nuevos turnos entre
preflight y cambio y revalidar inmediatamente antes de la mutación. Si se pierde
la ventana o cambia generación, repetir el gate.

Activar CLI/helper/dependencias como unidad. Comprobar identidad cargada en daemon
**y cada helper**, readiness, protocolo, features, homes, partition y rutas de
Codex. Configuración y journals se conservan. Ningún Send antes de readiness y
verificación de modelo/capacidad/superficie.

Si falla readiness, no iniciar campaña: preservar DAG/logs, mantener expansión
cerrada y restaurar el rollback verificado sólo tras nueva ventana segura.

## 11. M7 — Verificar viaje completo desde abrir Codex

Revisar y demostrar estos pasos con correlación, no sólo lectura de source:

1. Launcher selecciona snapshot; startup gate/supervisor verifica daemon y par.
2. Descriptor/route llegan al Codex instalado; catálogo refleja cuenta/modelo/
   esfuerzo sin duplicar ni eliminar modelos nativos. Reiniciar Codex sólo en
   ventana coordinada si la integración real lo requiere.
3. Request Responses/SSE vincula owner/session/operation y listeners de abort.
4. Host compila literalmente instrucciones/historial, mide payload una vez,
   selecciona transporte y negocia features con helper verificado.
5. Browser lease pertenece al turno; documento/modelo/adjuntos/pills/readback
   coinciden con payload seleccionado antes de autorizar Send.
6. Journal registra preparación/activación del efecto y submission demuestra
   aceptación. ACK es observación separada; ausencia no dispara reenvío.
7. Full-mode MCP llega por conector/túnel correctos: call_received → claim →
   emisión al Codex exterior → ejecución local real → result_received → entrega.
   Demostrar efecto y exit code; `reply_sent` solo no basta.
8. Completion fence/FSM determina finalización; persistencia precede entrega
   durable y cleanup no deja listeners/tabs/streams huérfanos.
9. Compactación aplica política compartida y siguiente epoch conserva tarea.

Verificar Browser-only sin capacidades MCP; Full con la misma capacidad de turno
para todos los esfuerzos disponibles; distinguir Automatic/Zero Risk si son
rutas afectadas. Zero Risk no permite leer/mutar DOM para facilitar el canario.
No seleccionar `Codex Native` legacy ni confundir `Codex Native2 DEV` con el
connector de producción. No renombrar/refrescar/borrar connectors para resolver
una discrepancia de identidad sin seguir su migración documentada.

Salida M7: una tarea real con tool local, final y cleanup correlacionados; inventory
startup actualizado con puntos de fallo observables. Pruebas de cancelación/
reconnect se hacen sobre turnos de evaluación propios, no trabajo ajeno.

## 12. M8 — Ejecutar y evaluar 20 compactaciones reales

Dos sesiones independientes con identidad estable, diez checkpoints por sesión y
más de 22 minutos reales cada una. No cuentan sleeps, clocks virtuales, timestamps
inventados o duplicación de traces. Registrar tiempo transcurrido monotónico y
actividad efectiva del agente, herramientas y navegador.

Para cada checkpoint:

1. Capturar tarea vigente y siguiente acción pendiente antes de compaction.
2. Disparar compaction por mecanismo soportado del Codex real; registrar motivo,
   límites/capacidades y ruta efectiva. No asumir que el expectedRoute ocurrió.
3. Verificar normalización/validación/reparación máximo una vez; persistencia
   durable precede aceptación y entrega. Checkpoint v2 correcto es condición
   necesaria, no suficiente.
4. Observar la primera acción de continuación y contrastarla con la obligación
   pendiente. Requisitos/instrucciones/evidencia deben conservarse sin invención.
5. Verificar herramienta ejecutada realmente, sus resultados y comprobaciones
   finales. Entrega MCP, texto de éxito o comando citado no prueban ejecución.
6. Registrar baseline/final de recursos y health; comprobar cierre físico.
7. Evaluador independiente emite pass/fail/incomplete con referencias auditables.

Cubrir retained y fallback observados. La matriz alterna cinco de cada ruta por
sesión como objetivo; si la superficie no permite provocar una ruta, registrar el
gap y preparar un mecanismo soportado antes de continuar. No relabelar traces ni
fabricar fallback. Intentos adicionales se registran aparte con denominadores
reales. Un fallo del build invalida expansión: investigar y repetir campaña del
candidato corregido; no reemplazar silenciosamente un caso fallido por uno verde.

Guardar hechos de abort durante persistencia, handoff sin consumir, cierre tardío,
rebind/cursor vencido y carreras cuando se ejecuten realmente. Las pruebas locales
ya cubren estos escenarios; fault injection adicional debe estar soportado,
acotado y aplicado a sesiones propias, sin ocultar la diferencia con tráfico normal.

## 13. M9–M10 — Incidentes, recursos y eficiencia

### 13.1 Preguntas causales que siguen abiertas

- ACK multipart parte 2: expiró a 180001 ms, pero no se sabe si falló generación,
  entrega, hidratación, selección/identidad o extracción. Capturar timestamps,
  submission, baseline/surface/generación, eventos de red sanitizados y DAG;
  reproducir con fixture mínima cuando haya evidencia suficiente.
- Checkpoint `missing_state`: cero tags en visible/HTML/markdown en la captura
  inspeccionada. Contrato/provenance más estrictos no prueban obediencia real.
  Distinguir salida inválida del modelo, entrega y representación/extracción.
- Identidades múltiples observadas: fixtures prueban virtualización/hidratación;
  falta atribuir causalmente el incidente real con identidad estable y submission.
- 401 históricos: sin endpoint/request/build correlacionados no atribuirlos a
  MCP, sesión del navegador o credenciales específicas.

Si no se reproduce un incidente, decirlo; canario verde no demuestra causa raíz
resuelta. Un bug probado exige RED→GREEN, revisión y candidato nuevo. Cambios a
selectores requieren evidencia DOM y fixture; usar locators/condiciones observables.
**Timeout posterior a Send no autoriza resend automático.**

### 13.2 Recursos y observabilidad

Contrastar baselines por turno/documento y runtime: waiters, listeners, timers,
transacciones, persistencias, retained releases y conexiones observables. Los loops
locales de 100 ciclos son evidencia por scope, no prueba universal de no fugas.
Si falta un contador, declarar inobservado; añadir seam mínimo si es necesario.

Validar bounded queue por cantidad/bytes, degradación por drops/fallo I/O, circuit,
retención de writers muertos, flush con deadline y fallback stderr. Un fallo del
sink no modifica el resultado funcional, pero puede bloquear aceptación operativa.
Preservar causa del productor en cada frontera; no sustituirla por PID/generación
receptora. Causas desconocidas y flags de truncado deben seguir visibles.

Presupuestos vigentes a preservar: DAG 16 KiB/depth 8/16 hijos agregados; ring y
cola 256 registros/1 MiB; segmentos por writer 5×10 MiB; retención elegible de
writers muertos 7 días/128 MiB; flush 1000 ms. Verificar source si se cambian.
No eliminar locks legacy ambiguos ni writers vivos para cumplir retención.

### 13.3 Métricas y evaluación separadas

Reportar fidelidad, éxito funcional, herramienta ejecutada, continuidad y cleanup
con denominadores distintos de coste/latencia. Medir bytes y tokens estimados del
payload físico seleccionado, latencia p50/p95 por fase y end-to-end con muestras
conservadas. No atribuir cache hits o facturación que ChatGPT Web no expone.
Comparar mismos casos/builds identificados, cuenta/modelo/esfuerzo y condiciones.
Ninguna reducción de contexto se acepta si empeora requisitos o éxito de tarea.
No aumentar silenciosamente deadlines para tapar regresiones.

## 14. M11 — Agregación, decisión, cierre y rollback

Sobre un log exclusivo y real de campaña, el acumulador existente se ejecuta así:

```bash
bun run scripts/compaction-canary-report.ts /ruta/privada/canary.log
```

Exigir 20 traces distintos durables de la campaña aceptada, cobertura retained/
fallback y cero failed/rejected/incomplete/malformedEvents/mixedBuildTraces/
deliveredWithoutLocalPersistence. Revisar raw privado y journal: el acumulador no
valida duración, semántica, herramientas reales, Send único ni causalidad completa.
Su exit code/reporte no sustituye el evaluador de continuidad.

Entregables finales pendientes:

- Inventario vivo y manifest del candidato/rollback, con recetas y hashes.
- Runner/procedimiento real, matriz congelada y registro privado de 20 checkpoints.
- Evaluación por checkpoint y sesión: fidelidad, próxima acción, ejecución, final,
  tiempo real, rutas, Send y recursos.
- Reporte agregado, métricas/muestras y comparación con límites declarados.
- Análisis causal por incidente: probado/inferido/desconocido y fixes asociados.
- SAST/secretos/revisión/aislamiento/firma y resolución de procedencia RED.
- Runbook probado de activation/rollback y registro de identidades cargadas.
- Recibos nuevos y ledger append-only; documentación y decisión operacional.

En fallo: detener expansión, preservar journal/correlaciones/DAG, dejar inciertos
los efectos inciertos y no reenviar. Esperar settlement, demostrar otra ventana
segura y restaurar par/deps/config verificados cuando proceda. Validar readiness,
identidad y journal después de rollback. Registrar fallos e intentos completos,
no sólo campañas exitosas.

Aceptar únicamente con todos los gates requeridos y evidencia independiente.
No declarar terminado por budget/contexto agotado ni sólo porque pasó la suite.
Al entregar explicar qué cambió, qué se ejecutó, qué sigue pendiente y qué acción
concreta lo resuelve. Si no hay ventana, dejar todo preparable listo y comunicar
los blockers, sin detener arbitrariamente trabajo autorizado.

## 15. M12 — Integración y release: alcance condicionado

No hay merge/publicación realizados por esta entrega. Si el usuario encarga ese
paso, inspeccionar remoto/divergencia y CI actuales, preparar PR revisable por
slices con commits/validación, cumplir CONTRIBUTING y dejar decisión al maintainer.
No asumir remoto sincronizado con la base `9c6e02a` ni hacer rebase implícito.

Para release estable aplica `docs/release-validation.md`: packaging/smoke nativos,
Windows 11 con sus once checks reales de cuenta/integración, macOS con los checks
interactivos indicados y Linux con packaging/desktop y checks requeridos antes de
claim de soporte. Incluir clean install/upgrade, cancelación, sesión/config
preservadas, modos/connector/model catalog y flujos afectados. No hay evidencia
actual de esos gates de release para este candidato; el test omitido de plataforma
no debe presentarse como aprobado.

Los resultados históricos de otra versión no certifican este build. Prerelease,
updater, tags/signing/checksums y publicación requieren alcance explícito y gates
revisados; no invocarlos como efecto secundario de canarios verdes.

## 16. Mapa de código y dispatch a agentes

| Área | Archivos principales |
| --- | --- |
| Captura/build/arranque | `scripts/build-development-runtime.ts`, `launcher/scripts/dev.cjs`, `launcher/electron/development-runtime.cjs`, `runtime-command.cjs`, `runtime-supervisor.cjs`, `runtime-startup-gate.cjs` |
| Identidad | `src/runtime-identity.ts`, `src/adapters/chatgpt-web/helper-protocol.ts`, `launcher-helper-client.ts` |
| Responses/HTTP | `src/server/response-route.ts`, `src/responses/compaction.ts`, `src/server/host-prompt-preflight.ts` |
| Prompt/procedencia/transporte | `src/adapters/chatgpt-web/prompt/compiler.ts`, `types.ts`, `sanitization.ts`, `record-fragments.ts`, `src/responses/compaction-contract.ts` |
| Medición/multipart | `src/adapters/chatgpt-web/input-tokens.ts`, `browser/multipart-plan.ts`, `compaction-repair.ts` |
| Checkpoint/recuperación | `src/adapters/chatgpt-web/compaction-policy.ts`, `compaction-handoff.ts`, `adapter/compaction-checkpoint.ts`, `adapter/compaction-flow.ts`, `session-actor/`, `rolling-checkpoint.ts` |
| Lifecycle/browser | `src/adapters/chatgpt-web/browser-worker.ts`, `browser/turn-events.ts`, `turn-page-binding.ts`, `turn-wake.ts`, `turn-completion-loop.ts`, `dom-signal.ts`, `submission-observer.ts`, `turn-execution/feeds.ts`, `compaction-transaction.ts` |
| MCP/terminal | `src/adapters/chatgpt-web/turn-terminal.ts`, `mcp-observation.ts`, `mcp-telemetry.ts`, `turn-broker.ts`, `mcp-server.ts` |
| Diagnóstico causal | `src/diagnostics/index.ts`, `errors.ts`, `events.ts`, `sink.ts`, `src/adapters/chatgpt-web/compaction-observability.ts` |
| Gates/evaluación | `scripts/harness-live-canary.ts`, `check-harness-continuity.ts`, `compare-harness-prompts.ts`, `compaction-canary-report.ts`, `tests/fixtures/continuity-replay.ts` |

Rutas abreviadas continúan el directorio del primer archivo de su grupo cuando
sea inequívoco. Resolver rutas reales antes del dispatch; no asumir un fichero
`session-actor.ts` cuando la autoridad actual vive en `session-actor/`.

Ownership original: agente A kernel/producción/regresiones específicas; agente B
fixtures/replay/evaluación/gates/evidencia y revisión readonly de producción.
Nuevas delegaciones deben enumerar archivos exclusivos existentes/propuestos,
base commit, objetivo, invariantes, pruebas, evidencia y dependencias de integración.
Un test pertenece a un solo escritor. A/V son roles distintos de esos ownerships,
con separación acreditada; B no aprueba automáticamente su propia infraestructura.

Propuesta para avanzar antes de ventana:

- Dispatch de revisión/SAST/gobernanza: snapshot readonly, reports privados y
  recibos nuevos. Sin editar producción, candidate directory o ledger previo.
- Dispatch de rollback/inventario: artefactos privados y runbook, sin restart/
  install/setup. Lectura de producción; scripts nuevos sólo con ownership declarado.
- Dispatch de evaluación: workspace benchmark aislado, manifest/matriz/evaluador
  y tests propios. No cambiar el harness durante la campaña.
- Fixes de kernel: integración serial de bugs reproducidos, tests afectados,
  revisión y candidato nuevo antes de iniciar aceptación.

## 17. Primera acción y checklist de salida

Primera acción: M0 read-only, leer recibos y reglas, identificar blockers vivos.
Después iniciar M1/M2/M3 independientes. No empezar compactaciones reales mientras
falte un gate previo; no detener preparación porque la ventana aún no existe.

Checklist para el siguiente handoff, si no se completa toda la campaña:

- HEAD/branch/source-inputs/build/runtime identities exactos; estado limpio/sucio.
- M0–M12 con estado pendiente/en progreso/aprobado/fallido/no aplicable y evidencia.
- Owners y archivos de cambios no integrados, sin perder trabajo de otra sesión.
- Último preflight y blockers con timestamp, no PIDs supuestos ni ceros inventados.
- Canarios realmente ejecutados, duración y ruta observada, incluso intentos fallidos.
- Comandos/gates pendientes y razón; siguiente acción técnica concreta.
- Rollback disponible/no disponible y forma segura de retomar.
- Ubicación privada de datos sensibles; sólo referencias sanitizadas compartibles.

No dejar un nuevo handoff que mezcle un candidato histórico con el actual, ni
convierta tareas propuestas en ejecución acreditada. El estado inicial de este
roadmap es **implementación local verificada; aceptación operativa y release R2
pendientes**, con cero compactaciones reales y cero sesiones largas acreditadas.
