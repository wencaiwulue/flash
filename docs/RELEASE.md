# Release Record

## Initial restoration release

- **Source baseline**: `4b9d30f` (`asdf`).
- **Target repository**: `wencaiwulue/flash` on GitHub.
- **Visibility**: Public, selected by the repository owner.
- **Release status**: Initial commit pushed and first GitHub Actions run passed.
- **Commit**: `9b2a35201244ca84adeaa6844bf799e5a18aff6d`.
- **CI**: `ci` run `42750917055` passed on 2026-11-10.
- **Remotes**:
  - `legacy`: `https://github.com/wencaiwulue/claude-code`
  - `origin`: `git@github.com:wencaiwulue/flash.git`

The initial commit preserves the current work rather than creating an orphan branch or rewriting the baseline. `node_modules/`, `dist/`, local configuration, logs, and credentials are excluded by `.gitignore` and by the pre-push review.

### Included work

- Restored a reproducible Bun/TypeScript build and declaration pipeline.
- Recovered original TypeScript sources from embedded source maps where available.
- Restored core message, SDK, UI, OAuth, storage, and transport types.
- Added the external build and disabled-boundary behavior for internal-only modules.
- Implemented the CLI headless path, SDK query, in-process MCP, V2 sessions, portable session mutations/forking, and scheduled tasks.
- Added offline regression tests and CI.

### Verification at release preparation

- Frozen dependency installation passed.
- TypeScript checking completed with zero errors.
- 7 tests and 38 assertions passed.
- CLI, SDK, and declaration builds passed.
- Real CLI/SDK query, in-process MCP, V2 multi-turn/resume, abort, and packaged SDK query checks passed.

See `docs/STATUS.md` for the commands and the distinction between verified, implemented-but-unverified, missing, disabled, and protocol-blocked capabilities.

### Known limitations

`connectRemoteControl`, Linux libsecret, npm marketplace sources, Cloud xattr persistence, SDK rewind, non-REPL stop hooks, and several SDK control methods remain incomplete. Cloud and daemon/bridge work requires authoritative protocol confirmation. Internal experimental features remain disabled in the external build.

The initial release does not amend its commit to add release metadata. The actual commit SHA and GitHub Actions result will be recorded in a subsequent documentation update.

## Follow-up feature completion

- **Commit**: `6b7bf48b0b4f0af740073eddbc5584f0c598c539`.
- **CI**: `ci` run `42757526053` passed on 2026-11-10.
- **Remote**: the same commit is present on `origin/main`.

Added Linux libsecret with fallback, npm marketplace loading and refresh, ultraplan OAuth refresh, SDK rewind, headless prompt/agent stop hooks, and SDK control APIs. The full suite now has 38 tests and 146 assertions, with build and declaration generation passing.

Cloud xattr and daemon/bridge remote control remain blocked on authoritative protocols. See `docs/STATUS.md` for the current matrix rather than treating them as implemented.

## Remote control and Cloud unblocking

`connectRemoteControl` now uses the existing env-less bridge instead of a daemon
stub. It has offline fake-transport coverage for FIFO queues, permission request
pairing, control responses, and teardown. Cloud persistence now maps output paths
to Files API file IDs rather than relying on an unspecified xattr attribute.

The perpetual fallback is intentional: env-less + perpetual uses the existing
env-based pointer/reconnect implementation. A future pure env-less perpetual
protocol remains separate work and is not claimed here.

Verification and release metadata for this change will be appended after the
next commit and GitHub Actions run.

- **Commit**: `02bc3c2efcd3f3d7978da33b2683e9d392f3220c`.
- **CI**: `ci` run `42778573907` passed on 2026-11-10.
- **Verification**: 61 tests and 247 assertions passed, with typecheck, build,
  declarations, and CLI/SDK smoke checks passing.

## External feature profile and SDK DAG recovery

The external build now compiles the existing trigger, remote-trigger, voice,
bridge, ultraplan, file-persistence, and brief implementations. `/ultraplan`
uses the normal Claude AI availability checks instead of an internal-user gate.
A standalone Bun regression builds and loads the feature profile, checking 27
non-null tools and the `ultraplan`, `voice`, and `brief` registrations.

SDK session reads now share the CLI's pure parallel-branch recovery helper.
Both public message reads and V2 transcript resume retain same-ID assistant
siblings and their tool results before filtering and pagination.

- **Verification**: 64 tests and 261 assertions passed, with typecheck, build,
  declarations, and CLI/SDK smoke checks passing.

## Monitor, terminal capture, and simple tool implementations

`Monitor` now runs permission-checked background shell commands and turns real
stdout chunks into per-line task notifications, including chunk-boundary and
final partial-line handling. `TerminalCapture` reads the existing tmux panel
without creating or attaching a session. `OverflowTest` produces deterministic
large results. These three features are enabled in the external profile, which
now contains 30 non-null tools.

Sleep supports aborts and the existing min/max settings; CtxInspect reuses the
`/context` data path. Their dependent proactive and context-collapse feature
flags remain disabled until those feature groups are complete.

- **Verification**: 73 tests and 288 assertions passed, with typecheck, build,
  declarations, and CLI startup smoke checks passing.

## Proactive state and Coordinator workers

Proactive mode now has real activation, pause/resume, context-blocked state,
change subscriptions, next-tick visibility, and an idle scheduler. `/proactive`
controls the mode, Sleep is enabled only while it is active, and the external
REPL no longer relies on `USER_TYPE=ant` for tick scheduling.

Coordinator mode now supplies a background `worker` definition with standard
non-recursive tools and a self-contained task/verification prompt. Lightweight
name-only modules avoid loading the tool registry from worker definitions.

- **Verification**: 77 tests and 329 assertions passed, with typecheck, build,
  declarations, CLI startup smoke checks, and the 32-tool compiled feature
  profile passing. Real model-driven proactive and multi-worker sessions remain
  separate live validation work.
