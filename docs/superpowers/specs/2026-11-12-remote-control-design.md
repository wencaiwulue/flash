---
id: remote-control
batch: 6
title: Remote Control 远程会话、传输与重连设计
date: 2026-11-12
status: draft
---

# Remote Control 远程会话、传输与重连设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理""提高可靠性""保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

当用户通过 WebSocket 连接云端 CCR（Claude Code Runtime）会话时，需要接收实时 SDK 消息流、发送用户输入、响应权限请求、处理网络中断并恢复会话而不丢失未确认的消息。
如果每次断线都要求用户重新创建会话或丢失正在进行的权限交互，会导致用户体验断裂、正在执行的工具被中断、以及已输入内容需要重新发送。

当通过 direct-connect（本地服务器）访问时，需要在本地进程间建立安全传输、持久化会话事件日志、支持从任意序列点恢复、保证权限响应不重复处理、以及允许会话在没有客户端连接时继续运行。
如果没有事件持久化，重启服务器将丢失所有历史消息；如果没有序列号，重连时可能出现重复或缺失消息。

因此本子系统必须在以下约束下完成：

- **协议约束**：WebSocket 连接 + HTTP POST 发送用户消息（CCR 模式）；WebSocket 全双工 + 事件日志（direct-connect 模式）
- **安全约束**：所有连接需要 Bearer token 认证；Unix socket 权限限制为 0o600；token 不在 URL 中暴露
- **兼容性约束**：SDK 消息格式与本地 REPL 格式需要适配；控制消息（权限请求/响应/中断）与 SDK 消息共享通道
- **性能约束**：断线后重连延迟控制在合理范围（2000ms 首次重试）；心跳间隔 30s（CCR）或 15s（direct-connect）
- **并发约束**：多个客户端可连接同一会话；会话在无客户端时可继续运行（detached 状态）
- **持久化约束**：事件日志自动轮转防止无限增长；会话索引权限 0o600

存在两种不同的部署模式：

