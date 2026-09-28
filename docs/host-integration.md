# Host integration refactor

## Objective and current boundary

Allow a future Gentle Shell/Pi provider to use this bridge while Pi owns tool execution, approvals, session identity and workspace authority. The starting fork was clean at `c5d6128`; it already included browser/composer/connector extractions. This increment changes the MCP boundary, not the browser refactor or the installed launcher.

Risk classification: R2, medium-sized increment, because command execution and per-turn authority are involved. The implementation and independent reviewer share a filesystem; their separation is not a mechanically isolated merge approval. No release, deployment or merge is included.

## Completed increment: separate transport from local execution

- `mcp/native-tools.ts`: native/safe composition and safe turn lifecycle.
- `mcp/host-command-tools.ts`: delegates command/session requests to the outer host. No local shell or global task lookup.
- `mcp/host-registry-tools.ts`: discovery and exact tool invocation, including existing Codex gateway/compaction compatibility.
- `mcp/legacy-filesystem-tools.ts`: clearly isolated legacy local file operations and Codex patch/image adapters. These are not a host-only filesystem contract.
- `TurnCoordinator.invokeRaw`: internal protocol response; preserves catalog JSON until the catalog consumer validates it.
- `TurnCoordinator.invoke`: model-facing result conversion without implicit filesystem writes.

Three defects motivated behavior changes:

1. Native background execution used the bridge's shell instead of the host, including under `workspaceWrite`, which the task manager did not enforce. It is rejected for native/safe turns under all policies. Native sessions remain available where advertised by the host.
2. Native/safe result offloading wrote into the workspace despite read-only policy. Delegated and legacy-file results now use inline truncation, without spooling. Native task waiting also no longer exposes the global local-task manager.
3. Nested tool discovery parsed JSON after model-facing truncation/spooling, breaking catalogs over 2,500 characters. It now uses the internal response and refuses catalogs above 1 MiB of UTF-8 before parsing. This is an application payload limit, not a claim that allocation before the broker receives a frame is bounded by 1 MiB.

## Compatibility

The native/safe `background=true` option and `codex_wait_tasks` remain recognizable but return explicit errors. No bridge-local task IDs, log files or task completion notifications are created by those contracts. Old task IDs do not become native command sessions. Refresh the MCP connector's tool catalog when deploying because descriptions changed; the ABI pin was deliberately updated after inspecting the schema change.

Model-facing text above the existing 2,500-character threshold is truncated with a notice and has no offloaded recovery file. Structured content retains its existing handling. This is not transparent preservation of arbitrary JSON tool results; Pi/Facts integration must account for response pagination and transport budgets. Internal tool catalog JSON is handled separately.

## Required next increments

1. Define a versioned host contract, authenticated local pairing and session/turn ownership. Pi metadata must be independent of Codex transcript XML and cannot be inferred from model-authored text.
2. Select routing from that frozen contract. A Pi turn must expose only the exact advertised host tools and must never enter legacy filesystem handlers, local background execution or the Codex JavaScript gateway.
3. Separate model catalog discovery/authentication from Codex passthrough. The current unauthenticated `/v1/models` request fails; `/healthz` is not sufficient proof of model or account readiness.
4. Implement a Gentle Shell provider using Responses SSE, scoped cancellation and dynamic model discovery. Preserve tool call IDs and return results through Pi's normal execution hooks. Add the sidebar only once readiness states are meaningful.
5. Verify a real `facts_query` round trip, a denied write, cancellation, stale/replayed calls and two concurrent sessions before declaring the connection functional.

Further audit findings remain open: Chat-First task ownership/cancellation, general spooler symlink/pruning behavior outside this native/safe boundary, and the legacy direct filesystem execution model. No claim is made that this increment fixes those subsystems.

## Verification log

Baseline: 1,352 passed, 12 skipped, zero failed (`/tmp/web-refactor-baseline.log`). Regression RED evidence: local background bypass (`/tmp/web-host-boundary-red.log`), implicit output writes (`/tmp/web-host-spooling-red.log`), and corrupt large catalog JSON (`/tmp/web-catalog-red.log`). Tests use the real MCP stdio server and turn broker with temporary workspaces, without model calls. The former local-background feature tests were replaced because that behavior was deliberately withdrawn; the replacement tests exercise both native/safe and all three sandbox policies, including a successful delegated command round trip.

An initial focused run failed on the expected connector ABI hash change, which was then reviewed and updated. Subsequent pre-catalog-fix focused coverage passed 135 tests. Final results are appended below after the final gates complete.

Final gates (2026-09-27): 1,355 passed, 12 skipped, zero failures across 1,367 tests and 113 files (`/tmp/web-final-full.log`). Typecheck passed (`/tmp/web-final-types.log`); both bundles built and their integrity check passed (`/tmp/web-final-build.log`); whitespace check passed. Independent read-only review ran seven regressions with 68 assertions (`/tmp/bridge-boundary-review-complete.log`) and reported no further blocking defect in this increment. The installed launcher and Gentle Shell were not modified or deployed. The broader host/Pi connection remains unfinished as listed above.

## Continuation: Chat-First tasks and waiting costs

