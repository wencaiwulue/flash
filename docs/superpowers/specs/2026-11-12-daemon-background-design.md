---
id: daemon-background
batch: 6
title: Daemon & Background 守护进程与后台会话设计
date: 2026-11-12
status: draft
---

# Daemon & Background 守护进程与后台会话设计

## 1. 问题与约束

Daemon 与后台会话系统提供两类互补的长期运行能力：
- 守护进程模式：通过 supervisor 自动重启的独立 worker，支持远程控制会话
- 后台会话模式：基于 tmux 的可分离、可恢复的 CLI 会话，支持日志查看和重新附着

这两个子系统共享 UDS（Unix Domain Socket）消息传递基础设施，但在进程生命周期管理、恢复策略和用户交互模型上有明确区别。

**约束条件：**
- 守护进程仅支持 `assistant`/`remote-control` worker 类型
- 后台会话依赖 tmux 可用（Windows 需要 WSL）
- UDS socket 路径长度受限（非 Windows < 100 字节）
- 所有注册表/墓碑/日志文件权限必须为 0o600

## 2. 设计理由与备选方案

### tmux 作为后台会话容器而非直接 daemonize

| 维度 | 说明 |
|---|---|
| **决策** | 使用 tmux 实现后台会话分离与输出捕获 |
| **备选** | 直接 double-fork + nohup，或使用 PM2 等进程管理器 |
| **代价** | 依赖 tmux 可用，Windows 需 WSL 包装，增加复杂度 |
| **证据** | `src/cli/bg.ts:333-335` 检查 tmux 可用，`tests/backgroundSessions.test.ts:156-205` 验证发现/附着/日志/终止 |
| **理由** | tmux 提供免费的：终端输出缓冲、可重新附着、进程组管理、窗口大小处理 |

**选择理由**：
- tmux 提供免费的终端输出缓冲，无需自己实现
- 可重新附着，用户体验好
- 进程组管理，清理彻底
- 窗口大小处理，无需关心

### 多层身份验证而非仅 PID

| 维度 | 说明 |
|---|---|
| **决策** | PID+启动令牌 + tmux socket/pane + 日志路径 + UDS socket 的链式验证 |
| **备选** | 仅依赖 PID，或仅依赖会话目录 |
| **代价** | 代码复杂，授权路径长，Windows 不可用 |
| **证据** | `src/cli/bg.ts:175-227` `authorizeSession()`，`tests/backgroundSessions.test.ts:129-130,191-214` |
| **理由** | PID 复用是现实风险，尤其在长期运行系统上；fail-closed 安全模型要求多因素验证 |

**选择理由**：
- PID 复用是现实风险，尤其在长期运行系统上
- fail-closed 安全模型要求多因素验证
- 链式验证确保会话真实可信

### 原子文件操作 + 严格权限

| 维度 | 说明 |
|---|---|
| **决策** | 所有注册表/墓碑/日志使用 mkdir -m 0o700 + temp-write + rename 原子更新，权限 0o600 |
| **备选** | 直接写入，放宽权限，或使用数据库 |
| **代价** | 代码冗长，需要小心处理每个写入点 |
| **证据** | `src/daemon/main.ts:65-71`、`src/utils/udsRegistry.ts:26-31`、`src/cli/bg.ts:373-376,463` |
| **理由** | 防止竞态、部分写入、其他用户读取敏感信息；0o700/0o600 是类 Unix 系统标准安全实践 |

**选择理由**：
- 防止竞态条件
- 防止部分写入导致的文件损坏
- 防止其他用户读取敏感信息
- 0o700/0o600 是类 Unix 系统标准安全实践

### Supervisor 指数退避重启策略

| 维度 | 说明 |
|---|---|
| **决策** | 失败重启延迟 = min(maxDelay, baseDelay * 2^restarts)，默认 base=1s, max=30s, maxRestarts=5 |
| **备选** | 固定间隔、立即重启、或不重启 |
| **代价** | 暂时故障时服务不可用时间延长 |
| **证据** | `src/daemon/supervisor.ts:63-67`、`tests/daemon.test.ts:91-114` |
| **理由** | 指数退避防止系统过载，同时保证最终恢复；上限防止等待过长；最大重启次数避免永久故障循环 |

**选择理由**：
- 指数退避防止系统过载
- 同时保证最终恢复
- 上限防止等待过长
- 最大重启次数避免永久故障循环

### UDS 作为消息通道而非仅信号

| 维度 | 说明 |
|---|---|
| **决策** | 使用 UDS 进行 ping 发现、会话识别、跨会话提示传递 |
| **备选** | 仅用信号，或使用 TCP localhost，或不提供跨会话通信 |
| **代价** | Socket 路径长度限制，Windows 命名管道差异，需要额外清理逻辑 |
| **证据** | `src/utils/udsMessaging.ts:42-66`、`src/utils/udsClient.ts:58-129`、`tests/udsMessaging.test.ts:42-73` |
| **理由** | UDS 提供可靠的、带身份的消息传递；ping/pong 实现可靠发现；行 JSON 协议简单可扩展 |

**选择理由**：
- UDS 提供可靠的、带身份的消息传递
- ping/pong 实现可靠发现
- 行 JSON 协议简单可扩展

### 墓碑机制而非立即删除

| 维度 | 说明 |
|---|---|
| **决策** | 后台会话终止后移入墓碑保留退出信息，拒绝同 ID 重用（除非 --resume） |
| **备选** | 立即删除注册表记录，或允许自由重用 ID |
| **代价** | 占用少量磁盘空间，需要额外清理逻辑 |
| **证据** | `src/cli/bg.ts:99-109,282-286,653-665`、`tests/backgroundSessions.test.ts:221-224` |
| **理由** | 用户可能想查看已退出会话的退出原因或日志；防止会话 ID 意外重用导致混淆 |

**选择理由**：
- 用户可能想查看已退出会话的退出原因或日志
- 防止会话 ID 意外重用导致混淆

## 3. 目标与非目标

### 目标

- 守护进程模式：提供通过 supervisor 自动重启的独立 worker，支持远程控制会话
- 后台会话模式：提供基于 tmux 的可分离、可恢复的 CLI 会话，支持日志查看和重新附着
- 共享基础设施：提供 UDS 消息传递基础设施，支持跨会话发现和通信
- 安全保证：多层身份验证、原子文件操作、严格权限控制
- 可恢复性：后台会话支持完整恢复，守护进程支持状态查询和幂等启动

### 非目标

- 不支持 Windows 原生后台会话（仅 WSL）
- 不提供守护进程持久化日志（当前 supervisor/worker 无持久化日志）
- 不自动清理墓碑（无自动墓碑过期机制）
- 不实现 `--resume` 标志（已预留但未实现）
- 不支持远程后台会话（当前仅限本地）

## 4. 架构、模块与数据流

### 模块设计卡：daemon-main (守护进程主入口)

**源码位置**：`src/daemon/main.ts`

**真实入口签名**：
```typescript
export async function daemonMain(args: string[]): Promise<void>
export async function startDaemon(kind = 'assistant', registryDir?: string): Promise<DaemonRecord>
export async function stopDaemon(kind = 'assistant', registryDir?: string): Promise<boolean>
export async function getDaemonStatus(kind = 'assistant', registryDir?: string): Promise<{ running: boolean; pid?: number }>
```

**关键类型**：
```typescript
type DaemonRecord = {
  pid: number
  kind: string
  startedAt: string
}
```

**输入输出**：
- 输入：`[command, kind]`，command ∈ {'start', 'stop', 'status', 'run'}
- 输出：
  - start：`Daemon {kind} supervisor running (pid {pid})`
  - stop：`Daemon {kind} stopped` 或 `Daemon {kind} is not running`
  - status：JSON `{"running":true,"pid":1234}` 或 `{"running":false}`