| 模式 | 传输层 | 会话位置 | 权限仲裁 |
|---|---|---|---|
| CCR (Cloud Controlled Runtime) | WebSocket (Anthropic API) | 云端 | 本地客户端 |
| Direct Connect | TCP 或 Unix Socket | 本地服务器 | 本地客户端 |

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 序列号重放机制 | 每条事件附加单调递增 `seq`；重连时通过 `after=N` 重放 | 确保重连时不丢失不重复；允许从任意点恢复 | 仅重连后新消息：会丢失断线期间的会话进展；完全从头重放：对于长会话太慢 | 服务器需要存储和读取事件日志；客户端需要跟踪 last_seq | `src/server/sessionManager.ts:674-704` |
| WebSocket 消息采用 NDJSON 帧 | 每条消息单独一行 JSON；支持批量发送 | 避免帧边界解析复杂性；允许简单地缓冲和重发 | 二进制协议：增加实现复杂度；单消息连接：过于低效 | 每行需要是完整 JSON；需要过滤空行 | `src/server/server.ts:242-251` |
| 权限响应 ID 幂等去重 | 每个 `control_response` 包含 `request_id`；记录已处理 ID 哈希；冲突时发送错误并忽略 | 避免重复执行权限决策；网络重发不会导致不一致 | 依赖 TCP 可靠传输：WebSocket 重连时仍可能重发；客户端自行去重：服务器无法保护后端 | 内存占用与未完成权限请求数成正比；需要持久化请求哈希 | `src/server/sessionManager.ts:827-841` |
| 会话状态分离：starting/running/detached/stopping/stopped | WebSocket attach 时转为 running；detach 后进入 detached；可自动回收 idle detached | 允许会话在无客户端时继续运行；可安全重启服务器 | 无状态：每次都重新创建会话；单运行态：无法区分有/无客户端 | 状态转换复杂度增加；需要 idle sweep 机制 | `src/server/types.ts:31-39` |
| 直接连接服务器认证采用 Bearer token + 时间安全比较 | `Authorization: Bearer <token>`；SHA-256 哈希比较 | 防止时序攻击；token 不在 URL 中出现 | URL 查询参数 token：易出现在日志中；cookie：不适合 CLI 场景 | 每次请求都需要验证；token 生成和管理由调用方负责 | `src/server/server.ts:30-42` |
| Unix socket 路径权限严格限制 | socket 权限 0o600；父目录 0o700 | 防止非授权用户访问本地服务器 | 世界可读：存在安全风险；仅 TCP：Unix 域 socket 更高效且不需要端口分配 | 需要确保目录存在和权限正确；跨平台差异处理 | `src/server/server.ts:94-95,290-295` |
| CCR 模式采用"HTTP 发输入 + WebSocket 收输出"分离 | `sendEventToRemoteSession` 通过 POST；`SessionsWebSocket` 接收流 | 利用 HTTP 的可靠性传递用户输入；WebSocket 提供低延迟下行 | 全 WebSocket：需要更复杂的流控；全 HTTP：轮询延迟高 | 两个通道需要共享会话上下文；发送失败需要单独处理 | `src/remote/RemoteSessionManager.ts:219-242` |
| WebSocket 重连策略：指数退避 + 有限重试 + 会话不存在特殊处理 | 首次重连 2000ms；最大 5 次；4001 最多 3 次（处理 compaction 短暂不可用） | 平衡快速恢复与服务器负载；处理临时性会话不可用 | 无限重试：浪费资源；无重试：用户体验差 | 状态需要在重连间保持；viewerOnly 模式永不放弃 | `src/remote/SessionsWebSocket.ts:17-26,234-288` |
| 控制消息与 SDK 消息复用同一通道 | 通过 `type` 字段区分：`control_request`/`control_response`/`control_cancel_request` 与 SDK 类型 | 避免建立多个连接；权限请求与消息流自然同步 | 分离控制通道：增加资源占用和复杂度 | 接收方需要过滤和路由不同类型 | `src/remote/RemoteSessionManager.ts:153-183` |
| SDK 消息适配器将远程格式转换为 REPL 格式 | `convertSDKMessage` 转换 `assistant`/`result`/`system` 等类型 | 远程和本地可以使用相同的渲染路径 | 两套渲染逻辑：代码重复且易不一致 | 适配器需要处理多种消息类型；部分类型直接忽略 | `src/remote/sdkMessageAdapter.ts:257-371` |
| 事件日志自动轮转防止无限增长 | 写入时检查大小；超过限制时只保留后半部分事件 | 防止磁盘耗尽；保留足够重放历史 | 不限制：有磁盘耗尽风险；完整历史：存储成本高 | 可能需要回放重置（`replay_reset: true`）；旧事件永久丢失 | `src/server/sessionManager.ts:706-724` |
| 会话索引使用临时文件 + rename 原子写入 | 写入 `server-sessions.json.<pid>.<uuid>.tmp` 后重命名；权限 0o600 | 防止崩溃导致索引损坏；原子更新保证一致性 | 直接覆盖：崩溃可能留下半写文件；追加：需要合并逻辑 | 临时文件需要清理；目录权限需要预先设置 | `src/server/sessionManager.ts:310-322` |

## 3. 目标与非目标

### 目标（实际承担）

- **状态与生命周期**：
  - 管理远程会话连接状态（connected/reconnecting/disconnected）
  - 拥有 pending 权限请求映射（request_id → request）
  - 维护 direct-connect 事件日志与会话索引
  - 拥有会话状态机（starting/running/detached/stopping/stopped）

- **接口与数据**：
  - 保证 WebSocket 接收消息按序列号顺序处理
  - 保证权限响应幂等处理
  - 提供 SDK 消息到 REPL 消息的转换
  - 暴露会话创建/恢复/删除 HTTP 接口

- **执行与环境**：
  - 支持 CCR（云端）和 direct-connect（本地）两种模式
  - 支持 TCP 和 Unix Socket 两种传输
  - 支持 CLI 入口 `remote-control-server`

- **依赖边界**：
  - 调用 SDK query 进行 CCR 会话创建
  - 调用 ProcessBackend 启动子进程
  - 使用 teleport API 发送远程事件（主设计由其他 spec 负责）

### 非目标（不承担）

