---
id: agent-swarms
batch: 5
title: Agent Swarms 子代理、团队与协调执行设计
date: 2026-11-12
status: draft
---

# Agent Swarms 子代理、团队与协调执行

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用“负责管理”“提高可靠性”“保证一致性”等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

当用户需要并行执行多个复杂任务、在多个代理间协调工作、或者隔离不同代理的执行环境时，单代理串行执行会导致任务吞吐低、资源隔离弱、交互体验差。如果直接让代理间共享内存状态，会产生竞态条件和权限泄漏；如果完全独立运行多个进程，又会导致通信成本高、状态同步复杂。因此本子系统必须在单进程多协程或多进程模型下，实现代理间的消息传递、权限同步、生命周期管理，同时保持用户交互的一致性。

约束：
- Feature flag 控制：`isAgentSwarmsEnabled()` 控制是否启用团队功能，`feature('COORDINATOR_MODE')` 控制协调器模式，`feature('FORK_SUBAGENT')` 控制隐式子代理
- 兼容现有单代理执行路径，不能破坏已有功能
- 支持三种后端：in-process（同进程）、tmux（多终端）、iTerm2（多面板）
- 权限模型需要与现有 permission system 集成，worker 不能越权
- 消息持久化基于文件系统（mailbox），需要处理并发读写和锁
- 团队状态持久化到 `~/.claude/teams/{teamName}/` 目录

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 基于文件系统的 mailbox 消息传递 | 每个 agent 有独立 inbox 文件，通过 lockfile 保证原子读写，消息包含 from/text/timestamp/read/color/summary 字段 | 跨进程（tmux/iTerm2）和同进程（in-process）统一通信模型，不依赖内存共享，支持恢复 | 内存队列：无法跨进程；gRPC：实现复杂，本地场景过度设计；环境变量：单向且容量有限 | 文件 I/O 开销，需要处理锁竞争和 ENOENT | `src/utils/teammateMailbox.ts:43-91` |
| 团队状态持久化到 config.json | TeamFile 包含 name/description/leadAgentId/members 等，members 记录 agentId/name/agentType/model/tmuxPaneId/cwd/worktreePath/subscriptions/backendType/isActive/mode | 跨会话恢复，便于调试和审计，团队解散时可清理 | 仅内存状态：进程退出丢失；数据库：本地场景过度设计 | 文件 I/O，需要处理并发读写 | `src/utils/swarm/teamHelpers.ts:64-182` |
| 双路径权限同步：UI bridge + mailbox | in-process worker 通过 `getLeaderToolUseConfirmQueue()` 直接使用 leader 的 ToolUseConfirm 队列，否则通过 `sendPermissionRequestViaMailbox()` 发送消息 | 同进程下减少延迟和文件 I/O，跨进程下保持可靠性 | 仅 mailbox：同进程有不必要开销；仅 UI bridge：无法跨进程 | 代码分支复杂度，两种路径需要分别测试 | `src/utils/swarm/inProcessRunner.ts:128-300` |
| 隐式 fork 继承父系统提示和工具池 | `isForkSubagentEnabled()` 时，省略 `subagent_type` 触发 fork，子代理通过 `buildForkedMessages()` 继承父消息，使用 `useExactTools` 保持工具池一致 | 最大化 prompt cache 命中率，子代理与父代理能力一致，无需重新构建工具池 | 显式指定：用户体验差，无法利用缓存；完全独立：缓存失效，工具池重建延迟 | 递归 fork 需要禁止，fork child 不能再 fork | `src/tools/AgentTool/forkSubagent.ts:32-210` |
| Coordinator 模式分离协调与执行 | Coordinator 模式下，主代理只负责 spawn worker、send message、收集结果，worker 执行具体任务，`<task-notification>` 作为结果载体 | 避免主代理阻塞，支持并行执行，结果聚合清晰 | 主代理直接执行：阻塞用户交互，无法并行；纯后台进程：用户不可见 | 需要协调器专用系统提示，worker 能力受限 | `src/coordinator/coordinatorMode.ts:111-369` |
| Worktree 隔离可选，而非强制 | `isolation: 'worktree'` 参数触发 git worktree 创建，fork 子代理也可继承；无 isolation 时与父代理共享 cwd | 平衡隔离需求和性能，用户可选择是否需要隔离 | 强制隔离：开销大，简单任务过度设计；无隔离：可能产生文件冲突 | 需要处理 worktree 清理、路径转换、未提交变更检测 | `src/tools/AgentTool/AgentTool.ts:850-953` |
| 异步 agent 与同步 agent 双路径 | `shouldRunAsync` 决定是 spawn 后台 agent 还是同步执行；同步 agent 支持自动后台化（`getAutoBackgroundMs()`） | 兼容现有同步语义，同时支持后台并行；用户可选择交互模式 | 仅异步：破坏现有代码路径；仅同步：无法并行 | 代码复杂度高，两个路径需要分别测试 | `src/tools/AgentTool/AgentTool.ts:954-1669` |
| 团队解散前检查活跃成员 | `TeamDeleteTool` 检查 `nonLeadMembers.filter(m => m.isActive !== false)`，有活跃成员时拒绝解散 | 防止意外终止正在执行的 worker，避免资源泄漏 | 直接解散：可能导致 worker 异常，资源未清理；警告后强制：用户可能误操作 | 需要明确 `isActive` 状态管理，worker 退出时标记 | `src/tools/TeamDeleteTool/TeamDeleteTool.ts:71-139` |

