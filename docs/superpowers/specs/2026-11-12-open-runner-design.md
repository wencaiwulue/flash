---
id: open-runner
batch: 6
title: Open Runner 环境执行与 Worker 协议设计
date: 2026-11-12
status: draft
---

# Open Runner 环境执行与 Worker 协议设计

## 1. 问题与约束

Open Runner 需要解决以下核心问题与约束：

1. **分布式作业分发**：安全地将作业分配给多个 Worker，避免重复执行
2. **崩溃恢复**：Worker 崩溃时不丢失进度，也不重复执行有副作用的任务
3. **环境隔离**：防止敏感凭据泄漏到子进程，默认权限最小化
4. **事件持久化**：确保执行过程中的事件可靠存储，支持回放
5. **上游凭据注入**：在 CCR 环境中安全地向第三方服务注入凭据
6. **向后兼容**：不替换 remote-control/daemon，而是互补
7. **单进程部署**：初始设计支持单进程文件存储，不依赖分布式数据库

## 2. 设计理由与备选方案

### 2.1 租期 + 心跳（而非长期租约）

- **备选方案**：长期租约 + 显式释放（简单，但 Worker 崩溃会导致作业卡住）
- **选择理由**：在可靠性和开销之间最佳平衡，自动恢复，可配置超时
- **代价**：需要心跳流量
- **证据**：`src/open-runner/store.ts` `expire()` 方法

### 2.2 串行化操作（而非细粒度锁）

- **备选方案**：细粒度锁（理论性能更好，但容易死锁）
- **选择理由**：无竞态，易推理，作业调度不是瓶颈
- **代价**：吞吐量受限
- **证据**：`src/open-runner/store.ts` `serialize()` 方法

### 2.3 Worker 隔离：runner_id + instance_id + worker_epoch

- **备选方案**：仅 runner_id（简单，但多个实例同时运行会冲突）
- **选择理由**：精确隔离，新实例自动使旧实例失效
- **代价**：需要持久化 instance_id
- **证据**：`src/open-runner/store.ts` `register()` 方法

### 2.4 事件持久化：JSONL + 原子重命名

- **备选方案**：
  - SQLite（查询能力强，但增加依赖，部署复杂）
  - 纯 JSON 数组（简单，但追加需要重写整个文件，崩溃时可能损坏）
- **选择理由**：追加原子，崩溃可恢复（截断最后一行），事件主要是追加和顺序回放
- **代价**：查询需要扫描
- **证据**：`src/open-runner/store.ts` `appendEvents()` + `load()`

### 2.5 环境变量：白名单（而非黑名单）

- **备选方案**：黑名单（向后兼容好，但容易遗漏新的敏感变量）
- **选择理由**：安全优先，默认拒绝
- **代价**：需要显式添加
- **证据**：`src/open-runner/worker.ts` `workerEnvironment()`

### 2.6 绑定地址：仅 localhost（而非 0.0.0.0/::）

- **备选方案**：0.0.0.0/::（可远程访问，但需要 TLS + 更强认证）
- **选择理由**：符合当前使用场景，网络隔离，无需 TLS
- **代价**：不能远程访问
- **证据**：`src/open-runner/server.ts` 第 182-184 行

### 2.7 提示词交付：显式标记不确定性

- **备选方案**：
  - 总是重试（可用性高，但可能重复执行有副作用的任务）
  - 从不重试（无重复风险，但可用性低）
- **选择理由**：让调用方决定，安全且灵活
- **代价**：增加复杂性
- **证据**：`src/open-runner/worker.ts` `recoverActiveWork()`

### 2.8 Upstream Proxy 令牌：仅内存 + prctl（而非保留令牌文件）

- **备选方案**：保留令牌文件（崩溃后可恢复，但 prompt 注入可读取）
- **选择理由**：安全优先，防止 ptrace 读取堆，防止文件读取
- **代价**：崩溃后需重新注入
- **证据**：`src/upstreamproxy/upstreamproxy.ts` 第 140-144 行

## 3. 目标与非目标

### 3.1 目标

1. **可靠的作业分发**：Worker 可以拉取作业，租期到期自动转移
2. **崩溃恢复**：Worker 重启后可以恢复或报告失败，交付不确定性显式标记
3. **事件持久化**：所有 SDK 事件可靠存储，可回放，事件幂等追加
4. **安全隔离**：防止敏感凭据泄漏，路径遍历防护，环境白名单
5. **幂等性**：重复操作不会导致重复效果
6. **可观测性**：作业状态和事件可查询
7. **上游代理**：安全注入第三方服务凭据

### 3.2 非目标

1. **不替换 remote-control/daemon**：互补，不重叠
2. **不支持分布式 Store**：当前是单进程文件存储
3. **不支持优先级队列**：当前是 FIFO
4. **不支持多租户限流**：仅占位 CAPACITY_EXCEEDED
5. **不支持 TLS**：当前仅绑定 localhost
6. **不暴露 Metrics**：当前无 Prometheus 等指标

