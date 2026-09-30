# CONTEXT

Working notes for anyone (human or agent) touching the ChatGPT web adapter while
`browser-worker.ts` is decomposed into composed controllers. It fixes the vocabulary used across
the refactor and the test conventions the refactor must preserve. For the product-level picture
(modes, launcher, MCP) read `docs/architecture.md` instead.

## Module map

`src/adapters/chatgpt-web/browser-worker.ts` — worker entry point and turn orchestration. Owns the
resolved browser configuration, the browser/context/page handles, the managed-browser startup
promise, the maintenance tail, the active-run registry, the launcher helper and the turn pipeline
(`run` → `runExclusive` → `runBrowserTurn`). The pipeline is what the sprint is carving out (S2).

`src/adapters/chatgpt-web/browser/` — composed controllers, one concern each. Every controller is
a class whose methods type their `this` as a `...Host` interface: the worker lends exactly the
state slice the controller needs (config, handles, registries, host callbacks), so
`ChatGptBrowserWorker.prototype` keeps steering every internal call without construction-order
coupling.

- `browser-session.ts` (`BrowserSession`) — page/context lifecycle: managed browser startup,
  suspension-aware stage budgets (`runStage`), maintenance tail, run registry.
- `composer-controller.ts` (`ComposerController`) — composer acquisition, prompt attach, connector
  trigger attempt budget, send.
- `submission-observer.ts` (`SubmissionObserver`) — submission evidence: baselines, DOM state
  caches, acceptance verdicts.
- `turn-diagnostics.ts` (`TurnDiagnostics`) — assistant-turn binding, stalled-turn diagnostics,
  diagnostic page snapshots.
- `response-observer.ts` (`ResponseObserver`) — response DOM snapshots feeding the completion loop.
- `model-controls.ts` (`ChatGptModelControls`) — model/effort selection and verification against
  the live picker.

Pure modules under `browser/` — no Playwright types, no I/O, deterministic; unit-testable without
a page:

- `dom-signal.ts` — event-driven DOM wake signal for the observation loops.
- `dom-trackers.ts` — completion and tool-status evidence windows (DOM health verdicts).
- `turn-liveness.ts` — `resolveTurnLivenessSignals`, the S3 liveness classifier.
- `turn-completion-fsm.ts` — explicit phase machine for the completion loop: every DOM observation
  maps to exactly one phase and action.
- `suspension-clock.ts` — stage budgets that refund time spent in system sleep.
- `prompt-readback.ts` — attached-prompt readback equivalence.
- `multipart-plan.ts` — Bigger Context staged-send planning.
- `context-pressure.ts` — per-conversation/per-page context pressure tracking.
- `turn-events.ts` — per-turn scoped event bus; identity `(sessionId, surfaceId, turnId)` so
  concurrent turns never see each other's events.

## Seams

- **S1 — public worker API.** `ChatGptBrowserWorker.run / verifyConnector / inspectSession /
  smokeTest / inspectLimitsPlan / close`. The only surface all consumers use; shape and semantics
  are frozen.
- **S2 — TurnOrchestrator (planned).** The turn pipeline inside `runBrowserTurn` (prepare → attach
  → send → observe → complete), extracted so the worker keeps S1 and delegates.
- **S3 — `resolveTurnLivenessSignals`.** Pure classification consumed by the observation loops;
  signature frozen: snapshot + `now` → `{ externalProgressLive, externalToolCallsInFlight,
  multiChannelLivenessActive }`.
- **S4 — pure module seams.** The exported functions of the pure modules above; tests drive them
  directly, never through worker source text.

## Testing conventions

- Tests go through public APIs (`forProvider`, `run`, `close`) or worker-prototype fixtures:
  `Object.assign(Object.create(ChatGptBrowserWorker.prototype), {...})` with only the fields the
  exercised path touches. Never call the constructor directly. Shared builders live in
  `tests/fixtures/browser-fakes.ts` (page/locator/composer fakes) and
  `tests/fixtures/worker-harness.ts` (worker fixture + turn builder).
- Source-text assertions — `readFileSync` of anything under `src/` — are banned. The remaining
  occurrences in `tests/browser-worker-contract.test.ts` are being eliminated (sprint-4 gate; see
  `bun run check:refactor-gates`).
- DOM evaluation callbacks are tested against real synthetic DOM: build a domino window, expose it
  in a `node:vm` context, and run the serialized worker callback against the domino element —
  `runInContext(\`(\${callback.toString()})\`, context)(element, arg)`. See
  `tests/prompt-readback.test.ts`. This exercises exactly the code a Chromium page would, without
  a browser.
- `mock.module` isolation: one mocked module per new test file. Snapshot the real exports before
  installing the mock, delegate everything the mock does not override, and restore in `afterAll`
  (see `tests/browser-worker-defects.test.ts`).

## Liveness invariants

Pinned by `tests/turn-liveness.test.ts`; preserve them through any refactor:

- `externalProgressLive` implies `multiChannelLivenessActive`: proven MCP activity always counts
  as liveness.
- The DOM remains authoritative for text and completion.
- Liveness postpones verdicts, never waives them.