## 3. 目标与非目标

### 状态与生命周期

**目标**：
- 拥有 team context（团队名称、成员列表、inbox）的完整生命周期
- 拥有 agent 任务状态（pending/running/completed/failed/killed）的管理
- 拥有 mailbox 消息的读写与标记已读
- 拥有 worktree 的创建、路径转换、清理

**非目标**：
- 不拥有单代理内部执行逻辑（由 query-core 负责）
- 不拥有工具实现细节（由各工具模块负责）
- 不拥有 git worktree 的核心实现（由 `src/utils/worktree.ts` 负责）

### 接口与数据

**目标**：
- 提供 `AgentTool` spawn 子代理，支持 `subagent_type`/`name`/`team_name`/`isolation`/`run_in_background` 等参数
- 提供 `TeamCreateTool`/`TeamDeleteTool` 管理团队
- 提供 `SendMessageTool` 向特定 agent 发送消息
- 保证 mailbox 消息的持久化和跨进程可见

**非目标**：
- 不提供跨机器 agent 通信
- 不保证消息实时性（基于文件系统轮询）

### 执行与环境

**目标**：
- 支持 CLI 环境下的 in-process/tmux/iTerm2 三种后端
- 支持 SDK 环境下的 async agent
- 支持 feature flag 动态禁用各子功能

**非目标**：
- 不支持 browser/electron 环境（除非后续扩展）
- 不保证跨平台终端兼容性（tmux/iTerm2 是特定平台）

### 依赖边界

- 权限同步：调用 permission system，本文描述调用契约，主设计由 permissions spec 负责
- Worktree：调用 worktree 模块，本文描述调用契约，主设计由其他 spec 负责
- Query：调用 query-core 执行 agent，本文描述调用契约，主设计由 query-core spec 负责

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// AgentTool - spawn 子代理
type AgentToolInput = {
  description: string
  prompt: string
  subagent_type?: string
  model?: 'sonnet' | 'opus' | 'haiku'
  run_in_background?: boolean
  name?: string           // teammate name (multi-agent only)
  team_name?: string      // team context (multi-agent only)
  mode?: PermissionMode   // permission mode for teammate
  isolation?: 'worktree' | 'remote'
  cwd?: string
}

type AgentToolOutput =
  | { status: 'completed', prompt: string, ...agentResult }
  | { status: 'async_launched', agentId: string, description: string, prompt: string, outputFile: string }
  | { status: 'teammate_spawned', teammate_id: string, name: string, ... }
  | { status: 'remote_launched', taskId: string, sessionUrl: string, ... }

// TeamCreateTool - 创建团队
type TeamCreateInput = {
  team_name: string
  description?: string
  agent_type?: string
}

type TeamCreateOutput = {
  team_name: string
  team_file_path: string
  lead_agent_id: string
}

// TeamDeleteTool - 解散团队
type TeamDeleteInput = {}

type TeamDeleteOutput = {
  success: boolean
  message: string
  team_name?: string
}