## 4. 架构、模块与数据流

### 4.1 架构概览

```
Admin Client (提交/查询/取消)
         │
         ▼
┌─────────────────────────────────────────────────────┐
│              Open Runner Server                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │   HTTP API   │  │    Store     │  │ Queue    │ │
│  └──────────────┘  └──────────────┘  └──────────┘ │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
              ┌──────────────────┐
              │   Worker Pool    │
              └────────┬─────────┘
                       │
                       ▼
              ┌──────────────────┐
              │   CLI Child      │
              │  (执行作业)      │
              └──────────────────┘
```

### 4.2 模块设计卡

#### 4.2.1 Protocol 模块

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `normalizeWorkInput(value: unknown): WorkInput`、`contentHash(value: unknown): string`、`readTokenFile(path: string): Promise<string>` |
| **关键类型** | `WorkInput`、`WorkRecord`、`WorkAssignment`、`RunnerIdentity`、`LeaseIdentity`、`RunnerRegistration`、`WorkEventInput`、`WorkEvent`、`OpenRunnerErrorCode`、`OpenRunnerError` |
| **输入输出** | 输入：未知 JSON 值（来自 HTTP 请求）；输出：规范化的类型安全对象；错误：`OpenRunnerError` 带错误码（`AUTHENTICATION_FAILED`、`INVALID_REQUEST`、`IDEMPOTENCY_CONFLICT` 等） |
| **状态机** | 无状态纯函数模块；验证函数是确定性的，无副作用 |
| **注册/拉取/心跳/执行/恢复流程** | 不参与流程执行，仅提供类型定义和验证函数供其他模块使用 |
| **错误与安全** | 错误码枚举覆盖所有失败场景；token 文件读取验证权限（0600）、所有权（当前用户）、熵（32-1024 字符，无空白）；路径遍历防护（`validateRelativeCwd` 检查 `..`、绝对路径、Windows 盘符）；contentHash 提供确定性哈希用于幂等性检查 |
| **设计取舍/备选** | 选择 JSON Schema 风格的手动验证而非运行时库，避免额外依赖；错误码是字符串枚举而非数字，便于调试；token 读取不包含在错误消息中，避免泄露 |
| **源码测试证据** | `src/open-runner/protocol.ts`：`normalizeWorkInput` L201-242、`validateRelativeCwd` L244-258、`resolveWorkspaceCwd` L261-275、`contentHash` L302-304、`readTokenFile` L351-400；测试：`tests/openRunnerProtocol.test.ts` |

#### 4.2.2 Store 模块

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `class OpenRunnerStore { constructor(opts: OpenRunnerStoreOptions); async initialize(): Promise<void>; async register(value: unknown): Promise<RunnerRegistration>; async submit(value: unknown): Promise<WorkRecord>; async poll(value: unknown): Promise<{server_time: string, work: WorkAssignment[], cancel_requested: string[]}>; async acknowledge(workId: string, value: unknown): Promise<WorkRecord>; async heartbeat(workId: string, value: unknown): Promise<{lease_expires_at: string, state: WorkState, cancel_requested: boolean}>; async appendEvents(workId: string, value: unknown): Promise<{accepted: {event_id: string, seq: number}[], last_seq: number}>; async complete(workId: string, value: unknown): Promise<WorkRecord>; async cancel(workId: string, value: unknown): Promise<WorkRecord>; async getWork(workId: string): Promise<WorkRecord>; async listWorks(state?: WorkState, limit?: number): Promise<WorkRecord[]> }` |
| **关键类型** | `StoredWork`（带 lease/epoch 的内部状态）、`PersistentState`（磁盘持久化格式）、`OpenRunnerStoreOptions`（配置：stateDir、leaseMs、heartbeatIntervalMs、now、monotonicNow、retryBaseMs） |
| **输入输出** | 输入：未知 JSON 值（来自 Server 路由）；输出：公开的 `WorkRecord`（隐藏内部字段如 `protocol`、`submit_hash`、`completion_hash`）； Lease 身份通过 `parseLeaseIdentity` 从请求体中提取 |
| **状态机** | `queued → leased → running → succeeded/failed/cancelled`；retry_wait 是 leased 的前置状态（lease 过期自动退回）；cancel_requested 是布尔标志，在 queued/leased/running 时都可设置，queued/retry_wait 时立即完成，leased/running 时通知 worker；Worker epoch：同一 runner_id + 新 instance_id → epoch 递增，旧 epoch 所有操作被拒绝 |
| **注册/拉取/心跳/执行/恢复流程** | **注册**：`register()` → 验证 runner_id/instance_id/capabilities → 递增 epoch（新 instance_id）→ 持久化 → 返回 epoch+间隔；**拉取**：`poll()` → 验证 epoch → 过期租期回收 → 队列中取作业 → 状态 queued→leased/ retry_wait→leased → 设置 lease_id/expires_at/runner_id/instance_id/epoch；**心跳**：`heartbeat()` → 验证 lease/epoch → 续租（更新 expires_at）→ 返回 cancel_requested；**执行**：`acknowledge()` → leased→running；`appendEvents()` → event_id 去重，原子追加 JSONL；`complete()` → 终态，retryable 失败时 retry_wait；**恢复**：无主动恢复，通过租期过期机制实现自动重试；事件持久化在崩溃后可重新读取 |
| **错误与安全** | `STALE_WORKER_EPOCH`（旧实例被围栏）、`STALE_LEASE`（租期过期或不匹配）、`WORK_TERMINAL`（终态不可变）、`IDEMPOTENCY_CONFLICT`（同 work_id 不同输入）、`EVENT_ID_CONFLICT`（同 event_id 不同内容）；序列化操作（`serialize()` 方法），所有操作通过 Promise 链串行执行，无竞态；原子写入（`atomicWriteJson`）：临时文件 → sync → rename → fsync 目录；token 不经过 Store |
| **设计取舍/备选** | 选择单进程文件存储而非分布式数据库，简化部署；选择序列化操作而非细粒度锁，避免死锁，吞吐量受限但可接受；租期+心跳而非长期租约，自动恢复；JSONL 而非 SQLite，追加原子，崩溃可恢复（截断最后不完整行），查询需扫描；备选：细粒度锁（放弃）、SQLite（放弃）、长期租约（放弃） |
| **源码测试证据** | `src/open-runner/store.ts`：`serialize()` L458-469、`register()` L586-640、`submit()` L643-718、`poll()` L721-809、`heartbeat()` L874-903、`appendEvents()` L933-1038、`complete()` L1068-1133、`expire()` L520-557、`atomicWriteJson` L117-136；测试：`tests/openRunnerWorker.test.ts` |

