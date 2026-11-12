---
id: bridge
batch: 6
title: Bridge 环境桥接与远程工作生命周期设计
date: 2026-11-12
status: draft
---

# Bridge 环境桥接与远程工作生命周期设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Bridge 系统解决的核心问题是让 claude.ai 网页能安全地控制本地 Claude Code CLI 实例，同时保持可靠的会话生命周期管理、多会话隔离、权限回调和崩溃恢复。

### 核心问题域

- **环境注册与发现**：如何让服务器识别并路由到特定的本地 CLI 实例，同时支持重连恢复？
- **轮询与重连策略**：在网络不稳定时如何保证不丢消息、不重复处理工作？
- **工作秘密安全**：如何安全传递会话凭证，同时支持两个版本的协议？
- **会话生命周期**：从 spawn、心跳到超时终止，如何管理子进程与状态跟踪？
- **权限回调**：工具权限请求如何从子进程路由到网页端，再路由回来？
- **多会话与 worktree**：如何支持并行会话而不互相踩踏文件系统？
- **关闭与恢复**：干净退出和崩溃恢复的语义有何不同？
- **安全边界**：OAuth、环境 secret、会话 JWT、受信设备 token 各层的职责是什么？

### 约束条件

- 不能复制 remote-control、daemon 或 SDK 的设计文档；只写 bridge 模块。
- 需要支持两个主要实现：standalone `claude remote-control` 和内嵌的 REPL bridge。
- 需要同时支持 v1（env-based，轮询）和 v2（env-less，直接连接）两种协议。
- 崩溃恢复需要跨 worktree 查找指针，因为 REPL 可能在不同的 worktree 中运行。

## 2. 设计概览

### 2.1 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│                   claude.ai Web UI                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Claude.ai Server                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Environments API (v1)  │  Code Sessions API (v2)   │  │
│  │  - register             │  - create                 │  │
│  │  - poll                 │  - events SSE             │  │
│  │  - acknowledge          │  - worker POST            │  │
│  │  - heartbeat            │  - worker JWT             │  │
│  │  - stop                 │                           │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │
         ┌─────────────────┴─────────────────┐
         │                                   │
         ▼                                   ▼
┌───────────────────────┐        ┌──────────────────────────┐
│   Standalone Bridge   │        │      REPL Bridge        │
│  (bridgeMain.ts)      │        │  (replBridge.ts +       │
│  - poll/work-dispatch │        │   remoteBridgeCore.ts)  │
│  - multi-session      │        │  - in-process           │
│  - spawn child        │        │  - perpetual mode      │
└───────────────────────┘        └──────────────────────────┘
         │                                   │
         └─────────────────┬─────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Session Layer                             │
│  ┌─────────────────┐  ┌──────────────────────────────────┐ │
│  │ sessionRunner   │  │      createSession.ts           │ │
│  │ - spawn child   │  │ - create/fetch/archive          │ │
│  │ - NDJSON parse  │  │ - title derivation              │ │
│  │ - activity track│  │                                 │ │
│  └─────────────────┘  └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 关键概念

| 概念 | 定义 |
|------|------|
| **Environment** | 一个 bridge 实例的逻辑标识，client 生成 UUID，server 分配 `environment_id` |
| **Work Item** | 待处理的会话，包含 `WorkSecret` 和会话信息 |
| **WorkSecret** | 编码的会话凭证，包含 `session_ingress_token`、`api_base_url` 等 |
| **SessionHandle** | 运行中会话的句柄，支持杀死、写入 stdin、更新 token |
| **SpawnMode** | `single-session` / `worktree` / `same-dir` 三种会话隔离模式 |
| **BridgePointer** | 崩溃恢复指针，存储在 `.claude/bridge-pointer.json` |
| **Transport** | v1 (HybridTransport) / v2 (SSE + CCRClient) 的抽象 |

## 3. 环境注册与发现

### 3.1 注册流程

**当前设计**：
1. Client 生成 `bridgeId` (UUID) 和 `environmentId` (UUID)
2. 发送注册请求，携带：
   - `machine_name`：主机名
   - `branch`/`git_repo_url`：git 信息
   - `worker_type`：`claude_code` (standalone) 或 `claude_code_assistant` (REPL)
   - `max_sessions`：容量
   - `spawn_mode`：会话隔离模式
   - `reuse_environment_id`：用于恢复（可选）