- 不负责实际工具执行（由 ProcessBackend/SDK 负责）
- 不负责权限 UI 展示（由 REPL 负责）
- 不负责 SSH 隧道建立（由 ssh 模块负责）
- 不负责 Bridge 协议（由 bridge 模块负责）
- 不负责会话 transcript 格式（由 session-persistence spec 负责）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

#### CCR 模式客户端入口

```typescript
// src/remote/RemoteSessionManager.ts
class RemoteSessionManager {
  constructor(config: RemoteSessionConfig, callbacks: RemoteSessionCallbacks)
  connect(): void
  sendMessage(content: RemoteMessageContent, opts?: { uuid?: string }): Promise<boolean>
  respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): void
  cancelSession(): void
  disconnect(): void
  isConnected(): boolean
  getSessionId(): string
}

type RemoteSessionConfig = {
  sessionId: string
  getAccessToken: () => string
  orgUuid: string
  hasInitialPrompt?: boolean
  viewerOnly?: boolean
}

type RemoteSessionCallbacks = {
  onMessage: (message: SDKMessage) => void
  onPermissionRequest: (request: SDKControlPermissionRequest, requestId: string) => void
  onPermissionCancelled?: (requestId: string, toolUseId: string | undefined) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onReconnecting?: () => void
  onError?: (error: Error) => void
}
```

#### Direct Connect 客户端入口

```typescript
// src/server/directConnectManager.ts
class DirectConnectSessionManager {
  constructor(config: DirectConnectConfig, callbacks: DirectConnectCallbacks)
  connect(): void
  sendMessage(content: RemoteMessageContent): boolean
  sendMessageRecord(message: Record<string, unknown>): boolean
  respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): void
  sendInterrupt(): void
  disconnect(): void
  isConnected(): boolean
}

// src/server/createDirectConnectSession.ts
async function createDirectConnectSession(options: {
  serverUrl: string
  authToken?: string
  cwd: string
  dangerouslySkipPermissions?: boolean
  sessionId?: string
  clientRequestId?: string
}): Promise<{ config: DirectConnectConfig; workDir?: string; resumed?: boolean; lastSeq?: number }>
```

#### Direct Connect 服务器入口

```typescript
// src/server/server.ts
function startServer(config: ServerConfig, sessionManager: SessionManager, logger: ServerLogger): ServerHandle

// src/server/sessionManager.ts
class SessionManager {
  constructor(backend: SessionBackend, options: SessionManagerOptions)
  async createSession(request: CreateSessionRequest): Promise<CreateSessionResult>
  async getSession(sessionId: string): Promise<Record<string, unknown>>
  async deleteSession(sessionId: string): Promise<Record<string, unknown>>
  async attach(sessionId: string, after: number, send: (record: Record<string, unknown>) => void): Promise<() => void>
  async handleClientMessage(sessionId: string, raw: unknown): Promise<void>
  async destroyAll(): Promise<void>
  async reapIdleSessions(): Promise<void>
}

// src/commands/remoteControlServer/server.ts
async function startRemoteControlServer(options?: {
  cwd?: string
  createQuery?: (params: { prompt: AsyncIterable<SDKUserMessage>; options: { cwd: string } }) => ServerQuery
}): Promise<RemoteControlServerInfo>
```

#### 服务器 HTTP 契约

