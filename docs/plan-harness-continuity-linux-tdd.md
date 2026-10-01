# Plan de continuidad fiable en Linux por sprints TDD

## 1. Objetivo, alcance y organización

Cerrar los bugs y gaps pendientes del flujo **Codex → Responses/SSE → ChatGPT web → MCP → herramientas → resultados → continuación**, conservando el chat temporal cuando sea seguro y evitando repetir efectos.

La iniciativa se clasifica **R2 × L** por autorización de capacidades, concurrencia, persistencia y recuperación. Se trabajará sobre la arquitectura existente, sin reemplazar el adaptador ni crear otra autoridad de recuperación.

- **Ejecución por actividades:** las actividades (sprints) se ejecutan de forma serial en una única sesión de trabajo. No hay un segundo agente ejecutor ni un hilo supervisor paralelo; la unidad de planificación, ejecución y entrega es la actividad.
- **Aprobación:** el usuario, como operador del entorno, revisa en los puntos de entrega que defina. El ejecutor nunca convierte su propia evaluación en aprobación ni activa candidatos pendientes de los controles requeridos.
- **Separación R/A/V de SHS:** la exigencia R2×L se satisface con gates mecánicos verificables (tests RED→GREEN, typecheck, lint, gates estructurales, SAST), evidencia reproductible y revisión humana real en los cierres de actividad. Los controles independientes sustituyen a la ficción de un segundo rol; donde SHS exige aislamiento demostrado (firmas, verificador independiente), el gate queda pendiente y se declara, no se simula.
- **Plataforma:** únicamente el Linux actual. Publicación, merge y certificación Windows/macOS quedan fuera.
- **Cadencia:** sprints secuenciales, definidos por entregables verificables, sin estimaciones de duración inventadas.

**Registro vivo:** el estado por sprint, el backlog reconciliado con el handoff M0–M12 y la matriz de trazabilidad viven en [harness-continuity-sprint-log.md](harness-continuity-sprint-log.md). Este plan es la especificación; el registro es su estado de ejecución.

**Fuentes iniciales:** el handoff vigente, el ADR de continuidad y los diagnósticos de incidentes. El baseline observado es `07fdd11`; debe verificarse nuevamente al comenzar. Los PIDs, versiones, hashes y cifras históricas son evidencia anterior, no estado vivo garantizado.

## 2. Decisiones e invariantes obligatorios

### Continuidad y autorización

Mantener separadas cuatro identidades dentro del actor existente: hilo nativo, época de ejecución, conversación remota y operación con sus recibos.

- ESC significa **detener y conservar** cuando la detención esté confirmada.
- Continuar inicia otro turno, con una capacidad nueva, dentro del mismo hilo.
- Una capacidad revocada por interrupción nunca recupera permisos mediante alias o lineage.
- Conservar la conversación no conserva los permisos anteriores.
- Cancelar una herramienta no demuestra que su efecto externo se haya revertido.
- `close()` conserva su semántica actual de abort y liberación; no se transforma en pausa.

### Persistencia y contratos

- El journal existente sigue siendo la autoridad durable de operaciones.
- Añadir el resultado **`interrupted`** para una operación de navegador cuya detención se haya confirmado; no equivale a `completed` ni a `not_sent`.
- Persistir solicitud, evidencia de detención y cursor de continuación antes de habilitar reutilización.
- Las herramientas y entregas ambiguas siguen requiriendo reconciliación independiente.
- Evolucionar el protocolo interno del actor desde versión 5 a 6 para los eventos nuevos.
- Negociar una feature interna `interrupt_retention_v1` entre CLI/helper/launcher. Una combinación incompatible no habilita retención tras ESC.
- Conservar nombres y schemas públicos MCP, contrato checkpoint v2 y Responses/SSE.

### Contexto y salud

- Chat temporal por defecto; guardado sólo por elección explícita.
- Compactación de Codex y rotación del chat web son decisiones independientes.
- En una conversación válida se transmite el delta autorizado.
- Al cambiar de conversación se utiliza checkpoint validado, delta y referencias recuperables.
- No truncar silenciosamente instrucciones esenciales para cumplir el presupuesto reducido.
- Compactar Codex no reinicia los contadores físicos del chat remoto.
- Ningún timeout después de Send autoriza reenvío automático.

## 3. Sprints de ejecución

### Sprint 0 — Baseline, inventario y backlog verificable

**Objetivo:** establecer qué está implementado, qué falla y qué aceptación sigue pendiente.

**Trabajo:**