3. Server 返回 `environment_id` 和 `environment_secret`（JWT）

**证据位置**：`bridgeApi.ts` 中的 `registerBridgeEnvironment()`，`bridgeMain.ts` 中的初始注册逻辑。

**为什么这样设计**：
- Client 侧生成 UUID 确保重试幂等，同时让 `reuseEnvironmentId` 可以引用之前注册的环境。
- 携带 git 信息让网页能显示当前环境对应的仓库和分支，提升用户体验。
- `worker_type` 让服务器能区分不同来源的 bridge，分别路由。

**代价**：Client 需要存储 `reuseEnvironmentId` 用于恢复；如果丢失，只能创建新环境。

**备选方案**：
- 备选 1：Server 生成所有 ID。代价：重试无法幂等，需要额外的去重机制。
- 备选 2：不携带 git 信息。代价：网页无法显示仓库上下文，体验下降。

### 3.2 环境 ID 的重用与恢复

**当前设计**：
- `--session-id` 和 `--continue` 使用 `reuseEnvironmentId` 重新注册到同一环境
- 同时调用 `reconnectSession()` 强制终止该环境上的 stale worker 并重新入队会话
- Shutdown 时跳过 archive/deregister，允许未来恢复

**证据位置**：`bridgeMain.ts` 中的 resume 逻辑（2307-2434 行），`bridgeApi.ts` 中的 `reconnectSession()`。

**为什么这样设计**：
- 用户期望 `--session-id` 能回到同一会话，而不是创建新会话。
- 强制终止 stale worker 避免两个 bridge 同时处理同一会话。

**设计决策 1：环境注册使用双 ID 模型（client UUID + server ID）**

| 维度 | 选择 | 备选 | 代价 | 证据 |
|------|------|------|------|------|
| 幂等性 | Client 生成 `bridgeId`/`environmentId` | Server 只生成 ID | Client 需要存储恢复 ID | `bridgeApi.ts` 中的注册请求 |
| 恢复语义 | `reuseEnvironmentId` + `reconnectSession()` | 每次创建新环境 | 用户需要接受新 session URL | `bridgeMain.ts` 的 resume 分支 |

## 4. 轮询与重连策略

### 4.1 轮询配置

**当前设计**：
- 不在容量时：默认 2 秒轮询
- 在容量时：默认 10 分钟轮询 + 可选心跳
- 多会话有三个阶段：未满 / 部分满 / 满
- 回收窗口：默认 5 秒内未确认的工作可被其他实例回收

**证据位置**：`pollConfigDefaults.ts`、`pollConfig.ts`。

**安全规则**：
- 所有间隔 ≥ 100ms，防止 fat-finger 配置导致 DDoS
- 在容量时必须至少启用一个 liveness 机制（心跳或轮询），防止 tight loop
- 配置用 Zod 验证，任何字段违规则回退到默认配置，不接受部分有效配置

**为什么这样设计**：
- 不在容量时低延迟轮询，在容量时减少请求以降低服务器负载。
- 心跳是更轻量的 liveness 信号（无 DB 命中），可单独启用或与轮询并用。
- 回收窗口让崩溃的实例快速被接管，同时避免竞争条件。

### 4.2 错误恢复与退避

**当前设计**：
```
连接错误：2s → 4s → 8s → ... → 120s cap，10 分钟后放弃
一般错误：500ms → ... → 30s cap，10 分钟后放弃
睡眠检测：间隙 > 2×backoff cap 时重置错误预算（系统睡眠唤醒）
```

**证据位置**：`bridgeMain.ts` 的 `runBridgeLoop()` 中的 backoff 逻辑。

**为什么这样设计**：
- 指数退避避免服务器过载。
- 睡眠检测处理笔记本合盖等场景，避免唤醒后长时间等待退避。
- 10 分钟放弃窗口平衡了可用性和资源占用。

### 4.3 心跳机制

**当前设计**：
- `heartbeatWork()` 使用 session ingress JWT（无 DB 命中）延长租约
- 在容量时可配置用心跳代替轮询
- `capacityWake` 信号在会话结束时唤醒睡眠中的 poll loop
- Auth 失败触发 `reconnectSession()` 获取新鲜 token

