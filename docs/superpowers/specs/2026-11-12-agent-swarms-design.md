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

---

### 4.2 AgentTool 模块设计卡

#### 4.2.1 AgentTool 主入口

**真实入口签名**
```typescript
// src/tools/AgentTool/AgentTool.tsx
const AgentTool: Tool<InputSchema, Output> = buildTool({
  name: AGENT_TOOL_NAME,
  searchHint: 'delegate work to a subagent',
  async call(
    { prompt, subagent_type, description, model, run_in_background, name, team_name, mode, isolation, cwd }: AgentToolInput,
    toolUseContext: ToolUseContext,
    canUseTool: CanUseToolFn,
    assistantMessage?: Message
  ): Promise<{ data: Output }>
})
```

**关键类型定义**
```typescript
type AgentToolInput = z.infer<typeof inputSchema>
type AgentToolOutput = z.infer<typeof outputSchema>
type Progress = AgentToolProgress | ShellProgress

type TeammateSpawnedOutput = {
  status: 'teammate_spawned'
  prompt: string
  teammate_id: string
  agent_id: string
  agent_type?: string
  model?: string
  name: string
  color?: string
  tmux_session_name: string
  tmux_window_name: string
  tmux_pane_id: string
  team_name?: string
  is_splitpane?: boolean
  plan_mode_required?: boolean
}

type RemoteLaunchedOutput = {
  status: 'remote_launched'
  taskId: string
  sessionUrl: string
  description: string
  prompt: string
  outputFile: string
}
```

**输入输出路径**
- 输入：用户/coordinator 提供的 `description`、`prompt`、`subagent_type`、可选参数 `name`/`team_name`/`mode`/`isolation`/`cwd`
- 输出：根据执行模式返回四种状态之一
  - `completed`: 同步执行完成结果
  - `async_launched`: 后台 agent 已启动，返回 `agentId` 与 `outputFile`
  - `teammate_spawned`: 团队成员已创建，返回 pane/session 信息
  - `remote_launched`: 远程 agent 已启动，返回 `taskId` 与 `sessionUrl`

**Agent/Team 状态**
- 前台同步：通过 `registerAgentForeground`/`unregisterAgentForeground` 管理 AppState 中的 agent 任务
- 后台异步：通过 `registerAsyncAgent`/`completeAsyncAgent`/`failAsyncAgent` 管理
- 团队成员：更新 `AppState.teamContext.teammates[agentId]`，记录 name/color/tmux_session_name/tmux_pane_id/cwd/spawned_at
- 进程环境：设置 `CLAUDE_CODE_AGENT_ID`、`CLAUDE_CODE_AGENT_NAME`、`CLAUDE_CODE_TEAM_NAME` 等 env var

**创建流程**
```
用户输入 AgentTool
  → 检查 feature gate (isAgentSwarmsEnabled, isForkSubagentEnabled, isCoordinatorMode)
  → 解析 team_name 与当前团队上下文
  → 检查权限规则 (filterDeniedAgents)
  → 决定执行模式 (sync/async/teammate/remote)
    - sync: registerAgentForeground → runAgent → cleanupWorktreeIfNeeded → finalizeAgentTool
    - async: registerAsyncAgent → 后台启动 runAsyncAgentLifecycle → 立即返回 async_launched
    - teammate: resolveTeamName → spawnTeammate → 更新 TeamFile → 返回 teammate_spawned
    - remote: checkRemoteAgentEligibility → registerRemoteAgentTask → teleportToRemote → 返回 remote_launched
  → 清理与返回结果
```

**错误与清理路径**
- 用户取消：捕获 `AbortError`，调用 `cleanupWorktreeIfNeeded`，设置 agent 任务状态为 `killed`
- 执行失败：调用 `failAsyncAgent`/`finalizeAgentTool` 记录错误，保留有变更的 worktree
- 并发安全：所有 AppState 更新通过 updater 函数原子化，async agent 状态变化通过任务队列协调

**设计取舍**
- 取舍：同一工具承担四种执行模式，而非拆分四个独立工具
  - 理由：统一入口简化调用方理解，共享参数验证与工具池构建逻辑
  - 代价：内部复杂度高，类型系统需要处理四种输出分支
- 取舍：isolation worktree 可选而非强制
  - 理由：简单任务无需隔离开销，用户可根据场景选择
  - 代价：需处理 worktree 存在/缺失两种路径，文件变更检测逻辑复杂

**源码测试证据**
- 主实现：`src/tools/AgentTool/AgentTool.tsx`
- Fork 路径：`src/tools/AgentTool/forkSubagent.ts`
- 工具池：`src/tools/AgentTool/loadAgentsDir.ts`
- 执行器：`src/tools/AgentTool/runAgent.ts`
- 测试：未找到直接测试文件

---

#### 4.2.2 AgentTool Fork 隐式子代理

**真实入口签名**
```typescript
// src/tools/AgentTool/forkSubagent.ts
function isForkSubagentEnabled(): boolean
function isInForkChild(messages: Message[]): boolean
function buildForkedMessages(directive: string, assistantMessage: AssistantMessage): Message[]
function buildChildMessage(directive: string): string
function buildWorktreeNotice(parentCwd: string, worktreeCwd: string): string
```

