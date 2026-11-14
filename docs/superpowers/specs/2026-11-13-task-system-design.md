---
id: task-system
batch: 5
title: Task System 任务状态、后台执行与生命周期设计
date: 2026-11-13
status: draft
---

# Task System 任务状态、后台执行与生命周期设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理""提高可靠性""保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

当用户需要执行长时间运行的命令、并行发起多个任务、或者让任务在后台继续执行而不阻塞当前交互时，同步执行会导致用户体验差、资源利用率低。如果让所有任务都共享内存状态，会产生竞态条件；如果完全独立进程，又会导致状态同步复杂。因此本子系统必须提供统一的任务抽象，支持多种任务类型，管理任务生命周期，处理后台化与通知，同时保持状态一致性。

约束：
- 兼容多种任务类型：`local_bash`、`local_agent`、`remote_agent`、`in_process_teammate`、`local_workflow`、`monitor_mcp`、`dream`
- 支持任务后台化，前台/后台状态切换
- 任务输出持久化到文件系统，支持增量读取
- 任务状态存储在 `AppState.tasks` 中，通过 `getAppState`/`setAppState` 访问
- 支持任务终止（kill），清理资源
- 任务通知通过 `<task-notification>` XML 标签传递
- Todo list 任务（TaskCreate/TaskUpdate 等）与后台执行任务是两个独立子系统，共享部分工具命名但不共享实现
- 不能吞并 Agent Swarms、Workflow 或 cron 的职责

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 任务 ID 带类型前缀 | `generateTaskId()` 生成 `{prefix}{random}`，前缀 `b/a/r/t/w/m/d` 对应各类型 | 调试时一眼识别任务类型，避免 ID 冲突，向后兼容 | UUID：可读性差；纯数字：无法识别类型 | 需要维护前缀映射表 | `src/Task.ts:82-110` |
| 任务输出写入独立文件 | `getTaskOutputPath()` 返回 `{projectTempDir}/{sessionId}/tasks/{taskId}.output`，`DiskTaskOutput` 异步写入 | 避免内存中累积大量输出，支持跨会话恢复，增量读取 | 仅内存：进程退出丢失；数据库：过度设计 | 文件 I/O 开销，需要处理并发写入 | `src/utils/task/diskOutput.ts:1-453` |
| 轮询而非事件驱动 | `pollTasks()` 每秒调用一次，`generateTaskAttachments()` 检查输出更新 | 简单可靠，不需要复杂的事件订阅机制，兼容所有任务类型 | 事件回调：实现复杂，可能内存泄漏；WebSocket：过度设计 | 轮询有延迟，CPU 周期性唤醒 | `src/utils/task/framework.ts:257-308` |
| 终端任务延迟驱逐 | `evictTerminalTask()` 检查 `notified` 和 `evictAfter`，LocalAgentTask 有 30 秒 grace period | 用户有时间查看完成的任务输出，避免立即消失导致困惑 | 立即驱逐：用户可能错过输出；永不驱逐：内存泄漏 | 需要管理 `evictAfter` 时间戳 | `src/utils/task/framework.ts:124-143` |
| AppState.tasks 按 ID 索引 | `Record<TaskId, TaskState>`，任务通过 ID 查找 | O(1) 查找，便于更新单个任务，避免数组遍历 | 数组：查找需要遍历，更新需要索引 | 需要确保 ID 唯一性 | `src/Task.ts:43-57` |
| 任务状态机：pending→running→terminal | `TaskStatus` 包括 pending/running/completed/failed/killed，`isTerminalTaskStatus()` 判断结束 | 清晰的状态转换，便于 UI 显示和逻辑判断 | 更细粒度状态：增加复杂度；布尔标记：难以追踪历史 | 需要处理状态转换的合法性 | `src/Task.ts:14-30` |
| Task 接口仅要求 kill | `Task` 接口只有 `name`/`type`/`kill()`，spawn/render 不在这里（22546 号 PR 移除） | 简化接口，kill 是唯一需要跨类型统一调用的操作；spawn/render 各类型差异大，统一接口反而复杂 | 统一 spawn/render：各类型参数差异大，接口难以设计 | 需要在各工具中分别处理 spawn | `src/Task.ts:71-80` |
| Todo list 任务持久化到 `~/.claude/tasks/{taskListId}/` | 每个任务一个 JSON 文件，high-water mark 防止 ID 重用，lockfile 保证原子读写 | 跨会话持久化，支持团队协作（同一 taskListId），并发安全 | 仅内存：进程退出丢失；数据库：过度设计 | 文件 I/O，锁竞争 | `src/utils/tasks.ts:1-861` |
| Todo list 任务与后台任务分离 | Todo list 任务有独立的 `Task` 类型和工具，后台任务在 `AppState.tasks` 中 | 两者概念不同：todo list 是规划工具，后台任务是执行机制；强行合并会导致概念混乱 | 统一任务模型：概念混淆，职责不清 | 用户可能混淆两种"任务" | `src/utils/tasks.ts:1-861` + `src/Task.ts:1-130` |
| 停止任务时 suppress bash 通知 | `stopTask()` 中检查 `isLocalShellTask()`，设置 `notified: true` 并直接 emit SDK 事件 | 避免"exit code 137"这样的噪音通知，用户主动停止不需要额外通知 | 始终通知：用户体验差；完全不通知：SDK 消费者收不到事件 | 需要类型判断分支 | `src/tasks/stopTask.ts:69-95` |
| 任务输出 cap 5GB | `MAX_TASK_OUTPUT_BYTES` 5GB，超过后截断并添加提示 | 防止无约束输出填满磁盘，同时保留足够的调试信息 | 无 cap：磁盘满风险；小 cap：调试信息不足 | 需要处理截断后的输出 | `src/utils/task/diskOutput.ts:29-31` |

## 3. 目标与非目标

### 状态与生命周期

**目标**：
- 拥有任务状态机（pending/running/completed/failed/killed）的完整管理
- 拥有任务 ID 生成与唯一性保证
- 拥有任务输出的持久化与增量读取
- 拥有任务的注册、更新、驱逐生命周期
- 拥有任务的后台化与前台恢复
- 拥有任务终止与资源清理

**非目标**：
- 不拥有 Agent Swarms 的团队协调逻辑（由 agent-swarms spec 负责）
- 不拥有 Workflow 的执行引擎（由 workflow 负责）
- 不拥有 cron 的调度逻辑（由 cronTasks 负责）
- 不拥有 Todo list 的业务逻辑（todo list 任务是独立子系统）