// Mailbox 操作
function readMailbox(agentName: string, teamName?: string): Promise<TeammateMessage[]>
function writeToMailbox(recipientName: string, message: Omit<TeammateMessage, 'read'>, teamName?: string): Promise<void>
function markMessageAsReadByIndex(agentName: string, teamName: string | undefined, messageIndex: number): Promise<void>
```

调用方通过工具调用进入，异步 agent 通过 `<task-notification>` 返回结果，同步 agent 直接返回。依赖注入包括 `getAppState`/`setAppState`/`abortController` 等。

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `AgentTool` | agentId、autoBackground 状态、worktreeInfo | spawn agent、同步/异步执行、worktree 管理 | 子代理内部执行 | 调用 `runAgent()`，写入 AppState |
| `TeamCreateTool` / `TeamDeleteTool` | AppState.teamContext | 创建/解散团队、读写 teamFile | 团队成员执行 | 调用 `writeTeamFileAsync()`、`cleanupTeamDirectories()` |
| `teammateMailbox.ts` | inbox 文件、lockfile | 读写消息、标记已读 | 消息内容解释 | 文件系统 I/O、lockfile |
| `inProcessRunner.ts` | inProcessTeammate 状态、abortController | 执行 in-process worker、权限同步 | tmux/iTerm2 后端 | 调用 `runAgent()`、leaderToolUseConfirmQueue |
| `teamHelpers.ts` | TeamFile、team directory | 读写 teamFile、清理团队目录 | 团队业务逻辑 | JSON 序列化、文件系统 I/O |
| `permissionSync.ts` | pending/resolved permission 文件 | 发送/响应权限请求 | 权限决策逻辑 | mailbox、leader permission bridge |
| `coordinatorMode.ts` | coordinator 模式标志 | 协调 worker 执行、聚合结果 | 实际任务执行 | 系统提示注入、`<task-notification>` 解析 |
| `forkSubagent.ts` | fork boilerplate、cached prompt 前缀 | 构建 forked 消息、检测递归 fork | fork 子代理执行 | 调用 `runAgent()` 时传入 `useExactTools` |

状态设计理由：
- TeamFile 持久化到磁盘：支持跨会话恢复，便于审计
- Mailbox 每个 agent 独立文件：避免单文件写竞争，便于分别清理
- In-process 权限通过 UI bridge：减少文件 I/O，降低延迟
- Async agent 状态写入 AppState.tasks：统一任务管理界面

复制与共享：
- 子代理通过 `assembleToolPool()` 重新构建工具池（fork 路径除外）
- Fork 路径通过 `useExactTools` 共享父代理工具池（用于缓存命中）
- Permission updates 通过 `leaderPermissionBridge` 共享给 leader

重置与清理：
- 团队解散时调用 `cleanupTeamDirectories()` 删除整个 team 目录
- Agent worktree 无变更时自动清理，有变更时保留
- Resolved permission 文件定时清理（`cleanupOldResolutions()`）

### 4.3 主控制流

#### Spawn 子代理（同步路径）

```text
用户输入 AgentTool(description, prompt, subagent_type)
  → AgentTool.call()：验证输入、解析 team_name、检查 isTeammate()
  → resolveTeamName()：确定团队上下文
  → 构建 effectiveIsolation（参数或 agent 定义）
  → effectiveIsolation === 'worktree' 时：createAgentWorktree()
  → 构建 enhancedSystemPrompt / forkParentSystemPrompt
  → 注册为 foreground task（`registerAgentForeground()`）
  → runAgent()：执行子代理主循环
    → 子代理产生消息：写入 agentMessages
    → 子代理需要权限：调用 createInProcessCanUseTool()
      → 有 leader bridge 时：通过 leaderToolUseConfirmQueue 显示 UI
      → 否则：通过 mailbox 发送 permission_request
  → 子代理完成：finalizeAgentTool()
  → cleanupWorktreeIfNeeded()：无变更则删除 worktree
  → 返回 { status: 'completed', ... }
```

#### Spawn 子代理（异步路径）

```text
用户输入 AgentTool(description, prompt, subagent_type, run_in_background: true)
  → AgentTool.call()：验证输入、检查 isCoordinatorMode() / isForkSubagentEnabled()
  → registerAsyncAgent()：创建后台任务，分配 agentId
  → name 存在时：更新 AppState.agentNameRegistry
  → 后台执行：runWithAgentContext() + wrapWithCwd()
    → runAgent()：与同步路径相同执行逻辑
    → completeAsyncAgent() / failAsyncAgent()：更新任务状态
    → cleanupWorktreeIfNeeded()
    → enqueueAgentNotification()：发送 `<task-notification>`
  → 立即返回 { status: 'async_launched', agentId, outputFile, ... }