#### 4.2.3 Server 模块

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `class OpenRunnerServer { constructor(opts: OpenRunnerServerOptions); async start(): Promise<OpenRunnerServerInfo>; async stop(): Promise<void> }; async startOpenRunnerServer(opts: OpenRunnerServerOptions): Promise<OpenRunnerServer>` |
| **关键类型** | `OpenRunnerServerOptions`（host、port、stateDir、workerToken、adminToken、workerTokenFile、adminTokenFile、leaseMs、heartbeatIntervalMs、retryBaseMs、now、monotonicNow、drainTimeoutMs）、`OpenRunnerServerInfo`（protocol、server_url、state_dir、host、port） |
| **输入输出** | 输入：HTTP 请求（JSON 主体）+ Authorization: Bearer <token>；输出：JSON 响应，带 `protocol: "open-runner-v1"` 字段；健康检查：`GET /open-runner/v1/health` |
| **状态机** | Server 自身状态：`started` 可接受请求 → `draining` 拒绝新提交 → `stopped`；Worker/Admin 双角色认证，路由级别权限检查 |
| **注册/拉取/心跳/执行/恢复流程** | **路由**：`POST /open-runner/v1/runners/register`（Worker）→ `store.register()`；`POST /open-runner/v1/work`（Admin）→ `store.submit()`；`POST /open-runner/v1/work/poll`（Worker）→ 循环 `store.poll()` + `waitForChange`；`GET /open-runner/v1/work`（Admin）→ `store.listWorks()`；`GET /open-runner/v1/work/{workId}`（Admin/Worker）→ `store.getWork()`（Worker 需 valid lease）；`POST /open-runner/v1/work/{workId}/ack`（Worker）→ `store.acknowledge()`；`POST /open-runner/v1/work/{workId}/heartbeat`（Worker）→ `store.heartbeat()`；`POST /open-runner/v1/work/{workId}/events`（Worker）→ `store.appendEvents()`；`POST /open-runner/v1/work/{workId}/complete`（Worker）→ `store.complete()`；`POST /open-runner/v1/work/{workId}/cancel`（Admin）→ `store.cancel()`；`GET /open-runner/v1/work/{workId}/events`（Admin/Worker）→ `store.readEvents()` |
| **错误与安全** | 双令牌认证：Worker Token 和 Admin Token 独立，timing-safe 比较（`tokensEqual`）避免时序攻击；绑定仅 localhost（`isLoopbackHost`），不支持远程访问；请求体大小限制（MAX_EVENT_BATCH_BYTES + 1MB）；所有错误通过 `errorResponse()` 统一格式，含 retryable 标志；draining 模式拒绝新提交但允许已有作业继续 |
| **设计取舍/备选** | 选择 Bearer Token 而非 mTLS，简化本地部署；选择显式双令牌而非单令牌权限范围，安全边界清晰；选择 HTTP/1.1 而非 HTTP/2，Node.js 原生支持；备选：mTLS（放弃）、权限范围令牌（放弃）、gRPC（放弃） |
| **源码测试证据** | `src/open-runner/server.ts`：`authenticate()` L61-66、`role()` L256-267、`handle()` L275-434、路由 L302-419、`start()` L179-239、`stop()` L489-525；测试：`tests/openRunnerProtocol.test.ts` |

