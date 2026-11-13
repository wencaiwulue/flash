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

---

### 4.2 模块设计卡

#### 模块：CronLock（调度锁）

**真实入口签名**：
```typescript
export async function tryAcquireSchedulerLock(opts?: SchedulerLockOptions): Promise<boolean>
export async function releaseSchedulerLock(opts?: SchedulerLockOptions): Promise<void>
export type SchedulerLockOptions = {
  dir?: string
  lockIdentity?: string
}
```

**关键类型**：
```typescript
type SchedulerLock = {
  sessionId: string  // 或 daemon 的 stable id
  pid: number        // 用于检测进程存活
  acquiredAt: number // epoch ms
}
```

**输入输出**：
- 输入：可选的 `dir`（项目根目录）和 `lockIdentity`（稳定标识）
- 输出：`tryAcquireSchedulerLock` 返回是否成功获得锁；`releaseSchedulerLock` 无返回
- 副作用：创建/删除 `{project}/.claude/scheduled_tasks.lock`

**任务/进程状态**：
- 模块内部状态：`unregisterCleanup`（清理函数）、`lastBlockedBy`（去重日志）
- 锁持有者状态：`{sessionId, pid, acquiredAt}` 持久化到锁文件

**创建/触发/恢复/完成流程**：
1. **获取锁**：使用 `fs.writeFile(..., {flag: 'wx'})` 原子创建锁文件
2. **已存在检查**：若锁文件存在，检查是否已由同 session 持有（是 → 更新 pid）
3. **陈旧锁检测**：检查锁持有者的 pid 是否存活（通过 `isProcessRunning`）
4. **锁恢复**：若 pid 已死亡，删除锁文件并重试获取
5. **锁释放**：进程退出时通过 `registerCleanup` 自动删除锁文件

**并发与失败**：
- 并发控制：原子 `wx` 标志保证只有一个进程创建成功
- 失败处理：锁获取失败返回 `false`，不抛异常；释放时忽略 `ENOENT`
- 锁竞争：非持有进程每 5 秒探测一次（`LOCK_PROBE_INTERVAL_MS`）
- 死锁防护：通过 pid 存活检测和陈旧锁自动恢复避免死锁

**设计取舍与备选**：
- 取：PID + sessionId 双重标识；舍：租约续期（增加复杂度）
- 备选：共享内存 IPC（跨平台复杂）、单实例强制（多会话场景不便）
- 代价：PID 可能被复用 → 用 `acquiredAt` + `sessionId` 降低风险

**源码测试证据**：
- 位置：`src/utils/cronTasksLock.ts:1-196`
- 证据：`tryCreateExclusive` 使用 `flag: 'wx'`、`isProcessRunning` 检测存活、`registerCleanup` 退出清理
- 测试：`tests/cronLifecycle.test.ts`（锁竞争接管场景）

---

#### 模块：CronTasks（任务持久化）

**真实入口签名**：
```typescript
export async function addCronTask(cron: string, prompt: string, recurring: boolean, durable: boolean, agentId?: string): Promise<string>
export async function removeCronTasks(ids: string[], dir?: string): Promise<void>
export async function listAllCronTasks(dir?: string): Promise<CronTask[]>
export async function readCronTasks(dir?: string): Promise<CronTask[]>
export async function writeCronTasks(tasks: CronTask[], dir?: string): Promise<void>
export async function markCronTasksFired(ids: string[], firedAt: number, dir?: string): Promise<void>
export function hasCronTasksSync(dir?: string): boolean
```

**关键类型**：
```typescript
type CronTask = {
  id: string                    // 8 字符 UUID slice
  cron: string                  // 5 字段标准 cron
  prompt: string                // 触发时入队的 prompt
  createdAt: number             // epoch ms，锚点
  lastFiredAt?: number          // 仅 recurring，上次触发时间
  recurring?: boolean           // true = 周期性
  permanent?: boolean           // true = 不过期（assistant 用）
  durable?: boolean             // false = 会话级仅内存
  agentId?: string              // 会话级任务的 teammate id
}
type CronJitterConfig = {
  recurringFrac: number         // 周期性任务抖动比例
  recurringCapMs: number        // 周期性任务抖动上限
  oneShotMaxMs: number          // 一次性任务提前量上限
  oneShotFloorMs: number        // 一次性任务提前量下限
  oneShotMinuteMod: number      // 触发抖动的分钟模数
  recurringMaxAgeMs: number     // 周期性任务过期时间
}
```

