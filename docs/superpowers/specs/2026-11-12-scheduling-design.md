---
id: scheduling
batch: 5
title: Scheduling 定时任务、模板作业与主动唤醒设计
date: 2026-11-12
status: draft
---

# Scheduling 定时任务、模板作业与主动唤醒设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理"、"提高可靠性"、"保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际机制是什么、为什么采用、备选方案及不采用原因、付出了什么代价、证据在哪里。

## 1. 问题与约束

当用户需要"每隔5分钟检查一下PR状态"、"明天下午3点提醒我开会"、"后台持续监控某个目录"时，需要一套独立于交互式会话的调度系统。系统必须支持：

- **定时任务（Cron Tasks）**：按cron表达式定期触发，支持一次性和周期性任务
- **模板作业（Template Jobs）**：脱离交互式界面的后台作业，拥有持久化状态和恢复能力
- **主动唤醒（Proactive）**：模型主动发起行动而非被动响应用户，配合SleepTool实现轮询

约束：
- cron使用5字段标准格式，解释为本地时区
- 同一项目目录下的多个Claude会话不能重复触发同一个cron任务
- 模板作业的状态必须持久化到磁盘，支持跨会话恢复
- 主动唤醒功能默认关闭，需通过命令显式激活
- 不设计跨机器的分布式调度，仅支持单机多会话协调

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
| --- | --- | --- | --- | --- | --- |
| cron任务持久化到`.claude/scheduled_tasks.json` | 每个任务带8字符ID，包含cron、prompt、createdAt、lastFiredAt、recurring、permanent | 文件简单可见，不依赖外部数据库；支持手动编辑/备份 | SQLite：过度设计；纯内存：进程退出丢失任务 | 文件读写需加锁，防并发损坏 | src/utils/cronTasks.ts:74-182 |
| 使用PID锁文件防多会话重复触发 | `.claude/scheduled_tasks.lock`包含sessionId、pid、acquiredAt；持有锁的会话才执行check() | 简单可靠，无需分布式协调；崩溃的会话会被其他会话检测到并接管 | 基于共享内存：跨进程复杂；单实例强制：多会话场景不便 | 锁文件需在退出时清理，防死锁 | src/utils/cronTasksLock.ts:1-196 |
| cron抖动（Jitter）避峰 | 周期性任务：`next + jitterFrac * interval`（默认cap 15分钟）；一次性任务：若落在mod 30分钟，提前`0-90秒` | 防止所有用户选"0 9 * * *"导致inference峰值 | 无抖动：会有惊群效应；完全随机：破坏用户"准时"预期 | 一次性任务最多提前90秒，对体验影响有限 | src/utils/cronTasks.ts:313-445 |
| 模板作业使用双进程监督者模式 | supervisor进程detached启动，持有pid锁；spawn子进程执行实际任务，监控其stdout/stderr/exit | supervisor独立存活，可监控任务；子进程崩溃不影响supervisor；detached可跨会话 | 单进程：崩溃丢失任务；多线程：状态同步复杂 | 需管理两个进程的生命周期，增加复杂度 | src/jobs/supervisor.ts:1-442 |
| 主动唤醒作为功能开关，非默认行为 | `activateProactive('command')`启动，`deactivateProactive()`停止；状态跟踪active/paused/contextBlocked | 默认安全，用户需显式启用；防止意外后台运行 | 默认开启：隐私/资源风险；全局配置：不灵活 | 用户需记住启用/停用 | src/proactive/index.ts:1-96 |
| SleepTool仅在proactive激活时可用 | `isEnabled() { return isProactiveActive() }` | 防止普通交互中被误用 | 始终可用：用户可能用sleep阻塞会话 | 需先启用proactive才能用sleep | src/tools/SleepTool/SleepTool.ts:48-54 |
| 一次性错过的任务在启动时询问，不自动触发 | `findMissedTasks()`检测，`buildMissedTaskNotification()`询问用户；自动删除已询问的任务 | 尊重用户，防止在不合适的时间触发很久前的提醒 | 自动触发：可能打扰用户；静默忽略：用户可能不知道任务错过了 | 用户需要手动选择是否执行 | src/utils/cronScheduler.ts:201-234 |
| 周期性任务7天后自动过期（除非permanent） | `recurringMaxAgeMs`默认7天，`isRecurringTaskAged()`检测，最后一次执行后删除 | 防止遗忘的任务永久运行，控制资源消耗 | 永不过期：资源泄漏风险；更短/更长：默认不一定适合所有人 | permanent标志仅内部使用（assistant模式） | src/utils/cronScheduler.ts:54-61, 309-319 |
| 会话级任务不持久化，仅存内存 | `addSessionCronTask()`/`getSessionCronTasks()`存bootstrap state，`durable=false`标记 | 临时任务不污染磁盘；会话结束自动消失 | 全部持久化：磁盘垃圾多；临时内存结构需单独管理 | 两种任务路径在check()中分别处理 | src/utils/cronTasks.ts:210-213, 288-296 |

