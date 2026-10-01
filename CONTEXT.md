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

## Turn lifecycle checkpoints (2026-09-30)

Production and all commits belong to A. B supplied the assigned tests/infra, performed read-only
semantic review, and owns this documentation. Ownership transferred retirement and the three new
compaction test files to A during execution; B's broker composition test is frozen and committed
by A. No B staging, commits, production edits, extra agents, or live-service operations.

| Stage | Seam and responsibility | Commits and observed gates |
| --- | --- | --- |
| 1 | Strict browser-contract preflight: executable resolution, validation and child test environment | `fa98979`; B: 10 runner + 35 DOM tests, typecheck/lint pass. A full: 2,044 pass / 14 skip / 0 fail, 225.31s. |
| 2 | MCP image contract: required explicit contract and runtime rejection before tool registration | `e28d104`; missing-contract RED before fix; A focused/typecheck/lint pass. A full: 2,045 pass / 14 skip / 0 fail, 224.78s. |
| 3 | Helper wire protocol: shared input/output types, decoder framing and typed identity | `9a00e7c`, `8ed93c8`, `7d0ad4a`; A: 115 protocol/client tests, typecheck/lint pass. A full: 2,146 pass / 14 skip / 0 fail, 202.97s. |
| 4 | Retirement coordinator: physical execution/owner/conversation gates, distinct epoch closure, deterministic clock | `c437edd`, `1a8251e`, `aebdc0e`, final interaction fix `313cec1`; A latest: 92 pass, 4.57s, typecheck/lint pass (88 warnings). Earlier stage full: 2,159 pass / 14 skip / 0 fail, 207s. |
| 5 | Compaction policy, browser runner and checkpoint transaction on the existing actor journal | `5d4b6b0` policy: 82 pass; `7a7cbce` runner: 23 pass; `09d6bdd` checkpoint: 134 pass. A reported typecheck/lint passing and 13 new seam tests GREEN. A full: 2,172 pass / 14 skip / 0 fail, 211.33s. |
| 6 | Broker admission, tool queue and completion fence over the facade's sole channel registry | `8ee5ac1` characterization: B 5 pass / 41 assertions, 59ms; `07d630a` admission: A 43 pass; `1a5c60e` queue: A 45 pass, both typecheck/lint pass; `c009109` fence committed. Final full after `313cec1` remains pending. |

Lifecycle vocabulary: **logical outcome** is the client-visible final/error and exact-response
replay; **physical settlement** is completion of the helper/browser teardown; **conversation
close** also detaches the retained epoch and awaits its asynchronous retained release. Logical
completion does not imply physical settlement, and physical settlement does not imply conversation
close. Replacement ownership waits for the applicable physical/closure gate.

Broker composition is admission -> tool queue -> completion fence: admission resolves capability
authority, the queue delivers/replays calls and consumes results, and the fence commits against
the causal revision after active requests and pending invocations stop vetoing completion.
Checkpoint lifecycle is prepared -> received -> validated -> persisted -> accepted; rejection is
allowed while prepared/received/validated. Persisted or accepted checkpoints survive late cleanup;
the existing actor journal owns transition ordering and idempotency.

Stage 1 retains optional local suites but fails closed through `bun run test:browser-contracts`.
The runner resolves `CHATGPT_DOM_TEST_BROWSER` or Chromium's executable, rejects missing paths,
directories and non-executable files, then forwards the validated environment to six DOM suites.
CI still installs Chromium. B ran `/usr/bin/google-chrome`: 35 pass, zero skips, 275.73s. The included
`browser-response-dom.test.ts` still uses Domino/VM; its conversion was outside B ownership.
Evidence: `/tmp/turn-lifecycle-b-stage1-preflight-red.log`, `-stage1-runner-green.log`,
`-stage1-browser.log`, `-stage1-typecheck.log`, `-stage1-lint.log` (same prefix).

Stage 2's real MCP transport regression uses `Reflect.apply(registerImageTools, ..., [server, {}])`
and proves missing contract rejection occurs before image aliases register. Three existing callers
now explicitly select `contract: "native"`. Evidence: `/tmp/turn-lifecycle-b-stage2-mcp-red.log`.

Stage 3's real child keeps its input loop alive after `null`, `[]`, `42` and unsupported kinds;
`null` crashed before A's fix. The output decoder matrix preserves legacy ready/version behavior
and validates identity/digests. Table rows wrap values as `{ frame }` so Bun does not interpret
`[]` as a zero-argument callback. Input framing separately observed 13 valid controls and 20 RED
invalid ACK/id/kind cases. Critical ACK errors retain id and emit before abort; prepared/progress
business guards remain in the handler. Evidence: `/tmp/turn-lifecycle-b-stage3-ipc-red.log`,
`-stage3-output-decoder.log`, `-stage3-output-child-green.log`, `-stage3-input-schema-red.log`.
Version compatibility remains unchanged: unversioned ready frames without identity retain the
`legacy_unverified` path when existing build checks allow it. A versioned ready frame still requires
identity; identity-bearing frames retain protocol/version, process, artifact and build checks before
status `compatible`. Malformed advertised versions remain rejected.

Full checkpoints initially under `/tmp` hit the intentional durable-runtime path guard: 291
failures, comprising 274 direct rejections and 17 cascades. The identical focused suite failed
four cases there and passed four in the durable main tree. A recreated persistent worktrees after
a cross-filesystem move failed; no source guard or assertion changed. Evidence:
`/tmp/turn-lifecycle-b-stage1-environment-investigation.log`.

