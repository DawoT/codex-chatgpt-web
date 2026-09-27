# Security model

## Trust boundaries

The user trusts the local Codex app, this loopback daemon, the launcher's private Electron browser
profile, the selected ChatGPT workspace, OpenAI's tunnel service, and the exact MCP connector they
created. Repository contents, tool output, websites, and prompt text are untrusted data.

## Full-mode capability flow

1. The daemon accepts a Codex Responses turn on `127.0.0.1`.
2. It extracts `cwd`, workspace roots, and sandbox policy from the native Codex envelope. When a
   resumed root task or subagent omits that envelope, its canonical local rollout must prove the
   exact thread and current turn (or latest source turn for standalone compaction). Request metadata
   can only constrain that authority. Tools always come from the current request; user-authored
   `<environment_context>` text is never a source of recovered authority.
   A context-only continuation after completed compaction additionally binds the exact checkpoint
   and source instruction to its native thread, turn, model and effort. A freshly emitted environment
   claim without a new human message must match that turn's canonical rollout in cwd, roots and
   sandbox policy; the checkpoint alone does not grant filesystem authority.
3. It creates a random, turn-scoped token and embeds it in that one ChatGPT browser prompt.
4. Every Codex Native action presents that same turn token. The MCP handler idempotently claims an
   internal binding plus a request-scoped activity lease and immediately dispatches the requested
   action; neither internal handle is exposed to the model. The lease is settled only after the MCP
   handler finishes, including inventory calls that need no outer Codex tool.
5. MCP can request only a callable tool advertised by the active outer Codex turn. The unrestricted
   raw orchestration `exec` gateway remains available in Full mode. Before caller-authored
   JavaScript runs, the bridge wraps its tool registry with a transparent proxy that enforces the
   exact 10-second `wait_agent` polling contract and prevents recursive raw `exec`. The generic
   inventory/call pair also provides a structured exact-name path. Codex remains responsible for
   its sandbox, approval, UI, command sessions, and tool result.
6. Before a Codex tool batch is dispatched, the browser records and acknowledges the current answer
   projection. Completion stays blocked while the tool is unresolved and then requires a new stable
   final-answer projection after that causal boundary. A two-phase broker fence then rereads the DOM
   and commits completion only if the activity revision stayed unchanged with no active invocation;
   a concurrent claim makes the candidate lose, while a claim after commit receives an explicit
   terminal rejection. Recent MCP activity may suppress a false DOM-health failure but never adds
   an idle delay to a successful completion.

The bridge transports decisions; it does not add a second planner, semantic router, or fallback
model. Every available effort uses the same MCP contract. An unavailable account route, missing
connector, or missing outer tool fails explicitly instead of becoming an effort-specific exception.

The direct turn-token MCP schema is attached only through the `Codex Native2` connector identity.
The pre-v4 `Codex Native` connector is treated as legacy and is never selected as a fallback. This
prevents a cached legacy schema from being mistaken for the current capability contract.

## Chat-First connector

The chat-first contract is a third connector identity (`Codex Chat-First`, MCP server name
`codex-chat-first`) with a different ABI: its tools accept no turn token and no per-call request
id, because there is no Codex envelope to derive authority from.

1. New source of authority: the `chatFirst` block of the local operator's `config.json`. The
   enabled flag, sandbox mode, and workspace list come from that file only — never from request
   envelopes, prompt text, or tool output. Both the MCP entry point and the server fail closed
   when `chatFirst.enabled` is not true.
2. Separate connector identity and ABI: chat-first tools advertise no `turn_token`/`request_id`
   argument and never dial the turn broker, so they cannot inherit or impersonate a Codex turn's
   derived capabilities.
3. No per-call secret: the tunnel's stdio transport does not forward credentials per call. The
   gate is the conjunction of `chatFirst.enabled`, the tunnel runtime's account binding, and the
   sandbox of the configured mode (`readOnly`, `workspaceWrite`, `dangerFullAccess`).
4. Audited mutations: every successful `codex_write_file` and `codex_patch_file` appends one JSONL
   record to `runtime/chat-first-audit.jsonl` (rotated at 5 MB) with the timestamp, tool, target
   path, and written byte count. The audit is fail-open: it never breaks a completed mutation.