### 接口与数据

**目标**：
- 提供 `Task` 接口用于各任务类型实现
- 提供 `registerTask()`/`updateTaskState()`/`evictTerminalTask()` 等框架函数
- 提供 `pollTasks()`/`generateTaskAttachments()` 等轮询函数
- 提供 `stopTask()` 统一停止入口
- 提供 `DiskTaskOutput` 类处理输出写入
- 保证任务 ID 的唯一性和类型可识别性

**非目标**：
- 不提供跨机器任务调度
- 不保证任务执行的实时性（轮询有延迟）
- 不提供分布式任务队列

### 执行与环境

**目标**：
- 支持 CLI 环境下的所有任务类型
- 支持 SDK 环境下的任务创建与查询
- 支持任务后台执行，不阻塞主交互

**非目标**：
- 不支持 browser/electron 环境（除非后续扩展）
- 不保证任务的持久化执行（进程退出后未完成任务丢失）

### 依赖边界

- AppState：调用方提供 `getAppState`/`setAppState`，本文描述状态结构
- SDK events：调用 `enqueueSdkEvent()`，本文描述事件内容
- Message queue：调用 `enqueuePendingNotification()`，本文描述通知格式

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// Task 接口 - 各任务类型实现
interface Task {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState, getAppState?: () => AppState): Promise<void>
}

// TaskStateBase - 所有任务状态共享字段
interface TaskStateBase {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}

// TaskContext - 任务执行上下文
interface TaskContext {
  abortController: AbortController
  getAppState: () => AppState
  setAppState: SetAppState
}

// 框架函数
function registerTask(task: TaskState, setAppState: SetAppState): void
function updateTaskState<T extends TaskState>(taskId: string, setAppState: SetAppState, updater: (task: T) => T): void
function evictTerminalTask(taskId: string, setAppState: SetAppState): void
async function pollTasks(getAppState: () => AppState, setAppState: SetAppState): Promise<void>
async function stopTask(taskId: string, context: StopTaskContext): Promise<StopTaskResult>

// 输出管理
class DiskTaskOutput {
  constructor(taskId: string)
  append(content: string): void
  flush(): Promise<void>
  cancel(): void
}
function appendTaskOutput(taskId: string, content: string): void
async function flushTaskOutput(taskId: string): Promise<void>
async function getTaskOutputDelta(taskId: string, fromOffset: number, maxBytes?: number): Promise<{ content: string, newOffset: number }>
async function getTaskOutput(taskId: string, maxBytes?: number): Promise<string>
```

调用方通过工具调用（Bash/Agent 等）创建任务，注册到 `AppState.tasks`，任务执行过程中写入输出文件，框架每秒轮询检查更新，任务完成后发送 `<task-notification>`，最终从 AppState 中驱逐。

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `Task.ts` | TaskType/TaskStatus 定义、Task 接口、generateTaskId/createTaskStateBase | 任务基础类型、ID 生成、基础状态创建 | 具体任务实现 | 导出类型和函数供其他模块使用 |
| `tasks.ts` | getAllTasks() 注册表 | 按类型获取 Task 实现 | 任务执行 | 返回 Task[] 供 stopTask 使用 |
| `task/framework.ts` | 轮询逻辑、attachment 生成、任务注册/更新/驱逐 | registerTask/updateTaskState/evictTerminalTask/pollTasks/generateTaskAttachments | 具体任务类型实现 | 使用 getAppState/setAppState，调用 diskOutput |
| `task/diskOutput.ts` | outputs Map<taskId, DiskTaskOutput>、_pendingOps Set | initTaskOutput/appendTaskOutput/flushTaskOutput/getTaskOutputDelta/cleanupTaskOutput | 任务状态管理 | 文件系统 I/O |
| `task/TaskOutput.ts` | （未细读） | （未细读） |  |  |
| `task/outputFormatting.ts` | （未细读） | （未细读） |  |  |
| `task/sdkProgress.ts` | （未细读） | （未细读） |  |  |
| `stopTask.ts` | （无状态） | stopTask() | 任务启动 | 调用 getTaskByType().kill() |
| `tasks/LocalShellTask/` | LocalShellTaskState、child process | spawn、kill | 其他任务类型 | 使用 setAppState 更新状态 |
| `tasks/LocalAgentTask/` | LocalAgentTaskState、agent messages | spawn、kill、resume | 其他任务类型 | 使用 setAppState 更新状态 |
| `tasks/RemoteAgentTask/` | RemoteAgentTaskState | kill | 其他任务类型 |  |
| `tasks/InProcessTeammateTask/` | InProcessTeammateTaskState | 消息追加 | 其他任务类型 |  |
| `tasks/LocalWorkflowTask/` | （未细读） | （未细读） |  |  |
| `tasks/MonitorMcpTask/` | （未细读） | （未细读） |  |  |
| `tasks/DreamTask/` | （未细读） | （未细读） |  |  |
| `tasks/LocalMainSessionTask.ts` | （未细读） | （未细读） |  |  |
| `utils/tasks.ts` | tasksUpdated signal、leaderTeamName | createTask/getTask/updateTask/deleteTask/listTasks/claimTask/resetTaskList | 后台任务管理 | 文件系统 I/O、lockfile |
| `tools/TaskCreateTool/` | （无状态） | TaskCreateTool.call() | 后台任务 | 调用 createTask() |
| `tools/TaskGetTool/` | （无状态） | TaskGetTool.call() | 后台任务 | 调用 getTask() |
| `tools/TaskListTool/` | （无状态） | TaskListTool.call() | 后台任务 | 调用 listTasks() |
| `tools/TaskUpdateTool/` | （无状态） | TaskUpdateTool.call() | 后台任务 | 调用 updateTask()/claimTask()/blockTask() |
| `tools/TaskStopTool/` | （无状态） | TaskStopTool.call() | Todo list 任务 | 调用 stopTask() |
| `tools/TaskOutputTool/` | （未细读） | （未细读） |  |  |
| `tools/TodoWriteTool/` | （未细读） | （未细读） |  |  |

状态设计理由：
- 任务状态集中在 `AppState.tasks`：统一访问点，便于 UI 渲染和框架处理
- 任务输出分散在独立文件：避免 AppState 过大，支持增量读取
- Todo list 任务独立存储：与后台任务概念分离，避免混淆

复制与共享：
- 任务状态更新通过 `setAppState(prev => ({ ...prev, tasks: { ...prev.tasks, [taskId]: updated } }))` 不可变更新
- 任务输出文件路径共享，写入通过 `DiskTaskOutput` 队列化
- Todo list 任务通过文件系统共享，支持多进程访问

重置与清理：
- 终端任务在 `notified: true` 且 grace period 过后被 `evictTerminalTask()` 移除
- 任务输出文件在 `cleanupTaskOutput()` 时删除
- Todo list 任务在 `resetTaskList()` 时清空并更新 high-water mark
- `DiskTaskOutput` 在 `evictTaskOutput()` 时从内存 map 中移除

### 4.3 主控制流

#### LocalShellTask 创建与执行（典型路径）

```text
用户输入 Bash 命令（或通过工具调用）
  → 构建 LocalShellTaskState，调用 createTaskStateBase()
  → initTaskOutput(taskId)：创建空输出文件
  → registerTask(task, setAppState)：添加到 AppState.tasks
  → spawn child process：child_process.spawn()
  → 更新状态为 running：updateTaskState()
  → child process stdout/stderr：appendTaskOutput()
  → child process exit：
    → 更新状态为 completed/failed
    → 设置 endTime
    → enqueuePendingNotification() 发送 <task-notification>
  → 轮询循环 pollTasks() 每秒执行：
    → generateTaskAttachments()：检查输出更新
    → applyTaskOffsetsAndEvictions()：更新 outputOffset，驱逐已通知的终端任务
