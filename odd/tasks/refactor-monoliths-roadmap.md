# Refactor Monoliths Roadmap

Status: complete

## Classification

- SHS cell for this planning change: `R0xS` fast path.
- Reason: this task only creates planning/documentation artifacts and changes no production behavior.
- ODD scope: substantial planning artifact, but no implementation work is performed in this task.
- No production source files may be edited as part of this task.
- No commit was requested by the user, so this task must not create one.

## Artifacts

- `odd/tasks/refactor-monoliths-roadmap.md`
- `roadmap.yaml`

## Tasks

- [x] Review harness quality requirements and repository verification commands.
- [x] Define phased refactor order, dependencies, SHS risk/size policy, and TDD evidence model.
- [x] Create `roadmap.yaml`.
- [x] Validate YAML syntax and verify required roadmap sections.
- [x] Read back the final scope and report any skipped or unavailable checks.

## Quality constraints

- Preserve the previously identified refactor order and public facade strategy.
- Encode ODD, TDD, SHS, work-unit commit boundaries, native review/RDD boundaries, rollback rules, and escalation conditions.
- Treat authentication, passkeys, shared concurrency/state, Electron privileged IPC/process control, runtime recovery, and broker capability/turn state as R2 trigger surfaces during future implementation.
- Do not invent an Engram mirror for this planning task because no writable memory tool is available in the current harness session.
- The roadmap is planning only; it must not claim that any refactor has already been implemented or verified.
