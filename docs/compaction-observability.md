# Compaction and Native2 diagnostics

The next activated build emits one JSON object per line after `[chatgpt-web] compaction_event`.
The stable schema version is `1`. Each record carries a 12-character execution hash and its
broker handoff trace hash, phase,
outcome, route, elapsed milliseconds, and the loaded process identity (protocol, commit when
verified, artifact SHA-256, generation, PID). Validation issues become bounded codes; prompts,
checkpoint contents, raw errors, capability tokens, thread IDs, and source paths are not logged.

Compaction phases are `prepared`, `received`, `validated`, `repair_started`, `persisted`,
`accepted`, `delivered`, and `failed`. `received` requires the browser result and physical
settlement. `persisted` with `outcome: "skipped"` means local workspace persistence was not
applicable; it is never evidence of a durable checkpoint. `accepted` follows validation and the
persistence decision. Only `delivered` records completion emission. A successful `validated`
record alone is not a completed canary. The older `checkpoint_validation` log remains available
for existing consumers and now includes the same trace and issue codes.

To summarize saved daemon logs without exposing their content in the report:

```sh
bun run scripts/compaction-canary-report.ts /path/to/daemon.log
```

The script also accepts standard input. It counts unique traces, durable completions, deliveries
without local persistence, rejections, failures, incomplete traces, and mixed-build traces.
Mixed-build traces never count as complete. A durable completion requires `persisted` with
`localPersisted: true`, `accepted`, and `delivered` on one trace and one loaded build identity.
The report is a local aggregate, not proof of authenticated browser behavior or resumed task
continuation. The release canary still needs 20 real compact-and-continue observations, retained
and fallback coverage, and two sessions longer than 22 minutes. Record those facts separately.

Native2 MCP JSONL telemetry remains at `~/.codex-chatgpt-web/logs/mcp/telemetry.jsonl` with
rotation. Each new event includes the loaded MCP process identity. The process also writes
`transport_ready`, `transport_error`, and `transport_closed` with the same identity to stderr;
these lifecycle records contain no raw exception text. `call_received` proves the
request reached the local MCP transport. Later lifecycle events locate the broker, browser, host,
and response boundary. If an agent reports `Session terminated` but there is no matching
`call_received`, the local telemetry cannot establish whether ChatGPT attempted the call or where
it failed upstream. Compare the exact time window, connector state, daemon logs, and build
generation before assigning a cause. A successful direct host command does not test the ChatGPT
connector.

Activating this instrumentation requires the usual idle, verified-build handoff. Do not restart
or replace a daemon while other agents have active turns.