| 端点 | 方法 | 功能 |
|---|---|---|
| `/health` | GET | 返回协议版本、PID、服务器版本 |
| `/sessions` | POST | 创建或恢复会话 |
| `/sessions/{id}` | GET | 获取会话信息 |
| `/sessions/{id}` | DELETE | 停止并删除会话 |
| `/sessions/{id}/ws` | GET | WebSocket 升级，支持 `?after=N` |

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `SessionsWebSocket` | WebSocket 连接、重连计时器、ping 间隔、sessionNotFoundRetries | connect、close、sendControlRequest、sendControlResponse | 消息业务逻辑、权限决策 | `onMessage` 回调、`onReconnecting` 回调 |
| `RemoteSessionManager` | pendingPermissions Map、SessionsWebSocket 实例 | connect、sendMessage、respondToPermissionRequest、cancelSession | UI 渲染、工具执行 | SDKMessage 回调、PermissionRequest 回调 |
| `sdkMessageAdapter` | 无状态 | convertSDKMessage、isSessionEndMessage | 实际渲染、状态更新 | ConvertedMessage 输出 |
| `SessionManager` | sessions Map、idempotency Map、indexCorrupt 标志、mutation 队列、persistence Promise、idleTimer | createSession、attach、handleClientMessage、deleteSession、reapIdleSessions | 子进程执行、SDK 逻辑 | BackendSession 接口、send 回调 |
| `DirectConnectSessionManager` | WebSocket 连接、lastSeq、outgoing 队列、attempts、ready 标志 | connect、sendMessage、respondToPermissionRequest、sendInterrupt | 权限 UI、消息渲染 | DirectConnectCallbacks 接口 |
| `ProcessBackend` | sessions Map、可执行路径、环境变量 | create、destroyAll | HTTP 服务、WebSocket 处理 | BackendSession 接口 |
| `startServer` (Bun.serve) | sockets Set、readySockets Set、detachBySocket WeakMap、keepalive 间隔 | 处理 HTTP 请求、路由 WebSocket | 会话业务逻辑、权限 | SessionManager 接口 |
| `SdkRemoteController` | pending Map、多个异步任务（output/inbound/control/permission）、stopPromise | requestPermission、stop | 实际 SDK query 生命周期 | RemoteControlHandle 接口、UserMessageChannel 接口 |

状态位置选择理由：

- **序列号在服务器端生成**：服务器是唯一真相源；重放时由服务器决定从哪开始
- **pendingPermissions 在 RemoteSessionManager**：权限仲裁在客户端；超时/取消需要本地跟踪
- **会话索引在 SessionManager**：持久化到 `~/.claude/server-sessions.json`；需要原子更新
- **outgoing 队列在 DirectConnectSessionManager**：等待 ready 前需要缓冲客户端输入

复制/共享/重置/清理：

- **复制**：SDK 消息通过适配器转换后传递，不共享原始对象
- **共享**：SessionManager 通过 callbacks 共享给 WebSocket 处理
- **重置**：WebSocket 重连时会重建连接，但保留 pending 状态
- **清理**：disconnect/stop 时清理计时器、连接、pending Maps

### 4.3 主控制流

#### CCR 模式端到端流

```text
用户调用 `remote-control-server`
  → `startRemoteControlServer` 创建 pendingInput 和 SDK query
  → SDK `enableRemoteControl(true)` 返回 session_url/connect_url/environment_id
  → 用户（或另一客户端）通过 URL 加入
  → `RemoteSessionManager.connect()` 创建 `SessionsWebSocket`
  → WebSocket 连接到 `wss://api.anthropic.com/v1/sessions/ws/{sessionId}/subscribe`
  → 服务器发送 `auth_status`、`system`、`assistant` 等 SDK 消息
  → `handleMessage` 路由：
    - SDK 消息 → `onMessage` 回调 → 适配器 → REPL 渲染
    - `control_request` → `onPermissionRequest` 回调 → 展示权限 UI
    - `control_cancel_request` → 清理 pending + 调用 `onPermissionCancelled`
  → 用户输入 → `sendMessage` → HTTP POST 到 teleport API
  → 用户响应权限 → `respondToPermissionRequest` → `sendControlResponse`
  → 用户取消 → `cancelSession` → `sendControlRequest({ subtype: 'interrupt' })`
  → 网络断线 → `handleClose` → 5 次内自动重连 → `onReconnecting` → `onConnected`
  → 用户断开 → `disconnect()` → 关闭 WebSocket + 清理 pending
```

#### Direct Connect 会话创建流

```text
客户端 POST /sessions { cwd, session_id?, client_request_id?, dangerously_skip_permissions? }
  → `SessionManager.createSession` 验证 token
  → 检查 client_request_id 幂等性（已存在直接返回）
  → 验证 cwd 在允许 workspace 内
  → 验证 dangerously_skip_permissions 标志
  → 如果 session_id 存在且已停止：验证 transcript 可用 → resume
  → 如果新会话：创建 UUID → 初始化 SessionInfo
  → `Backend.create` 启动子进程（带 --print --input-format stream-json --output-format stream-json）
  → 订阅 stdout → `handleStdout`
  → 持久化索引 → 原子写入 server-sessions.json
  → 返回 { session_id, ws_url, work_dir, protocol, state, resumed, last_seq }