**关键类型定义**
```typescript
const FORK_AGENT: BuiltInAgentDefinition = {
  agentType: 'fork',
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',
} satisfies BuiltInAgentDefinition

const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'
```

**输入输出路径**
- 输入：用户省略 `subagent_type`，`isForkSubagentEnabled()` 返回 true
- 消息前缀构建：`buildForkedMessages` 保留完整 `assistantMessage`，为所有 `tool_use` 生成占位 `tool_result`
- 输出：通过 `AgentTool.call` 返回 `async_launched` 状态，最终通过 `<task-notification>` 交付结果

**Agent/Team 状态**
- `querySource` 设置为 `fork`，继承父 prompt cache 前缀
- `useExactTools` 保持工具池与父完全一致，确保 cache 命中
- `isInForkChild` 通过检查消息中 `FORK_BOILERPLATE_TAG` 检测，防止递归 fork

**创建流程**
```
用户 AgentTool 省略 subagent_type
  → isForkSubagentEnabled 检查 (feature('FORK_SUBAGENT') && !isCoordinatorMode && !isNonInteractiveSession)
  → isInForkChild 检测，防止递归 fork
  → 构建 forked messages：
    - 保留完整父 assistantMessage (所有 content blocks)
    - 为每个 tool_use 生成占位 tool_result (FORK_PLACEHOLDER_RESULT)
    - 添加 fork boilerplate 消息
  → 使用 FORK_AGENT 定义 (tools: ['*'], model: 'inherit', permissionMode: 'bubble')
  → 后台异步执行
```

**设计取舍**
- 取舍：隐式触发（省略 subagent_type）而非显式命令
  - 理由：降低用户使用门槛，自然利用 prompt cache
  - 代价：需要与 coordinator mode 互斥，需要检测递归 fork
- 取舍：共享完整工具池而非受限子集
  - 理由：最大化 prompt cache 复用，fork child 能力与父一致
  - 代价：需要严格防止递归 fork，需要 `bubble` permission mode 避免重复 prompt

**源码测试证据**
- 实现：`src/tools/AgentTool/forkSubagent.ts`
- 测试：未找到直接测试文件

---

#### 4.2.3 AgentTool Worktree 隔离

**真实入口签名**
```typescript
// src/utils/worktree.ts 导出函数被 AgentTool 调用
function createAgentWorktree(): Promise<string>
function hasWorktreeChanges(worktreePath: string): Promise<boolean>
function removeAgentWorktree(worktreePath: string): Promise<void>
```

**关键类型定义**
```typescript
// 工作目录配置
type IsolationMode = 'worktree' | 'remote' | undefined
type CwdOverride = string | undefined

// Worktree 元数据（未显式类型，通过 TeamFile 存储）
{
  worktreePath?: string  // TeamFile.members[*].worktreePath
}
```

**输入输出路径**
- 输入：`isolation: 'worktree'` 参数，或 `cwd` 参数（与 isolation 互斥）
- 输出：worktree 创建成功后路径写入 `TeamFile.members[*].worktreePath`，agent 执行期间 cwd 切换到 worktree
- 路径转换：fork child 继承 worktree 时，通过 `buildWorktreeNotice` 提示路径转换

**Agent/Team 状态**
- 父 agent：cwd 保持不变，worktree 路径记录在 agent 元数据
- 子 agent：cwd 设置为 worktree，通过 env var 传递 worktree 信息
- TeamFile：成员记录 `worktreePath`，团队清理时一并删除

**创建流程**
```
用户设置 isolation: 'worktree'
  → 检查与 cwd 参数互斥
  → createAgentWorktree：
    - git worktree add 创建临时工作树
    - 生成唯一路径名
  → 切换 agent 执行 cwd 到 worktree
  → buildWorktreeNotice 注入系统提示，告知路径转换
  → 执行 agent 任务
  → 完成后 cleanupWorktreeIfNeeded：
    - hasWorktreeChanges 检测变更
    - 无变更：removeAgentWorktree 删除
    - 有变更：保留并提示用户
```

**设计取舍**
- 取舍：git worktree 而非独立 clone
  - 理由：共享对象库，创建速度快，占用空间小
  - 代价：依赖 git 仓库存在，对非 git 项目需降级处理
- 取舍：无变更自动清理，有变更保留
  - 理由：平衡资源占用与安全，防止意外丢失工作
  - 代价：`hasWorktreeChanges` 需考虑 untracked 文件，决策逻辑复杂

**源码测试证据**
- 实现：`src/tools/AgentTool/AgentTool.tsx` (worktree 相关部分)
- 底层：`src/utils/worktree.ts`
- 测试：未找到直接测试文件

---

### 4.3 团队工具模块设计卡

#### 4.3.1 TeamCreateTool 创建团队

**真实入口签名**
```typescript
// src/tools/TeamCreateTool/TeamCreateTool.ts
const TeamCreateTool: Tool<InputSchema, Output> = buildTool({
  name: TEAM_CREATE_TOOL_NAME,
  searchHint: 'create a multi-agent swarm team',
  async call(input: Input, context: ToolUseContext): Promise<{ data: Output }>
})

// 内部关键函数
function generateUniqueTeamName(providedName: string): string
```