The user requested further refactoring and bottleneck removal before any Pi integration. This R2 increment replaces the global task singleton with one manager per MCP registration, filtering records by canonical selected workspace while preserving a shared concurrency quota. It passes configured concurrency/retention values (defaults eight and 48 hours), honors `workdir`, fixes returned log paths, and removes implicit result spooling from Chat-First. This supersedes the task-routing/wait-cancellation gaps listed in the earlier increment; it does not make local shells into an OS sandbox or isolate conversations sharing a connector.

Modules now separate task state/process lifecycle (`background-task-manager.ts`), types, completion subscriptions (`background-task-wait.ts`), log storage (`background-task-log.ts`), and Chat-First MCP command/task registration (`mcp/chat-first-task-tools.ts`). Waiting uses a single deadline and completion listeners, reads logs only for the final result, and removes listeners on timeout or cancellation. Completion listener iteration uses a snapshot, so a listener removing itself cannot skip another. Process completion is idempotent; resource quotas count a process until close, including `terminating` tasks. Explicit POSIX kill is immediate for the current process group, with no deferred escalation targeting a potentially recycled PID.

Storage rejects static symlink substitutions, uses exclusive log creation and inode-checked bounded reads/deletion, and removes owned logs with record eviction rather than abandoning them. Admission is bounded if retained artifacts cannot be reclaimed. A log containing one line larger than 128 KiB retains its final fragment. Filesystem race limitations, Windows process-tree limits and restart retention are stated in `security-model.md`.

RED evidence: owner/workdir/listener/cancellation defects (`/tmp/task-lifecycle-red.log`), MCP cross-workspace visibility (`/tmp/chat-first-scope-red.log`), redirected logs and orphan retention (`/tmp/task-logs-red.log`). Independent review reproduced a regression introduced while cleaning termination timers: a descendant ignoring SIGTERM survived its parent (`/tmp/task-descendant-red.log`). Immediate POSIX group kill fixes it. Review also found a newly dropped single-line log tail (`/tmp/task-long-line-red.log`), now covered. The old concurrency test intentionally allowed a new process immediately after requesting kill; it now requires actual close before reuse. Final focused coverage: 21 tests passed with 143 assertions (`/tmp/task-reviewed-focused.log`).

Reproduce the performance comparison with `bun scripts/benchmark-background-tasks.ts`. The report in `docs/evidence/background-task-waits.json` records source hashes, runtime and three paired samples. It compares the former polling algorithm against event waiting using the same current manager, a real eight-second command, and a 5.2-second requested wait. This measures log-tail read operations and cancellation responsiveness, not filesystem cache misses, model latency, or overall throughput. No model calls, launcher restart, deployment or Pi connection is included.

Continuation final gates: 1,364 passed, 12 skipped, zero failures across 1,376 tests and 114 files (`/tmp/task-refactor-full.log`). Typecheck and both bundle builds/integrity checks passed (`/tmp/task-refactor-final-types.log`, `/tmp/task-refactor-build.log`); whitespace check passed. Independent review confirmed the last log-tail fix and reported no remaining blocking finding in this increment. In all three benchmark pairs, log-tail reads fell from three to one (66.7% fewer); the median cancellation sample for the event-wait runs was approximately 0.051 ms. Both benchmark modes use the current cancellation implementation, so that timing is not an old-versus-new cancellation comparison. The requested wait duration remains 5.2 seconds.

## Continuation: prompt correctness and MCP diagnostics

Before Pi integration, the next audit found and corrected these defects:

- Static prompt fingerprints omitted the JSON output format's `name` and `strict` fields, so a cache hit could replay another request's output contract. Both now participate in the key. Continuations also retain output formatting, checkpoints and the current transport capability restrictions.
- Static instruction arrays were constructed before every cache lookup. Construction now runs only on a miss. This avoids that repeated work; it is not a measured improvement in end-to-end latency. Updating an existing LRU entry no longer evicts another entry, and invalid capacities fail explicitly.
- Prompt instructions required fresh tool calls even when supplied evidence was sufficient, prohibited reporting observed platform failures without another tool call, promised unmeasured atomic/microsecond filesystem execution, and elevated compaction instructions from arbitrary tool output. The revised contract distinguishes evidence from instructions, permits accurate error reporting, requires tools for fresh effects/verification, and states the distinction between host enforcement and direct filesystem path policy.
- Requested command waits could expand the MCP invocation timeout to 315 seconds despite the configured transport deadline. The invocation now respects the remaining turn TTL and a configurable budget capped at 90 seconds. Invalid/non-finite configuration falls back to 90 seconds. This intentionally replaces the former long-wait test expectations; long work needs host sessions and short waits. A timed-out invocation retires its binding, but does not prove that host execution stopped.
- Duplicate JSON-RPC IDs left permanent observation tombstones. Observation now counts outstanding replies, suppresses ambiguous correlation (including duplicates arriving during asynchronous send), and frees capacity after all replies settle, including failed sends. The observer remains bounded at 1,024 tracked IDs; calls without replies retain slots until transport close.
- `codex_wait_tasks` was missing from the bridge tool-name set. It is now recognized by diagnostics and excluded from safe host discovery together with its bridge namespace.

RED evidence: `/tmp/prompt-cache-red.log` (four failures), `/tmp/mcp-timeout-red.log` (three failures), `/tmp/mcp-observation-tombstone-red.log` (three failures). Independent review reran 23 focused tests with 73 assertions (`/tmp/bridge-prompt-final-review.log`). Review used the shared worktree, not an isolated merge gate.