**输入输出**：
- 持久化位置：`{project}/.claude/scheduled_tasks.json`
- 文件格式：`{tasks: CronTask[]}`
- 会话任务位置：`bootstrap/state`（内存）

**任务/进程状态**：
- 文件任务：持久化，多会话共享
- 会话任务：内存，仅当前进程可见
- 抖动计算：基于 `taskId` 的确定性抖动（`jitterFrac` 函数解析 8 字符 id 为 `[0,1)`）

**创建/触发/恢复/完成流程**：
1. **任务创建**：`addCronTask` → 验证 cron → 生成 8 字符 id → 持久化或内存
2. **抖动计算**：周期性任务：`nextCronRunMs` + `jitterFrac * interval`（上限 15 分钟）；一次性任务：若落在 `minute % 30 === 0` 则提前 `[0, 90s]`
3. **任务触发**：`markCronTasksFired` 批量更新 `lastFiredAt`（避免 N 次写入）
4. **任务清理**：一次性任务触发后 `removeCronTasks` 删除；周期性任务 `isRecurringTaskAged` 检测过期

**并发与失败**：
- 并发控制：`writeJsonAtomic` 原子写入（临时文件 + rename）
- 失败处理：`readCronTasks` 解析失败返回空数组；无效 cron 任务静默丢弃
- 任务去重：无（允许重复 cron）；但 `inFlight` Set 防止同一 check() 周期内重复触发

**设计取舍与备选**：
- 取：8 字符短 ID；舍：完整 UUID（节省空间，足够唯一）
- 取：确定性抖动；舍：随机抖动（保证同任务同调度，避免惊群）
- 取：周期性任务 7 天过期；舍：永久运行（防止遗忘任务泄漏）
- 代价：一次性任务最多提前 90 秒触发（用户可能注意到，但可接受）

**源码测试证据**：
- 位置：`src/utils/cronTasks.ts:1-459`
- 证据：`addCronTask` 生成 8 字符 UUID slice、`jitterFrac` 解析 taskId 为 `[0,1)`、`isRecurringTaskAged` 检测 7 天过期
- 测试：`tests/cronLifecycle.test.ts`（一次性任务触发、周期性任务调度）

---

#### 模块：CronScheduler（调度循环）

**真实入口签名**：
```typescript
export function createCronScheduler(options: CronSchedulerOptions): CronScheduler
export type CronSchedulerOptions = {
  onFire: (prompt: string) => void
  isLoading: () => boolean
  assistantMode?: boolean
  onFireTask?: (task: CronTask) => void
  onMissed?: (tasks: CronTask[]) => void
  dir?: string
  lockIdentity?: string
  getJitterConfig?: () => CronJitterConfig
  isKilled?: () => boolean
  filter?: (t: CronTask) => boolean
  now?: () => number
  lockProbeIntervalMs?: number
}
export type CronScheduler = {
  start: () => void
  stop: () => void
  getNextFireTime: () => number | null
}
```

**关键类型**：
- 同 `CronTasks` 模块

**输入输出**：
- 输入：`onFire/onFireTask` 回调、`isLoading` 门控、`filter` 任务过滤
- 输出：`CronScheduler` 实例（`start/stop/getNextFireTime`）
- 文件监听：`chokidar` 监听 `scheduled_tasks.json` 变化

**任务/进程状态**：
- 内存状态：`tasks`（已加载任务）、`nextFireAt`（id → epoch ms）、`missedAsked`（已询问的错过任务）、`inFlight`（触发中任务）
- 所有权状态：`isOwner`（是否持有锁）、`lockProbeTimer`（探测定时器）

