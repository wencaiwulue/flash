# Implementation Status

Last updated: 2026-11-10.

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
| `bun test` | 152 tests, 645 assertions passed |
| `live-validation` workflow | Model, SkillHub, and Cloud jobs passed; desktop correctly skipped without a self-hosted runner |
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
| Local skill search | Verified (offline index/build) | Fuse metadata ranking, natural-language fallback, visible-skill filtering, turn-zero/write-pivot/subagent prefetch, cache invalidation, and `DiscoverSkills` are enabled |
| Remote canonical skills via SkillHub | Verified (live public registry) | Public REST search/resolve/download, canonical state, mixed prefetch, versioned cache, zip path/symlink protection, and real telemetry tested; `SKILLHUB_LIVE_OK` |
| UDS inbox and peers | Verified (real local socket) | 0600 socket permissions, plain-text enqueue/wakeup, path and session-ID routing, live peer handshake, stale registry cleanup, and teardown tested; `ListPeers` and `/peers` registered |
| Daemon supervisor and worker registry | Verified (offline lifecycle) | Bounded exponential restarts, clean stop, stale PID cleanup, worker dispatch, and `daemon status` smoke tested |
| Remote Control server | Verified (offline lifecycle/build) | Shared SDK query, enable/disable, input close, idempotent start/stop, and `/remote-control-server` registration tested; no live Cloud session claimed |
| Workflow definitions and execution | Verified (offline runner/task) | Strict schema/dependency validation, project discovery, bounded DAG concurrency, interpolation, failure propagation, skip/retry/kill, output persistence, task UI state, `/workflows`, and `Workflow` build registration tested; real model agents not run |
| HISTORY_SNIP | Verified (offline/build) | Marker execution, protected-tail/tool-pair safety, tokensFreed, nudge reset, REPL projection, SDK replay contract, SnipTool, and `/force-snip` tested |
| ReviewArtifact and `/hunter` | Verified (offline reviewer/build) | Input/size validation, independent read-only reviewer, structured findings, unverified status, FileRead permission delegation, and bundled skill registration tested |
| Reactive compaction | Verified (offline compactor/hooks) | PTL/media withholding, media stripping, shared compactor retry, PreCompact deduplication, failure mapping, and success cleanup tested; live API recovery not run |
| Context collapse and CtxInspect | Verified (offline summarizer/persistence) | 90% background spawn, 95% blocking spawn, idempotent UUID projection, tool-pair boundaries, empty-summary health, commit/snapshot restore, staged overflow recovery, subscriptions, and compiled CtxInspect tested; live model/413 not run |
| Core query and tool orchestration | Verified | Real model + Read round trip passed |
| SDK query, async messages, abort | Verified | Source and packaged SDK queries passed |
| In-process MCP tools | Verified | Tool metadata, invocation, and model round trip passed |
| SDK session list/read/rename/tag/fork | Verified | Offline JSONL tests passed; fresh fork UUID chains and parallel assistant/tool-result DAG recovery before both SDK read paths and pagination checked |
| V2 create/resume/prompt | Verified | Multi-turn and history recall passed |
| Scheduled tasks | Verified | One-shot dedup, recurring reschedule, aging, lock takeover, and missed/abort tests passed |
| LSP lifecycle | Verified | Real JSON-RPC initialize, crash restart, maxRestarts, shutdown timeout, and stop cleanup passed |
| Changed-file partial reads | Verified | Real offset/limit rereads, boundary changes, full reads, and deletion eviction passed |
| Non-REPL prompt/agent stop hooks | Verified (offline and E2E) | Prompt/agent allow, block, failure, cancellation, and real headless Stop feedback verified |
| SDK rewind | Verified (offline) | Per-query snapshots, dry-run, actual restore, async snapshot waits, invalid IDs, and concurrent persistence isolation tested |
| SDK `getContextUsage`, `reloadPlugins`, `stopTask`, `applyFlagSettings`, `getSettings` | Verified (offline) | Control methods use shared CLI implementations and have an empty-input regression test |
| `connectRemoteControl` | Verified (offline transport) | Env-less bridge handle, FIFO queues, permission pairing, control responses, and teardown verified with fake transport; real remote round trip not yet run |
| Linux libsecret | Verified (offline) | `secret-tool` lookup/store/clear with fallback, migration, and mocked failure tests |
| npm marketplace source | Verified (offline) | Fresh npm staging, scoped packages, schema validation, refresh, cache cleanup, and lifecycle-script suppression tested with a mock runner |
| Cloud file persistence | Verified (offline) | Files API maps normalized output paths to file IDs; ambiguity, pagination, delay, partial failure, and abort tests passed; no xattr attribute guessed |
| ultraplan OAuth refresh | Verified (mocked) | Refresh runs before every remote poll; `/ultraplan` is externally registered with Claude AI availability checks |
| env-less perpetual bridge | Verified (offline isolated process) | Reuses cse_* and SSE cursor, skips create on resume, rebuilds after 401, preserves temporary teardown, and clears pointer only on explicit archive; live OAuth round trip not yet run |
| Live model Workflow | Verified | Settings-based auth returned `WORKFLOW_LIVE_OK` |
| Live proactive Sleep | Verified | Settings-based auth returned `PROACTIVE_LIVE_OK` |
| Live context-collapse and reactive compaction | Verified | Settings-based auth returned `CONTEXT_COLLAPSE_LIVE_OK` and `REACTIVE_COMPACTION_LIVE_OK` |
| Buddy and Fork Subagent | Verified (offline/build) | Deterministic bones, model soul persistence, reaction, mute command, fork cache placeholders, recursive guard, worktree notice, and `/fork` prompt tested |
| Open KAIROS adapters | Verified (offline/build) | Assistant gate/team/session discovery, isolated team initialization, install wizard, SendUserFile, OS/webhook notifications, GitHub PR subscriptions, and dream registration tested |
| Computer Use via Zavora MCP | Verified (metadata/permissions) | Real tool schemas and denied-action protection passed; native desktop control requires a separately authorized desktop session |
| Browser via Playwright MCP | Verified (real isolated browser) | Real tool metadata, local-page navigation, snapshot, and close passed with isolated browser profile |
| iTerm hide/show/rebalance | Platform limitation | Not treated as a core implementation gap |

## Remaining implementation boundaries

- Self-hosted SkillHub registry: the public registry round trip passes (`SKILLHUB_LIVE_OK`); a separate private/self-hosted registry run is optional.
- `MonitorMcpTask`: the legacy MCP-task backend remains unavailable. The enabled `Monitor` tool uses the verified local-shell task path instead and never creates `monitor_mcp` state.
- Native Computer Use desktop control: open MCP metadata and permission checks pass, but a real authorized desktop session is still required.
- Live validation gaps: model/Cloud/remote-control and native desktop round trips still need authorized environments; changed-file, cron, and LSP deterministic lifecycle tests now pass.

## Next implementation order

1. Run Cloud Files, Remote Control, and env-less perpetual round trips in an authorized Claude OAuth environment.
2. Run native Computer Use control in an authorized interactive desktop/VM.
3. Optionally run a private self-hosted SkillHub registry round trip.

Every implementation must add or update its verification evidence here. Build success alone does not promote a feature to **Verified**.