#### 4.2.4 Worker 模块

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `class OpenRunnerWorker { constructor(opts: OpenRunnerWorkerOptions); async initialize(): Promise<void>; async register(): Promise<RunnerRegistration>; async runOnce(waitMs?: number): Promise<WorkRecord[]>; async run(opts?: {once?: boolean, waitMs?: number}): Promise<WorkRecord[]>; stop(): void }; async runOpenRunnerWorker(opts: OpenRunnerWorkerOptions & {once?: boolean}): Promise<WorkRecord[]>` |
| **关键类型** | `OpenRunnerWorkerOptions`（client、runnerId、workspace、stateDir、maxWork、instanceId、execPath、scriptArgs、env、spawnProcess、buildChildCommand）、`ActiveWork`（当前作业状态：assignment、identity、phase、pid、start_token、pending_event 等）、`ActivePhase`（accepted、spawning、prompt_sending、prompt_sent、running） |
| **输入输出** | 输入：作业分配（`WorkAssignment`）；输出：完成的 `WorkRecord`；子进程 stdin：JSON prompt；子进程 stdout：NDJSON 事件流（sdk/process/log/error）；子进程 stderr：记录到 worker.log |
| **状态机** | Worker 内部阶段：`accepted`（刚拿到作业）→ `spawning`（启动子进程）→ `prompt_sending`（发送 prompt 到 stdin）→ `prompt_sent`（prompt 已写入）→ `running`（执行中）；阶段状态持久化到 `active-work-{leaseId}.json`，崩溃后可读取恢复决策；delivery_unknown 标志：在 prompt_sending 阶段崩溃 → DELIVERY_UNKNOWN，需显式重试；其他阶段 → RUNNER_RESTARTED，可自动重试 |
| **注册/拉取/心跳/执行/恢复流程** | **注册**：`initialize()` → 搜索 stateDir 中 active-work-*.json → 为每个恢复作业（`recoverActiveWork()`）；`register()` → `client.register()` → 保存 instance.json；**拉取**：`runOnce()` → `client.poll()` → 并发执行多个作业（maxWork）；**心跳**：`execute()` 中 `setInterval()` 定期调用 `client.heartbeat()`，失败≥3次终止子进程；**执行**：`execute()` → 创建 `ActiveWork` → 写入磁盘 → `acknowledge()` → 启动子进程 → 发送 prompt（记录 pending_event）→ 事件转发 → `complete()` → 清除 active-work；**恢复**：`recoverActiveWork()` → 读取 active-work → 验证进程（pid + start_token），存活则终止 → 发送 pending_event（如果有）→ 根据阶段决定 retryable → `complete(failed)` |
| **错误与安全** | 环境白名单（`workerEnvironment()`）：仅允许明确列出的变量（PATH、HOME、USER、LOGNAME、SHELL、LANG、TMPDIR、TEMP、TMP、ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN、ANTHROPIC_BASE_URL、CLAUDE_CODE_OAUTH_TOKEN、CLAUDE_CONFIG_DIR、NODE_ENV、LC_*、AWS_*、GOOGLE_*、CLOUD_ML_*）；黑名单移除：OPEN_RUNNER_*、SSH_*、WORKER_TOKEN、ADMIN_TOKEN、CLAUDE_CODE_SESSION_ACCESS_TOKEN、CLAUDE_CODE_WORKER_EPOCH；日志脱敏（`redact()`）：替换 Bearer/sk-ant-/sk- 前缀的值为 [REDACTED]；进程身份验证：使用 `getProcessStartToken()` + `probeProcessIdentity()` 验证 PID 对应同一进程（防止 PID 重用攻击） |
| **设计取舍/备选** | 选择阶段状态持久化而非仅内存，崩溃后可恢复；选择显式 DELIVERY_UNKNOWN 标记而非总是重试或从不重试，调用方决定安全性；选择环境白名单而非黑名单，安全优先；备选：仅内存状态（放弃）、自动重试所有失败（放弃）、环境黑名单（放弃） |
| **源码测试证据** | `src/open-runner/worker.ts`：`workerEnvironment()` L59-89、`initialize()` L173-183、`recoverActiveWork()` L185-243、`execute()` L315-496、`sendEvent()` L306-313、`redact()` L92-94；测试：`tests/openRunnerWorker.test.ts` |

