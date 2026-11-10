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
| `bun test` | 7 tests, 38 assertions passed |
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
| Built-in tool pool | Verified | 23 built-in tools loaded with no null entries in the smoke check |
| Core query and tool orchestration | Verified | Real model + Read round trip passed |
| SDK query, async messages, abort | Verified | Source and packaged SDK queries passed |
| In-process MCP tools | Verified | Tool metadata, invocation, and model round trip passed |
| SDK session list/read/rename/tag/fork | Verified | Offline JSONL tests passed; fresh fork UUID chains checked |
| V2 create/resume/prompt | Verified | Multi-turn and history recall passed |
| Scheduled tasks | Verified | Missed-event and abort tests passed |
| LSP lifecycle configuration | Verified | `restartOnCrash` and `shutdownTimeout` configuration test passed |
| Changed-file partial reads | Implemented, unverified | `offset/limit` is forwarded to `FileReadTool`; add a dedicated regression test |
| Non-REPL prompt/agent stop hooks | Not implemented | `src/utils/hooks.ts` still has the non-REPL TODO |
| SDK rewind | Not implemented | `src/utils/sdkQuery.ts` currently reports that checkpointing is unavailable |
| SDK `getContextUsage`, `reloadPlugins`, `stopTask`, `applyFlagSettings`, `getSettings` | Not implemented | These methods currently report unsupported |
| `connectRemoteControl` | Blocked on protocol | Requires matching daemon/bridge lifecycle and duplex protocol; API currently rejects |
| Linux libsecret | Not implemented | Linux currently uses plaintext storage; implement `secret-tool` with fallback |
| npm marketplace source | Not implemented | `src/utils/plugins/marketplaceManager.ts` still throws |
| Cloud xattr file IDs | Blocked on protocol | Attribute name, encoding, output root, and error behavior must be confirmed |
| ultraplan OAuth refresh | Not implemented | Add refresh before repeated polling; preserve existing internal gate |
| env-less perpetual bridge | Blocked on protocol | Requires internal bridge-pointer and JWT lifecycle |
| Internal KAIROS/proactive/workflow/computer-use features | Explicitly disabled | No internal flags are enabled in the external build |
| iTerm hide/show/rebalance | Platform limitation | Not treated as a core implementation gap |

## Next implementation order

1. Linux libsecret with isolated runner tests.
2. npm marketplace loading and refresh with mocked npm execution.
3. ultraplan refresh, SDK rewind, headless hooks, and SDK control methods.
4. Cloud xattr after confirming its protocol.
5. `connectRemoteControl` after recovering the daemon/bridge contract.
6. env-less perpetual bridge after the remote-control contract is available.

Every implementation must add or update its verification evidence here. Build success alone does not promote a feature to **Verified**.
