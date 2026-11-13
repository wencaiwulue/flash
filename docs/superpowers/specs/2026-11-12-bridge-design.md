---
id: bridge
batch: 2
title: Bridge 环境桥接与远程工作生命周期设计
date: 2026-11-12
status: draft
---

# Bridge 环境桥接与远程工作生命周期设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Bridge 系统解决的核心问题是让 claude.ai 网页能安全地控制本地 Claude Code CLI 实例，同时保持可靠的会话生命周期管理、多会话隔离、权限回调和崩溃恢复。

核心问题域：
- **环境注册与发现**：如何让服务器识别并路由到特定的本地 CLI 实例，同时支持重连恢复？
- **轮询与重连策略**：在网络不稳定时如何保证不丢消息、不重复处理工作？
- **工作秘密安全**：如何安全传递会话凭证，同时支持两个版本的协议？
- **会话生命周期**：从 spawn、心跳到超时终止，如何管理子进程与状态跟踪？
- **权限回调**：工具权限请求如何从子进程路由到网页端，再路由回来？
- **多会话与 worktree**：如何支持并行会话而不互相踩踏文件系统？
- **关闭与恢复**：干净退出和崩溃恢复的语义有何不同？
- **安全边界**：OAuth、环境 secret、会话 JWT、受信设备 token 各层的职责是什么？

约束条件：
- 不能复制 remote-control、daemon 或 SDK 的设计文档，只写 bridge 模块
- 需要支持两个主要实现：standalone `claude remote-control` 和内嵌的 REPL bridge
- 需要同时支持 v1（env-based，轮询）和 v2（env-less，直接连接）两种协议
- 崩溃恢复需要跨 worktree 查找指针，因为 REPL 可能在不同的 worktree 中运行

## 2. 设计理由与备选方案

| 决策维度 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---------|---------|----------|-------------------|-----|------|
| 幂等注册 | Client 生成 bridgeId 和 environmentId，携带 git 信息、worker_type、max_sessions、spawn_mode 注册 | Client 侧生成 UUID 确保重试幂等，携带 git 信息提升用户体验，worker_type 让服务器区分来源 | Server 生成所有 ID：重试无法幂等，需要额外去重；不携带 git 信息：体验下降 | Client 需要存储恢复 ID | bridgeApi.ts 中的注册请求 |
| 恢复语义 | `--session-id` 和 `--continue` 使用 reuseEnvironmentId 重新注册，同时调用 reconnectSession 强制终止 stale worker | 用户期望回到同一会话，强制终止防止两个 bridge 同时处理 | 每次创建新环境：用户需要接受新 session URL | bridgeMain.ts 的 resume 分支，bridgeApi.ts 的 reconnectSession |
| 轮询配置 | 不在容量时默认 2 秒轮询，在容量时默认 10 分钟轮询 + 可选心跳，回收窗口 5 秒 | 平衡响应速度和服务器负载，心跳提供更轻量的 liveness，回收窗口让崩溃实例快速被接管 | 仅心跳：需要持续连接；仅轮询：延迟高 | 配置复杂度增加 | pollConfigDefaults.ts、pollConfig.ts |
| 安全规则 | 所有间隔 ≥ 100ms 防止 DDoS，在容量时至少一种 liveness 机制，Zod 验证配置回退默认值 | 深度防御防止配置错误导致问题，回退默认值保证可用性 | 无验证：可能导致严重问题 | pollConfig.ts 的 object-level refine |
| 退避策略 | 连接错误：2s→4s→8s→…→120s cap，10 分钟后放弃；一般错误：500ms→…→30s cap；睡眠检测：间隙 > 2×cap 时重置错误预算 | 指数退避防止服务器过载，睡眠检测处理笔记本合盖场景，放弃窗口平衡可用性 | 无退避：服务器过载；无放弃：永久重试 | bridgeMain.ts 的 runBridgeLoop |
| 心跳机制 | heartbeatWork 使用 session ingress JWT（无 DB 命中）延长租约，capacityWake 在会话结束时唤醒，auth 失败触发 reconnectSession | 心跳比轮询轻量，capacityWake 让新工作立即被接受，auth 失败主动恢复 | 仅轮询：负载高；仅心跳：无新工作唤醒 | bridgeMain.ts 的心跳循环，capacityWake.ts |
| WorkSecret 结构 | version: 1，session_ingress_token，api_base_url，sources，auth，claude_code_args，mcp_config，environment_variables，use_code_sessions | 显式版本支持演进，use_code_sessions 让服务器渐进迁移 v2，session ingress token 与 OAuth 分离 | 无版本：难以演进；合并 token：安全边界不清晰 | types.ts 的 WorkSecret 定义，workSecret.ts 的 decodeWorkSecret |
| URL 构建 | v1：buildSdkUrl → WebSocket URL，localhost 用 /v2/，生产用 /v1/；v2：buildCCRv2SdkUrl → HTTP URL，指向 /v1/code/sessions/{id} | 支持双协议渐进迁移，localhost 使用 v2 方便开发 | 统一用 /v1/：本地开发与生产不一致 | workSecret.ts 的三个 URL/ID 函数 |
| ID 比较 | sameSessionId 比较 UUID 时忽略 session_ vs cse_ 前缀 | 处理兼容层 retag，防止 v2 迁移期间拒绝自己的会话 | 严格相等：可能误拒绝 | workSecret.ts 的 sameSessionId |
| Token 刷新 | createTokenRefreshScheduler 在 JWT 过期前 5 分钟主动刷新，generation counter 让 stale in-flight refresh 失效，连续 3 次失败后放弃，60 秒重试延迟，子进程通过 stdin 的 update_environment_variables 消息接收新 token | 主动刷新避免请求中间 token 过期失败，generation counter 防止竞态，通过 stdin 推送简化子进程设计 | 被动刷新：用户请求可能失败；子进程拉取：复杂度高 | jwtUtils.ts，sessionRunner.ts 的 updateAccessToken |
| Spawn 模式 | single-session（一个会话后退出）、same-dir（多会话共享 cwd）、worktree（每个会话独立 git worktree） | 灵活支持不同场景，single-session 简单，same-dir 快速原型，worktree 强隔离 | 仅一种模式：无法满足所有场景 | types.ts 的 SpawnMode，bridgeMain.ts 的 worktree 创建逻辑 |
| 会话 Spawner | 子进程用 --print、--sdk-url、--session-id 启动，去掉 CLAUDE_CODE_OAUTH_TOKEN，设置 CLAUDE_CODE_ENVIRONMENT_KIND=bridge、CLAUDE_CODE_SESSION_ACCESS_TOKEN、v1/v2 标志，NDJSON 从 stdout 解析，stderr 调试，activity 环形缓冲区（最后 10 个活动），超时看门狗（默认 24 小时） | 剥离父 OAuth token 是安全边界，NDJSON 是简单可调试的 IPC，超时防止遗忘会话无限运行 | 继承 OAuth token：子进程权限过大；二进制 IPC：难以调试 | sessionRunner.ts 的 createSessionSpawner |
| 活动跟踪 | 每秒更新状态显示，工具动词映射（Read→Reading，Write→Writing），最后 5 个活动 trail，多会话模式活动列表，标题派生从第一条真实用户消息（跳过 tool-result、synthetic） | 人类可读的动词友好，跳过工具结果防止标题无用 | 原始工具名：不够友好；第一条任意消息：标题可能是工具结果 | sessionRunner.ts 的 extractActivities，bridgeMain.ts 的状态更新循环 |
| 权限回调 | 子进程发出 control_request（subtype: can_use_tool），bridge 通过 sendPermissionResponseEvent 转发到服务器，用户在网页批准/拒绝，服务器发送 control_response，bridge 通过 stdin 转发回子进程 | 权限请求由子进程发起（只有它知道完整上下文），bridge 仅透明路由 | Bridge 拦截权限请求：需要理解所有工具上下文 | sessionRunner.ts 的 control request 检测，bridgeMain.ts 的转发逻辑，bridgePermissionCallbacks.ts |
| 容量管理 | 默认 32 个会话（SPAWN_SESSIONS_DEFAULT），--capacity 可配置，在容量时用心跳代替轮询或降低频率，capacityWake 在会话结束时唤醒 | 限制并发保证稳定性，容量时降低负载，capacityWake 快速响应 | 无容量限制：可能 OOM；无唤醒：新工作等待久 | bridgeMain.ts 的容量判断，capacityWake.ts |
| Worktree 创建与清理 | 用 createAgentWorktree 创建隔离 git worktree，最佳努力清理会话结束时删除，hook-based 回退（git worktree 不可用时），--continue 扫描 sibling worktrees 查找 pointer | Worktree 提供强隔离，hook 回退保证可用性，跨 worktree 扫描是必须的（REPL 可能在不同 worktree 启动然后写入 pointer） | 所有会话用 worktree：UX 下降（初始不在用户期望目录）；无扫描：无法恢复 | bridgeMain.ts 的 worktree 逻辑，bridgePointer.ts 的 readBridgePointerAcrossWorktrees |
| 干净关闭 | SIGINT/SIGTERM 或 controller abort 触发，给所有活跃会话发送 SIGTERM，等待最多 shutdown grace period（默认 30s），SIGKILL stragglers，对所有活跃工作项调用 stopWork（带重试），archive 所有会话（幂等），deregister 环境，清除 crash-recovery pointer，等待待清理的 promise（stopWork、worktree 删除） | 有序清理防止资源泄漏，幂等 archive 防止重复，清除 pointer 防止意外恢复 | 直接退出：资源泄漏，会话挂起 | bridgeMain.ts 的 teardown 逻辑（2435-2600+ 行） |
| 崩溃恢复 | Pointer 文件：bridge-pointer.json（v1）或 env-less-bridge-pointer.json（v2），TTL 4 小时（与服务器 BRIDGE_LAST_POLL_TTL 匹配），包含 sessionId、environmentId、source、lastSequenceNum（v2），权限 0o600，perpetual 模式：pointer 在 teardown 时保留，不 archive 会话 | 4 小时 TTL 让恢复在合理时间可用，0o600 防止其他用户读取，perpetual 模式让 CLI 退出后会话继续，重启无缝恢复 | 无 TTL：stale pointer 累积；无权限：安全风险 | bridgePointer.ts，envLessBridgePointer.ts，perpetualBridge.test.ts |
| 四层认证 | OAuth access token（环境注册、轮询）、environment secret JWT（工作认领）、session ingress JWT（会话特定操作：心跳、权限响应）、trusted device token（v2 elevated security tier） | 深度防御，每层职责明确 | 单层 token：安全风险高 | bridgeApi.ts、trustedDevice.ts |
| 受信设备 Token | 登录后立即注册（服务器 gate 检查 account_session.created_at < 10min），存储在 keychain（macOS），作为 X-Trusted-Device-Token 头发送，90 天滚动过期，enrollment 永远不阻塞登录流程（最佳努力） | Elevated security tier 用于敏感操作，但 enrollment 不能成为登录障碍 | 必需 enrollment：登录流程复杂 | trustedDevice.ts |
| 输入验证 | SAFE_ID_PATTERN：^[a-zA-Z0-9_-]+$ 防止路径遍历，MAX_INBOUND_TEXT_LENGTH：1MB，MAX_INBOUND_BASE64_LENGTH：20MB，MAX_INBOUND_ATTACHMENTS：20，envelope 严格验证字段白名单，不允许额外字段 | 严格输入验证是安全基础，即使服务器也验证，本地提供深度防御 | 宽松解析：可能注入攻击 | inboundMessages.ts、bridgeApi.ts |
| Feature Gate 与权限检查 | isBridgeEnabled：需要 claude.ai 订阅 + tengu_ccr_bridge gate；isEnvLessBridgeEnabled：检查 tengu_bridge_repl_v2 gate；getBridgeDisabledReason：详细诊断为什么不可用（构建 flag？未订阅？token scope 不足？无 org UUID？gate 关闭？）；policy check：allow_remote_control 必须允许 | 分层 gate 让功能渐进发布（内部 dogfood→ant→beta→full），详细禁用原因避免用户困惑，帮助诊断问题 | 单一 gate：诊断路径不清晰 | bridgeEnabled.ts、initReplBridge.ts |
| 两个 Bridge 实现 | Standalone：命令 claude remote-control，轮询/工作分发模型，多会话支持，子进程 spawn，状态显示；REPL bridge：通过 /remote-control 在交互式会话中调用，两个变体（v1 env-based 轮询，v2 env-less 直接连接），perpetual 模式（会话在 CLI 退出后存活，重启恢复），进程内消息转发（不 spawn 子进程），初始历史刷新带 cap（默认 200 条消息），flush gate（历史刷新期间排队实时写入） | Perpetual 模式让用户可以关闭 CLI 然后回来继续同一会话（符合网页会话直觉），flush gate 防止历史刷新与实时消息交错，保证一致性 | 仅有 standalone：无法在交互式会话中使用；仅进程内：无法隔离 | bridgeMain.ts，replBridge.ts，remoteBridgeCore.ts，initReplBridge.ts，flushGate.ts |

