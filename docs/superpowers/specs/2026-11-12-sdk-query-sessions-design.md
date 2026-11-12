---
title: SDK Query、Session、控制面与 Checkpoint 设计
date: 2026-11-12
status: approved
---

# SDK Query、Session、控制面与 Checkpoint 设计

## 1. 问题与为什么需要统一生命周期

SDK 调用方需要的不只是发送一个 prompt。可靠的查询还包括异步输入输出、权限与控制请求、会话恢复、上下文读取、任务停止，以及按消息恢复文件状态。若这些能力各自维护状态，模型消息、持久化消息和文件快照会失去同一 UUID 的对应关系，取消和恢复也无法形成一致的生命周期。

本功能将这些接口放在同一设计中，是因为它们共享三条约束：

- **消息身份**：query、session transcript 和 checkpoint 都以 user message UUID 关联。
- **生命周期一致性**：创建、流式输出、控制、停止、恢复和 rewind 必须经过同一 query/session 状态。
- **恢复语义分离但配套**：session 恢复对话，checkpoint 恢复该消息对应的文件状态；两者需要协调，但不能合并成一次不透明的全量恢复。

### 目标

- 提供可结束、可中断、可恢复的异步 query 生命周期。
- 复用同一消息转换与持久化规则，避免 CLI 与 SDK 行为漂移。
- 让控制方法直接操作现有生产状态，不引入影子状态。
- 按消息精确关联文件快照和 rewind，同时提供无副作用 dry run。

### 非目标

- 不重新实现模型传输协议，不把 remote-control 当作 query 默认实现。
- 不把 CLI UI 状态复制到 SDK，不把 session 恢复等同于文件系统回滚。
- 不用全局 checkpoint 配置共享不同 query 的快照。

## 2. 为什么采用这些接口边界

| 模块 | 设计职责 | 为什么必须独立 |
|---|---|---|
| `createSdkQuery()` | 创建异步 query，串联消息 channel、控制请求、权限和清理 | 避免调用方自行拼接异步生成器与控制协议，保证取消/中断也能完成清理 |
| `createSdkSession()` / `resumeSdkSession()` | 创建或恢复多轮会话 | 避免把多轮对话误当成一次性 prompt；复用 transcript 才能保持上下文 |
| `sdkSessions.ts` | 读取、列出、重命名、标记、fork JSONL session | 封装持久化格式和 parentUuid 链，避免 SDK 与 CLI 各自解释文件 |
| `sessionChainRecovery.ts` | 恢复并行 assistant sibling 与 tool results | 单 parent 遍历会漏掉并行分支；纯函数让 CLI 与 SDK 共享 DAG 规则 |
| `sdkControl.ts` | context usage、flag/settings、stopTask、reloadPlugins | 将控制操作映射到现有生产状态，避免复制状态推导逻辑 |
| `FileCheckpointing` | 按 userMessageId 注册、等待并恢复文件快照 | 解决消息已到达但快照未完成的问题，不能用全量恢复替代精确 rewind |

这些边界让查询生命周期、持久化格式、控制面和文件恢复可以独立测试和替换。DAG recovery 不读取 analytics 或 CLI AppState，控制接口只组合现有状态函数，checkpoint 不依赖远程协议。

`createSdkSession()` 与 `resumeSdkSession()` 不是另一套查询实现：它们复用 query 和消息转换，避免 CLI 与 SDK 的模型行为漂移。

## 3. 生命周期与数据流

```text
用户消息 UUID
   → 注册 snapshot Promise
   → query 处理消息与工具调用
   → session JSONL 记录 parentUuid
   → 控制请求 / 状态更新
   → 恢复 session
   → 按 UUID 等待 snapshot 后 rewind 文件
```

### 3.1 Query 与消息 channel

`createSdkQuery()` 负责异步消息输入、模型输出、控制请求、权限与清理。调用方通过 async iterable 接收消息，而不是自己管理控制帧。interrupt、abort、return 和底层 transport teardown 必须沿同一生命周期传播，避免只停止模型生成却遗留 watcher、任务或文件句柄。

### 3.2 Session 与并行 DAG

`createSdkSession()` 创建多轮会话，`resumeSdkSession()` 从既有 transcript 恢复。JSONL 读取、列出、重命名、标记和 fork 由 session 工具统一处理，避免 CLI 和 SDK 对文件格式做不同解释。

