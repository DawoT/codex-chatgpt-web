# Changelog

All notable changes to this fork are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
versions adhere to [Semantic Versioning](https://semver.org/). This fork
diverged from `miuuyy/codex-chatgpt-web` before its 6.1.0 release; upstream
releases are tracked separately and are not listed here.

## [Unreleased]

## [6.2.0] - 2026-09-29

First fork release line. The fork adds durable session actors, a hardened
turn broker, a reworked compaction pipeline, and local security hardening
on top of the upstream 6.0.x browser bridge.

### Added

- Durable session actors (`session-actor/`): a WAL SQLite journal owns
  session state while in-memory mailboxes serialize commands; per-producer
  sequence gaps answer `recovery_required`, commands replay idempotently,
  and startup recovery abandons uncertain browser operations without
  persisted results. Mailboxes are evicted (quiesce + identity guard) after
  global cancellation so the manager cannot grow with cancelled sessions.
- Structured retained-compaction handoffs: one-shot MCP control tokens,
  bound checkpoints, execution-evidence classification, autonomous
  triggering, compaction canary observability, resilient fresh-chat
  fallback and oversized-stage truncation for fallback turns.
- Turn-broker hardening: surface nonces, completion fences, activity
  leases, bounded token aliases and retired-handle tombstones, idempotent
  concurrent revocations, and typed protocol errors
  (`TurnBrokerTokenError`, `TurnBrokerRequestError`, `TurnBrokerStateError`,
  `TurnBrokerProtocolError`) with unchanged message text.
- Loopback Host header validation on every request (DNS-rebinding guard)
  and per-peer-address rate limiting on `/v1/responses`.
- `CHANGELOG.md` (this file).

### Changed

- Repository identity (downloads, auto-updater, issue templates) points at
  this fork; upstream credits and issue references are preserved.
- Bun toolchain pinned to 1.4.2 across CI, installers, launchers and
  runtime notices.
- Internal `odd/` agent task notes are no longer tracked.

### Security

- `fast-uri` overridden to 3.1.8 and `ip-address` to 10.7.2 in the root
  workspace, and `fast-uri`/`undici` (per-major) in the launcher workspace,
  clearing two high and two moderate advisories so `bun audit` gates are
  green again.

[Unreleased]: https://github.com/DawoT/codex-chatgpt-web/compare/v6.2.0...HEAD
[6.2.0]: https://github.com/DawoT/codex-chatgpt-web/compare/7579422...v6.2.0