**证据位置**：`bridgeMain.ts` 的心跳循环，`capacityWake.ts`。

**为什么这样设计**：
- 心跳比轮询更轻量，适合在容量时使用。
- `capacityWake` 让新工作能立即被接受，而不是等到下次心跳/轮询。

**设计决策 2：在容量时支持心跳 + 轮询双模式，并用 capacityWake 快速唤醒**

| 维度 | 选择 | 备选 | 代价 | 证据 |
|------|------|------|------|------|
| Liveness | 心跳 + 轮询可配置 | 只用心跳或只用轮询 | 配置复杂度增加 | `pollConfig.ts` 的 object-level refine |
| 唤醒信号 | `capacityWake` AbortController 组合 | 只依赖超时唤醒 | 新工作可能等待最长心跳间隔 | `capacityWake.ts` |
| Auth 失败 | 触发 `reconnectSession()` | 直接退出 | 更激进的恢复尝试 | `bridgeMain.ts` 的心跳错误处理 |

## 5. 工作秘密安全

### 5.1 WorkSecret 结构

**当前设计**：
```typescript
type WorkSecret = {
  version: 1
  session_ingress_token: string    // JWT
  api_base_url: string
  sources: Array<{ type: string; git_info?: {...} }>
  auth: Array<{ type: string; token: string }>
  claude_code_args?: Record<string, string>
  mcp_config?: unknown
  environment_variables?: Record<string, string>
  use_code_sessions?: boolean      // server 选择 v1/v2
}
```

**编码**：base64url 编码的 JSON，解码时验证 version 和必填字段。

**证据位置**：`types.ts` 的 `WorkSecret` 定义，`workSecret.ts` 的 `decodeWorkSecret()`。

**为什么这样设计**：
- 显式 `version` 字段支持未来演进。
- `use_code_sessions` 让服务器能逐步迁移到 v2，同时保持兼容性。
- `session_ingress_token` 与 OAuth 分离，子进程不需要父进程的 OAuth token。

### 5.2 URL 构建与协议选择

**当前设计**：
- v1：`buildSdkUrl()` → WebSocket URL，localhost 用 `/v2/`，生产用 `/v1/`
- v2：`buildCCRv2SdkUrl()` → HTTP URL，指向 `/v1/code/sessions/{id}`
- `sameSessionId()` 比较 UUID 时忽略 `session_` vs `cse_` 前缀

**证据位置**：`workSecret.ts` 的三个 URL/ID 函数。

**为什么这样设计**：
- v1/v2 双协议支持渐进迁移，不需要一次性切换。
- `sameSessionId()` 处理兼容层 retag，避免在 v2 迁移期间拒绝自己的会话。

**设计决策 3：WorkSecret 包含协议选择标志，ID 比较忽略前缀**

| 维度 | 选择 | 备选 | 代价 | 证据 |
|------|------|------|------|------|
| 协议选择 | `use_code_sessions` 标志 | 两个不同的 WorkSecret 类型 | 需要同时支持两个解码器 | `workSecret.ts` 的 `decodeWorkSecret()` |
| ID 比较 | 忽略前缀，只比较 UUID | 严格相等 | 需要一个 ID 规范化函数 | `workSecret.ts` 的 `sameSessionId()` |
| URL 构建 | localhost 用 `/v2/`，生产用 `/v1/` | 统一用 `/v1/` | 本地开发与生产不一致 | `workSecret.ts` 的 `buildSdkUrl()` |

### 5.3 Token 刷新

**当前设计**：
- `createTokenRefreshScheduler()` 在 JWT 过期前 5 分钟主动刷新
- Generation counter 让 stale in-flight refresh 失效
- 连续 3 次失败后放弃，60 秒重试延迟
- 子进程通过 stdin 的 `update_environment_variables` 消息接收新 token

**证据位置**：`jwtUtils.ts`，`sessionRunner.ts` 的 `updateAccessToken()`。

**为什么这样设计**：
- 主动刷新避免请求中间 token 过期导致的失败。
- Generation counter 避免并发 refresh 导致的竞态。
- 通过 stdin 推送而不是让子进程自己拉取，简化子进程设计。