## 3. 目标与非目标

### 定时任务（Cron）

**目标**：
- 支持标准5字段cron表达式，本地时区
- 支持一次性（one-shot）和周期性（recurring）任务
- 同一项目目录多会话时，仅一个会话触发任务
- 持久化任务到`.claude/scheduled_tasks.json`，支持跨会话恢复
- 抖动避峰，防止所有用户同时触发inference
- 检测错过的任务并询问用户
- 周期性任务自动过期（默认7天）

**非目标**：
- 不支持cron的高级语法（L、W、?、名字别名等）
- 不支持跨机器调度
- 不保证毫秒级精确（秒级轮询）
- 不支持优先级队列

### 模板作业（Template Jobs）

**目标**：
- 脱离交互式界面运行，状态持久化
- 双进程supervisor模式，保证监控可靠
- 支持任务恢复（--resume）
- 分类器识别任务状态（in_progress/needs_input/completed/blocked/failed）
- 完整的transcript记录

**非目标**：
- 不支持分布式作业队列
- 不支持作业依赖关系
- 不支持作业优先级

### 主动唤醒（Proactive）

**目标**：
- 提供功能开关，用户显式激活/停用
- 支持pause/resume/contextBlocked状态
- 仅在激活时启用SleepTool
- 通过subscribe机制通知UI状态变化

**非目标**：
- 不提供默认的proactive行为（仅提供框架）
- 不自动在后台启动proactive

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

**定时任务入口**：
- `CronCreateTool`：创建cron任务
- `CronDeleteTool`：删除cron任务
- `CronListTool`：列出cron任务
- `createCronScheduler()`：创建调度器，启动check()循环
- `readCronTasks()`/`writeCronTasks()`：读写任务文件

**模板作业入口**：
- `spawnSupervisorProcess()`：启动supervisor进程
- `runJobSupervisor()`：supervisor主函数（`template-job-supervisor`命令）
- `readJob()`/`writeJobState()`：读写作业状态

**主动唤醒入口**：
- `activateProactive('command')`/`deactivateProactive()`：开关
- `pauseProactive()`/`resumeProactive()`：暂停/继续
- `setContextBlocked(bool)`：上下文阻塞
- `isProactiveActive()`：检查是否激活

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
| --- | --- | --- | --- | --- |
| `cron.ts` | 无纯函数 | `parseCronExpression()`解析，`computeNextCronRun()`计算下次触发，`cronToHuman()`转自然语言 | 任务持久化、调度 | 导出解析/计算函数给cronTasks |
| `cronTasks.ts` | `scheduled_tasks.json`文件格式、任务CRUD、抖动计算 | `addCronTask()`/`removeCronTasks()`/`listAllCronTasks()`/`markCronTasksFired()`，抖动计算函数 | 调度循环、锁 | 导出类型和CRUD给cronScheduler |
| `cronTasksLock.ts` | `scheduled_tasks.lock`锁文件 | `tryAcquireSchedulerLock()`/`releaseSchedulerLock()` | 调度逻辑 | 导出锁函数给cronScheduler |
| `cronScheduler.ts` | `nextFireAt`Map、`missedAsked`Set、`inFlight`Set、`isOwner`标志 | `check()`每秒轮询、文件watch、锁管理、任务触发 | cron解析、文件格式 | 调用cronTasks和cronTasksLock，调用onFire/onFireTask |
| `jobs/schema.ts` | JobRecord/JobState/ReplyRecord等类型定义 | Zod schema解析 | 状态持久化、supervisor逻辑 | 导出类型给其他jobs模块 |
| `jobs/supervisor.ts` | supervisor进程、child进程、job state | `spawnSupervisorProcess()`/`runJobSupervisor()`/`mergeProcessOutcome()` | 作业创建、分类器逻辑 | 调用jobs/state读写状态 |
| `jobs/state.ts` | job目录结构、锁文件、原子写 | `readJob()`/`writeJobState()`/`withJobLock()`/`appendTranscriptLocked()` | supervisor进程管理 | 被supervisor调用 |
| `jobs/classifier.ts` | 分类逻辑 | （未细读） | 状态管理 | （未细读） |
| `proactive/index.ts` | controlState（active/paused/contextBlocked）、nextTickAt、listeners | activate/deactivate/pause/resume/setContextBlocked、subscribe | 具体的proactive行为 | 被SleepTool、UI组件调用 |
| `ScheduleCronTool/*` | 无（工具无状态） | CronCreate/CronDelete/CronList工具调用 | 调度、锁 | 调用cronTasks和bootstrap state |
| `SleepTool/SleepTool.ts` | 无（工具无状态） | Sleep工具调用 | 时间管理 | 调用isProactiveActive()检查启用 |
| `RemoteTriggerTool/RemoteTriggerTool.ts` | 无（工具无状态） | RemoteTrigger工具调用（list/get/create/update/run） | 调度、本地状态 | 调用claude.ai API |