```

#### 团队创建与成员 spawn

```text
用户输入 TeamCreateTool(team_name, description)
  → TeamCreateTool.call()：检查已有 teamContext，生成唯一 team_name
  → 构建 TeamFile：leadAgentId = 'team-lead@teamName'，members[0] = leader
  → writeTeamFileAsync()：持久化到 ~/.claude/teams/{teamName}/config.json
  → resetTaskList() + ensureTasksDir()：创建团队任务目录
  → setLeaderTeamName()：设置 leader 团队名称
  → 更新 AppState.teamContext
  → 返回 { team_name, team_file_path, lead_agent_id }

后续 AgentTool(name, team_name, ...)
  → resolveTeamName() 获取团队上下文
  → isTeammate() 检查（teammate 不能再 spawn teammate）
  → spawnTeammate()：根据 backendType 选择 in-process/tmux/iTerm2
  → 更新 TeamFile.members：添加新成员
  → 返回 { status: 'teammate_spawned', teammate_id, name, ... }
```

#### Coordinator 模式执行

```text
用户输入任务描述
  → Coordinator 系统提示注入：getCoordinatorSystemPrompt()
  → Coordinator 决策：并行 spawn 多个 worker
    → AgentTool(description1, prompt1, subagent_type: 'worker', run_in_background: true)
    → AgentTool(description2, prompt2, subagent_type: 'worker', run_in_background: true)
  → Coordinator 结束当前 turn，等待 `<task-notification>`
  → Worker 完成：`<task-notification>` 作为用户消息到达
  → Coordinator 继续：SendMessage() 或 spawn 新 worker 或汇总结果
```

#### Mailbox 消息传递

```text
发送方 writeToMailbox(recipientName, { from, text, timestamp, color, summary })
  → ensureInboxDir()：确保 inbox 目录存在
  → lockfile.lock()：获取文件锁
  → readMailbox()：读取现有消息
  → push(newMessage)：追加新消息
  → writeFile()：写入更新后的 inbox
  → lockfile.release()：释放锁

接收方 readUnreadMessages(agentName)
  → readMailbox()：读取全部消息
  → filter(m => !m.read)：过滤未读
  → 返回未读消息列表

接收方 markMessageAsReadByIndex(agentName, messageIndex)
  → lockfile.lock()
  → readMailbox()
  → messages[messageIndex].read = true
  → writeFile()
  → lockfile.release()
