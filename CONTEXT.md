# CONTEXT

Vocabulary and test boundaries for the composed ChatGPT web worker. Product modes,
launcher and MCP architecture are described in `docs/architecture.md`.

## Ownership and composition

`src/adapters/chatgpt-web/browser-worker.ts` owns the public API, resolved configuration,
active-run registry, helper client, context-pressure registries and browser-turn pipeline.
It delegates to constructed controller instances with typed dependency objects. Controllers
execute on their own instances; callbacks connect concerns without lending the worker's `this`.
`browser/index.ts` supplies the shared exports re-exported by the worker entry point.

- `BrowserSession` owns browser acquisition and maintenance serialization. Its
  `BrowserSessionState` object is shared with the worker: browser/context/page handles,
  managed-browser acquisition promise and maintenance tail have one authoritative owner.
- `ComposerController` owns composer readiness, connector selection, prompt/file attachment
  and send activation. Real Page/Locator APIs are required at its browser boundary.
- `ChatGptModelControls` selects and verifies model/effort through the live controls.
- `SubmissionObserver` owns submission baselines, DOM evidence and acceptance observation.
- `ResponseObserver` projects the response DOM into typed snapshots.
- `TurnDiagnostics` owns observation recovery, assistant binding and stalled-turn diagnostics.
- `TurnOrchestrator` owns one turn's launcher lease, heartbeat, interactive lock and terminal
  notification. Injected callbacks perform browser work and host communication.
- `TurnCompletionLoop` owns observation after submission. Its dependencies provide response
  snapshots, binding reconciliation, DOM/progress wakeups, liveness classification and page
  rebinding. It returns text/cache; connection cleanup and final persistence remain in the worker.

## Seams

- **S1 — public worker API:** `forProvider`, `run`, `verifyConnector`, `inspectSession`,
  `smokeTest`, `inspectLimitsPlan`, `close`. Provider registry cleanup is an observable lifecycle
  contract, as are prompt release and abort of pending helper runs on close.
- **S2 — launcher lifecycle:** `TurnOrchestrator.run(turn)`. Heartbeat starts after the lease
  and before surface/preparation callbacks. Completion and failure always release the interactive
  lock and retire the leased surface. Launcher control errors preserve their established precedence.
- **S3 — liveness classification:** `resolveTurnLivenessSignals(snapshot, now)`. The explicit
  clock makes classification deterministic. Multipart waits, diagnostics and completion consume
  the same classifier through callbacks where needed.
- **S4 — planning and DOM projection:** multipart planning, prompt readback, response snapshots
  and completion phases have focused tests of their exported behavior.
- **S5 — completion observation:** `TurnCompletionLoop.run(input)`. Rebinding returns the actual
  replacement Page after updating worker connection ownership; the loop then renews bindings/cache.

## Determinism and effects

`turn-liveness.ts` and `turn-completion-fsm.ts` classify explicit inputs. `dom-trackers.ts`
maintains evidence windows; `turn-events.ts` is a scoped in-memory event bus with waiters.
`multipart-plan.ts` has no browser I/O but draws a transaction UUID. `prompt-readback.ts`
executes a serialized DOM callback through Locator.evaluate. `dom-signal.ts` uses Page.evaluate,
DOM observers and watchdog timers. `suspension-clock.ts` measures suspension. `context-pressure.ts`
combines pressure state with `ChatGptPageDomObserver`, which measures the live page. These modules
must not all be described as pure or as free of Playwright/timers.

## Test boundaries

Use public APIs or `makeWorkerFixture()` from `tests/fixtures/worker-harness.ts`. The harness
calls the real private constructor through Reflect.construct, resolves complete configuration,
and seeds the shared session state. It preserves actual initialization without registering a
provider singleton. Do not replace workers with prototype-derived objects.

Browser fakes live in `tests/fixtures/browser-fakes.ts`: typed Page/Locator values, asynchronous
browser actions, event subscriptions, selector refinements, keyboard and attachment APIs.
Configure browser responses and failures at these boundaries. Keep the method under test real;
replace a collaborating effect only when it is outside the behavior being asserted.

DOM callbacks run against synthetic DOM through domino and node:vm; genuine Chromium cases
remain in the dedicated browser suites. Helper tests use real daemon/helper IPC endpoints and
substitute browser work in the child process on constructed workers. Shutdown characterization
holds a prepared prompt during an abortable browser wait, closes the real worker/helper and
checks AbortError, one prompt release and aborted launcher retirement.

Tests assert behavior rather than reading production source or extracting sentinel-delimited
blocks. Reading diagnostic outputs and generated artifacts is permitted. Heavy mixed-density
multipart compiler coverage lives in `tests/browser-multipart-compilation.test.ts`; worker
contract assertions and compiler limits are preserved while measuring contract latency separately.

## Acceptance checks