- Crear el documento del plan y un registro de sprints con estado, dependencias, commits y evidencias.
- Inspeccionar Git, instrucciones, runtimes, puertos, integración Codex, launcher, helper, catálogo y configuración relevante.
- Identificar los artefactos realmente cargados y las versiones de Codex utilizadas por terminal e IDE.
- Reconciliar M0–M12 del handoff con el código vigente. La selección explícita de recibos del collector ya existe: verificarla, no reimplementarla.
- Registrar separadamente bugs reproducidos, hipótesis, incidentes sin causa demostrada y gates pendientes.
- Definir las fronteras de prueba: worker público, lifecycle del launcher, observación/liveness, API del broker, actor/journal, helper IPC y Responses/SSE.

**Salida:** baseline sanitizado, backlog trazable y matriz requisito → sprint → prueba → evidencia.

**Criterio de cierre:** ningún pendiente descartado sin evidencia; ninguna operación sobre sesiones ajenas.

### Sprint 1 — Revocación terminal y aislamiento del broker

**Objetivo:** eliminar la readmisión de capacidades interrumpidas.

**RED:**

- Registrar A, interrumpirlo, registrar B para el mismo hilo y comprobar que A no puede resolver, reclamar ni invocar sobre B.
- Cubrir alias explícitos, cadenas de alias y recuperación por trace/thread.
- Comprobar que una solicitud tardía no adquiere permisos de otra época.

**GREEN:**

- Diferenciar retirada compatible para continuación autorizada de revocación terminal.
- Validar época y propietario en admisión, binding y despacho.
- Mantener los alias legítimos dentro de su alcance autorizado.
- Evitar que resultados tardíos creen nuevas autorizaciones.

**Criterio de cierre:** cero readmisiones del token interrumpido, continuaciones legítimas preservadas y aislamiento entre hilos comprobado.

### Sprint 2 — Interrupción confirmada y conservación del chat

**Objetivo:** corregir la pérdida de conversación y el bloqueo posterior a ESC.

**RED:**

- Interrumpir antes de Send, después de aceptación y durante una herramienta.
- Interrumpir cuando la herramienta ya terminó, pero su entrega sigue pendiente.
- Repetir ESC y simular fallo de Detener, respuesta tardía y cierre del helper.

**GREEN:**

- Persistir `interrupt_requested` y revocar admisión antes de solicitar Detener.
- Acusar recibo dentro del presupuesto existente de dos segundos del hook, sin esperar un resumen del modelo.
- Confirmar asincrónicamente la detención sobre la respuesta y superficie exactas.
- Usar diez segundos como presupuesto inicial de confirmación física; al vencer, mantener reconciliación pendiente, no declarar detención.
- Registrar `interrupted` con evidencia verificable y retener la conversación.
- Liberar la ejecución y el lock interactivo sin borrar el binding recuperable.
- Tratar la ausencia de observadores como falta de evidencia, no como superficie desaparecida.
- Implementar migración transaccional y recuperación del journal; no convertir automáticamente incertidumbres históricas en interrupciones.

**Criterio de cierre:** ESC conserva el chat cuando existe confirmación; una detención no confirmada no habilita continuación ni produce éxito ficticio.

### Sprint 3 — Continuación segura y errores transparentes

**Objetivo:** continuar en el mismo chat sin duplicar historial ni herramientas.

**RED:**

- Continuar después de una respuesta parcial sin assistant final.
- Repetir la solicitud nativa tras una desconexión.
- Cambiar modelo, esfuerzo, contexto autorizado o identidad de conversación.
- Perder el chat conservando un checkpoint válido.
- Intentar compactar mientras existen efectos pendientes de reconciliación.

**GREEN:**

- Persistir un cursor ligado al prefijo/padre nativo, revisión, época, respuesta remota y recibos por llamada.
- Crear capacidad nueva y enviar únicamente el delta cuya procedencia esté acreditada.
- Conservar resultados terminados; reconciliar la entrega sin reejecutar su efecto.
- Mantener la respuesta parcial como evidencia, no como checkpoint confirmado.
- Cuando falte el chat, aplicar checkpoint compatible y delta; ante incompatibilidad, conservar la vía canónica segura.
- Propagar errores tipados de reconciliación, conversación perdida y handoff fallido, preservando la causa.
- No presentar un retry como solución cuando el estado requiere reconciliación.

**Criterio de cierre:** primera acción de continuación correcta, ninguna llamada duplicada y ninguna continuación autorizada por contexto parcial sin procedencia.

### Sprint 4 — Stream interrumpido, liveness y diagnóstico causal

**Objetivo:** terminar la espera indefinida que puede ocultar el botón Detener.

**RED:**

