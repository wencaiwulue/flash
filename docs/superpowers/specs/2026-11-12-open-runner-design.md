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

### 4.2 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| Protocol | `src/open-runner/protocol.ts` | 类型定义、验证、错误码 |
| Server | `src/open-runner/server.ts` | HTTP API、认证、路由 |
| Store | `src/open-runner/store.ts` | 持久化、状态机、并发控制 |
| Worker | `src/open-runner/worker.ts` | 作业拉取、子进程、恢复 |
| Client | `src/open-runner/client.ts` | 客户端封装、重试 |
| Main | `src/open-runner/main.ts` | CLI 入口 |
| Environment Runner | `src/environment-runner/main.ts` | 环境 Runner 入口 |
| Self-hosted Runner | `src/self-hosted-runner/main.ts` | 自托管 Runner 入口 |
| Upstream Proxy | `src/upstreamproxy/upstreamproxy.ts` | CCR 上游代理初始化 |
| Relay | `src/upstreamproxy/relay.ts` | CONNECT-over-WS 中继 |
| MoreRight | `src/moreright/useMoreRight.tsx` | 本地笔记 UI |

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

### 9.1 短期改进

1. **MoreRight 持久化**：当前笔记是进程本地的，可以存储到配置目录
2. **状态迁移工具**：如果未来更改状态格式，提供迁移路径
3. **更丰富的错误码**：区分更多失败原因，便于调试和自动化

### 9.2 中期改进

4. **TLS 支持**：如果需要远程部署 Server，添加 TLS
5. **Metrics**：暴露 Prometheus 指标（作业数量、延迟、队列长度等）
6. **优先级队列**：支持作业优先级（urgent、normal、low）
7. **多租户限流**：按租户限流和配额
8. **WebSocket 事件流**：实时推送事件而非轮询

### 9.3 长期改进

9. **分布式 Store**：支持高可用（PostgreSQL 或 Raft 或类似）
10. **Web UI**：提供作业管理、监控、调试的 Web 界面
11. **更多 Backends**：扩展 Open Backends 生态（更多浏览器、更多云服务）
12. **作业依赖图**：支持作业间依赖，DAG 编排
13. **水平伸缩**：支持多个 Server 实例协调
