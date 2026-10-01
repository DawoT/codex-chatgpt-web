# Incidente de cálculo de uso después del reinicio

Fecha: 2026-10-01. Cambio R2×M por su efecto sobre cancelación y entrega de
herramientas de un turno activo. Investigación e implementación directas, sin
subagentes. Registro local de evidencia; no aprobación independiente de release.

## Causa demostrada

El reinicio cargó el candidato preparado: CLI `6fe17b7f…b3e20`, helper
`f9329682…28c6`, artifact set
`0d84b435ab0459319019e596aaf5ee94c68dfcf8c5f4032659b2bc818ae1ae7f`.
Ambos declararon `paired_manifest_verified` y build `a25e1ef`.

El incidente pertenece al trace `cc59d5d5464c`, modelo
`chatgpt-web/gpt-5.6-sol`, esfuerzo `high`. La primera llamada de herramienta
aparece a las 17:18:37 UTC; once resultados llegaron al host antes del fallo de
las 17:19:45.158 UTC. La siguiente llamada quedó pendiente. La solicitud original
ya había sido aceptada por el navegador.

El stack acredita esta cadena:

```text
emitRoundBatch / emitToolBatch
  estimateChatGptWebUsage
    resolveBiggerContextMultipartParts
      selectCompiledChatGptWebTransport
        buildMultipartPlan
          assertChatGptWebMultipartInputWithinLimits
```

La selección hipotética de transporte rechazó un mensaje de 46.726 caracteres
contra el límite local de 45.000, con código `context_length_exceeded`. No era
un rechazo de contexto recibido de ChatGPT: falló el cálculo local de uso que
acompañaba la emisión de la siguiente herramienta.

El último uso de entrada informado era 64.921 tokens estimados y Codex anunciaba
una ventana de 240.300. Después del error el rollout mostró un contador de
240.300 con última entrada cero; ese evento posterior no prueba que el modelo
hubiera consumido toda la ventana. Los contadores acumulados de facturación de
varias solicitudes tampoco representan el tamaño del contexto de una solicitud.

Un chat inicial puede acumular mucho texto durante su primer turno: dos resultados
registraron aproximadamente 40.200 bytes cada uno. Ese crecimiento disparó la
planificación equivocada mientras continuaba la misma conversación del navegador.
No se publican comandos, prompts ni resultados privados.

## Decisión e implementación

`estimateChatGptWebUsage` mide el contexto lógico acumulado con el compilador y
tokenizador existentes. Deja de invocar el selector de transporte según Bigger
Context para cada resultado de herramienta o respuesta final. Se conserva el
argumento de compatibilidad de la función; no controla la medición ordinaria.
Las métricas siguen declarando `estimated: true` e incluyen historial, contratos,
imágenes, skills y reserva de plataforma. No son mediciones de uso del proveedor.

Se conservan la FSM, el journal y las reglas de lifecycle. El arreglo impide que
una medición de uso convierta una entrega válida en cancelación. La preparación
del prompt y `buildMultipartPlan` siguen validando límites antes de un Send real;
no se elevan límites, descartan registros ni autorizan reenvíos.

La regresión unitaria presenta historial de herramientas que ningún transporte
nuevo puede llevar: la selección sigue rechazándolo y el cálculo de uso devuelve
una estimación creciente. La regresión de integración usa el broker real con un
worker de navegador controlado: una herramienta añade contexto grande y la
respuesta final se entrega con un único arranque de navegador, tanto con Bigger
Context activado como desactivado. Esta integración no acredita una nueva prueba
contra ChatGPT autenticado.

## Verificación y procedencia

La reproducción inicial produjo dos fallos esperados. Se repitió RED desde un
archivo Git del HEAD registrado, superponiendo únicamente los tests de regresión;
GREEN añadió únicamente el archivo de producción corregido. El recibo conserva
los hashes de esos archivos y de los logs originales privados. No hay un commit
RED separado, firmas A/V ni verificador independiente. No se fabrican.

La suite completa pasó con 2.341 tests, 14 skips y cero fallos. Typecheck y los
gates estructurales pasaron. Lint pasó con 88 warnings existentes. Se construyó
un snapshot aislado con dependencias del lockfile congelado; CLI `--version` y
handshake/shutdown del helper verificaron el par físico. El home del smoke del
helper fue temporal, sin navegador ni puerto de producción.

El [recibo](evidence/usage-accounting-20261001/verification.json) recoge comandos,
resultados, hashes de fuentes y artefactos, además de los límites de aceptación.
Para repetir las regresiones:

```bash
bun test tests/chatgpt-web-usage-boundary.test.ts tests/chatgpt-web-harness.test.ts \
  -t 'usage measures accumulated|recalculates active-turn usage'
bun run typecheck
bun run lint
bun run check:refactor-gates
bun test ./tests
```

## Gaps y estado operacional

- El host conserva `context_length_exceeded`, pero la captura final del helper
  contiene `abort_unknown`. La causa de cancelación pierde detalle al llegar al
  diagnóstico del navegador. El stack del host permite atribuir este incidente;
  el helper por sí solo no lo permite.
- El error tipado público mezcla límite de mensaje/transporte con ventana del
  modelo. La UI de Codex transforma ese código en un aviso genérico de ventana
  agotada. El arreglo elimina su emisión indebida durante medición; el diseño
  de códigos para rechazos auténticos de transporte queda pendiente.
- La evidencia estructurada del error no conserva las medidas 46.726/45.000;
  fue necesario correlacionar el stack privado. Añadir campos numéricos tipados
  en ese límite es trabajo de observabilidad pendiente.
- Hubo dos eventos `page_request_failed` anteriores. No hay evidencia que los
  conecte causalmente con este fallo local; no se atribuyen al contexto.
- Las pruebas de compilación y broker no sustituyen un canario autenticado del
  arreglo. El servidor cargado al iniciar esta investigación sigue siendo el
  candidato anterior al fix. Activar otro par exige la ventana segura y los
  controles del handoff; no se reinició ni se interrumpieron turnos ajenos.

Los recibos y el ledger históricos permanecen intactos. Esta evidencia no cierra
M1, rollback ni la campaña de compactaciones reales del handoff.
