# Review before context/memory integration

Reviewed clean HEAD `d44f2e6` and the host/MCP recovery boundaries introduced by
`2a606bc` and `46f2252`. Corrections remain uncommitted. The running launcher was
not redeployed as part of this source review.

## Reproduced defects and corrections

1. Byte reads always restarted at byte zero; `next_offset` could be mistaken for
   the existing line offset. Added explicit `offset_bytes` / `next_offset_bytes`,
   validated the 128 KiB ceiling, rejected mixed pagination modes and preserved
   UTF-8 boundaries. Invalid budgets and offsets return tool errors.
2. Command output truncated by UTF-16 indices while claiming a byte ceiling.
   Both streams now retain a UTF-8 prefix within their byte budgets. Omitted
   stdout and stderr bytes are reported separately and in total.
3. Root command exit could leave detached descendants alive when they inherited
   stdout/stderr. Cleanup at `close` waited for those same descendants to close
   the pipes. The command's unique cgroup is now killed on `exit`; no recycled
   process identifier is signaled at that point. The regression exercises a
   real descendant and verifies its later filesystem effect does not occur.
4. Telemetry retained nested secret fields and unrestricted error text. Nested
   metadata is discarded and errors become a generic diagnostic code. This is
   not an arbitrary-secret detector: future production callers must use a
   content-free schema for identifiers and scalar metadata.
5. A rejected telemetry write poisoned the instance queue permanently. The
   current caller still receives its error and later writes can recover.
6. Rotation checked the old size rather than the incoming record and failed to
   rotate with `maxFiles=1`. Rotation now accounts for the incoming record,
   rejects oversized records and validates retention settings.
7. Independent sink instances raced during rotation. A filesystem writer lock
   serializes append and rotation. Unknown/crashed locks fail after five seconds
   and require verified manual recovery; they are not stolen using elapsed time.
8. Queries followed symlink archives and accepted arbitrary matching filenames.
   Archive opens now refuse symlinks/nonregular files, enforce size limits, and
   select only retained numeric archive names. Query result limits are bounded.

## Invalidated evidence

### Additional loss of context found in production preflight

The adapter called `preparePreflightInput` before compiling ordinary and retained
requests. Above its character threshold, that helper replaced all but the latest
two heavy tool results with generic tombstones, including failed commands. This
discarded evidence independently of Pi's semantic compaction and without a
retrievable replacement reference.

Preflight now preserves the complete request and only recommends transport or
native compaction. The automatic pruning implementation was removed. Regression
fixtures reproduce an old failed operation containing an unresolved obligation
and source reference; both multipart and inline paths retain it exactly. Existing
tests and the dogfood check that treated deletion as success were replaced with
preservation checks. RED/GREEN evidence is in `/tmp/preflight-preservation-*.log`.

This character-based planner does not itself execute compaction or provide a
tokenizer-backed admission guarantee. The compiled-prompt tokenizer and browser
transport gates remain separate. Keeping evidence can increase payload size
until native compaction runs; no savings claim is made for this correction.

Following the request through the compiler found another independent loss path:
ordinary non-multipart compilation called `withAdaptiveHistoryPruning` after
preflight. That call has now been removed. A final-prompt regression first failed
on a historical command failure with an unresolved obligation and exact source
reference, then passed with its complete content retained
(`/tmp/compiled-preservation-red.log`, `/tmp/compiled-preservation-green.log`).
The legacy pruning helpers remain exported for existing callers/tests, but there
is no production invocation of that pipeline.

The special inline compaction loop also discarded oldest history to fit its
110,000-byte transport cap. That loop is now removed. For automatic browser mode,
an oversized inline compaction is rebuilt in six complete multipart stages and
token-counted, including attachments and acknowledgments, against the base model
window. Automatic staging does not enable the experimental context multiplier.
An excessive total raises `context_length_exceeded`; atomic stage limits also
remain enforced. Manual transport never automatically stages messages and still
rejects oversized inline input. Configured experimental multipart retains its
separate existing policy.

Regressions cover cumulative constraints, failed outputs, images, the base-window
ceiling and rebuilding a missing retained conversation with Bigger Context both
enabled and disabled. The compiler no longer emits omission notices or trimming
counts for newly compiled requests; legacy result metadata remains readable.
This implements transport escalation, not incremental semantic summarization or
proof of a real model's summary fidelity. RED/GREEN evidence is recorded in
`/tmp/auto-compaction-transport-*.log`; the earlier loss regression is in
`/tmp/compaction-fidelity-red.log`.