- 状态记录：`$CLAUDE_CONFIG/daemon/{kind}.json`，权限 0o600

**进程与会话状态**：
- Supervisor 进程：detached、stdio='ignore'、unref()
- 注册表目录：0o700，注册表文件：0o600
- 幂等性：重复 start 不创建新实例，仅返回已存在记录

**启动流程**：
1. 读取现有记录，通过 `process.kill(pid, 0)` 验证进程存活
2. 已存在活跃进程 → 直接返回现有记录
3. 存在陈旧记录 → 删除记录
4. spawn supervisor：`node {script} daemon run {kind}`，detached:true
5. 原子写入记录：mkdir -m 0o700 → write temp → rename
6. 写入失败 → kill 已启动的 supervisor 并回滚

**监督流程（runForeground）**：
1. 创建 `DaemonSupervisor` 实例
2. 注册 SIGINT/SIGTERM 信号处理调用 `supervisor.stop()`
3. 调用 `supervisor.run(kind)` 获取退出码
4. 设置 `process.exitCode`

**停止流程**：
1. 读取记录并验证进程存活
2. 删除记录文件
3. 发送 SIGTERM 信号

**错误与恢复**：
- spawn 失败：抛出错误，不留下残留记录
- 写入失败：kill supervisor，抛出错误
- 陈旧记录：下次 start/status 时自动删除
- 停止时进程不存在：返回 false

**设计取舍/备选**：
- 不使用锁文件：依赖原子 rename 和进程存在性验证
- 不捕获 supervisor 输出：当前设计无持久化日志
- 不支持 supervisor 重启：守护进程自身不实现自重启

**源码测试证据**：
- `tests/daemon.test.ts` 验证 start/stop/status 流程、幂等启动、陈旧记录清理

---

### 模块设计卡：daemon-supervisor (守护进程监督器)

**源码位置**：`src/daemon/supervisor.ts`

**真实入口签名**：
```typescript
export class DaemonSupervisor {
  constructor(options: SupervisorOptions)
  async run(kind: string): Promise<number>
  stop(): void
  getState(): { running: boolean; restarts: number; pid?: number }
}

type SupervisorOptions = {
  spawn: (kind: string) => DaemonWorkerProcess
  maxRestarts?: number  // 默认 5
  baseDelayMs?: number  // 默认 1000ms
  maxDelayMs?: number   // 默认 30000ms
  wait?: (ms: number) => Promise<void>
}

export type DaemonWorkerProcess = {
  readonly pid?: number
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  once(event: 'error', listener: (error: Error) => void): void
}
```

**输入输出**：
- 输入：worker kind ∈ {'assistant', 'remote-control'}
- 输出：worker 进程退出码（或最终错误）
- 内部状态：`running`、`stopping`、`restarts`、`active`（当前 worker）

**进程与会话状态**：
- Worker 进程：stdio='inherit'，与 supervisor 同 stdio
- 重启计数器：`restarts`，从 0 开始，失败递增
- 停止标志：`stopping`，主动停止时设为 true，不再重启

**启动/监督/停止流程**：

启动：
1. 检查 `running` 标志防止重入
2. 重置 `stopping=false`、`restarts=0`
3. 进入无限循环：
   a. 调用 `spawn(kind)` 创建 worker
   b. 保存 `active` 引用
   c. 等待 `error` 或 `exit` 事件
   d. 清空 `active` 引用

重启判断：
- `stopping=true` → 返回退出码
- 退出码 `code=0` → 正常返回
- `restarts < maxRestarts` → 进入指数退避后重启
- 否则 → 抛出错误

指数退避：
```typescript
delay = min(maxDelay, base * (2 ** restarts))
```
- base=1s, max=30s, maxRestarts=5
- 第1次失败：等待 1s
- 第2次失败：等待 2s
- 第3次失败：等待 4s
- 第4次失败：等待 8s
- 第5次失败：等待 16s
- 超过：抛出错误

停止：
1. 设置 `stopping=true`
2. 如果有 `active` worker → kill('SIGTERM')

**错误与恢复**：
- Worker 启动错误（spawn 抛出）：计入失败，触发重启
- Worker 非零退出：计入失败，触发重启
- 超过 maxRestarts：抛出错误，supervisor 退出
- 主动 stop：正常退出，不计入失败

**设计取舍/备选**：
- 不使用更复杂的退避策略（如抖动）：当前指数退避足够简单有效
- 不保存重启历史：仅计数，不持久化
- 不区分错误类型：所有非零退出都视为可重启失败

**源码测试证据**：
- `tests/daemon.test.ts` 验证重启策略、maxRestarts 限制、指数退避时序

---

### 模块设计卡：daemon-worker-registry (Worker 类型注册表)

**源码位置**：`src/daemon/workerRegistry.ts`

**真实入口签名**：
```typescript
export async function runDaemonWorker(
  kind: string | undefined,
  dependencies: {
    start?: typeof startRemoteControlServer
    wait?: typeof waitForRemoteControlServer
  } = {}
): Promise<void>
```

**输入输出**：
- 输入：worker kind ∈ {'assistant', 'remote-control'}
- 输出：无（持续运行直到关闭）
- 依赖注入：可选替换 startRemoteControlServer/waitForRemoteControlServer

**进程与会话状态**：
- Worker 类型：仅 'assistant' 和 'remote-control' 两种
- 内部实现：当前两种都映射到 remote-control 模式
- 远程控制服务器启动：创建/复用 query 会话
- 等待关闭：`waitForRemoteControlServer()` 阻塞直到禁用

**启动流程**：
1. 验证 kind 不为 undefined
2. 验证 kind 为已知类型
3. 调用 `startRemoteControlServer()`
4. 调用 `waitForRemoteControlServer()` 等待关闭

**错误与恢复**：
- kind 缺失：抛出 `Missing daemon worker kind`
- unknown kind：抛出 `Unknown daemon worker kind: {kind}`

**设计取舍/备选**：
- 不支持自定义 worker：当前为硬编码列表
- 'assistant' 与 'remote-control' 同义：预留未来扩展空间

**源码测试证据**：
- `tests/daemon.test.ts` 验证 worker 启动与关闭

---

### 模块设计卡：bg-cli (后台会话主入口与生命周期)

**源码位置**：`src/cli/bg.ts`

**真实入口签名**：
```typescript
export async function handleBgFlag(args: string[]): Promise<void>
export async function launchBackgroundSession(
  inputArgs: string[],
  options: BackgroundLaunchOptions = {}
): Promise<BackgroundSessionRecord>
export async function attachHandler(sessionId: string | undefined): Promise<void>
export async function logsHandler(sessionId: string | undefined): Promise<void>
export async function killHandler(sessionId: string | undefined): Promise<void>
export async function psHandler(args: string[]): Promise<void>
export async function authorizeSession(
  input: SessionRegistryRecord | BackgroundSessionRecord,
  operation: 'ps' | 'attach' | 'kill' = 'kill'
): Promise<AuthorizedSession>

export type BackgroundLaunchOptions = {
  executable?: string
  executableArgs?: string[]
  cwd?: string
  env?: Record<string, string>
  waitForRegistration?: boolean  // 默认 true
  stopTimeoutMs?: number
}

export class BackgroundSessionError extends Error {
  readonly code: string
  constructor(code: string, message: string)
}
```

**关键类型**：
```typescript
const VERSION = 'background-sessions-v1'
const MAX_LOG_BYTES = 1024 * 1024
const MAX_LOG_LINES = 200

type AuthorizedSession = {
  record: BackgroundSessionRecord
  state: 'live' | 'stopped' | 'unknown'
  attachedClients: number
}
```

