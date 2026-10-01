# Read-only diagnostics review evidence

Reviewer: continuity-recovery conversation, distinct from main implementation conversation. No formal reviewer-isolation or approval claim. Root was read only by this reviewer; probes, logs, fixtures, and this report were written only under /tmp. No runtime restart, deployment, live canary, root build, or root test suite.

## Snapshot limits

Before HEAD: 02f79eaafa91841af8dcd132f223990974997548
After HEAD: 02f79eaafa91841af8dcd132f223990974997548
Before/after dirty status differs while main implementation proceeds concurrently. Do not attribute these changes to reviewer edits. The missing-peer identity finding was rerun after a concurrent source correction and is no longer reported as current. Source hashes of the inspected files are recorded in cgw-diagnostics-review-status-after.json. Probes import current root modules, not the recovery branch; root sources were mutable during review.

## Reproductions

Run from /tmp/cgw-continuity-recovery:

- bun /tmp/cgw-diagnostics-review-probes.ts
- bun /tmp/cgw-diagnostics-review-name.ts
- bun /tmp/cgw-diagnostics-review-dag.ts

Logs: /tmp/cgw-diagnostics-review-probes-current.log, /tmp/cgw-diagnostics-review-name.log, /tmp/cgw-diagnostics-review-dag-current.log.

1. errors.ts:212,232: primitive root errors get different UUIDs for root and first node; undefined/null/string/boolean/number graphs all fail parseDiagnosticError. String AbortSignal reasons therefore fail typed abort-frame validation in helper-protocol.ts:426. No fabricated cause or replacement journal.
2. errors.ts:340-350: shared children are traversed repeatedly; reached only counts nodes and never bounds revisits. A 9-node, 6,222-byte graph with 16 repeated edges per level failed to complete within a 750ms child-process deadline, terminated with SIGTERM. Such graph fits normal wire budgets and depth 8; parse is synchronous.
3. errors.ts:189-193: safeName coerces unknown values and returns the original value after a matching string conversion. A name object containing a private sentinel and toString returning Error leaks the sentinel into both serialized graph and producer event. A throwing toString also escapes serialization; produce(input) occurs before the emitDiagnosticEvent catch at index.ts:48.
4. runtime-identity.ts:55-63: valid paired hashes with buildCommit null yield non-null artifactSetSha256 but manifest_mismatch. build-development-runtime.ts intentionally emits null for dirty checkouts. launcher-helper-client.ts:358-367 rejects manifest_mismatch during handshake, so dirty development snapshots cannot initialize their helper despite matching artifacts.
5. runtime-identity.ts:31,66: corrupt JSON in an existing manifest leaves entrypoint_only because catch swallows parsing failure. This differs from missing peer in a readable paired manifest, now correctly manifest_mismatch. Both artifacts can lose paired verification/commit attribution; handshake can no longer compare a known artifact set when both do this.
6. events.ts:279-295,360: malformed external runtime pid/generation/protocol are silently replaced by local process identity. Probe with pid0/generation invalid/protocol0 was accepted and attributed to receiver PID/generation; parser should reject malformed remote identity rather than invent provenance.

Inspected sink queue/allocation/archive bounds, no-follow/nonblocking file handles, producer ring budgets, retention eligibility, server flush lifecycle, and startup snapshot verifier. No additional concrete defect proven in these paths. Packaged source/helper vs installed CLI roots were checked against ensurePackagedRuntime's bundle validation; distinct paths alone are not reported as mixed-build evidence.

## Earlier commit review (separate snapshot)

Root commits reviewed: fe203a8, b7e9f2c, 9c0d2a8. Cherry-picked into clean tracked recovery worktree as 221fa6c, ea24ddb, 6eb7f45. Recovery implementation remains atomic commit 35a016509c0ca505d6d070916185b919dae165dc, evidence /tmp/cgw-recovery-evidence.md.
Focused earlier verification: 39 pass / 0 fail / 208 assertions (823ms); launcher logging 8 pass / 0 fail; typecheck exit0. Logs /tmp/cgw-main-review-focused.log, /tmp/cgw-main-review-logging.log, /tmp/cgw-main-review-typecheck.log.
Earlier targeted regression probes: 2 pass / 2 fail, /tmp/cgw-main-review-probes.log; missing-peer downgrade was then reproduced and subsequently corrected in current root. Fresh compaction digest prompt omission was reported to main separately; not rerun or approved in this diagnostics review.
HTTP tests in /tmp worktree: 0 pass / 2 fail caused by existing production guard rejecting ephemeral /tmp runtime paths; no HTTP defect inferred and guard not weakened. Log /tmp/cgw-main-review-http.log.

## Follow-up fixes rereview

All six previously reproduced findings are resolved by current independent probe reruns. See /tmp/cgw-diagnostics-rereview-evidence.md for commands, results, main-provided RED/GREEN logs, and new depth/cycle cases. Original findings above are historical evidence and were not overwritten. No formal approval.