Stage 4 separates logical final/replay from physical helper settlement. B's original seven public
characterizations passed before extraction; the clock cycle, duplicate trace cancellation, TTL
pruning, and owner replacement during asynchronous retained release each observed RED before A's
fix. The final cross-cancellation interaction was discovered by source review and reproduced by
A: zero pass / one fail, expected one release/matched closure but got zero. `313cec1` separates
`conversationClosures` (one full epoch close) from `conversationRetirements` (physical scope).
Closure reservation is synchronous before waiting, duplicate close coalesces through the full
release promise, and owner gating lasts through physical settlement plus retained release.
Logical replay, cancellation deduplication and identity-checked cleanup remain intact.
Evidence: `/tmp/turn-lifecycle-b-stage4-retirement-baseline.log`, `-stage4-clock-red.log`,
`-stage4-clock-green.log`, `-stage4-path-bugs-red.log`, `-stage4-conversation-owner-red.log`,
`-retirement-conversation-gate-review.log`.

Stage 5's policy keeps route precedence; browser execution retains physical ownership before
observation, awaits browser then physical settlement before consumption, cancels on failure and
adds no blind Send retry. Observer disconnect remains separate from operator/deadline cancellation.
Checkpoint recovery/idempotency belong to SessionActorManager and its journal, without duplicate
transaction state. Order remains received -> validated -> local effect -> persisted -> accepted;
the retained path logs/marks its WeakMap after persisted, while the observer path logs its local
effect before persisted. B's read-only review found no blocking drift. A owned new seam tests;
initial RED was three missing-module load errors. Existing B baseline: 84 pass across five files,
2.42s. Evidence: `/tmp/turn-lifecycle-b-stage5-baseline.log`, `-stage5-compaction-review.log`.

Stage 6 keeps socket, binding, channel and lineage authority in the facade. Admission preserves
exact host capabilities, cycle termination, alias recency/eviction, trace-before-thread succession
and request error precedence. Queue preserves delivered-before-queued replay, one result, lifecycle
telemetry, 15ms batching and queued waiters -> claim waiters -> invocations rejection. Compaction
resolves queued calls while delivered calls remain owned. Fence preserves prune -> revision
validation -> raw token lookup, pending-work veto and committed-revision idempotency. B's final
read-only review of all three components and the `313cec1` closure fix found no unresolved blocker.
Evidence: `/tmp/turn-lifecycle-b-stage6-broker-composition-green.log`,
`-stage6-broker-composition-lint.log`, `-stage6-admission-review.log`,
`-stage6-queue-fence-review.log`, `-stage6-final-semantic-review.log`.

Final acceptance at code commit `313cec1`: the immutable full coverage suite, run alone with
unchanged timeouts, passed 2,178 tests / 14 optional browser skips / zero failures, 11,805 assertions
across 199 files in 208.51s. Evidence: `/tmp/turn-lifecycle-final-full-solo.log`. The separate required
real-browser entrypoint passed 35 tests across six suites, zero failures, in 275.73s:
`/tmp/turn-lifecycle-b-stage1-browser.log`. Worker contract: 158 pass in 1.90s; strict refactor gates
PASS (29 source / 202 test files); helper CJS bundle and Node syntax check passed. Typecheck and
lint passed; lint retains 88 pre-existing warnings. The latest retirement fix passed 92 focused
tests in 4.57s. Final coverage is 100% functions/lines for the orchestrator, shared helper protocol,
three compaction seams and three broker components; retirement is 92.86% functions / 100% lines.
Evidence: `/tmp/turn-lifecycle-final-contract.log`, `-final-gates.log`, `-final-build.log`,
`-final-types.log`, `-final-lint.log`, `-final-crosscancel-green.log`.

Validation failure history remains explicit. The intermediate mutable Stage 6 run finished at
2,177 pass / 14 skip / one fail in 249.20s: the new cross-cancellation regression loaded against
the earlier cached registry, matching its RED, so this is not immutable evidence for `c009109`.
The first immutable final full run had 2,176 pass / 14 skip / two failures in 237.89s; both were
pre-existing 5s test timeouts while full runs overlapped. The same immutable tree passed all twelve
focused tests in 17.88s: effort selection took 1,742.61ms and native workspace-write about 2.5s.
The unchanged solo full then passed those cases in 1,779.26ms and 2,442.82ms. No source guard,
assertion or timeout was relaxed. Evidence: `/tmp/turn-lifecycle-stage6-full.log`,
`/tmp/turn-lifecycle-final-full.log`, `/tmp/turn-lifecycle-final-timeouts-focused.log`.

B's semantic review completed with no unresolved finding; B then froze documentation and closed.
A assumed documentation ownership for these final receipts and local integration. No approval
or engineering verification remains pending. The migration has sixteen conventional code/test
commits and a separate documentation acceptance commit; integration uses a local fast-forward.

Zero-cast statements apply only to the reviewed extraction/worker-controller targets. The two
pre-existing `as unknown as` casts in compaction-flow's oversized-message truncation remain out of
that target; this receipt does not claim zero production casts globally.

Reproduction: `bun run test:coverage`, `bun run typecheck`, `bun run lint`, and
`bun run check:refactor-gates`. For required browser contracts, set
`CHATGPT_DOM_TEST_BROWSER` to an installed executable or install Playwright Chromium, then run
`bun run test:browser-contracts`. The required entrypoint fails preflight instead of silently skipping.
