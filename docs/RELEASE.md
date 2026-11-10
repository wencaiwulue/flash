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
  declarations, CLI startup smoke checks, and the 42-tool compiled feature
  profile passing. Real model-driven proactive and multi-worker sessions remain
  separate live validation work.

## Local skill discovery

Local skill search now indexes project, user, and plugin command metadata with
Fuse.js, falls back to keyword aggregation for natural-language queries, and
filters skills already visible or invoked. Turn-zero, write-pivot, and subagent
signals produce native discovery attachments, and `DiscoverSkills` exposes the
same search to the model. Cache clearing is wired into command reloads.

Remote canonical-skill loading remains explicitly unavailable because no
authoritative remote protocol is present; this change does not fabricate remote
skills or success telemetry.

- **Verification**: 83 tests and 352 assertions passed, with typecheck, build,
  declarations, CLI startup smoke checks, and the 42-tool compiled feature
  profile passing.

## UDS inbox and peer sessions

The UDS boundary now runs a real local socket server with 0600 permissions,
bounded newline frames, ping/pong discovery, request timeouts, and private
per-session registry records. Incoming text enters the existing prompt queue
and wakes headless consumers. Clients address peers by socket path or session
ID, remove stale records instead of returning offline peers, and clean up both
socket and registry on teardown. `ListPeers` and `/peers` expose the live view.

- **Verification**: 85 tests and 368 assertions passed, including real local
  socket round trips. Typecheck, build, declarations, and the 42-tool compiled
  feature profile passed.

## Daemon and Remote Control server lifecycle

`daemon start|run|stop|status` now has a real supervisor with bounded
exponential restarts, signal-driven worker termination, and stale PID cleanup.
Workers dispatch to the SDK remote-control query path instead of a separate
wire protocol. `/remote-control-server` shares one query, reports the existing
session URL, and disables remote control and closes input during teardown.

- **Verification**: 91 tests and 390 assertions passed, with typecheck, build,
  declarations, `daemon status`, and the 42-tool compiled feature profile
  passing. Lifecycle tests use fakes; no live Cloud session is claimed.

## Declarative workflows

Workflow JSON definitions now have strict schema, unique-step, dependency, and
cycle validation. Discovery covers project/user directories plus bundled
registrations. The executor provides bounded DAG concurrency, input/result
interpolation, failure propagation, skip/retry/kill controls, and downstream
retry recovery. Local task state, output persistence, notifications, and the
workflow detail UI are connected. Steps still execute through the existing
agent runner and tool permission callback.

- **Verification**: 100 tests and 424 assertions passed, with typecheck, build,
  declarations, and the 42-tool compiled feature profile passing. Step runners
  are deterministic fakes; real model-agent workflows remain live validation.

## Context collapse

Context collapse now projects committed spans by UUID, runs summarization in
the background at 90% and blocks at 95%, tracks staged state and health, and
recovers staged summaries after a real prompt-too-long response. Commit and
snapshot restoration preserves collapse IDs and boundaries across resume.
Tool-use/result pairs are kept intact, empty summaries are rejected, and
`CtxInspect` exposes the live counters.

- **Verification**: 107 tests and 459 assertions passed, with typecheck, build,
  declarations, and the 42-tool compiled feature profile passing. Summarizers
  and persistence are injected fakes in tests; live model and API 413 recovery
  remain separately unverified.

## Reactive compaction

Reactive compaction now detects prompt-too-long and media-size errors, strips
images/documents with the existing compactor, preserves PreCompact semantics,
and maps too-few-groups, abort, exhausted, error, and unstrippable-media
outcomes. Successful recovery performs the same cache and state cleanup as the
other compaction paths.

- **Verification**: 112 tests and 479 assertions passed, with typecheck, build,
  declarations, and the 42-tool compiled feature profile passing. Live API
  recovery remains separately unverified.

## Buddy and Fork Subagent

BUDDY now hatches and persists model-generated companion souls, emits short
reactions through the existing side-query path, and supports `/buddy` status,
mute, and unmute. Deterministic bones remain independent of stored soul data.
FORK_SUBAGENT is enabled with its existing cache-preserving context prefix,
recursive-fork guard, worktree notice, and a real `/fork` prompt command.

- **Verification**: 118 tests and 516 assertions passed, with typecheck, build,
  declarations, and the 42-tool compiled feature profile passing.

## HISTORY_SNIP

History snipping now uses explicit tool markers, protected recent messages,
bidirectional tool-pair expansion, token-growth nudges, and idempotent boundary
projection. REPL keeps scrollback while SDK replay truncates its in-memory
view. `Snip` and `/force-snip` are enabled without rewriting on-disk history.

- **Verification**: 125 tests and 546 assertions passed, with typecheck, build,
  declarations, and the 42-tool compiled feature profile passing.

## ReviewArtifact and Hunter

ReviewArtifact now performs independent read-only reviews with FileRead
permission checks, size limits, structured blocker/warning/nit findings,
file/line evidence, and explicit unverified status. `/hunter` registers a real
bundled evidence-review prompt instead of an unavailable placeholder.

- **Verification**: 130 tests and 563 assertions passed, with typecheck, build,
  declarations, and the 42-tool compiled feature profile passing.

## SkillHub remote skills

Remote canonical skills now use SkillHub's public REST API instead of the
missing private AKI backend. Discovery registers `_canonical_` skills, loading
resolves a fixed version, and downloads use bounded, path-safe zip extraction
with symlink rejection and versioned disk caches. Remote errors are reported
without dropping local skill results or emitting false success telemetry.

- **Verification**: 134 tests and 580 assertions passed, with typecheck, build,
  declarations, and the 42-tool compiled feature profile passing. Tests use a
  real local HTTP registry; a self-hosted live registry remains separate.

## Open KAIROS functionality

KAIROS now initializes real in-process assistant teams, discovers sessions via
OAuth APIs, and provides a real daemon install wizard. SendUserFile uses the
existing bridge upload path, notifications use OS/webhook adapters, and PR
subscriptions use GitHub REST with first-poll baselining and ID deduplication.
Dream, assistant, and subscribe-pr registrations are included.

- **Verification**: 140 tests and 604 assertions passed, with typecheck, build,
  declarations, and the 42-tool compiled feature profile passing. Live Cloud,
  notification, and GitHub round trips remain separately unverified.

## Open Computer Use and Browser backends

Computer Use now runs through Zavora's real MCP server and tool schemas while
preserving existing allowlist and permission denial behavior. Browser support
uses Playwright MCP with a real WebBrowser tool and isolated Chromium profiles,
not the previous empty private-package stubs.

- **Verification**: 142 tests and 611 assertions passed, with typecheck, build,
  declarations, and the 42-tool compiled feature profile passing. Real local
  browser navigation passed; native desktop control still needs an authorized
  desktop session.