- Reproducir el aviso observado en español e inglés con Detener visible.
- Cubrir recuperación transitoria, interrupción sostenida y herramienta legítimamente activa.
- Excluir texto citado, indicadores ocultos y estados pertenecientes a otro turno.
- Simular errores de observación, red y callbacks del consumidor.

**GREEN:**

- Reconocer el estado localizado dentro de la respuesta asignada.
- Separar "Detener visible" de progreso acreditado.
- Aplicar una gracia inicial de **180 segundos** ante aviso sostenido sin progreso.
- Reiniciar esa ventana sólo por progreso de la respuesta o actividad efectiva de herramientas; conservar los límites existentes de leases.
- Al agotarse, emitir `remote_connection_interrupted`, preservar evidencia y no regenerar ni reenviar.
- Observar salud durante el turno, con frecuencia máxima de una muestra cada diez segundos y cambios de estado inmediatos.
- Registrar clase de petición, frontera, causa, generación y operación con datos sanitizados.

**Criterio de cierre:** recuperación transitoria permitida y fallo sostenido acotado, sin introducir un límite general de duración para tareas sanas.

### Sprint 5 — Compactación, presión remota y fidelidad

**Objetivo:** reducir contexto sin confundirlo con la permanencia del chat.

**RED:**

- Compactar Codex conservando conversación y continuar.
- Compactar varias veces sin poner artificialmente el presupuesto remoto en cero.
- Rechazar handoff incompleto, sin `response.completed` o con número incorrecto de items.
- Cubrir presupuesto inicial excesivo, payload multipart y requisitos literales grandes.
- Comprobar incompatibilidad de checkpoint, revisión y generación.

**GREEN:**

- Mantener uso local veraz y separado del preflight de reenvío.
- Contabilizar contenido realmente añadido al chat y resultados MCP, evitando contar contexto que no se transmitió.
- Mantener los límites conservadores existentes hasta disponer de calibración suficiente; registrar discrepancias entre estimaciones.
- Conservar checkpoint de fase oportunista y evidencia recuperable, sin exigir una llamada al modelo durante ESC.
- Validar y persistir el checkpoint antes de aceptación y entrega.
- Rotar por pérdida o presión acreditada; no por tiempo transcurrido.
- Verificar el contrato contra las versiones instaladas de Codex. Leer `main` no acredita compatibilidad futura.

**Criterio de cierre:** requisitos y siguiente acción conservados en rutas retained/fallback, sin falsas liberaciones de contexto.

### Sprint 6 — Resiliencia, infraestructura de aceptación y rollback

**Objetivo:** preparar una campaña reproducible y una recuperación operativa segura.

**RED:**

- Reiniciar procesos aislados entre solicitud y confirmación, persistencia y entrega.
- Cubrir mensajes repetidos, fuera de orden, generaciones antiguas y pérdida de acknowledgements.
- Rechazar rollback incompleto, recibos incompatibles y mezcla de builds.

**GREEN:**

- Ejecutar chaos dirigido exclusivamente sobre fixtures y procesos propios.
- Preparar runner/procedimiento de aceptación real: el collector actual no ejecuta la campaña.
- Congelar veinte casos, obligaciones pendientes y oracles externos al resultado producido.
- Utilizar los flags existentes de selección de recibos.
- Preparar rollback con CLI, helper, dependencias, configuración necesaria, manifiestos y procedencia.
- Probar restauración sobre una copia aislada del journal, preservando datos.
- Si el rollback anterior no puede leer el journal nuevo, bloquear activación hasta resolver esa compatibilidad.

**Criterio de cierre:** runner y evaluador reproducibles; rollback completo probado, sin modificar el runtime activo.

### Sprint 7 — Seguridad, revisión y candidato Linux congelado

**Objetivo:** producir un candidato revisable e identificable.

**Trabajo y verificaciones:**