```

#### 任务后台化与前台恢复

```text
前台任务状态：isBackgrounded = false，在 UI 中显示为活跃
  → 用户触发后台化（如点击后台按钮）
  → updateTaskState() 设置 isBackgrounded = true
  → 任务继续执行，UI 显示为后台任务
  → 用户点击恢复：
    → updateTaskState() 设置 isBackgrounded = false
    → UI 重新显示为前台任务
```

#### 任务停止

```text
用户调用 TaskStopTool({ task_id }) 或 SDK stop_task
  → stopTask()：
    → 验证任务存在且状态为 running
    → getTaskByType(task.type) 获取 Task 实现
    → 调用 task.kill(taskId, setAppState, getAppState)
    → LocalShellTask.kill()：发送 SIGTERM 到 child process
    → LocalAgentTask.kill()：abortController.abort()
    → 对于 LocalShellTask：设置 notified = true，直接 emit SDK event
  → 更新任务状态为 killed
  → 最终被 evictTerminalTask() 从 AppState 移除
```

#### Todo list 任务创建与更新

```text
用户调用 TaskCreateTool({ subject, description, ... })
  → getTaskListId()：确定任务列表 ID（sessionId/teamName/CLAUDE_CODE_TASK_LIST_ID）
  → ensureTasksDir()：确保目录存在
  → lockfile.lock()：获取列表级锁
  → findHighestTaskId()：读取现有任务和 high-water mark
  → 创建 Task 文件：{id, subject, description, status: 'pending', ...}
  → notifyTasksUpdated()：触发信号
  → 释放锁
  → 执行 TaskCreated hooks

用户调用 TaskUpdateTool({ taskId, status: 'in_progress', ... })
  → 验证任务存在
  → lockfile.lock(taskPath)：获取任务级锁
  → updateTaskUnsafe()：更新任务文件
  → 状态为 'completed' 时执行 TaskCompleted hooks
  → 释放锁
  → notifyTasksUpdated()
```

#### 任务通知与 SDK 事件

```text
任务完成/失败/被杀死
  → enqueuePendingNotification()：
    → 构建 <task-notification> XML：
      <task-notification>
        <task-id>{taskId}</task-id>
        <tool-use-id>{toolUseId}</tool-use-id>
        <task-type>{type}</task-type>
        <output-file>{outputFile}</output-file>
        <status>{status}</status>
        <summary>{description} {statusText}</summary>
      </task-notification>
  → 消息队列在下一个 turn 发送给模型
  → enqueueSdkEvent()：同时发送 SDK 事件（task_started/task_finished）
```

### 4.4 数据结构与持久化

#### TaskStateBase（内存 + 输出文件）

```typescript
interface TaskStateBase {
  id: string                          // {prefix}{random}，如 b1a2b3c4
  type: TaskType                      // local_bash | local_agent | ...
  status: TaskStatus                  // pending | running | completed | failed | killed
  description: string                 // 任务描述，用于 UI 显示
  toolUseId?: string                  // 关联的 tool use ID，用于匹配请求
  startTime: number                   // 毫秒时间戳
  endTime?: number                    // 毫秒时间戳，terminal 状态时设置
  totalPausedMs?: number              // 总暂停时间（毫秒）
  outputFile: string                  // 输出文件路径
  outputOffset: number                // 已读取的字节偏移，用于增量读取
  notified: boolean                   // 是否已发送通知
}
```

存储：`AppState.tasks[taskId]`；输出文件：`getTaskOutputPath(taskId)`。

#### 各类型特有的 TaskState

```typescript
// LocalShellTaskState
interface LocalShellTaskState extends TaskStateBase {
  type: 'local_bash'
  command: string
  cwd: string
  exitCode?: number | null
  signal?: string | null
  kind?: 'bash' | 'monitor'
}

// LocalAgentTaskState
interface LocalAgentTaskState extends TaskStateBase {
  type: 'local_agent'
  agentId: AgentId
  messages: AgentMessage[]
  retain: boolean
  evictAfter?: number
  diskLoaded?: boolean
  isBackgrounded?: boolean
  pendingMessages?: AgentMessage[]
  // ... 更多字段
}

// RemoteAgentTaskState
interface RemoteAgentTaskState extends TaskStateBase {
  type: 'remote_agent'
  sessionUrl?: string
  // ... 更多字段
}

// InProcessTeammateTaskState
interface InProcessTeammateTaskState extends TaskStateBase {
  type: 'in_process_teammate'
  agentName?: string
  agentColor?: string
  // ... 更多字段
}

