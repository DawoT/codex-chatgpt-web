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
