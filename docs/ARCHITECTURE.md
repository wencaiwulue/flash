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

## Context 与 Memory 生命周期总览

本节提供 Context（对话上下文）与 Memory（记忆系统）的产品级架构总览，详细设计请参考各子系统 spec。

### Context 生命周期：Prompt → Token → Compaction → PTL → Boundary → QueryEngine → Session Restore

Context 系统负责管理发送给模型的对话历史，在 Token 限制和用户体验之间取得平衡。

1. **请求前：Micro-Compaction**
   - 每轮请求发送前，先执行 `microCompactMessages()`
   - 有两条路径：time-based（优先）和 cached
   - Time-based：当距上次 micro-compact 超过阈值时，清理旧工具结果
   - Cached：当 prompt caching 启用且模型支持时，保留缓存前缀
   - 证据：`src/services/compact/microCompact.ts:1-535`

2. **请求中：Context Collapse**
   - 每轮 query 开始时调用 `applyCollapsesIfNeeded()`
   - 计算 Token 占比：ratio = 当前 Token / 有效上下文窗口
   - ratio < 0.9：直接返回，应用已 commit 的 collapse
   - 0.9 ≤ ratio < 0.95 且无 active spawn：启动异步 summarization
   - ratio ≥ 0.95：等待异步 summarization 完成
   - 证据：`src/services/contextCollapse/index.ts:1-346`

3. **PTL 触发：Reactive Compact**
   - 当模型返回 "Prompt too long"（PTL）错误时触发
   - 先执行 `stripImagesFromMessages()` 移除图片
   - 再调用 `compactConversation()` 执行完整压缩
   - 单次尝试，失败后映射错误原因
   - 证据：`src/services/compact/reactiveCompact.ts:1-188`

4. **Compact Boundary：QueryEngine 裁剪**
   - 当遇到 compact boundary 消息时，QueryEngine 裁剪 mutableMessages 数组
   - 仅保留 boundary 之后的内容
   - Preserved segment UUID 链保持完整
   - 会话恢复时从 storage 重建
   - 证据：[batch-1.md 证据链](status/design-docs-completeness-audit/batch-1.md#证据链请求前--请求中--ptl--boundary--queryengine--session-restore)

5. **会话恢复：Session Restore**
   - 从 storage 加载 commits 和 snapshot
   - 重建 collapseStore（committed、staged、generation、armed、lastSpawnTokens）
   - `projectView()` 应用已 commit 的 collapse 到当前消息
   - 证据：`src/services/contextCollapse/store.ts:1-90`

### Memory 加载与失效：Auto → Team → Session → CLAUDE.md → Daily Log

Memory 系统负责从多个来源加载和组织上下文信息。

1. **来源优先级**
   - Auto-memory：自动提取的会话摘要
   - Team memory：团队共享记忆（仅内部用户）
   - Session memory：当前会话恢复
   - CLAUDE.md：项目根目录的项目文档
   - Daily log：用户日记（如有）

2. **加载时机**
   - `initSessionMemory()`：在 setup() 阶段加载（非 bare 模式）
   - `loadConversationForResume()`：当使用 --resume 时
   - 动态：技能执行过程中按需加载

3. **失效与整理**
   - Auto-memory 阈值可配置：`/autocompact <tokens>`
   - Session persistence 可禁用：`--no-session-persistence`
   - 证据：[memory spec](superpowers/specs/2026-11-12-memory-design.md)

### 跨子系统边界与主责 Spec

| 层次 | 主责子系统 | Spec | Coverage |
|------|-----------|------|----------|
| Context Compaction | context-compaction | [context-compaction spec](superpowers/specs/2026-11-12-context-compaction-design.md) | [coverage](architecture/coverage/context-compaction.yaml) |
| Query Engine | query-core | [query-core spec](superpowers/specs/2026-11-12-query-core-design.md) | [coverage](architecture/coverage/query-core.yaml) |
| Session Persistence | session-persistence | [session-persistence spec](superpowers/specs/2026-11-12-session-persistence-design.md) | [coverage](architecture/coverage/session-persistence.yaml) |
| Memory System | memory | [memory spec](superpowers/specs/2026-11-12-memory-design.md) | [coverage](architecture/coverage/memory.yaml) |