## 3. 目标与非目标

### 状态与生命周期

目标：
- 提供环境注册、轮询、确认、心跳、停止的完整 v1 API
- 提供代码会话创建、事件 SSE、worker POST 的完整 v2 API
- 管理子进程 spawn、activity 跟踪、超时看门狗
- 实现崩溃恢复指针（跨 worktree 扫描，TTL）
- 提供 perpetual 模式支持（CLI 退出后会话继续）
- 权限请求透明路由

非目标：
- 不处理代理执行逻辑（由 SDK 负责）
- 不处理 OAuth 流程（由 auth 模块负责）
- 不处理工具实现（由各工具模块负责）

### 接口与数据

目标：
- WorkSecret 类型安全的解码与验证
- SessionHandle 接口提供 kill、writeStdin、updateToken
- BridgePointer 读写与跨 worktree 扫描
- PollConfig Zod 验证与默认值回退

非目标：
- 不提供 SDK 导出（仅内部使用）
- 不暴露底层 WebSocket/HTTP 细节

### 执行与环境

目标：
- 支持 standalone 和 REPL 两种模式
- 支持 v1 和 v2 双协议
- 支持 Unix 平台（macOS、Linux）
- 支持 git worktree 隔离与回退

非目标：
- 不支持 Windows 原生（需要 WSL）
- 不支持无 git 环境的 worktree 隔离

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

Standalone 入口：`claude remote-control`
REPL 入口：`/remote-control` 命令

主要类型契约：
```typescript
// WorkSecret（v1 和 v2 共用）
interface WorkSecret {
  version: 1
  session_ingress_token: string
  api_base_url: string
  sources?: Array<{type: string; git_info?: {...}}>
  auth?: Array<{type: string; token: string}>
  claude_code_args?: Record<string, string>
  mcp_config?: unknown
  environment_variables?: Record<string, string>
  use_code_sessions?: boolean
}

// Spawn 模式
type SpawnMode = 'single-session' | 'same-dir' | 'worktree'

// Session 句柄
interface SessionHandle {
  kill(signal?: NodeJS.Signals): void
  writeStdin(data: string): void
  updateToken(token: string): void
  readonly id: string
  readonly exited: boolean
}

// Bridge 指针
interface BridgePointer {
  sessionId: string
  environmentId: string
  source: string
  lastSequenceNum?: number
  timestamp: number
}
```

### 4.2 模块设计卡

#### 模块：环境注册 (bridgeApi.ts)

**真实入口签名与关键类型：**
```typescript
function createBridgeApiClient(deps: {
  baseUrl: string
  getAccessToken: () => string | undefined
  runnerVersion: string
  onDebug?: (msg: string) => void
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  getTrustedDeviceToken?: () => string | undefined
}): BridgeApiClient

interface BridgeApiClient {
  registerBridgeEnvironment(config: BridgeConfig): Promise<{
    environment_id: string
    environment_secret: string
  }>
  reconnectSession(environmentId: string, sessionId: string): Promise<void>
  deregisterEnvironment(environmentId: string): Promise<void>
}

interface BridgeConfig {
  dir: string
  machineName: string
  branch: string
  gitRepoUrl: string | null
  maxSessions: number
  spawnMode: SpawnMode
  verbose: boolean
  sandbox: boolean
  bridgeId: string
  workerType: string
  environmentId: string
  reuseEnvironmentId?: string
  apiBaseUrl: string
  sessionIngressUrl: string
  debugFile?: string
  sessionTimeoutMs?: number
}
```