**输入输出**：
- launch：通过 `--bg` 标志触发，返回 session summary JSON
- attach：需要 TTY，附加到 tmux 会话
- logs：输出最后 200 行/1MiB 日志到 stdout
- kill：返回 `{"session_id":"...","state":"stopped"}`
- ps：每行一个 session JSON，或 `--json` 输出完整数组
- 错误：输出 `{code}: {message}` 到 stderr，设置 exitCode=1

**进程与会话状态**：
- SessionId：UUID v4 格式，36字符
- tmux socket：`claude-bg-{uid}-{sessionId[0:8]}`
- tmux session：`bg-{sessionId[0:8]}`
- 日志路径：`$CLAUDE_CONFIG/session-logs/{sessionId}.log`（0o600）
- UDS socket：`/tmp/claude-code-{uid}-{sessionId[0:8]}.sock`
- 进程环境：
  - `CLAUDE_CODE_SESSION_KIND=bg`
  - `CLAUDE_CODE_SESSION_NAME=bg-{suffix}`
  - `CLAUDE_CODE_SESSION_LOG={logPath}`
  - `CLAUDE_CODE_MESSAGING_SOCKET={messagingSocketPath}`
  - `CLAUDE_CODE_ENTRYPOINT=cli`

**启动流程（launchBackgroundSession）**：
1. 前置检查：
   - 验证 `--bg` 标志存在
   - 拒绝冲突模式：`--print`、`--sdk`、`--ssh`、`--remote-control`、`cc:`、`--input-format`
   - 验证 tmux 可用（`checkTmuxAvailable()`）
2. 会话 ID 处理：
   - 从 `--session-id` 读取或生成 UUID
   - 验证格式：`/^[0-9a-f-]{36}$/i`
3. 冲突检测：
   - 检查注册表中是否已存在同 ID 会话
   - 对比 argsHash（sha256 of {cwd, args}）保证参数一致
   - 检查墓碑文件拒绝已退出会话（预留 `--resume`）
4. 准备资源：
   - 创建日志目录（0o700）、日志文件（0o600，O_EXCL）
   - 验证 tmux 会话不存在
5. 创建 tmux 会话：
   ```
   tmux -L {socket} new-session -d -s {session} -c {cwd} \
     -e KEY=VALUE ... -- {command}
   ```
6. 获取 tmux 元数据：
   - `display-message -p '#{socket_path},#{pid},#{pane_pid}'`
   - 验证 tmuxServerPid、tmuxPanePid
7. 获取进程身份：
   - `getProcessIdentity(panePid)` 验证进程 running
   - 获取 processStartToken（防止 PID 复用）
8. 写入注册表：
   - `writeSessionRegistryRecord(record)` 原子写入
9. 启动日志捕获：
   - `pipe-pane -o 'cat >> {logPath}'`
10. 等待注册（可选，默认开启）：
    - 轮询最多 5 秒，检查 `registeredAt` 字段
    - 验证 UDS socket 返回正确 sessionId
11. 失败回滚：
    - kill tmux 会话
    - 删除注册表记录
    - 删除日志文件

**附着流程（attachHandler）**：
1. 验证 stdin/stdout 为 TTY
2. 查找会话，验证不是墓碑
3. 调用 `attach(record)`：
   - 最多重试 3 次
   - 每次先重新 `authorizeSession()`
   - 指数退避（100ms, 200ms, 400ms）
   - 执行 `tmux -L {socket} attach-session -t {session}`
   - Windows 下通过 WSL：`wsl -e tmux ...`

**日志查看流程（readLogs）**：
1. 查找会话（不区分是否墓碑）
2. 验证日志路径在 `$CLAUDE_CONFIG/session-logs/` 内
3. 验证日志文件：普通文件、非符号链接、uid 匹配
4. chmod 0o600（确保正确权限）
5. 读取最后 1MiB：
   - 如果超过 1MiB，从 `size - 1MiB` 开始
   - 截断到第一个换行（避免不完整行）
6. 保留最后 200 行
7. 输出到 stdout，如果需要输出截断警告

**终止流程（killBackgroundSession）**：
1. 查找会话
2. 如果已是墓碑 → 返回 `already_stopped`
3. 初始授权验证
4. 发送 SIGTERM：
   - 每次发送前重新 `authorizeSession()`
   - 验证 processStartToken 未变
5. 等待退出（默认 5 秒）：
   - 每 50ms 检查一次进程状态
   - 重新验证 processStartToken 防止 PID 复用
   - `unknown` 状态继续等待（进程退出中）
6. 超时升级 SIGKILL：
   - 再次验证 token
   - 发送 SIGKILL
   - 等待最多 5 秒
7. 清理 tmux：`kill-session`
8. 写入墓碑：`writeSessionTombstone(stopped)`
9. 删除注册表记录：`deleteSessionRegistryRecord(record)`
10. 返回 `stopped` 状态

**列表流程（listBackgroundSessions）**：
1. 读取所有注册表记录
2. 对每个记录：
   - 非 bg 类型：检查进程存在性，保留或跳过
   - bg 类型：
     - 尝试 `authorizeSession(record, 'ps')`
     - 状态 `stopped`：移入墓碑
     - 状态 `live`/`unknown`：加入列表
3. 按 started_at 排序（相同按 sessionId 字典序）
4. 输出公共字段：
   - `session_id`、`pid`、`kind`
   - `state`、`name`（可选）
   - `cwd`、`started_at`、`updated_at`
   - `attached_clients`、`waiting_for`
   - bg 特有：`tmux_socket`、`tmux_session`、`log_path`

**授权流程（authorizeSession）**：
Fail-closed 链式验证，任何一步失败立即拒绝：

1. **记录验证**：
   - `version === VERSION`
   - `kind === 'bg'`
   - `sessionId`、`processStartToken`、`tmuxSocket`、`tmuxSocketPath`、`tmuxSession`、`logPath` 存在
   - `ownerUid === uid()`
   - `pid === tmuxPanePid`
   - tmuxSocketPath 和 logPath 为绝对路径

2. **日志验证**：
   - 日志文件存在
   - 普通文件、非符号链接、uid 匹配
   - logPath 所在目录 realpath 等于 `$CLAUDE_CONFIG/session-logs` 的 realpath

3. **Windows 检查**：
   - Windows 平台 → 拒绝（PID 身份验证不可用）

4. **进程身份验证**：
   - `getProcessIdentity(pid)`
   - state === 'not_found'：检查 tmux 会话是否还存在，是则冲突
   - state === 'unknown'：ps 操作降级返回 unknown，attach/kill 拒绝
   - state === 'running'：验证 `token === processStartToken`

5. **tmux 身份验证**：
   - tmux socket 文件存在、是 socket、非符号链接、uid 匹配
   - socket 文件所在目录名为 `tmux-{uid}`
   - `has-session -t {tmuxSession}` 成功
   - `display-message -p '#{socket_path},#{pane_pid},#{session_attached}'`
   - socket_path 匹配
   - pane_pid 匹配 pid
   - 返回 attached_clients 数量

6. **UDS 验证（可选）**：
   - 如果有 messagingSocketPath：
     - 非 Windows 时验证绝对路径
     - `pingUdsSession()` 验证返回的 sessionId 匹配

7. **返回授权会话**：
   - `record`、`state`、`attachedClients`

**错误与恢复**：

错误码列表：
- `BG_MODE_CONFLICT`：缺少 --bg 或冲突模式
- `TMUX_UNAVAILABLE`：tmux 不可用
- `SESSION_CONFLICT`：会话 ID 已存在或参数不匹配
- `TMUX_LAUNCH_FAILED`：无法创建 tmux 会话
- `PID_IDENTITY_MISMATCH`：进程身份验证失败
- `SESSION_LAUNCH_TIMEOUT`：后台进程未及时注册
- `SESSION_IDENTITY_CONFLICT`：tmux/UDS 身份不匹配
- `SESSION_NOT_FOUND`：会话不存在或已退出
- `SESSION_NOT_BACKGROUND`：会话不是后台类型
- `SESSION_AMBIGUOUS`：多个会话匹配 ID
- `LOG_UNAVAILABLE`：日志不可用
- `ATTACH_REQUIRES_TTY`：attach 需要 TTY
- `KILL_TIMEOUT`：SIGKILL 后进程未退出
- `INVALID_ARGUMENT`：无效参数
- `BACKGROUND_OPERATION_FAILED`：通用失败