**创建/触发/恢复/完成流程**：
1. **调度启动**：`start()` → 检查 `getScheduledTasksEnabled()` → `enable()`
2. **锁获取**：`tryAcquireSchedulerLock()` → 成功则 `isOwner = true`；失败则启动 5 秒探测
3. **初始加载**：`load(true)` → 检测错过的一次性任务 → `onMissed/onFire(buildMissedTaskNotification())` → 删除已询问的任务
4. **检查循环**：每秒 `check()` → 若 `isKilled()/isLoading()` 则跳过 → 处理文件任务（仅 `isOwner`）→ 处理会话任务 → 清理 `nextFireAt`
5. **任务处理**：首次计算 `nextFireAt`（recurring 从 `lastFiredAt/createdAt`，one-shot 从 `createdAt`）→ 到期触发 → 周期性任务重新调度并 `markCronTasksFired`；一次性/过期任务 `removeCronTasks`
6. **调度停止**：`stop()` → 清理定时器 → 关闭 watcher → 释放锁

**并发与失败**：
- 并发控制：锁持有进程才处理文件任务；会话任务无锁
- 失败处理：`check()` 不抛异常；`isKilled` 门控可随时停止调度
- 错过任务：仅初始加载时检测一次性任务错过；会话运行期间错过的任务静默立即触发
- `inFlight` 防护：防止同一任务在异步删除/更新期间重复触发

**设计取舍与备选**：
- 取：秒级轮询；舍：事件驱动（简单可靠，1 秒延迟可接受）
- 取：仅初始加载检测错过任务；舍：每次 check() 检测（避免重复询问）
- 取：`nextFireAt` 锚定到 `lastFiredAt/createdAt`；舍：锚定到 `now()`（防止休眠后快速补触发）
- 代价：最高 1 秒触发延迟

**源码测试证据**：
- 位置：`src/utils/cronScheduler.ts:1-550`
- 证据：`check()` 每秒执行、`isOwner` 控制文件任务处理、`inFlight` 防止重复触发、`nextFireAt` 锚定到 `lastFiredAt/createdAt`
- 测试：`tests/cronLifecycle.test.ts`（锁竞争接管、错过任务检测）

---

#### 模块：CronNotification（错过任务通知）

**真实入口签名**：
```typescript
export function buildMissedTaskNotification(tasks: CronTask[]): string
export function findMissedTasks(tasks: CronTask[], nowMs: number): CronTask[]
```

**关键类型**：
- 同 `CronTasks` 模块

**输入输出**：
- 输入：错过的 `CronTask[]`
- 输出：格式化的通知 prompt 字符串
- 副作用：已询问的任务添加到 `missedAsked` Set 并删除

**任务/进程状态**：
- `missedAsked`：已询问的任务 id（防止重复询问）
- `nextFireAt`：错过任务设为 `Infinity`（防止 `check()` 重复触发）

**创建/触发/恢复/完成流程**：
1. **错过检测**：`findMissedTasks` → 计算每个任务从 `createdAt` 的下次触发 → 若 < now 则为错过
2. **通知构建**：`buildMissedTaskNotification` → 生成自然语言提示
3. **用户选择**：用户决定是否执行（由调用方处理，scheduler 不负责）
4. **任务清理**：询问后立即 `removeCronTasks` 删除错过的任务

**并发与失败**：
- `missedAsked` Set：防止文件 reload 时重复询问
- `nextFireAt = Infinity`：防止 `check()` 在异步删除期间触发原始 prompt

**设计取舍与备选**：
- 取：询问用户而非自动触发；舍：静默自动触发（尊重用户，避免不当时机打扰）
- 取：仅一次性任务询问；舍：周期性任务询问（周期性任务应立即触发并重新调度）
- 代价：用户可能忘记选择 → 任务永久保留（但已添加到 `missedAsked` 不再询问）

**源码测试证据**：
- 位置：`src/utils/cronNotification.ts`（引用自 `cronScheduler.ts:21,223`）
- 证据：`cronScheduler.ts:201-234`（错过任务检测、询问、删除流程）

---

#### 模块：JobState（作业状态与存储）

**真实入口签名**：
```typescript
export async function readJob(jobDirectory: string): Promise<JobRecord>
export async function readJobState(jobDirectory: string): Promise<JobState>
export async function writeJobState(jobDirectory: string, state: JobState): Promise<void>
export async function withJobLock<T>(jobDirectory: string, operation: () => Promise<T>): Promise<T>
export async function appendTranscriptLocked(jobDirectory: string, record: Omit<TranscriptRecord, ...>): Promise<TranscriptRecord>
export async function assertSecureJobDirectory(jobDirectory: string): Promise<string>
export async function getProcessStartToken(pid: number): Promise<string | null>
export async function probeProcessIdentity(pid: number, expectedStartToken: string | null): Promise<ProcessProbe>
export async function reconcileJob(jobDirectory: string): Promise<JobState>
```

