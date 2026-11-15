# Release Record

## v1.0.1

### Standalone runtime fix

- Defer Playwright runtime imports until browser features are actually used, so CLI help does not resolve Playwright package metadata during startup.
- Run direct and extracted-binary version/help smoke checks with `node_modules` temporarily hidden and restored afterward, preventing CI runners from satisfying undeclared standalone runtime dependencies.
- Update the documented installation example to `v1.0.1`.

### v1.0.0 known issue

The `v1.0.0` standalone archives can fail `--help` outside the CI source tree because Playwright package metadata is resolved from the runner's `node_modules` path. Its tag and assets remain immutable; use `v1.0.1` instead.

## v1.0.0

### Release scope

- First versioned standalone-binary release for macOS ARM64/x64, Linux ARM64/x64, and Windows ARM64/x64. Each archive contains the platform binary, the English `README.md`, and the Simplified Chinese `README.zh-CN.md`.
- The root README is English by default and links to its Chinese counterpart; both versions document source builds, manual archives, checksums, and shell installation.
- A POSIX `sh` installer for macOS/Linux detects the host platform, resolves the latest or an explicitly selected release, verifies the archive against `SHA256SUMS`, and installs `flash` without `sudo`. It is published as the separate `install.sh` Release asset.
- The release gate covers version/help execution, exact archive contents, extraction, and checksums. Model providers, optional native integrations, signing, notarization, and automatic updates remain outside this release's verified scope.

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

## Lifecycle regressions

Changed-file offset/limit reads now have real filesystem coverage. Cron has
one-shot deduplication, recurring reschedule, aging, and lock-takeover tests,
including a fix for the disk-delete/watch-reload race. LSP has real JSON-RPC
lifecycle tests, including crash recovery, maxRestarts, shutdown timeout, and
closed-connection cleanup.

- **Verification**: 151 tests and 643 assertions passed, with typecheck, build,
  declarations, and the 42-tool compiled feature profile passing.

## Env-less perpetual and live model validation

Perpetual env-less bridges now persist `cse_*` and SSE cursors, skip session
creation on resume, rebuild after 401s, and distinguish temporary teardown from
explicit archive. Workflow-backed commands are `local` with non-interactive
support and a real permission fallback, so headless workflows execute.

Real model checks returned `WORKFLOW_LIVE_OK`, `PROACTIVE_LIVE_OK`,
`CONTEXT_COLLAPSE_LIVE_OK`, and `REACTIVE_COMPACTION_LIVE_OK`. No Claude OAuth
is currently available, so Cloud Files, Remote Control, and env-less live
server checks remain unverified. Native desktop control also needs an
authorized interactive desktop.

- **Verification**: 152 tests and 645 assertions passed, with typecheck, build,
  declarations, and the 42-tool compiled feature profile passing.
- **Commit**: `e31ff8ffe39417856b209be89190ef9cc429e6b9`; CI run `42861258902` passed.

## CI live validation

Added `live-validation.yml` with separate model, SkillHub, Cloud, and desktop
jobs. Model and public SkillHub scripts are opt-in scheduled/manual checks;
OAuth and desktop jobs run only when their protected environment is present.
The scripts use isolated config directories and never print credentials.

Live script checks returned `WORKFLOW_LIVE_OK`, `PROACTIVE_LIVE_OK`,
`CONTEXT_COLLAPSE_LIVE_OK`, `REACTIVE_COMPACTION_LIVE_OK`, and
`SKILLHUB_LIVE_OK`. SkillHub's current `global` namespace and response shapes
are now supported. GitHub Actions `live-validation` run `42940722483` also
passed, with model/Cloud skipped when their credentials are absent and desktop
skipped when no self-hosted runner is configured.

## Settings-based authentication

`live-model-validation.ts` now accepts `ANTHROPIC_AUTH_TOKEN` directly from
`~/.claude/settings.json` while rejecting ambiguous simultaneous API-key and
Bearer-token configurations. The CI auth guard recognizes the same token type.
Local settings-based validation returned all four model sentinels. The workflow
uses the matching `ANTHROPIC_AUTH_TOKEN` secret instead of treating it as an
`x-api-key` credential or Claude OAuth.

## Substantive commit design documentation

All 93 historical commits now have independently reviewed design records and
rendered SPEC/PLAN pairs. SPEC records the before-state, goals and non-goals,
architecture and data flow, decisions, alternatives, security boundaries,
acceptance criteria, evidence, and remaining scope. PLAN reconstructs the
file-level implementation order, reuse, compatibility, risks, verification,
and completed versus incomplete work. Metadata-only commits document their
actual self/SHA and index migration rather than inventing product architecture.

`scripts/commit-docs/records/` is the mandatory content source; missing records
and generic fallback prose fail instead of being generated. Validation covers
full-SHA inventory, changed-file and symbol references, immutable evidence
revisions, descendant-only later evidence, placeholders, sensitive content,
and duplicated substantive paragraphs. Automated checks do not replace the
per-commit semantic review.

Normal CI validates ancestor SHA records plus the current `self` record. The
local `--next` mode also finalizes the current HEAD before a new commit. CI runs
only the read-only `docs:check`; it no longer generates documents immediately
before checking them. A new GitHub Actions result will be recorded separately
only after that run actually completes.

## External stub restoration

All 82 audited external stubs now have public implementations and offline
verification. Remote Control distinguishes ordinary messages from trusted
webhooks and renders webhook, cross-session, and Fork content instead of
dropping it. `bridge:` peer messages use the Sessions API. Agent memory
snapshots, public commit attribution, semantic Bash prompt rules, and public
MCP Tasks cancellation are implemented.

The browser and desktop backends are separated by capability: isolated
Playwright remains available for WebBrowser, while real Chrome attaches over
loopback CDP with a dedicated persistent profile. Computer Use separates
Zavora from a public macOS native adapter built with ScreenCaptureKit,
CoreGraphics, NSWorkspace, and CGEvent. Neither path claims private extension
or Swift/Enigo ABI compatibility.

Direct Connect, background sessions, SSH, local Template Jobs, and the
versioned Open Runner protocol now include real process, persistence, auth,
recovery, and cleanup paths. Eighteen restored slash commands, public
maintenance commands, Tungsten, MoreRight, ccshare resume, and the remaining
public prompt/settings/devtools capabilities are registered in the external
build. Feature flags are shared by production and profile tests, and the
standard test runner isolates each test file in a separate Bun process.

- **Verification**: 87 test files, 483 tests and 2415 assertions passed, one
  skipped; zero failures. Typecheck, CLI/SDK/declaration builds, Swift helper
  compilation, external profile checks, and dist command smoke tests passed.
- **Live boundaries**: trusted webhook production, two-session peer traffic,
  Google Chrome login state, interactive desktop controls, authorized Linux
  SSH, external runners, and private-protocol differential compatibility were
  not executed. Open CDP, Open Runner, and the public macOS helper are open
  implementations, not private-protocol compatibility claims.
