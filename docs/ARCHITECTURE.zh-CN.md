# 架构

## 总览

本项目提供两个可独立构建的产品：

- **CLI**：交互式和无外设的 agent 终端应用
- **Agent SDK**：可嵌入的 TypeScript API，用于查询、工具、会话和定时任务

外部构建使用 `USER_TYPE=external` 和空的 `features`。内部或实验性模块要么通过死代码消除（DCE）排除，要么通过显式禁用边界表示。禁用边界并不代表相应功能已实现。

## 入口点与构建

| 产物 | 源入口点 | 用途 |
|---|---|---|
| `dist/main.js` | `src/entrypoints/cli.tsx` | CLI 引导、版本/帮助快速路径、交互式和无外设执行 |
| `dist/sdk.mjs` | `src/entrypoints/agentSdkTypes.ts` | 公开的 Agent SDK API |
| `dist/types/entrypoints/agentSdkTypes.d.ts` | TypeScript 声明生成 | SDK 消费者类型 |

`scripts/build.ts` 注入 `MACRO.*` 值并创建两个 JavaScript 产物。每次构建前，`scripts/generate-sdk-types.ts` 从 `src/entrypoints/sdk/` 中的当前 Zod 模式派生可序列化的 SDK 类型。`bun run build:types` 生成声明。

`src/runtimeMacros.ts` 在直接源码执行和测试期间提供兼容的默认值，因此源码导入不需要预先构建的 bundle。

## 查询与状态流程

1. CLI 或 SDK 初始化配置、权限、工具、MCP 连接和 `AppState`
2. `src/QueryEngine.ts` 拥有对话状态、提示处理、系统初始化和轮次生命周期
3. `src/query.ts` 执行模型流式传输和工具编排
4. `src/tools.ts` 提供内置工具。`src/services/mcp/client.ts` 在运行时发现 MCP 工具，`assembleToolPool()` 将它们与内置工具合并
5. `src/utils/permissions/permissions.ts` 和工具权限上下文决定调用是允许、拒绝还是需要确认
6. SDK 消息被产出给调用者。记录和会话状态被持久化，不终止宿主进程

`AppState` 是模型选择、权限、MCP 客户端/工具、任务、插件、文件历史和 UI 状态的共享状态容器。SDK 在 `src/utils/sdkQuery.ts` 中包装这些机制；它不会启动交互式 Ink UI。

关于此流程背后的具体入口签名、状态所有权、持久化顺序、恢复分支、清理语义和设计权衡，请参阅 [Query Core 对话与工具执行设计](superpowers/specs/2026-11-12-query-core-design.md)。

## SDK 组合

- `src/utils/sdkQuery.ts`：异步查询输入/输出、权限、MCP 生命周期、模型控制和资源清理
- `src/utils/sdkSessionConversation.ts`：V2 多轮会话。每轮流在结果消息处结束，而底层查询保持活跃供后续轮次使用
- `src/utils/sdkSessions.ts`：可移植的 JSONL 会话列表、读取、元数据更新和使用新 UUID 链分叉
- `src/utils/cronScheduler.ts`：文件支持的调度器和锁定。`src/utils/cronNotification.ts` 安全地格式化错过的任务
- `src/entrypoints/sdk/coreSchemas.ts` 和 `controlSchemas.ts`：生成的 SDK 类型的真实来源

进程内 MCP 使用 `InMemoryTransport`，因此通过 `tool()` 和 `createSdkMcpServer()` 注册的自定义工具与 SDK 调用者在同一进程中运行。基于进程的 MCP 服务器使用正常的 MCP 连接管理器。

## 安全性与持久化

`src/utils/secureStorage/` 抽象凭证存储。macOS 使用带有纯文本回退的 Keychain；其他平台当前依赖回退实现。携带机密的 JSON 绝不应被记录或放在命令行参数中。

会话文件位于配置的 Claude 主目录的 `projects/` 目录下。可移植会话代码尽可能避免 CLI 全局会话状态，允许 SDK 消费者使用隔离的配置目录。

## 功能边界

`USER_TYPE === 'ant'` 和 `feature(...)` 保护内部功能，包括 KAIROS/主动工作流、内部压缩、浏览器/计算机使用、协调器工作流和远程守护进程模式。外部构建不会将这些宣传为稳定功能。

禁用的模块可能返回 `false`、空集合或显式不可用错误。它们有意与完成的实现不同。验证状态属于 `docs/STATUS.md`；发布历史属于 `docs/RELEASE.md`。

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

## 子系统设计规格

回顾性子系统设计、审查状态和主要文件所有权索引在 [子系统设计规格](architecture/INDEX.md) 中维护。本页面保持产品级总览；子系统详细说明存在于链接的 spec 中，而非在此重复。