单 parent 反向遍历只能恢复一条分支。`recoverOrphanedParallelToolResults()` 以 API message id 聚合 assistant sibling，以 parentUuid 聚合 tool_result，再将未见过的分支插回该 group 最后的主链 anchor 后。这样 CLI resume 与 SDK reads 使用相同 DAG，且不共享 CLI 状态。

### 3.3 控制面

`getSdkContextUsage()` 复用 `collectContextData()`，不另算 token。`applySdkFlagSettings()` 合并 flag settings，删除 null 键并通知 change detector；model 变化额外更新 override 与 session metadata。`getSdkSettings()` 返回 settings sources 与当前 model/effort。`stopSdkTask()` 调用现有 stopTask。`reloadSdkPlugins()` 先刷新插件，再并行读取 commands 和 cache-only plugin state，返回 commands、agents、plugins、mcpServers 和 error_count。

选择复用生产状态函数，是为了让 SDK 控制结果与 CLI 实际行为一致，而不是让 SDK 另建一套“看起来正确”的状态。

### 3.4 Checkpoint 与 rewind

`makeSnapshot(messageId)` 在启动异步工作前将 Promise 放入 pending map；同一 UUID 复用该 Promise。`rewindFiles()` 先等待对应 snapshot，再调用共享 `rewindFileCheckpoint()`：

- checkpointing 未启用 → 返回 disabled；
- 目标 checkpoint 不存在 → 返回 not found；
- snapshot 创建失败 → 返回创建错误；
- dry run → 只返回 diff stats；
- 正式恢复 → 调用 fileHistoryRewind 并捕获错误。

先注册 Promise 是为了等待“该消息对应的 snapshot”，不是等待任意文件写入。dry run 与正式恢复分离，是为了先审查范围再产生副作用。checkpoint 按 query 实例隔离，是为了避免不同 query 相互覆盖快照。

## 4. 为什么按这个顺序实施

1. **先固定 UUID、query 输入输出和清理**：后续 session 与 checkpoint 都依赖消息身份和可结束生命周期。
2. **再实现 JSONL 与 DAG 恢复**：先保证对话历史完整，再决定文件回滚点。
3. **再接入控制方法**：通过现有生产状态避免重复实现，减少接口之间不一致。
4. **最后用 snapshot Promise 关联文件恢复**：验证消息与快照的对应关系，再实现 dry run 和失败分支。

这个顺序让每一步都有独立可验证产物，避免先做一个全量 rewind 再反推其消息和状态含义。

## 5. 失败语义

| 失败 | 处理 |
|---|---|
| Query interrupt/abort/return | 沿 query 生命周期停止并清理 transport、任务和 watcher |
| 并行 transcript 分支缺失 | 用共享 DAG helper 恢复，不能简单丢弃 |
| 控制请求涉及 model 变化 | 更新 override、change detector 和 session metadata，不只改一个变量 |
| Snapshot 创建失败 | 返回 checkpoint 创建错误，不使用旧文件状态冒充可恢复 |
| 无 checkpoint 或功能关闭 | 返回明确 canRewind=false，不写文件 |
| dry run | 只返回统计，不执行恢复 |
| 正式恢复异常 | 返回带 error 的 canRewind=false，不把部分恢复当成成功 |

## 6. 验收设计与测试理由

- **Query 生命周期**：验证异步输入、流式输出、interrupt、abort 和清理顺序，避免“返回消息即成功”的假验收。
- **Session 恢复与 fork**：验证 parentUuid、并行 sibling、tool result、分页和 fork UUID 重写，确保恢复完整且不重复。
- **控制面**：验证 flag 合并/null 删除、model metadata、context usage、stopTask、plugin reload 返回值均来自生产实现。
- **Checkpoint**：验证同 UUID snapshot 只创建一次、rewind 等待对应 Promise、dry run 不写文件，以及缺 checkpoint、snapshot 失败和恢复失败的错误。
- **隔离性**：DAG recovery 不读 CLI analytics/AppState，控制测试不启动真实模型，checkpoint 不依赖远程文件服务。

这些测试分别证明异步行为可结束、历史可恢复、状态不重复、文件可回滚且作用域不串扰。最后执行全量测试、typecheck 和 build，确认 CLI 与 SDK 的共同交付没有被破坏。