**关键类型**：
```typescript
type JobRecord = {
  version: 'local-template-jobs-v1'
  job_id: uuid
  session_id: uuid
  request_id: uuid
  created_at: timestamp
  cwd: string
  template: TemplateSnapshot
  transcript_path: string
  initial_prompt: string
  rendered_prompt: string
  request_hash: string
}
type JobState = {
  version: 'local-template-jobs-v1'
  job_id: uuid
  status: 'queued'|'running'|'waiting_for_input'|'blocked'|'completed'|'failed'|'cancelled'
  generation: number
  active_reply_id: uuid | null
  pid: number | null
  started_at: timestamp
  updated_at: timestamp
  ended_at: timestamp | null
  exit_code: number | null
  classification: JobClassification | null
  last_error: {code: string; message: string} | null
}
type SupervisorRecord = { version, job_id, session_id, reply_id, pid, start_token, started_at }
type ChildRecord = { version, job_id, session_id, reply_id, pid, start_token, argv, spawned_at, ended_at, exit_code, signal }
type ReplyRecord = { version, reply_id, job_id, prompt, prompt_hash, generation, status, accepted_at, completed_at, error }
type TranscriptRecord = { version, seq, timestamp, job_id, direction, kind, payload }
type ProcessProbe = 'alive'|'dead'|'reused'|'unknown'
```

**输入输出**：
- 作业目录结构：
  ```
  {config}/jobs/{jobId}/
    job.json          # JobRecord
    state.json        # JobState
    supervisor.json   # SupervisorRecord
    child.json        # ChildRecord
    transcript.jsonl  # TranscriptRecord[] (JSONL)
    stderr.log        # 诊断日志（轮转）
    lock/
      state.lock      # proper-lockfile
      startup-*.json  # 启动标记
    replies/
      {replyId}.json  # ReplyRecord
  ```
- 持久化位置：`{config}/jobs/{jobId}/`（`getClaudeConfigHomeDir()/jobs`）

**任务/进程状态**：
- `generation`：递增版本号（防止旧结果覆盖新状态）
- `pid` + `startToken`：双重进程身份标识（防止 PID 复用误判）
- `status` 状态机：`queued` → `running` → `waiting_for_input`/`blocked`/`completed`/`failed`

**创建/触发/恢复/完成流程**：
1. **目录创建**：`createJobDirectory()` → 创建 UUID 命名目录 → 设置 0o700 权限
2. **安全断言**：`assertSecureJobDirectory()` → 验证目录在 jobs root 内 → 非 symlink → 权限 0o700
3. **原子写入**：`writeJsonAtomic()` → 临时文件（`.UUID.tmp`）→ `fsync` → `rename` → 目录 `fsync`
4. **锁操作**：`withJobLock()` → `proper-lockfile` 加锁（stale 60s, retries 40）
5. **Transcript 追加**：`appendTranscriptLocked()` → 读取最后一行计算 `seq` → 原子追加
6. **进程探测**：`probeProcessIdentity()` → `kill(pid, 0)` 检测存活 → 比较 `startToken` 验证身份
7. **作业调和**：`reconcileJob()` → 检测 supervisor 是否死亡 → 死亡则标记 `failed` + `last_error: recovery_uncertain`

**并发与失败**：
- 并发控制：`withJobLock()` 串行化操作；`generation` 版本号防止旧结果覆盖新状态
- 失败处理：`writeJsonAtomic()` 保证原子性；`reconcileJob()` 检测崩溃 supervisor 并标记失败
- PID 复用防护：`startToken`（Linux: `/proc/{pid}/stat` 第 20 字段；macOS/BSD: `ps -o lstart=`）
- 诊断日志：`stderr.log` 轮转（> 1MB 时重命名为 `.1`），敏感信息 redact

