---
id: open-runner
title: Open Runner 环境执行与 Worker 协议设计
date: 2026-11-12
status: draft
batch: 6
---

<!--
  仅用于提交文档：严格按照格式书写九章，不修改 manifest/INDEX
-->

## 1. 概述

**Open Runner** 是一个用于安全、可靠地在远程或自托管环境中执行 Claude Code CLI 的分布式系统。它提供了：

- 标准化的 HTTP 协议（open-runner-v1）用于作业提交、拉取和完成
- 带租期（lease）的 Worker 注册和心跳机制
- 带幂等性保证的事件流持久化
- 可选的环境隔离
- 上游代理凭据注入
- 崩溃恢复机制

### 与 remote-control/daemon 的区别

Open Runner 不是 remote-control/daemon 的替代品，而是一个互补的组件：

- remote-control/daemon：长期运行的后台服务，用于设备注册和持久化连接
- Open Runner：按需启动的 Worker 池，专注于作业分发、事件流和崩溃恢复

## 2. 架构

Open Runner 由以下核心组件构成：

```
┌─────────────────────────────────────────────────────────────────┐
│                        Admin Client                             │
│                   (作业提交 / 查询 / 取消)                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Open Runner Server                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   HTTP API   │  │    Store     │  │  Work Queue  │          │
│  │ (认证/路由)  │  │ (持久化)     │  │ (租期管理)   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Worker Pool                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   Worker 1   │  │   Worker 2   │  │   Worker 3   │          │
│  │ (单/多作业)  │  │ (单/多作业)  │  │ (单/多作业)  │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
└─────────┼─────────────────┼─────────────────┼────────────────────┘
          │                 │                 │
          ▼                 ▼                 ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │   CLI Child  │  │   CLI Child  │  │   CLI Child  │
  │  (执行作业)  │  │  (执行作业)  │  │  (执行作业)  │
  └──────────────┘  └──────────────┘  └──────────────┘
```

### 主要组件职责

| 组件 | 文件 | 职责 |
|------|------|------|
| Server | `src/open-runner/server.ts` | HTTP API、认证、队列管理 |
| Store | `src/open-runner/store.ts` | 持久化状态、事件存储、并发控制 |
| Worker | `src/open-runner/worker.ts` | 作业拉取、子进程管理、崩溃恢复 |
| Client | `src/open-runner/client.ts` | 客户端封装、重试逻辑 |
| Protocol | `src/open-runner/protocol.ts` | 类型定义、验证、错误码 |

## 3. 协议与 API 设计

### 协议版本

所有请求和响应都使用 `protocol: "open-runner-v1"` 标记。

### 错误码

| 错误码 | HTTP 状态 | 含义 |
|--------|-----------|------|
| `AUTHENTICATION_FAILED` | 401 | 认证失败 |
| `PERMISSION_DENIED` | 403 | 权限不足 |
| `INVALID_REQUEST` | 400 | 请求无效 |
| `WORK_NOT_FOUND` | 404 | 作业不存在 |
| `IDEMPOTENCY_CONFLICT` | 409 | 幂等冲突（同一 work_id 不同输入） |
| `EVENT_ID_CONFLICT` | 409 | 事件 ID 冲突 |
| `TERMINAL_CONFLICT` | 409 | 已终止作业冲突 |
| `STALE_LEASE` | 409 | 租期过期 |
| `STALE_WORKER_EPOCH` | 409 | Worker epoch 过期（实例重启） |
| `WORK_TERMINAL` | 409 | 作业已终止 |
| `CAPACITY_EXCEEDED` | 429 | 容量超限 |
| `SERVER_DRAINING` | 503 | 服务器正在停止 |
| `RECOVERY_CONFLICT` | 409 | 恢复冲突 |
| `WORK_TIMEOUT` | 408 | 作业超时 |
| `CHILD_EXIT` | 500 | 子进程退出失败 |
| `CHILD_PROTOCOL_ERROR` | 500 | 子进程协议错误 |
| `RUNNER_RESTARTED` | 500 | Runner 重启 |
| `LEASE_EXPIRED` | 409 | 租期过期 |
| `INTERNAL_ERROR` | 500 | 内部错误 |

### API 端点

#### 健康检查

```http
GET /open-runner/v1/health
```

响应：
```json
{
  "protocol": "open-runner-v1",
  "server_version": "1.0.0",
  "pid": 12345
}
```