**输入输出：**
- 输入：BridgeConfig（包含 client 生成的 bridgeId、environmentId、git 信息、worker_type、max_sessions、spawn_mode）
- 输出：{ environment_id, environment_secret }（后端可能返回新的 environment_id）
- 请求：POST /v1/environments/bridge，携带 X-Trusted-Device-Token（如果启用）
- 响应头：Authorization: Bearer <OAuth token>, anthropic-beta: environments-2025-11-01

**Bridge/Session 状态：**
- Bridge 状态：注册前 → 注册后（获得 environment_secret）
- 幂等语义：reuseEnvironmentId 存在时，后端尝试重新连接现有环境
- 状态存储：environmentSecret 保存在内存中，用于后续 poll 请求

**注册流程：**
1. Client 生成 UUID bridgeId 和 environmentId
2. 收集 git repo URL、branch、machine name 等元数据
3. 构造 BridgeConfig，worker_type 标识来源（claude_code/claude_code_assistant）
4. POST /v1/environments/bridge，请求体包含 metadata
5. 服务器返回 environment_id（可能与 reuseEnvironmentId 相同或不同）和 environment_secret JWT
6. 使用返回的 environment_id 进行后续 poll/heartbeat 操作

**重连流程（reconnectSession）：**
- 场景：恢复会话时、JWT 过期时
- 作用：强制终止 stale worker 并重新调度工作
- 请求：POST /v1/environments/{environmentId}/bridge/reconnect，body { session_id }

**注销流程（deregisterEnvironment）：**
- 场景：clean shutdown 时
- 请求：DELETE /v1/environments/bridge/{environmentId}
- 最佳努力：失败不阻止退出

**错误处理与安全：**
- 401 Unauthorized：触发 onAuth401 刷新 OAuth token，重试一次；仍失败则抛出 BridgeFatalError
- 403 Forbidden：检查 error_type 是否包含 "expired"，显示针对性提示
- 404 Not Found：提示 Remote Control 可能不可用
- 410 Gone：提示会话已过期，需重启
- 429 Too Many Requests：提示轮询过于频繁
- SAFE_ID_PATTERN 验证：/^[a-zA-Z0-9_-]+$/，防止路径遍历
- 所有请求 timeout 10-15 秒

**设计取舍与备选：**
- 取舍：Client 生成 UUID 而非 Server 生成 → 重试幂等，但 client 需存储恢复 ID
- 备选：Server 生成所有 ID → 需要额外去重机制，恢复不友好
- 取舍：reuseEnvironmentId 作为可选字段 → 支持幂等注册，但需处理新旧 ID 不一致
- 取舍：metadata.worker_type 透传 → 前端可过滤，但后端不验证
- 证据：bridgeApi.ts registerBridgeEnvironment 实现

**源码与测试证据：**
- src/bridge/bridgeApi.ts (registerBridgeEnvironment, reconnectSession, deregisterEnvironment)
- tests/perpetualBridge.test.ts（指针恢复测试覆盖注册流程）
- 常量：SAFE_ID_PATTERN, BETA_HEADER, BRIDGE_LOGIN_INSTRUCTION

---

#### 模块：轮询与重连 (bridgeMain.ts, pollConfig.ts)

**真实入口签名与关键类型：**
```typescript
async function runBridgeLoop(
  config: BridgeConfig,
  environmentId: string,
  environmentSecret: string,
  api: BridgeApiClient,
  spawner: SessionSpawner,
  logger: BridgeLogger,
  signal: AbortSignal,
  backoffConfig: BackoffConfig = DEFAULT_BACKOFF,
  initialSessionId?: string,
  getAccessToken?: () => string | undefined | Promise<string | undefined>,
): Promise<void>

interface BackoffConfig {
  connInitialMs: number
  connCapMs: number
  connGiveUpMs: number
  generalInitialMs: number
  generalCapMs: number
  generalGiveUpMs: number
  shutdownGraceMs?: number
  stopWorkBaseDelayMs?: number
}

const DEFAULT_BACKOFF: BackoffConfig = {
  connInitialMs: 2000,
  connCapMs: 120000,
  connGiveUpMs: 600000,
  generalInitialMs: 500,
  generalCapMs: 30000,
  generalGiveUpMs: 600000,
}

interface PollIntervalConfig {
  poll_interval_ms_not_at_capacity: number // default 2000
  poll_interval_ms_at_capacity: number // default 600000
  non_exclusive_heartbeat_interval_ms: number // default 0
  multisession_poll_interval_ms_not_at_capacity: number
  multisession_poll_interval_ms_partial_capacity: number
  multisession_poll_interval_ms_at_capacity: number
  reclaim_older_than_ms: number // default 5000
  session_keepalive_interval_v2_ms: number // default 120000
}
```

**输入输出：**
- 输入：BridgeConfig, environmentId, environmentSecret, BridgeApiClient, SessionSpawner, AbortSignal
- 输出：无（长期运行循环）
- Poll 请求：GET /v1/environments/{environmentId}/work/poll，Authorization: Bearer <environmentSecret>
- Poll 参数：reclaim_older_than_ms（默认 5000ms，回收未 ack 的工作）

**Bridge/Session 状态：**
- Poll 状态：正常轮询 → 错误退避 → 睡眠检测重置
- 容量状态：不在容量（2s 轮询）→ 部分容量（2s 轮询）→ 满容量（10min 轮询 + 心跳）
- 活跃会话 Map：sessionId → SessionHandle

**轮询流程：**
1. 检查活跃会话数 < maxSessions
2. 选择轮询间隔（不在容量：2s；在容量：10min + 心跳）
3. pollForWork，带 reclaim_older_than_ms 参数
4. 收到工作项 → decodeWorkSecret → spawn session
5. 无工作 → 等待（可被 capacityWake 唤醒）
6. 循环

**重连流程（指数退避与睡眠检测）：**
1. 错误类型区分：连接错误（conn*）vs 一般错误（general*）
2. 指数退避：connInitialMs 2s → 4s → 8s → ... → connCapMs 120s；generalInitialMs 500ms → ... → 30s
3. 睡眠检测：当前时间 - 上次 poll 时间 > 2×cap 时，重置错误预算
4. 放弃窗口：10 分钟（600000ms）后不再重试，失败退出
5. 重连成功：重置错误计数，更新 logger 状态

**错误处理与安全：**
- 401/403/404/410：BridgeFatalError，区分 expired error_type
- 401：触发 onAuth401 刷新 OAuth，重试一次
- 403：isSuppressible403 检查，某些权限错误可忽略
- 404/410：环境已过期，不可恢复
- 网络错误：按 BackoffConfig 退避
- 最小间隔保护：所有 poll 间隔 ≥ 100ms（配置验证层强制）

**设计取舍与备选：**
- 取舍：双模式轮询（不在容量/在容量）+ 可选心跳 → 平衡响应速度与服务器负载
- 备选：仅轮询 → 容量时响应慢；仅心跳 → 新工作唤醒复杂
- 取舍：reclaim_older_than_ms 5s → 快速回收 JWT 过期后的未 ack 工作
- 备选：更长回收窗口 → 减少服务器负载，但恢复更慢
- 取舍：睡眠检测使用 2×cap 阈值 → 避免笔记本合盖后无限退避
- 备选：无睡眠检测 → 合盖后再开盖可能长时间等待
- 证据：bridgeMain.ts runBridgeLoop 退避逻辑、pollConfig.ts 验证

**源码与测试证据：**
- src/bridge/bridgeMain.ts (runBridgeLoop, pollSleepDetectionThresholdMs)
- src/bridge/pollConfig.ts (pollIntervalConfigSchema, getPollIntervalConfig)
- src/bridge/pollConfigDefaults.ts (DEFAULT_POLL_CONFIG)
- 测试：tests/perpetualBridge.test.ts（指针恢复场景）

---

#### 模块：Work Secret (workSecret.ts)

**真实入口签名与关键类型：**
```typescript
function decodeWorkSecret(secret: string): WorkSecret
function buildSdkUrl(apiBaseUrl: string, sessionId: string): string
function buildCCRv2SdkUrl(apiBaseUrl: string, sessionId: string): string
function sameSessionId(a: string, b: string): boolean
async function registerWorker(
  sessionUrl: string,
  accessToken: string,
): Promise<number> // returns worker_epoch

interface WorkSecret {
  version: number
  session_ingress_token: string
  api_base_url: string
  sources: Array<{
    type: string
    git_info?: { type: string; repo: string; ref?: string; token?: string }
  }>
  auth: Array<{ type: string; token: string }>
  claude_code_args?: Record<string, string> | null
  mcp_config?: unknown | null
  environment_variables?: Record<string, string> | null
  use_code_sessions?: boolean
}
```