**设计取舍与备选**：
- 取：目录级隔离；舍：单一数据库（简单可见，易调试/备份）
- 取：`pid` + `startToken` 双重标识；舍：仅 pid（防止 PID 复用误判）
- 取：`generation` 版本号；舍：无（防止旧分类结果覆盖新状态）
- 代价：每个作业一个目录 → 小作业略占空间，但可接受

**源码测试证据**：
- 位置：`src/jobs/state.ts:1-482`
- 证据：`assertSecureJobDirectory()` 验证目录安全、`writeJsonAtomic()` 原子写入、`getProcessStartToken()` 获取进程启动时间、`reconcileJob()` 调和崩溃作业
- 测试：`tests/daemon.test.ts`（supervisor 重启策略、状态清理）

---

#### 模块：JobSupervisor（模板作业监督者）

**真实入口签名**：
```typescript
export async function spawnSupervisorProcess(jobDirectory: string, replyId: string | null, deps?: SupervisorDeps): Promise<{pid: number; startToken: string | null}>
export async function runJobSupervisor(requestedJobDirectory: string, deps?: SupervisorDeps): Promise<JobState>
export function mergeProcessOutcome(state: JobState, exitCode: number | null, spawnError?: {code: string; message: string}): JobState
export type SupervisorDeps = {
  execPath?: string
  scriptArgs?: string[]
  env?: NodeJS.ProcessEnv
  spawnProcess?: typeof spawn
  buildChildCommand?: (context: {...}) => {command: string; args: string[]}
}
```

**关键类型**：
- 同 `JobState` 模块

**输入输出**：
- 输入：`jobDirectory`、`replyId`（可选）、`deps`（测试注入）
- 输出：`spawnSupervisorProcess` 返回 `{pid, startToken}`；`runJobSupervisor` 返回最终 `JobState`
- 命令：`template-job-supervisor {jobDirectory}`（入口由 `CLAUDE_CODE_ENTRYPOINT` 标识）

**任务/进程状态**：
- Supervisor 状态：detached 进程，持有 job lock，监控 child
- Child 状态：非 detached，执行实际工作，`--print --output-format stream-json` 输出
- 状态持久化：`state.json`、`supervisor.json`、`child.json`

**创建/触发/恢复/完成流程**：
1. **Supervisor 启动**：`spawnSupervisorProcess()` → `assertSecureJobDirectory()` → 写 `startup-*.json` → `spawn({detached: true, stdio: 'ignore'})` → `unref()` → 写 `supervisor.json` → 更新 job state pid
2. **Supervisor 运行**：`runJobSupervisor()` → `withJobLock()` → 读取 job/state → 若非 `queued/running` 则返回 → 更新 state 为 `running` → 写 `supervisor.json` → 追加 transcript
3. **Child 启动**：构建 `buildJobChildArgv()` → `--resume {sessionId}`（若有 replyId）或 `--session-id {sessionId}` → `spawn()` → 写 `child.json` → 追加 transcript
4. **Child 监控**：`stderr` → `appendJobDiagnostic()`；`stdout` → 逐行 JSON 解析 → `appendTranscriptLocked()`；`close` → 等待 exit code
5. **结果合并**：`mergeProcessOutcome()` → 若 spawn 错误或 exit code != 0 → `failed`；否则检查分类器结果 → `confidence >= 0.7` 则用分类 `category` → 否则 `waiting_for_input`
6. **状态持久化**：`writeJobState()` → `finalizeReply()`（更新 reply.json）
7. **进程树**：Claude（主进程）→ Supervisor（detached，持有锁）→ Child（执行工作）

**并发与失败**：
- 并发控制：supervisor 全程持有 job lock
- 失败处理：child spawn 失败 → 标记 `failed`；child 崩溃 → `mergeProcessOutcome()` 处理；supervisor 崩溃 → `reconcileJob()` 检测并标记 `failed` + `recovery_uncertain`
- 分离设计：supervisor detached → 主进程退出不影响；child 崩溃不影响 supervisor 记录结果

**设计取舍与备选**：
- 取：双进程 supervisor/child；舍：单进程（保证监控可靠性，即使 child 崩溃也能记录结果）
- 取：detached supervisor；舍：non-detached（允许主进程退出后作业继续）
- 代价：双进程生命周期管理复杂度增加

