---
id: workflow
batch: 5
title: Workflow DAG 编排与失败传播设计
date: 2026-11-12
status: draft
---

# Workflow DAG 编排与失败传播设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理""提高可靠性""保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

当用户需要执行一系列有依赖关系的步骤（如先分析代码、再生成测试、最后运行测试）时，手动协调步骤间的依赖、失败处理、重试会非常繁琐。如果直接顺序执行，无法利用并行性提升效率；如果每个步骤都是独立 agent，又会导致状态同步复杂。因此本子系统必须提供：DAG（有向无环图）依赖解析、可控并发调度、灵活的失败传播（跳过/继续）、步骤级重试/跳过、状态持久化、子 agent 执行接口。

约束：
- 不复制 task-system 的通用状态机（WorkflowExecution 自己管理步骤状态）
- Workflow 定义可以通过 JSON 文件在项目中发现（`.claude/workflows/*.json`）
- 支持通过 WorkflowTool 调用，也支持通过 startWorkflowTask 直接启动
- 步骤可以依赖其他步骤的输出，支持 `{{input}}` 和 `{{steps.<id>.output}}` 插值
- 支持 `continueOnError` 让步骤在依赖失败时仍继续执行
- 并发度可配置（1-8），默认 2
- 步骤执行通过 agent（可配置 agentType）完成
- 支持 kill workflow、skip 单个步骤、retry 单个步骤
- 执行状态持久化到任务输出文件

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| Workflow 定义用 Zod 解析 | `parseWorkflowDefinition()` 用 Zod schema 验证，额外检查重复 ID、未知依赖、循环依赖 | Zod 提供类型安全的验证，额外 DAG 检查确保可执行 | 纯 JSON Schema：Zod 更贴合 TS 生态；纯手动验证：易出错 | 需要维护 Zod schema 和额外 DAG 检查逻辑 | `src/tools/WorkflowTool/schema.ts:1-67` |
| 步骤提示用简单正则替换 | `buildStepPrompt()` 用 `/\{\{([^}]+)\}\}/g` 正则替换 `{{input}}` 和 `{{steps.<id>.output}}` | 简单直接，满足当前需求 | 模板引擎（如 Mustache）：过度设计，增加依赖；更复杂语法：YAGNI | 不支持转义 `{{`，不支持复杂表达式 | `src/tools/WorkflowTool/schema.ts:54-67` |
| WorkflowExecution 用 wake/loop 模式 | `WorkflowExecution` 内部有 `loop()` 异步函数，通过 `wake()` 函数唤醒，`controllers` Map 管理正在运行的步骤 | 简洁的异步协调模式，不需要复杂的事件发射器 | Promise.all + 依赖追踪：难以处理动态 retry/skip；RxJS：过度设计 | 需要手动管理 wake 调用，避免遗漏 | `src/tools/WorkflowTool/executor.ts:35-240` |
| 步骤状态机：pending→running→terminal | `WorkflowAgentStatus` 包括 pending/running/completed/failed/skipped | 清晰的状态转换，便于判断下一步该做什么 | 更细粒度状态（如 retrying）：增加复杂度 | 需要处理状态转换的合法性 | `src/tools/WorkflowTool/executor.ts:3-26` |
| 失败传播：跳过依赖失败且未 continueOnError 的步骤 | `propagateSkips()` 检查每个 pending 步骤的依赖，如有 skipped 或（failed 且 !continueOnError）则标记为 skipped | 符合直觉：依赖没完成，当前步骤也没法做 | 更复杂的策略（如基于条件的跳过）：YAGNI | 需要在 propagateSkips 中遍历所有步骤，O(n) 复杂度 | `src/tools/WorkflowTool/executor.ts:141-158` |
| 并发控制：按 concurrency 限制同时运行的步骤数 | `loop()` 中计算 `running = controllers.size`，取 `ready.slice(0, concurrency - running)` 启动 | 简单的并发限制，避免资源耗尽 | 更复杂的调度（如优先级队列）：YAGNI | 不支持优先级，所有就绪步骤平等 | `src/tools/WorkflowTool/executor.ts:209-211` |
| 重试时重置 skipped 的依赖步骤 | `retry(stepId)` 重置该步骤为 pending，然后递归重置所有依赖它且被 skipped 的步骤为 pending | 合理的重试语义：重试一个步骤，应该让依赖它的步骤也有机会重新执行 | 只重置被重试的步骤：依赖它的步骤可能仍处于 skipped 状态，导致 workflow 卡住 | 需要递归遍历步骤依赖图 | `src/tools/WorkflowTool/executor.ts:79-102` |
| 每个步骤用独立 AbortController | `controllers` Map 保存 stepId → AbortController，kill() 时 abort 所有，skip(stepId) 时 abort 单个 | 精确控制单个步骤的生命周期 | 单个 AbortController 控制整个 workflow：无法单独跳过某个步骤 | 需要管理多个 AbortController，确保都被清理 | `src/tools/WorkflowTool/executor.ts:38,104-113,161-163` |
| 执行结果持久化到 JSON 文件 | LocalWorkflowTask 完成时，将 `WorkflowExecutionState` 写入 `outputFile` | 持久化完整结果，便于后续查询 | 仅内存：进程退出丢失；数据库：过度设计 | 需要处理文件写入失败 | `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts:99-113` |
| WorkflowTool 用 discovery 查找项目 workflows | `getWorkflowCommands()` 读取 `.claude/workflows/*.json`，解析为 workflow 定义，创建工具命令 | 让用户可以在项目中定义自己的 workflow | 硬编码 workflows：不灵活；远程 workflow：过度设计 | 需要处理 JSON 解析失败 | `src/tools/WorkflowTool/discovery.ts` + `createWorkflowCommand.ts` |
| 步骤执行通过 runAgent 完成 | `runWorkflowStep()` 导入 `runAgent()`，根据 step.agentType 选择 agent，执行并返回最后一条文本消息 | 复用现有的 agent 执行逻辑，支持自定义 agent | 直接调用模型：无法使用工具，功能受限 | 需要导入 runAgent，增加耦合 | `src/tools/WorkflowTool/runner.ts:1-55` |
| workflow 完成后更新 AppState 中的 LocalWorkflowTaskState | LocalWorkflowTask 监听 WorkflowExecution 的 onUpdate，调用 updateTaskState() 更新 agents、summary、error | 保持 AppState 同步，便于 UI 显示 | 不更新 AppState：UI 无法显示进度 | 需要频繁调用 setAppState | `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts:88-94` |

## 3. 目标与非目标