**输入输出：**
- decodeWorkSecret 输入：base64url 编码的字符串
- decodeWorkSecret 输出：验证后的 WorkSecret 对象
- buildSdkUrl 输出：v1 WebSocket URL（wss://host/v1/session_ingress/ws/{sessionId}）或 localhost v2 URL
- buildCCRv2SdkUrl 输出：v2 HTTP URL（https://host/v1/code/sessions/{sessionId}）
- sameSessionId 输入：两个 sessionId（可能带 cse_ 或 session_ 前缀）
- sameSessionId 输出：布尔值（UUID 部分是否相同）

**Bridge/Session 状态：**
- WorkSecret 状态：encoded → decoded → validated
- 协议选择：use_code_sessions=true 时用 v2，否则用 v1
- URL 变体：localhost 用 /v2/，生产用 /v1/（Envoy 重写）

**Work Secret 解码流程：**
1. base64url 解码 → UTF-8 字符串
2. JSON 解析 → 对象
3. 验证 version === 1
4. 验证 session_ingress_token 非空字符串
5. 验证 api_base_url 字符串
6. 返回类型安全的 WorkSecret

**URL 构建流程：**
- v1 WebSocket URL：apiBaseUrl 协议换 ws/wss，路径 /v1/session_ingress/ws/{sessionId}
- v2 CCR URL：路径 /v1/code/sessions/{sessionId}
- localhost 检测：includes('localhost') || includes('127.0.0.1') → 用 v2 路径

**Session ID 兼容性流程（sameSessionId）：**
1. 严格相等检查 → true
2. 否则提取最后一个 '_' 后的 UUID 部分
3. 比较 UUID 部分 → 相同则 true
4. 处理：session_{uuid} vs cse_{uuid} vs {uuid}

**错误处理与安全：**
- decodeWorkSecret：version 不匹配、缺少 session_ingress_token、缺少 api_base_url 都抛出错误
- 不验证签名（服务器已验证）
- buildSdkUrl：无安全验证（假设 apiBaseUrl 可信）
- registerWorker：验证 worker_epoch 为有限安全整数

**设计取舍与备选：**
- 取舍：显式 version 字段 → 支持未来协议演进
- 备选：无版本 → 演进困难
- 取舍：use_code_sessions 布尔值 → 服务器控制渐进迁移 v2
- 备选：客户端决定 → 迁移不可控
- 取舍：sameSessionId 忽略前缀 → 兼容 v1/v2 过渡期间的双重标记
- 备选：严格相等 → 过渡期间可能拒绝自己的会话
- 取舍：registerWorker 返回 worker_epoch（可能是字符串或数字）→ 兼容不同编码器
- 证据：workSecret.ts 所有函数

**源码与测试证据：**
- src/bridge/workSecret.ts (decodeWorkSecret, buildSdkUrl, buildCCRv2SdkUrl, sameSessionId, registerWorker)
- 测试：tests/perpetualBridge.test.ts（v1/v2 路径选择）

---

#### 模块：会话 Spawn 与心跳 (sessionRunner.ts, bridgeMain.ts)

**真实入口签名与关键类型：**
```typescript
function createSessionSpawner(deps: {
  execPath: string
  scriptArgs: string[]
  env: NodeJS.ProcessEnv
  verbose: boolean
  sandbox: boolean
  debugFile?: string
  permissionMode?: string
  onDebug: (msg: string) => void
  onActivity?: (sessionId: string, activity: SessionActivity) => void
  onPermissionRequest?: (
    sessionId: string,
    request: PermissionRequest,
    accessToken: string,
  ) => void
}): SessionSpawner

interface SessionSpawner {
  spawn(opts: SessionSpawnOpts, dir: string): SessionHandle
}

interface SessionSpawnOpts {
  sessionId: string
  sdkUrl: string
  accessToken: string
  useCcrV2?: boolean
  workerEpoch?: number // required when useCcrV2=true
  onFirstUserMessage?: (text: string) => void
}

interface SessionHandle {
  sessionId: string
  done: Promise<SessionDoneStatus>
  kill(): void
  forceKill(): void
  activities: SessionActivity[] // ring buffer, MAX_ACTIVITIES=10
  currentActivity: SessionActivity | null
  accessToken: string
  lastStderr: string[] // ring buffer, MAX_STDERR_LINES=10
  writeStdin(data: string): void
  updateAccessToken(token: string): void
}
```

**输入输出：**
- Spawn 输入：SessionSpawnOpts（sessionId, sdkUrl, accessToken, useCcrV2, workerEpoch）、工作目录
- Spawn 输出：SessionHandle
- 子进程参数：--print --sdk-url <url> --session-id <id> --input-format stream-json --output-format stream-json --replay-user-messages [--verbose] [--debug-file <file>]
- 心跳输入：environmentId, workId, sessionIngressToken
- 心跳输出：{ lease_extended: boolean, state: string, last_heartbeat: string, ttl_seconds: number }

**Bridge/Session 状态：**
- Session 状态：spawning → running → completed/failed/interrupted
- Activity 状态：环形缓冲区跟踪最后 10 个活动，动词映射（Read→Reading, Write→Writing 等）
- 超时状态：默认 24 小时看门狗（DEFAULT_SESSION_TIMEOUT_MS）
- Token 状态：sessionIngressToken 保存用于心跳，accessToken 用于子进程

**Spawn 流程：**
1. 剥离父进程的 CLAUDE_CODE_OAUTH_TOKEN（安全边界）
2. 设置 CLAUDE_CODE_ENVIRONMENT_KIND=bridge
3. 设置 CLAUDE_CODE_SESSION_ACCESS_TOKEN
4. 设置 v1/v2 特定环境变量
5. 构造子进程参数（scriptArgs 处理 npm vs bundled 模式）
6. Spawn 子进程，管道 stdout/stderr
7. 创建 readline 接口逐行解析 NDJSON
8. 启动超时看门狗
9. 返回 SessionHandle

**心跳流程：**
- 频率：non_exclusive_heartbeat_interval_ms（默认 0，可配置 60s）
- 请求：POST /v1/environments/{environmentId}/work/{workId}/heartbeat
- 认证：Authorization: Bearer <sessionIngressToken>（无 DB 命中）
- 作用：延长租约，避免服务器回收
- 错误：401/403 触发 reconnectSession；404/410 致命错误

**JWT 刷新流程：**
- 时机：过期前 5 分钟（TOKEN_REFRESH_BUFFER_MS）
- 调度：createTokenRefreshScheduler，generation counter 防止竞态
- v1：子进程通过 stdin update_environment_variables 接收新 token
- v2：调用 reconnectSession 触发服务器重新调度
- 重试：连续 3 次失败后放弃，60s 重试间隔
- 后续刷新：30 分钟后再次调度（FALLBACK_REFRESH_INTERVAL_MS）

**Spawn Mode 差异：**
- single-session：一个会话后 bridge 退出，无 worktree
- same-dir：多会话共享当前目录，可能互相踩踏
- worktree：每个会话独立 git worktree，createAgentWorktree 创建，会话结束后最佳努力删除

**错误处理与安全：**
- Spawn 失败：记录错误，清理 worktree（如果有），archive 会话（幂等）
- 子进程非零退出：记录错误，清理，archive
- 心跳 auth 失败：reconnectSession 强制重新调度
- Token refresh getAccessToken 失败：最多重试 3 次，间隔 60s
- 安全：剥离父 OAuth token，子进程权限最小化

**设计取舍与备选：**
- 取舍：剥离父 OAuth token → 安全边界清晰，但需要单独的 session token
- 备选：继承 token → 子进程权限过大
- 取舍：NDJSON 逐行解析 → 简单可调试
- 备选：二进制协议 → 调试困难
- 取舍：超时看门狗 24 小时 → 防止遗忘会话无限运行
- 备选：无超时 → 资源泄漏风险
- 取舍：activity 动词映射 → UI 友好
- 备选：原始工具名 → 不够友好
- 证据：sessionRunner.ts createSessionSpawner, bridgeMain.ts 心跳 loop