**设计取舍/备选**：
- 使用 tmux 而非直接 daemonize：免费获得输出缓冲、可附着、进程组管理
- 不使用 tmux 内置的 control mode：通过 socket 和 display-message 足够
- PID+startToken 而非仅 PID：防止 PID 复用攻击
- 链式验证而非单一检查：fail-closed 安全模型
- 每次操作前重新验证：防止 TOCTOU 攻击
- 墓碑机制而非立即删除：用户可查看退出原因，防止 ID 重用
- 预留 --resume 标志：当前未实现
- 不自动清理墓碑：无过期机制

**源码测试证据**：
- `tests/backgroundSessions.test.ts` 验证启动/附着/日志/终止、并发会话、PID 令牌验证、防止 PID 复用、身份验证链

---

### 模块设计卡：concurrent-sessions (会话注册表与墓碑)

**源码位置**：`src/utils/concurrentSessions.ts`

**真实入口签名**：
```typescript
export async function registerSession(): Promise<boolean>
export async function writeSessionRegistryRecord(
  record: SessionRegistryRecord | BackgroundSessionRecord
): Promise<void>
export async function readSessionRegistry(): Promise<SessionRegistryRecord[]>
export async function deleteSessionRegistryRecord(
  record: SessionRegistryRecord | BackgroundSessionRecord
): Promise<boolean>
export async function writeSessionTombstone(
  record: SessionRegistryRecord | BackgroundSessionRecord
): Promise<void>
export async function updateSessionActivity(patch: {
  status?: SessionStatus
  waitingFor?: string
}): Promise<void>
export async function updateSessionName(name: string | undefined): Promise<void>
export async function countConcurrentSessions(): Promise<number>

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
export type SessionStatus = 'busy' | 'idle' | 'waiting'

export type SessionRegistryRecord = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: SessionKind
  entrypoint?: string
  name?: string
  logPath?: string
  messagingSocketPath?: string
  processStartToken?: string
  status?: SessionStatus | 'starting'
  waitingFor?: string | null
  updatedAt?: number
  registeredAt?: number
  [key: string]: unknown
}

export type BackgroundSessionRecord = SessionRegistryRecord & {
  version: 'background-sessions-v1'
  launchId: string
  argsHash: string
  lifecycle: 'launching' | 'running' | 'stopping' | 'stopped' | 'failed'
  tmuxSocket: string
  tmuxSocketPath: string
  tmuxSession: string
  tmuxServerPid: number
  tmuxPanePid: number
  ownerUid: number
  exit?: {
    code: number | null
    signal: string | null
    reason: string
    ended_at: number
  } | null
}
```

**输入输出**：
- 注册表目录：`$CLAUDE_CONFIG/sessions/`
- 注册表文件：`{pid}.json`，权限 0o600
- 墓碑目录：`$CLAUDE_CONFIG/session-tombstones/`
- 墓碑文件：`{sessionId}.json`，权限 0o600
- 目录权限：0o700

**进程与会话状态**：
- 注册表记录按 pid 命名：允许同一 sessionId 下多 pid 检测？不，通过 sessionId 查找
- 原子更新：临时文件写入后 rename
- 退出清理：自动注册 cleanup hook
- 会话切换：自动更新记录中的 sessionId

**原子写入流程（atomicWriteJson）**：
1. 创建临时文件：`{path}.{pid}.{timestamp}.tmp`，O_EXCL，0o600
2. 写入内容
3. fsync（handle.sync）
4. chmod 0o600（再次确保）
5. rename 到目标路径（原子覆盖）

**注册流程（registerSession）**：
1. 如果是 agent → 跳过（agent 不注册）
2. 从环境变量或默认值确定 kind
3. 如果是 bg：尝试读取预先存在的 pid.json（launcher 写入的）
4. 注册 cleanup hook：
   - 退出时验证 sessionId 和 processStartToken 未变
   - bg 会话：写入墓碑
   - 删除注册表记录
5. 创建目录（0o700），chmod 目录（0o700）
6. 原子写入注册表记录
7. 注册 session switch hook：更新记录中的 sessionId
8. 返回 true 表示成功

**更新流程（updatePidFile）**：
- 通过队列序列化更新（防止竞态）
- 读取现有记录 → 合并 patch → 原子重写
- 更新 updatedAt 时间戳

**墓碑写入流程（writeSessionTombstone）**：
- 仅处理 kind === 'bg'
- 写入到 `$CLAUDE_CONFIG/session-tombstones/{sessionId}.json`
- 原子写入

**计数流程（countConcurrentSessions）**：
- 读取所有 {pid}.json 文件
- 对每个文件：
  - 如果是当前 pid：计数 +1
  - 否则：验证进程存在（kill(pid, 0)）
- 不在这里删除陈旧记录（bg 清理需要完整授权链）

**错误与恢复**：
- 写入失败：不抛错，仅记录调试日志
- 目录创建失败：忽略，可能已存在
- 读取损坏的 JSON：返回 undefined
- cleanup hook 中错误：静默忽略

**设计取舍/备选**：
- 按 pid 而非 sessionId 命名注册表文件：便于读取所有活跃进程
- 临时文件命名包含 pid 和 timestamp：防止不同进程/时间冲突
- O_EXCL 打开临时文件：防止同一文件并发写入
- fsync 后 rename：确保数据持久化
- 不使用数据库：简单 JSON 文件足够
- 不锁注册表：依赖原子 rename 和进程存在性验证

**源码测试证据**：
- `tests/backgroundSessions.test.ts` 验证原子注册表写入、权限 0o600/0o700、墓碑创建/查询

---

### 模块设计卡：process-identity (进程身份验证)

**源码位置**：`src/utils/processIdentity.ts`

**真实入口签名**：
```typescript
export async function getProcessIdentity(pid: number): Promise<ProcessIdentity>
export async function getProcessStartToken(pid: number): Promise<string | undefined>
export async function matchesProcessStartToken(
  pid: number,
  expected: string
): Promise<boolean>

export type ProcessIdentity = {
  state: 'running' | 'not_found' | 'unknown'
  token?: string
}
```

**输入输出**：
- 输入：pid（必须 > 1，且为安全整数）
- 输出：
  - state：'running'（存在且有 token）、'not_found'（不存在）、'unknown'（权限不足或 token 不可用）
  - token：启动时间戳（平台特定）

**进程与会话状态**：
- Zombie 进程：视为 'not_found'（Linux 上通过 /proc/[pid]/stat 检测，其他通过 ps）
- PID ≤ 1：视为 'not_found'
- EPERM（无权限发信号）：返回 'unknown'
- ESRCH（进程不存在）：返回 'not_found'

**平台实现**：

Linux：
- Token：`/proc/[pid]/stat` 中的第 22 字段（starttime，从系统启动后的 clock tick 数）
- Zombie 检测：`/proc/[pid]/stat` 中的第 3 字段为 'Z'
- 解析：跳过 comm（可能包含空格/括号），从最后一个 ')' 后拆分

macOS/BSD：
- Token：`ps -o lstart= -p {pid}` 的输出（完整启动时间字符串）
- Zombie 检测：`ps -o stat= -p {pid}` 以 'Z' 开头

Windows：
- Token：不可用（返回 undefined）
- Zombie：不检测（返回 false）