### 编排与调度

**目标**：
- 拥有 DAG 依赖解析与循环检测
- 拥有可控并发调度（1-8，默认 2）
- 拥有步骤状态机管理
- 拥有失败传播逻辑（默认跳过，可选继续）

**非目标**：
- 不拥有循环/条件工作流（YAGNI）
- 不拥有分布式调度（仅本地）
- 不拥有跨会话恢复（当前实现未支持）
- 不拥有优先级调度

### 接口与交互

**目标**：
- 提供 `parseWorkflowDefinition()` 验证和解析 workflow 定义
- 提供 `WorkflowExecution` 类管理执行生命周期
- 提供 `startWorkflowTask()` 启动 workflow 任务
- 提供 `killWorkflowTask()`/`skipWorkflowAgent()`/`retryWorkflowAgent()` 控制执行
- 支持通过 WorkflowTool 调用
- 支持通过项目 JSON 文件发现 workflow

**非目标**：
- 不提供 workflow 可视化编辑器
- 不提供 workflow 版本控制
- 不提供 workflow 市场

### 执行与持久化

**目标**：
- 执行状态持久化到任务输出文件
- 支持步骤级重试/跳过
- 支持整体 kill
- 支持子 agent 执行（可配置 agentType）

**非目标**：
- 不保证 workflow 原子性（部分步骤可能已完成）
- 不保证步骤幂等性（取决于步骤本身）
- 不持久化中间 agent 消息（仅保存最终 output）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// Schema - 定义和解析 workflow
const workflowStepSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  prompt: z.string().min(1),
  agentType: z.string().min(1).optional(),
  dependsOn: z.array(z.string()).default([]),
  continueOnError: z.boolean().default(false),
})

const workflowDefinitionSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().min(1),
  steps: z.array(workflowStepSchema).min(1),
  concurrency: z.number().int().min(1).max(8).default(2),
})

function parseWorkflowDefinition(value: unknown): WorkflowDefinition
function buildStepPrompt(step: WorkflowStep, input: string, results: Record<string, string>): string

// Execution - 核心执行引擎
type WorkflowAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
type WorkflowAgentState = { status: WorkflowAgentStatus; output?: string; error?: string }
type WorkflowExecutionStatus = 'running' | 'completed' | 'failed' | 'killed'
type WorkflowExecutionState = {
  status: WorkflowExecutionStatus
  agents: Record<string, WorkflowAgentState>
  results: Record<string, string>
  error?: string
}
type WorkflowStepRunner = (step: WorkflowStep, prompt: string, signal: AbortSignal) => Promise<string>

class WorkflowExecution {
  constructor(
    workflow: WorkflowDefinition,
    input: string,
    runner: WorkflowStepRunner,
    onUpdate?: (state: WorkflowExecutionState) => void
  )
  start(): void
  getState(): WorkflowExecutionState
  skip(stepId: string): boolean
  retry(stepId: string): boolean
  kill(): boolean
  readonly done: Promise<WorkflowExecutionState>
}

// Task - 集成到任务系统
type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  workflowName?: string
  agentCount: number
  agents?: Record<string, WorkflowAgentState>
  agentId?: string
  error?: string
}

function startWorkflowTask(options: {
  workflow: WorkflowDefinition
  input: string
  context: ToolUseContext
  canUseTool: CanUseToolFn
  runner?: WorkflowStepRunner
}): { taskId: string; done: Promise<WorkflowExecutionState> }

function killWorkflowTask(taskId: string, setAppState: SetAppState): boolean
function skipWorkflowAgent(taskId: string, agentId: string, setAppState: SetAppState): boolean
function retryWorkflowAgent(taskId: string, agentId: string, setAppState: SetAppState): boolean
```

调用方通过 WorkflowTool 或直接调用 startWorkflowTask() 启动，WorkflowExecution 解析 DAG、调度步骤、调用 runner 执行，过程中通过 onUpdate 通知状态变化，最终返回 WorkflowExecutionState。

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `schema.ts` | 无状态（纯函数） | parseWorkflowDefinition、buildStepPrompt | 执行逻辑 | 导出 Zod schema、类型、解析/插值函数 |
| `executor.ts` | WorkflowExecution 内部 state、controllers Map、wake 函数 | start、skip、retry、kill、loop | 任务系统集成、agent 执行 | 导出 WorkflowExecution 类、类型、runner 接口 |
| `runner.ts` | 无状态（纯函数） | runWorkflowStep | workflow 编排 | 调用 runAgent()、getTools()、GENERAL_PURPOSE_AGENT |
| `LocalWorkflowTask.ts` | executions Map<taskId, WorkflowExecution> | startWorkflowTask、killWorkflowTask、skipWorkflowAgent、retryWorkflowAgent | workflow 编排、agent 执行 | 集成 Task 系统、调用 WorkflowExecution |
| `discovery.ts` | 无状态（纯函数） | getWorkflowCommands | 执行逻辑 | 读取 .claude/workflows/*.json |
| `createWorkflowCommand.ts` | 无状态（纯函数） | 创建 workflow 工具命令 | 执行逻辑 | 调用 startWorkflowTask() |
| `WorkflowTool.ts` | 无状态（纯函数） | WorkflowTool.call() | 执行逻辑 | 调用 discovery、createWorkflowCommand |

状态设计理由：
- WorkflowExecution 内部状态私有，通过 getState() 返回快照：避免外部直接修改导致不一致
- executions Map 全局保存活跃的 WorkflowExecution：支持后续通过 taskId 进行 kill/skip/retry
- 步骤状态在 WorkflowExecution.agents 中：统一管理所有步骤状态

复制与共享：
- WorkflowExecutionState 每次通过 snapshot() 深拷贝（对象展开）返回：避免外部修改内部状态
- results 是 Record<string, string>，保存已完成步骤的输出：便于后续步骤插值

重置与清理：
- WorkflowExecution 完成后，从 executions Map 中删除
- controllers Map 中的 AbortController 在步骤完成后删除
- kill() 时 abort 所有 controllers

### 4.3 主控制流

#### Workflow 启动与执行（典型路径）

```text
用户调用 WorkflowTool 或直接调用 startWorkflowTask()
  → parseWorkflowDefinition()：验证定义、检查依赖、检测循环
  → createTaskStateBase()：创建 LocalWorkflowTaskState
  → registerTask()：添加到 AppState.tasks
  → 创建 WorkflowExecution 实例
  → execution.start()：
    → 调用 onUpdate 通知初始状态
    → 启动 loop() 异步函数
  → loop()：
    → propagateSkips()：跳过依赖失败的步骤
    → 计算 running = controllers.size
    → 找出 ready = 所有 pending 且 dependenciesReady 的步骤
    → 启动 ready.slice(0, concurrency - running) 个步骤：
      → 创建 AbortController，加入 controllers
      → 标记步骤为 running
      → 调用 runner(step, prompt, signal)
        → 成功：标记步骤为 completed，保存 output 到 results
        → 失败：标记步骤为 failed，保存 error
        → 最终：从 controllers 删除，调用 notify()
    → 检查是否还有 pending 或 running 步骤
      → 是：等待 wake()（通过 new Promise(resolve => (this.wake = resolve))）
      → 否：结束 loop
  → loop 结束后：
    → 确定最终状态（completed/failed/killed）
    → 调用 finish()  resolve done promise
    → 调用 onUpdate 通知最终状态
  → LocalWorkflowTask 收到最终状态：
    → 将 state 写入 outputFile
    → 更新 AppState 中的任务状态为 terminal
    → 发送 <task-notification>
  → 从 executions Map 删除 WorkflowExecution