**源码与测试证据：**
- src/bridge/sessionRunner.ts (createSessionSpawner, extractActivities, toolSummary, safeFilenameId)
- src/bridge/jwtUtils.ts (createTokenRefreshScheduler, decodeJwtExpiry, decodeJwtPayload)
- src/bridge/types.ts (SessionHandle, SessionSpawnOpts, DEFAULT_SESSION_TIMEOUT_MS)
- 测试：tests/perpetualBridge.test.ts（perpetual 模式会话管理）

---

#### 模块：权限回调 (bridgePermissionCallbacks.ts, bridgeApi.ts, sessionRunner.ts)

**真实入口签名与关键类型：**
```typescript
interface BridgePermissionCallbacks {
  sendRequest(
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    description: string,
    permissionSuggestions?: PermissionUpdate[],
    blockedPath?: string,
  ): void
  sendResponse(requestId: string, response: BridgePermissionResponse): void
  cancelRequest(requestId: string): void
  onResponse(
    requestId: string,
    handler: (response: BridgePermissionResponse) => void,
  ): () => void // unsubscribe
}

interface BridgePermissionResponse {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: PermissionUpdate[]
  message?: string
}

interface PermissionRequest {
  type: 'control_request'
  requestId: string
  request: {
    subtype: 'can_use_tool'
    tool_name: string
    input: Record<string, unknown>
    tool_use_id: string
  }
}

interface BridgeApiClient {
  sendPermissionResponseEvent(
    sessionId: string,
    event: PermissionResponseEvent,
    sessionToken: string,
  ): Promise<void>
}

interface PermissionResponseEvent {
  type: 'control_response'
  response: {
    subtype: 'success'
    request_id: string
    response: Record<string, unknown>
  }
}
```

**输入输出：**
- PermissionRequest 输入：子进程 stdout NDJSON，type=control_request, subtype=can_use_tool
- PermissionResponseEvent 输出：POST /v1/sessions/{sessionId}/events，body { events: [event] }
- Control response 输入：服务器返回（通过 poll 或 SSE）
- Control response 输出：子进程 stdin NDJSON

**Bridge/Session 状态：**
- 权限请求状态：检测到 → 转发到服务器 → 等待用户响应 → 返回子进程
- 无超时状态：无限等待用户决定（当前实现）
- 透明路由：Bridge 不理解权限语义，仅转发

**权限请求转发流程：**
1. sessionRunner 解析子进程 stdout NDJSON
2. 检测 type='control_request' 且 subtype='can_use_tool'
3. 调用 onPermissionRequest 回调
4. bridgeMain 调用 bridgeApi.sendPermissionResponseEvent
5. POST /v1/sessions/{sessionId}/events，携带 sessionIngressToken

**权限响应路由流程：**
1. 服务器通过 poll（v1）或 SSE（v2）发送 control_response
2. bridgeMain 或 replBridge 接收
3. 通过 sessionHandle.writeStdin 写入子进程 stdin NDJSON
4. 子进程继续执行

**错误处理与安全：**
- sendPermissionResponseEvent 网络错误：记录，继续重试直到会话结束
- 无效 control_response：类型守卫 isBridgePermissionResponse 验证 behavior 字段
- 无权限超时：当前无超时机制，可能永久等待
- 透明转发：不修改 payload，保持完整性

**设计取舍与备选：**
- 取舍：透明路由（Bridge 不理解权限语义）→ 简单，子进程保持完整上下文
- 备选：Bridge 拦截权限请求 → 需要理解所有工具上下文，复杂
- 取舍：无权限超时 → 保证用户有足够时间决定
- 备选：超时回退默认决策 → 需要定义默认策略（allow/deny）
- 取舍：control_response subtype='success' → 遵循 SDK 协议
- 备选：自定义 subtype → 协议不兼容
- 证据：bridgePermissionCallbacks.ts, sessionRunner.ts control request 检测, bridgeApi.ts sendPermissionResponseEvent

**源码与测试证据：**
- src/bridge/bridgePermissionCallbacks.ts (isBridgePermissionResponse, type definitions)
- src/bridge/sessionRunner.ts (PermissionRequest type, onPermissionRequest callback)
- src/bridge/bridgeApi.ts (sendPermissionResponseEvent)
- 测试：tests/perpetualBridge.test.ts（权限回调场景未找到直接测试）

---

#### 模块：多会话与容量管理 (bridgeMain.ts, capacityWake.ts)

**真实入口签名与关键类型：**
```typescript
const SPAWN_SESSIONS_DEFAULT = 32

function createCapacityWake(outerSignal: AbortSignal): CapacityWake

interface CapacityWake {
  signal(): CapacitySignal // creates merged abort signal
  wake(): void // abort current wait and arm fresh controller
}

interface CapacitySignal {
  signal: AbortSignal
  cleanup: () => void // removes listeners
}

// 桥接器内部状态
const activeSessions = new Map<string, SessionHandle>()
const sessionStartTimes = new Map<string, number>()
const sessionWorkIds = new Map<string, string>()
const sessionCompatIds = new Map<string, string>()
const sessionIngressTokens = new Map<string, string>()
const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>()
const sessionWorktrees = new Map<string, {
  worktreePath: string
  worktreeBranch?: string
  gitRoot?: string
  hookBased?: boolean
}>()
const timedOutSessions = new Set<string>()
const titledSessions = new Set<string>()
const capacityWake = createCapacityWake(loopSignal)
```

**输入输出：**
- 容量输入：maxSessions（默认 32，可配置）
- 唤醒输入：无（仅信号）
- 唤醒输出：无（仅状态变更）

**Bridge/Session 状态：**
- 容量状态：活跃会话数 < maxSessions → 不在容量；≥ maxSessions → 在容量
- 轮询状态：不在容量 → poll_interval_ms_not_at_capacity（2s）；在容量 → poll_interval_ms_at_capacity（10min）+ 心跳
- 容量唤醒：会话结束时调用 capacityWake.wake()，立即退出在容量的睡眠

**多会话管理流程：**
1. 初始化 activeSessions Map、sessionWorktrees Map 等
2. Poll 时检查 activeSessions.size < maxSessions
3. 收到工作项：spawn 会话，添加到 activeSessions
4. 会话结束：从 activeSessions 删除，清理 worktree，archive，调用 capacityWake.wake()
5. 在容量时：合并 outerSignal 与 capacityWake signal，任一 abort 都唤醒

**Capacity Wake 流程：**
1. createCapacityWake 创建内部 AbortController
2. signal() 创建合并 signal（outerSignal || wakeController.signal）
3. wake() abort 当前 controller，创建新 controller
4. cleanup() 移除事件监听器，避免泄漏

**Spawn Mode 差异（多会话场景）：**
- single-session：maxSessions 忽略，一个会话后退出
- same-dir：多会话共享当前目录，无隔离
- worktree：每个会话独立 git worktree，强隔离

**错误处理与安全：**
- 容量唤醒无错误状态（纯信号机制）
- 会话清理失败：记录警告，继续（最佳努力）
- worktree 删除失败：记录警告，不阻止退出

**设计取舍与备选：**
- 取舍：默认容量 32 → 平衡并发与资源使用
- 备选：更小容量 → 更安全但并发低；更大容量 → 更高并发但资源风险
- 取舍：在容量时用心跳 + 低频轮询 → 服务器负载低，新工作可快速唤醒
- 备选：仅轮询 → 响应慢；仅心跳 → 唤醒复杂
- 取舍：capacityWake 使用双 AbortController → 支持外部 abort 与容量唤醒
- 备选：单 controller → 无法区分原因
- 证据：bridgeMain.ts 容量逻辑, capacityWake.ts 实现

**源码与测试证据：**
- src/bridge/bridgeMain.ts (activeSessions Map, SPAWN_SESSIONS_DEFAULT, capacity check)
- src/bridge/capacityWake.ts (createCapacityWake, CapacityWake interface)
- 测试：tests/perpetualBridge.test.ts（容量管理场景未找到直接测试）

---

#### 模块：Worktree 创建与清理 (bridgeMain.ts, workSecret.ts, bridgePointer.ts)

**真实入口签名与关键类型：**
```typescript
// 来自 ../utils/worktree.js
function createAgentWorktree(...): Promise<{
  worktreePath: string
  worktreeBranch?: string
  gitRoot?: string
  hookBased?: boolean
}>
function removeAgentWorktree(...): Promise<void>

// bridgeMain.ts 内部状态
const sessionWorktrees = new Map<string, {
  worktreePath: string
  worktreeBranch?: string
  gitRoot?: string
  hookBased?: boolean
}>()
```