**关键类型定义**
```typescript
type Input = z.infer<typeof inputSchema>  // { team_name: string, description?: string, agent_type?: string }
type Output = { team_name: string, team_file_path: string, lead_agent_id: string }

type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  members: Array<{
    agentId: string
    name: string
    agentType?: string
    model?: string
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

**输入输出路径**
- 输入：`team_name`（必填）、`description`、`agent_type`（可选）
- 输出：最终使用的 `team_name`（可能已添加后缀避免冲突）、`team_file_path`、`lead_agent_id`
- 副作用：创建 `~/.claude/teams/{teamName}/config.json`、创建团队任务目录、更新 `AppState.teamContext`

**Agent/Team 状态**
- AppState：设置 `teamContext.teamName`、`teamContext.teamFilePath`、`teamContext.leadAgentId`、`teamContext.teammates[leadAgentId]`
- 进程环境：设置 leader 团队名称通过 `setLeaderTeamName`，不设置 `CLAUDE_CODE_AGENT_ID`（leader 不是 teammate）
- TeamFile：初始化 leader 成员记录，`name=TEAM_LEAD_NAME`、`agentId=formatAgentId(TEAM_LEAD_NAME, teamName)`
- 会话清理：调用 `registerTeamForSessionCleanup`，会话退出时自动清理

**创建流程**
```
用户 TeamCreateTool(team_name, description, agent_type)
  → 检查 isAgentSwarmsEnabled
  → 检查是否已在团队中：AppState.teamContext 存在则抛出错误
  → generateUniqueTeamName：
    - 检查团队名是否已存在
    - 存在则通过 generateWordSlug 生成唯一名称
  → 构建初始 TeamFile：
    - leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)
    - leadSessionId = getSessionId()
    - members[0] = leader (name=TEAM_LEAD_NAME, agentType=agent_type, model=当前 model)
  → writeTeamFileAsync 持久化到 ~/.claude/teams/{teamName}/config.json
  → registerTeamForSessionCleanup 注册会话退出清理
  → resetTaskList + ensureTasksDir 创建团队任务目录
  → setLeaderTeamName 设置 leader 团队名称
  → 更新 AppState.teamContext
  → 返回结果
```

**错误与清理路径**
- 团队已存在：自动重命名而非失败，通过 `generateUniqueTeamName` 处理
- 已在团队中：抛出错误，防止嵌套团队
- 并发安全：`writeTeamFileAsync` 使用原子写入（先写临时再 rename）

**设计取舍**
- 取舍：团队名冲突自动重命名而非失败
  - 理由：提高鲁棒性，避免用户因命名失败而重试
  - 代价：实际团队名可能与请求不同，调用方需使用返回值
- 取舍：限制单个 leader 只能管理一个团队
  - 理由：简化状态管理，避免多团队上下文混淆
  - 代价：需要先 TeamDelete 才能创建新团队

**源码测试证据**
- 实现：`src/tools/TeamCreateTool/TeamCreateTool.ts`
- 底层：`src/utils/swarm/teamHelpers.ts`
- 测试：未找到直接测试文件

---

#### 4.3.2 TeamDeleteTool 解散团队

**真实入口签名**
```typescript
// src/tools/TeamDeleteTool/TeamDeleteTool.ts
const TeamDeleteTool: Tool<InputSchema, Output> = buildTool({
  name: TEAM_DELETE_TOOL_NAME,
  searchHint: 'disband a swarm team and clean up',
  async call(input: Input, context: ToolUseContext): Promise<{ data: Output }>
})
```

**关键类型定义**
```typescript
type Input = {}  // 无参数，使用当前 AppState.teamContext
type Output = { success: boolean, message: string, team_name?: string }
```

**输入输出路径**
- 输入：无显式参数，从 `AppState.teamContext.teamName` 获取
- 输出：操作成功/失败状态、消息、团队名
- 副作用：删除团队目录、删除任务目录、清除 `AppState.teamContext`、清除颜色分配

**Agent/Team 状态**
- 活跃成员检查：读取 TeamFile，过滤 `nonLeadMembers`，检查 `isActive !== false`
- 清理：调用 `cleanupTeamDirectories` 删除团队目录与成员 worktree
- 会话清理：调用 `unregisterTeamForSessionCleanup`，防止重复清理
- AppState 清除：设置 `teamContext = undefined`，清除 `inbox.messages`

**解散流程**
```
用户 TeamDeleteTool()
  → 检查 isAgentSwarmsEnabled
  → 从 AppState.teamContext 获取 teamName
  → 无团队则返回 success: true，无操作
  → 读取 TeamFile 检查活跃成员：
    - nonLeadMembers = members.filter(m => m.name !== TEAM_LEAD_NAME)
    - activeMembers = nonLeadMembers.filter(m => m.isActive !== false)
    - 活跃成员存在则拒绝：返回 success: false，提示使用 requestShutdown
  → cleanupTeamDirectories(teamName)：
    - 读取 TeamFile 获取所有成员 worktreePath
    - destroyWorktree 逐个删除 worktree
    - 删除 ~/.claude/teams/{teamName} 目录
    - 删除 ~/.claude/tasks/{sanitizedTeamName} 目录
  → unregisterTeamForSessionCleanup
  → clearTeammateColors
  → clearLeaderTeamName
  → 更新 AppState：清除 teamContext，清空 inbox
  → 返回 success: true