```

#### 步骤重试

```text
用户调用 retryWorkflowAgent(taskId, stepId)
  → 从 executions Map 获取 WorkflowExecution
  → execution.retry(stepId)：
    → 验证 workflow 正在 running，步骤状态为 failed 或 skipped
    → 重置步骤为 pending
    → 递归重置所有依赖该步骤且被 skipped 的步骤为 pending
    → 调用 notify() 唤醒 loop
  → loop 继续：
    → propagateSkips()（可能取消一些跳过）
    → 找到就绪步骤
    → 重新执行被重试的步骤
```

#### 步骤跳过

```text
用户调用 skipWorkflowAgent(taskId, stepId)
  → 从 executions Map 获取 WorkflowExecution
  → execution.skip(stepId)：
    → 验证 workflow 正在 running，步骤未 completed
    → 标记步骤为 skipped
    →  abort 该步骤的 controller（如果正在运行）
    → 调用 notify() 唤醒 loop
  → loop 继续：
    → propagateSkips()：跳过依赖该步骤的步骤
    → 继续调度其他步骤
```

#### Workflow Kill

```text
用户调用 killWorkflowTask(taskId)
  → 从 executions Map 获取 WorkflowExecution
  → execution.kill()：
    → 验证 workflow 正在 running
    → 标记 workflow 状态为 killed
    → 将所有 pending 步骤标记为 skipped
    → abort 所有 controllers
    → 调用 notify() 唤醒 loop
  → loop 继续：
    → 等待所有 running 步骤结束（通过 signal 被 abort）
    → 结束 loop
  → 更新 AppState 中的任务状态为 killed
```

### 4.4 数据结构与持久化

#### WorkflowDefinition（输入定义）

```typescript
interface WorkflowDefinition {
  name: string                          // kebab-case，如 "review-pr"
  description: string                   // 人类可读描述
  steps: WorkflowStep[]                 // 至少一个步骤
  concurrency: number                   // 1-8，默认 2
}