## 6. 会话生命周期

### 6.1 Spawn 模式

**当前设计**：
- `single-session`：一个会话，结束后 bridge 退出
- `same-dir`：多会话共享同一 cwd（可能互相踩踏）
- `worktree`：每个会话有独立的 git worktree

**证据位置**：`types.ts` 的 `SpawnMode`，`bridgeMain.ts` 的 worktree 创建逻辑。

**为什么这样设计**：
- `single-session` 适合简单用例，符合用户直觉。
- `same-dir` 适合快速原型，但不推荐生产使用。
- `worktree` 提供真正的隔离，但需要 git 支持；初始会话仍在 cwd（UX 考虑）。

### 6.2 会话 Spawner

**当前设计**：
- 子进程用 `--print`、`--sdk-url`、`--session-id` 启动
- 环境变量：
  - 去掉 `CLAUDE_CODE_OAUTH_TOKEN`（安全隔离）
  - 设置 `CLAUDE_CODE_ENVIRONMENT_KIND=bridge`
  - 设置 `CLAUDE_CODE_SESSION_ACCESS_TOKEN`
  - v1：`CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2=1`
  - v2：`CLAUDE_CODE_USE_CCR_V2=1` + `CLAUDE_CODE_WORKER_EPOCH`
- NDJSON 从 stdout 解析，stderr 用于调试
- Activity 环形缓冲区（最后 10 个活动）
- 超时看门狗（默认 24 小时）

**证据位置**：`sessionRunner.ts` 的 `createSessionSpawner()`。

**为什么这样设计**：
- 去掉父 OAuth token 是安全边界：子进程只能访问会话级 API，不能代表用户做其他操作。
- NDJSON 管道是简单、可调试的 IPC 机制。
- 24 小时超时防止遗忘的会话无限运行。

### 6.3 活动跟踪与状态显示

**当前设计**：
- 每秒更新状态显示
- 工具动词映射：`Read`→`Reading`，`Write`→`Writing` 等
- 最后 5 个活动的 trail
- 多会话模式：活动会话列表
- 标题派生：`onFirstUserMessage` 从第一条真实用户消息派生（跳过 tool-result、synthetic）

**证据位置**：`sessionRunner.ts` 的 `extractActivities()`，`bridgeMain.ts` 的状态更新循环。

**为什么这样设计**：
- 人类可读的动词比原始工具名更友好。
- 跳过 tool-result 和 synthetic 消息避免标题为 "Here are the files you asked for" 等无用内容。

**设计决策 4：会话隔离分层（环境变量剥离 + 可选 worktree），标题从第一条真实用户消息派生**

| 维度 | 选择 | 备选 | 代价 | 证据 |
|------|------|------|------|------|
| 安全隔离 | 剥离父 OAuth token，仅会话 JWT | 让子进程继承 OAuth | 子进程权限过大 | `sessionRunner.ts` 的 env 构造 |
| Worktree | 仅在需要时创建，初始会话在 cwd | 所有会话都用 worktree | UX 下降（初始不在用户期望的目录） | `bridgeMain.ts` 的 worktree 逻辑 |
| 标题派生 | 跳过 tool-result/synthetic，取第一条真实消息 | 用第一条任意消息 | 标题常为上下文工具结果 | `sessionRunner.ts` 的 `onFirstUserMessage` 回调 |
| 超时 | 默认 24 小时，可配置 | 无超时 | 会话可能无限运行 | `types.ts` 的 `DEFAULT_SESSION_TIMEOUT_MS` |

## 7. 权限回调

**当前设计**：
1. 子进程发出 `control_request`，`subtype: 'can_use_tool'`
2. Bridge 通过 `sendPermissionResponseEvent()` 转发到服务器
3. 用户在网页批准/拒绝
4. 服务器发送 `control_response`
5. Bridge 通过 stdin 转发给子进程

**证据位置**：`sessionRunner.ts` 的 control request 检测，`bridgeMain.ts` 的转发逻辑，`bridgePermissionCallbacks.ts`。

**为什么这样设计**：
- 权限请求由子进程发起（而不是 bridge 拦截），因为只有子进程知道完整的工具调用上下文。
- Bridge 只是透明路由，不做决策，保持简单。

