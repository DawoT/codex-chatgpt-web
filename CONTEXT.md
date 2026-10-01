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
suppressions in the worker and every browser module, zero direct worker
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
These notes record acceptance on refactor/browser-worker before merge to main. The user explicitly
approved including the MCP fix and validating everything; the approved fix is committed in bcb703b.
The branch has not yet merged to main at this documentation checkpoint.

- Worker contract: 158 passing tests, 1.89s standalone; the heavy compiler case remains in
  `browser-multipart-compilation.test.ts` with its original transport limits and assertions.
- `bun test tests/turn-orchestrator.test.ts tests/turn-completion-loop.test.ts --coverage`:
  48 passing tests, 11.31s in the focused coverage run. TurnOrchestrator: 100% functions / 100%
  lines. TurnCompletionLoop: 52.63% functions / 96.76% lines. Callback function coverage remains
  reported explicitly; the complete acceptance run confirms the same module percentages.
- Helper client: 14 passing tests, 2.70s, including close during pending browser work.
- Safe MCP lifecycle: seven passing tests, 11.04s, including both image aliases and schemas.
- Nine controlled scanner checks include future browser modules, child-process prototype strings,
  source URL/join reads and permitted temporary outputs. The strict repository scan is zero.

These are focused measurements. The complete acceptance suite and its coverage are separate
checks; passing these files does not substitute for their result.

## Final acceptance (2026-09-30, before merge)

The complete `bun run test:coverage` run passed: 2,034 passed, 14 skipped, zero failed across
2,048 tests / 192 files, 11,485 assertions, 212.57s. Evidence:
`/tmp/browser-refactor-acceptance-final-coverage.log`. The skips are reported explicitly.
The aggregate Bun coverage report is 82.34% functions / 82.19% lines.
TurnOrchestrator coverage is 100% functions / 100% lines; TurnCompletionLoop is 52.63%
functions / 96.76% lines. The launcher module exceeds its 85% line-coverage requirement.

The standalone worker contract passed all 158 tests in 1.89s. Strict gates passed with zero
violations across 29 production modules and 195 test/fixture files. Final typecheck and lint
exited zero; lint reports 88 warnings. These results establish acceptance on the branch, while
merge to main remains a separate action owned by the parent.

## Liveness and cleanup invariants

- Proven external activity suppresses stale DOM health verdicts and contributes to multi-channel
  liveness. It delays decisions without waiving completion evidence.
- DOM remains authoritative for answer text; unresolved tool batches and the completion fence
  must settle before final completion.
- A stopped Thinking block does not itself prove completion while MCP acknowledgement is pending.
- Consumer callback errors propagate once, outside retryable DOM observation handling.
- Close aborts pending helper runs, then disconnects browser resources and clears lifecycle state
  in finally, including when maintenance rejects. Graceful draining would be a behavior change.

## Final read-only review and resolved gaps

The extracted session/controllers use constructed instances and explicit dependencies. Launcher
orchestration preserves lease/heartbeat/retirement and interactive-lock cleanup. Completion
rebinding updates worker connection ownership before renewing loop bindings/cache; persistence
and disconnect remain with the worker. Consumer failures remain outside observation retries.
The explicit turnFailed flag preserves falsy thrown values while retaining client_cancelled
precedence. Close clears lifecycle handles in finally even when maintenance rejects; the real
helper characterization confirms abort and exactly one prepared-prompt release. DOM signal
initialization connects its observer only after its state is assigned. These slices have no
additional blocking findings from the read-only review.

The Chat-First image schema gap is resolved in bcb703b with explicit user approval. Registration
now passes contract: "chat-first" while preserving scopeFor, so both image aliases advertise the
correct token-free schema. The original absence-of-authority assertions remain intact. Both
aliases were called through real MCP without turn_token/request_id against a missing local input
image and controlled child credentials; the handler error proves dispatch before any image HTTP
request. Independent read-only review found no blocker; the focused regression passed in 682ms,
and the complete acceptance run passed it as well. A owned the one-line production change and
included B's delegated regression test in the same atomic commit.

The cross-provider registry race is resolved in commit 5f9ea42. Shutdown captures key/worker
entries, waits for their closes through allSettled, then removes only entries whose current worker
still matches that snapshot. A different provider created during the await remains registered for
its subsequent close; the same-provider behavior and aggregate failure reporting are preserved.
The regression observed RED (seven pass / one fail) before the fix in
`/tmp/browser-registry-cross-provider-red.log`. Independent review read both production/test diffs
and reran the defect suite: eight pass / zero fail in 369ms
(`/tmp/track-b-registry-review-green.log`). No blocking finding remains for this fix.

Both identified gaps are resolved and reviewed. No unresolved scope approval or acceptance
blocker remains from these reviews. The working branch is ready for the parent's local fast-forward
merge; this document does not claim that merge has already happened.