A later full bridge suite found one stale subagent test that still required the
removed destructive pruning: 1,489 passed, 12 skipped and one failed
(`/tmp/context-integration-full-latest.log`). Its assertion now checks that both
subagent and root compiled prompts retain the old tool output. The affected
subagent and preservation run passed 10 tests
(`/tmp/context-integration-affected.log`). The full suite was rerun after this
correction: 1,491 passed, 12 skipped and zero failed across 1,503 tests
(`/tmp/bridge-context-full-current.log`).

The original 30-scenario report cannot support its 99.2% savings or quality-gate
claims. Several token counts were constants, all three quality flags were
assigned `true`, and the supposed replay scenario merely serialized a trace
label. The context scenario depended on Gentle Shell's lossy snippet algorithm.

The original result is retained under `legacyUnverifiedResult` for audit, with
top-level gates and savings unavailable and rollout approval false. The legacy
runner now labels itself exploratory, emits null quality gates, writes a
separate exploratory artifact and returns failure for unsuccessful scenarios.
It is not the rollout benchmark; its obsolete context scenarios still need a
replacement that exercises native semantic compaction and actual transport.

## Verification

- Full bridge suite: 1,480 passed, 12 skipped, zero failures across 133 files
  (`/tmp/bridge-agent-review-full.log`).
- Host/MCP/recovery and producer selection: 74 passed
  (`/tmp/bridge-review-focused.log`).
- Detached inherited-pipe regression: failed before the change and passed after
  it (`/tmp/bridge-pipe-lifecycle-red.log`, `...-green.log`).
- Producer Unicode/pagination and telemetry regressions were observed failing
  before correction (`/tmp/bridge-agent-review-red.log`). Subsequent focused
  tests also cover per-stream omitted counts and symlink archives.
- Typecheck passed; `git diff --check` passed.

Reproduce with `bun test ./tests` and `bun run typecheck`. Individual regression
files are `tests/bounded-producers.test.ts`, `tests/telemetry-trace.test.ts` and
`tests/foreground-exec-cancellation.test.ts`.

## Integration still required

### Live catalog authentication diagnosis

On 2026-09-27 the running launcher remained healthy and its embedded ChatGPT
browser passed `doctor`, while periodic model-catalog requests from a client
classified `other` returned upstream HTTP 401. A read-only request through the
same `/v1/models` route using the current local Codex access token returned
HTTP 200 with both Codex and generic User-Agent headers. The current route and
token therefore work; the periodic caller likely holds different or stale
authorization. A timestamped loopback-socket sample saw the tunnel-managed
`codex app-server` process connect during the next 401, while the desktop's
managed app-server also held a connection; the sample does not prove which
request belonged to which process. No bearer value was logged or copied into
the evidence.

The doctor previously reported only the healthy proxy and could hide a newer
catalog failure behind an older successful count. It now adds a warning when
the most recent failed catalog observation follows the latest success. It
keeps the browser and Pi host checks distinct and does not infer an account
failure from a separate client's 401. The diagnostic has a RED/GREEN regression
(`/tmp/doctor-catalog-red.log`); a live doctor run displayed the warning without
changing runtime state. The complete bridge suite then passed 1,493 tests with
12 skips and zero failures across 1,505 tests (`/tmp/bridge-doctor-full.log`).
Typecheck, bundle integrity and the launcher's 348 passing tests (one skip)
passed as well.

### Compiled prompt admission and repeated accounting

Host admission now validates expanded Responses input before durable recovery,
sequence consumption or tool-result acceptance. A real HTTP regression reproduced
an invalid user-content shape leaving `admitted` recovery despite zero adapter
executions. The correction keeps recovery `unobserved` and permits correction
using the same sequence. A continuation regression additionally found the general
parser's extensible unknown-item fallback accepted malformed known tool blocks;
the host now checks each item against the exported known-item schema. It does
not change the general Responses endpoint's extensibility. The 28 host HTTP,
status and recovery tests pass (`/tmp/host-pre-admission-green.log`). This validates
request shape, not early compiled-token admission.

A later admission regression found that high-reasoning requests without streaming
also produced a durable host receipt before the response route returned HTTP 400.
Host admission now parses and routes the expanded request before recording it, and
enforces that local streaming precondition. The corrected request can reuse the
same sequence; the 29 host HTTP, recovery and status tests pass
(`/tmp/host-high-stream-red.log`, `/tmp/host-high-stream-green.log`). This still
does not move account-dependent compiled-token limits ahead of recovery admission.