interface WorkflowStep {
  id: string                            // kebab-case，唯一
  prompt: string                        // 支持 {{input}} 和 {{steps.<id>.output}}
  agentType?: string                    // 可选，默认 GENERAL_PURPOSE_AGENT
  dependsOn: string[]                   // 依赖的步骤 ID 列表
  continueOnError: boolean              // 依赖失败时是否继续，默认 false
}
```

来源：用户通过 WorkflowTool 传入，或从 `.claude/workflows/*.json` 读取。

#### WorkflowExecutionState（执行状态）

```typescript
interface WorkflowExecutionState {
  status: WorkflowExecutionStatus       // running | completed | failed | killed
  agents: Record<string, WorkflowAgentState>  // 步骤 ID → 状态
  results: Record<string, string>       // 步骤 ID → 输出（仅 completed 步骤）
  error?: string                        // workflow 级错误（非步骤级）
}

interface WorkflowAgentState {
  status: WorkflowAgentStatus           // pending | running | completed | failed | skipped
  output?: string                       // 步骤输出（仅 completed）
  error?: string                        // 步骤错误（仅 failed 或 skipped）
}
```

内存存储：WorkflowExecution 内部；持久化：任务输出文件（JSON）。

#### LocalWorkflowTaskState（任务系统状态）

```typescript
interface LocalWorkflowTaskState extends TaskStateBase {
  type: 'local_workflow'
  workflowName?: string
  agentCount: number                    // 步骤总数
  agents?: Record<string, WorkflowAgentState>
  agentId?: string                      // 启动该 workflow 的 agent ID
  error?: string
}
```

存储：`AppState.tasks[taskId]`。

#### 持久化格式（outputFile JSON）

```json
{
  "status": "completed",
  "agents": {
    "a": { "status": "completed", "output": "..." },
    "b": { "status": "completed", "output": "..." }
  },
  "results": {
    "a": "...",
    "b": "..."
  }
}
```

位置：`getTaskOutputPath(taskId)`。

### 4.5 跨子系统依赖

| 依赖方向 | 模块 | 职责描述 | 主设计 spec |
|---|---|---|---|
| 上游 | task-system | 任务生命周期、状态管理、通知 | task-system spec |
| 上游 | agent-swarms | agent 定义、agentType 查找 | agent-swarms spec |
| 上游 | query-core | runAgent()、getTools()、消息管理 | query-core spec |
| 下游 | WorkflowTool | 用户接口、workflow 发现 | 本文 |
| 下游 | LocalWorkflowTask | 任务系统集成 | 本文 |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| Workflow 定义无效 | `parseWorkflowDefinition()` | Zod 错误向上抛出 | 否 | 无 | 异常向上抛出 |
| 步骤执行失败 | `WorkflowExecution.launch()` catch | 步骤状态设为 failed，保存 error | 可通过 `retry()` 手动重试，无上限 | 从 controllers 删除该步骤 | Workflow 继续（除非有其他步骤依赖它且未 continueOnError） |
| Workflow 定义文件无效 | `getWorkflowCommands()` | catch 并跳过该文件 | 否 | 无 | 该 workflow 不被发现 |
| 步骤 prompt 插值失败 | `buildStepPrompt()` | 不匹配的占位符保持原样 | 否 | 无 | prompt 包含原始占位符 |
| workflow 输出文件写入失败 | LocalWorkflowTask done handler | catch 并更新 state.error | 否 | 无 | 任务状态设为 failed，包含写入错误 |
| 步骤被 skip | `skip()` | 步骤状态设为 skipped，error 设为（如适用） | 可通过 `retry()` 手动重试 | abort 该步骤的 controller | 依赖该步骤且未 continueOnError 的步骤也被 skipped |
| workflow 被 kill | `kill()` | workflow 状态设为 killed | 否 | abort 所有 controllers，从 executions Map 删除 | 所有 pending 步骤被 skipped，running 步骤被 abort |

工程取舍：
- **简单正则 vs 模板引擎**：简单正则满足当前需求，无依赖；模板引擎更强大但过度设计。选择简单正则。
- **wake/loop vs Promise.all vs 事件发射器**：wake/loop 简洁灵活；Promise.all 难以处理 retry/skip；事件发射器复杂。选择 wake/loop。
- **步骤级重试/跳过 vs 整体重试**：步骤级更灵活；整体更简单。选择步骤级。
- **仅持久化最终 output vs 完整 agent 消息**：仅 output 简单；完整消息更可调试但体积大。选择仅 output。
- **并发度 1-8 vs 无限制**：限制避免资源耗尽；无限制更灵活但风险高。选择限制 1-8。

## 6. 现状验收标准

1. 给定有效 workflow 定义（两个顺序步骤），执行 WorkflowExecution，必须：
   - 先执行步骤 a，完成后再执行步骤 b
   - 步骤 b 的 prompt 包含步骤 a 的 output
   - 最终状态为 completed
   - results 包含两个步骤的 output
   - agents 状态正确

2. 给定 workflow 定义（两个独立步骤），执行 WorkflowExecution，必须：
   - 两个步骤并发执行（取决于 concurrency）
   - 最终状态为 completed
   - results 包含两个步骤的 output

3. 给定 workflow 定义（步骤 b 依赖 a，且 continueOnError: false），步骤 a 失败，必须：
   - 步骤 a 状态为 failed
   - 步骤 b 状态为 skipped
   - 最终 workflow 状态为 failed

4. 给定 workflow 定义（步骤 b 依赖 a，且 continueOnError: true），步骤 a 失败，必须：
   - 步骤 a 状态为 failed
   - 步骤 b 仍执行（status 为 completed/failed）
   - 最终 workflow 状态取决于步骤 b

5. 给定正在运行的 workflow，执行 skip(stepId)，必须：
   - 该步骤状态变为 skipped
   - 如正在运行则被 abort
   - 依赖该步骤且未 continueOnError 的步骤也被 skipped

6. 给定失败的步骤，执行 retry(stepId)，必须：
   - 该步骤状态重置为 pending
   - 依赖该步骤且被 skipped 的步骤也重置为 pending
   - 该步骤重新执行

7. 给定正在运行的 workflow，执行 kill()，必须：
   - workflow 状态变为 killed
   - 所有 pending 步骤被 skipped
   - 所有 running 步骤被 abort
   - done promise resolve 为 killed 状态

8. 给定项目目录中的 `.claude/workflows/review.json`，调用 getWorkflowCommands()，必须：
   - 返回包含 "review" 命令的列表
   - 命令 kind 为 "workflow"

9. 调用 startWorkflowTask()，必须：
   - 在 AppState.tasks 中创建 LocalWorkflowTaskState
   - 状态从 pending → running → terminal
   - 最终输出文件包含完整 WorkflowExecutionState

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| Workflow 定义用 Zod 解析并检查 DAG | `src/tools/WorkflowTool/schema.ts:1-67` | `tests/workflow.test.ts:48-87` | 仅检查基本验证、重复 ID、未知依赖、循环依赖 |
| 步骤提示用简单正则替换 | `src/tools/WorkflowTool/schema.ts:54-67` | `tests/workflow.test.ts:48-57` | 仅检查 {{input}} 和 {{steps.<id>.output}} |
| WorkflowExecution 用 wake/loop 模式 | `src/tools/WorkflowTool/executor.ts:35-240` | `tests/workflow.test.ts:90-123` | 仅检查基本执行流程 |
| 步骤状态机 | `src/tools/WorkflowTool/executor.ts:3-26` | `tests/workflow.test.ts:90-206` | 覆盖所有状态转换 |
| 失败传播：跳过依赖失败且未 continueOnError 的步骤 | `src/tools/WorkflowTool/executor.ts:141-158` | `tests/workflow.test.ts:125-143` | 仅检查基本失败传播 |
| 并发控制：按 concurrency 限制同时运行的步骤数 | `src/tools/WorkflowTool/executor.ts:209-211` | `tests/workflow.test.ts:90-123` | 仅检查 concurrency=2 的情况 |
| 重试时重置 skipped 的依赖步骤 | `src/tools/WorkflowTool/executor.ts:79-102` | `tests/workflow.test.ts:145-174` | 仅检查基本重试场景 |
| 每个步骤用独立 AbortController | `src/tools/WorkflowTool/executor.ts:38,161-163` | `tests/workflow.test.ts:193-206` | 仅检查 kill 场景 |
| 执行结果持久化到 JSON 文件 | `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts:99-113` | `tests/workflow.test.ts:233-261` | 仅检查基本持久化 |
| WorkflowTool 用 discovery 查找项目 workflows | `src/tools/WorkflowTool/discovery.ts` + `createWorkflowCommand.ts` | `tests/workflow.test.ts:209-232` | 仅检查基本发现 |
| 步骤执行通过 runAgent 完成 | `src/tools/WorkflowTool/runner.ts:1-55` | 未找到直接测试 runner 的测试 | 仅检查代码实现 |
| workflow 完成后更新 AppState 中的 LocalWorkflowTaskState | `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts:88-94` | `tests/workflow.test.ts:233-261` | 仅检查基本更新 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/workflow.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|---|---|---|---|
| workflow-schema | Workflow 定义解析、提示插值 | `tests/workflow.test.ts:48-87` |  |
| workflow-executor | Workflow 执行引擎、DAG 调度、失败传播、重试/跳过/kill | `tests/workflow.test.ts:90-206` |  |
| workflow-runner | 步骤执行、runAgent 集成 | 未找到直接测试 |  |
| workflow-tool | Workflow 工具、发现、命令创建 | `tests/workflow.test.ts:209-232` | 其他工具不归本组 |
| workflow-task | LocalWorkflowTask 实现、任务系统集成 | `tests/workflow.test.ts:233-261` | 其他任务类型不归本组 |

相关子系统：
- [Task System](./2026-11-13-task-system-design.md)：提供任务生命周期、状态管理、通知
- [Query Core](./2026-11-12-query-core-design.md)：提供 runAgent()、getTools()
- [Agent Swarms](./2026-11-12-agent-swarms-design.md)：提供 agentType 定义

### 4.6 模块设计卡：Workflow Schema

#### 真实入口签名与关键类型

```typescript
// src/tools/WorkflowTool/schema.ts
export const workflowStepSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  prompt: z.string().min(1),
  agentType: z.string().min(1).optional(),
  dependsOn: z.array(z.string()).default([]),
  continueOnError: z.boolean().default(false),
})

export const workflowDefinitionSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().min(1),
  steps: z.array(workflowStepSchema).min(1),
  concurrency: z.number().int().min(1).max(8).default(2),
})

export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition
export function buildStepPrompt(
  step: WorkflowStep,
  input: string,
  results: Readonly<Record<string, string>>,
): string
```

#### 输入与输出

| 函数 | 输入 | 输出 | 异常条件 |
|------|------|------|----------|
| `parseWorkflowDefinition` | `unknown`（待验证值） | `WorkflowDefinition` | Zod 验证失败、重复 ID、未知依赖、循环依赖、自依赖 |
| `buildStepPrompt` | `WorkflowStep`, `input string`, `results Record` | `string`（插值后提示） | 无异常，不匹配的占位符原样返回 |

#### 任务与步骤状态

- 无内部状态，纯函数模块
- 验证阶段无持久状态

#### 解析流程

```text
parseWorkflowDefinition(value):
  → Zod schema 验证（字段类型、格式、默认值）
  → 检查重复 step.id（使用 Set）
  → 检查所有 dependsOn 引用存在的 step.id
  → 检查无自依赖（id !== dependency）
  → DAG 循环检测（DFS 标记 visiting/visited）
    → visit(id):
      → 若已 visited：跳过
      → 若正在 visiting：抛出循环错误
      → 标记为 visiting
      → 递归访问所有依赖
      → 移除 visiting 标记
      → 标记为 visited
  → 返回 WorkflowDefinition
```

#### 设计取舍与备选

| 决策 | 选择 | 备选 | 取舍 |
|------|------|------|------|
| 验证方式 | Zod + 手动 DAG 检查 | 纯 JSON Schema、纯手动 | Zod 提供 TS 类型安全；额外 DAG 检查确保无环 |
| 循环检测 | DFS 递归 | Kahn 拓扑排序 | DFS 简单直接，适合小规模 workflow（steps 数量少） |
| ID 格式 | kebab-case 正则 | 任意字符串 | 强制一致性，避免空格和特殊字符问题 |

#### 源码测试证据

- 源码：`src/tools/WorkflowTool/schema.ts:1-67`
- 测试：`tests/workflow.test.ts:48-87`
- 覆盖场景：有效定义、重复 ID、未知依赖、循环依赖、自依赖

---

### 4.7 模块设计卡：Prompt 插值

#### 真实入口签名与关键类型

```typescript
// src/tools/WorkflowTool/schema.ts
export function buildStepPrompt(
  step: WorkflowStep,
  input: string,
  results: Readonly<Record<string, string>>,
): string
```

#### 输入与输出

| 输入 | 描述 |
|------|------|
| `step.prompt` | 包含 `{{input}}` 或 `{{steps.<id>.output}}` 的模板字符串 |
| `input` | workflow 级输入，替换 `{{input}}` |
| `results` | 已完成步骤的输出 map，替换 `{{steps.<id>.output}}` |

| 输出 | 描述 |
|------|------|
| `string` | 插值后的字符串 |

#### 插值与转义边界

| 占位符 | 替换条件 | 不匹配处理 |
|--------|----------|------------|
| `{{input}}` | 总是 | （无此情况） |
| `{{steps.<id>.output}}` | `<id>` 在 `results` 中存在且值非 `undefined` | 原样保留 `{{steps.<id>.output}}` |
| `{{<other>}}` | 无匹配 | 原样保留 |
| `{{`（无闭合） | 不匹配正则 | 原样保留 |

**转义边界**：不支持转义 `{{`。若 prompt 中需要字面 `{{`，无法实现，会被当作占位符起始标记尝试匹配。

#### 插值流程

```text
buildStepPrompt(step, input, results):
  → 对 step.prompt 执行正则替换 /\{\{([^}]+)\}\}/g
  → 对每个匹配：
    → 若引用 === 'input' → 返回 input
    → 若引用匹配 /^steps\.([a-z][a-z0-9-]*)\.output$/
      → 且 results[id] 存在 → 返回 results[id]
    → 否则 → 返回原匹配串
  → 返回替换后字符串
```

#### 设计取舍与备选

| 决策 | 选择 | 备选 | 取舍 |
|------|------|------|------|
| 插值方式 | 简单正则替换 | Mustache/Handlebars、模板字面量、带转义的解析器 | 无依赖，满足当前需求；不支持转义和复杂表达式 |
| 不匹配处理 | 原样保留 | 抛出错误、替换为空 | 容错性好，便于调试；但可能隐藏拼写错误 |
| 引用格式 | `steps.<id>.output` | `outputs.<id>`、直接 `<id>` | 明确命名空间，预留扩展空间 |

#### 源码测试证据

- 源码：`src/tools/WorkflowTool/schema.ts:54-67`
- 测试：`tests/workflow.test.ts:48-57`
- 覆盖场景：`{{input}}` 替换、`{{steps.<id>.output}}` 替换

---

### 4.8 模块设计卡：DAG 解析与并发调度

#### 真实入口签名与关键类型

```typescript
// src/tools/WorkflowTool/executor.ts
export type WorkflowAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
export type WorkflowAgentState = {
  status: WorkflowAgentStatus
  output?: string
  error?: string
}
export type WorkflowExecutionStatus = 'running' | 'completed' | 'failed' | 'killed'
export type WorkflowExecutionState = {
  status: WorkflowExecutionStatus
  agents: Record<string, WorkflowAgentState>
  results: Record<string, string>
  error?: string
}
export type WorkflowStepRunner = (
  step: WorkflowStep,
  prompt: string,
  signal: AbortSignal,
) => Promise<string>

export class WorkflowExecution {
  constructor(
    workflow: WorkflowDefinition,
    input: string,
    runner: WorkflowStepRunner,
    onUpdate?: (state: WorkflowExecutionState) => void,
  )
  start(): void
  getState(): WorkflowExecutionState
  skip(stepId: string): boolean
  retry(stepId: string): boolean
  kill(): boolean
  readonly done: Promise<WorkflowExecutionState>
}
```

#### 任务与步骤状态

| 状态 | 含义 | 允许的目标状态 |
|------|------|----------------|
| `pending` | 等待依赖完成或调度槽位 | `running`、`skipped` |
| `running` | 正在执行 | `completed`、`failed`、`skipped` |
| `completed` | 成功完成 | （终态） |
| `failed` | 执行失败 | `pending`（通过 retry） |
| `skipped` | 用户跳过或依赖未完成 | `pending`（通过 retry） |

| Workflow 状态 | 含义 |
|---------------|------|
| `running` | 执行中 |
| `completed` | 所有步骤完成且无 failed |
| `failed` | 至少一个步骤 failed 且未被 continueOnError 绕过 |
| `killed` | 用户主动终止 |

#### 依赖完成条件

```typescript
// 真实判断逻辑
private dependenciesReady(step: WorkflowStep): boolean {
  return step.dependsOn.every(id => {
    const dependency = this.state.agents[id]
    return (
      dependency?.status === 'completed' ||
      (dependency?.status === 'failed' && step.continueOnError)
    )
  })
}
```

即：依赖的每个步骤要么 `completed`，要么 `failed` 但当前步骤 `continueOnError: true`。

#### 并发调度流程

```text
loop():
  → 循环条件：
    → workflow 状态为 running，或
    → workflow 状态为 killed 但仍有运行中的步骤（controllers.size > 0）

  → propagateSkips()：跳过因依赖失败/跳过而无法执行的步骤
  → running = controllers.size（当前运行步骤数）
  → ready = 筛选 pending 且 dependenciesReady 的步骤
  → 启动 ready.slice(0, concurrency - running) 个步骤：
    → 创建 AbortController，加入 controllers Map
    → 标记步骤为 running
    → 调用 runner(step, prompt, signal)
    → 成功：标记 completed，保存 output 到 results
    → 失败：标记 failed，保存 error
    → finally：从 controllers 删除，调用 notify()

  → pending = 检查是否还有 pending 步骤
  → 若 (controllers.size === 0 且 !pending)：break 循环
  → 若 (ready.length === 0 或 controllers.size >= concurrency)：
    → 等待 wake()（通过 Promise 挂起）

  → 循环结束后：
    → 若 workflow 仍为 running：
      → 检查是否有 failed 步骤 → 设为 failed 或 completed
    → resolve done promise
    → 调用 onUpdate 最终状态
```

#### 并发上限

- 配置范围：`concurrency: 1-8`（schema 强制）
- 默认值：`2`
- 实现方式：`ready.slice(0, concurrency - running)`，即取就绪步骤中前 N 个，N = 并发上限 - 当前运行数
- 调度公平性：按 workflow.steps 数组顺序，无优先级

#### 设计取舍与备选

| 决策 | 选择 | 备选 | 取舍 |
|------|------|------|------|
| 调度模式 | wake/loop + Promise 挂起 | Promise.all、事件发射器、RxJS | wake/loop 简洁灵活，易于处理动态 retry/skip |
| 并发控制 | 简单计数 + slice | 信号量、优先级队列 | 简单直接，满足需求；不支持优先级 |
| 状态可见性 | 通过 snapshot() 返回深拷贝 | 直接暴露内部状态 | 避免外部修改导致不一致；有拷贝开销 |
| 并发上限 | 1-8 硬限制 | 无限制、可配置更高 | 避免资源耗尽；限制灵活性 |

#### 源码测试证据

- 源码：`src/tools/WorkflowTool/executor.ts:35-240`
- 测试：`tests/workflow.test.ts:90-123`
- 覆盖场景：并发执行独立步骤、依赖步骤顺序执行

---

### 4.9 模块设计卡：失败传播与跳过规则

#### 真实入口签名与关键逻辑

```typescript
// 失败传播核心逻辑
private propagateSkips(): boolean {
  let changed = false
  for (const step of this.workflow.steps) {
    if (this.state.agents[step.id]?.status !== 'pending') continue
    const blocked = step.dependsOn.some(id => {
      const status = this.state.agents[id]?.status
      return status === 'skipped' || (status === 'failed' && !step.continueOnError)
    })
    if (blocked) {
      this.state.agents[step.id] = {
        status: 'skipped',
        error: 'Skipped because a dependency did not complete',
      }
      changed = true
    }
  }
  return changed
}

// skip() 外部接口
skip(stepId: string): boolean {
  if (this.state.status !== 'running') return false
  const agent = this.state.agents[stepId]
  if (!agent || agent.status === 'completed') return false
  this.state.agents[stepId] = { status: 'skipped' }
  this.controllers.get(stepId)?.abort()  // 如正在运行则中止
  this.notify()
  return true
}
```

#### 失败与跳过规则

| 场景 | 步骤状态 | 对依赖它的步骤的影响 |
|------|----------|----------------------|
| 步骤成功 | `completed` | 正常，依赖满足 |
| 步骤失败 | `failed` | 依赖它且 `continueOnError: false` → `skipped`；`continueOnError: true` → 可执行 |
| 步骤被跳过 | `skipped` | 依赖它的所有步骤 → `skipped`（无论 `continueOnError`） |
| 依赖混合状态 | 见下 | 见下 |

**混合依赖完成条件**：某步骤依赖 A、B、C，若 A `completed`、B `failed` 且当前步骤 `continueOnError: true`、C `skipped` → 当前步骤被 `skipped`（因为 C 是 `skipped`）。

#### 失败传播流程

```text
propagateSkips():
  → 遍历所有步骤（按 workflow.steps 顺序）
  → 对每个 pending 步骤：
    → 检查是否有任何依赖满足：
      → 依赖状态为 skipped，或
      → 依赖状态为 failed 且当前步骤 !continueOnError
    → 若满足：
      → 标记当前步骤为 skipped
      → 设置 error: 'Skipped because a dependency did not complete'
      → 记录 changed = true
  → 返回是否有变化
```

#### 用户触发 skip 流程

```text
skip(stepId):
  → 验证 workflow 正在 running
  → 验证步骤存在且未 completed
  → 标记步骤为 skipped（不保留原 error/output）
  → 若步骤正在运行：abort 其 controller
  → 调用 notify() 唤醒 loop
  → loop 继续，propagateSkips() 跳过依赖该步骤的步骤
```

#### 设计取舍与备选

| 决策 | 选择 | 备选 | 取舍 |
|------|------|------|------|
| 跳过粒度 | 步骤级 | 仅整体 workflow | 更灵活；复杂度增加 |
| 跳过传播 | 总是传播跳过 | 可选传播、条件传播 | 符合直觉；无灵活配置 |
| continueOnError | 仅对 failed 生效 | 也对 skipped 生效 | skipped 视为更严重的阻塞；减少配置选项 |
| 错误消息 | 固定字符串 | 更详细原因 | 简单；信息有限 |

#### 源码测试证据

- 源码：`src/tools/WorkflowTool/executor.ts:69-77, 141-158`
- 测试：`tests/workflow.test.ts:125-143, 176-191`
- 覆盖场景：失败传播、continueOnError 绕过、用户 skip、skip 传播

---

### 4.10 模块设计卡：重试预算与重试流程

#### 真实入口签名与关键逻辑

```typescript
// retry() 外部接口
retry(stepId: string): boolean {
  if (this.state.status !== 'running') return false
  const agent = this.state.agents[stepId]
  if (!agent || (agent.status !== 'failed' && agent.status !== 'skipped')) {
    return false
  }
  this.state.agents[stepId] = { status: 'pending' }
  // 递归重置依赖该步骤且被跳过的步骤
  const resetDependents = (id: string): void => {
    for (const step of this.workflow.steps) {
      if (!step.dependsOn.includes(id)) continue
      const dependent = this.state.agents[step.id]
      if (
        dependent?.status === 'skipped' &&
        dependent.error === 'Skipped because a dependency did not complete'
      ) {
        this.state.agents[step.id] = { status: 'pending' }
        resetDependents(step.id)
      }
    }
  }
  resetDependents(stepId)
  this.notify()
  return true
}
```

#### 重试预算与限制

| 限制项 | 当前实现 | 设计取舍 |
|--------|----------|----------|
| 重试次数 | 无上限，可无限 retry | 简化；无防止滥用机制 |
| 重试时机 | workflow 必须 running | 完成后也可重试需更复杂状态管理 |
| 可重试状态 | 仅 failed 或 skipped | completed 不允许重试（避免破坏下游依赖） |
| 历史记录 | 不保存重试历史 | 简单；无法显示重试次数 |

#### 重试流程

```text
retry(stepId):
  → 验证 workflow 正在 running
  → 验证步骤状态为 failed 或 skipped
  → 重置该步骤为 pending（清空 output/error）
  → 递归重置依赖步骤（resetDependents）：
    → 遍历所有步骤，查找依赖当前 id 的步骤
    → 若依赖步骤状态为 skipped 且错误消息匹配
      → 重置为 pending
      → 递归处理该依赖步骤的下游
  → 调用 notify() 唤醒 loop
  → loop 继续：
    → propagateSkips()（可能取消之前的跳过）
    → 找到就绪步骤
    → 重新执行被重试的步骤
```

#### 设计取舍与备选

| 决策 | 选择 | 备选 | 取舍 |
|------|------|------|------|
| 重试范围 | 重置该步骤 + 传播重置被跳过的下游 | 仅该步骤、询问用户重置哪些 | 合理默认；下游可能已有独立完成的状态 |
| 下游重置条件 | 仅错误消息匹配的 skipped | 所有 skipped、包含 failed | 精确；可能遗漏其他原因的 skipped |
| 重试次数 | 无限制 | 上限、指数退避 | 简单；可能浪费资源 |
| 重试历史 | 不保存 | 保存历史、显示次数 | 简单；无审计/调试信息 |

#### 源码测试证据

- 源码：`src/tools/WorkflowTool/executor.ts:79-102`
- 测试：`tests/workflow.test.ts:145-174`
- 覆盖场景：重试失败步骤、重试触发下游重置

---

### 4.11 模块设计卡：取消清理

#### 真实入口签名与关键逻辑

```typescript
// kill() 外部接口
kill(): boolean {
  if (this.state.status !== 'running') return false
  this.state.status = 'killed'
  for (const [id, agent] of Object.entries(this.state.agents)) {
    if (agent.status === 'pending') this.state.agents[id] = { status: 'skipped' }
  }
  for (const controller of this.controllers.values()) controller.abort()
  this.notify()
  return true
}

// 步骤执行完成后的清理
private launch(step: WorkflowStep): void {
  // ...
  .finally(() => {
    this.controllers.delete(step.id)  // 从 Map 移除
    this.notify()
  })
}

// skip() 中的单步清理
skip(stepId: string): boolean {
  // ...
  this.controllers.get(stepId)?.abort()  // 中止单个步骤
  // ...
}
```

#### 取消清理流程

```text
kill():
  → 验证 workflow 正在 running
  → 标记 workflow 状态为 killed
  → 所有 pending 步骤标记为 skipped
  → abort 所有 controllers（运行中的步骤）
  → 调用 notify() 唤醒 loop
  → loop 继续：
    → 等待所有运行中的步骤结束（通过 signal 被 abort）
    → 结束 loop

loop 退出条件（killed 状态）：
  → workflow.status === 'killed' && controllers.size === 0
  → 即：所有步骤要么终止要么被跳过，且无运行中步骤

步骤完成清理（finally）：
  → 从 controllers Map 移除该步骤的 controller
  → 调用 notify()
```

#### 资源清理边界

| 资源 | 清理方式 | 未清理的情况 |
|------|----------|--------------|
| `controllers` Map | 步骤完成时 `delete`、kill 时 `abort` 所有 | （正常都清理） |
| AbortController | 步骤完成时丢弃、kill 时全部 `abort` | （正常都清理） |
| `executions` Map（LocalWorkflowTask） | workflow done 时 `delete` | 进程退出前未完成的 workflow |
| agent 执行 | 通过 `signal.abort()` 通知 | agent 可能忽略 signal 继续运行 |
| 持久化文件 | 无回滚，最后状态写入 | 写入失败时状态不一致 |

#### Runner 与 Task 的边界

| 层 | 职责 | 不做 |
|----|------|------|
| `WorkflowExecution`（executor.ts） | DAG 调度、状态管理、调用 runner、AbortController 生命周期 | 任务系统集成、agent 执行细节、持久化 |
| `runWorkflowStep`（runner.ts） | 调用 `runAgent()`、处理 signal、收集输出 | workflow 编排、状态管理 |
| `LocalWorkflowTask`（LocalWorkflowTask.ts） | 任务系统集成、持久化、`executions` Map 管理 | workflow 编排逻辑 |

边界契约：`WorkflowStepRunner` 签名
```typescript
(step: WorkflowStep, prompt: string, signal: AbortSignal) => Promise<string>
```
- 成功 resolve string 输出
- 失败 reject Error
- 尊重 `signal.aborted`，抛 `AbortError`

#### 设计取舍与备选

| 决策 | 选择 | 备选 | 取舍 |
|------|------|------|------|
| kill 后状态 | 设为 killed，不允许 retry | 保持 running 允许重试 | killed 语义更明确；灵活性降低 |
| pending 步骤处理 | 全部 skipped | 保持 pending 或询问 | 快速终止；可能浪费已完成的依赖 |
| 清理时机 | 步骤 finally 中 | 统一在 loop 结束时 | 及时释放；分散在多处 |
| 执行 Map 清理 | done 时 delete | 保留一段时间用于查询 | 及时释放；无法查询已完成 workflow |

#### 源码测试证据

- 源码：`src/tools/WorkflowTool/executor.ts:38, 104-113, 160-194`
- 测试：`tests/workflow.test.ts:193-206`
- 覆盖场景：kill 中止运行步骤、kill 跳过 pending 步骤、skip 单步中止

---

### 4.12 模块设计卡：LocalWorkflowTask 与持久化

#### 真实入口签名与关键类型

```typescript
// src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts
export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  workflowName?: string
  summary?: string
  agentCount: number
  agents?: Record<string, WorkflowAgentState>
  agentId?: string
  error?: string
}

const executions = new Map<string, WorkflowExecution>()

export function startWorkflowTask(options: {
  workflow: WorkflowDefinition
  input: string
  context: ToolUseContext
  canUseTool: CanUseToolFn
  runner?: WorkflowStepRunner
}): { taskId: string; done: Promise<WorkflowExecutionState> }

export function killWorkflowTask(taskId: string, _setAppState: SetAppState): boolean
export function skipWorkflowAgent(taskId: string, agentId: string, _setAppState: SetAppState): boolean
export function retryWorkflowAgent(taskId: string, agentId: string, _setAppState: SetAppState): boolean

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId, setAppState) { /* ... */ },
}
```

#### 输入与输出

| 函数 | 输入 | 输出 |
|------|------|------|
| `startWorkflowTask` | `workflow`, `input`, `context`, `canUseTool`, `runner?` | `{ taskId, done: Promise<WorkflowExecutionState> }` |
| `killWorkflowTask` | `taskId`, `setAppState` | `boolean`（是否成功） |
| `skipWorkflowAgent` | `taskId`, `agentId`, `setAppState` | `boolean`（是否成功） |
| `retryWorkflowAgent` | `taskId`, `agentId`, `setAppState` | `boolean`（是否成功） |

#### 持久化与跨会话恢复限制

| 项 | 当前实现 | 限制 |
|----|----------|------|
| 持久化时机 | workflow done 时写入 | 执行中间状态不持久化 |
| 持久化内容 | 完整 `WorkflowExecutionState` JSON | 不包含中间 agent 消息、重试历史 |
| 持久化位置 | `getTaskOutputPath(taskId)` | 仅本地文件系统 |
| 跨会话恢复 | 不支持 | 无从持久化状态恢复执行的逻辑 |
| `executions` Map | 仅内存 | 进程退出后丢失，无法通过 taskId 重新关联 |
| 并发安全 | 无锁 | 同一 taskId 并发操作可能状态不一致 |

#### 任务执行流程

```text
startWorkflowTask(options):
  → 生成 taskId
  → 创建 LocalWorkflowTaskState 并注册到 AppState
  → 创建 WorkflowExecution 实例：
    → runner 绑定 context/canUseTool/transcriptSubdir
    → onUpdate 回调更新 AppState 中的任务
  → 加入 executions Map（taskId → execution）
  → execution.start()
  → execution.done.then():
    → 从 executions Map 删除
    → 尝试写入 outputFile（mkdir + writeFile）
      → 成功：标记 hasOutput
      → 失败：修改 finalState.error，状态设为 failed
    → 更新 AppState 任务为终态（completed/failed/killed）
    → 发送 task-notification
    → 返回 finalState