```

#### Direct Connect WebSocket attach 流

```text
WebSocket 升级 GET /sessions/{id}/ws?after=N
  → `SessionManager.getSession` 验证存在
  → `SessionManager.attach` 注册 send 回调
  → 读取事件日志（`{id}.jsonl`）
  → 发送 `direct_connect/ready` 消息（含 last_seq、replayed_from、replay_reset）
  → 重放事件（seq > after）
  → 连接加入 `session.connections` Set
  → 会话状态变为 `running`
  → 新事件通过 `publishNow` 分发给所有连接
  → 客户端发送 NDJSON 行 → `handleClientMessage`
    - `user` → 写入后端 stdin
    - `control_response` → 去重后写入后端
    - `control_request` → 处理 interrupt 或返回错误
    - `keep_alive` → 忽略
  → 客户端断开 → 从 `connections` 删除 → 最后一个 → 状态变为 `detached`
```

#### 权限请求/响应流

```text
后端发送 `control_request` (subtype: 'can_use_tool', request_id, tool_name, input, tool_use_id)
  → `SessionManager.handleStdout` → `publish` → 所有连接
  → 客户端 `DirectConnectSessionManager.dispatch` → `onPermissionRequest` 回调
  → 用户决策 → `respondToPermissionRequest`
  → 发送 `control_response` (request_id, response: { behavior, updatedInput/message })
  → 服务器 `handleClientMessage`
    - 检查 request_id 是否已处理（通过哈希比对）
    - 未处理 → 记录哈希 → 写入后端
    - 冲突 → 发送 `direct_connect/error` (code: 'CONTROL_ID_CONFLICT')
  → 后端接收响应 → 继续执行或停止
```

#### 断线重连与恢复流

```text
网络中断 → WebSocket close（非 4003 永久拒绝）
  → `SessionsWebSocket.handleClose` 或 `DirectConnectSessionManager` 检测
  → 检查重试次数（5 次，viewerOnly 永不放弃）
  → `scheduleReconnect` (2000ms)
  → `onReconnecting` 回调
  → 计时器到期 → `connect()`
  → 连接成功 → 发送 `ready` 事件 → `onConnected`
  → 重放 `after=lastSeq` 之后的事件
  → 缓冲的 outgoing 消息发送
  → 如果 4001 且 <3 次 → 立即重试（处理 compaction 窗口）
  → 如果 4003 或重试耗尽 → `onDisconnected`
```

#### Idle 会话回收流

```text
idleTimer 触发（每 idleSweepIntervalMs）
  → `reapIdleSessions` 扫描所有会话
  → 条件：status === detached && connections.size === 0 && now - lastActiveAt >= idleTimeoutMs
  → `deleteSession` → 状态变为 stopping
  → `backend.stop()` → SIGTERM → 超时后 SIGKILL
  → 状态变为 stopped
  → 持久化索引
```

### 4.4 数据结构与持久化

#### 关键数据结构

```typescript
// 会话信息（内存与持久化）
type SessionInfo = {
  id: string
  status: 'starting' | 'running' | 'detached' | 'stopping' | 'stopped'
  createdAt: number
  workDir: string
  process: ChildProcess | null
  sessionKey?: string  // process start token
  lastActiveAt: number
  lastSeq: number
  transcriptSessionId: string
  permissionMode?: 'default' | 'bypassPermissions'
  exit?: SessionExit
}

type SessionExit = {
  code: number | null
  signal: string | null
  reason?: string
  endedAt: number
}

// 会话索引文件（~/.claude/server-sessions.json）
type IndexFile = {
  version: 1
  ownerId: string
  sessions: Record<string, SessionIndexEntry>
  idempotency?: Record<string, { hash: string; result: CreateSessionResult }>
}

// 事件记录（内存与 JSONL）
type EventRecord = {
  type: string
  subtype?: string
  seq: number
  // ... 其他消息字段
}