**源码测试证据**：
- 位置：`src/jobs/supervisor.ts:1-442`
- 证据：`spawnSupervisorProcess()` 用 `detached: true`、`runJobSupervisor()` 监控 child stdout/stderr/close、`mergeProcessOutcome()` 结合 exit code 与分类器
- 测试：`tests/daemon.test.ts`（supervisor 重启策略、状态清理）

---

#### 模块：JobClassifier（作业分类器）

**真实入口签名**：
```typescript
export function classifyAndWriteState(jobDirectory: string, assistantMessages: AssistantMessage[]): Promise<void>
```

**关键类型**：
```typescript
type JobClassification = {
  category: 'in_progress'|'needs_input'|'completed'|'blocked'|'failed'
  summary: string
  confidence: number  // 0-1
  question: string | null
  evidence: {
    assistant_message_uuids: string[]
    tool_use_ids: string[]
  }
  classified_at: timestamp
  generation: number
  model: string
  status: 'ok'|'stale'|'unavailable'
  error_code?: string
}
```

**输入输出**：
- 输入：`jobDirectory`、`AssistantMessage[]`（当前轮的 assistant 消息）
- 输出：无（副作用：写入 `state.json.classification`）
- 模型：`getSmallFastModel()`（小模型快速分类）
- 工具：`classify_job_turn`（强制工具调用）

**任务/进程状态**：
- `generation`：与 job state 匹配（防止旧结果覆盖新状态）
- `confidence`：≥ 0.7 为 `ok`；否则 `stale`
- `classificationQueues`：按 jobDirectory 串行化（避免锁重入）

**创建/触发/恢复/完成流程**：
1. **队列串行化**：`classificationQueues` Map 确保同 jobDirectory 的分类串行执行（避免与 supervisor 锁竞争）
2. **状态读取**：读取 `initialState` 获取 `generation`
3. **Payload 构建**：`buildTurnPayload()` → 截取最多 64KB 的 assistant 消息 → 提取 `tool_uses`
4. **Side Query**：`sideQuery()` → 小模型 + `classify_job_turn` 工具 → 超时 55 秒 → temperature 0 → max_tokens 768
5. **验证**：`modelClassificationSchema` 验证结构 → `evidenceIsValid()` 验证证据 uuid 真实存在
6. **状态检查**：重新读取 `latestState` → 若 `generation` 不匹配则丢弃（防止旧结果覆盖新状态）
7. **状态写入**：`confidence >= 0.7` → `status: 'ok'`；否则 `status: 'stale'` + `error_code: 'LOW_CONFIDENCE'` → `writeJobState()`（仅更新 `classification`、`updated_at`，不改变 `status`/`pid`/`exit_code` 等）

**并发与失败**：
- 并发控制：`classificationQueues` 串行化；`generation` 版本号防止旧结果覆盖
- 失败处理：分类失败/超时/无效 → 返回 `null`，保留上次分类结果；supervisor 的 `mergeProcessOutcome()` 提供 `unavailable` 兜底
- 不持有锁：supervisor 已持有锁，此处避免重入（proper-lockfile 不可重入）

**设计取舍与备选**：
- 取：小模型快速分类；舍：大模型（速度优先，分类仅作参考）
- 取：`confidence` 阈值 0.7；舍：无阈值（避免低置信度误判）
- 取：仅更新 `classification` 字段；舍：supervisor 合并时决定最终状态（分类器不拥有状态机）
- 代价：分类可能失败 → supervisor 用确定性兜底

**源码测试证据**：
- 位置：`src/jobs/classifier.ts:1-280`
- 证据：`classifyAndWriteStateSerialized()` 检查 `generation`、`requestClassification()` 用 `sideQuery` + 工具、`MIN_USABLE_CONFIDENCE = 0.7`
- 测试：`tests/templateJobs.test.ts`（分类器场景）

---

#### 模块：Proactive（主动唤醒）

**真实入口签名**：
```typescript
export function activateProactive(source: 'command'): boolean
export function deactivateProactive(): boolean
export function pauseProactive(): boolean
export function resumeProactive(): boolean
export function setContextBlocked(blocked: boolean): boolean
export function isProactiveActive(): boolean
export function isProactivePaused(): boolean
export function isProactiveContextBlocked(): boolean
export function getProactiveControlState(): ProactiveControlState
export function getNextTickAt(): number | null
export function setProactiveNextTickAt(value: number | null): void
export function subscribeToProactiveChanges(listener: () => void): ProactiveUnsubscribe
```