```

#### 设计取舍与备选

| 决策 | 选择 | 备选 | 取舍 |
|------|------|------|------|
| 持久化 | 仅最终状态写入文件 | 增量持久化、数据库 | 简单；无恢复能力 |
| 跨会话恢复 | 不支持 | 支持从文件恢复 | 避免一致性复杂度；进程崩溃需从头执行 |
| executions Map | 全局单例 Map | 嵌入 AppState | 简单；AppState 需可序列化 |
| runner 绑定 | start 时闭包绑定 | 每次调用传入 | 简化 executor 接口；runner 不能更改 |

#### 源码测试证据

- 源码：`src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts:1-176`
- 测试：`tests/workflow.test.ts:233-261`
- 覆盖场景：启动任务、更新 AppState、持久化输出文件

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | STATUS 记录反向声明依赖的 skip 传播可留下 pending，skip→retry 可接受旧 runner 的迟到结果 | 修复依赖状态传播，并用 execution generation 隔离 retry 前后的 runner 结果 | 高：DAG 顺序、通知和终态持久化均可能受影响 | 参数化不同步骤声明顺序，覆盖 skip 链、skip→retry、旧 runner 晚完成；最终不得有 pending，旧结果不得改变新执行状态 | M | 待运行验证 |
| P2 | 当前实现不支持跨会话恢复（设计推断） | 支持从持久化的 WorkflowExecutionState 恢复执行 | 需要考虑一致性、agent 恢复等，风险中等 | 添加恢复测试，验证可以从中断点继续 | M | 待运行验证 |
| P2 | 当前实现不保存完整 agent 消息，仅保存最终 output（设计推断） | 可选地保存完整 agent 消息，便于调试 | 增加存储开销，风险低 | 添加选项，测试可以保存和读取完整消息 | S | 待运行验证 |
| P2 | 步骤提示插值不支持转义 `{{`，也不支持更复杂表达式（设计推断） | 考虑支持转义，或采用更强大的模板引擎 | 可能破坏现有 workflow，风险中等 | 添加转义测试，验证现有 workflow 仍工作 | M | 待运行验证 |
| P2 | 当前并发控制不支持优先级（设计推断） | 考虑添加步骤优先级，让重要步骤先执行 | 增加调度复杂度，风险低 | 添加优先级测试，验证高优先级步骤先执行 | M | 待运行验证 |
| P3 | 当前没有 workflow 可视化（设计推断） | 添加 UI 显示 DAG、执行进度、状态 | 前端工作量，风险低 | 手动测试 UI 显示正确 | L | 待运行验证 |
| P3 | workflow 测试覆盖不足（证据：第 7 章部分无测试） | 添加 runner.ts、更多边界场景的测试 | 无风险 | 实现缺失的测试 | M | 待运行验证 |