5. `dangerFullAccess` grants read/write access to the whole disk with the operating user's
   permissions, and it is the default sandbox mode for an enabled chat-first connector. Activating
   chat-first therefore starts from full-disk access unless the operator explicitly lowers
   `chatFirst.sandboxMode`; either choice is an explicit operator decision recorded in
   `config.json`.

## Principal risks

### Prompt injection and destructive tool use

ChatGPT sees repository content and tool results that may contain hostile instructions. Full mode
can invoke write and command tools. Use a trusted workspace, keep Codex sandbox/approval settings
appropriate, and grant only intended connector actions. Automatic per-call approval is off by
default.

### Browser session theft

The launcher's persistent Electron partition can authorize ChatGPT access. It remains in the
current OS user's private application-data directory and is never copied into a daemon prompt or
runtime descriptor. Never sync, upload, attach, or commit it. On suspected exposure, sign out or
revoke the ChatGPT session from the launcher.

### Tunnel credential theft

The runtime key needs only Tunnels Read + Use. It is accepted through a hidden prompt or copied
from a file, stored with user-only permissions, referenced by file, and never placed in a command
argument or generated profile. Rotate it after suspected exposure.

### Same-user local process

The Responses endpoint is loopback-only, but it has no independent bearer secret because the
built-in Codex OpenAI provider cannot be configured with a bridge-specific credential while
preserving the native provider/task identity. Another process under the same OS user can reach the
port. Run on a trusted single-user account and treat local code execution as inside the trust
boundary.

The lifecycle endpoints are separate from the Responses surface. `/admin/drain`, `/admin/resume`,
`/admin/cancel-turn`, `/admin/cancel-turns`, and `/admin/shutdown` require a random bearer token stored in the
user-only application config. The launcher uses them to reject new work, prove that both the HTTP
request and long-lived browser/tool loop are idle, flush response state, and stop a process. The
token does not turn loopback into a hostile-local-process security boundary; it prevents accidental
or unauthenticated lifecycle control through ordinary requests.

### Browser/UI drift

ChatGPT DOM and labels are not a stable API. Selectors are narrow; Full-mode completion requires
stable completed-turn evidence and, after tools, a new final-answer projection. UI drift fails the
turn; it never chooses another model, starts another transport, or returns a fabricated success.

### Login-state isolation

The launcher keeps ChatGPT login, identity-provider navigation, and model turns in one private
Electron partition. Allowed login popups are adopted into an in-launcher `WebContentsView` that
shares that partition; unrelated external links remain outside it. A visible composer alone is not
authentication evidence: the launcher also requires a valid server session and an exact Temporary
Chat URL before setup can continue. No cookies, local storage, or browser profile are copied from an
external browser.

### Cross-turn data leakage

Browser turns use at most five independent task-bound tabs in one private login partition. Every
outer Codex task owns an exact launcher surface lease and retains its Temporary Chat only across
sequential messages in the same model/effort/compaction epoch; chats are never reused across tasks.
Closing a running tab destroys its page and terminates that turn. The five-tab limit bounds parallel
account traffic. Tool calls remain in the same ChatGPT response. The
bounded local continuation cache is private, expires, and exists only to implement Codex
`previous_response_id` replay. Full-mode context compaction accepts a checkpoint only through its
one-shot MCP control capability in the exact retained source chat. If that chat no longer exists, a
fresh tool-free Temporary Chat receives the canonical Codex history; the bridge never parses ordinary
assistant prose as a structured handoff.

### Background command execution and sandbox boundary

For native and safe contracts, command execution belongs to the outer host. `codex_exec(background=true)` now fails explicitly for every sandbox policy: the former local-shell path bypassed host hooks and could not enforce `workspaceWrite`. Use the command options actually advertised by the host. Where native command sessions are available, `codex_write_stdin` continues them; a `shell_command` implementation does not necessarily provide that capability.

`codex_wait_tasks` remains a compatibility entry but rejects bridge-local task IDs in native/safe turns. These turns no longer create local task logs or completion/resume notifications. Existing local task IDs cannot be converted into native session IDs.

Chat-First remains an explicitly local execution mode. Its task manager is private to the MCP registration; operations filter tasks by the canonical selected workspace. This is routing isolation, not separate authentication between ChatGPT conversations: a caller authorized for several configured workspaces may select any of them. A private SQLite admission ledger in the configured home shares one command capacity across Chat-First MCP processes and workspaces (default eight active processes). Foreground calls queue in FIFO order for at most five seconds; background calls reject when capacity or a prior queue is occupied. Requested background workdirs are validated and honored. Logs are returned relative to the selected workspace.

