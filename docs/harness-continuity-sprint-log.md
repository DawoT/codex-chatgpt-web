# Registro de sprints — continuidad fiable (Linux, TDD)

Especificación: [plan-harness-continuity-linux-tdd.md](plan-harness-continuity-linux-tdd.md).
Gobernanza SHS: **R2×L**. Ejecución por actividades, serial, sin segundo agente;
la aprobación es del usuario en los puntos de entrega. Este registro es append-only
en sus entradas cerradas: las correcciones se añaden como entradas nuevas que
referencian la original.

## 1. Baseline verificado (Sprint 0, 2026-10-01)

| Dato | Valor observado |
| --- | --- |
| Rama | `refactor/harness-continuity` |
| HEAD al abrir el Sprint 0 | `07fdd11` (plan baseline) |
| HEAD al cerrar el Sprint 0 | `9998126` (reparación del incidente integrada en 6 commits) |
| Árbol de trabajo | Limpio tras los commits del Sprint 0 |
| Bun / Node | `1.4.2` / `v26.10.0` |
| Checkout real | `/home/deuz/projects/codex-chatgpt-web` (`/home/deuz/Proyectos` es symlink) |
| Worktrees adicionales | `/home/deuz/verify-wt`, `/tmp/cgw-continuity-*`, `/tmp/continuity-baseline-9c6e02a` — históricos, sin tocar |
| Launcher | Electron del launcher **activo** al momento del inventario; no se reinicia ni activa nada esta vuelta |
| Admisión del daemon | `{"capacity":8,"active":[],"waiting":0}` (vacía, read-only) |
| `AGENTS.md` local | No existe en el checkout; las reglas aplicables vienen de CONTRIBUTING, handoff y plan |

Gates ejecutados sobre el árbol final del Sprint 0 (serie serial):

| Gate | Resultado |
| --- | --- |
| `bun test ./tests` | 2374 pass, 14 skip, 0 fail; 13383 assertions; 234,97 s |
| Contratos Chromium real (`/usr/bin/google-chrome`) | 37 pass, 0 fail; 257,47 s |
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0; 88 warnings de baseline, 0 errores |
| `bun run check:refactor-gates --strict` | PASS |
| Compilación aislada CLI/helper + `node --check` | Válida, fuera del runtime activo |

## 2. Estado de sprints

| Sprint | Objetivo | Estado | Commits / evidencia |
| --- | --- | --- | --- |
| S0 | Baseline, inventario, backlog | **Cerrado** (esta entrada; veredicto propuesto: aceptado, pendiente revisión) | `788f4aa`…`9998126` + este documento |
| S1 | Revocación terminal del broker | **Pendiente** | — |
| S2 | Interrupción confirmada y conservación del chat | **Parcial** (heredado + esta vuelta) | Retención de chats temporales: `47244a6`. Barrera de reconciliación tipada y rechazo de reemplazo de turno incierto: `84326ae`. Pendiente: `interrupt_requested`, ack ≤2 s, confirmación física ≤10 s, resultado `interrupted` |
| S3 | Continuación segura y errores transparentes | **Parcial** (heredado) | Cursor/recuperación por journal: `d648f39`. Errores tipados de reconciliación: `788f4aa`. Pendiente: cobertura RED de los cinco escenarios del sprint |
| S4 | Stream interrumpido, liveness, diagnóstico causal | **Sustancialmente implementado** | Detección localizada del aviso, separación Detener/progreso, gracia 180 s, fallo tipado sin reenvío: `533c219`. Clasificación causal de fallos de petición: `688eda1`. Diagnóstico del incidente: `9998126` |
| S5 | Compactación, presión remota, fidelidad | **Parcial** | Ráfaga urgente → `compactionRequired`: `a0cd9ab`. Resto pendiente |
| S6 | Resiliencia, aceptación, rollback | **Pendiente** | — |
| S7 | Seguridad, revisión, candidato congelado | **Pendiente** | — |
| S8 | Aceptación real Linux | **Bloqueado por ventana** | Requiere ventana operacional real y candidato de S7 |

### Discrepancia abierta de S4 (decisión documentada, no relabelada)

- El plan pide emitir `remote_connection_interrupted` al agotarse la gracia. La
  implementación emite el error tipado estable `chatgpt_stream_interrupted` (502) y
  eventos `page_request_failed` con causa de transporte sanitizada; no existe un evento
  diagnóstico con ese nombre. Pendiente de decisión en la verificación de S4: añadir el
  evento de diagnóstico o registrar la equivalencia semántica en el plan.
- La observación de salud por muestreo (≤1 muestra/10 s, cambios inmediatos) se satisface
  hoy por la observación dirigida por eventos (wake por mutación/progreso, publicación
  inmediata de `stop_button_visibility_changed`), no por un sampler temporizado nuevo.
  Verificar en la revisión de S4 que esa equivalencia es aceptable.

## 3. Backlog reconciliado M0–M12 → sprints