## 8. 多会话与 Worktree

### 8.1 容量管理

**当前设计**：
- 默认 32 个会话（`SPAWN_SESSIONS_DEFAULT`）
- `--capacity` 可配置
- 在容量时用心跳代替轮询，或降低轮询频率
- `capacityWake` 在会话结束时唤醒

**证据位置**：`bridgeMain.ts` 的容量判断，`capacityWake.ts`。

### 8.2 Worktree 创建与清理

**当前设计**：
- 用 `createAgentWorktree()` 创建隔离的 git worktree
- 最佳努力清理：会话结束时删除 worktree
- Hook-based 回退：如果 git worktree 不可用
- Worktree 扫描：`--continue` 扫描 sibling worktrees 查找 pointer

**证据位置**：`bridgeMain.ts` 的 worktree 逻辑，`bridgePointer.ts` 的 `readBridgePointerAcrossWorktrees()`。

**为什么这样设计**：
- Worktree 提供强隔离，但不是所有用户都用 git；hook-based 回退保证可用性。
- 跨 worktree 扫描是必须的，因为 REPL 可能在不同的 worktree 中启动，然后写入 pointer。

## 9. 关闭与恢复

### 9.1 干净关闭

**当前设计**：
1. `SIGINT`/`SIGTERM` 或 controller abort 触发
2. 给所有活跃会话发送 `SIGTERM`
3. 等待最多 shutdown grace period（默认 30 秒）
4. `SIGKILL` stragglers
5. 对所有活跃工作项调用 `stopWork()`（带重试）
6. Archive 所有会话（幂等）
7. Deregister 环境
8. 清除 crash-recovery pointer
9. 等待待清理的 promise（stopWork、worktree 删除）

**证据位置**：`bridgeMain.ts` 的 teardown 逻辑（2435-2600+ 行）。

### 9.2 崩溃恢复

**当前设计**：
- Pointer 文件：`bridge-pointer.json`（v1）或 `env-less-bridge-pointer.json`（v2）
- TTL：4 小时（与服务器 `BRIDGE_LAST_POLL_TTL` 匹配）
- 包含：`sessionId`、`environmentId`、`source`、`lastSequenceNum`（v2）
- 权限：`0o600`（仅所有者读写）
- Perpetual 模式：pointer 在 teardown 时保留，不 archive 会话

**证据位置**：`bridgePointer.ts`、`envLessBridgePointer.ts`、`perpetualBridge.test.ts`。

**为什么这样设计**：
- 4 小时 TTL 让崩溃恢复在合理时间内可用，同时避免永久保留 stale pointer。
- `0o600` 防止其他用户读取会话信息。
- Perpetual 模式让 CLI 退出后会话继续存在，重启后能无缝恢复。

**设计决策 5：用 TTLed pointer 文件做崩溃恢复，perpetual 模式保留 pointer 并跳过 archive**

| 维度 | 选择 | 备选 | 代价 | 证据 |
|------|------|------|------|------|
| 恢复存储 | 每个目录的 pointer 文件，`0o600` | 全局存储 | 用户隐私风险 | `envLessBridgePointer.ts` |
| TTL | 4 小时，与服务器匹配 | 无限期 | Stale pointer 累积 | `bridgePointer.ts` 的 TTL 检查 |
| Perpetual teardown | 保留 pointer，不 archive | 与普通 teardown 相同 | 用户需要明确知道 perpetual 的语义 | `perpetualBridge.test.ts` 的测试场景 |
| Worktree 扫描 | 扫描 sibling worktrees 找 pointer | 只看当前目录 | 从不同 worktree 启动时无法恢复 | `bridgePointer.ts` 的 `readBridgePointerAcrossWorktrees()` |

## 10. 安全边界

### 10.1 认证层

**当前设计**：
| 层级 | Token 类型 | 用途 |
|------|-----------|------|
| 1 | OAuth access token | 环境注册、轮询 |
| 2 | Environment secret (JWT) | 工作认领 |
| 3 | Session ingress JWT | 会话特定操作（心跳、权限响应） |
| 4 | Trusted device token | Elevated security tier（v2） |

**证据位置**：`bridgeApi.ts`、`trustedDevice.ts`。