### 4.3 主控制流

#### Cron任务调度主循环

```
scheduler.start()
  → 检查getScheduledTasksEnabled()或assistantMode
  → enable()
    → tryAcquireSchedulerLock()
    → load(true)：初始加载，检查错过的一次性任务
    → chokidar.watch()监听scheduled_tasks.json变化
    → setInterval(check, 1000ms)

check()每1秒执行：
  → 若isKilled()或isLoading()且非assistantMode，返回
  → getJitterConfig()获取配置
  → process(file-backed tasks)：仅当isOwner
    → 若inFlight.has(id)，跳过
    → 若nextFireAt未设置，计算首次触发时间（recurring从lastFiredAt或createdAt，one-shot从createdAt）
    → 若now >= next：
      → onFire/onFireTask调用
      → 若recurring且未aged：计算新next，markCronTasksFired()
      → 若one-shot或aged：inFlight.add(id)，removeCronTasks()
  → process(session tasks)：不考虑锁
  → 清理nextFireAt中不再存在的task id
```

#### Template Job Supervisor流程

```
spawnSupervisorProcess(jobDirectory, replyId)
  → assertSecureJobDirectory()
  → readJob()
  → write startup-*.json
  → spawn detached child: `node template-job-supervisor jobDirectory`
  → write supervisor record
  → update job state with pid

runJobSupervisor(jobDirectory)
  → withJobLock()
  → readJobState()
  → 若status非queued/running，返回
  → update state to running with current pid
  → spawn child process with --print --output-format stream-json --resume/--session-id
  → 监控child.stdout/ stderr/close
  → appendTranscriptLocked()记录所有事件
  → 当child退出：mergeProcessOutcome()更新状态
  → writeJobState()
  → finalizeReply()
```

#### Proactive状态流转

```
初始：{ active: false, paused: false, contextBlocked: false }

activateProactive('command')
  → active=true, paused=false, contextBlocked=false
  → notify() listeners

deactivateProactive()
  → active=false, paused=false, contextBlocked=false
  → nextTickAt=null

pauseProactive()
  → paused=true
  → nextTickAt=null

resumeProactive()
  → paused=false

setContextBlocked(true)
  → contextBlocked=true
  → nextTickAt=null
```

### 4.4 数据结构与持久化

#### CronTask结构

```typescript
type CronTask = {
  id: string // 8字符UUID slice
  cron: string // 5字段cron表达式
  prompt: string // 触发时入队的prompt
  createdAt: number // epoch ms
  lastFiredAt?: number // 仅recurring，上次触发时间
  recurring?: boolean // true=周期性，false/undefined=一次性
  permanent?: boolean // true=不过期（内部assistant模式用）
  durable?: boolean // false=会话级仅内存，undefined=持久化到磁盘
  agentId?: string // 会话级任务，若由teammate创建
}
```

持久化位置：`{project}/.claude/scheduled_tasks.json`

#### 锁文件结构

```typescript
type SchedulerLock = {
  sessionId: string // 或daemon的stable id
  pid: number // 用于检测进程存活
  acquiredAt: number // epoch ms
}
```

持久化位置：`{project}/.claude/scheduled_tasks.lock`

#### JobState结构

```typescript
type JobState = {
  version: 'local-template-jobs-v1'
  job_id: uuid
  status: 'queued'|'running'|'waiting_for_input'|'blocked'|'completed'|'failed'|'cancelled'
  generation: number // 递增版本号
  active_reply_id: uuid|null
  pid: number|null // 当前运行进程
  started_at: timestamp
  updated_at: timestamp
  ended_at: timestamp|null
  exit_code: number|null
  classification: JobClassification|null
  last_error: { code: string; message: string }|null
}
```

