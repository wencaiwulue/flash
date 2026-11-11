# Implementation Status

Last updated: 2026-11-11.

Statuses:

- **Verified**: the stated command or end-to-end path was executed successfully.
- **Implemented, unverified**: implementation exists but the stated protocol or environment has not been validated.
- **Not implemented**: the capability is missing or a public API explicitly rejects it.
- **Explicitly disabled**: unavailable by design in the external build.
- **Blocked on protocol**: an authoritative contract or test environment is required before implementation can safely proceed.

## Verified evidence

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | Passed |
| `bun run generate:sdk-types` | Generated 125 core types and 59 control types |
| `bun run typecheck` | Passed with zero TypeScript errors |
| `bun test` | 168 tests, 672 assertions passed |
| `live-validation` workflow | Run `42940722483` passed; SkillHub executed, model/Cloud were skipped when credentials were absent, and desktop was skipped without a self-hosted runner |
| Commit documentation | 93 historical SPEC/PLAN pairs plus `self`; full-history `--next` checks passed with path/evidence/duplication gates and independent semantic review for every commit |
| Linux secret storage | 4 tests, 17 assertions passed with mocked `secret-tool` |
| npm marketplace | 7 tests passed with mocked npm execution; no registry access |
| ultraplan polling | Refresh-before-poll test passed |
| `bun run build` | Built CLI, SDK, and declarations |
| `bun dist/main.js --version` | `1.0.0 (Claude Code)` |
| `bun dist/main.js --help` | Completed successfully |
| CLI model + Read tool round trip | Returned `CLI_TOOL_ROUNDTRIP_OK` |
| SDK model query | Returned `SDK_QUERY_OK` and exited after cleanup |
| SDK in-process MCP round trip | Returned `SDK_MCP_QUERY_OK` |
| V2 multi-turn and resumed history | `FIRST_TURN_OK`, `SECOND_TURN_OK`, and resumed recall passed |
| Query abort | Ended with `error_during_execution` and cleaned up |
| Packaged SDK query | `dist/sdk.mjs` returned `DIST_SDK_OK` |
| Scheduled-task formatting and abort | Tests passed |

Real model checks used the session's configured provider with an isolated `HOME`. No credentials are stored in this repository.

## Capability matrix