#### 4.2.5 事件 JSONL 模块

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `async appendEvents(workId: string, value: unknown): Promise<{accepted: {event_id: string, seq: number}[], last_seq: number}>; async readEvents(workId: string, after?: number, limit?: number): Promise<{work_id: string, events: WorkEvent[], last_seq: number, has_more: boolean}>` |
| **关键类型** | `WorkEventInput`（event_id、kind、occurred_at、message）、`WorkEvent`（seq 字段追加）；kind: "sdk" \| "process" \| "log" \| "error"；MAX_EVENT_BYTES = 4MB，MAX_EVENT_BATCH_BYTES = 8MB |
| **输入输出** | 输入：事件数组（带 client 生成的 event_id）；输出：accepted 数组（分配的 seq），重复 event_id 返回已有的 seq 不重复写入；文件路径：`{stateDir}/events/{workId}.jsonl` |
| **状态机** | 无状态，仅追加；seq 单调递增从 1 开始；last_seq 保存在 state.json 中，崩溃后可从 JSONL 重新计算并恢复（append 可在 state 写入前存活，保留且编号安全） |
| **去重流程** | 每个事件必须带唯一 UUID event_id；Store 维护 `eventIds: Map<workId, Map<eventId, {seq, hash}>>`；同 event_id 同 hash → 返回已有 seq；同 event_id 不同 hash → `EVENT_ID_CONFLICT` 错误；同 batch 内重复 event_id 同上处理；event_id 由 client 生成（通常是消息 UUID），`eventIdForMessage()` 辅助函数从 message 中提取 uuid 或生成新的 |
| **错误与安全** | 事件 message 大小限制 4MB，batch 8MB；event_id 冲突检查防止重复或篡改；JSONL 格式：每行一个完整 JSON，最后一行是空行（便于截断恢复）；崩溃恢复：加载时检查最后一行是否完整（以 \n 结尾），不完整则截断 |
| **设计取舍/备选** | 选择 JSONL 而非 SQLite，追加原子，无需数据库依赖；选择 client 生成 event_id 而非 server 分配，支持客户端重试幂等；选择内存 eventIds 索引而非每次扫描，加快去重；备选：SQLite（放弃）、server 分配 ID（放弃）、无索引（放弃） |
| **源码测试证据** | `src/open-runner/store.ts`：`appendEvents()` L933-1038、`readEvents()` L1041-1066、`load()`（事件加载）L283-330、`validateStoredEvent()` L431-456；`src/open-runner/protocol.ts`：`eventIdForMessage()` L310-313；测试：`tests/openRunnerProtocol.test.ts` |

#### 4.2.6 Upstream Proxy 模块

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `async initUpstreamProxy(opts?: {tokenPath?: string, systemCaPath?: string, caBundlePath?: string, ccrBaseUrl?: string}): Promise<{enabled: boolean, port?: number, caBundlePath?: string}>; function getUpstreamProxyEnv(): Record<string, string>` |
| **关键类型** | `SESSION_TOKEN_PATH = "/run/ccr/session_token"`；`UpstreamProxyState`（enabled、port、caBundlePath）；NO_PROXY_LIST（localhost、127.0.0.1、::1、169.254.0.0/16、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、anthropic.com、github.com、npm/pypi/crates/go 注册表） |
| **输入输出** | 输入：无（从环境变量读取配置）；输出：环境变量字典（HTTPS_PROXY、NO_PROXY、SSL_CERT_FILE 等）；中继输入：localhost TCP CONNECT；中继输出：WebSocket 隧道到 CCR 服务器 |
| **初始化流程** | 仅在 `CLAUDE_CODE_REMOTE` 和 `CCR_UPSTREAM_PROXY_ENABLED` 为 true 时启用；步骤：1. 读取 session_token 文件；2. `setNonDumpable()`（Linux+Bun 时 prctl(PR_SET_DUMPABLE, 0) 阻止 ptrace 读取堆）；3. 下载并拼接 CA 证书（系统 + CCR MITM CA）；4. 启动 CONNECT-over-WebSocket 中继；5. **unlink token 文件**（确认中继监听后才删除， supervisor 重启可重试）；6. 设置环境变量供子进程使用 |
| **中继协议** | LOCAL：TCP 接受 HTTP CONNECT，返回 200 Connection Established，然后双向隧道；REMOTE：WebSocket 到 `/v1/code/upstreamproxy/ws`，BinaryType=arraybuffer，Content-Type=application/proto；PROTO：UpstreamProxyChunk  protobuf 手动编码（tag 0x0a + varint length + bytes）；WebSocket 上双认证：Upgrade 请求头带 Bearer <token>（会话 JWT），隧道内 CONNECT 带 Proxy-Authorization: Basic <sessionId:token>（用于上游服务认证）；PING：每 30 秒发送空 chunk 保持连接 |
| **错误与安全** | 令牌仅内存保留，文件 unlink 后无法恢复；prctl(PR_SET_DUMPABLE, 0) 阻止同一 UID 的 ptrace 附加进程读取堆令牌；NO_PROXY 包含 Anthropic API（MITM 会破坏非 Bun 运行时）和 GitHub/npm/pypi/crates（CCR 已直接可达）；CA 证书拼接使 curl/gh/python/kubectl 信任 MITM 代理；所有失败打开（fail open）：任何错误记录警告并禁用代理，不破坏会话；中继仅绑定 127.0.0.1，无远程访问 |
| **设计取舍/备选** | 选择 CONNECT-over-WebSocket 而非 raw CONNECT，GKE L7  ingress 仅支持路径前缀路由，无 connect_matcher；选择手动 protobuf 编码而非 protobufjs 依赖，仅单字段消息；选择令牌文件 unlink 而非保留，安全优先（崩溃后需重新注入）；选择 fail open 而非 fail closed，代理不应破坏会话；备选：gRPC（放弃）、protobufjs（放弃）、保留令牌文件（放弃）、fail closed（放弃） |
| **源码测试证据** | `src/upstreamproxy/upstreamproxy.ts`：`initUpstreamProxy()` L79-153、`setNonDumpable()` L225-252、`getUpstreamProxyEnv()` L160-199、`downloadCaBundle()` L254-285；`src/upstreamproxy/relay.ts`：`startUpstreamProxyRelay()` L155-173、`encodeChunk()` L66-81、`decodeChunk()` L87-103、`handleData()` L295-342、`openTunnel()` L344-428；测试：未单独测试，集成在 CCR 会话中验证 |

