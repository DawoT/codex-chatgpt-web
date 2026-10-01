# Evidencia local — diagnóstico causal y continuidad

El recibo vigente es [harness-continuity-verification.json](../harness-continuity-verification.json).
La medición comparable está en [harness-continuity-gates.json](../harness-continuity-gates.json).
Los recibos de `98bef09` se conservaron como históricos y baseline; no identifican
el candidato operativo actual.

`log-index.json` contiene SHA-256 de los archivos de este directorio, excluyéndose
a sí mismo. Los logs `.txt` son copias de ejecuciones locales, no logs privados de
conversaciones. `candidate-manifest.json` y `built-pair-smoke.json` identifican el
par físico ejecutable y el smoke sin Send. `live-health.json` es una observación
read-only del runtime anterior, no una certificación de inactividad.

El detector genérico marcó una línea de `full-suite-final.txt` con un hash corto
de token del fixture de churn del broker. Se redactó esa línea antes de versionar;
el log bruto permanece fuera de Git y su SHA se registra en el recibo. Los
resultados finales de la suite se conservaron. El índice describe la copia
redactada, no los bytes originales.

`log-normalization.json` registra los hashes anteriores y posteriores a retirar
espacios finales de los logs para pasar el control de whitespace de Git. Esa
normalización no cambia los resultados ni convierte el log en un snapshot de código.

Los pares `*-red.txt` / `*-green.txt` registran fallos reproducibles y su corrección.
RED se ejecutó agregando la regresión al árbol de trabajo anterior a la corrección;
no existe un commit separado de cada overlay RED. Los commits GREEN se identifican
en el handoff y en el ledger. No atribuir los logs a un snapshot limpio diferente
ni presentar un overlay como commit RED verificable.

Los informes de revisión conservan su snapshot y límites originales: el reviewer
operó en otra conversación y leyó fuentes mutables. Sus reproducciones justifican
regresiones, pero no equivalen a revisión formal del commit final con aislamiento
R/A/V comprobado.

La aceptación local cubre tests, contratos reales del navegador, build congelado,
auditorías de dependencias y detector de secretos con control positivo sintético.
No acredita canarios reales, obediencia del modelo tras compactación, rollback
completo del daemon previo, SAST dedicado ni firmas criptográficas de aprobación.
La activación permanece pendiente; no se interrumpió el runtime ocupado.