Remaining adoption limits are explicit: truncating visible `content` does **not** bound `structuredContent`, images, metadata or total serialized MCP output. A future negotiated result budget must preserve advertised output schemas, support pagination for large structured results, and report oversized results explicitly; silently slicing JSON is not a valid fix. Local Chat-First foreground cancellation and OS process containment also remain separate gaps. Prompt tests validate compiled contracts, not model obedience, injection resistance, or real-world task completion. Continuations now carry more required instructions, so this change claims no token savings. No real-model benchmark, launcher deployment or Pi integration was performed.

Reproduce the focused checks from the repository root:

```sh
bun test tests/prompt-cache-regression.test.ts tests/prompt-contract.test.ts tests/keep-alive-heartbeat.test.ts tests/mcp-observation.test.ts tests/mcp-observation-capacity.test.ts tests/mcp-tool-visibility.test.ts
bun run typecheck
bun run build:bundles
```

Final gates for this increment: 1,374 passed, 12 skipped, zero failures across 1,386 tests and 117 files (`/tmp/prompt-mcp-final-full.log`). The first full run exposed one obsolete literal assertion demanding unconditional tool use; its replacement asserts fresh mutations/verification and reuse of supplied evidence, passed targeted checks, and then passed the full rerun. Typecheck (`/tmp/prompt-mcp-types.log`), bundle build/integrity (`/tmp/prompt-mcp-build.log`) and `git diff --check` passed. No deployment or live model evaluation occurred.

## Second pre-Pi audit: foreground cancellation, result delivery and audit outcomes

This increment reproduces and fixes four concrete defects without changing the installed launcher:

1. Chat-First checked cancellation before starting foreground commands but never forwarded it to the running process. `handleExecCommand` now accepts an AbortSignal, refuses pre-aborted work, kills the current POSIX process group on cancellation/timeout, waits for process close, removes its listener/timer and invalidates file caches. The MCP registration forwards its request signal. Termination is immediate SIGKILL; command cleanup traps do not run. Windows currently kills only the root process; deliberately detached descendants are not contained by this mechanism.
2. Foreground execution validated an explicit working directory against readable roots only, and skipped validation for the default directory. Both paths now require writable-root and symlink containment before starting a shell. This validates the starting directory, not subsequent shell accesses; it is not an OS sandbox.
3. Result conversion limited visible text but delivered unlimited structured output and metadata. `asMcpResult` now budgets the complete serialized result object at 1 MiB (UTF-8, including retained content/structuredContent/_meta). Oversize results become a small `isError` response with code `mcp_result_too_large`, no partial structured JSON and `retryable:false`. It warns that effects may already have occurred and asks for narrower reads or supported pagination, never repetition of mutations. This is a delivery budget measured after serialization, not a producer memory/allocation bound or a negotiated pagination protocol. Internal broker inventory consumers retain their separate validation.
4. Audit logging skipped failed shell commands, although a command can change files before exiting nonzero or being cancelled. Settled command attempts now record success/error outcomes, while existing successful file-write records retain their format. The log remains best effort; process crashes before settlement and audit-storage failures are not a durable execution journal.

RED evidence: `/tmp/foreground-red.log` (pre-abort, in-flight cancellation and writable-root failures), `/tmp/foreground-mcp-red.log` (real stdio MCP cancellation did not prevent a later write), `/tmp/mcp-budget-red.log` (structured output and metadata bypass), `/tmp/failed-command-audit-red.log` (file changed but audit absent). Focused verification passed 22 tests with 144 assertions (`/tmp/prepi-second-focused.log`). The MCP cancellation test also executes another command after cancellation to verify that the connector remains usable.

Remaining work before claiming a production Pi adapter: host-owned execution/identity and cancellation contracts, OS containment where required, aggregate admission control covering foreground and background commands, bounded producer allocations and schema-aware pagination. Current background-task quotas do not bound concurrent foreground commands. Real model behavior and end-to-end latency remain unmeasured. No Pi integration or deployment is included.

Independent review identified one bypass of the new delivery budget: host tool inventory returned its structured result directly. The budget check is now a separate `enforceMcpResultBudget` helper used by both result conversion and inventory, so inventory JSON is not subjected to the visible-text truncator. Four real MCP stdio/broker regressions cover direct/gateway sources in native/safe contracts, oversize rejection, and successful subsequent retrieval of an intact catalog larger than 2,500 characters. RED: `/tmp/mcp-inventory-budget-red.log`; focused GREEN: 13 tests, 112 assertions (`/tmp/mcp-inventory-budget-green.log`). The reviewer shared the worktree; this is not an isolated merge approval.

Final gates for the second pre-Pi audit: 1,386 passed, 12 skipped, zero failures across 1,398 tests and 120 files (`/tmp/prepi-second-final-full.log`). Typecheck (`/tmp/prepi-second-final-types.log`), bundle build/integrity (`/tmp/prepi-second-final-build.log`) and whitespace checks passed. The earlier complete run before the inventory correction also passed (1,382 tests plus 12 skipped). All changes remain local and uncommitted; the installed launcher was not restarted or deployed.

## Pi host protocol v1 implementation