The production browser worker checks tokenizer-derived compiled input and
visible-message limits before acquiring its page. A fresh host turn now runs
the same compilation and transport checks before immutable recovery admission.
It accounts for the host-shaped broker token, Luna checkpoint prompt, skill and
image attachments, and multipart stages. An oversized first request leaves
recovery `unobserved` and can reuse its sequence after correction. The HTTP
regression first failed with a 200 response; the corrected focused tests pass
34/34 (`/tmp/host-preflight-agent-review.log`). This preflight is intentionally
limited to a new full-history turn. Continuations and retained browser
conversations still rely on the worker's final compiled check; their effective
payload depends on live session state. Tokenization of the randomized broker
suffix can differ slightly from the deterministic admission sample near an
exact boundary, so the worker remains authoritative.

`measureCompiledChatGptWebInput` now supplies total tokens, maximum message tokens
and maximum characters from one set of message token counts. The browser worker
uses that shared measurement instead of separately recounting the messages for
the maximum. Image reserves, skill files and staged acknowledgment tokens are
retained. Actual transaction-specific staging checks remain separate. Tests cover
inline and multipart accounting (`/tmp/context-metrics-*.log`). No measured
latency improvement or upstream token savings is claimed for this refactor.

The MCP process now owns a `McpTelemetry` writer connected to real transport
observations. It writes under the configured home at
`logs/mcp/telemetry.jsonl`, with a process-instance UUID and call sequence linking
receipt and reply. It retains the existing stderr observations. Its queue is
capped at 256 events; later records expose dropped events and failed writes.
Write failures do not change tool outcomes. A real stdio test checks that the
log updates without file names or contents; another uses an invalid log
directory and verifies successful tool delivery. Terminal labels are explicitly
scoped to MCP transport, not proof that a command completed or stopped.

Opaque request-local UUIDs now propagate from the MCP transport across async
handlers into broker invocations. Broker queue, delivery, result-received and
abandonment events include that UUID and the broker-generated call ID. A real
native/safe MCP test drives an advertised host command through the broker,
returns its result, and verifies the three persisted lifecycle events share
the invocation ID without retaining the command. Concurrent handler tests
verify trace separation across awaits. The SDK installs its message handler
before starting the transport; observation wraps it at that boundary.

This establishes correlation to the host tool invocation, not to an OS process
or every nested call inside a gateway program. Broker result receipt can carry
a running-session result. Abandonment does not prove process termination.
Compaction now records `broker_compaction_cancelled` for each queued invocation
removed before delivery, with terminal state `cancelled`, its original IDs and
elapsed time. This does not imply execution. A real socket-broker regression
first reproduced the missing closure, then verified the persisted terminal event
and absence of command contents (`/tmp/broker-compaction-trace-red.log` and
`/tmp/broker-compaction-trace-green.log`; 51 focused tests passed).
Abrupt process death can lose queued observations.
Reads are not snapshot-consistent during concurrent rotation; audit queries
require a stable snapshot or synchronization before stronger claims are made.

Byte paging is exposed by Chat-First and fast-path dispatch. Real stdio tests
reconstruct Unicode, continue offsets and reject mixed modes. Native/Zero Risk
retain their published line-paging schema: the broad suite caught that adding
byte parameters changed the cached connector ABI. The native hash gate was left
unchanged and passed after restoring the published schema. A safe-turn line-read
test still checks the start boundary. Adding byte paging to those connectors
requires an explicit identity migration. Chat-First's changed schema also needs
an explicit catalog refresh or new connector before deployment; existing cached
clients must not be assumed to discover the new fields automatically. A large-page
test found the output sanitizer truncated the visible JSON despite advancing
the cursor; bounded byte pages now preserve that JSON under the existing total
MCP wire ceiling. Byte regression records are in `/tmp/mcp-byte-*.log` and
`/tmp/dispatch-byte-red.log`. The later broad review recorded 1,485 passed,
12 skipped and one ABI failure (`/tmp/integration-review-bridge-full.log`).
That failing native contract passed after correction (`/tmp/native-abi-green.log`);
this is a full run followed by targeted correction, not a claim that the full
suite was rerun after the correction.
Existing line reads can still allocate up to 16 MiB. Byte pages read the live
file and do not promise a pinned snapshot across edits. The output cap bounds
retained memory rather than command CPU or total bytes produced.

Host recovery tests exercise capability isolation, shared admission, and crash
recovery; they do not authorize exposing Pi compaction summaries across sessions.
Gentle Shell now has opt-in native Pi compaction scheduling after settled turns,
verified through its installed runtime with a deterministic local provider.
Semantic quality evaluation and a trusted session/branch binding for standalone
memory retrieval remain pending. Facts historical digests
must be compared with current source evidence before reuse.

Cgroup containment remains conditional on Linux delegation. This review makes
no Windows descendant-containment or live browser/401 claim. Telemetry directory
rename attacks by another process with equal filesystem authority are outside
the static file checks. No merge certification or deployment is implied.
