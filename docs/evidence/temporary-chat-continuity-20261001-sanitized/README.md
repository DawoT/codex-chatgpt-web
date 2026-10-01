# Evidencia sanitizada de continuidad temporal

Esta copia publica resultados y logs de fixtures/canary propios, sin rutas personales.
Los recibos originales sellados y el ledger histórico permanecen intactos en el
workspace. El directorio original se excluye localmente de Git. Su hash original
figura en `verification.json`; esta copia tiene hashes derivados y no sustituye
retroactivamente los recibos originales del ledger. Una clonación sólo contiene
esta evidencia sanitizada, no los originales locales.

Código: `705ccba` (uso de contexto), `dc29a6d` (rate limiter), `47244a6`
(continuidad). Los source hashes medidos siguen siendo los del candidato probado.
Los commits no reconstruyen ni reinician el servidor que está trabajando.

La arquitectura y comandos reproducibles están en
[la ADR de continuidad](../../temporary-chat-continuity.md). La evidencia pública
actual es [verification.json](verification.json). Los paths `<repo>`, `<profile>`
y `<user-home>` son marcadores de redacción; para ejecutar el smoke se utiliza
el descriptor de build local real, nunca esos marcadores como rutas ejecutables.

Resultados: 2360 tests aprobados, 14 omitidos; 115 focalizados y 37 contratos de
navegador aprobados. Typecheck, lint y gates pasaron. Canary real: tres turnos,
dos checkpoints confirmados, mismo chat en la continuación y superficie nueva
tras liberar sólo el chat de prueba. La aplicabilidad del checkpoint al contexto
canónico recuperado se comprobó por replay local; no es una medición del DOM.
La campaña extensa de sesiones/compactaciones y la aprobación independiente de
release permanecen pendientes.