The bridge now exposes authenticated `/host/v1/sessions`, `/host/v1/responses`, session DELETE and per-turn cancellation. Pairing requires the local control credential, protocol 1, host `pi`, an absolute working directory and Full mode. Browser Origin requests are rejected. The handshake returns the local route catalog and supported reasoning efforts without upstream Codex model discovery. Session capabilities, IDs and monotonic sequences bind each request. Body/continuation/session capacities are bounded; live tool calls/results are checked against emitted identities, a stable per-turn catalog and exact replay evidence. Imported paired history before the latest user request remains evidence only.

The advertised effort list is filtered by account capability. An HTTP 401 caused by an invalid or expired host capability carries `error.code=host_capability_invalid` and `x-cgw-admission: rejected`; this proves that the model request was not admitted and lets a host renew its capability once. A later model/session-health 401 has no such header and must not trigger automatic resubmission.

Server-only `_hostTurn` authority overrides environment discovery without trusting caller metadata. Host environments have no local filesystem roots and immutable execution mode/catalog. Native MCP host requests allow only inventory and exact tool invocations. Local aliases, gateway discovery fallback, token resurrection and local workspace initialization are disabled. Revoked host tokens cannot be recovered through legacy aliases or predecessor matching.

Chat-First admission now shares configured concurrency across foreground/background processes. Background calls reject immediately when full; foreground calls enter a FIFO queue of at most the concurrency limit for up to five seconds. Cancellation removes queued work, leases release once, and process closure releases capacity. Existing background record/log retention still applies.

RED evidence: `/tmp/shared-admission-red.log`; GREEN 12 admission/lifecycle tests (`/tmp/shared-admission-focused.log`). Host boundary and prompt regressions passed separately; integrated focused coverage passed 23 tests with 199 assertions (`/tmp/pi-bridge-focused.log`). The installed Pi extension exposed an SDK loader alias incompatibility; its fix uses the public compatibility Responses factory. The joint real HTTP/Pi probe then exposed unsupported reasoning effort `none`, corrected by advertised route effort negotiation. `/tmp/pi-cross-repo.log` verifies actual Pi facts execution, permission denial, three HTTP rounds and zero retained sessions using scripted model output, not the browser/model.

See the Gentle Shell checkout's `docs/codex-web-bridge.md` for extension configuration and runtime verification. Source changes remain local; the installed launcher has not been restarted. Remaining verification before final completion includes successful command execution/cancellation through Pi, reconnection and concurrent Pi sessions on the composed path, and a final review of HTTP admission and stream lifecycle. This increment does not claim live ChatGPT operation or OS containment.

Current integrated gates: bridge suite 1,402 passed, 12 skipped, zero failures (`/tmp/pi-bridge-full.log`); Gentle Shell 4,075 passed, 41 skipped, zero failures plus provider-contract/runtime-harness stages (`/tmp/pi-gentle-full.log`). These full runs precede the final effort/JSON-argument compatibility changes, which passed the host HTTP suite (7 tests, 45 assertions, `/tmp/pi-http-final.log`), Pi focused/runtime checks (8 tests) and the combined probe (`/tmp/pi-cross-repo-final.log`). Type checks and bundle integrity passed; Gentle Shell reports its existing 188 recorded diagnostics with no regressions rather than a diagnostic-free compilation. JSON tool arguments are compared by canonical parsed content so Pi reserialization does not reject equivalent calls. The goal remains active until successful command/cancellation, reconnect and concurrent composed-session cases and final lifecycle review are verified. No launcher deployment occurred.

## Continuation: Pi cancellation and composed lifecycle

The provider previously stopped observing the agent signal when a model HTTP stream ended. Aborting Pi while a tool ran therefore left the bridge turn waiting for its result. `/tmp/pi-tool-abort-red.log` reproduces the missing cancellation; the provider now keeps agent subscriptions across tool-use rounds, rejects continuation of cancelled turns, and removes listeners on final output, replacement turns and provider shutdown. Focused client/provider/installed-extension checks passed nine tests (`/tmp/pi-tool-abort-green.log`); completed-turn subscription cleanup is additionally verified in `/tmp/pi-provider-lifetime-final.log`.

A second regression rejected a new user request containing the prior cancelled command's tool result (`/tmp/pi-aborted-history-red.log`). Paired results from a cancelled older turn can now enter history with immutable replay evidence. They cannot reactivate the cancelled turn, change recorded results, or complete an unrelated live invocation. Eight HTTP tests passed with 49 assertions (`/tmp/pi-aborted-history-green.log`).

The joint probe now runs two installed Pi runtimes concurrently, each with its own committed workspace. It exercises facts lookup, permission denial, allowed shell effects, cancellation during shell execution, a subsequent user request retaining aborted history, and explicit extension disconnect/reconnect. Twenty scripted model rounds use four distinct host capabilities; both cancellations are scoped and zero sessions remain (`/tmp/pi-composed-final.log`). Unique emitted call IDs distinguish newly issued calls from imported transcript evidence. Model output remains scripted: this is a real Pi/HTTP/tool integration test, not a live ChatGPT browser evaluation.

Final lifecycle inspection covered asynchronous body admission and reauthentication, capability revocation, sequence consumption, catalog immutability, result provenance, stream closure and agent signal cleanup. This inspection was performed by the implementer; the last HTTP changes do not have a completed independent reviewer sign-off. Prior independent reviews cover the execution boundary, prompts and shared command admission. Source changes do not deploy or restart the installed launcher.