```

**设计取舍**
- 取舍：有活跃成员时拒绝删除而非强制清理
  - 理由：防止意外中断正在工作的 teammate，避免资源泄漏
  - 代价：需要先 SendMessage 发送 shutdown_request 并等待确认
- 取舍：清理 worktree 作为 TeamDelete 的一部分
  - 理由：团队解散意味着所有成员工作结束，统一清理避免孤儿目录
  - 代价：需要在删除 TeamFile 前先读取 worktreePath 列表

**源码测试证据**
- 实现：`src/tools/TeamDeleteTool/TeamDeleteTool.ts`
- 底层：`src/utils/swarm/teamHelpers.ts` (cleanupTeamDirectories, destroyWorktree)
- 测试：未找到直接测试文件

---

#### 4.3.3 SendMessageTool 团队消息传递

**真实入口签名**
```typescript
// src/tools/SendMessageTool/SendMessageTool.ts
const SendMessageTool: Tool<InputSchema, SendMessageToolOutput> = buildTool({
  name: SEND_MESSAGE_TOOL_NAME,
  searchHint: 'send messages to agent teammates (swarm protocol)',
  async call(
    input: Input,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    assistantMessage?: Message
  ): Promise<{ data: SendMessageToolOutput }>
})
```

**关键类型定义**
```typescript
type Input = z.infer<typeof inputSchema>
// {
//   to: string,
//   summary?: string,
//   message: string | StructuredMessage
// }

type StructuredMessage =
  | { type: 'shutdown_request', reason?: string }
  | { type: 'shutdown_response', request_id: string, approve: boolean, reason?: string }
  | { type: 'plan_approval_response', request_id: string, approve: boolean, feedback?: string }

type SendMessageToolOutput =
  | MessageOutput  // { success: boolean, message: string, routing?: MessageRouting }
  | BroadcastOutput  // { success: boolean, message: string, recipients: string[], routing?: MessageRouting }
  | RequestOutput  // { success: boolean, message: string, request_id: string, target: string }
  | ResponseOutput  // { success: boolean, message: string, request_id?: string }
```

**输入输出路径**
- 输入：`to`（接收者名称、`*` 广播、`uds:<path>`、`bridge:<session-id>`）、`summary`（纯文本消息必填）、`message`（文本或结构化消息）
- 输出：根据消息类型返回对应输出，包含路由信息（发送者/接收者颜色用于 UI 显示）
- 特殊路径：本地 agent 恢复：`to` 为已注册 agent name 且任务已停止时，调用 `resumeAgentBackground` 恢复执行

**Agent/Team 状态**
- AppState.agentNameRegistry：将 agent name 映射到 agentId，用于恢复已停止 agent
- AppState.tasks：查找 LocalAgentTask，检查 `status: running` 或已停止
- Mailbox：非本地 agent 消息写入 `~/.claude/teams/{teamName}/inboxes/{agentName}.json`
- 进程间：UDS/Bridge 路径通过 `sendToUdsSocket`/`postInterClaudeMessage` 直接发送

**消息路由流程**
```
用户 SendMessageTool(to, summary, message)
  → 检查 isAgentSwarmsEnabled
  → validateInput：
    - to 不能为空
    - 纯文本消息必须有 summary
    - 结构化消息不能广播
    - shutdown_response 必须发送给 TEAM_LEAD_NAME
    - bridge 路径需要 isReplBridgeActive
  → feature('UDS_INBOX') 且 to 是 uds/bridge 路径：
    - bridge: postInterClaudeMessage
    - uds: sendToUdsSocket
  → 否则，检查是否为本地 agent：
    - 从 agentNameRegistry 或 toAgentId(to) 获取 agentId
    - 查找 AppState.tasks[agentId]
    - isLocalAgentTask 且 !isMainSessionTask：
      - 任务 running：queuePendingMessage 入队，等下次 tool call 处理
      - 任务 stopped：resumeAgentBackground 恢复并注入消息
  → 否则为团队消息：
    - to === '*'：handleBroadcast 读取 TeamFile，逐个 writeToMailbox
    - to 是 teammate：handleMessage writeToMailbox
  → 结构化消息特殊路由：
    - shutdown_request：handleShutdownRequest 生成 requestId，写入目标 inbox
    - shutdown_response approve：handleShutdownApproval 发送确认给 leader，in-process 则 abort task，否则 gracefulShutdown
    - plan_approval_response：仅 leader 可调用，writeToMailbox 发送给目标
  → 返回对应输出
