# Refactor Monoliths — P0 Baseline Contracts

Status: in progress

## Classification

- SHS cell: `R1xM`.
- Risk rationale: P0 changes only executable characterization/tests and evidence, not production behavior, but the tests define regression boundaries for production contracts.
- Size rationale: eight refactor areas require coordinated test mapping and baseline verification.
- Independent read-only review is required before closure.
- If P0 discovers a sensitive trigger domain that requires changing production code, stop P0 and create/reclassify a separate work unit; P0 itself must not modify production code.

## Scope

### Allowed production edits

None.

### Allowed P0 edits

- `tests/**` only when a missing deterministic contract must be characterized.
- `launcher/tests/**` only when a missing deterministic launcher contract must be characterized.
- `odd/tasks/refactor-monoliths-p0.md` for execution evidence.
- `roadmap.yaml` only if P0 status/evidence metadata needs to be recorded without changing the planned implementation semantics.

## Work units

- [ ] P0-W1 — Inventory nearest direct and integration tests for P1-P8.
- [ ] P0-W2 — Add only missing black-box characterization required before extraction.
- [ ] P0-W3 — Record exact focused test commands for P1-P8.
- [ ] Run P0 boundary verification.
- [ ] Complete independent read-only review or record the concrete harness blocker.

## TDD / Evidence policy

- Existing covered behavior is baseline evidence; do not manufacture RED for behavior already characterized.
- A new characterization test must demonstrate an actually uncovered observable contract.
- If a new test is needed, observe RED for the expected missing contract/harness seam before any production implementation. P0 contains no production implementation, so a RED that reveals an existing bug stops the phase and becomes a separate bug task rather than being "fixed" inside P0.
- Prefer public/facade behavior over private implementation assertions.
- Record command, result, and whether a failure is candidate-caused, pre-existing, flaky, or environment-caused.

## Baseline targets

1. P1 — `src/bridge/sse-stream.ts`
2. P2 — `src/adapters/chatgpt-web/index.ts`
3. P3 — `launcher/electron/runtime-supervisor.cjs`
4. P4 — `launcher/electron/runtime.cjs`
5. P5 — `launcher/src/App.tsx` + `launcher/electron/main.cjs`
6. P6 — `launcher/electron/browser-host.cjs`
7. P7 — `src/adapters/chatgpt-web/browser-worker.ts`
8. P8 — `src/adapters/chatgpt-web/turn-broker.ts`

## Evidence log

- Branch at P0 start: `docs/refactor-roadmap`.
- Pre-existing untracked planning artifacts: `roadmap.yaml`, `odd/tasks/refactor-monoliths-roadmap.md`.
- Delegated explorer attempt: unavailable in this session; inline read-only fallback is being used.