Completion evidence available so far: Gentle Shell full suite 4,076 passed, 41 skipped, zero failures, with provider-contract and runtime-harness stages passing (`/tmp/pi-gentle-completion.log`); final provider listener checks passed (`/tmp/pi-provider-lifetime-final.log`). Bridge typecheck passed (`/tmp/pi-host-completion-types.log`), both bundles and integrity passed (`/tmp/pi-completion-build.log`), runtime module validation passed (`/tmp/pi-completion-runtime.log`), and both whitespace checks passed. Gentle Shell typecheck reports 188 existing recorded diagnostics, no regressions (`/tmp/pi-abort-types.log`).

Final bridge full suite: 1,404 passed, 12 skipped, zero failures across 1,416 tests (`/tmp/pi-bridge-completion.log`). This run includes the cancelled-history fix. The final joint probe includes continuation after abort as well as reconnect and simultaneous Pi sessions. All source-level implementation and verification in this increment is complete; live browser/model evaluation and deployment remain outside these test claims.

## Live startup and compatibility verification (2026-09-27)

Started the source launcher with the existing production browser partition and configuration, updated the runtime command and native/chat-first tunnel profiles to the current bundle, and retained configuration/profile backups under the local core home's `backups/pi-live-*` directory. Removed the duplicate standalone tunnel poller; the launcher supervises the source daemon and the remaining tunnel. The checkout Electron sandbox helper was replaced with a symlink to the already installed root-owned Chrome helper, with its original retained alongside it; the sandbox was not disabled.

Live Pi SDK testing exposed a previously unexercised dependency on native Codex message item metadata during browser-session replay. Authenticated server-owned host turns now select their current user revision independently of native item metadata. The regression failed before the correction (`/tmp/pi-live-revision-red.log`), then passed together with native history tests (`/tmp/pi-live-revision-green.log`). Native Codex authority parsing remains unchanged. The real Pi TUI completed a text request and a `facts_query` lookup of `buildPiInvocation`; Codex completed a read-only, tool-free request with the advertised Instant effort `low` (`/tmp/pi-live-codex-exec-low.log`). A websocket 426 triggers Codex's existing SSE fallback; it did not prevent completion.

Host responses previously bypassed configured HTTP rate admission. An authenticated cross-capability regression reproduced that gap (`/tmp/pi-host-rate-red.log`). Host model admission now shares a bounded sliding-window budget across all Pi capabilities in the daemon, preventing session churn from resetting that quota, while cancellation/deletion bypass model admission (`/tmp/pi-host-rate-green.log`). This is request-rate admission, not a cross-process scheduler or global browser concurrency guarantee.

The installed Codex catalog introduced native priorities beyond the smoke test's fixed roster assumptions. The smoke now compares the installed Codex's top-five ordering with the actual emitted augmented catalog, while retaining independent route/effort and V1 feature checks. The actual installed binary passes (`/tmp/pi-live-codex-catalog-green.log`). Final focused checks: 33 tests, 256 assertions, zero failures (`/tmp/pi-live-final-tests.log`), typecheck and bundle build passed, and the two-runtime twenty-round composed probe passed (`/tmp/pi-live-final-composed.log`). The last full suites precede these live fixes; no new full-suite claim is made here.

Post-reload live SDK assertion passed (`/tmp/pi-live-proof.log`): final stop reason, exact normalized `PI_WEB_OK` text, and no tool execution. Gentle Shell focused client/provider/installed-extension checks passed nine tests (`/tmp/pi-live-gentle-focused.log`). The source launcher, supervised host-v1 daemon, one native tunnel poller and a visible Pi terminal remain running; the temporary automation TUI was closed after testing. Pi model selection remains explicit through `/model`.

## Admission and transport retirement audit (2026-09-27)

Independent review reproduced a cancellation race while a host request body was still being read. Admission now records its turn identity before that asynchronous read. Cancel creates a terminal tombstone and aborts body admission; session deletion, expiry and shutdown also retire pending bodies. Cancelled requests cannot start the model adapter or reuse the turn. Real streamed-body tests cover cancel, deletion and expiry: 12 tests and 71 assertions passed (`/tmp/pi-admission-retirement-reviewed.log`), following the failed cancellation regression (`/tmp/pi-admission-abort-red.log`).

The Pi client now cancels the original remote turn on transport failure while retaining uncertain-delivery protection. Actual HTTP tests cover a peer dropping the request before response headers and during the response body; neither case retries the model request. RED: `/tmp/pi-transport-retirement-red.log`; GREEN: fourteen client/provider/extension tests (`/tmp/pi-transport-retirement-green.log`). Control-response JSON also has incremental byte budgets, verified against oversized chunked streams that do not finish (`/tmp/pi-json-stream-red.log`, `/tmp/pi-json-stream-green.log`).

Complete suites at this stage passed 1,409 bridge tests with 12 skipped (`/tmp/pi-retirement-full-bridge.log`) and 4,081 Gentle Shell tests with 41 skipped (`/tmp/pi-retirement-full-gentle.log`). Bridge types, bundle integrity and the twenty-round composed Pi probe passed. These gates precede the automatic-workspace-persistence correction described in the next verification increment. The reviewer shares the worktree; this is not mechanically isolated merge approval.

## Automatic persistence authority correction