`bun run check:refactor-gates` enforces strict targets: zero double casts and unused-private-member
suppressions in the worker/controllers/orchestrator/completion module, zero direct worker
prototype references anywhere in tests (including child-process scripts), and zero statically
resolved production-source reads in tests. Unrelated Object.create fixtures are permitted.
The scanner resolves common static paths and allows temporary diagnostic/tool outputs; it is
not a general interpreter of dynamic JavaScript paths. `--root` supports controlled gate checks.
`bun run verify`, already used by CI, runs the strict gate alongside typecheck, lint and coverage.

Measure `bun test tests/browser-worker-contract.test.ts` standalone against the <5s requirement.
Run orchestrator/completion coverage against their dedicated suites; launcher orchestration must
cover at least 85% of lines. Completion coverage is reported separately, including function
coverage, rather than attributing its results to the launcher module.

## Recorded focused validation (2026-09-30)

Initial user-verified baseline: clean HEAD 80dadbf, 161 contract tests passing in roughly 15s.
These notes record the refactor/browser-worker branch before final acceptance; they do not claim
that the branch has merged to main. MCP scope approval remains pending with the parent/user.

- Worker contract: 158 passing tests, 1.89s standalone; the heavy compiler case remains in
  `browser-multipart-compilation.test.ts` with its original transport limits and assertions.
- `bun test tests/turn-orchestrator.test.ts tests/turn-completion-loop.test.ts --coverage`:
  48 passing tests, 11.31s (latest parent coverage run). TurnOrchestrator: 100% functions / 100% lines. TurnCompletionLoop:
  52.63% functions / 96.76% lines. Callback function coverage remains reported explicitly.
- Helper client: 14 passing tests, 2.70s, including close during pending browser work.
- Safe MCP lifecycle: seven passing tests, 11.04s, including both image aliases and schemas.
- Nine controlled scanner checks include future browser modules, child-process prototype strings,
  source URL/join reads and permitted temporary outputs. The strict repository scan is zero.

These are focused measurements. The complete acceptance suite and its coverage are separate
checks; passing these files does not substitute for their result.

Full coverage run before the cross-provider registry fix: 2,032 passed, 14 skipped and one
failed across 2,047 tests / 192 files, 216.52s (`/tmp/browser-refactor-full-coverage.log`).
The failing Chat-First schema assertion remains intact and MCP production scope approval is
pending. This is an observed failing acceptance run, not full-green acceptance or a merge.
The registry fix subsequently passed its own RED/GREEN regression and independent read-only
review; this earlier complete-suite result is retained without claiming a later full-green run.

## Liveness and cleanup invariants

- Proven external activity suppresses stale DOM health verdicts and contributes to multi-channel
  liveness. It delays decisions without waiving completion evidence.
- DOM remains authoritative for answer text; unresolved tool batches and the completion fence
  must settle before final completion.
- A stopped Thinking block does not itself prove completion while MCP acknowledgement is pending.
- Consumer callback errors propagate once, outside retryable DOM observation handling.
- Close aborts pending helper runs, then disconnects browser resources and clears lifecycle state
  in finally, including when maintenance rejects. Graceful draining would be a behavior change.

## Final read-only review and pending gaps

The extracted session/controllers use constructed instances and explicit dependencies. Launcher
orchestration preserves lease/heartbeat/retirement and interactive-lock cleanup. Completion
rebinding updates worker connection ownership before renewing loop bindings/cache; persistence
and disconnect remain with the worker. Consumer failures remain outside observation retries.
The explicit turnFailed flag preserves falsy thrown values while retaining client_cancelled
precedence. Close clears lifecycle handles in finally even when maintenance rejects; the real
helper characterization confirms abort and exactly one prepared-prompt release. DOM signal
initialization connects its observer only after its state is assigned. These slices have no
additional blocking findings from the read-only review.

One external gap remains before complete acceptance:

- Chat-First image registration: `mcp/chat-first-tools.ts` calls registerImageTools with scopeFor
  but omits contract. `mcp/image-tools.ts` defaults to native and advertises optional turn_token,
  contradicting the Chat-First schema assertion. Keep that assertion. The parent owns scope
  escalation and the prepared `/tmp/chat-first-image-contract.patch`; B changes no MCP production.
  Tests additionally exercise both aliases without turn authority using a nonexistent local input
  image and controlled child credentials, stopping before any image HTTP request.
The cross-provider registry race is resolved in commit 5f9ea42. Shutdown captures key/worker
entries, waits for their closes through allSettled, then removes only entries whose current worker
still matches that snapshot. A different provider created during the await remains registered for
its subsequent close; the same-provider behavior and aggregate failure reporting are preserved.
The regression observed RED (seven pass / one fail) before the fix in
`/tmp/browser-registry-cross-provider-red.log`. Independent review read both production/test diffs
and reran the defect suite: eight pass / zero fail in 369ms
(`/tmp/track-b-registry-review-green.log`). No blocking finding remains for this fix.

Only the unapproved MCP gap remains unresolved. Its correct Chat-First schema assertions stay
in the uncommitted test patch; MCP production was not changed by B. Final complete-suite
acceptance and disposition of that gap remain prerequisites for merge. No merge is claimed.