#### Runner 注册

```http
POST /open-runner/v1/runners/register
Authorization: Bearer <worker-token>
Content-Type: application/json

{
  "protocol": "open-runner-v1",
  "runner_id": "<uuid>",
  "instance_id": "<uuid>",
  "capabilities": {
    "max_work": 1,
    "permission_modes": ["default", "acceptEdits", "plan"]
  }
}
```

响应：
```json
{
  "protocol": "open-runner-v1",
  "runner_id": "<uuid>",
  "instance_id": "<uuid>",
  "worker_epoch": 1,
  "heartbeat_interval_ms": 10000,
  "lease_ms": 30000,
  "server_time": "2026-11-12T00:00:00.000Z"
}
```

#### 作业提交（Admin 仅）

```http
POST /open-runner/v1/work
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "protocol": "open-runner-v1",
  "work_id": "<uuid>",
  "input": {
    "prompt": "review this code",
    "cwd": ".",
    "model": "claude-3-5-sonnet",
    "permission_mode": "default",
    "session_id": "<uuid>"
  },
  "max_attempts": 3,
  "max_runtime_ms": 3600000
}
```

#### 作业拉取（Worker 仅）

```http
POST /open-runner/v1/work/poll
Authorization: Bearer <worker-token>
Content-Type: application/json

{
  "protocol": "open-runner-v1",
  "runner_id": "<uuid>",
  "instance_id": "<uuid>",
  "worker_epoch": 1,
  "max_work": 1,
  "wait_ms": 25000
}
```

响应：
```json
{
  "protocol": "open-runner-v1",
  "server_time": "2026-11-12T00:00:00.000Z",
  "work": [
    {
      "work_id": "<uuid>",
      "session_id": "<uuid>",
      "attempt": 1,
      "lease_id": "<uuid>",
      "lease_expires_at": "2026-11-12T00:00:30.000Z",
      "input": { ... },
      "max_runtime_ms": 3600000
    }
  ],
  "cancel_requested": ["<work-id>"]
}
```

#### 作业确认（Worker 仅）

```http
POST /open-runner/v1/work/{work_id}/ack
Authorization: Bearer <worker-token>
Content-Type: application/json

{
  "protocol": "open-runner-v1",
  "runner_id": "<uuid>",
  "instance_id": "<uuid>",
  "worker_epoch": 1,
  "lease_id": "<uuid>"
}
```

#### 心跳（Worker 仅）

```http
POST /open-runner/v1/work/{work_id}/heartbeat
Authorization: Bearer <worker-token>
Content-Type: application/json

{
  "protocol": "open-runner-v1",
  "runner_id": "<uuid>",
  "instance_id": "<uuid>",
  "worker_epoch": 1,
  "lease_id": "<uuid>"
}
```

响应：
```json
{
  "protocol": "open-runner-v1",
  "lease_expires_at": "2026-11-12T00:00:30.000Z",
  "state": "running",
  "cancel_requested": false
}
```

#### 追加事件（Worker 仅）

```http
POST /open-runner/v1/work/{work_id}/events
Authorization: Bearer <worker-token>
Content-Type: application/json

{
  "protocol": "open-runner-v1",
  "runner_id": "<uuid>",
  "instance_id": "<uuid>",
  "worker_epoch": 1,
  "lease_id": "<uuid>",
  "events": [
    {
      "event_id": "<uuid>",
      "kind": "sdk",
      "occurred_at": "2026-11-12T00:00:00.000Z",
      "message": { "type": "assistant", "content": "..." }
    }
  ]
}
```

响应：
```json
{
  "protocol": "open-runner-v1",
  "accepted": [
    { "event_id": "<uuid>", "seq": 1 }
  ],
  "last_seq": 1
}
```

#### 完成作业（Worker 仅）

```http
POST /open-runner/v1/work/{work_id}/complete
Authorization: Bearer <worker-token>
Content-Type: application/json

{
  "protocol": "open-runner-v1",
  "runner_id": "<uuid>",
  "instance_id": "<uuid>",
  "worker_epoch": 1,
  "lease_id": "<uuid>",
  "outcome": "succeeded",
  "retryable": false,
  "result": { "exit_code": 0 },
  "error": null
}
```

#### 取消作业（Admin 仅）

```http
POST /open-runner/v1/work/{work_id}/cancel
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "protocol": "open-runner-v1",
  "reason": "operator request"
}
```