```

**设计取舍**
- 取舍：同一工具处理四种路由（本地 agent、团队成员、UDS、Bridge）
  - 理由：统一消息发送接口，调用方无需关心位置
  - 代价：validateInput 与 call 逻辑复杂，多分支判断
- 取舍：支持结构化消息（协议）与纯文本（用户）两种模式
  - 理由：协议消息类型安全可解析，纯文本灵活易用
  - 代价：两套处理路径，广播限制仅纯文本

**源码测试证据**
- 实现：`src/tools/SendMessageTool/SendMessageTool.ts`
- 协议：`src/utils/teammateMailbox.ts`
- 测试：未找到直接测试文件

---

### 4.4 团队状态与通信模块设计卡

#### 4.4.1 TeamFile 团队状态持久化

**真实入口签名**
```typescript
// src/utils/swarm/teamHelpers.ts
function readTeamFile(teamName: string): TeamFile | null
async function readTeamFileAsync(teamName: string): Promise<TeamFile | null>
async function writeTeamFileAsync(teamName: string, teamFile: TeamFile): Promise<void>
function getTeamFilePath(teamName: string): string
function getTeamDir(teamName: string): string
```

**关键类型定义**
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

type TeamAllowedPath = {
  path: string
  toolName: string
  addedBy: string
  addedAt: number
}
```

**输入输出路径**
- 存储位置：`~/.claude/teams/{teamName}/config.json`
- 目录结构：
  ```
  ~/.claude/teams/
    {teamName}/
      config.json
      inboxes/
        {agentName}.json
      permissions/
        pending/
        resolved/
  ```
- 读写方式：同步 `readTeamFile`（用于 UI 渲染）、异步 `readTeamFileAsync`/`writeTeamFileAsync`（用于工具处理）
- 原子性：`writeTeamFileAsync` 使用原子写入（先写临时再 rename）

**Agent/Team 状态**
- 成员生命周期：`joinedAt` 记录加入时间，`isActive` 标记是否活跃（false 表示空闲/退出）
- 后端信息：`backendType`、`tmuxPaneId` 用于跨进程后端管理
- 权限模式：`mode` 记录成员当前权限模式，用于 UI 显示与继承
- 工作隔离：`worktreePath` 记录成员工作树路径，团队清理时使用

**读写流程**
```
readTeamFile(teamName)
  → getTeamFilePath → readFileSync → jsonParse → validate
  → ENOENT 返回 null

writeTeamFileAsync(teamName, teamFile)
  → getTeamDir → mkdir recursive
  → writeFile 原子化写入
  → logForDebugging

成员更新示例：
  → readTeamFile(teamName)
  → members.map(...) 更新字段
  → writeTeamFileAsync(teamName, updatedTeamFile)
```

**设计取舍**
- 取舍：同时提供同步与异步 API
  - 理由：同步用于 React 组件渲染路径，异步用于工具处理避免阻塞
  - 代价：两套实现，需注意状态一致性
- 取舍：完整 JSON 文件而非增量更新
  - 理由：实现简单，读取即完整状态
  - 代价：大团队文件写入开销，需要原子化防止并发损坏

**源码测试证据**
- 实现：`src/utils/swarm/teamHelpers.ts`
- 测试：未找到直接测试文件

---

#### 4.4.2 Mailbox 文件邮箱系统

**真实入口签名**
```typescript
// src/utils/teammateMailbox.ts
function getInboxPath(agentName: string, teamName?: string): string
async function readMailbox(agentName: string, teamName?: string): Promise<TeammateMessage[]>
async function readUnreadMessages(agentName: string, teamName?: string): Promise<TeammateMessage[]>
async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName?: string
): Promise<void>
async function markMessageAsReadByIndex(
  agentName: string,
  teamName: string | undefined,
  messageIndex: number
): Promise<void>
async function markMessagesAsRead(agentName: string, teamName?: string): Promise<void>
async function clearMailbox(agentName: string, teamName?: string): Promise<void>
```

**关键类型定义**
```typescript
type TeammateMessage = {
  from: string
  text: string
  timestamp: string
  read: boolean
  color?: string
  summary?: string
}

// 结构化协议消息（嵌套在 text 字段中 JSON 序列化）
type IdleNotificationMessage = { type: 'idle_notification', from: string, timestamp: string, ... }
type PermissionRequestMessage = { type: 'permission_request', request_id: string, ... }
type PermissionResponseMessage = { type: 'permission_response', request_id: string, ... }
type ShutdownRequestMessage = { type: 'shutdown_request', requestId: string, ... }
type ShutdownApprovedMessage = { type: 'shutdown_approved', requestId: string, ... }
type ShutdownRejectedMessage = { type: 'shutdown_rejected', requestId: string, ... }
type PlanApprovalRequestMessage = { type: 'plan_approval_request', requestId: string, ... }
type PlanApprovalResponseMessage = { type: 'plan_approval_response', requestId: string, ... }
type TeamPermissionUpdateMessage = { type: 'team_permission_update', ... }
type ModeSetRequestMessage = { type: 'mode_set_request', ... }
type SandboxPermissionRequestMessage = { type: 'sandbox_permission_request', ... }
type SandboxPermissionResponseMessage = { type: 'sandbox_permission_response', ... }
type TaskAssignmentMessage = { type: 'task_assignment', ... }
```

**输入输出路径**
- 存储位置：`~/.claude/teams/{teamName}/inboxes/{agentName}.json`
- 文件格式：JSON 数组，每个元素为 `TeammateMessage`
- 锁机制：使用 `lockfile.lock` 与 `{inboxPath}.lock` 文件，`LOCK_OPTIONS` 配置重试与退避
- 消息状态：`read: boolean` 标记是否已读，索引按写入顺序排列

