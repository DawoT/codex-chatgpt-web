# Diagnostics fixes: read-only rereview

Reviewer: continuity-recovery conversation; no formal approval or verified-isolation claim. Root /home/deuz/projects/codex-chatgpt-web was read only. Every probe/log/fixture/evidence write occurred under /tmp; no runtime restart, root build, deployment, or live canary.

Reviewed runtime-identity tracked diff and current errors/events implementations (diagnostics directory remains untracked in root). All six earlier reproduced findings are resolved in the inspected implementations. safeName never coerces; primitive root shares graph ID; parse traversal re-expands only at increasing depth, with active-cycle detection preceding the cache; dirty matching artifacts retain verified status; corrupt existing JSON produces mismatch; malformed remote identity throws before sanitizer fallback.

Original probes rerun:
- bun /tmp/cgw-diagnostics-rereview-probes.ts -> exit0. Only adaptation from the original script: catch expected remote-identity rejection so remaining manifest probes still execute. Primitive cases undefined/null/string/boolean/number all valid. Hostile name no throw. Remote identity rejected. Missing pair and corrupt manifest mismatch. Dirty matching pair verified with null buildCommit.
- bun /tmp/cgw-diagnostics-review-name.ts -> exit0. graphLeaksSentinel=false, eventLeaksSentinel=false, nameType=string.
- bun /tmp/cgw-diagnostics-review-dag.ts -> exit0, completed; same 9-node/6222-byte case previously killed at 750ms.
- bun test /tmp/cgw-diagnostics-rereview-depth.test.ts -> 3 pass / 0 fail / 3 assertions, 32ms. Shared node first reached shallowly is accepted on a depth8 longest path; depth9 is rejected; reachable cycle is rejected.

Logs: /tmp/cgw-diagnostics-rereview-probes.log, /tmp/cgw-diagnostics-rereview-name.log, /tmp/cgw-diagnostics-rereview-dag.log, /tmp/cgw-diagnostics-rereview-depth.log.

Main-provided evidence inspected (not executions by this reviewer):
- /tmp/cgw-review-regressions-red.log: 27 pass / 10 fail / 136 assertions, 813ms.
- /tmp/cgw-review-regressions-green.log: 37 pass / 0 fail / 146 assertions, 751ms.
- /tmp/cgw-error-facts-red.log: 5 pass / 2 fail / 35 assertions, 1.55s.
- /tmp/cgw-error-facts-green.log: 17 pass / 0 fail / 78 assertions, 953ms.
The aggregate main RED logs already show the safeName regression passing; original independent before/after probe logs establish that finding separately. These are observational rereview results, not a full-suite result or deployment approval.

Before/after HEAD: 02f79eaafa91841af8dcd132f223990974997548 / 02f79eaafa91841af8dcd132f223990974997548.
Inspected source files changed during probes: [].
Root status changed during probes: False.
Snapshots and SHA256: /tmp/cgw-diagnostics-rereview-before.json, /tmp/cgw-diagnostics-rereview-after.json.