| Area | Status | Evidence / next step |
|---|---|---|
| CLI build and startup | Verified | Build, version, help, and real headless query passed |
| Built-in tool pool | Verified | External feature-profile build loaded 42 tools with no null entries, including Cron, RemoteTrigger, Monitor, OverflowTest, TerminalCapture, and Sleep |
| External feature profile | Verified | Trigger, remote-trigger, voice, bridge, ultraplan, persistence, brief, Monitor, OverflowTest, terminal panel, PROACTIVE, and COORDINATOR_MODE are compiled in; `ultraplan`, `voice`, `brief`, and `proactive` are registered |
| Monitor streaming | Verified (local shell) | Real stdout chunks become deduplicated per-line notifications, with final partial-line flush and completion notification; Bash permission checks are reused |
| Proactive and Sleep | Verified (offline scheduler/build) | Activation, pause/resume, context blocking, idle scheduling, abort/settings, `/proactive`, and external REPL wiring tested; real model-driven perpetual session not run |
| Coordinator worker | Verified (definition/build) | One background `worker` with non-recursive standard tools and a real system prompt; multi-worker model orchestration not run |
| Local skill search | Implemented, unverified (cache lifecycle) | Fuse ranking, filtering and discovery signals are implemented, but failed-load cleanup unconditionally deletes the cwd entry and can remove a newer overlapping load; empty write-pivot results can also repeat |
| Remote canonical skills via SkillHub | Implemented, unverified (SkillTool integration) | Public REST search/resolve/download and `SKILLHUB_LIVE_OK` passed, but canonical `skillPath=destination` is later miscomputed with `dirname()`, so loading/permission/telemetry integration is not closed |
| UDS inbox and peers | Verified (real local socket) | 0600 socket permissions, plain-text enqueue/wakeup, path and session-ID routing, live peer handshake, stale registry cleanup, and teardown tested; `ListPeers` and `/peers` registered |
| Daemon supervisor and worker registry | Verified (offline lifecycle) | Bounded exponential restarts, clean stop, stale PID cleanup, worker dispatch, and `daemon status` smoke tested |
| Remote Control server | Verified (offline lifecycle/build) | Shared SDK query, enable/disable, input close, idempotent start/stop, and `/remote-control-server` registration tested; no live Cloud session claimed |
| Workflow definitions and execution | Implemented, unverified (scheduler edge cases) | Offline tests cover schema, DAG, controls, persistence and registration, but reverse-order dependency skip propagation can stall and skip→retry admits late results from the old runner; the later live sentinel does not cover these orderings |
| HISTORY_SNIP | Implemented, unverified (model Snip path) | Direct arrays and `/force-snip` cover marker/projection behavior, but the real query filters all `snip_marker` entries before `snipCompactIfNeeded`, so a model-emitted marker cannot execute through that path |
| ReviewArtifact and `/hunter` | Implemented, unverified (file permission executor) | Direct/mock tests cover input validation, reviewer structure and registration, but FileRead's `updatedInput` replaces ReviewArtifact's input shape instead of preserving `artifact_path`, `focus`, and `context` |
| Reactive compaction | Verified (offline compactor/hooks) | PTL/media withholding, media stripping, shared compactor retry, PreCompact deduplication, failure mapping, and success cleanup tested; the later live recovery sentinel is recorded separately below |
| Context collapse and CtxInspect | Implemented, unverified (full staged lifecycle) | Offline tests cover thresholds, UUID projection, restore and overflow draining, but normal `startSpawn` still commits directly without first enqueueing `staged`; the later live model sentinel is recorded separately below |
| Core query and tool orchestration | Verified | Real model + Read round trip passed |
| SDK query, async messages, abort | Verified | Source and packaged SDK queries passed |
| In-process MCP tools | Verified | Tool metadata, invocation, and model round trip passed |
| SDK session list/read/rename/tag/fork | Verified | Offline JSONL tests passed; fresh fork UUID chains and parallel assistant/tool-result DAG recovery before both SDK read paths and pagination checked |
| V2 create/resume/prompt | Verified | Multi-turn and history recall passed |
| Scheduled tasks | Verified | One-shot dedup, recurring reschedule, aging, lock takeover, and missed/abort tests passed |
| LSP lifecycle | Verified (offline lifecycle subset) | Real JSON-RPC initialize, crash restart and maxRestarts passed; shutdown tests observe fast return and `stopped`, not listener disposal or child-process exit |
| Changed-file partial reads | Verified | Real offset/limit rereads, boundary changes, full reads, and deletion eviction passed |
| Non-REPL prompt/agent stop hooks | Verified (offline and E2E) | Prompt/agent allow, block, failure, cancellation, and real headless Stop feedback verified |
| SDK rewind | Verified (offline) | Per-query snapshots, dry-run, actual restore, async snapshot waits, invalid IDs, and concurrent persistence isolation tested |
| SDK `getContextUsage`, `reloadPlugins`, `stopTask`, `applyFlagSettings`, `getSettings` | Verified (offline) | Control methods use shared CLI implementations and have an empty-input regression test |
| `connectRemoteControl` | Verified (offline transport) | Env-less bridge handle, FIFO queues, permission pairing, control responses, and teardown verified with fake transport; real remote round trip not yet run |
| Linux libsecret | Verified (offline) | `secret-tool` lookup/store/clear with fallback, migration, and mocked failure tests |
| npm marketplace source | Verified (offline) | Fresh npm staging, scoped packages, schema validation, refresh, cache cleanup, and lifecycle-script suppression tested with a mock runner |
| Cloud file persistence | Verified (offline) | Files API maps normalized output paths to file IDs; ambiguity, pagination, delay, partial failure, and abort tests passed; no xattr attribute guessed |
| ultraplan OAuth refresh | Verified (mocked) | Refresh runs before every remote poll; `/ultraplan` is externally registered with Claude AI availability checks |
| env-less perpetual bridge | Verified (offline mock transport) | Reuses cse_* and SSE cursor, skips create on resume, rebuilds after 401, preserves temporary teardown, and attempts pointer cleanup on explicit archive; write/unlink failures are best-effort, and real restart/OAuth/SSE behavior is unverified |
| Live model Workflow | Verified | Settings-provided Bearer environment returned `WORKFLOW_LIVE_OK` |
| Live proactive Sleep | Verified (local scheduler) | `PROACTIVE_LIVE_OK` confirms activation and local Sleep timing; it does not make a model request or verify Bearer/OAuth |
| Live context-collapse and reactive compaction | Verified | Settings-provided Bearer environment returned `CONTEXT_COLLAPSE_LIVE_OK` and `REACTIVE_COMPACTION_LIVE_OK` |
| Buddy and Fork Subagent | Verified (offline/build) | Deterministic bones, model soul persistence, reaction, mute command, fork cache placeholders, recursive guard, worktree notice, and `/fork` prompt tested |
| Open KAIROS adapters | Verified (offline subset) | Six offline tests cover the main adapters and build registration; direct coverage does not prove every session-discovery, install-wizard, webhook, supervisor-liveness, or remote-readiness path |
| Computer Use via Zavora MCP | Verified (metadata/permissions) | Real tool schemas and denied-action protection passed; native desktop control requires a separately authorized desktop session |
| Browser via Playwright MCP | Implemented, unverified (error propagation) | Real isolated Chromium navigation, snapshot and close passed, but WebBrowser discards MCP `result.isError`, so backend failures can be returned without an error signal |
| iTerm hide/show/rebalance | Platform limitation | Not treated as a core implementation gap |

