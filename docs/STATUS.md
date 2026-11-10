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
| `bun test` | 64 tests, 261 assertions passed |
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
| Built-in tool pool | Verified | External feature-profile build loaded 27 tools with no null entries, including Cron and RemoteTrigger |
| External feature profile | Verified | `AGENT_TRIGGERS`, `AGENT_TRIGGERS_REMOTE`, `VOICE_MODE`, `BRIDGE_MODE`, `ULTRAPLAN`, `FILE_PERSISTENCE`, and `KAIROS_BRIEF` are compiled in; `ultraplan`, `voice`, and `brief` are registered |
| Core query and tool orchestration | Verified | Real model + Read round trip passed |
| SDK query, async messages, abort | Verified | Source and packaged SDK queries passed |
| In-process MCP tools | Verified | Tool metadata, invocation, and model round trip passed |
| SDK session list/read/rename/tag/fork | Verified | Offline JSONL tests passed; fresh fork UUID chains and parallel assistant/tool-result DAG recovery before both SDK read paths and pagination checked |
| V2 create/resume/prompt | Verified | Multi-turn and history recall passed |
| Scheduled tasks | Verified | Missed-event and abort tests passed |
| LSP lifecycle configuration | Verified | `restartOnCrash` and `shutdownTimeout` configuration test passed |
| Changed-file partial reads | Implemented, unverified | `offset/limit` is forwarded to `FileReadTool`; add a dedicated regression test |
| Non-REPL prompt/agent stop hooks | Verified (offline and E2E) | Prompt/agent allow, block, failure, cancellation, and real headless Stop feedback verified |
| SDK rewind | Verified (offline) | Per-query snapshots, dry-run, actual restore, async snapshot waits, invalid IDs, and concurrent persistence isolation tested |
| SDK `getContextUsage`, `reloadPlugins`, `stopTask`, `applyFlagSettings`, `getSettings` | Verified (offline) | Control methods use shared CLI implementations and have an empty-input regression test |
| `connectRemoteControl` | Verified (offline transport) | Env-less bridge handle, FIFO queues, permission pairing, control responses, and teardown verified with fake transport; real remote round trip not yet run |
| Linux libsecret | Verified (offline) | `secret-tool` lookup/store/clear with fallback, migration, and mocked failure tests |
| npm marketplace source | Verified (offline) | Fresh npm staging, scoped packages, schema validation, refresh, cache cleanup, and lifecycle-script suppression tested with a mock runner |
| Cloud file persistence | Verified (offline) | Files API maps normalized output paths to file IDs; ambiguity, pagination, delay, partial failure, and abort tests passed; no xattr attribute guessed |
| ultraplan OAuth refresh | Verified (mocked) | Refresh runs before every remote poll; `/ultraplan` is externally registered with Claude AI availability checks |
| env-based perpetual bridge | Verified (offline) | Env-less + perpetual intentionally falls back to env-based pointer/reconnect; teardown preserves pointer. Pure env-less perpetual remains a separate protocol task |
| Full KAIROS/proactive/workflow/computer-use features | Explicitly disabled or stub-only | `KAIROS_BRIEF` is enabled independently; the remaining internal systems require implementation before their flags are enabled |
| iTerm hide/show/rebalance | Platform limitation | Not treated as a core implementation gap |

## Next implementation order

1. Implement the remaining simple tool stubs, then proactive state and Coordinator worker definitions before enabling their flags.
2. Split workflow, UDS inbox, daemon, context-collapse, and local skill-search work into separately verified implementations.
3. Run real Cloud API and remote bridge round trips in an authorized environment.
4. Pure env-less perpetual bridge only if the product explicitly requires eliminating the Environments API; existing perpetual continuity is already provided by env-based bridge.

Every implementation must add or update its verification evidence here. Build success alone does not promote a feature to **Verified**.