Real native Codex verification exposed automatic creation of `.agents/STATE.md` despite a read-only task. Automatic initialization and compaction now share `workspace-persistence.ts`: read-only, host-only and absent authority produce no persistence; writable tasks validate their workspace and target paths against writable roots and existing symlinks. Automatic writes use strict helpers that never fall back to home storage. Reading workspace state or listing checkpoints no longer creates directories. Legacy explicitly invoked helpers retain their existing fallback behavior.

Compaction also previously ignored its summary when updating `STATE.md`. The last summary now round-trips through a JSON metadata section, replaces the previous summary and retains at most 32,768 characters there. The checkpoint retains its separate summary. Other custom sections are preserved; embedded Markdown headings in the summary remain data rather than changing ordinary state fields.

Adapter and actual compaction-flow regressions cover read-only, host-only, missing environment, excluded writable roots, `.agents`/checkpoint/STATE symlink escapes, and authorized persistence. Independent review found no additional concrete authority bypass. Containment checks remain preflight checks and are not atomic against another local process changing symlinks; this is not OS isolation.

The environment restarted during final verification: temporary logs and running source processes disappeared while the worktree persisted. Final gates were restarted from current files. The source launcher and visible Pi were started again. Running the full suite concurrently exposed a test opening the real profile's broker socket, causing live requests to fail; those failures are test-environment interference, not successful live verification. Test isolation and fresh live checks must complete before a final post-correction compatibility claim.

## Test isolation and broker start recovery

`bunfig.toml` now preloads a temporary bridge home before importing test modules. Test hooks restore it after suites that modify configuration variables, close test brokers and clean up the temporary home. The user's `HOME` is unchanged. Legacy state/checkpoint/subagent fallbacks also honor `getConfigDir()` instead of constructing an unconditional home path. A subprocess regression verifies that direct `bun test` overrides an inherited live bridge home and removes its temporary profile. This isolates default paths; explicitly supplied paths still need isolated fixtures.

The initial socket conflict also exposed a cached rejected broker-start promise. A later request can now acquire the endpoint after its previous owner retires; it does not retry the failed model request or command. Closing a broker whose start was rejected preserves the external socket. Explicit cleanup checks the owned device/inode. Bun may itself unlink the pathname on closing a listening server after another local process replaces its endpoint; no atomic protection against that replacement is claimed.

Fresh native Codex verification completed exactly one successful `printf CODEX_TOOL_OK` command and reported its output. Independent filesystem assertions confirmed no `.agents` directory and a clean git status in the committed temporary read-only workspace (`/tmp/pi-persistence-codex-live.log`). Pi's live SDK check also passed (`/tmp/pi-persistence-pi-live.log`). The earlier empty `STATE.md` created by the defect was verified unchanged, backed up under the core home's `backups/readonly-state-*`, and removed from Gentle Shell.

Focused broker recovery/lifecycle/lineage coverage passed 37 tests and 423 assertions; fresh platform-specific recovery checks passed five tests. Legacy-home checks passed 46 tests and 157 assertions. The intermediate full isolation run imported old modules before concurrent edits finished and failed four newly updated assertions; a fresh focused run passed all twelve corresponding recovery/subagent tests. Final gates must use a new process started after those edits.

Final fresh-process gates after all edits: **1,433 passed, 12 skipped, zero failures across 1,445 tests and 128 files** (`/tmp/pi-lifecycle-full-final.log`). Bridge typecheck, bundle integrity and the twenty-round/two-Pi composed probe passed (`/tmp/pi-lifecycle-{types,bundles,composed}-final.log`). Gentle Shell's fresh full run passed 4,081 tests, 41 skipped and its provider-contract/runtime-harness stages. The post-reload authenticated Pi SDK check passed (`/tmp/pi-lifecycle-postreload-live.log`). At final inspection the host-v1 daemon was healthy with zero active HTTP/browser turns, its production broker socket belonged to that daemon, one source launcher/native tunnel remained running, and one visible Pi terminal remained open. No commit or PR was created.

## Authenticated turn inspection

This increment closes the recovery guidance gap: uncertain delivery previously told the caller to inspect host state without exposing a supported inspection endpoint. Classified R2/M for capability isolation and shared lifecycle state. The additive `GET /host/v1/sessions/:session/turns/:turn` uses the session capability, rejects Browser Origin requests, returns `no-store` metadata and consumes neither model quota nor request sequence. It does not return messages, tool arguments/results, workspace paths, catalogs or credentials.

States are `unknown`, `admitting`, `active`, `idle` and `cancelled`. `idle` means no active bridge response, not successful completion of the user's task. `request_sequence` identifies the last accepted request for that turn; an incomplete first body has no accepted sequence. `last_completed_sequence` and `last_completed_response_id` identify the last committed completed model response, even when a later request fails. `response_retained` tells whether that response remains in the bounded continuation cache. Pending tool calls count emitted calls without registered results, not live commands. Cancellation describes revoked bridge authority; its separate requested/settled field remains scoped to bridge HTTP/browser activity.

Pi's explicit `/web-bridge status` reads the current affinity without creating a capability or another model request. The client caps the reply at 64 KiB/three seconds, validates the metadata schema and rejects stale connection generations. The provider also checks that the inspected user turn remains current after the read. Inspection never clears uncertain-delivery protection; `replay_allowed` is always false.