#### 查询作业

```http
GET /open-runner/v1/work/{work_id}
Authorization: Bearer <admin-token>
```

#### 查询事件

```http
GET /open-runner/v1/work/{work_id}/events?after=0&limit=100
Authorization: Bearer <admin-token>
```

响应：
```json
{
  "protocol": "open-runner-v1",
  "work_id": "<uuid>",
  "events": [
    { "event_id": "<uuid>", "kind": "sdk", "occurred_at": "...", "seq": 1, "message": { ... } }
  ],
  "last_seq": 1,
  "has_more": false
}
```

#### 列出作业

```http
GET /open-runner/v1/work?state=running&limit=100
Authorization: Bearer <admin-token>
```

## 4. 状态机与并发模型

### 作业状态

```
queued → leased → running → succeeded
          ↓          ↓          ↓
          └──────→ retry_wait → failed
                       ↓
                  cancelled
```

| 状态 | 含义 | 允许转移 |
|------|------|----------|
| `queued` | 排队中，等待 Worker 拉取 | `leased` |
| `leased` | 已分配给 Worker，等待确认 | `running`, `queued` (租期过期) |
| `running` | 执行中 | `succeeded`, `failed`, `cancelled`, `retry_wait` (租期过期) |
| `retry_wait` | 等待重试 | `leased` |
| `succeeded` | 成功完成（终态） | - |
| `failed` | 失败（终态） | - |
| `cancelled` | 已取消（终态） | - |

### 租期机制

租期是 Open Runner 的核心并发控制机制：

- Worker 拉取作业时获得一个 `lease_id` 和 `lease_expires_at`
- Worker 必须在租期内发送心跳刷新租期（默认 10 秒心跳，30 秒租期）
- 租期过期后，Store 自动将作业状态转移回 `queued` 或 `retry_wait`
- 新 Worker 可以拉取并重试该作业

### Worker Epoch 隔离

每个 Worker 实例注册时获得一个 `worker_epoch`：

- 同一 `runner_id` + 新 `instance_id` = `worker_epoch` + 1
- 旧 epoch 的请求返回 `STALE_WORKER_EPOCH`
- 这确保了一个 Runner 只有一个活跃实例

### 并发控制

Store 使用串行化操作模式：

```typescript
private serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = this.operation.then(async () => {
    if (this.closed) throw new Error('Open Runner store is closed')
    if (!this.initialized) throw new Error('Open Runner store is not initialized')
    return operation()
  })
  this.operation = result.then(() => {}, () => {})
  return result
}
```

所有对状态的修改都通过 `serialize()` 排队，确保：

- 无竞态条件
- 状态转换原子性
- 事件顺序一致性

## 5. Worker 生命周期与恢复

### Worker 启动流程

1. **初始化状态目录**：创建 `~/.config/claude-code/open-runner/<runner-id>`
2. **恢复崩溃作业**：扫描 `active-work-*.json`，清理并标记失败
3. **注册 Runner**：获得 `worker_epoch`
4. **轮询作业**：循环执行

### 活动作业持久化

Worker 为每个活动作业写入 `active-work-<lease-id>.json`：

```json
{
  "protocol": "open-runner-v1",
  "assignment": { ... },
  "identity": { ... },
  "phase": "prompt_sent",
  "pid": 12345,
  "start_token": "<token>",
  "connection_generation": 1,
  "prompt_sent": true,
  "delivery_unknown": false,
  "pending_event": null,
  "updated_at": "2026-11-12T00:00:00.000Z"
}
```

### 阶段定义

| 阶段 | 含义 | 恢复策略 |
|------|------|----------|
| `accepted` | 已接受作业，未执行任何操作 | `RUNNER_RESTARTED`（可重试） |
| `spawning` | 正在启动子进程 | `RUNNER_RESTARTED`（可重试） |
| `prompt_sending` | 正在发送提示词 | `DELIVERY_UNKNOWN`（需显式重试） |
| `prompt_sent` | 提示词已发送，执行中 | `RUNNER_RESTARTED`（可重试） |
| `running` | 执行中 | `RUNNER_RESTARTED`（可重试） |

### 崩溃恢复

Worker 初始化时的恢复流程：