## Remaining implementation boundaries

- Self-hosted SkillHub registry: the public registry round trip passes (`SKILLHUB_LIVE_OK`); a separate private/self-hosted registry run is optional.
- `MonitorMcpTask`: the legacy MCP-task backend remains unavailable. The enabled `Monitor` tool uses the verified local-shell task path instead and never creates `monitor_mcp` state.
- Workflow scheduling: reverse-declared dependency chains can leave skipped work pending, and skip→retry can accept a late result from the aborted runner. The live Workflow sentinel does not exercise these orderings.
- HISTORY_SNIP integration: the real query projects away all `snip_marker` messages before calling `snipCompactIfNeeded`, so direct marker tests and `/force-snip` do not prove the model Snip path works.
- Local skill cache lifecycle: a failed older load can delete a newer cwd Promise during cleanup, and a write pivot with no attachment can trigger repeatedly.
- SkillHub integration: canonical metadata uses process-global state, and `skillPath=destination` is later passed through `dirname()`, producing the wrong base directory for skill loading, permissions and telemetry. `SKILLHUB_LIVE_OK` does not cover this integration path.
- Browser error propagation: WebBrowser drops MCP `result.isError`; local navigation/snapshot success does not prove backend errors are surfaced.
- Live-validation settings loading: `live-model-validation.ts` checks `process.env` before any `settings.env` application; a settings-provided Bearer must already be injected by the caller, and the standalone script does not itself load `~/.claude/settings.json`.
- ReviewArtifact permission input: on automatic-allow paths, FileRead permission delegation returns `updatedInput` in FileRead's shape and loses `artifact_path`, `focus`, and `context`. A persistent ReviewArtifact allow without a path can also cover later unrelated reads outside the working directory. Direct tool tests do not cover these paths.
- Context-collapse staging: normal `startSpawn` calls `commitStaged` without first adding the new summary to `collapseStore.staged`; restored snapshots can be drained, but a same-run prompt-too-long response has no newly generated staged summary to drain. The default summarizer also supplies the archive through both prompt and fork context, duplicating it, and reset-during-persistence still needs regression coverage. The live model sentinel does not close these gaps.
- Native Computer Use desktop control: open MCP metadata and permission checks pass, but a real authorized desktop session is still required.
- Live validation gaps: Cloud/remote-control and native desktop round trips still need authorized environments; model and public SkillHub checks have passed, and changed-file, cron, and LSP deterministic lifecycle tests pass.

## Next implementation order

1. Fix reverse-order skip propagation and skip→retry runner fencing in Workflow, with adversarial DAG-order regressions.
2. Make model-emitted snip markers survive projection until execution, then add a real query-path regression.
3. Preserve ReviewArtifact's input fields and path scope through permission delegation, with executor-level allow/ask/persistent-allow tests.
4. Close normal-spawn context staging, remove duplicate archive input, and cover reset-during-persistence recovery.
5. Repair canonical skillPath/base-directory handling, local cache ownership, and WebBrowser `isError` propagation with integration regressions.
6. Make standalone live-validation settings loading explicit, or require caller-injected credentials and test the four authentication matrix branches.
7. Run Cloud Files, Remote Control, and env-less perpetual round trips in an authorized Claude OAuth environment.
8. Run native Computer Use control in an authorized interactive desktop/VM.
9. Optionally run a private self-hosted SkillHub registry round trip.

Every implementation must add or update its verification evidence here. Build success alone does not promote a feature to **Verified**.