**关键类型**：
```typescript
type ProactiveControlState = Readonly<{
  active: boolean
  paused: boolean
  contextBlocked: boolean
}>
type ProactiveUnsubscribe = () => void
```

**输入输出**：
- 输入：`source: 'command'`（仅允许通过命令激活）
- 输出：boolean（是否成功改变状态）
- 订阅机制：`subscribeToProactiveChanges()` 监听状态变化
- 无持久化：状态仅在内存

**任务/进程状态**：
- `controlState`：`{active, paused, contextBlocked}`（只读，通过 setter 改变）
- `nextTickAt`：下次唤醒时间（epoch ms 或 null）
- `listeners`：Set of listener 函数

**创建/触发/恢复/完成流程**：
1. **激活**：`activateProactive('command')` → `active=true, paused=false, contextBlocked=false` → `nextTickAt=null` → `notify()`
2. **停用**：`deactivateProactive()` → `active=false, paused=false, contextBlocked=false` → `nextTickAt=null` → `notify()`
3. **暂停/继续**：`pauseProactive()` → `paused=true` → `nextTickAt=null`；`resumeProactive()` → `paused=false`
4. **上下文阻塞**：`setContextBlocked(true)` → `contextBlocked=true` → `nextTickAt=null`
5. **状态流转**：
   ```
   初始: {active: false, paused: false, contextBlocked: false}
   → activate → {active: true, paused: false, contextBlocked: false}
   → pause → {active: true, paused: true, contextBlocked: false}
   → resume → {active: true, paused: false, contextBlocked: false}
   → setContextBlocked(true) → {active: true, paused: false, contextBlocked: true}
   → deactivate → {active: false, paused: false, contextBlocked: false}
   ```
6. **SleepTool 检查**：`isProactiveActive()` 为 true 时 SleepTool 才启用

**并发与失败**：
- 无并发控制：状态操作是同步简单赋值
- 失败处理：状态未激活时调用 pause/resume/setContextBlocked 返回 false，无副作用
- 幂等设计：重复 activate/deactivate 安全

**设计取舍与备选**：
- 取：仅 `'command'` 源可激活；舍：自动激活（安全优先，用户显式控制）
- 取：不持久化；舍：持久化（避免忘记关闭）
- 取：`nextTickAt` 随状态变化清空；舍：保留（防止暂停/阻塞后错误唤醒）
- 代价：用户需记住激活/停用

**源码测试证据**：
- 位置：`src/proactive/index.ts:1-96`
- 证据：`activateProactive()` 仅接受 `'command'`、状态变化时 `nextTickAt=null`、`subscribeToProactiveChanges()` 通知机制

---

#### 模块：SleepTool（休眠工具）

**真实入口签名**：
```typescript
// 工具定义：src/tools/SleepTool/SleepTool.ts
isEnabled(): boolean { return isProactiveActive() }
```

**关键类型**：
- 工具输入：`{duration: number}`（毫秒）
- 工具输出：`{interrupted: boolean}`

**输入输出**：
- 启用条件：`isProactiveActive() === true`（否则工具不显示）
- 输入：`duration`（毫秒）
- 输出：`interrupted`（是否被中断）

**任务/进程状态**：
- 无内部状态（工具无状态）

**设计取舍与备选**：
- 取：仅 proactive 激活时可用；舍：始终可用（防止普通交互中误用 sleep 阻塞会话）
- 代价：用户需先 activate proactive 才能用 sleep

**源码测试证据**：
- 位置：`src/tools/SleepTool/SleepTool.ts`
- 证据：`isEnabled()` 检查 `isProactiveActive()`

---

#### 模块：RemoteTrigger（远程触发器边界）

**真实入口签名**：
```typescript
// 工具定义：src/tools/RemoteTriggerTool/RemoteTriggerTool.ts
// 操作：list/get/create/update/run
```

**关键类型**：
- 不复制 task-system 或 SDK cron API