A normal MCP stdin close cancels its foreground calls and terminates its background tasks before command leases are released. A forcefully killed MCP process cannot prove that its shell descendants stopped, so its active lease stays occupied. Inspect it with `codex-chatgpt-web admission status --json`. After independently confirming the command and descendants have settled, recover one exact lease with `codex-chatgpt-web admission recover ID --ack-descendants-settled`. Linux leases record boot ID, PID namespace and process start ticks, so a recycled PID cannot impersonate the original owner. If identity is unknown after a reboot, migration or legacy schema upgrade, additionally confirm the original owner is offline and pass `--ack-owner-offline`. Recovery always refuses an owner proven alive and never runs automatically. It does not undo command effects. Same-user tampering and deliberately escaped descendants remain outside this operational guard; a stale lease without operator recovery sacrifices availability to preserve the concurrency bound.

Task polling and multi-task waiting are cancelable and subscribe to completion events without periodic log reads. Canceling a wait leaves the job running. Explicit kill transitions through `terminating` until process close; the process continues to count against its quota. On POSIX, kill sends SIGKILL immediately to the original process group, avoiding delayed signals after PID reuse. On Linux with a delegated cgroup v2 hierarchy, each local command also joins a private child cgroup before executing; `cgroup.kill` covers ordinary descendants that start a new session. Both signals are sent because cancellation can race with the initial cgroup join. Normal command completion also retires remaining processes in that cgroup. If cgroup delegation is unavailable, the process-group behavior remains. A same-UID command that deliberately migrates out of its writable cgroup is not contained; this is not an adversarial sandbox. Windows currently signals the root child process and has no equivalent verified group guarantee. Local shell commands still do not have OS-level filesystem/network sandboxing merely because a workspace policy is configured.

Task-log storage rejects pre-existing symlink directories and checks stored file/directory identity before reading or collecting logs. It reads at most 128 KiB per tail request. Finished records are capped at 50 total retained task records; eviction removes the corresponding owned log. If logs cannot be safely reclaimed, admission fails at that record bound. A 48-hour default TTL is checked opportunistically while the registration is alive; this is not cross-restart disk retention. These checks do not establish race-free isolation against hostile concurrent ancestor-directory renames. Chat-First result conversion also disables implicit spooling, including for read-only requests.

Native/safe tool-result transport no longer spools large text into the workspace or home directory. It returns bounded inline text with the existing truncation notice. This applies to delegated results and legacy filesystem-tool results. The legacy direct filesystem handlers still exist and are not suitable for a host-only Pi adapter. This change does not harden other users of the general-purpose spooler.

The tool descriptions changed, so refresh the ChatGPT MCP connector's cached tool catalog when deploying this revision. Source changes alone do not update a running launcher.

## Network exposure

- Responses and health listeners bind to `127.0.0.1` only.
- Full mode uses OpenAI's outbound HTTPS Secure MCP Tunnel; it opens no public listener or inbound
  firewall rule.
- The embedded browser connects to ChatGPT, the selected identity provider during explicit sign-in,
  and user-authorized attachment URLs through normal browser networking.

## Non-goals

- Defending against a compromised local OS user or compromised Codex/Electron binary.
- Bypassing ChatGPT plan, workspace, usage, action-control, or model restrictions.
- Making consumer browser automation equivalent to a supported OpenAI API contract.

### Foreground command cancellation and delivery limits

Chat-First foreground calls now pass MCP cancellation into the local process handler. Already-aborted requests do not start a shell; cancellation and timeout signal the current POSIX process group and, when delegated on Linux, its command cgroup, then await close. Windows root-process termination and deliberately migrated descendants retain the limits stated above. Working directories, including the default, must pass writable-root validation; shell commands themselves are still not confined by that path check. Failed/cancelled command outcomes are included in the best-effort audit log because partial effects may have occurred.

Tool-result conversion now rejects a serialized result object larger than 1 MiB, including structured data and metadata, with an explicit error instead of slicing structured JSON. This supersedes the earlier unbounded structured-result delivery limitation. It does not cap memory consumed while producing/serializing a result or provide automatic pagination, and a delivery error does not undo tool effects.