// WebSocket 消息帧（NDJSON 行）
// 发送方向（服务器→客户端）：
// - SDK 消息（assistant/user/result/system/tool_progress 等）
// - { type: 'direct_connect', subtype: 'ready', session_id, state, last_seq, replayed_from, replay_reset? }
// - { type: 'direct_connect', subtype: 'error', code, request_id? }
// - { type: 'direct_connect', subtype: 'control_invalidated', request_ids?, reason }
// - { type: 'direct_connect', subtype: 'stopped', session_id, exit }
// - { type: 'keep_alive', timestamp }
//
// 接收方向（客户端→服务器）：
// - { type: 'user', message, parent_tool_use_id, session_id }
// - { type: 'control_request', request_id, request: { subtype, ... } }
// - { type: 'control_response', response: { subtype, request_id, ... } }
// - { type: 'keep_alive' }
```

#### 持久化策略

- **写入时机**：每次 `publishNow` 先 append 到事件日志；索引在 create/delete/resume/exit/attach 后持久化
- **写入等待**：事件日志 append 是异步但顺序化（通过 `eventChain` Promise 队列）；索引写入也是异步但通过 `persistence` Promise 序列化
- **恢复重建**：启动时读取 `server-sessions.json`；之前 active 的会话标记为 stopped；发送 `control_invalidated` 事件
- **敏感字段**：token 只在内存和 Authorization header，不持久化、不记录日志、不出现在 URL

#### 序列与因果约束

- `seq` 单调递增，每个事件都有
- 控制响应必须引用之前存在的 `request_id`
- 重放时 `seq` 必须 > `after` 且连续（除非 `replay_reset`）
- `client_request_id` 用于幂等，相同 request 必须返回相同结果

### 4.5 跨子系统依赖

| 上游输入 | 下游副作用 | 相关 spec |
|---|---|---|
| SDK query（`enableRemoteControl`） | CCR 会话创建 | sdk-query-sessions |
| UserMessageChannel | 转发远程用户输入 | sdk-query-sessions |
| PermissionResult | 远程权限响应 | permissions |
| ProcessBackend（`--print --input-format stream-json`） | direct-connect 后端执行 |（本文描述调用契约）|
| teleport API（`sendEventToRemoteSession`） | 发送用户消息到 CCR |（外部）|
| Unix socket 传输 | 本地进程间通信 |（本文描述）|

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| WebSocket 连接失败 | `SessionsWebSocket.connect` | `onError` 回调 + `onReconnecting` | 最多 5 次，2000ms 首次，指数退避 | 旧连接已关闭，重连时新建 | `onReconnecting` → 成功时 `onConnected`，失败时 `onDisconnected` |
| 会话不存在（4001） | `SessionsWebSocket.handleClose` | 同上 | 最多 3 次（处理 compaction 窗口），之后永久结束 | 同上 | 3 次内 `onReconnecting`，之后 `onDisconnected` |
| 未授权（4003） | `SessionsWebSocket.handleClose` | `onDisconnected` | 永不重试（永久失败） | 清理连接和计时器 | 立即 `onDisconnected` |
| 事件日志损坏 | `SessionManager.initialize` | 标记 `indexCorrupt = true` | 无 | 忽略已损坏索引，新会话仍可创建 | 创建新会话成功；恢复会话返回 409 |
| 后端进程崩溃 | `ProcessBackend` exit 事件 | `SessionManager.handleExit` → 发布 `control_invalidated` + `stopped` 事件 | 不自动重启（需要显式 resume） | 清理 pending controls，标记 `status: stopped`，持久化索引 | 客户端收到 `stopped` 事件，下次 resume 重建进程 |
| 权限响应冲突（相同 request_id 不同内容） | `SessionManager.handleClientMessage` | 发送 `direct_connect/error` (code: 'CONTROL_ID_CONFLICT') | 不重试（客户端错误） | 不修改状态，不转发后端 | 客户端收到错误帧，连接保持打开 |
| 会话 idle 超时 | `SessionManager.reapIdleSessions` | 无直接通知（通过状态变化） | 不重试（已删除） | `deleteSession` → 停止后端 → 清理连接 | 客户端下次 attach 收到 409 或需要重新创建 |
| 事件日志超过大小限制 | `SessionManager.rotateEventsIfNeeded` | 新连接收到 `replay_reset: true` | 不重试（正常操作） | 保留后半部分事件，旧事件删除 | 重连时可能从 0 开始，中间历史丢失 |
| 直接连接服务器无法创建 Unix socket | `startServer` | 抛出异常 | 不重试（启动失败） | 不创建服务器 | 启动失败，调用方需要处理 |
| 客户端发送无效 JSON | `startServer` WebSocket message | 关闭连接（code 1007） | 不重试（客户端错误） | 从 `sockets` 移除，detach | 连接关闭 |
| 客户端发送超大帧 | `startServer` WebSocket message | 关闭连接（code 1009） | 不重试（客户端错误） | 同上 | 连接关闭 |
| 远程控制停止 | `SdkRemoteController.stop` | 关闭所有异步任务，reject 所有 pending | 不重试（显式停止） | 清理 pending Map，close handle，interrupt query | Promise<void> resolve 时已清理 |

## 6. 现状验收标准

1. 当 WebSocket 连接在非 4003 情况下断开时，系统必须自动重连最多 5 次（首次延迟 2000ms），
   并且在重连期间必须通过 `onReconnecting` 通知调用方；重连成功后必须发送 `onConnected`。

2. 当客户端使用 `?after=N` 连接时，服务器必须只发送 `seq > N` 的事件，
   并且事件必须按 `seq` 严格递增顺序；不得发送重复或乱序消息。

3. 当相同 `request_id` 的权限响应重复发送时，服务器必须只转发一次给后端，
   并且在内容冲突时必须发送 `CONTROL_ID_CONFLICT` 错误给客户端；不得让后端看到冲突响应。

4. 当会话在 detached 状态且 idle 超过 `idleTimeoutMs` 时，系统必须自动停止并删除会话，
   并且必须清理子进程资源；不得无限保留 idle 会话。

5. 当事件日志超过 `eventLogLimitBytes` 时，服务器必须只保留后半部分事件，
   并且新连接必须收到 `replay_reset: true`；不得崩溃或阻塞。

6. 当创建会话时提供 `client_request_id` 时，使用相同 id 的后续请求必须返回相同结果，
   并且不得重复创建后端进程；必须幂等。

7. 当使用 Unix socket 时，socket 文件权限必须是 0o600，父目录权限必须是 0o700，
   并且 token 不得出现在 URL 或日志中；不得暴露给其他用户。

8. 当远程服务器发送 `control_cancel_request` 时，客户端必须清理对应的 pending 请求，
   并且必须调用 `onPermissionCancelled` 回调；不得让 UI 等待已取消的请求。

9. 当 direct-connect 服务器重启时，之前 active 的会话必须标记为 stopped，
   并且必须持久化会话索引；重启后可以 resume 会话。

10. 当 SDK 消息到达时，`sdkMessageAdapter` 必须正确转换为 REPL 可渲染格式，
    并且必须忽略不需要的消息类型（如 `auth_status`、`tool_use_summary`）；不得抛出异常。

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 序列号重放机制 | `src/server/sessionManager.ts:674-704` | `tests/directConnect.test.ts:233-276`（WebSocket 接受 NDJSON、持久化重放） | 重放验证在 direct-connect 模式；CCR 模式重放由云端实现 |
| 权限响应 ID 幂等去重 | `src/server/sessionManager.ts:827-841` | `tests/directConnect.test.ts:278-301`（控制响应 ID 去重与冲突拒绝） | 仅测试 direct-connect 去重；CCR 去重由云端实现 |
| 会话状态机（running/detached） | `src/server/sessionManager.ts:751-802` | `tests/directConnect.test.ts:324-335`（idle 回收 detached 会话） | 状态转换测试覆盖 idle 路径；其他路径需要更多测试 |
| Bearer token + 时间安全比较 | `src/server/server.ts:30-42` | `tests/directConnect.test.ts:192-218`（loopback 需要认证、幂等、max sessions） | 认证测试使用假 token；生产 token 由外部提供 |
| Unix socket 权限严格限制 | `src/server/server.ts:94-95,290-295` | `tests/directConnect.test.ts:403-415`（Unix socket 私有权限与真实传输） | Unix socket 测试仅在支持的平台运行 |
| HTTP 发输入 + WebSocket 收输出分离 | `src/remote/RemoteSessionManager.ts:219-242` |（无直接测试；通过集成验证） | 发送路径依赖 teleport API |
| WebSocket 重连策略 | `src/remote/SessionsWebSocket.ts:17-26,234-288` |（无直接测试；设计推断） | 重连逻辑在浏览器/Bun 环境行为可能不同 |
| 控制消息与 SDK 消息复用通道 | `src/remote/RemoteSessionManager.ts:153-183` |（设计推断） | 消息路由逻辑主要在客户端 |
| SDK 消息适配器 | `src/remote/sdkMessageAdapter.ts:257-371` |（无直接测试；通过集成验证） | 适配器转换覆盖主要消息类型 |
| 事件日志自动轮转 | `src/server/sessionManager.ts:706-724` | `tests/directConnect.test.ts:417-430`（事件轮转广告 replay_reset） | 轮转阈值可配置；测试使用小值加速 |
| 原子索引写入 | `src/server/sessionManager.ts:310-322` | `tests/directConnect.test.ts:432-443`（幂等记录在重启后存活） | 原子性通过文件系统 rename 保证 |
| 空闲会话回收 | `src/server/sessionManager.ts:927-940` | `tests/directConnect.test.ts:324-335`（idle 回收 detached 会话） | 回收间隔需要足够短以便测试 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/remote-control.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|---|---|---|---|
| remote-client | CCR 模式客户端：会话管理、WebSocket、SDK 适配 |（集成测试） | `src/bridge/*`（bridge 协议） |
| remote-server | Direct Connect 服务器：会话管理、HTTP/WebSocket 服务、后端进程 | `tests/directConnect.test.ts` | `src/ssh/*`（SSH 隧道） |
| remote-control-command | `remote-control-server` 命令入口 |（无直接测试） | 其他命令 |
| remote-sdk-control | SDK 远程控制适配层 |（无直接测试） | SDK query 核心 |
| remote-transport | 直接连接传输辅助：Unix socket 路径解析、HTTP/WebSocket URL | `tests/directConnect.test.ts:403-415` | `src/utils/udsMessaging.ts`（UDS 消息） |
| remote-tests | 远程控制与 direct-connect 测试 | `tests/directConnect.test.ts` | 其他测试文件 |

相关子系统：

- `sdk-query-sessions`：SDK query 生命周期，CCR 会话创建的基础
- `permissions`：权限决策框架，远程权限请求的本地仲裁
- `session-persistence`：会话 transcript 格式，direct-connect resume 的基础
- `bridge`：Bridge 协议（非本文范围，设计独立）
- `ssh`：SSH 隧道（非本文范围，传输层选项）

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | `SessionsWebSocket` 重连逻辑没有单元测试；行为依赖环境差异 | 添加 WebSocket 重连单元测试（使用 mock WebSocket） | 低（仅新增测试） | 验证重连延迟、次数、4001 特殊处理逻辑 | M | 已证实（测试缺口明显） |
| P2 | `sdkMessageAdapter` 没有独立单元测试；转换逻辑通过集成验证 | 添加适配器测试，覆盖所有消息类型转换 | 低（仅新增测试） | 验证输入输出对，包括边界情况（无效消息、未知类型） | S | 已证实（测试缺口明显） |
| P2 | 事件日志重播重置后没有机制同步初始状态；客户端可能需要从头重建上下文 | 考虑在 `replay_reset` 时附加会话快照或摘要 | 中（需要协议变更） | 验证重置后客户端能正确重建视图 | L | 设计推断（基于当前实现的限制） |
| P3 | viewerOnly 模式永不放弃重连，但没有指数退避上限延迟调整；可能造成过多重连尝试 | 为 viewerOnly 模式增加更长的重连延迟或动态调整 | 低（仅改变计时参数） | 验证 viewerOnly 重连更温和且仍最终成功 | S | 设计推断 |
| P3 | `RemoteSessionManager.pendingPermissions` 没有超时清理；服务器永远不取消时可能内存泄漏 | 为 pending 权限添加超时机制，自动清理并通知调用方 | 中（需要新状态和回调） | 验证超时后正确清理且 UI 得到通知 | M | 设计推断 |