**边界说明**：
- 与 CronScheduler 边界：RemoteTrigger 是独立的 claude.ai API 调用，不使用本地 `scheduled_tasks.json`，不参与本地锁竞争
- 与 Task System 边界：RemoteTrigger 调用由工具框架处理，不通过 `createCronScheduler` 调度
- 认证：需要 OAuth（不在本文档范围）

**源码测试证据**：
- 位置：`src/tools/RemoteTriggerTool/RemoteTriggerTool.ts:46-161`
- 证据：工具调用 claude.ai API，不涉及本地 cron 文件/锁

---

### 4.3 模块与状态所有权

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
| cron表达式解析支持5字段标准格式 | src/utils/cron.ts:1-308 | 未找到直接测试 | 仅支持min/hour/dom/month/dow，不支持L/W/?/名字 |
| 锁文件使用O_EXCL原子创建 | src/utils/cronTasksLock.ts:69-91 | 未找到直接测试 | 依赖Node.js fs.writeFile flag='wx' |
| cron抖动：周期性任务使用frac*interval cap 15分钟 | src/utils/cronTasks.ts:381-398 | 未找到直接测试 | jitterFrac从task id计算，稳定 |
| cron抖动：一次性任务在mod 30分钟时提前0-90秒 | src/utils/cronTasks.ts:421-445 | 未找到直接测试 | 可通过growthbook配置调整mod、max、floor |
| 模板作业supervisor detached启动 | src/jobs/supervisor.ts:96-122 | 未找到直接测试 | detached=true，stdio='ignore' |
| supervisor监控child进程stdout/stderr/close | src/jobs/supervisor.ts:356-422 | 未找到直接测试 | 所有事件追加到transcript |
| proactive状态管理和subscribe | src/proactive/index.ts:1-96 | 未找到直接测试 | 仅内存，不持久化 |
| SleepTool仅在proactive激活时启用 | src/tools/SleepTool/SleepTool.ts:53 | 未找到直接测试 | isEnabled()检查isProactiveActive() |
| CronCreateTool验证cron表达式和MAX_JOBS=50 | src/tools/ScheduleCronTool/CronCreateTool.ts:25-116 | 未找到直接测试 | 验证parseCronExpression和nextCronRunMs |
| RemoteTriggerTool调用claude.ai API管理triggers | src/tools/RemoteTriggerTool/RemoteTriggerTool.ts:46-161 | 未找到直接测试 | 需要oauth认证，beta API |
| Cron调度器生命周期 | src/utils/cronScheduler.ts | tests/cronLifecycle.test.ts：一次性任务触发、周期性任务调度、锁竞争接管 | 未覆盖多实例并发场景 |
| Supervisor指数退避重启 | src/jobs/supervisor.ts | tests/daemon.test.ts：supervisor重启策略、maxRestarts限制、状态清理 | 未覆盖实际worker执行失败场景 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/scheduling.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
| --- | --- | --- | --- |
| cron-core | cron表达式解析、抖动计算、missed检测 | tests/cronLifecycle.test.ts |  |
| cron-tasks | 任务持久化CRUD、文件格式 | tests/cronLifecycle.test.ts |  |
| cron-scheduler | 调度循环、锁管理、文件watch、任务触发 | tests/cronLifecycle.test.ts |  |
| cron-lock | scheduler锁文件、PID存活检测 | tests/cronLifecycle.test.ts | computerUseLock.ts（相似模式） |
| jobs-schema | 模板作业类型定义、Zod schema | tests/daemon.test.ts |  |
| jobs-supervisor | supervisor进程管理、child spawn监控、状态合并 | tests/daemon.test.ts |  |
| jobs-state | 作业目录、锁、原子写、transcript | tests/daemon.test.ts |  |
| jobs-classifier | 任务分类逻辑 | tests/templateJobs.test.ts |  |
| proactive-core | 主动唤醒状态管理、subscribe | 未找到专用测试 |  |
| cron-tools | CronCreate/CronDelete/CronList工具 | tests/cronLifecycle.test.ts |  |
| sleep-tool | SleepTool实现 | 未找到专用测试 |  |
| remote-trigger-tool | RemoteTriggerTool实现 | 未找到专用测试 |  |

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