**输入输出：**
- 创建输入：当前目录、会话 ID
- 创建输出：worktreePath, worktreeBranch, gitRoot, hookBased（回退标志）
- 清理输入：worktreePath, gitRoot 等
- 清理输出：无（最佳努力）

**Bridge/Session 状态：**
- Worktree 状态：创建中 → 已创建 → 会话运行中 → 待清理 → 已清理/清理失败
- Hook-based 回退：git worktree 命令不可用时使用 hook 机制
- Same-dir 回退：hook 也不可用时使用当前目录

**Worktree 创建流程：**
1. Spawn mode 为 worktree 时调用 createAgentWorktree
2. 尝试 git worktree add
3. 失败则尝试 hook-based 回退
4. 再失败则回退到 same-dir 模式
5. 记录到 sessionWorktrees Map

**Worktree 清理流程：**
1. 会话结束时调用 removeAgentWorktree
2. 最佳努力：失败不阻止退出，仅记录警告
3. 从 sessionWorktrees Map 删除
4. shutdown 时等待所有清理 promise

**跨 Worktree 指针扫描流程（readBridgePointerAcrossWorktrees）：**
1. 首先检查当前目录的 pointer（快速路径）
2. 不存在则调用 git worktree list 获取所有 worktree
3. 并行读取每个 worktree 的 pointer
4. 选择最新的（ageMs 最小的）
5. 上限：MAX_WORKTREE_FANOUT=50，超过不扫描
6. 返回指针 + 所在目录，以便清理正确的文件

**错误处理与安全：**
- createAgentWorktree 失败：回退链（git → hook → same-dir）
- removeAgentWorktree 失败：记录警告，不阻止退出
- 指针读取失败：视为无指针，不阻止 --continue
- 指针写入失败：记录警告，不阻止启动
- 权限：0o600（仅 envLessBridgePointer.ts 显式设置，bridgePointer.ts 依赖 umask）

**设计取舍与备选：**
- 取舍：worktree 可选（spawn mode 选择）→ 灵活平衡隔离与体验
- 备选：强制 worktree → UX 下降（初始不在用户期望目录）
- 取舍：最佳努力清理 → 不阻止退出，稳定
- 备选：保证清理 → 可能卡住无法退出
- 取舍：跨 worktree 扫描 → --continue 可从任意 worktree 恢复
- 备选：仅当前目录 → UX 差（用户需记住原始目录）
- 取舍：指针 TTL 4 小时 → 合理时间窗口可恢复，避免 stale 指针累积
- 备选：无 TTL → stale 指针累积；更短 TTL → 恢复窗口小
- 证据：bridgeMain.ts worktree 逻辑, bridgePointer.ts readBridgePointerAcrossWorktrees

**源码与测试证据：**
- src/bridge/bridgeMain.ts (sessionWorktrees Map, createAgentWorktree/removeAgentWorktree calls)
- src/bridge/bridgePointer.ts (writeBridgePointer, readBridgePointer, clearBridgePointer, readBridgePointerAcrossWorktrees, MAX_WORKTREE_FANOUT, BRIDGE_POINTER_TTL_MS)
- src/bridge/envLessBridgePointer.ts (writeEnvLessBridgePointer, readEnvLessBridgePointer, clearEnvLessBridgePointer, ENV_LESS_POINTER_TTL_MS)
- 测试：tests/perpetualBridge.test.ts（指针恢复测试）

---

#### 模块：干净关闭与崩溃恢复 (bridgeMain.ts, bridgePointer.ts, replBridge.ts)

**真实入口签名与关键类型：**
```typescript
interface BackoffConfig {
  shutdownGraceMs?: number // default 30s
  stopWorkBaseDelayMs?: number // default 1s
}

// bridgeMain.ts 内部状态
let shutdownFlag = false
const activeSessions = new Map<string, SessionHandle>()
const sessionWorktrees = new Map<string, {...}>()
```

**输入输出：**
- 关闭输入：SIGINT/SIGTERM 或 AbortSignal abort
- 关闭输出：process exit（或 promise resolve）
- 恢复输入：--continue 或 --session-id <id> 或 pointer 文件存在
- 恢复输出：重新注册环境，重连会话

**Bridge/Session 状态：**
- Shutdown 状态：running → shutdownFlag=true（停止接受新工作）→ 发送 SIGTERM → 等待 shutdownGraceMs → 发送 SIGKILL → stopWork → archive → deregister → 清除 pointer → 退出
- Perpetual 状态：用户退出时保留 pointer，不 archive，子进程继续运行
- 恢复状态：pointer 存在 → 读取 sessionId/environmentId → reuseEnvironmentId 注册 → reconnectSession → 恢复

**干净关闭流程：**
1. 捕获 SIGINT/SIGTERM，或外部 AbortSignal abort
2. 设置 shutdownFlag=true，停止接受新工作
3. 给所有活跃会话发送 SIGTERM
4. 等待最多 shutdownGraceMs（默认 30s）
5. 给仍在运行的会话发送 SIGKILL
6. 对所有活跃工作项调用 stopWork（带重试：1s/2s/4s 指数退避）
7. Archive 所有会话（幂等，409 Conflict 忽略）
8. Deregister 环境（最佳努力，失败不阻止）
9. 非 perpetual 模式：清除 bridge pointer
10. 等待待清理的 promise（stopWork、worktree 删除）
11. 退出

**Perpetual 模式退出流程：**
1. 用户在 REPL 中退出（非崩溃）
2. 设置 shutdownFlag
3. 保留 bridge pointer（不清除）
4. 不 archive 会话
5. 保留子进程继续运行
6. 退出 CLI
7. 用户可稍后用 --continue 恢复

**崩溃恢复流程（--continue）：**
1. 调用 readBridgePointerAcrossWorktrees 扫描当前目录和 sibling worktrees
2. 找到 TTL 4 小时内的最新 pointer
3. 使用 pointer 中的 sessionId、environmentId
4. 构造 BridgeConfig，设置 reuseEnvironmentId
5. registerBridgeEnvironment（幂等）
6. reconnectSession（强制终止 stale worker）
7. v2：从 lastSequenceNum 开始重放事件
8. 恢复会话

**Flush Gate 流程（v2 REPL 历史刷新）：**
1. 创建新会话或恢复会话
2. 建立 SSE 连接
3. flushGate.holdWrites()：缓存实时写入
4. 处理初始历史（带 cap，默认 200 条）
5. flushGate.releaseWrites()：处理缓存的实时写入
6. 进入交互模式

**错误处理与安全：**
- stopWork 失败：最多重试 3 次，指数退避，记录警告
- deregister 失败：记录警告，不阻止退出
- pointer 清除失败：记录警告，不阻止退出
- archiveSession 409：忽略（已 archive）
- 401/403/404/410 在关闭流程中：记录，继续

**设计取舍与备选：**
- 取舍：shutdownGraceMs 30s → 给会话足够时间优雅退出
- 备选：更短 → 可能强制杀死未完成工作；更长 → 用户等待久
- 取舍：stopWork 重试（1s/2s/4s）→ 增加成功率，不无限重试
- 备选：无限重试 → 可能卡住
- 取舍：perpetual 模式保留 pointer 与会话 → 网页式体验
- 备选：总是清理 → 用户需重新开始
- 取舍：flush gate 缓存实时写入 → 保证历史与实时顺序一致
- 备选：无 flush gate → 历史与实时交错，状态不一致
- 证据：bridgeMain.ts shutdown 逻辑（2435-2600+ 行）, replBridge.ts flushGate 使用

**源码与测试证据：**
- src/bridge/bridgeMain.ts (shutdown 流程, stopWork 重试, BackoffConfig)
- src/bridge/bridgePointer.ts (readBridgePointerAcrossWorktrees, BRIDGE_POINTER_TTL_MS)
- src/bridge/envLessBridgePointer.ts (ENV_LESS_POINTER_TTL_MS)
- src/bridge/flushGate.ts (Flusher 接口, holdWrites/releaseWrites/queueWrite)
- 测试：tests/perpetualBridge.test.ts（perpetual 模式指针管理）
- 测试：tests/daemonBridge.test.ts（daemon bridge 队列与状态）

### 4.3 主控制流

#### 初始化流程（Standalone）