持久化位置：`{jobDir}/state.json`

#### Proactive控制状态

```typescript
type ProactiveControlState = {
  active: boolean
  paused: boolean
  contextBlocked: boolean
}
```

仅内存，不持久化。

### 4.5 跨子系统依赖

| 依赖方向 | 模块 | 职责描述 | 主设计 spec |
| --- | --- | --- | --- |
| 上游 | bootstrap/state | 存储session cron tasks、scheduledTasksEnabled标志 | （待补充） |
| 上游 | growthbook | 提供cron jitter config、kairos cron启用开关 | （待补充） |
| 下游 | 命令框架 | CronCreate/CronDelete/CronList工具 | commands-framework |
| 下游 | 工具框架 | SleepTool、RemoteTriggerTool | tool-framework |
| 下游 | session存储 | Cron任务可能启动新session | session-persistence |
| 下游 | analytics | 记录cron fire/missed/expired事件 | （待补充） |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
| --- | --- | --- | --- | --- | --- |
| cron文件读写失败 | readCronTasks/writeCronTasks | catch并logError，返回空数组/静默失败 | 无重试 | 无回滚 | 返回空任务列表/静默失败 |
| 锁文件已被其他存活会话持有 | tryAcquireSchedulerLock | 内部log，不抛异常 | 不重试，每5秒probe一次 | 不持有锁 | isOwner=false，仅处理session tasks |
| 锁文件存在但pid已死 | tryAcquireSchedulerLock | 内部log，不抛异常 | 删除锁后重试一次 | 删除旧锁文件 | 可能成功获得锁 |
| cron任务触发时prompt执行失败 | （调用方onFire） | 取决于调用方处理 | scheduler不负责 | scheduler仅处理任务调度，不负责执行失败 | 取决于调用方 |
| template job child spawn失败 | runJobSupervisor | catch，update state到failed，writeJobState | 不重试 | 清理pid，write final state | job状态变为failed，last_error记录 |
| template job child崩溃（非0退出） | runJobSupervisor | mergeProcessOutcome()根据exit code和分类器结果更新状态 | 不重试 | write final state，finalize reply | job状态变为failed/waiting_for_input/blocked/completed |
| proactive激活后SleepTool被调用 | SleepTool.isEnabled | 工具不显示在工具列表中 | 不重试 | 无 | 模型看不到工具，不会调用 |
| 一次性任务错过了（进程未运行） | cronScheduler.load(true) | findMissedTasks()检测，buildMissedTaskNotification()询问用户 | 不重试自动触发 | 询问后删除任务 | 用户看到询问，选择是否执行 |

工程取舍：
- **秒级轮询 vs 事件驱动**：轮询简单可靠，但有最多1秒延迟；事件驱动及时但复杂。选择轮询。
- **PID存活检测 vs 租约过期**：PID检测简单直接，但PID可能被复用；租约需定期续期。选择PID检测。
- **双进程supervisor vs 单进程**：双进程保证监控可靠性，但增加复杂度；单进程简单但崩溃丢失监控。选择双进程。
- **proactive作为开关 vs 总是可用**：开关安全但需显式启用；总是可用方便但有风险。选择开关。

## 6. 现状验收标准

1. 给定cron表达式"*/5 * * * *"，调用CronCreateTool创建recurring任务，必须：
   - 任务写入scheduled_tasks.json（若durable=true）
   - 调度器每5分钟左右触发（±抖动）
   - 7天后自动过期删除
   - 多会话同时运行时，仅一个会话触发

2. 给定cron表达式"30 14 28 2 *"（2月28日14:30一次性），创建后关闭Claude，错过触发时间后重启，必须：
   - 启动时检测到错过的任务
   - 显示询问用户是否执行
   - 用户选择后删除任务

3. 给定template job，调用spawnSupervisorProcess，必须：
   - supervisor进程detached启动
   - spawn子进程执行任务
   - 子进程stdout/stderr写入transcript
   - 子进程退出后，supervisor更新job state并退出

4. 给定proactive未激活，调用SleepTool必须：
   - 工具不可见/不可用
   - 模型无法调用