**Agent/Team 状态**
- 消息所有权：每个 agent 独立 inbox，不共享
- 消息顺序：append-only，索引稳定
- 已读跟踪：按索引标记，避免删除消息导致索引失效
- 结构化检测：`isStructuredProtocolMessage` 识别协议消息，路由到对应处理器而非 LLM

**邮箱操作流程**
```
writeToMailbox(recipientName, message, teamName)
  → ensureInboxDir：确保目录存在
  → getInboxPath：确定文件路径
  → 先创建 inbox 文件（如果不存在）
  → lockfile.lock：获取锁（重试 + 退避）
  → readMailbox：读取现有消息（锁后重读确保最新）
  → push(newMessage)：追加消息（read: false）
  → writeFile：写入完整数组
  → release：释放锁

markMessageAsReadByIndex(agentName, teamName, messageIndex)
  → lockfile.lock：获取锁
  → readMailbox：读取最新状态
  → 索引越界或已读则返回
  → messages[messageIndex].read = true
  → writeFile：写入更新
  → release：释放锁

readUnreadMessages(agentName, teamName)
  → readMailbox（无锁，只读）
  → filter(m => !m.read)
  → 返回结果
```

**设计取舍**
- 取舍：文件锁 + 重试/退避而非内存队列或数据库
  - 理由：跨进程（tmux/iTerm2）与同进程统一机制，不依赖共享内存
  - 代价：文件 I/O 开销，锁竞争导致延迟
- 取舍：append-only + 标记已读而非删除消息
  - 理由：索引稳定，便于引用与调试，保留历史
  - 代价：文件增长，需定时清理（当前未实现）
- 取舍：结构化消息嵌套在 text 字段 JSON 中
  - 理由：保持 TeammateMessage 类型简单，兼容纯文本与协议两种模式
  - 代价：需要双重解析，`isStructuredProtocolMessage` 先检测再路由

**源码测试证据**
- 实现：`src/utils/teammateMailbox.ts`
- 锁机制：`src/utils/lockfile.ts`
- 测试：未找到直接测试文件

---

#### 4.4.3 双路径权限同步

**真实入口签名**
```typescript
// src/utils/swarm/inProcessRunner.ts
function createInProcessCanUseTool(
  identity: TeammateIdentity,
  abortController: AbortController,
  onPermissionWaitMs?: (waitMs: number) => void
): CanUseToolFn

// src/utils/swarm/permissionSync.ts
function createPermissionRequest(params: { ... }): SwarmPermissionRequest
async function writePermissionRequest(request: SwarmPermissionRequest): Promise<SwarmPermissionRequest>
async function sendPermissionRequestViaMailbox(
  params: { ... }
): Promise<PermissionResolution>
function generateRequestId(): string

// src/utils/swarm/leaderPermissionBridge.ts
function getLeaderToolUseConfirmQueue(): ((updater: (queue: LeaderToolUseConfirmQueue) => LeaderToolUseConfirmQueue) => void) | undefined
function getLeaderSetToolPermissionContext(): ((context: ToolPermissionContext, options?: { preserveMode?: boolean }) => void) | undefined
```

**关键类型定义**
```typescript
type SwarmPermissionRequest = z.infer<typeof SwarmPermissionRequestSchema>
// {
//   id: string, workerId: string, workerName: string, workerColor?: string, teamName: string,
//   toolName: string, toolUseId: string, description: string, input: Record<string, unknown>,
//   permissionSuggestions: unknown[], status: 'pending' | 'approved' | 'rejected',
//   resolvedBy?: 'worker' | 'leader', resolvedAt?: number, feedback?: string,
//   updatedInput?: Record<string, unknown>, permissionUpdates?: unknown[], createdAt: number
// }

type PermissionResolution = {
  decision: 'approved' | 'rejected'
  resolvedBy: 'worker' | 'leader'
  feedback?: string
  updatedInput?: Record<string, unknown>
  permissionUpdates?: PermissionUpdate[]
}

type LeaderToolUseConfirmQueueItem = {
  assistantMessage?: Message
  tool: Tool
  description: string
  input: Record<string, unknown>
  toolUseContext: ToolUseContext
  toolUseID: string
  permissionResult: PermissionResult
  permissionPromptStartTimeMs: number
  workerBadge?: { name: string, color: string }
  onUserInteraction(): void
  onAbort(): void
  onAllow(...): void
  onReject(...): void
}
```

**输入输出路径**
- 同进程路径（in-process）：
  - 输入：worker `canUseTool` 调用返回 `behavior: 'ask'`
  - 输出：通过 `getLeaderToolUseConfirmQueue` 直接在 leader UI 显示 prompt，结果同步返回
- Mailbox 路径（跨进程 tmux/iTerm2）：
  - 输入：worker `sendPermissionRequestViaMailbox` 写入 leader inbox
  - 输出：leader 轮询检测，用户决定后写入 worker inbox，worker 轮询获取结果