### 4.3 作业状态机

| 状态 | 含义 | 允许转移 |
|------|------|----------|
| queued | 排队中 | leased |
| leased | 已分配 | running, queued (租期过期) |
| running | 执行中 | succeeded, failed, cancelled, retry_wait |
| retry_wait | 等待重试 | leased |
| succeeded | 成功（终态） | - |
| failed | 失败（终态） | - |
| cancelled | 取消（终态） | - |

### 4.4 Worker 阶段

| 阶段 | 含义 | 恢复策略 |
|------|------|----------|
| accepted | 已接受作业 | RUNNER_RESTARTED（可重试） |
| spawning | 正在启动子进程 | RUNNER_RESTARTED（可重试） |
| prompt_sending | 正在发送提示词 | DELIVERY_UNKNOWN（需显式重试） |
| prompt_sent | 提示词已发送 | RUNNER_RESTARTED（可重试） |
| running | 执行中 | RUNNER_RESTARTED（可重试） |

### 4.3 作业状态机

| 状态 | 含义 | 允许转移 |
|------|------|----------|
| queued | 排队中 | leased |
| leased | 已分配 | running, queued (租期过期) |
| running | 执行中 | succeeded, failed, cancelled, retry_wait |
| retry_wait | 等待重试 | leased |
| succeeded | 成功（终态） | - |
| failed | 失败（终态） | - |
| cancelled | 取消（终态） | - |

### 4.4 Worker 阶段

| 阶段 | 含义 | 恢复策略 |
|------|------|----------|
| accepted | 已接受作业 | RUNNER_RESTARTED（可重试） |
| spawning | 正在启动子进程 | RUNNER_RESTARTED（可重试） |
| prompt_sending | 正在发送提示词 | DELIVERY_UNKNOWN（需显式重试） |
| prompt_sent | 提示词已发送 | RUNNER_RESTARTED（可重试） |
| running | 执行中 | RUNNER_RESTARTED（可重试） |

### 4.5 数据流

#### 4.5.1 作业提交流程

```
Admin Client → POST /work
                ↓
            Server 验证（认证、幂等键）
                ↓
            Store 串行化插入 → queued
                ↓
            返回 work_id
```

#### 4.5.2 作业拉取流程

```
Worker → POST /worker/register（获取 worker_epoch）
          ↓
        POST /work/lease（拉取作业）
          ↓
        Server → Store 原子更新：queued → leased，设置租期
          ↓
        返回作业
```

#### 4.5.3 心跳流程

```
Worker → POST /work/:work_id/heartbeat（定期）
          ↓
        Server → Store 更新租期
```

#### 4.5.4 事件追加流程

```
Worker → POST /work/:work_id/events（批量）
          ↓
        Server → Store event_id 去重，原子追加 JSONL
          ↓
        返回分配的 seq
```

## 5. 失败语义与工程取舍

### 5.1 失败语义

| 失败场景 | 处理方式 | 系统行为 |
|---------|---------|---------|
| 租期过期 | Store.expire() 自动释放 | 作业回到 queued，其他 Worker 可拉取 |
| Worker epoch 过期 | 新实例注册使旧 epoch 失效 | 旧实例请求被拒绝，退出 |
| 提示词交付不确定 | Worker 在 prompt_sending 阶段崩溃 | 标记为 DELIVERY_UNKNOWN，需显式重试 |
| 事件重复提交 | event_id 去重 | 返回已分配 seq，不重复追加 |
| 进程身份验证失败 | PID + start_token 不匹配 | 拒绝操作 |
| 路径遍历尝试 | 路径验证失败 | 拒绝访问 |
| 环境变量黑名单 | OPEN_RUNNER_*、SSH_* 等被移除 | 子进程看不到敏感变量 |
| prctl 失败 | 忽略（非 Linux 或非 Bun） | 继续执行，但内存防护降级 |