```
用户执行 `claude remote-control`
  → 解析命令行参数（session-id、continue、capacity、spawn-mode 等）
  → 检查 isBridgeEnabled（订阅、gate、token scope、org UUID）
  → 尝试读取 bridge pointer（崩溃恢复）
  → 生成 bridgeId、environmentId（或从 pointer 恢复）
  → registerBridgeEnvironment（携带 git info、worker_type、max_sessions、spawn_mode、reuseEnvironmentId）
  → 收到 environment_secret JWT
  → 如果恢复中：reconnectSession（强制终止 stale worker）
  → 初始化 capacityWake
  → 启动 poll loop
  → 启动 heartbeat loop（如果配置）
  → 显示状态 UI
  → 等待 SIGINT/SIGTERM 或 controller abort
```

#### Poll Loop 主流程（v1）

```
循环：
  → 检查是否在容量（活跃会话数 >= max_sessions）
  → 选择轮询间隔（容量时更长，用心跳代替）
  → pollWork（带 lastSequenceNum）
  → 收到工作项：
    → decodeWorkSecret
    → 检查是否已有同会话（去重）
    → 如果需要：createAgentWorktree
    → spawn 子进程（sessionRunner）
    → 注册到活跃会话 Map
    → capacityWake.wake()（如果从容量变为非容量）
  → 处理错误：
    → 退避逻辑（指数退避、睡眠检测、放弃窗口）
  → 等待轮询间隔或 capacityWake
```

#### 会话执行流程

```
spawn 子进程（sessionRunner）
  → 剥离 CLAUDE_CODE_OAUTH_TOKEN
  → 设置 CLAUDE_CODE_ENVIRONMENT_KIND=bridge
  → 设置 CLAUDE_CODE_SESSION_ACCESS_TOKEN
  → 设置 v1/v2 标志
  → 启动子进程（--print、--sdk-url、--session-id）
  → 管道 stdout/stderr
  → 解析 NDJSON 从 stdout
  → 跟踪 activity（环形缓冲区、动词映射）
  → 检测第一条真实用户消息，派生标题
  → 检测 control_request，转发到服务器
  → 处理 stdin 更新（token refresh 等）
  → 启动超时看门狗（24 小时）
  → 等待子进程退出
  → 清理 worktree（最佳努力）
  → archive 会话（幂等）
  → 从活跃会话 Map 移除
  → capacityWake.wake()
```

#### 权限回调流程

```
子进程发出 NDJSON：
  {type: "control_request", subtype: "can_use_tool", ...payload...}
  → sessionRunner 检测到
  → 调用 sendPermissionResponseEvent
  → bridgeApi 发送到服务器
  → 用户在网页批准/拒绝
  → 服务器发送 control_response（轮询或 SSE）
  → bridge 接收
  → 通过 stdin 写入子进程 NDJSON
  → 子进程继续执行
```

#### Clean Shutdown 流程

```
SIGINT/SIGTERM 或 controller abort
  → 设置 shutdown flag（停止接受新工作）
  → 给所有活跃会话发送 SIGTERM
  → 等待最多 shutdown grace period（默认 30s）
  → 发送 SIGKILL 给 stragglers
  → 对所有活跃工作项调用 stopWork（带重试）
  → archive 所有会话（幂等）
  → deregister 环境（最佳努力）
  → 如果不是 perpetual 模式：清除 crash-recovery pointer
  → 等待待清理的 promise（stopWork、worktree 删除）
  → 退出
```

#### Perpetual 模式退出流程

```
用户在 REPL 中退出（非崩溃）
  → 设置 shutdown flag
  → 保留 bridge pointer（不清除）
  → 不 archive 会话
  → 保留子进程继续运行
  → 退出 CLI
  → 用户可以稍后继续，--continue 恢复
```

#### 崩溃恢复流程（--continue）

```
用户执行 `claude remote-control --continue`
  → 扫描当前目录和 sibling worktrees 找 bridge pointer（TTL 4 小时内）
  → 找到 pointer
  → 使用 sessionId、environmentId 恢复
  → registerBridgeEnvironment（reuseEnvironmentId）
  → reconnectSession（强制终止 stale worker）
  → 重新连接到同一会话
  → 如果是 v2：从 lastSequenceNum 开始重放事件
```

#### REPL Bridge 初始化流程（v2）

```
用户执行 `/remote-control`
  → 检查 isEnvLessBridgeEnabled
  → 如果 perpetual pointer 存在：恢复
  → 否则：创建新会话（createCodeSession）
  → 建立 SSE 连接（事件流）
  → 初始历史刷新（带 cap，默认 200 条消息）
  → flushGate.holdWrites()
  → 处理历史事件
  → flushGate.releaseWrites()
  → 处理排队的实时写入
  → 进入交互模式
```

### 4.4 数据结构与持久化

#### Bridge 指针文件

位置：`~/.claude/bridge-pointer.json`（v1）或 `env-less-bridge-pointer.json`（v2）
权限：0o600
TTL：4 小时

```typescript
interface BridgePointer {
  version: 1
  sessionId: string
  environmentId: string
  source: string
  lastSequenceNum?: number  // v2 only
  timestamp: number  // for TTL check
}
```

#### Poll 配置

```typescript
interface PollConfig {
  pollIntervalEmptyMs: number  // default: 2000
  pollIntervalPartialMs: number  // default: 5000
  pollIntervalFullMs: number  // default: 600000 (10 minutes)
  heartbeatIntervalMs?: number  // default: undefined
  ackWindowSeconds: number  // default: 5
  minIntervalMs: number  // default: 100 (safety floor)
}
```

### 4.5 跨子系统依赖

| 依赖方向 | 模块 | 职责描述 |
|---------|-----|---------|
| 上游 | auth | OAuth token 获取与刷新，不涉及 bridge 逻辑 |
| 上游 | settings | 配置目录路径 |
| 上游 | worktree | createAgentWorktree，由 bridge 调用 |
| 下游 | SDK | 子进程内执行，bridge 仅 spawn 和路由 |
| 共享 | remote-control | 共享会话基础设施，但职责独立 |
| 共享 | daemon | 共享进程管理模式，但生命周期不同 |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|--------|-----------------|--------------|--------------|-------------|
| 注册网络失败 | bridgeMain.ts 初始化 | 捕获异常，指数退避重试 | 10 分钟放弃窗口 | 无 | 用户看到重试状态 |
| Poll 网络失败 | poll loop | 捕获异常，指数退避重试 | 10 分钟放弃窗口 | 保留已有会话 | 用户看到重试状态 |
| Work decode 失败 | poll loop 收到工作项 | 记录错误，跳过该工作项 | 否（单个坏工作不影响其他） | 无 | 该工作项可能被其他实例认领 |
| 子进程启动失败 | sessionRunner spawn | 记录错误，清理 worktree（如果有），archive 会话（幂等） | 否（单个会话失败不影响其他） | 清理 worktree，archive 会话 | 用户看到该会话失败状态 |
| 子进程崩溃（非零退出） | sessionRunner wait | 记录错误，清理 worktree（如果有），archive 会话（幂等） | 否（会话不重试） | 清理 worktree，archive 会话 | 用户看到该会话崩溃状态 |
| 权限回调网络失败 | bridgeApi sendPermissionResponseEvent | 记录错误，继续重试直到成功或会话结束 | 是（无限重试直到会话结束） | 无 | 用户看到 pending 状态 |
| Auth 失败（401） | bridgeApi 任何请求 | 触发 reconnectSession，获取新 token | 是（reconnectSession 一次） | 清除旧 token | 自动恢复 |
| Heartbeat 失败 | heartbeat loop | 记录警告，继续尝试 | 是（无限） | 无 | 用户看到警告 |
| Worktree 创建失败 | bridgeMain spawn 会话前 | 尝试 hook-based 回退，如果仍失败用 same-dir 模式 | 否（回退而不是重试） | 清理部分创建的 worktree | 用户看到回退警告 |
| Worktree 删除失败 | sessionRunner 清理 | 记录警告，忽略（最佳努力） | 否 | 无（用户可能需要手动清理） | 用户看到警告 |
| StopWork 失败 | shutdown 流程 | 记录警告，继续重试最多 3 次 | 3 次 | 无（服务器可能最终超时） | 用户看到警告 |
| Deregister 失败 | shutdown 流程 | 记录警告，忽略（最佳努力） | 否 | 无（服务器会最终超时清理） | 用户看到警告 |
| Pointer 写入失败 | 启动/崩溃时 | 记录警告，忽略（不阻止启动） | 否 | 无（只是无法自动恢复） | 用户看到警告 |
| Pointer 读取失败 | --continue 时 | 记录警告，当作无 pointer 处理 | 否 | 无 | 用户需要手动指定 session-id |
| Envelope 验证失败 | inboundMessages.ts | 记录错误，断开连接/丢弃消息 | 否 | 无 | 安全保护 |