**Agent/Team 状态**
- Leader 桥接：`getLeaderToolUseConfirmQueue`/`getLeaderSetToolPermissionContext` 通过闭包访问 leader 状态，仅同进程可用
- Worker 权限更新：同进程路径通过 `applyPermissionUpdates` 直接更新 leader `toolPermissionContext`（`preserveMode: true`）
- Mailbox 状态：旧路径通过 `~/.claude/teams/{teamName}/permissions/pending/{requestId}.json` 存储，新路径通过 `permission_request`/`permission_response` 协议消息

**权限同步流程**
```
同进程路径（createInProcessCanUseTool）:
  worker 调用 canUseTool
    → hasPermissionsToUseTool 返回 behavior: 'ask'
    → feature('BASH_CLASSIFIER') 且是 Bash 工具：
      - awaitClassifierAutoApproval
    → 检查 abortController.signal.aborted
    → getLeaderToolUseConfirmQueue 存在：
      - 创建 Promise，注册 onAllow/onReject/onAbort 回调
      - 通过 setToolUseConfirmQueue 将 prompt 入队 leader UI
      - workerBadge 显示 worker name/color
      - 用户决定：
        - allow: persistPermissionUpdates，更新 leader toolPermissionContext (preserveMode: true)
        - reject: 返回 SUBAGENT_REJECT_MESSAGE
      - Promise resolve 继续执行

Mailbox 路径（sendPermissionRequestViaMailbox）:
  worker 创建 SwarmPermissionRequest
    → writePermissionRequest 写入 pending 目录
    → writeToMailbox 发送 permission_request 到 leader inbox
    → 轮询等待：sleep + readMailbox 查找对应 permission_response
    → 超时？无超时，永久等待
    → 收到响应：更新 request status，移动到 resolved 目录
    → 返回 PermissionResolution
```

**设计取舍**
- 取舍：同进程直接 UI bridge，跨进程 mailbox 双路径
  - 理由：同进程低延迟，无需文件 I/O；跨进程 mailbox 统一可靠
  - 代价：两套实现，调用方需判断可用路径
- 取舍：旧路径 pending/resolved 文件 + 新路径 mailbox 协议并存
  - 理由：渐进迁移，避免破坏现有部署
  - 代价：代码复杂度高，需要维护两套逻辑
- 取舍：无超时永久等待
  - 理由：用户可能长时间未决定，超时会导致任务失败
  - 代价：worker 可能永久阻塞，需要 shutdown_request 强制退出

**源码测试证据**
- in-process：`src/utils/swarm/inProcessRunner.ts`
- permissionSync：`src/utils/swarm/permissionSync.ts`
- leaderBridge：`src/utils/swarm/leaderPermissionBridge.ts`
- 测试：未找到直接测试文件

---

### 4.5 Coordinator 协调器模块设计卡

#### 4.5.1 Coordinator Mode 协调器模式

**真实入口签名**
```typescript
// src/coordinator/coordinatorMode.ts
function isCoordinatorMode(): boolean
function matchSessionMode(sessionMode: 'coordinator' | 'normal' | undefined): string | undefined
function getCoordinatorUserContext(
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string
): { [k: string]: string }
function getCoordinatorSystemPrompt(): string
```

**关键类型定义**
```typescript
// 常量定义
const INTERNAL_WORKER_TOOLS = new Set([
  TEAM_CREATE_TOOL_NAME,
  TEAM_DELETE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])

// Coordinator 系统提示返回类型
{ workerToolsContext: string }
```

**输入输出路径**
- 启用条件：`feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)`
- 会话恢复：`matchSessionMode` 检测会话存储的模式，不匹配则切换 env var
- 系统提示：`getCoordinatorSystemPrompt` 注入协调器专用提示，定义角色、工具、worker 能力
- 用户上下文：`getCoordinatorUserContext` 注入 worker 工具列表、MCP 服务器、scratchpad 目录

**Agent/Team 状态**
- 互斥性：coordinator mode 与 fork subagent 互斥，`isForkSubagentEnabled` 返回 false
- 环境变量：`CLAUDE_CODE_COORDINATOR_MODE` 控制模式切换，会话恢复时可能被 `matchSessionMode` 修改
- 工具白名单：`ASYNC_AGENT_ALLOWED_TOOLS` 过滤 worker 可用工具，排除 `INTERNAL_WORKER_TOOLS`

**协调器工作流**
```
会话启动：
  → 检查 process.env.CLAUDE_CODE_COORDINATOR_MODE
  → isCoordinatorMode 返回 true/false
  → 会话恢复时：matchSessionMode 比较存储模式，不匹配则切换 env var

用户交互：
  → getCoordinatorSystemPrompt 注入提示：
    - 角色：coordinator，委派任务给 worker
    - 工具：AgentTool (spawn worker)、SendMessage (继续 worker)、TaskStop (停止 worker)
    - 工作流：spawn → 等待 <task-notification> → SendMessage 继续或汇总
  → getCoordinatorUserContext 添加上下文：
    - workerToolsContext：worker 可用工具列表、MCP 服务器、scratchpad 目录
  → coordinator 决策：
    - 并行 spawn 多个 AgentTool(run_in_background: true)
    - 结束当前 turn，等待 <task-notification> 用户消息
    - 收到通知后继续，SendMessage 跟进或汇总结果
```