### 5.2 工程取舍

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| 并发模型 | 串行化操作 | 吞吐量受限 | 无竞态，易推理 |
| 绑定地址 | 仅 localhost | 不能远程访问 | 安全，无需 TLS |
| 事件存储 | JSONL | 查询需要扫描 | 追加原子，崩溃可恢复 |
| 环境变量 | 白名单 + 黑名单 | 需要显式添加 | 安全默认 |
| 租期 | 心跳刷新 | 额外流量 | 自动恢复 |
| 交付不确定 | 显式标记 | 调用方决策 | 无意外重复 |
| 令牌存储 | 仅内存 + prctl | 崩溃后需重注 | 安全优先 |
| Store | 单进程文件 | 不支持分布式 | 简单部署 |

## 6. 现状验收标准

### 6.1 功能验收标准

- **Server**：
  - 可以启动，绑定 localhost
  - 双令牌认证（Worker/Admin）
  - 所有 API 端点工作

- **作业管理**：
  - 作业提交与幂等性验证（idempotency_key）
  - 作业查询（单个、列表）
  - 作业取消
  - 作业完成（succeeded/failed）

- **Worker 管理**：
  - Worker 注册与 epoch 递增
  - 作业拉取与租期分配
  - 心跳与租期刷新
  - Worker epoch 过期时拒绝旧实例

- **事件系统**：
  - 事件追加与去重（event_id）
  - 事件查询与分页
  - 事件流（WebSocket 或 SSE）

- **Store**：
  - 状态机正确转移
  - 租期过期自动回收
  - 串行化操作无竞态
  - JSONL 持久化原子追加
  - 崩溃后可恢复（截断最后不完整行）

- **Worker**：
  - 作业拉取、执行、报告
  - 崩溃恢复逻辑正确
  - Worker 阶段与恢复策略匹配
  - 子进程环境变量白名单/黑名单正确应用

- **安全**：
  - 路径验证防止遍历
  - 进程身份验证（PID + start_token）
  - 环境变量清理
  - 双令牌认证

- **Upstream Proxy**：
  - Upstream Proxy 初始化
  - Relay CONNECT-over-WS
  - prctl(PR_SET_DUMPABLE, 0)（Linux+Bun）
  - 令牌文件 unlink 后仅内存保留

### 6.2 测试验收标准

- Protocol 测试覆盖完整生命周期
- Worker 测试覆盖崩溃恢复
- Backends 测试覆盖 Chrome/Computer Use

## 7. 代码与测试证据

### 7.1 核心实现文件

- **Protocol**：`src/open-runner/protocol.ts` - 类型、验证、错误码
- **Server**：`src/open-runner/server.ts` - HTTP API、路由
- **Store**：`src/open-runner/store.ts` - 持久化、状态机
- **Worker**：`src/open-runner/worker.ts` - 作业执行、恢复
- **Client**：`src/open-runner/client.ts` - 客户端封装
- **Main**：`src/open-runner/main.ts` - CLI 入口
- **Environment Runner**：`src/environment-runner/main.ts`
- **Self-hosted Runner**：`src/self-hosted-runner/main.ts`
- **Upstream Proxy**：
  - `src/upstreamproxy/upstreamproxy.ts` - 代理初始化
  - `src/upstreamproxy/relay.ts` - CONNECT-over-WS
- **MoreRight**：`src/moreright/useMoreRight.tsx`
- **Open Backends**：
  - `src/external-stubs/claude-for-chrome-mcp.ts`
  - `src/external-stubs/computer-use-mcp.ts`
- **支持文件**：
  - `src/jobs/state.ts`（进程 start_token）
  - `src/utils/envUtils.ts`
  - `src/utils/debug.ts`
  - `src/utils/cleanupRegistry.ts`

### 7.2 测试文件

- **Protocol**：`tests/openRunnerProtocol.test.ts`
- **Worker**：`tests/openRunnerWorker.test.ts`
- **Backends**：`tests/openBackends.test.ts`

### 7.3 关键实现证据

#### 租期机制

代码位置：`src/open-runner/store.ts`
```typescript
private expire(work: StoredWork): boolean {
  if (work.state !== 'leased' && work.state !== 'running') return false;
  const deadline = this.leaseDeadlines.get(work.work_id);
  const expired = deadline !== undefined
    ? this.monotonicNow() >= deadline
    : !work.lease_expires_at || this.now() >= Date.parse(work.lease_expires_at);
  if (!expired) return false;
  // ... 释放租期，转移状态
}
```

