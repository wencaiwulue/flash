# Architecture

## Overview

This project provides two independently buildable products:

- **CLI**: an interactive and headless agent terminal application.
- **Agent SDK**: an embeddable TypeScript API for queries, tools, sessions, and scheduled tasks.

The external build uses `USER_TYPE=external` and `features: []`. Internal or experimental modules are either excluded by dead-code elimination or represented by explicit disabled boundaries. A disabled boundary is not evidence that the corresponding feature is implemented.

## Entrypoints and build

| Artifact | Source entrypoint | Purpose |
|---|---|---|
| `dist/main.js` | `src/entrypoints/cli.tsx` | CLI bootstrap, version/help fast paths, interactive and headless execution |
| `dist/sdk.mjs` | `src/entrypoints/agentSdkTypes.ts` | Public Agent SDK API |
| `dist/types/entrypoints/agentSdkTypes.d.ts` | TypeScript declaration emit | SDK consumer types |

`scripts/build.ts` injects `MACRO.*` values and creates both JavaScript artifacts. `scripts/generate-sdk-types.ts` derives serializable SDK types from the current Zod schemas in `src/entrypoints/sdk/` before every build. `bun run build:types` emits declarations.

`src/runtimeMacros.ts` supplies compatible defaults during direct source execution and tests, so source imports do not require a prior bundle.

## Query and state flow

1. CLI or SDK initializes configuration, permissions, tools, MCP connections, and `AppState`.
2. `src/QueryEngine.ts` owns conversation state, prompt processing, system initialization, and turn lifecycle.
3. `src/query.ts` performs model streaming and tool orchestration.
4. `src/tools.ts` supplies built-in tools. `src/services/mcp/client.ts` discovers MCP tools at runtime and `assembleToolPool()` merges them with built-ins.
5. `src/utils/permissions/permissions.ts` and the tool permission context decide whether a call is allowed, denied, or requires confirmation.
6. SDK messages are yielded to the caller. Transcript and session state are persisted without terminating the host process.

`AppState` is the shared state container for model selection, permissions, MCP clients/tools, tasks, plugins, file history, and UI state. The SDK wraps this machinery in `src/utils/sdkQuery.ts`; it does not spawn the interactive Ink UI.

For the concrete entry signatures, state ownership, persistence ordering, recovery branches, cleanup semantics, and design trade-offs behind this flow, read [Query Core 对话与工具执行设计](superpowers/specs/2026-11-12-query-core-design.md).

## SDK composition

- `src/utils/sdkQuery.ts`: async query input/output, permissions, MCP lifecycle, model controls, and resource cleanup.
- `src/utils/sdkSessionConversation.ts`: V2 multi-turn sessions. Per-turn streams end at result messages while the underlying query remains alive for later turns.
- `src/utils/sdkSessions.ts`: portable JSONL session listing, reading, metadata updates, and forking with fresh UUID chains.
- `src/utils/cronScheduler.ts`: file-backed scheduler and locking. `src/utils/cronNotification.ts` formats missed tasks safely.
- `src/entrypoints/sdk/coreSchemas.ts` and `controlSchemas.ts`: source of truth for generated SDK types.

In-process MCP uses `InMemoryTransport` so custom tools registered by `tool()` and `createSdkMcpServer()` run in the same process as the SDK caller. Process-based MCP servers use the normal MCP connection manager.

## Security and persistence

`src/utils/secureStorage/` abstracts credential storage. macOS uses Keychain with plaintext fallback; other platforms currently depend on the fallback implementation. Secret-bearing JSON must never be logged or placed in command-line arguments.

Session files live below the configured Claude home's `projects/` directory. Portable session code avoids CLI global session state where possible, allowing SDK consumers to use isolated configuration directories.

## Feature boundaries

`USER_TYPE === 'ant'` and `feature(...)` guard internal functionality, including KAIROS/proactive workflows, internal compaction, browser/computer use, coordinator workflows, and remote daemon modes. The external build does not advertise these as stable capabilities.

Disabled modules may return `false`, an empty collection, or an explicit unavailable error. They are intentionally different from completed implementations. Verification status belongs in `docs/STATUS.md`; release history belongs in `docs/RELEASE.md`.

## Subsystem design specifications

The retrospective subsystem designs, review status, and primary file ownership index are maintained in [Subsystem design specs](architecture/INDEX.md). This page remains the product-level summary; subsystem prose lives in the linked specs rather than being duplicated here.