```typescript
// 1. 扫描活动工作记录
for (const name of await readdir(this.stateDir)) {
  if (/^active-work(?:-[0-9a-f-]{36})?\.json$/.test(name)) {
    await this.recoverActiveWork(join(this.stateDir, name))
  }
}

// 2. 对于每个记录
//   a. 验证 PID + start_token
//   b. 如果进程还在，发送 SIGTERM，等待最多 2 秒
//   c. 如果还在，发送 SIGKILL
//   d. 发送待处理事件
//   e. 报告完成：失败 + retryable
//   f. 删除活动记录
```

### 进程身份验证

使用 `start_token` 验证 PID 是否是同一个进程：

```typescript
// src/jobs/state.ts
// - 在 Linux 上读取 /proc/<pid>/stat 的 starttime
// - 在 macOS 上使用 libproc 读取 start_time
// - 在 Windows 上使用 GetProcessTimes
```

这避免了 PID 重用导致的错误终止。

## 6. 环境隔离与安全边界

### 子进程环境白名单

Worker 只向子进程传递安全的环境变量：

```typescript
const exact = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TEMP', 'TMP',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'NODE_ENV',
])
for (const [key, value] of Object.entries(env)) {
  if (exact.has(key) || key.startsWith('LC_') || key.startsWith('AWS_') ||
      key.startsWith('GOOGLE_') || key.startsWith('CLOUD_ML_')) {
    result[key] = value
  }
}
```

### 环境变量黑名单

以下变量被明确删除：

- `OPEN_RUNNER_*`
- `SSH_*`
- 包含 `WORKER_TOKEN` 或 `ADMIN_TOKEN` 的变量
- `CLAUDE_CODE_SESSION_ACCESS_TOKEN`
- `CLAUDE_CODE_WORKER_EPOCH`

### 工作目录验证

输入的 `cwd` 经过严格验证：

```typescript
function validateRelativeCwd(value: unknown): string {
  // 1. 必须是非空字符串，< 4096 字节
  // 2. 不包含 NUL、反斜杠
  // 3. 不是绝对路径，不包含 Windows 盘符
  // 4. 不包含 '..'（路径遍历保护）
  // 5. 移除 './' 前缀和 '/' 后缀
}

async function resolveWorkspaceCwd(workspace: string, relative: string): Promise<string> {
  // 1. 验证相对路径
  // 2. 解析为绝对路径
  // 3. 检查不逃出 workspace（包括 symlink）
  // 4. canonicalize 后再次检查
}
```

### 令牌文件安全

Server 读取的令牌文件必须满足：

- 权限 `0600`
- 是常规文件，不是 symlink
- 由当前用户所有
- 包含高熵令牌（32-1024 字符，无空白）

### 认证模型

Server 有两个独立的令牌：

- Worker Token：只能注册、轮询、更新作业
- Admin Token：只能提交、查询、取消作业

两个令牌不能混用，认证失败返回 `401`，权限不足返回 `403`。

## 7. 上游代理与凭据注入

### 架构

Upstream Proxy 是 CCR（Cloud Code Runner）的安全组件：

```
┌─────────────────────────────────────────────────────────┐
│                  CCR Session Container                  │
│  ┌───────────────────────────────────────────────────┐ │
│  │         Claude Code CLI (Parent)                  │ │
│  │  - 读取 /run/ccr/session_token                    │ │
│  │  - prctl(PR_SET_DUMPABLE, 0)                      │ │
│  │  - 下载 CA 证书                                   │ │
│  │  - 启动 Relay 进程                                │ │
│  │  - 立即 unlink token 文件                         │ │
│  └──────────────────────┬────────────────────────────┘ │
│                         │                              │
│                         ▼                              │
│  ┌───────────────────────────────────────────────────┐ │
│  │    Relay (127.0.0.1:<ephemeral-port>)             │ │
│  │  - 监听 CONNECT 请求                              │ │
│  │  - 包装 WS，注入 Session Token                    │ │
│  └──────────────────────┬────────────────────────────┘ │
└─────────────────────────┼──────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │  GKE L7 Load Balancer │
              └───────────┬───────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │  CCR Upstream Proxy   │
              │  - MITM TLS           │
              │  - 注入凭据           │
              └───────────┬───────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │   Real Upstream       │
              │   (Datadog, etc.)     │
              └───────────────────────┘
```

### 协议

Relay 使用 WebSocket + protobuf 编码：

```protobuf
message UpstreamProxyChunk {
  bytes data = 1;
}
```

- **Tag**: `0x0a` (field 1, wire type 2)
- **Varint length**: 可变长度编码
- **Bytes payload**: 原始字节