**僵尸检测流程（isZombie）**：
1. Linux：读取 /proc/[pid]/stat，查找最后一个 ')'，其后第一个字段为状态
2. 其他：ps -o stat=，检查是否以 'Z' 开头

**获取身份流程（getProcessIdentity）**：
1. 验证 pid > 1 且为安全整数
2. 尝试 `process.kill(pid, 0)`
3. 捕获错误：
   - EPERM → 'unknown'
   - ESRCH → 'not_found'
   - 其他 → 'unknown'
4. 检查是否为 zombie → 'not_found'
5. 尝试获取 token
6. 有 token → `{state:'running', token}`
7. 无 token → `{state:'unknown'}`

**错误与恢复**：
- /proc 读取失败：返回 undefined token
- ps 执行失败：返回 undefined token
- 任何异常：返回 'unknown' 状态

**设计取舍/备选**：
- 使用 starttime 而非创建时间：防止时钟回拨影响
- 不使用 PID alone：PID 复用是现实风险
- Linux 使用 /proc 而非 ps：更高效、更可靠
- Token 不解析为数字：字符串比较即可
- Windows 不支持：依赖 WSL 方案

**源码测试证据**：
- `tests/backgroundSessions.test.ts` 验证 PID 令牌验证、防止 PID 复用

---

### 模块设计卡：uds-registry (UDS 会话注册表)

**源码位置**：`src/utils/udsRegistry.ts`

**真实入口签名**：
```typescript
export async function registerUdsSession(
  session: Required<Pick<UdsLiveSession, 'sessionId' | 'socketPath' | 'pid'>> &
    Pick<UdsLiveSession, 'kind'>,
  registryDir?: string
): Promise<void>
export async function unregisterUdsSession(
  sessionId: string,
  socketPath: string,
  registryDir?: string
): Promise<void>
export async function readUdsRegistry(
  registryDir?: string
): Promise<UdsLiveSession[]>

export type UdsLiveSession = {
  kind?: string
  sessionId?: string
  socketPath: string
  pid?: number
}
```

**输入输出**：
- 注册表目录：`$CLAUDE_CONFIG/uds/`
- 注册表文件：`{sessionId-sanitized}.json`，权限 0o600
- SessionId 清理：替换 `[^a-zA-Z0-9_-]` 为 '_'

**进程与会话状态**：
- 目录权限：0o700
- 文件权限：0o600
- 原子写入：temp write + rename

**注册流程**：
1. mkdir -p -m 0o700 registryDir
2. 临时文件：`{path}.{pid}.tmp`
3. writeFile 临时文件，0o600
4. rename 到目标路径

**注销流程**：
1. 读取现有记录
2. 验证 socketPath 匹配（防止误删他人记录）
3. 删除文件
4. 不存在或不匹配：静默忽略

**读取流程**：
1. 读取目录下所有文件
2. 过滤 .json 文件
3. 尝试解析每个文件
4. 验证 sessionId 和 socketPath 存在
5. 过滤掉无效记录

**错误与恢复**：
- 目录不存在：read 返回空数组
- 文件解析失败：过滤掉该记录
- 注销时不匹配：静默忽略

**设计取舍/备选**：
- 按 sessionId 而非 socketPath 命名：按 ID 查找更高效
- SessionId 清理：防止特殊字符导致的路径问题
- 不校验 session 格式：由 udsMessaging 负责
- 不锁注册表：依赖原子 rename

**源码测试证据**：
- `tests/udsMessaging.test.ts` 验证注册/注销/读取

---

### 模块设计卡：uds-messaging (UDS 消息服务器)

**源码位置**：`src/utils/udsMessaging.ts`

**真实入口签名**：
```typescript
export async function startUdsMessaging(
  socketPath: string,
  options: { isExplicit: boolean; registryDir?: string }
): Promise<void>
export async function stopUdsMessaging(): Promise<void>
export function getUdsMessagingSocketPath(): string | undefined
export function setOnEnqueue(callback: () => void): boolean
export function getDefaultUdsSocketPath(): string

const MAX_FRAME_BYTES = 1024 * 1024
```

**输入输出**：
- 默认 socketPath：
  - Unix：`/tmp/claude-code-{uid}-{sessionId[0:8]}.sock`
  - Windows：`\\.\pipe\claude-code-{uid}-{sessionId[0:8]}`
- 输入帧：行分隔 JSON 或纯文本
- 输出帧：行分隔 JSON
- 最大请求帧：1 MiB
- 最大响应帧：64 KiB

**进程与会话状态**：
- 单例模式：每个进程仅一个活跃 UDS 服务器
- 活跃连接：Set<Socket>，关闭时全部 destroy
- 全局状态：`activeServer`、`activePath`、`activeRegistryDir`、`unregisterCleanup`、`onEnqueue`
- 服务器 unref：不阻止进程退出
- 注册 cleanup hook：进程退出时自动停止

**启动流程**：
1. 单例检查：
   - 已活跃且路径相同 → 直接返回
   - 已活跃且路径不同 → 抛出错误
2. 路径长度检查（非 Windows）：
   - Buffer.byteLength(socketPath) ≥ 100 → 抛出错误
3. Socket 清理（非 Windows）：
   - mkdir -p -m 0o700 父目录
   - 如果 socket 已存在：
     - pingUdsSession 验证是否活跃
     - 活跃 → 抛出错误
     - 不活跃 → unlink 删除
4. 创建服务器：
   - `createServer(connectionHandler)`
   - 监听 socketPath
5. 设置权限（非 Windows）：
   - `chmod(socketPath, 0o600)`
6. 注册会话：
   - `registerUdsSession({sessionId, kind, socketPath, pid})`
7. 注册 error 处理：仅记录调试日志
8. unref 服务器
9. 注册 cleanup hook

**连接处理**：
1. 跟踪连接：加入 Set<Socket>
2. 缓冲数据：拼接 chunk，查找 '\n'
3. 帧大小限制：超过 1 MiB → destroy socket
4. 逐帧处理：`handleFrame(frame, socket)`
5. 连接关闭：从 Set 移除
6. 连接错误：静默忽略（只记录调试日志）

**帧处理（handleFrame）**：
1. 尝试 JSON 解析
2. Ping 请求：
   ```json
   {"type":"ping"}
   →
   {"type":"pong","sessionId":"...","kind":"interactive|headless|bg"}
   ```
3. Message 请求：
   ```json
   {"type":"message","message":"prompt text"}
   →
   {"ok":true}
   ```
4. 纯文本（遗留）：
   ```
   plain text prompt
   →
   {"ok":true}
   ```
5. 空消息：
   ```json
   {"ok":false,"error":"Empty message"}
   ```
6. 有效消息：调用 `enqueue({mode:'prompt', value:message, priority:'later'})`，触发 `onEnqueue` 回调

**停止流程**：
1. 保存当前状态引用
2. 清空全局状态
3. 调用 unregisterCleanup
4. Destroy 所有活跃连接
5. 关闭服务器（等待 close 事件）
6. 注销会话（验证 socketPath 匹配）
7. 删除 socket 文件（非 Windows）

**错误与恢复**：
- 已存在活跃服务器：路径相同返回，不同抛出
- Socket 已存在且活跃：抛出错误
- 路径过长：抛出错误
- 连接错误：静默忽略
- 帧过大：销毁连接
- 消息处理错误：不返回错误（当前设计）

**设计取舍/备选**：
- 单例模式：简化资源管理
- 行分隔 JSON：简单，无需复杂分帧
- 最大帧限制：防止内存耗尽
- 权限 0o600：只有同一用户可连接
- 不认证消息：依赖文件系统权限和 sessionId 验证
- 服务器 unref：后台会话可正常退出
- 不持久化消息：仅内存队列，丢失不重试