### 10.2 受信设备 Token

**当前设计**：
- 登录后立即注册（服务器 gate 检查 `account_session.created_at < 10min`）
- 存储在 keychain（macOS）
- 作为 `X-Trusted-Device-Token` 头发送
- 90 天滚动过期
- Enrollment 永远不阻塞登录流程（最佳努力）

**证据位置**：`trustedDevice.ts`。

**为什么这样设计**：
- Elevated security tier 用于敏感操作，但 enrollment 不能成为登录的障碍。
- Keychain 提供安全存储，避免明文写在磁盘上。

### 10.3 输入验证

**当前设计**：
- `SAFE_ID_PATTERN`：`^[a-zA-Z0-9_-]+$`，防止路径遍历
- `MAX_INBOUND_TEXT_LENGTH`：1MB
- `MAX_INBOUND_BASE64_LENGTH`：20MB
- `MAX_INBOUND_ATTACHMENTS`：20
- Envelope 严格验证字段白名单，不允许额外字段

**证据位置**：`inboundMessages.ts`、`bridgeApi.ts`。

**为什么这样设计**：
- 严格的输入验证是安全的基础，即使服务器也验证，本地验证提供深度防御。

### 10.4 Feature Gate 与权限检查

**当前设计**：
- `isBridgeEnabled()`：需要 claude.ai 订阅 + `tengu_ccr_bridge` gate
- `isEnvLessBridgeEnabled()`：检查 `tengu_bridge_repl_v2` gate
- `getBridgeDisabledReason()`：详细诊断为什么不可用（构建 flag？未订阅？token scope 不足？无 org UUID？gate 关闭？）
- Policy check：`allow_remote_control` 必须允许

**证据位置**：`bridgeEnabled.ts`、`initReplBridge.ts`。

**为什么这样设计**：
- 分层 gate 让功能可以渐进发布（内部 dogfood → ant → beta → full）。
- 详细的禁用原因避免用户困惑，帮助诊断问题。

**设计决策 6：四层认证 + 严格输入验证 + 分层 feature gate，受信设备 enrollment 最佳努力不阻塞**

| 维度 | 选择 | 备选 | 代价 | 证据 |
|------|------|------|------|------|
| 认证 | OAuth + env secret + session JWT + trusted device | 单层 token | 实现复杂度增加 | `bridgeApi.ts` 的 auth header 构造 |
| 输入验证 | 严格字段白名单，拒绝额外字段 | 宽松解析，忽略额外字段 | 向后兼容性降低 | `inboundMessages.ts` 的 envelope 验证 |
| Feature gate | 分层（构建 flag → 订阅 → scope → org → GB） | 单一 gate | 诊断路径变长 | `bridgeEnabled.ts` 的 `getBridgeDisabledReason()` |
| Trusted device | 最佳努力，不阻塞登录 | 必需 enrollment | 登录流程更复杂 | `trustedDevice.ts` 的 enroll 逻辑 |

## 11. 两个 Bridge 实现

### 11.1 Standalone Bridge

**当前设计**：
- 命令：`claude remote-control`
- 轮询/工作分发模型
- 多会话支持（worktree/same-dir）
- 子进程 spawn
- 状态显示（shimmer、activity trail）

**证据位置**：`bridgeMain.ts`。

### 11.2 REPL Bridge

**当前设计**：
- 通过 `/remote-control` 在交互式会话中调用
- 两个变体：
  - v1：env-based，轮询/工作分发
  - v2：env-less，直接 `/bridge` 端点，无轮询
- Perpetual 模式：会话在 CLI 退出后存活，重启后恢复
- 进程内消息转发（不 spawn 子进程）
- 初始历史刷新带 cap（默认 200 条消息）
- Flush gate：在历史刷新期间排队实时写入

**证据位置**：`replBridge.ts`、`remoteBridgeCore.ts`、`initReplBridge.ts`、`flushGate.ts`。

**为什么这样设计**：
- Perpetual 模式让用户可以关闭 CLI 然后回来继续同一会话，符合网页会话的直觉。
- Flush gate 避免历史刷新与实时消息交错，确保一致性。

## 12. 覆盖范围

相关覆盖定义见 [Coverage](../../architecture/coverage/bridge.yaml)。