| Handoff | Trabajo | Sprint heredero |
| --- | --- | --- |
| M0 | Inventario vivo read-only | S0 (cerrado; relecturas obligatorias al comenzar cada sprint) |
| M1 | Gobernanza R2, SAST, procedencia RED | S7 |
| M2 | Rollback completo | S6 |
| M3 | Runner/matriz de canarios | S6 |
| M4 | Congelar candidato + gates | S7 |
| M5–M6 | Ventana inactiva, activación | S8 |
| M7 | Viaje completo startup→Codex→web→MCP | S8 |
| M8 | 2 sesiones >22 min / 20 compactaciones | S8 |
| M9 | Diagnóstico de incidentes | S2–S5 (reproducibles) + S8 (causalidad de sesiones reales) |
| M10 | Recursos, fidelidad, eficiencia | S8 |
| M11 | Decisión operacional y cierre | S8 |
| M12 | Integración/publicación | Fuera de alcance sin encargo explícito |

La selección explícita de recibos del collector quedó verificada en `8be1ef0`; no se reimplementa.

## 4. Registro separado del Sprint 0

### Bugs reproducidos y cerrados (TDD, evidencia en `9998126`)

1. Detener visible ocultaba el estancamiento durante la interrupción del stream.
2. `claimed` antiguo contaba como llamada activa indefinida.
3. Un envío nuevo bloqueado reemplazaba al propietario del turno incierto.
4. La detección global del aviso confundía contenido y turnos ajenos.
5. El aviso abortaba respuestas que seguían creciendo.
6. Una respuesta vacía interrumpida perdía el error tipado.
7. Fallos conocidos se reducían a `Operation failed` sin código estable.
8. `page_request_failed` perdía categoría y causa de transporte.
9. La ráfaga urgente no llegaba a la decisión de `compactionRequired`.
10. (Añadido al alinear la gracia a 180 s) La ventana de 60 s de la acción de
    finalización precedía al error tipado durante una interrupción sostenida;
    su conclusión se difiere al tracker de interrupción mientras el aviso es visible.

### Hipótesis declaradas no probadas

Saturación de DOM/SSE como causa raíz; límite universal de 30–40 min o 50
herramientas; throttling/moderación; deadlock SQLite (la barrera es lógica
deliberada). Detalle y veredicto: [browser-connection-interrupted-20261001.md](browser-connection-interrupted-20261001.md).

### Incidentes sin causa demostrada (abiertos)

- ACK multipart parte 2 expirado a 180001 ms: fase de fallo desconocida.
- Checkpoint `missing_state`: representación/extracción/obediencia sin atribuir.
- Identidades múltiples observadas: causalidad no atribuida.
- 401 históricos: sin endpoint/build correlacionados.
- SIGTERM (exit 143) en una suite intermedia de la sesión anterior: sin causa.

### Gates pendientes de la iniciativa

SAST Semgrep fijado por hash (S7); secret scan sobre compartibles (S7);
rollback completo probado (S6); runner de campaña real (S6); separación mecánica
R/A/V y firmas (S7 — quedará pendiente si no hay verificador independiente);
ventana operacional real (S8).

## 5. Fronteras de prueba y matriz de trazabilidad

| Frontera | Suite principal |
| --- | --- |
| Worker público | `tests/browser-worker*.test.ts`, `tests/fixtures/worker-harness.ts` |
| Lifecycle del launcher | `launcher/tests/` |
| Observación/liveness | `tests/turn-completion-loop.test.ts`, `tests/turn-liveness.test.ts`, `tests/browser-stream-interruption*.test.ts` |
| API del broker | `tests/turn-broker*.test.ts` (frontera de S1) |
| Actor/journal | `tests/session-actor.test.ts` |
| Helper IPC | `tests/continuity-diagnostics-browser.test.ts`, contratos helper |
| Responses/SSE | `tests/` de server/responses (rate-limit, preflight) |

| Requisito (plan §2) | Sprint | Prueba | Evidencia |
| --- | --- | --- | --- |
| Separar Detener visible de progreso acreditado | S4 | `browser-stream-interruption.test.ts` (uiGenerationIsLive), `turn-completion-loop.test.ts` (stale Stop) | `533c219` |
| Gracia inicial 180 s, reinicio sólo por progreso corroborado | S4 | `browser-stream-interruption.test.ts` (grace), `turn-completion-loop.test.ts` (181 s fail-closed; recuperación con crecimiento) | `533c219` |
| No regenerar ni reenviar tras fallo sostenido | S4 | `chatgpt_stream_interrupted` retryable=false; `h.deltas` vacíos | `533c219` |
| Reconciliación independiente para efectos ambiguos | S2/S3 | `session-actor.test.ts` (reemplazo y duplicado rechazados) | `84326ae` |
| Causas tipadas preservadas por IPC/diagnóstico | S3/S4 | `continuity-diagnostics-browser.test.ts` (contratos públicos) | `788f4aa`, `688eda1` |
| Heurísticas de retención ≠ límite obligatorio de entrada | S5 | `predictive-context-pressure.test.ts` (prompt viable no fuerza compactación) | `a0cd9ab` |
| Cero readmisiones del token interrumpido | S1 | Pendiente de RED | — |

## 6. Próxima actividad

**S1 — Revocación terminal y aislamiento del broker.** Primer paso: RED en la
frontera del broker (registrar A, revocar por interrupción, registrar B del mismo
hilo, comprobar que A no resuelve/reclama/invoca sobre B; alias, cadenas y
solicitudes tardías). Ningún trabajo de activación: el launcher sigue en uso.