// ... 其他类型类似
```

#### Todo list Task（持久化 JSON）

```typescript
interface Task {
  id: string
  subject: string
  description: string
  activeForm?: string
  owner?: string
  status: 'pending' | 'in_progress' | 'completed'
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
}
```

存储位置：`~/.claude/tasks/{taskListId}/{taskId}.json`。

#### TeamFile（Todo list 团队任务用）

```typescript
// 与 agent-swarms spec 中的 TeamFile 相同
interface TeamFile {
  name: string
  leadAgentId: string
  members: Array<{ agentId: string, name: string, ... }>
  // ... 更多字段
}
```

存储位置：`~/.claude/teams/{teamName}/config.json`（Todo list 用 teamName 作为 taskListId）。

#### High-water mark（Todo list 用）

```typescript
// 存储最后使用的最大 ID，防止重置后重用
type HighWaterMark = number
```

存储位置：`~/.claude/tasks/{taskListId}/.highwatermark`。

#### AppState 中的任务状态（内存）

```typescript
interface AppState {
  // ...
  tasks: Record<string, TaskState>
  expandedView?: 'tasks' | null
  agentNameRegistry: Map<string, AgentId>
  // ...
}
```

恢复：启动时从 session storage 恢复 agent 状态；Todo list 任务总是从文件读取。

不可持久化字段：
- `abortController`：内存对象
- `child process`：系统资源
- `DiskTaskOutput` 内部队列：内存状态

### 4.5 核心模块设计卡

#### 模块：Task (src/Task.ts)

**真实入口签名与关键类型：**
```typescript
export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'remote_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'monitor_mcp'
  | 'dream'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

export function isTerminalTaskStatus(status: TaskStatus): boolean

export interface Task {
  name: string
  type: TaskType
  kill(
    taskId: string,
    setAppState: SetAppState,
    getAppState?: () => AppState,
  ): Promise<void>
}

export interface TaskStateBase {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}

export function generateTaskId(type: TaskType): string
export function createTaskStateBase(
  id: string,
  type: TaskType,
  description: string,
  toolUseId?: string,
): TaskStateBase
```

**输入输出：**
- 输入：任务类型、描述、toolUseId（可选）
- 输出：任务ID、TaskStateBase 对象

**任务状态与生命周期：**
- 状态机：pending → running → {completed | failed | killed}
- isTerminalTaskStatus() 用于判断任务是否结束
- 只定义契约，不负责执行

**创建/执行/输出/清理流程：**
1. generateTaskId()：生成带类型前缀的任务ID
2. createTaskStateBase()：创建基础任务状态
3. 由具体任务类型实现 spawn/kill
4. 状态更新通过 framework.ts 的 updateTaskState()

**错误与并发：**
- 无内部错误处理，由调用方负责
- ID 生成使用 crypto.randomBytes，避免冲突
- 前缀映射表：local_bash→'b', local_agent→'a', remote_agent→'r', in_process_teammate→'t', local_workflow→'w', monitor_mcp→'m', dream→'d'

**设计取舍与备选：**
- 取舍：Task 接口只保留 kill()，移除 spawn/render（22546 号 PR）
- 理由：各类型 spawn/render 差异大，统一接口反而复杂
- 备选：UUID 替代带前缀 ID → 可读性差

**源码测试证据：**
- src/Task.ts:1-130（类型定义、generateTaskId、createTaskStateBase）
- 无专用测试，集成在各任务类型测试中

---

#### 模块：DiskTaskOutput (src/utils/task/diskOutput.ts)

**真实入口签名与关键类型：**
```typescript
export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024  // 5GB
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB'

export class DiskTaskOutput {
  constructor(taskId: string)
  append(content: string): void
  flush(): Promise<void>
  cancel(): void
}

export function getTaskOutputDir(): string
export function getTaskOutputPath(taskId: string): string
export function initTaskOutput(taskId: string): Promise<string>
export function initTaskOutputAsSymlink(taskId: string, targetPath: string): Promise<string>
export function appendTaskOutput(taskId: string, content: string): void
export async function flushTaskOutput(taskId: string): Promise<void>
export async function getTaskOutputDelta(
  taskId: string,
  fromOffset: number,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<{ content: string; newOffset: number }>
export async function getTaskOutput(
  taskId: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<string>
export async function getTaskOutputSize(taskId: string): Promise<number>
export async function cleanupTaskOutput(taskId: string): Promise<void>
export function evictTaskOutput(taskId: string): Promise<void>
```

**输入输出：**
- 输入：任务ID、内容字符串
- 输出：输出文件路径、增量内容、文件大小
- 存储位置：`{projectTempDir}/{sessionId}/tasks/{taskId}.output`

**任务状态与生命周期：**
- initTaskOutput：创建空文件（O_CREAT|O_EXCL|O_NOFOLLOW）
- appendTaskOutput：追加内容到队列，异步写入
- flushTaskOutput：等待队列排空
- evictTaskOutput：从内存 map 移除（不删除文件）
- cleanupTaskOutput：删除文件并清理内存

**创建/执行/输出/清理流程：**
1. initTaskOutput()：创建空文件，返回路径
2. appendTaskOutput()：获取或创建 DiskTaskOutput 实例，调用 append()
3. append()：检查 5GB 限制，超限后添加截断提示
4. #drainAllChunks()：异步写入队列，失败后重试一次
5. getTaskOutputDelta()：读取文件从 offset 开始的增量内容
6. getTaskOutput()：读取文件尾部，大文件添加省略提示

**错误与并发：**
- SECURITY：O_NOFOLLOW 防止符号链接攻击
- 内部错误：logError，不向外抛
- 队列并发：单线程写入，#queue 数组作为缓冲区
- _pendingOps Set 跟踪异步操作，防止测试 teardown 后 ENOENT
- 测试用：_clearOutputsForTest() 取消写入、等待 ops 完成、清空 map

**设计取舍与备选：**
- 取舍：5GB 硬编码限制
- 理由：防止无约束输出填满磁盘，保留足够调试信息
- 备选：可配置 cap → 增加复杂度
- 取舍：轮询而非事件驱动
- 理由：简单可靠，兼容所有任务类型
- 备选：事件回调 → 实现复杂，可能内存泄漏

**源码测试证据：**
- src/utils/task/diskOutput.ts:1-453
- 无专用测试，集成在 LocalShellTask 测试中

---

#### 模块：Task Framework (src/utils/task/framework.ts)

**真实入口签名与关键类型：**
```typescript
export const POLL_INTERVAL_MS = 1000
export const STOPPED_DISPLAY_MS = 3_000
export const PANEL_GRACE_MS = 30_000

export type TaskAttachment = {
  type: 'task_status'
  taskId: string
  toolUseId?: string
  taskType: TaskType
  status: TaskStatus
  description: string
  deltaSummary: string | null
}

export function registerTask(task: TaskState, setAppState: SetAppState): void
export function updateTaskState<T extends TaskState>(
  taskId: string,
  setAppState: SetAppState,
  updater: (task: T) => T,
): void
export function evictTerminalTask(taskId: string, setAppState: SetAppState): void
export function getRunningTasks(state: AppState): TaskState[]
export async function generateTaskAttachments(state: AppState): Promise<{
  attachments: TaskAttachment[]
  updatedTaskOffsets: Record<string, number>
  evictedTaskIds: string[]
}>
export function applyTaskOffsetsAndEvictions(
  setAppState: SetAppState,
  updatedTaskOffsets: Record<string, number>,
  evictedTaskIds: string[],
): void
export async function pollTasks(
  getAppState: () => AppState,
  setAppState: SetAppState,
): Promise<void>
```

**输入输出：**
- 输入：AppState、SetAppState、updater 函数
- 输出：TaskAttachment[]、updatedTaskOffsets、evictedTaskIds

**任务状态与生命周期：**
- registerTask：注册新任务，是替换（resume）时不重复 emit task_started
- updateTaskState：不可变更新单个任务，updater 返回相同引用时跳过
- evictTerminalTask：立即驱逐已通知且结束的任务
- pollTasks：每秒轮询，生成附件、应用偏移、驱逐
- generateTaskAttachments：不发送 completed 通知（各类型自己处理）

**创建/执行/输出/清理流程：**
1. registerTask() → 检查是否替换 → emit task_started SDK 事件
2. pollTasks() → generateTaskAttachments() → applyTaskOffsetsAndEvictions()
3. generateTaskAttachments()：读取 running 任务增量输出，标记 terminal+notified 任务驱逐
4. applyTaskOffsetsAndEvictions()：对 fresh state 操作，避免 TOCTOU 竞态
5. evictTerminalTask()：检查 grace period（LocalAgentTask 有 30s）

**错误与并发：**
- 并发安全：所有更新通过 setAppState 的 updater 函数，对 fresh state 操作
- TOCTOU 防护：generateTaskAttachments 读取时的状态与 apply 时的状态可能不同，apply 时重新检查
- LocalAgentTask 优雅期：'retain' in task 且 (task.evictAfter ?? Infinity) > Date.now() 时不驱逐

**设计取舍与备选：**
- 取舍：终端任务延迟驱逐
- 理由：用户有时间查看完成的任务输出
- 备选：立即驱逐 → 用户可能错过输出
- 取舍：轮询间隔 1 秒
- 理由：平衡响应性与 CPU 使用率
- 备选：事件驱动 → 复杂度高

**源码测试证据：**
- src/utils/task/framework.ts:1-308
- 无专用测试，集成在端到端测试中

---

#### 模块：stopTask (src/tasks/stopTask.ts)

**真实入口签名与关键类型：**
```typescript
export class StopTaskError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'not_running' | 'unsupported_type',
  )
}