```

### 4.4 数据结构与持久化

#### TeamFile（持久化）

```typescript
type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  hiddenPaneIds?: string[]
  teamAllowedPaths?: TeamAllowedPath[]
  members: Array<{
    agentId: string
    name: string
    agentType?: string
    model?: string
    prompt?: string
    color?: string
    planModeRequired?: boolean
    joinedAt: number
    tmuxPaneId: string
    cwd: string
    worktreePath?: string
    sessionId?: string
    subscriptions: string[]
    backendType?: BackendType
    isActive?: boolean
    mode?: PermissionMode
  }>
}
```

存储位置：`~/.claude/teams/{teamName}/config.json`，原子写入（先写临时文件再 rename）。

#### TeammateMessage（持久化）

```typescript
type TeammateMessage = {
  from: string
  text: string
  timestamp: string
  read: boolean
  color?: string
  summary?: string
}
```

存储位置：`~/.claude/teams/{teamName}/inboxes/{agentName}.json`，使用 lockfile 保证原子读写。

#### SwarmPermissionRequest（持久化，旧路径）

```typescript
type SwarmPermissionRequest = {
  id: string
  workerId: string
  workerName: string
  workerColor?: string
  teamName: string
  toolName: string
  toolUseId: string
  description: string
  input: Record<string, unknown>
  permissionSuggestions: unknown[]
  status: 'pending' | 'approved' | 'rejected'
  resolvedBy?: 'worker' | 'leader'
  resolvedAt?: number
  feedback?: string
  updatedInput?: Record<string, unknown>
  permissionUpdates?: unknown[]
  createdAt: number
}
```

存储位置：`~/.claude/teams/{teamName}/permissions/pending/{requestId}.json` → resolved/。新实现优先使用 mailbox。

#### AppState 中的团队状态（内存）

```typescript
type AppState = {
  // ...
  teamContext?: {
    teamName: string
    teamFilePath: string
    leadAgentId: string
    teammates: {
      [agentId: string]: {
        name: string
        agentType?: string
        color?: string
        tmuxSessionName: string
        tmuxPaneId: string
        cwd: string
        spawnedAt: number
      }
    }
  }
  agentNameRegistry: Map<string, AgentId>
  inbox: { messages: TeammateMessage[] }
  // ...
}
```

恢复：启动时从 teamFile 重建 teamContext；会话恢复时从 session storage 重建 agent 状态。

不可持久化字段：
- `abortController`：内存对象，无法持久化
- `leaderToolUseConfirmQueue`：UI 回调，无法持久化
- `inProcessTeammate` 运行时状态：进程退出即丢失

### 4.5 跨子系统依赖

| 依赖方向 | 模块 | 职责描述 | 主设计 spec |
|---|---|---|---|
| 上游 | permission system | 权限决策逻辑、permission mode | permissions spec |
| 上游 | worktree module | git worktree 创建、删除、变更检测 | 其他 spec |
| 上游 | query-core | 子代理主循环执行、工具调用 | query-core spec |
| 下游 | tasks system | 异步任务注册、进度更新、通知 | 其他 spec |
| 下游 | analytics | agent 事件记录、telemetry | 其他 spec |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| Team name 已存在 | `TeamCreateTool.call()` | 生成唯一 name 继续（不抛异常） | 自动重试（generateWordSlug） | 无 | 返回使用新 name 的结果 |
| 已在团队中再次创建团队 | `TeamCreateTool.call()` | throw Error | 否 | 无 | 异常向上抛出 |
| Teammate 尝试 spawn teammate | `AgentTool.call()` | throw Error | 否 | 无 | 异常向上抛出 |
| In-process teammate 尝试 background agent | `AgentTool.call()` | throw Error | 否 | 无 | 异常向上抛出 |
| Worktree 创建失败 | `createAgentWorktree()` | throw Error | 否 | 已创建的目录尝试删除 | 异常向上抛出 |
| 子代理执行中用户取消 | `abortController.signal.aborted` | `AbortError` 抛出 | 否 | worktree 按需清理，agent foreground 注销 | `AbortError` 向上抛出或 task killed |
| Mailbox lock 竞争 | `lockfile.lock()` | catch 并 logError，返回空结果 | 内部重试（LOCK_OPTIONS.retries） | 无 | readMailbox 返回空数组，writeToMailbox 默默失败 |
| Permission request 超时 | worker 轮询 | 无明确超时，worker 一直等待 | 否 | 无 | worker 阻塞等待 |
| TeamDelete 时有活跃成员 | `TeamDeleteTool.call()` | 返回 success: false | 否 | 无 | 返回拒绝解散的结果 |
| Fork child 尝试再 fork | `isInForkChild()` + `toolUseContext.options.querySource` 检测 | throw Error | 否 | 无 | 异常向上抛出 |
| Remote agent eligibility 检查失败 | `checkRemoteAgentEligibility()` | throw Error | 否 | 无 | 异常向上抛出 |
| In-process worker 崩溃 | `inProcessRunner.ts` | 通过 `appendTeammateMessage()` 发送错误消息 | 否 | 从 teamFile.members 标记 `isActive: false` | Leader 收到错误消息 |

工程取舍：
- **延迟 vs 可靠性**：in-process 使用 UI bridge 降低延迟，但无法跨进程；mailbox 跨进程但有文件 I/O 开销
- **隔离 vs 性能**：worktree 隔离安全但有 git 开销；共享 cwd 快但可能冲突
- **简单 vs 能力**：coordinator 模式简化协调但 worker 能力受限；单代理灵活但无法并行
- **持久化 vs 性能**：mailbox/teamFile 持久化支持恢复但有文件 I/O；纯内存快但进程退出丢失

## 6. 现状验收标准

1. 给定无团队状态的初始 AppState，执行 `TeamCreateTool({ team_name: 'test' })`，必须：
   - 在 `~/.claude/teams/test/config.json` 创建 teamFile
   - 在 AppState 设置 teamContext
   - 返回 team_name/team_file_path/lead_agent_id
   - 不得影响其他团队或会话

2. 给定有团队状态的 AppState，执行 `AgentTool({ name: 'worker1', team_name: 'test', prompt: '...' })`，必须：
   - 更新 teamFile.members 添加 worker1
   - 在 in-process 后端下创建独立执行上下文
   - 返回 teammate_spawned 结果
   - worker1 的权限请求必须通过 leader 的 UI 显示

3. 给定运行中的 async agent，执行 ESC 取消主代理，必须：
   - 主代理取消，但 async agent 继续执行
   - async agent 完成后通过 `<task-notification>` 通知
   - 不得终止 async agent 或泄漏资源

4. 给定有 worktree 的 agent，agent 完成且无文件变更时，必须：
   - 自动删除 worktree 目录
   - 更新 agent metadata 清除 worktreePath
   - 不得影响父代理的 git 状态

5. 给定 mailbox 中有未读消息，执行 `markMessageAsReadByIndex(agentName, 0)`，必须：
   - 原子更新 inbox 文件
   - 标记该消息为 read: true
   - 不得影响其他消息

6. 给定 fork 子代理场景，fork child 尝试再次 fork，必须：
   - 检测到递归 fork 并抛出 Error
   - 不得创建嵌套 fork 代理
   - 不得破坏父代理状态

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 基于文件系统的 mailbox 消息传递 | `src/utils/teammateMailbox.ts:43-271` | 未找到直接测试文件 | 未覆盖 tmux/iTerm2 后端的并发场景 |
| 团队状态持久化到 config.json | `src/utils/swarm/teamHelpers.ts:64-182` | 未找到直接测试文件 | 未覆盖并发读写 teamFile |
| 双路径权限同步 | `src/utils/swarm/inProcessRunner.ts:128-300` + `src/utils/swarm/permissionSync.ts:646-828` | 未找到直接测试文件 | 仅检查 in-process 路径，未测试 mailbox 路径 |
| 隐式 fork 继承父系统提示和工具池 | `src/tools/AgentTool/forkSubagent.ts:32-210` + `src/tools/AgentTool/AgentTool.ts:726-919` | 未找到直接测试文件 | feature('FORK_SUBAGENT') 可能未覆盖 |
| Coordinator 模式分离协调与执行 | `src/coordinator/coordinatorMode.ts:111-369` | 未找到直接测试文件 | 仅检查系统提示，未验证端到端协调 |
| Worktree 隔离可选 | `src/tools/AgentTool/AgentTool.ts:850-953` | 未找到直接测试文件 | 未覆盖有变更保留 worktree 的场景 |
| 异步/同步双路径 | `src/tools/AgentTool/AgentTool.ts:954-1669` | 未找到直接测试文件 | 未覆盖同步转后台的自动切换 |
| 团队解散前检查活跃成员 | `src/tools/TeamDeleteTool/TeamDeleteTool.ts:71-139` | 未找到直接测试文件 | 未覆盖 member.isActive 的完整生命周期 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/agent-swarms.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|---|---|---|---|
| agent-tool | AgentTool 实现、fork 子代理、agent memory | 未找到专用测试 | `src/tools/AgentTool/built-in/` 中的内置 agent 实现不归本组 |
| team-tools | TeamCreateTool、TeamDeleteTool | 未找到专用测试 | 其他工具（SendMessageTool、Task*Tool）不归本组 |
| swarm-utils | mailbox、teamHelpers、permissionSync、inProcessRunner、backends | 未找到专用测试 | `src/utils/teammate.ts` 等辅助函数不归本组 |
| coordinator | Coordinator 模式、系统提示 | 未找到专用测试 | 协调业务逻辑不归本组 |

相关子系统：
- [Query Core](./2026-11-12-query-core-design.md)：子代理执行主循环
- [Permissions](./2026-11-12-permissions-design.md)：权限决策与同步
- [Shell Tools](./2026-11-12-shell-tools-design.md)：Bash 工具在子代理中的执行

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | mailbox 无超时机制，worker 可能永久等待（设计推断） | 为 permission request 和 worker 等待添加超时 | 可能中断正在等待用户确认的合法请求 | 注入超时场景，验证 worker 正确退出或重试 | M | 设计推断 |
| P2 | in-process/tmux/iTerm2 三种后端测试缺口大（证据：第 7 章无测试） | 添加各后端的端到端测试 | 需要稳定的终端环境，CI 可能难以覆盖 | 实现基本的 in-process 测试，tmux/iTerm2 标记为手动验证 | L | 设计推断 |
| P3 | permissionSync 新旧两套路径并存（pending/resolved 文件 + mailbox），增加复杂度 | 移除旧的文件路径，统一使用 mailbox | 需要确保所有后端都迁移到 mailbox | 检查所有调用点，确认 mailbox 路径覆盖完整 | M | 设计推断 |
| P3 | worktree 清理依赖 hasWorktreeChanges()，未跟踪未跟踪文件可能导致意外保留（设计推断） | 考虑更保守的清理策略或明确告知用户 | 可能删除用户想保留的未跟踪文件 | 对比 git status 与 hasWorktreeChanges() 的行为 | S | 设计推断 |