RED: five missing-endpoint regressions (`/tmp/host-status-red.log`) and Pi inspection regressions (`/tmp/pi-inspection-red.log`). GREEN: seventeen host status/HTTP tests, 131 assertions (`/tmp/host-status-green.log`), and twenty-four Pi client/provider/runtime tests (`/tmp/pi-inspection-focused.log`). Independent review reran those checks. The composed probe verifies eight real status reads across four capabilities and two installed Pi runtimes while preserving twenty model rounds and zero retained sessions (`/tmp/host-status-composed-green.log`). Review shares the worktree and does not establish mechanically isolated merge approval. No automatic retry or model-quality claim is introduced.

Final full gates: bridge **1,438 passed, 12 skipped, zero failures** across 1,450 tests/129 files (`/tmp/host-inspection-full-bridge.log`); Gentle Shell **4,091 passed, 41 skipped, zero failures**, plus provider-contract/runtime-harness (`/tmp/host-inspection-full-gentle.log`). Bridge types and bundle integrity passed; Gentle types retain 188 recorded diagnostics without regressions. A fresh capability on the reloaded live daemon returned `unknown` before submission, completed an authenticated browser/model request, then returned `idle` with accepted/completed sequence 1, the exact completed response identity, retained response evidence and zero pending calls (`/tmp/host-inspection-live.log`). Automatic replay remained disabled and the capability was revoked after the probe.

The actual Pi 0.87.1 TUI also completed a live reply and rendered `/web-bridge status`: idle, cancellation none, accepted/completed sequence 1 and zero pending results, with the scope/replay explanation visibly wrapped at terminal width (`/tmp/host-inspection-tui.log`). The automation terminal was closed and its temporary session kept separately; one visible Pi terminal remains open. Final health inspection reports no active HTTP/browser turns. The running source daemon includes this inspection endpoint.

## Durable host model recovery

A Pi client with a persistent session file may send `recovery_scope`, a 64-character SHA-256 digest of its local session identity, when pairing. The host binds that scope to the new capability. `GET /host/v1/sessions/:session/recovery` requires that exact capability, rejects browser Origin requests, and returns bounded, `no-store` model metadata. A fresh pairing with the same scope can inspect it after daemon restart. The digest is an identifier, not a secret or an authorization token.

The host writes an exclusive, ordered admission before accepting the first model request for a turn, then records completed response sequences and cancellation milestones. The private journal contains only scope and turn identifiers, request digests, sequence numbers, response IDs, timestamps and states. It contains no prompt, tool arguments/results, output body or capability. Re-admitting a turn in the same scope is rejected, including after a process restart. Corrupt, missing or orphaned records fail closed. An `admitted` state may mean the model never ran or that its result was lost; `model-completed` proves host-side completion only. Neither state proves Pi received the stream or committed its transcript. Inspection cannot authorize replay.

Each scope is limited to 4,096 turns and 32,768 journal entries; there is no automatic retention cleanup yet. An incomplete temporary admission is ignored. A corrupt published claim blocks that scope for operator repair. POSIX file and directory sync are used; Windows does not offer the same directory-sync guarantee. The journal guards against accidental restart replay, not another local user who can modify the host's private directory. In-memory Pi sessions omit `recovery_scope` and have only live host inspection. A running older daemon must be restarted before it accepts the additive pairing field.

The final ordered claim is published by an atomic hard link after its temporary file is fully written and synced; model execution starts only after directory sync. Focused host recovery/status/HTTP tests passed 26/26, including process kills at held stream and completed response boundaries. The full bridge suite passed 1,447 with 12 skips and zero failures (`/tmp/host-recovery-bridge-final.log`); typecheck and bundle integrity passed. The installed Pi composed probe passed twenty rounds across two sessions (`/tmp/host-recovery-composed-final2.log`). The launcher restarted the source daemon, and a fresh persistent Pi SDK session received a live browser reply while leaving a durable host claim (`/tmp/host-recovery-live-final.log`). The running source daemon now includes the recovery endpoint. These are worktree observations, not a signed merge approval.

## Local shell descendant containment

Foreground and background Chat-First commands now use an optional Linux cgroup v2 child group when the current runtime has delegation. The command joins it before executing, and cancellation signals both `cgroup.kill` and the original POSIX process group to cover the initial join race. Normal close also retires leftover cgroup processes. A descendant that merely calls `setsid` is covered on delegated Linux. Without delegation, the existing process-group behavior remains; Windows still terminates the root child. A same-UID command can deliberately migrate out of a writable cgroup, so this is not an adversarial process sandbox or a filesystem/network boundary. See `docs/security-model.md` for the exact limit.

RED tests showed detached descendants writing after foreground and background cancellation (`/tmp/process-containment-red.log`, `/tmp/process-containment-background-red.log`). The final bridge suite passed 1,452 with 12 skips and zero failures (`/tmp/process-containment-full.log`); typecheck and bundle integrity passed. Immediate cancellation, normal close and detached-session paths are covered. Independent read-only review found and verified the correction of a pre-join race. The source daemon was restarted under the launcher, with tunnel and Pi still active. Windows containment and adversarial cgroup escape remain open.

## Cross-process Chat-First command admission

Chat-First foreground and background commands now acquire a slot from a private SQLite ledger under the configured home. MCP processes using that home share `backgroundTasks.maxConcurrent` (default eight); a workspace or a second MCP registration does not create another pool. Foreground callers queue FIFO for up to five seconds with at most one queue position per configured slot. Background callers reject immediately when capacity or an earlier queue is occupied. Changing the configured capacity while leases exist fails closed. Task records, logs and polling remain scoped to the MCP registration and selected workspace.