interface StopTaskContext {
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

interface StopTaskResult {
  taskId: string
  taskType: string
  command: string | undefined
}

export async function stopTask(
  taskId: string,
  context: StopTaskContext,
): Promise<StopTaskResult>
```

**输入输出：**
- 输入：taskId、StopTaskContext（getAppState、setAppState）
- 输出：StopTaskResult（taskId、taskType、command）
- 异常：StopTaskError（not_found | not_running | unsupported_type）

**任务状态与生命周期：**
- 验证任务存在且 running
- getTaskByType() 获取对应 Task 实现
- 调用 task.kill()
- LocalShellTask 特殊处理：设置 notified=true，直接 emit SDK 事件，抑制 bash 通知

**创建/执行/输出/清理流程：**
1. 从 AppState.tasks 查找任务
2. 验证任务存在且 status === 'running'
3. getTaskByType() 获取实现
4. task.kill(taskId, setAppState, getAppState)
5. LocalShellTask：标记 notified=true，emitTaskTerminatedSdk
6. 返回 StopTaskResult

**错误与并发：**
- StopTaskError 区分三种失败原因
- 并发安全：kill 内部通过 updateTaskState 原子更新
- suppress 通知：避免用户主动停止任务后看到 "exit code 137" 噪音

**设计取舍与备选：**
- 取舍：LocalShellTask suppress 通知，其他类型不 suppress
- 理由：LocalAgentTask 的 AbortError 通知携带 extractPartialResult，不是噪音
- 备选：统一 suppress → SDK 消费者收不到有用信息

**源码测试证据：**
- src/tasks/stopTask.ts:1-100
- 无专用测试，集成在 TaskStopTool 测试中

---

### 4.6 任务类型实现设计卡

#### 模块：LocalShellTask (src/tasks/LocalShellTask/)

**真实入口签名与关键类型：**
```typescript
export type BashTaskKind = 'bash' | 'monitor'

export interface LocalShellTaskState extends TaskStateBase {
  type: 'local_bash'
  command: string
  result?: { code: number; interrupted: boolean }
  completionStatusSentInAttachment: boolean
  shellCommand: ShellCommand | null
  unregisterCleanup?: () => void
  cleanupTimeoutId?: NodeJS.Timeout
  lastReportedTotalLines: number
  isBackgrounded: boolean
  agentId?: AgentId
  kind?: BashTaskKind
}

export function isLocalShellTask(task: unknown): task is LocalShellTaskState
export function looksLikePrompt(tail: string): boolean
export const BACKGROUND_BASH_SUMMARY_PREFIX = 'Background command '
```

**输入输出：**
- 输入：LocalShellSpawnInput（command、description、timeout、toolUseId、agentId、kind）
- 输出：TaskHandle、输出文件、<task-notification>

**任务状态与生命周期：**
- pending → running → {completed | failed | killed}
- isBackgrounded：false=前台，true=后台
- stall watchdog：每 5 秒检查输出增长，45 秒无增长且尾行像 prompt 时发送通知
- completion notification：各类型自己发送，不在 framework 中

**创建/执行/输出/清理流程：**
1. initTaskOutput()：创建输出文件
2. createTaskStateBase() + type-specific fields
3. registerTask()：添加到 AppState.tasks，emit task_started
4. spawn child process：stdout/stderr → appendTaskOutput()
5. startStallWatchdog()：监控输出停滞
6. child exit：updateTaskState() → enqueuePendingNotification()
7. 最终被 evictTerminalTask() 驱逐

**错误与并发：**
- spawn 失败：更新状态为 failed
- 超时：kill 子进程
- stall 检测：启发式匹配 (y/n)、[y/n]、(yes/no)、Do you...?、Press any key、Continue?、Overwrite?
- monitor 类型：UI 显示 description 而非 command

**设计取舍与备选：**
- 取舍：启发式 stall 检测
- 理由：避免对所有慢命令噪音，只在看起来像 interactive prompt 时通知
- 备选：总是通知 → 用户体验差
- 取舍：'bash' 与 'monitor' 两种 kind
- 理由：monitor 任务用于后台监控，UI 显示不同

**源码测试证据：**
- src/tasks/LocalShellTask/guards.ts:1-42
- src/tasks/LocalShellTask/LocalShellTask.tsx:1-18969
- src/tasks/LocalShellTask/killShellTasks.ts:1-100
- 无专用测试，集成在 shell 工具测试中

---

#### 模块：LocalAgentTask (src/tasks/LocalAgentTask/)

**真实入口签名与关键类型：**
```typescript
export interface LocalAgentTaskState extends TaskStateBase {
  type: 'local_agent'
  agentId: AgentId
  messages: AgentMessage[]
  retain: boolean
  evictAfter?: number
  diskLoaded?: boolean
  isBackgrounded?: boolean
  pendingMessages?: AgentMessage[]
  workflowName?: string
  prompt?: string
}

export interface ToolActivity {
  toolName: string
  input: Record<string, unknown>
  activityDescription?: string
  isSearch?: boolean
  isRead?: boolean
}

export interface AgentProgress {
  toolUseCount: number
  tokenCount: number
  lastActivity?: ToolActivity
  recentActivities?: ToolActivity[]
  summary?: string
}

export function isLocalAgentTask(task: unknown): task is LocalAgentTaskState
export function backgroundAgentTask(taskId: string, setAppState: SetAppState): void
```

**输入输出：**
- 输入：agent 定义、prompt、工作目录等
- 输出：agent 消息序列、输出文件（符号链接到 transcript）、SDK progress 事件

**任务状态与生命周期：**
- pending → running → {completed | failed | killed}
- retain：用户保留在 UI 中，不自动驱逐
- evictAfter：结束后 30 秒优雅期
- diskLoaded：从磁盘恢复状态标记
- isBackgrounded：前后台切换
- pendingMessages：resume 时待追加的消息

**创建/执行/输出/清理流程：**
1. initTaskOutputAsSymlink()：链接到 agent transcript 文件
2. createTaskStateBase() + agent-specific fields
3. registerTask()：替换 resume 时保留 UI 状态（retain、startTime、messages、diskLoaded、pendingMessages）
4. agent 执行循环：调用 tools，追加消息
5. emitTaskProgress()：发送 SDK progress 事件
6. 完成/失败/killed：updateTaskState()，设置 evictAfter=Date.now()+PANEL_GRACE_MS
7. 最终被 evictTerminalTask() 驱逐（优雅期后）

**错误与并发：**
- AbortError：捕获后更新状态为 killed/failed
- resume 替换任务：保留 UI 相关字段，避免用户体验跳变
- progress 跟踪：input_tokens 取最新（API 是累积的），output_tokens 求和

**设计取舍与备选：**
- 取舍：resume 时替换整个任务而非更新
- 理由：简化状态管理，通过 registerTask 的合并逻辑保留 UI 状态
- 备选：增量更新 → 复杂度高
- 取舍：30 秒优雅期
- 理由：用户有时间查看完成的 agent 对话

**源码测试证据：**
- src/tasks/LocalAgentTask/LocalAgentTask.tsx:1-23501
- 无专用测试，集成在 AgentTool 测试中

---

#### 模块：Todo Tasks (src/utils/tasks.ts)

**真实入口签名与关键类型：**
```typescript
export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const

export interface Task {
  id: string
  subject: string
  description: string
  activeForm?: string
  owner?: string
  status: 'pending' | 'in_progress' | 'completed'
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
}

export function isTodoV2Enabled(): boolean
export function getTaskListId(): string
export function sanitizePathComponent(input: string): string
export function getTasksDir(taskListId: string): string
export function getTaskPath(taskListId: string, taskId: string): string
export async function ensureTasksDir(taskListId: string): Promise<void>
export async function resetTaskList(taskListId: string): Promise<void>
export async function createTask(
  taskListId: string,
  taskData: Omit<Task, 'id'>,
): Promise<string>
export async function getTask(
  taskListId: string,
  taskId: string,
): Promise<Task | null>
export async function updateTask(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null>
export async function deleteTask(
  taskListId: string,
  taskId: string,
): Promise<boolean>
export async function listTasks(taskListId: string): Promise<Task[]>
export async function blockTask(
  taskListId: string,
  fromTaskId: string,
  toTaskId: string,
): Promise<boolean>

export interface ClaimTaskResult {
  success: boolean
  reason?: 'task_not_found' | 'already_claimed' | 'already_resolved' | 'blocked' | 'agent_busy'
  task?: Task
  busyWithTasks?: string[]
  blockedByTasks?: string[]
}
export async function claimTask(
  taskListId: string,
  taskId: string,
  claimantAgentId: string,
  options: ClaimTaskOptions = {},
): Promise<ClaimTaskResult>

export const tasksUpdated = createSignal()
export function setLeaderTeamName(teamName: string): void
export function clearLeaderTeamName(): void
export const onTasksUpdated = tasksUpdated.subscribe
export function notifyTasksUpdated(): void
```

**输入输出：**
- 输入：taskListId、taskData、updates、claimantAgentId
- 输出：taskId、Task、ClaimTaskResult、boolean
- 存储位置：`~/.claude/tasks/{taskListId}/{taskId}.json`
- 高水位标记：`~/.claude/tasks/{taskListId}/.highwatermark`

**任务状态与生命周期：**
- 状态：pending → in_progress → completed
- owner：认领的 agent ID
- blocks/blockedBy：任务依赖图
- high-water mark：防止 reset 后重用 ID

**创建/执行/输出/清理流程：**
1. getTaskListId()：优先级 CLAUDE_CODE_TASK_LIST_ID > teammateCtx.teamName > CLAUDE_CODE_TEAM_NAME > leaderTeamName > sessionId
2. ensureTaskListLockFile()：创建 .lock 文件（wx 标志）
3. lockfile.lock()：获取锁（重试 30 次，间隔 5-100ms）
4. findHighestTaskId()：从现有文件和 high-water mark 取最大值
5. writeFile()：创建 {id}.json
6. notifyTasksUpdated()：触发 signal
7. release lock
8. update/delete/claim 类似：先获取锁，再操作

**错误与并发：**
- 锁竞争：LOCK_OPTIONS 重试 30 次，minTimeout 5ms，maxTimeout 100ms
- 锁级别：list-level lock（resetTaskList、claimTaskWithBusyCheck），task-level lock（updateTask、claimTask）
- TOCTOU 防护：claimTaskWithBusyCheck 使用 list-level lock 原子检查 agent busy + claim
- 删除任务：更新 high-water mark，删除其他任务中的引用
- 旧状态迁移：ant 用户从 open/resolved 迁移到 pending/completed

**设计取舍与备选：**
- 取舍：Todo list 任务与后台任务分离
- 理由：Todo list 是规划工具，后台任务是执行机制，概念不同
- 备选：统一任务模型 → 概念混淆，职责不清
- 取舍：文件系统持久化而非数据库
- 理由：简单，跨进程共享，易于调试
- 备选：SQLite → 过度设计
- 取舍：lockfile + 重试而非乐观并发控制
- 理由：安全，避免竞态条件
- 备选：无锁 → 可能冲突

**源码测试证据：**
- src/utils/tasks.ts:1-861
- 无专用测试，集成在 TaskCreateTool/TaskUpdateTool 测试中

---

### 4.7 补充：未细读的任务类型

以下模块存在但未细读，其设计由对应 spec 覆盖：
- RemoteAgentTask：由 agent-swarms spec 覆盖
- InProcessTeammateTask：由 agent-swarms spec 覆盖
- LocalWorkflowTask：由 workflow spec 覆盖
- MonitorMcpTask：由 mcp spec 覆盖
- DreamTask：无独立 spec
- LocalMainSessionTask：无独立 spec

这些类型遵循相同的 Task 接口契约：实现 kill()，状态更新通过 updateTaskState()，输出通过 DiskTaskOutput，生命周期由 framework.ts 管理。

---

### 4.8 跨子系统依赖

| 依赖方向 | 模块 | 职责描述 | 主设计 spec |
|---|---|---|---|
| 上游 | query-core | Agent 执行主循环 | query-core spec |
| 上游 | agent-swarms | 团队任务、in-process teammate | agent-swarms spec |
| 上游 | bash execution | LocalShellTask 具体实现 | shell-tools spec |
| 上游 | mcp | MonitorMcpTask | mcp spec |
| 下游 | SDK events | 任务事件发送 | sdk-query-sessions spec |
| 下游 | message queue | 通知发送 | query-core spec |
| 下游 | UI components | 任务列表、任务详情、后台指示器 | 其他 spec |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| 任务输出文件写入失败 | `DiskTaskOutput.#drain()` | catch 并 logError，重试一次后放弃 | 内部重试一次 | 队列保留，不清理 | 调用方无感知，输出可能不完整 |
| 任务输出文件读取失败 | `getTaskOutputDelta()` | catch 并 logError，返回空内容 | 否 | 无 | 返回 `{ content: '', newOffset: fromOffset }` |
| 任务不存在（stopTask） | `stopTask()` | 抛出 `StopTaskError`，code: 'not_found' | 否 | 无 | 异常向上抛出 |
| 任务未运行（stopTask） | `stopTask()` | 抛出 `StopTaskError`，code: 'not_running' | 否 | 无 | 异常向上抛出 |
| 任务类型不支持（stopTask） | `stopTask()` | 抛出 `StopTaskError`，code: 'unsupported_type' | 否 | 无 | 异常向上抛出 |
| Todo list 锁竞争 | `lockfile.lock()` | catch 并在 LOCK_OPTIONS 内重试 | 内部重试 30 次，间隔 5-100ms | 无 | 调用方等待后成功或超时失败 |
| Todo list 任务文件不存在 | `getTask()` | catch 并返回 null | 否 | 无 | 返回 null |
| Todo list 任务 JSON 解析失败 | `getTask()` | catch 并 logError，返回 null | 否 | 无 | 返回 null |
| TaskCreated hook 阻塞错误 | `TaskCreateTool.call()` | 收集 blockingErrors，删除任务，抛出 Error | 否 | 删除刚创建的任务文件 | 异常向上抛出 |
| TaskCompleted hook 阻塞错误 | `TaskUpdateTool.call()` | 收集 blockingErrors，返回 success: false | 否 | 不回滚任务状态更新 | 返回 `{ success: false, error: '...' }` |
| Child process spawn 失败 | LocalShellTask | catch 并更新状态为 failed | 否 | 清理 abortController，记录 endTime | 任务状态 failed，输出包含错误信息 |
| Agent 执行被 abort | LocalAgentTask | catch AbortError，更新状态为 killed/failed | 否 | 清理 abortController，标记 notified | 任务状态 killed/failed，发送通知 |

工程取舍：
- **轮询 vs 事件驱动**：轮询简单可靠但有延迟；事件驱动实时但复杂。选择轮询。
- **任务输出文件 vs 内存**：文件持久化但有 I/O 开销；内存快但进程退出丢失。选择文件。
- **Todo list 与后台任务分离 vs 统一**：分离清晰但可能混淆；统一简单但概念混乱。选择分离。
- **Lockfile vs 无锁**：Lockfile 安全但有竞争；无锁快但可能冲突。选择 lockfile。
- **5GB 输出 cap vs 无限制**：有 cap 安全但可能丢失信息；无限制灵活但有磁盘风险。选择 cap。

## 6. 现状验收标准

1. 给定初始 AppState，创建 LocalShellTask 执行 `echo hello`，必须：
   - 在 `AppState.tasks` 中注册任务，状态 pending → running → completed
   - 在任务输出目录创建 `{taskId}.output` 文件，内容包含 `hello`
   - 发送 `<task-notification>` 通知
   - 最终任务从 AppState 中驱逐（延迟后）
   - 不得泄漏文件句柄或内存

2. 给定运行中的 LocalShellTask（如 `sleep 10`），执行 TaskStopTool，必须：
   - 任务状态变为 killed
   - Child process 被终止
   - 不发送多余的通知（suppress bash 通知）
   - SDK 事件正确发送
   - 最终任务从 AppState 中驱逐

3. 给定 Todo list 任务，执行 TaskCreate → TaskUpdate(status: 'in_progress') → TaskUpdate(status: 'completed')，必须：
   - 在 `~/.claude/tasks/{taskListId}/` 下创建任务文件
   - 任务状态正确更新
   - TaskCreated/TaskCompleted hooks 被执行
   - notifyTasksUpdated() 信号被触发
   - 并发创建多个任务时 ID 不冲突

4. 给定 Todo list 任务，执行 deleteTask，必须：
   - 任务文件被删除
   - high-water mark 被更新（如需要）
   - 其他任务的 blocks/blockedBy 引用被清理
   - notifyTasksUpdated() 信号被触发

5. 给定有输出的任务，调用 getTaskOutputDelta(fromOffset)，必须：
   - 返回从偏移开始的新内容
   - 返回正确的 newOffset
   - 不修改文件内容
   - 大文件时不超过 maxBytes 限制

6. 给定 terminal 且 notified 的任务，调用 evictTerminalTask，必须：
   - 任务从 AppState.tasks 中移除
   - LocalAgentTask 且 evictAfter 未到时不移除
   - 非 terminal 任务不移除
   - 未 notified 任务不移除

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 任务 ID 带类型前缀 | `src/Task.ts:82-110` | 未找到直接测试 | 已验证类型定义和前缀映射 |
| 任务输出写入独立文件 | `src/utils/task/diskOutput.ts:1-453` | 未找到直接测试 | 已验证 DiskTaskOutput 队列化写入、5GB cap、O_NOFOLLOW 安全机制 |
| 轮询而非事件驱动 | `src/utils/task/framework.ts:257-308` | 未找到直接测试 | 已验证 pollTasks 每秒执行、generateTaskAttachments 生成增量、applyTaskOffsetsAndEvictions 避免 TOCTOU |
| 终端任务延迟驱逐 | `src/utils/task/framework.ts:124-143` | 未找到直接测试 | 已验证 evictTerminalTask 检查 notified + terminal，LocalAgentTask 有 30s grace period（PANEL_GRACE_MS） |
| AppState.tasks 按 ID 索引 | `src/Task.ts:43-57` + `src/utils/task/framework.ts:48-71` | 未找到直接测试 | 已验证类型定义和 registerTask/updateTaskState 实现 |
| 任务状态机 | `src/Task.ts:14-30` | 未找到直接测试 | 已验证 isTerminalTaskStatus 检查 completed/failed/killed |
| Task 接口仅要求 kill | `src/Task.ts:71-80` | 未找到直接测试 | 已验证接口定义（22546 号 PR 移除 spawn/render） |
| Todo list 任务持久化 | `src/utils/tasks.ts:1-861` | 未找到直接测试 | 已验证文件系统存储、lockfile 并发控制、high-water mark 防 ID 重用、claimTask 原子性 |
| 停止任务时 suppress bash 通知 | `src/tasks/stopTask.ts:69-95` | 未找到直接测试 | 已验证 StopTaskError 三种错误码、LocalShellTask 特殊处理（标记 notified=true + 直接 emit SDK event） |
| 任务输出 cap 5GB | `src/utils/task/diskOutput.ts:29-31` + `118-126` | 未找到直接测试 | 已验证 MAX_TASK_OUTPUT_BYTES 5GB、超限添加截断提示 |
| LocalShellTask 实现 | `src/tasks/LocalShellTask/` 目录 | 未找到直接测试 | 已细读 guards.ts 类型定义、stall watchdog 启发式检测、isBackgrounded 前后台切换 |
| LocalAgentTask 实现 | `src/tasks/LocalAgentTask/` 目录 | 未找到直接测试 | 已细读类型定义、ToolActivity/AgentProgress 跟踪、resume 状态合并逻辑 |
| TaskCreateTool 实现 | `src/tools/TaskCreateTool/TaskCreateTool.ts:1-139` | 未找到直接测试 | 仅检查代码实现 |
| TaskUpdateTool 实现 | `src/tools/TaskUpdateTool/TaskUpdateTool.ts:1-407` | 未找到直接测试 | 仅检查代码实现 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/task-system.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|---|---|---|---|
| task-core | Task 接口、状态机、ID 生成 | 未找到专用测试 |  |
| task-framework | 任务注册、更新、驱逐、轮询 | 未找到专用测试 |  |
| task-disk-output | 任务输出文件管理 | 未找到专用测试 |  |
| task-types | 各任务类型实现（LocalShell/LocalAgent/RemoteAgent/InProcessTeammate/LocalWorkflow/MonitorMcp/Dream） | 未找到专用测试 |  |
| task-tools | TaskCreate/TaskGet/TaskList/TaskUpdate/TaskStop/TaskOutput/TodoWrite 工具 | 未找到专用测试 | 其他工具不归本组 |
| todo-tasks | Todo list 任务持久化、claim/block 逻辑 | 未找到专用测试 | 后台任务不归本组 |
| task-components | 任务 UI 组件、hooks | 未找到专用测试 |  |

相关子系统：
- [Agent Swarms](./2026-11-12-agent-swarms-design.md)：使用 in_process_teammate 任务、团队 todo list
- [Query Core](./2026-11-12-query-core-design.md)：使用 local_agent 任务执行 agent
- [Shell Tools](./2026-11-12-shell-tools-design.md)：使用 local_bash 任务执行命令
- [MCP](./2026-11-12-mcp-design.md)：使用 monitor_mcp 任务
- [SDK Query Sessions](./2026-11-12-sdk-query-sessions-design.md)：消费任务事件

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | Todo list 任务与后台任务名称相同，可能混淆用户（设计推断） | 明确区分命名：Todo list 称为"todo items"或"tasks"，后台任务称为"background jobs"或"async tasks" | 文档和 UI 变更风险小，代码重命名风险大 | 检查用户文档和 UI 文本，确认命名一致 | S/M（文档/代码） | 待运行验证 |
| P2 | 轮询延迟 1 秒，用户可能觉得响应慢（设计推断） | 考虑在任务完成时立即触发一次检查，而不是等下次轮询 | 需要添加事件触发机制，可能引入复杂性 | 测量任务完成到通知的延迟 | S | 待运行验证 |
| P3 | 任务测试缺口大（证据：第 7 章无测试） | 添加核心路径的单元测试和集成测试 | 需要 mock AppState、文件系统等 | 实现 TaskCreate/TaskUpdate、LocalShellTask 基本路径的测试 | L | 待运行验证 |
| P3 | Todo list lockfile 重试 30 次，高并发时可能超时（设计推断） | 考虑更细粒度的锁或乐观并发控制 | 可能引入竞态条件，需要仔细设计 | 模拟高并发场景测试 | M | 待运行验证 |
| P3 | 任务输出 cap 5GB 可能仍不够（设计推断） | 考虑可配置的 cap，或流式处理而非全量保存 | 配置复杂度增加 | 收集用户反馈，确认合理默认值 | S | 待运行验证 |