**源码测试证据**：
- `tests/udsMessaging.test.ts` 验证服务器启动/关闭、连接处理、帧限制、ping/pong

---

### 模块设计卡：uds-client (UDS 消息客户端)

**源码位置**：`src/utils/udsClient.ts`

**真实入口签名**：
```typescript
export async function pingUdsSession(
  socketPath: string,
  timeoutMs = 300
): Promise<UdsLiveSession | undefined>
export async function listAllLiveSessions(
  registryDir?: string
): Promise<UdsLiveSession[]>
export async function sendToUdsSocket(
  socketPath: string,
  message: string,
  registryDir?: string
): Promise<void>

const MAX_RESPONSE_BYTES = 64 * 1024
```

**输入输出**：
- ping：返回 pong 数据或 undefined
- list：返回所有活跃会话，按 sessionId 排序
- send：
  - 输入：socketPath 或 sessionId
  - 输出：抛出错误或成功返回
- 默认 ping 超时：300ms
- 最大响应：64 KiB

**进程与会话状态**：
- 会话发现：通过注册表 + ping 验证
- 陈旧记录清理：list 时自动删除不响应或 sessionId 不匹配的记录
- SessionId 解析：sendToUdsSocket 接受 sessionId 或 socketPath

**请求流程（requestUds）**：
通用底层实现，供 ping/send 使用：
1. 创建连接
2. 设置超时（clearTimeout 在 finish 时）
3. 连接建立时写入 payload + '\n'
4. 缓冲响应数据
5. 查找 '\n' 分隔符
6. 解析 JSON 响应
7. finish(error, value) 清理并返回
8. 任何错误：reject
9. 超时：reject
10. 响应过大：reject
11. 连接关闭无响应：reject

**Ping 流程**：
1. 发送 `{"type":"ping"}`
2. 验证响应 `type === "pong"` 且 `sessionId` 存在
3. 返回 `{sessionId, kind, socketPath}`
4. 任何失败：返回 undefined

**列表流程（listAllLiveSessions）**：
1. 读取注册表所有记录
2. 对每个记录并行 ping：
   - 成功且 sessionId 匹配 → 保留，添加 pid
   - 失败或 sessionId 不匹配 → 调用 unregisterUdsSession 删除
3. 过滤掉 undefined
4. 按 sessionId 排序
5. 返回结果

**发送流程（sendToUdsSocket）**：
1. 解析目标：
   - 以 '/' 或 '\\' 开头 → socketPath
   - 否则 → sessionId，通过 listAllLiveSessions 查找
2. 未找到会话 → 抛出错误
3. 发送消息（原始字符串或 JSON 帧）
4. 验证响应 `ok === true`
5. 否则 → 抛出错误（或 "UDS peer rejected the message"）

**错误与恢复**：
- Ping 失败：返回 undefined（不抛错）
- 列表中陈旧记录：自动清理
- 发送时会话不存在：抛出错误
- 响应非 ok：抛出错误
- 超时：抛出错误

**设计取舍/备选**：
- 接受 sessionId 或 socketPath：更灵活的 API
- list 时自动清理：防止注册表无限增长
- ping 超时短（300ms）：快速失败，不阻塞
- 不重试发送：调用者负责
- 不批量发送：一次一条

**源码测试证据**：
- `tests/udsMessaging.test.ts` 验证 ping/pong 发现、消息发送、会话识别、陈旧记录清理

---

### 守护进程架构

守护进程采用三层进程树结构：

```
CLI (start/stop/status)
      └─ Daemon Supervisor (detached, pid-recorded)
            └─ Worker Process (restarted on failure)
```

核心组件：
- `main.ts`：提供 daemon 子命令，管理 pid 记录在 `$CLAUDE_CONFIG/daemon/{kind}.json`
- `supervisor.ts`：实现带指数退避的重启策略，默认最大重启 5 次
- `workerRegistry.ts`：定义 worker 类型（当前仅 `assistant`/`remote-control`）

### 后台会话架构

后台会话基于 tmux 实现进程隔离与输出捕获：

```
CLI (launch/attach/logs/kill/ps)
      └─ tmux server (per-session socket)
            └─ tmux session (pane pipe to log)
                  └─ Claude CLI (background mode, UDS-enabled)
```

核心组件：
- `bg.ts`：后台会话生命周期管理与命令处理
- `concurrentSessions.ts`：会话注册表与墓碑机制
- `tmuxSocket.ts`：tmux 抽象与安全验证
- `processIdentity.ts`：PID+启动令牌的进程身份验证

### UDS 消息传递架构

UDS 提供跨会话发现与消息传递：

```
Session Registry ($CLAUDE_CONFIG/uds/{session-id}.json)
      ├─ socket path, session id, pid, kind
      └─ atomic write with 0o600 permissions

Messaging:
      ├─ ping/pong for liveness and session identification
      └─ prompt delivery with JSON framing
```

核心组件：
- `udsRegistry.ts`：会话注册与发现
- `udsMessaging.ts`：UDS 服务器实现
- `udsClient.ts`：客户端 ping、列表、消息发送

### 守护进程启动流程

1. **状态检查**：读取 `$CLAUDE_CONFIG/daemon/{kind}.json`，验证 PID 存活
2. **避免竞态**：检测到已存在且活跃的 daemon 直接返回现有记录
3. **分离启动**：`spawn(..., { detached: true, stdio: 'ignore' })` 并 `unref()`
4. **原子记录**：mkdir -m 0o700 → write temp → rename 保证原子性，文件权限 0o600
5. **清理回滚**：记录写入失败时 kill 已启动的 supervisor

### Supervisor 运行循环

1. **Spawn Worker**：启动指定类型的 worker 进程
2. **等待退出**：监听 `error` 和 `exit` 事件
3. **退出判断**：
   - 主动停止：`stopping=true`，返回退出码
   - 成功退出：code=0，正常返回
   - 失败重启：code≠0 且 `restarts<maxRestarts`
4. **指数退避**：`delay=min(maxDelay, base*2^restarts)`，默认 base=1s, max=30s
5. **超过限制**：连续失败超过 `maxRestarts`（默认 5）后抛出错误

### Worker 进程

Worker 当前为 `remote-control` 模式：
- 启动远程控制服务器
- 创建或复用 query 会话
- 禁用远程控制时清理并返回 query
- 支持 `waitForRemoteControlServer()` 等待关闭

### 后台会话启动与注册流程

1. **前置检查**：
   - 验证 `--bg` 标志存在
   - 拒绝冲突模式（`--print`、`--sdk`、`--ssh`、`--remote-control` 等）
   - 验证 tmux 可用
2. **会话 ID**：从 `--session-id` 读取或生成 UUID，验证格式
3. **冲突检测**：
   - 检查注册表中是否已存在同 ID 会话
   - 对比 argsHash 确保参数一致
   - 检查墓碑文件拒绝已退出会话（除非 `--resume`）
4. **tmux 创建**：
   - 专用 socket：`claude-bg-{uid}-{suffix}`
   - 会话名：`bg-{suffix}`
   - 输出管道：`pipe-pane -o 'cat >> {logPath}'`
5. **日志文件**：`$CLAUDE_CONFIG/session-logs/{sessionId}.log`，权限 0o600
6. **注册表写入**：原子写入 session 记录，包含完整身份元数据
7. **等待注册**：轮询等待后台进程注册 UDS 并验证 socket sessionId 匹配

### 后台会话附着与分离

附着流程：
1. **会话查找**：通过 sessionId 查找注册表或墓碑
2. **授权验证**：执行完整的 `authorizeSession()` 检查
3. **tmux attach**：调用 `tmux -L {socket} attach-session -t {session}`
4. **重试逻辑**：最多 3 次，指数退避

分离是标准 tmux 行为（`C-b d`），会话继续后台运行。

### 后台会话日志查看