The slot remains held through command close. Normal stdin EOF closes the MCP transport, aborts foreground work and terminates background tasks; their leases release after process close. A forcefully killed MCP owner leaves an active row because its shell descendants may still be running. `admission status --json` shows exact lease IDs and owner states. `admission recover ID --ack-descendants-settled` requires a dead or reused owner identity plus operator confirmation that command descendants settled. Linux identity includes boot ID, PID namespace and process start ticks. Reboot, namespace mismatch and legacy rows are `unknown` and additionally require `--ack-owner-offline`. A proven live owner cannot be recovered by either acknowledgement. No command effect is rolled back.

This increment is R2/L because it changes shared execution concurrency. A real two-MCP regression first showed `maxConcurrent=1` admitting both commands (`/tmp/global-admission-red.log`). Focused tests then covered cross-process rejection and release, FIFO, cancellation, timeout, configuration mismatch, stdin close, SIGKILL and exact-ID recovery. An independent read-only review found permanent capacity loss after crash, then PID reuse and reboot/legacy identity gaps; those were corrected. The review shares the writable worktree and is not mechanically isolated approval. See `docs/security-model.md` for remaining platform and operator limits.

Final fresh-process gates: 1,459 bridge tests passed, 12 skipped and zero failed across 130 files (`/tmp/global-admission-full-stable.log`); typecheck and bundle integrity passed. The bundled CLI executed `admission status --json` against the current profile and reported capacity eight with no active or waiting commands. The source daemon, launcher, tunnel and visible Pi stayed running. `/healthz` reported no active turns; the most recent upstream model-catalog probe returned 401, so no fresh live browser/model claim is made for this increment.

### Runtime follow-up after admission gates

A subsequent process check found the former visible Pi PID absent. It was restarted in a visible xterm using the project's installed Pi 0.87.1; launcher, daemon and native tunnel were left running. A fresh isolated persistent Pi SDK session completed a real browser/model request and returned `PI_WEB_OK` (`/tmp/global-admission-live-current.log`). The earlier upstream 401 belongs to the native `/v1/models` passthrough and does not establish a Pi host-route failure. This follow-up supersedes the earlier statement that the original Pi process remained continuously running; it does not claim that the native catalog authentication issue is repaired.

For a later catalog 401, run `codex-chatgpt-web doctor` and compare its catalog
warning with the last successful catalog request in `/healthz`. The 401 is an
upstream response to the caller's native Codex bearer, separate from the
embedded ChatGPT browser and Pi host capability. On 2026-09-27 the current
local Codex token returned 200 through `/v1/models`, while a periodic client
still returned 401. Reopen the affected Codex client so it reloads credentials;
if its own fresh request still fails, renew that client's sign-in. Do not copy
bearers into logs or treat a historical successful catalog count as current
authentication proof. Socket sampling implicated a tunnel-managed Codex child
but did not uniquely identify the failing request's process.

### Cross-repository review and compiled admission follow-up

The concurrent MCP session-yield changes were reviewed with focused command
and raw-exec regressions; the native gateway yields a running cell while a
long awaited command continues, and structured host command waits are bounded
only when that tool advertises `yield_time_ms`. A separate host regression
exposed first-turn compiled context rejection after durable recovery admission.
The host now compiles a fresh full-history request and checks attachment,
message, context and multipart transport limits before consuming the sequence.
The preflight uses a broker-shaped host token and Luna checkpoint option.
Continuations retain the browser worker's final check because their effective
prompt can depend on live retained conversation and checkpoint state.

Current source gates: 1,497 bridge tests passed, 12 skipped, zero failed
(`/tmp/bridge-preflight-full.log`); typecheck, bundle integrity and
`git diff --check` passed. The composed Pi probe passed two concurrent
sessions, twenty HTTP rounds, Facts, successful command execution,
cancellation, reconnection and zero retained sessions
(`/tmp/pi-host-preflight-review.log`). The probe uses scripted model output;
it does not establish live browser behavior for these new changes. The
running installed daemon was not restarted by this review.

### Verification after launcher restart

The user restarted the launcher. `/healthz` then reported a new source-daemon
PID (1217258), host protocol 1, a ready tunnel and a latest native catalog
result of HTTP 200. `doctor` reported `ready`. A fresh Pi SDK session reached
the real browser model and returned `PI_WEB_OK` after a prior run showed the
model unnecessarily calling `bash` to print that text. This is stochastic
model tool choice, not a host transport failure; the Pi probe now reports the
tool name when its no-tools assertion fails. A live HTTP request containing one
1.8-million-character record returned HTTP 400 before recovery admission;
inspection remained `unobserved`. An earlier 450,000-character repeated record
was admitted under the account's current Bigger Context configuration, so
HTTP 200 alone was not a valid oversized-prompt test. The daemon had zero
active HTTP/browser turns afterward. The older periodic 401 has not recurred
in the latest catalog result, but one successful request does not prove that
the other client has permanently refreshed its credentials.

The Pi probe's reported `usage.input` near 9,600 includes the bridge's fixed
8,192-token browser platform reserve. It is a conservative admission estimate,
not measured provider billing or 9,600 visible prompt tokens. Do not use it as
an ROI baseline without separating that reserve and observing delivered
payload size and latency.