**设计取舍**
- 取舍：通过系统提示定义协调器行为而非专用执行引擎
  - 理由：灵活可演进，利用 LLM 推理能力处理复杂协调
  - 代价：依赖提示质量，可能出错
- 取舍：coordinator 与 fork 互斥
  - 理由：coordinator 已有委派模型，fork 是另一种并行模式，避免混淆
  - 代价：用户需选择其一，不能同时使用

**源码测试证据**
- 实现：`src/coordinator/coordinatorMode.ts`
- 工具白名单：`src/constants/tools.ts` (ASYNC_AGENT_ALLOWED_TOOLS)
- 测试：未找到直接测试文件

---

### 4.6 模块与状态所有权（更新版）

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 | 设计文档位置 |
|---|---|---|---|---|---|
| `AgentTool` | agentId、autoBackground 状态、worktreeInfo | spawn agent、同步/异步执行、worktree 管理 | 子代理内部执行 | 调用 `runAgent`，写入 AppState | 4.2.1-4.2.3 |
| `forkSubagent` | fork boilerplate、cached prompt 前缀 | 构建 forked 消息、检测递归 fork | fork child 执行 | 调用 `runAgent` 时传入 `useExactTools` | 4.2.2 |
| `TeamCreateTool` / `TeamDeleteTool` | AppState.teamContext | 创建/解散团队、读写 teamFile | 团队成员执行 | 调用 `writeTeamFileAsync`、`cleanupTeamDirectories` | 4.3.1-4.3.2 |
| `SendMessageTool` | 待发送消息、路由状态 | 路由消息到本地 agent/团队成员/UDS/Bridge | 消息内容执行 | 调用 `writeToMailbox`、`resumeAgentBackground` | 4.3.3 |
| `teammateMailbox` | inbox 文件、lockfile | 读写消息、标记已读 | 消息内容解释 | 文件系统 I/O、lockfile | 4.4.2 |
| `teamHelpers` | TeamFile、team directory | 读写 teamFile、清理团队目录 | 团队业务逻辑 | JSON 序列化、文件系统 I/O | 4.4.1 |
| `inProcessRunner` | inProcessTeammate 状态、abortController | 执行 in-process worker、权限同步 | tmux/iTerm2 后端 | 调用 `runAgent`、leaderToolUseConfirmQueue | 4.4.3 |
| `permissionSync` | pending/resolved permission 文件 | 发送/响应权限请求 | 权限决策逻辑 | mailbox、leader permission bridge | 4.4.3 |
| `coordinatorMode` | coordinator 模式标志 | 协调 worker 执行、聚合结果 | 实际任务执行 | 系统提示注入、`<task-notification>` 解析 | 4.5.1 |

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
| AgentTool 四模式执行 | `src/tools/AgentTool/AgentTool.tsx:1-1669` | 未找到直接测试文件 | 未覆盖四种模式的完整组合 |
| AgentTool Fork 隐式子代理 | `src/tools/AgentTool/forkSubagent.ts:32-210` | 未找到直接测试文件 | feature('FORK_SUBAGENT') 可能未覆盖 |
| AgentTool Worktree 隔离 | `src/tools/AgentTool/AgentTool.tsx` (worktree 相关部分) + `src/utils/worktree.ts` | 未找到直接测试文件 | 未覆盖有变更保留 worktree 的场景 |
| TeamCreateTool 创建团队 | `src/tools/TeamCreateTool/TeamCreateTool.ts:1-241` | 未找到直接测试文件 | 未覆盖并发创建同名团队 |
| TeamDeleteTool 解散团队 | `src/tools/TeamDeleteTool/TeamDeleteTool.ts:1-139` | 未找到直接测试文件 | 未覆盖 member.isActive 的完整生命周期 |
| SendMessageTool 消息路由 | `src/tools/SendMessageTool/SendMessageTool.ts:1-800+` | 未找到直接测试文件 | 未覆盖 UDS/Bridge 跨机器路径 |
| TeamFile 状态持久化 | `src/utils/swarm/teamHelpers.ts:1-684` | 未找到直接测试文件 | 未覆盖并发读写 teamFile |
| Mailbox 文件邮箱系统 | `src/utils/teammateMailbox.ts:43-1142` | 未找到直接测试文件 | 未覆盖 tmux/iTerm2 后端的并发场景 |
| 双路径权限同步 | `src/utils/swarm/inProcessRunner.ts:1-600+` + `src/utils/swarm/permissionSync.ts:1-600+` + `src/utils/swarm/leaderPermissionBridge.ts` | 未找到直接测试文件 | 仅检查 in-process 路径，未测试 mailbox 路径 |
| Coordinator 模式协调 | `src/coordinator/coordinatorMode.ts:1-369` | 未找到直接测试文件 | 仅检查系统提示，未验证端到端协调 |
| Agent 内存快照管理 | `src/tools/AgentTool/agentMemorySnapshot.ts` + `src/tools/AgentTool/agentMemory.ts` | `tests/agentMemorySnapshot.test.ts`: 快照初始化、时间戳验证、保留变更、回滚机制、合并完成验证 | 未覆盖多 agent 同时合并的竞态场景 |

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