工程取舍总结：
| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|------|
| 幂等注册 vs 服务器生成 ID | Client 生成 UUID + reuseEnvironmentId | Client 需要存储恢复 ID | 重试安全，恢复友好 |
| 双协议支持 vs 仅 v2 | v1+v2 同时支持 | 代码复杂度高 | 渐进迁移，向后兼容 |
| Poll+heartbeat vs 仅一种 | 双模式可配置 | 配置复杂度高 | 灵活适应不同场景 |
| Worktree 隔离 vs 无隔离 | 可选 worktree，初始在 cwd | UX 稍复杂 | 灵活平衡隔离与体验 |
| Perpetual 模式 vs 总是清理 | 可配置保留会话 | 用户需要理解语义 | 网页式会话体验 |
| 最佳努力清理 vs 保证清理 | 最佳努力，记录警告 | 可能有残留资源 | 不阻止退出，稳定 |
| 四层认证 vs 单层 | OAuth+env secret+session JWT+trusted device | 复杂度高 | 深度防御，安全边界清晰 |
| 严格输入验证 vs 宽松 | 白名单验证，拒绝额外字段 | 向后兼容性稍差 | 安全第一 |

## 6. 现状验收标准

给定 clean 环境：
- 执行 `claude remote-control` 必须成功注册环境并开始轮询
- 状态 UI 必须正确显示轮询间隔、容量状态、活动 trail

给定有工作项到达：
- 必须正确 decode WorkSecret
- 必须 spawn 子进程（worktree 模式时创建 worktree）
- 子进程退出后必须清理（最佳努力）、archive、从活跃列表移除
- capacityWake 必须被唤醒

给定权限请求：
- 必须正确转发到服务器
- 响应必须正确路由回子进程

给定 SIGINT：
- 必须给所有活跃会话发送 SIGTERM
- 必须等待 grace period
- 必须发送 SIGKILL 给 stragglers
- 必须调用 stopWork（带重试）
- 必须 archive 所有会话
- 必须 deregister 环境
- 必须清除 pointer（非 perpetual 模式）

给定 `--continue`：
- 必须扫描 sibling worktrees 找 pointer（TTL 4 小时内）
- 必须恢复同一会话

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| 幂等注册与恢复 | bridgeMain.ts 初始化逻辑，bridgeApi.ts registerBridge/reconnectSession | perpetualBridge.test.ts：perpetual指针持久化、v1/v2路径选择、指针恢复 | 未覆盖并发恢复场景 |
| Poll/heartbeat 双模式 | bridgeMain.ts poll loop，pollConfig.ts，capacityWake.ts | 未找到直接测试 | 未覆盖极端负载场景 |
| WorkSecret decode 与 URL 构建 | workSecret.ts | 未找到直接测试 | 未覆盖所有协议迁移边缘情况 |
| Token refresh scheduler | jwtUtils.ts，sessionRunner.ts updateAccessToken | 未找到直接测试 | 未覆盖并发 refresh 竞态 |
| 会话 spawn 与 activity 跟踪 | sessionRunner.ts | 未找到直接测试 | 未覆盖所有工具动词映射 |
| 权限回调路由 | bridgePermissionCallbacks.ts，sessionRunner.ts control request 检测 | 未找到直接测试 | 未覆盖权限请求超时场景 |
| 多会话容量管理 | bridgeMain.ts 容量判断，capacityWake.ts | 未找到直接测试 | 未覆盖容量波动场景 |
| Worktree 创建与清理 | bridgeMain.ts worktree 逻辑，bridgePointer.ts readBridgePointerAcrossWorktrees | 未找到直接测试 | 未覆盖所有 git 错误回退场景 |
| Clean shutdown 流程 | bridgeMain.ts teardown 逻辑（2435-2600+ 行） | 未找到直接测试 | 未覆盖强制 kill 场景 |
| 崩溃恢复 pointer | bridgePointer.ts，envLessBridgePointer.ts，perpetualBridge.test.ts | perpetualBridge.test.ts | 未覆盖跨 worktree 扫描所有边缘情况 |
| 四层认证与输入验证 | bridgeApi.ts，trustedDevice.ts，inboundMessages.ts | tests/inboundEnvelope.test.ts：输入信封验证 | 未覆盖所有攻击向量 |
| Feature gate 分层检查 | bridgeEnabled.ts，initReplBridge.ts | 未找到直接测试 | 未覆盖所有禁用原因组合 |
| REPL bridge v2 与 flush gate | replBridge.ts，remoteBridgeCore.ts，initReplBridge.ts，flushGate.ts | perpetualBridge.test.ts：perpetual模式指针管理 | 未覆盖历史刷新与实时写入交错场景 |
| Daemon bridge集成 | assistant/daemonBridge.ts | tests/daemonBridge.test.ts：daemon bridge队列和状态 | 未覆盖长时间运行场景 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/bridge.yaml)

主要覆盖组：
| 分组 | 主拥有职责 | 相关测试或共享证据 |
|-----|-----------|------------------|
| bridge-main | Standalone bridge 主入口、poll loop、shutdown、会话管理 | perpetualBridge.test.ts |
| bridge-api | 环境注册、poll/ack/heartbeat/stop、reconnectSession | perpetualBridge.test.ts |
| bridge-session-runner | 会话 spawn、NDJSON 解析、activity 跟踪、权限回调路由 | perpetualBridge.test.ts |
| bridge-work-secret | WorkSecret 解码、URL/ID 构建 | perpetualBridge.test.ts |
| bridge-pointer | Bridge 指针读写、跨 worktree 扫描 | perpetualBridge.test.ts |
| bridge-poll-config | Poll 配置验证、默认值 |  |
| bridge-enabled | Feature gate 检查、禁用原因诊断 | perpetualBridge.test.ts |
| bridge-trusted-device | 受信设备 token 注册、获取、清除 |  |
| bridge-repl | REPL bridge 入口、v2 协议、perpetual 模式、flush gate | perpetualBridge.test.ts |
| bridge-inbound-messages | 输入验证、安全常量 | tests/inboundEnvelope.test.ts |
| bridge-permission-callbacks | 权限回调路由 |  |
| daemon-bridge | Daemon bridge 异步队列、核心桥接包装 | tests/daemonBridge.test.ts |

相关子系统：
- remote-control：共享会话基础设施，但职责独立
- daemon：共享进程管理模式，但生命周期不同
- SDK：bridge 仅 spawn 和路由，SDK 负责执行
- worktree：bridge 调用 createAgentWorktree，不拥有实现

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|--------|-------|-------|
| P1 | 当前无 Windows 原生支持，仅限 WSL | 实现 Windows 原生 bridge（无 tmux，使用 ConPTY/named pipes） | 低（仅新增平台） | Windows 上 `claude remote-control` 可用 | L | 设计推断 |
| P1 | 当前 worktree 删除失败时用户可能需要手动清理 | 改进 worktree 清理策略（更激进，提供手动清理命令） | 低（仅改进清理） | 清理更可靠，残留更少 | M | 设计推断 |
| P2 | 当前权限回调无超时，可能永久等待 | 为权限请求添加超时机制，回退默认决策 | 中（需要定义默认决策策略） | 权限请求不会永久挂起 | M | 设计推断 |
| P2 | 当前测试覆盖不足，很多关键路径无测试 | 添加全面测试（并发恢复、极端负载、协议迁移、权限回调超时、git 回退、flush gate 交错等） | 低（仅新增测试） | 测试覆盖所有主要设计决策 | L | 设计推断 |
| P2 | 当前 v1→v2 迁移路径不清晰 | 改进渐进迁移策略，更清晰的状态报告 | 中（协议变更） | 迁移更平滑，用户理解状态 | M | 设计推断 |
| P3 | 当前无会话资源限制（CPU/内存） | 添加可选的 cgroup/resource limit | 中（可能影响某些会话） | 可以限制会话资源使用 | L | 设计推断 |
| P3 | 当前状态 UI 较简单 | 改进状态 UI（更丰富的信息、更好的可视化） | 低（仅 UI 变更） | 用户看到更有用的状态 | M | 设计推断 |