### 初始化步骤

1. **读取会话令牌**：`/run/ccr/session_token`
2. **设置不可 dump**：`prctl(PR_SET_DUMPABLE, 0)` 防止同 UID ptrace 读取堆
3. **下载 CA 证书**：`/v1/code/upstreamproxy/ca-cert`
4. **合并系统 CA**：写入 `~/.ccr/ca-bundle.crt`
5. **启动 Relay**：监听 `127.0.0.1:<port>`
6. **Unlink 令牌**：确认 Relay 启动后删除令牌文件

### NO_PROXY 列表

以下主机不通过代理：

- `localhost`, `127.0.0.1`, `::1`
- 私有网络：`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`
- `anthropic.com`（及其子域）：MITM 会破坏非 Bun 运行时
- GitHub、包管理器等

### 环境变量暴露

```typescript
{
  HTTPS_PROXY: 'http://127.0.0.1:<port>',
  NO_PROXY: '...',
  SSL_CERT_FILE: '~/.ccr/ca-bundle.crt',
  NODE_EXTRA_CA_CERTS: '~/.ccr/ca-bundle.crt',
  REQUESTS_CA_BUNDLE: '~/.ccr/ca-bundle.crt',
  CURL_CA_BUNDLE: '~/.ccr/ca-bundle.crt'
}
```

## 8. 设计决策与证据

### 决策 1：仅绑定 localhost

| 选项 | 分析 |
|------|------|
| **仅 localhost** | ✅ 选择 |
| 0.0.0.0 / :: | ❌ 拒绝 |

**原因**：
- Open Runner 的安全模型依赖网络隔离
- Token 通过 Bearer 传递，没有传输加密要求（因为在 localhost）
- 如果绑定公网，需要 TLS + 更多认证
- 参考：`src/open-runner/server.ts` 第 182-184 行

```typescript
if (!isLoopbackHost(host)) {
  throw new Error('Open Runner reference HTTP server only binds to loopback')
}
```

**证据**：测试 `tests/openRunnerProtocol.test.ts` 验证了非 localhost 绑定会抛出错误。

---

### 决策 2：使用租期而非长期租约

| 选项 | 分析 |
|------|------|
| **租期 + 心跳** | ✅ 选择 |
| 长期租约 + 显式释放 | ❌ 拒绝 |

**原因**：
- Worker 可能崩溃而无法释放
- 租期超时提供了安全的故障恢复机制
- 心跳在运行中刷新租期
- 参考：`src/open-runner/store.ts` `expire()` 方法

**证据**：测试 `tests/openRunnerProtocol.test.ts` 验证了租期过期后作业回到队列。

---

### 决策 3：Worker Epoch 隔离

| 选项 | 分析 |
|------|------|
| **Epoch 递增 + 新 instance_id** | ✅ 选择 |
| 仅 runner_id | ❌ 拒绝 |
| 仅 instance_id | ❌ 拒绝 |

**原因**：
- 需要防止同一个 Runner 的多个实例同时工作
- instance_id 在每次启动时变化，触发 epoch + 1
- 旧 epoch 的请求立即被拒绝
- 参考：`src/open-runner/store.ts` `register()` 方法

**证据**：测试 `tests/openRunnerProtocol.test.ts` 验证了新实例注册后旧 epoch 被隔离。

---

### 决策 4：事件幂等性 + 顺序保证

| 选项 | 分析 |
|------|------|
| **event_id + seq 分配 + 持久化** | ✅ 选择 |
| 仅追加，不检查重复 | ❌ 拒绝 |
| 仅在内存中跟踪 | ❌ 拒绝 |

**原因**：
- Worker 可能重试追加事件
- 需要避免重复
- seq 确保消费者可以重建顺序
- 参考：`src/open-runner/store.ts` `appendEvents()` 方法

**证据**：测试 `tests/openRunnerProtocol.test.ts` 验证了重复事件 ID 不会导致重复追加。

---

### 决策 5：Token 文件仅保留在内存中（Upstream Proxy）

| 选项 | 分析 |
|------|------|
| **启动后立即 unlink token 文件** | ✅ 选择 |
| 保留令牌文件 | ❌ 拒绝 |

**原因**：
- 防止 prompt 注入读取令牌
- 配合 `prctl(PR_SET_DUMPABLE, 0)` 防止 ptrace 读取堆
- Relay 启动确认后才 unlink（失败可重试）
- 参考：`src/upstreamproxy/upstreamproxy.ts` 第 140-144 行