#### 事件幂等性

代码位置：`src/open-runner/store.ts`
```typescript
const existing = this.eventIds.get(workId)!;
if (existing.has(event.event_id)) {
  const stored = existing.get(event.event_id)!;
  if (stored.hash !== contentHash(event)) {
    throw new OpenRunnerError('EVENT_ID_CONFLICT', ...);
  }
  accepted.push({ event_id: event.event_id, seq: stored.seq });
  continue;
}
```

#### 环境隔离

代码位置：`src/open-runner/worker.ts`
```typescript
const exact = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', ...
]);
for (const key of Object.keys(result)) {
  if (key.startsWith('OPEN_RUNNER_') || key.startsWith('SSH_') || ...) {
    delete result[key];
  }
}
```

#### Upstream Proxy prctl

代码位置：`src/upstreamproxy/upstreamproxy.ts`
```typescript
function setNonDumpable(): void {
  if (process.platform !== 'linux' || typeof Bun === 'undefined') return;
  try {
    const ffi = require('bun:ffi');
    const lib = ffi.dlopen('libc.so.6', {
      prctl: { args: ['int', 'u64', 'u64', 'u64', 'u64'], returns: 'int' }
    });
    lib.symbols.prctl(4, 0n, 0n, 0n, 0n);
  } catch {}
}
```

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/open-runner.yaml)

### 8.1 相关子系统

- **Commands Framework**：可能通过命令触发 Open Runner 作业
- **Session System**：会话可能作为作业输入/输出
- **Git Integration**：作业可能在 Git 上下文中执行
- **Settings System**：Runner 配置
- **MCP System**：Open Backends 可能使用 MCP

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
| --- | --- | --- | --- | --- | --- | --- |
| P2 | MoreRight 当前笔记是进程本地的，重启后丢失 | 将笔记存储到配置目录，支持持久化和跨会话访问 | 低：不影响核心 Open Runner 功能 | 测试笔记持久化存储和跨会话读取 | S | 已证实（基于代码阅读） |
| P2 | 如果未来更改状态格式，无迁移路径，用户数据可能丢失 | 提供状态迁移工具，支持平滑升级 | 低：可实现为可选的升级时运行 | 测试状态从旧格式迁移到新格式，数据完整性 | S | 设计推断 |
| P2 | 当前错误码区分不够细，调试和自动化困难 | 丰富错误码，区分更多失败原因（网络、认证、权限、资源不足等） | 低：向后兼容，仅增加新错误码 | 测试各种错误场景返回正确错误码 | M | 设计推断 |
| P2 | 当前 Server 仅绑定 localhost，如需远程部署无 TLS 支持 | 添加 TLS 支持，可配置证书和密钥 | 中：需确保 localhost 模式仍正常工作 | 测试 TLS 模式和非 TLS 模式都正常工作 | M | 设计推断 |
| P3 | 当前无监控指标，运维困难 | 暴露 Prometheus 指标（作业数量、延迟、队列长度、Worker 状态等） | 低：可实现为可选功能，默认关闭 | 测试指标暴露和正确更新 | M | 设计推断 |
| P3 | 当前队列是 FIFO，不支持优先级 | 支持作业优先级（urgent、normal、low），按优先级调度 | 中：需确保现有功能不受影响 | 测试不同优先级作业的调度顺序 | M | 设计推断 |
| P3 | 当前无多租户限流，可能被滥用 | 按租户限流和配额，支持配置 | 中：需确保单租户场景不受影响 | 测试多租户限流生效 | L | 设计推断 |
| P3 | 当前事件通过轮询获取，延迟较高 | 实现 WebSocket 事件流，实时推送事件 | 中：需保持轮询作为 fallback | 测试 WebSocket 事件流和轮询 fallback | L | 设计推断 |
| P3 | 当前 Store 是单进程文件存储，不支持高可用 | 支持分布式 Store（PostgreSQL 或 Raft 或类似） | 高：涉及核心状态管理重构 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 当前只有 CLI 管理，不够直观 | 提供作业管理、监控、调试的 Web 界面 | 低：可选功能，不影响核心功能 | 设计阶段探索技术方案 | L | 设计推断 |
| P3 | 当前 Open Backends 生态有限 | 扩展 Open Backends 生态（更多浏览器、更多云服务） | 低：向后兼容，仅增加新后端 | 设计阶段探索生态扩展路径 | L | 设计推断 |
| P3 | 当前作业独立执行，不支持依赖 | 支持作业间依赖，DAG 编排 | 高：涉及调度核心逻辑重构 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 当前仅支持单 Server 实例，无法水平伸缩 | 支持多个 Server 实例协调，共享状态 | 高：涉及分布式系统复杂性 | 设计阶段探索技术方案 | L | 设计推断 |