日志特性：
- 保留最后 200 行或 1 MiB，取较晚者
- 截断时输出警告
- 保持日志文件权限 0o600 不变
- 验证日志路径在预期目录内

### 后台会话终止流程

1. **查找与授权**：同附着流程
2. **SIGTERM**：发送优雅终止信号
3. **等待退出**：默认 5 秒超时，可配置
4. **身份重验证**：每次检查都重新验证进程令牌，防止 PID 复用
5. **SIGKILL 升级**：超时后发送强制终止
6. **清理 tmux**：`kill-session` 销毁 tmux 会话
7. **写入墓碑**：在 `$CLAUDE_CONFIG/session-tombstones/` 保存退出信息
8. **删除注册表**：移除活跃会话记录

### 后台会话列表（ps）

列表输出包含：
- `session_id`、`pid`、`kind`
- `state`（idle/busy/unknown）
- `cwd`、`started_at`、`updated_at`
- `attached_clients`（tmux 附着数）
- `tmux_socket`、`tmux_session`、`log_path`（仅后台会话）

清理：列表时自动将已停止的后台会话移入墓碑。

### UDS 协议帧格式

```
Line-based JSON frames:
  { "type": "ping" } → { "type": "pong", "sessionId": "...", "kind": "interactive"|"headless"|"bg" }
  { "type": "message", "message": "prompt text" } → { "ok": true }
  Plain text (legacy) → { "ok": true }
```

限制：
- 单帧最大 1 MiB，超过则断开连接
- 响应最大 64 KiB
- ping 超时默认 300ms

### UDS 安全模型

**文件系统权限**：
- Socket 路径权限 0o600
- 注册表目录 0o700，文件 0o600
- 日志目录 0o700，文件 0o600
- 所有写入使用原子 rename 避免部分文件

**会话发现安全**：
- `listAllLiveSessions()` 对每个记录执行 ping
- SessionId 不匹配时自动清理陈旧记录
- Socket 路径验证：非 Windows 上必须是绝对路径

**消息安全**：
- 通过 sessionId 发送时自动解析到对应 socket path
- Ping 验证 sessionId 匹配防止消息错送
- 不提供跨用户通信

### UDS 服务器生命周期

1. **启动前检查**：
   - 已存在活跃服务器且路径相同直接返回
   - 已存在服务器但路径不同抛出错误
   - Socket 路径长度限制（非 Windows < 100 字节）
2. **Socket 清理**：检查已存在 socket，通过 ping 验证是否活跃，活跃则报错，不活跃则删除
3. **服务器启动**：`createServer()` 并 `listen(socketPath)`
4. **权限设置**：`chmod(socketPath, 0o600)`
5. **注册会话**：在 UDS 注册表记录 sessionId、socketPath、pid、kind
6. **连接处理**：
   - 跟踪活跃连接数
   - 缓冲拼接拆分包
   - 错误时静默忽略（只记录调试日志）
7. **关闭清理**：
   - 销毁所有活跃连接
   - 关闭服务器
   - 从注册表删除记录
   - 删除 socket 文件

### 守护进程恢复

守护进程不支持跨重启恢复，但提供：
- 状态查询：`daemon status` 返回当前运行状态和 pid
- 检测陈旧：读取 pid 记录后验证进程存活，不存活则删除记录
- 幂等启动：重复 `daemon start` 返回已有记录而不启动新实例

### 后台会话恢复

后台会话支持完整恢复：

**活跃会话恢复**：
- 通过 sessionId 查找注册表记录
- 执行完整身份验证（PID+令牌、tmux socket/pane、日志路径、UDS socket）
- 支持重新附着、查看日志、终止

**已退出会话（墓碑）**：
- 终止后保留墓碑记录，包含退出信息
- 墓碑可查询但不能重新附着
- 拒绝重用已退出会话的 ID（除非 `--resume`）

**身份验证链**（`authorizeSession`）：
1. 验证记录版本、kind、必需字段完整性
2. 验证日志文件存在、权限、路径正确
3. 验证进程 PID+启动令牌匹配（防止 PID 复用）
4. 验证 tmux socket 存在、uid 匹配、会话存在、pane pid 匹配
5. 验证 UDS socket（如果存在）返回正确 sessionId

## 5. 失败语义与工程取舍

### 守护进程失败语义

| 失败场景 | 处理方式 |
|---|---|
| 已存在活跃 daemon | 直接返回现有记录 |
| supervisor 启动失败 | 清理回滚，返回错误 |
| worker 失败（code≠0） | 指数退避重启，最多 5 次 |
| 超过最大重启次数 | supervisor 退出，返回错误 |
| 主动停止（`daemon stop`） | 正常退出，不重启 |
| 陈旧 pid 记录 | 验证进程不存活则删除记录 |

### 后台会话失败语义

| 失败场景 | 处理方式 |
|---|---|
| tmux 不可用 | 拒绝启动，提示安装 tmux |
| 冲突模式（--print 等） | 拒绝启动，提示冲突 |
| 会话 ID 已存在（活跃） | 拒绝启动，提示已存在 |
| 会话 ID 已存在（墓碑） | 拒绝启动，除非 --resume |
| tmux attach 失败 | 最多 3 次，指数退避 |
| 进程终止（SIGTERM） | 等待 5 秒超时，升级 SIGKILL |
| 身份验证失败 | 拒绝操作，静默清理陈旧记录 |

### UDS 失败语义

| 失败场景 | 处理方式 |
|---|---|
| Socket 路径过长 | 拒绝启动 |
| 已存在活跃服务器 | 路径相同直接返回，不同则报错 |
| Socket 文件已存在 | ping 验证，活跃报错，不活跃删除 |
| 单帧超过 1 MiB | 断开连接 |
| ping 超时（300ms） | 视为会话不存活，清理记录 |
| 消息发送失败 | 返回错误，不重试 |

### 工程取舍

| 维度 | 选择 | 代价 |
|---|---|---|
| 后台容器 | tmux | 依赖 tmux，Windows 需 WSL |
| 身份验证 | 多层链式 | 代码复杂，授权路径长 |
| 文件操作 | 原子写入 + 严格权限 | 代码冗长 |
| 重启策略 | 指数退避 | 暂时故障时不可用时间延长 |
| 消息通道 | UDS | 路径长度限制，Windows 差异 |
| 退出处理 | 墓碑机制 | 占用少量磁盘空间 |

## 6. 现状验收标准

### 守护进程功能

- 必须支持 `daemon start`、`daemon stop`、`daemon status` 命令
- 必须原子记录 pid 文件在 `$CLAUDE_CONFIG/daemon/{kind}.json`，权限 0o600
- Supervisor 必须实现指数退避重启策略（base=1s, max=30s, maxRestarts=5）
- Worker 必须支持 `remote-control` 模式
- 必须检测陈旧 pid 记录并删除
- 必须幂等启动（重复 `daemon start` 返回已有记录）

### 后台会话功能

- 必须验证 `--bg` 标志，拒绝冲突模式
- 必须验证 tmux 可用
- 必须检查会话 ID 冲突（活跃或墓碑）
- 必须创建专用 tmux socket 和会话
- 必须管道输出到日志文件（`$CLAUDE_CONFIG/session-logs/{sessionId}.log`，权限 0o600）
- 必须原子写入注册表记录
- 必须支持 `bg attach`、`bg logs`、`bg kill`、`bg ps` 命令
- 终止时必须写入墓碑，拒绝同 ID 重用（除非 --resume）
- `bg ps` 必须自动清理已停止的会话到墓碑

### UDS 功能