5. 给定proactive已激活，调用SleepTool({ duration: 5000 })，必须：
   - 等待5秒后返回
   - 若被中断，返回interrupted=true

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
| --- | --- | --- | --- |
| cron表达式解析支持5字段标准格式 | src/utils/cron.ts:1-308 | （未找到直接测试） | 仅支持min/hour/dom/month/dow，不支持L/W/?/名字 |
| 锁文件使用O_EXCL原子创建 | src/utils/cronTasksLock.ts:69-91 | （未找到直接测试） | 依赖Node.js fs.writeFile flag='wx' |
| cron抖动：周期性任务使用frac*interval cap 15分钟 | src/utils/cronTasks.ts:381-398 | （未找到直接测试） | jitterFrac从task id计算，稳定 |
| cron抖动：一次性任务在mod 30分钟时提前0-90秒 | src/utils/cronTasks.ts:421-445 | （未找到直接测试） | 可通过growthbook配置调整mod、max、floor |
| 模板作业supervisor detached启动 | src/jobs/supervisor.ts:96-122 | （未找到直接测试） | detached=true，stdio='ignore' |
| supervisor监控child进程stdout/stderr/close | src/jobs/supervisor.ts:356-422 | （未找到直接测试） | 所有事件追加到transcript |
| proactive状态管理和subscribe | src/proactive/index.ts:1-96 | （未找到直接测试） | 仅内存，不持久化 |
| SleepTool仅在proactive激活时启用 | src/tools/SleepTool/SleepTool.ts:53 | （未找到直接测试） | isEnabled()检查isProactiveActive() |
| CronCreateTool验证cron表达式和MAX_JOBS=50 | src/tools/ScheduleCronTool/CronCreateTool.ts:25-116 | （未找到直接测试） | 验证parseCronExpression和nextCronRunMs |
| RemoteTriggerTool调用claude.ai API管理triggers | src/tools/RemoteTriggerTool/RemoteTriggerTool.ts:46-161 | （未找到直接测试） | 需要oauth认证，beta API |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/scheduling.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
| --- | --- | --- | --- |
| cron-core | cron表达式解析、抖动计算、missed检测 | （未找到专用测试） |  |
| cron-tasks | 任务持久化CRUD、文件格式 | （未找到专用测试） |  |
| cron-scheduler | 调度循环、锁管理、文件watch、任务触发 | （未找到专用测试） |  |
| cron-lock | scheduler锁文件、PID存活检测 | （未找到专用测试） | computerUseLock.ts（相似模式） |
| jobs-schema | 模板作业类型定义、Zod schema | （未找到专用测试） |  |
| jobs-supervisor | supervisor进程管理、child spawn监控、状态合并 | （未找到专用测试） |  |
| jobs-state | 作业目录、锁、原子写、transcript | （未找到专用测试） |  |
| jobs-classifier | 任务分类逻辑 | （未找到专用测试） |  |
| proactive-core | 主动唤醒状态管理、subscribe | （未找到专用测试） |  |
| cron-tools | CronCreate/CronDelete/CronList工具 | （未找到专用测试） |  |
| sleep-tool | SleepTool实现 | （未找到专用测试） |  |
| remote-trigger-tool | RemoteTriggerTool实现 | （未找到专用测试） |  |

相关子系统：
- [Task System](./2026-11-13-task-system-design.md)：cron任务触发可能创建后台任务
- [Commands Framework](./2026-11-12-commands-framework-design.md)：cron工具的实现依赖
- [Tool Framework](./2026-11-12-tool-framework-design.md)：所有工具的基础框架
- [Session Persistence](./2026-11-12-session-persistence-design.md)：cron任务触发可能恢复session

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
| --- | --- | --- | --- | --- | --- | --- |
| P2 | cron任务错过的检测仅在启动时进行，若任务在会话运行期间错过（例如电脑休眠），不会询问用户（仅静默触发） | 考虑在check()中检测最近错过的一次性任务并询问，或至少记录日志 | 需要避免重复询问；需要定义"最近"的时间窗口 | 模拟休眠场景，验证检测行为 | S | 设计推断 |
| P2 | 模板作业分类器逻辑未在本文档详细说明，也未找到足够测试 | 补充分类器设计说明，添加测试 | 低，分类器相对独立 | 验证分类器准确识别各种状态 | M | 设计推断 |
| P3 | cron锁的probe间隔是硬编码5秒 | 考虑可配置，或根据场景调整 | 低 | 验证配置生效 | S | 设计推断 |
| P3 | proactive功能仅提供状态管理，没有默认行为或示例 | 提供默认的proactive agent示例或文档 | 低 | 文档+示例 | S | 设计推断 |