- Ejecutar SAST local con Semgrep Community Edition, versión y ruleset fijados por hash, control positivo y métricas desactivadas. Usar reglas locales y conservar resultados privados. [CLI oficial](https://docs.semgrep.dev/getting-started/quickstart), [control de métricas](https://docs.semgrep.dev/metrics).
- Reutilizar Gitleaks fijado en la evidencia existente y repetir escaneo de secretos sobre lo compartible.
- Ejecutar audits, typecheck, lint, gates, cobertura, launcher, contratos de navegador y build/smoke Linux.
- Conservar skips y warnings con explicación; exigir cero regresiones nuevas.
- Corregir la procedencia RED incompleta mediante reproducciones nuevas aisladas, sin falsificar historia.
- Añadir entradas de ledger append-only; verificar referencias y hashes.
- Preparar separación real entre implementador, verificador y aprobador. No presentar otro hilo o un worktree como aislamiento demostrado.
- Congelar el par CLI/helper con dependencias físicas y hashes; revisar exactamente ese snapshot.

**Criterio de cierre:** candidato y rollback verificables, hallazgos triados y controles independientes acreditados. Firmas o aislamiento pendientes mantienen el gate pendiente.

### Sprint 8 — Aceptación real Linux y cierre operacional

**Objetivo:** demostrar el comportamiento completo con el candidato congelado.

**Secuencia:**

1. Acreditar ventana inactiva, admisión cerrada y settlement físico; revalidar generación inmediatamente antes de cambiar artefactos.
2. Activar el par completo por la ruta soportada del launcher. Verificar identidad cargada y readiness.
3. Ejecutar un canary corto propio con herramienta local real, resultado, final y cleanup correlacionados.
4. Verificar ESC, conservación y continuación reales sobre una sesión de evaluación.
5. Ejecutar **dos sesiones independientes**, cada una con trabajo efectivo durante **más de 22 minutos** y **diez compactaciones reales**.
6. Buscar cinco rutas retained y cinco fallback por sesión mediante mecanismos soportados; registrar la ruta efectivamente observada.
7. Evaluar veinte checkpoints distintos: requisitos, steering, próxima acción, herramientas, resultados y checks finales.
8. Comprobar Browser-only sin MCP y Full con conector correcto. Preservar las restricciones de Zero Risk en los flujos afectados.
9. Medir recursos antes/después, bytes, tokens estimados y latencia con denominadores y muestras explícitos.
10. Actualizar diagnóstico de ACK multipart, `missing_state`, identidades múltiples y 401 históricos: causa probada, hipótesis o desconocida.

**Criterio de cierre:** campaña completa sin duplicados, mezcla de builds, pérdida de requisitos ni recursos pendientes. Un fallo detiene expansión; se preservan todos los intentos y se prepara un candidato nuevo cuando cambie producción.

## 4. Disciplina TDD y revisión por actividad

Para cada cambio significativo:

1. Escribir una regresión de comportamiento en una frontera definida.
2. Ejecutarla y comprobar que falla por la causa esperada.
3. Registrar commit RED, comando, entorno y resultado.
4. Implementar el cambio mínimo.
5. Registrar commit GREEN descendiente, ejecución y assertions.
6. Refactorizar con pruebas verdes y revisar errores, concurrencia y cleanup.
7. Entregar evidencia sanitizada del sprint.

No se aceptan pruebas que lean source para demostrar comportamiento, mocks que sustituyan lo que se afirma probar, asserts tautológicos ni relajación de timeouts para fabricar GREEN.

**Gates por sprint:** pruebas afectadas, typecheck, lint y controles estructurales. Añadir integración, launcher o navegador según la frontera modificada.

**Gates del candidato final:** suites completas seriales, cobertura por dominio, contratos reales de Chromium, build/smoke Linux, audits, SAST, secretos y verificación del par físico. Mantener el contrato worker menor de cinco segundos y los requisitos de cobertura adoptados por el proyecto.

Cada cierre de actividad registrará, en el sprint log y sus evidencias:

- Objetivo y requisitos cerrados, pendientes y afectados.
- Base, commits RED/GREEN, diff y estado del árbol.
- Comandos, resultados, skips, warnings y referencias de evidencia.
- Cambios de protocolo/persistencia y prueba de recuperación.
- Riesgos residuales y siguiente sprint.
- Veredicto propuesto, sin autoaprobarlo.

La revisión corresponde al usuario en los puntos de entrega que defina, o a un verificador independiente expresamente designado. El veredicto será **aceptado**, **requiere correcciones** o **bloqueado con causa**. Un resultado verde de tests no sustituye aceptación semántica ni operacional.

## 5. Definición de terminado y límites

La iniciativa termina cuando:

- ESC conserva una conversación detenida y confirmada.
- Continuar usa capacidad nueva y delta con procedencia.
- Los tokens revocados permanecen inválidos.
- La compactación local y la presión remota funcionan independientemente.
- Los errores preservan causa y recuperación posible.
- No existen reenvíos automáticos tras efectos aceptados o ambiguos.
- Migración, reinicio y rollback están probados.
- La campaña Linux completa y la evaluación independiente están acreditadas.
- Journal, recursos, diagnósticos y documentación conservan trazabilidad.
- Cada gap tiene evidencia de cierre o una limitación explícita; una causa desconocida nunca se etiqueta como corregida.

La documentación y los artefactos preparables pueden completarse sin ventana operacional. La activación espera una ventana real y sus controles, sin cancelar trabajo ajeno.