- 必须创建 socket 权限 0o600
- 必须验证 socket 路径长度（非 Windows < 100 字节）
- 必须支持 ping/pong 发现和会话识别
- 必须支持 JSON 帧消息传递
- 单帧必须限制 1 MiB，响应限制 64 KiB
- ping 超时默认 300ms
- 必须原子写入注册表记录（`$CLAUDE_CONFIG/uds/{session-id}.json`，权限 0o600）
- `listAllLiveSessions()` 必须对每个记录执行 ping，清理陈旧记录
- 通过 sessionId 发送必须验证 sessionId 匹配防止错送

### 安全要求

- 所有注册表/墓碑/日志目录权限必须 0o700，文件必须 0o600
- 所有写入必须使用 temp-write + rename 原子更新
- 后台会话必须执行完整身份验证链（PID+令牌、tmux、日志、UDS）
- 每次检查进程必须重验证令牌防止 PID 复用
- Socket 路径必须验证（非 Windows 绝对路径）

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
| --- | --- | --- | --- |
| tmux作为后台会话容器 | `src/cli/bg.ts`, `src/cli/tmuxSocket.ts` | tests/backgroundSessions.test.ts：会话发现/附着/日志/终止、并发会话 | Windows仅支持WSL |
| 多层身份验证 | `src/cli/processIdentity.ts`, `src/cli/bg.ts` | tests/backgroundSessions.test.ts：PID令牌验证、身份验证链、防止PID复用 | 未覆盖所有攻击向量 |
| 原子文件操作+严格权限 | `src/utils/udsRegistry.ts`, `src/cli/concurrentSessions.ts` | tests/backgroundSessions.test.ts：原子注册表写入、权限0o600/0o700 | 未覆盖并发写竞态 |
| Supervisor指数退避重启 | `src/daemon/supervisor.ts` | tests/daemon.test.ts：重启策略验证、maxRestarts限制 | 未覆盖实际worker崩溃场景 |
| UDS作为消息通道 | `src/utils/udsMessaging.ts`, `src/utils/udsClient.ts` | tests/udsMessaging.test.ts：ping/pong发现、消息发送、帧限制、会话识别 | 未覆盖大量并发消息 |
| 墓碑机制 | `src/cli/concurrentSessions.ts` | tests/backgroundSessions.test.ts：墓碑创建、查询、拒绝ID重用 | 无自动墓碑过期机制 |
| 后台会话生命周期 | `src/cli/bg.ts` | tests/backgroundSessions.test.ts：启动/附着/日志/终止、墓碑机制 | 未实现--resume标志 |
| 守护进程生命周期 | `src/daemon/main.ts` | tests/daemon.test.ts：启动/停止/状态查询、幂等启动、陈旧记录检测 | 无持久化日志 |
| UDS服务器生命周期 | `src/utils/udsMessaging.ts` | tests/udsMessaging.test.ts：服务器启动/关闭、连接处理 | Socket路径长度限制（非Windows<100字节） |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/daemon-background.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
| --- | --- | --- | --- |
| daemon-main | 守护进程命令与生命周期、PID记录 | tests/daemon.test.ts |  |
| daemon-supervisor | Supervisor指数退避重启、进程管理 | tests/daemon.test.ts |  |
| daemon-worker-registry | Worker类型定义（assistant/remote-control） | tests/daemon.test.ts |  |
| bg-cli | 后台会话命令与生命周期（launch/attach/logs/kill/ps） | tests/backgroundSessions.test.ts |  |
| concurrent-sessions | 会话注册表与墓碑机制、原子文件操作 | tests/backgroundSessions.test.ts |  |
| tmux-socket | tmux抽象与安全验证、会话管理 | tests/backgroundSessions.test.ts |  |
| process-identity | PID+启动令牌的进程身份验证、防止PID复用 | tests/backgroundSessions.test.ts |  |
| uds-registry | UDS会话注册与发现、原子操作、权限验证 | tests/udsMessaging.test.ts |  |
| uds-messaging | UDS服务器实现、ping/pong、消息处理、帧限制 | tests/udsMessaging.test.ts |  |
| uds-client | UDS客户端实现、ping、会话枚举、消息发送 | tests/udsMessaging.test.ts |  |

## 8. 文件覆盖与相关子系统

本设计的覆盖率文件位于 [Coverage](../../architecture/coverage/daemon-background.yaml)。

### 相关文件

- `src/daemon/main.ts`：守护进程命令与生命周期
- `src/daemon/supervisor.ts`：Supervisor 指数退避重启
- `src/daemon/workerRegistry.ts`：Worker 类型定义
- `src/cli/bg.ts`：后台会话命令与生命周期
- `src/cli/concurrentSessions.ts`：会话注册表与墓碑
- `src/cli/tmuxSocket.ts`：tmux 抽象与验证
- `src/cli/processIdentity.ts`：PID+令牌身份验证
- `src/utils/udsRegistry.ts`：UDS 会话注册与发现
- `src/utils/udsMessaging.ts`：UDS 服务器实现
- `src/utils/udsClient.ts`：UDS 客户端实现
- `tests/daemon.test.ts`：守护进程测试
- `tests/backgroundSessions.test.ts`：后台会话测试
- `tests/udsMessaging.test.ts`：UDS 消息传递测试

### 相关子系统

- SDK Query Sessions：UDS 消息传递基础设施
- Remote Control：守护进程 worker 模式
- Teleport：未来可集成远程后台会话

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | 当前 WSL 包装可用性有限，Windows 用户无法使用后台会话 | 提供原生 Windows 方案（如使用 Windows Subsystem for Linux 或者使用 Windows Terminal 隔离） | 中：需保持现有 Unix 平台功能不变 | 在 Windows 上测试后台会话启动、附着、日志查看、终止完整流程 | M | 已证实（基于代码阅读） |
| P1 | 当前 supervisor/worker 无持久化日志，问题难以诊断 | 添加日志输出到 `$CLAUDE_CONFIG/daemon/{kind}.log`，支持日志轮转 | 低：可实现为可选功能，默认关闭或最小日志 | 验证 daemon 启动/失败/重启有日志记录，日志目录权限正确 | S | 已证实（基于代码阅读） |
| P2 | 无自动墓碑过期机制，长期运行可能占用过多磁盘 | 添加配置选项自动清理超过一定时间的墓碑（如 7 天、30 天） | 低：可实现为后台任务，默认保守策略 | 测试墓碑自动清理逻辑，验证配置项生效 | S | 已证实（基于代码阅读） |
| P2 | 当前已预留 `--resume` 标志但未实现，用户无法从墓碑恢复 | 实现从墓碑恢复会话功能，包括会话状态、日志、进程身份验证 | 中：需确保恢复流程安全，防止会话劫持 | 测试从墓碑恢复会话，验证身份验证、权限检查、日志连续性 | M | 已证实（基于代码阅读） |
| P3 | 当前后台会话仅限本地，与 teleport 集成可支持远程 | 与 teleport 集成支持远程后台会话，实现跨设备会话迁移 | 中：需要考虑安全边界和权限模型 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 当前 UDS 在 Windows 上使用命名管道，测试覆盖不足 | 完善 UDS Windows 支持和测试，确保与 Unix 平台功能一致 | 低：现有功能已有基础，主要是测试完善 | 增加 Windows 平台 UDS 通信测试覆盖 | M | 待运行验证 |
| P3 | 用户需要 CLI 之外的管理方式，Web UI 更直观 | 探索提供 Web UI 查看和管理后台会话、守护进程 | 低：可选功能，不影响核心功能 | 设计阶段探索技术方案 | L | 设计推断 |
| P3 | 当前仅支持 `assistant`/`remote-control`，扩展性有限 | 支持插件化自定义 Worker 类型，允许第三方扩展 | 中：需要定义清晰的插件接口和安全边界 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 当前无分布式支持，仅单机运行 | 探索支持跨设备后台会话同步和管理 | 高：涉及分布式系统复杂性 | 设计阶段探索技术方案 | L | 设计推断 |