**证据**：代码注释明确说明了设计意图，测试验证了启动流程。

---

### 决策 6：提示词交付不确定性状态

| 选项 | 分析 |
|------|------|
| **在 `prompt_sending` 阶段崩溃 = DELIVERY_UNKNOWN** | ✅ 选择 |
| 总是重试 | ❌ 拒绝 |
| 从不重试 | ❌ 拒绝 |

**原因**：
- 如果提示词已发送但不确定，自动重试会导致重复执行
- 标记为不可重试，让用户/调用方决定
- 参考：`src/open-runner/worker.ts` `recoverActiveWork()` 方法

**证据**：测试 `tests/openRunnerWorker.test.ts` 验证了恢复时的不确定性处理。

---

### 决策 7：状态目录锁防止多个 Server 实例

| 选项 | 分析 |
|------|------|
| **server.lock + startup_token** | ✅ 选择 |
| 无锁 | ❌ 拒绝 |

**原因**：
- 防止两个 Server 进程同时操作同一状态目录
- startup_token 验证锁确实由当前进程持有
- 参考：`src/open-runner/store.ts` `initialize()` 方法

**证据**：代码实现了完整的锁逻辑，包括验证和清理。

---

### 决策 8：事件持久化使用 JSONL + 原子重命名

| 选项 | 分析 |
|------|------|
| **JSONL (每行一个事件) + fsync** | ✅ 选择 |
| SQLite | ❌ 拒绝 |
| 纯 JSON 数组 | ❌ 拒绝 |

**原因**：
- JSONL 追加是原子的（最后一行可能损坏，但可以截断）
- 崩溃后可以从 state.json 的 last_seq 恢复
- SQLite 增加依赖复杂性
- 参考：`src/open-runner/store.ts` `appendEvents()` + `load()`

**证据**：测试 `tests/openRunnerProtocol.test.ts` 验证了服务器重启后事件仍然存在。

---

### 决策 9：环境变量白名单而非黑名单

| 选项 | 分析 |
|------|------|
| **显式白名单** | ✅ 选择 |
| 黑名单 | ❌ 拒绝 |

**原因**：
- 白名单更安全：默认拒绝，只允许已知安全的
- 防止敏感变量泄漏
- 参考：`src/open-runner/worker.ts` `workerEnvironment()`

**证据**：测试 `tests/openRunnerWorker.test.ts` 验证了 `OPEN_RUNNER_SECRET` 不会传递给子进程。

---

### 决策 10：CONNECT 目标在 WS 隧道内发送

| 选项 | 分析 |
|------|------|
| **CONNECT + Proxy-Authorization 在 WS 隧道内** | ✅ 选择 |
| 单独的 API | ❌ 拒绝 |

**原因**：
- GKE L7 不支持 connect_matcher
- WS 可以通过路径路由
- 与 session-ingress tunnel 模式一致
- 参考：`src/upstreamproxy/relay.ts` `openTunnel()`

**证据**：代码实现了完整的 CONNECT-over-WS 协议。

## 9. 边界与未解决问题

### 当前边界

1. **最大提示词大小**：256 KiB (`MAX_PROMPT_BYTES`)
2. **最大单个事件**：4 MiB (`MAX_EVENT_BYTES`)
3. **最大事件批**：8 MiB (`MAX_EVENT_BATCH_BYTES`)
4. **最大尝试次数**：默认 3，可配置
5. **最大运行时间**：默认 1 小时，可配置
6. **Worker 数量**：不限，但单个 Worker 的 `max_work` 限制并发

### 未解决问题（非当前范围）

1. **TLS for Server**：当前仅支持 localhost，无需 TLS。如果未来支持远程部署，需要 TLS。
2. **Metrics**：当前没有暴露 Prometheus 或其他指标。
3. **Distributed Store**：当前 Store 是单进程文件存储。如果需要高可用，需要分布式存储。
4. **Priority Queue**：当前是 FIFO，无优先级。
5. **Rate Limiting**：当前没有按租户限流（仅 `CAPACITY_EXCEEDED` 占位）。
6. **MoreRight Persistence**：MoreRight 笔记当前是进程本地的，没有持久化。

## 覆盖率

[Coverage](../../architecture/coverage/open-runner.yaml)
