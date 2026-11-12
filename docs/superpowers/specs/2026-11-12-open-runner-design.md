---
id: open-runner
title: Open Runner 环境执行与 Worker 协议设计
date: 2026-11-12
status: draft
batch: 6
---

## 1. 问题与约束

### 问题

我们需要一个安全、可靠的系统来在远程或自托管环境中执行 Claude Code CLI。主要挑战包括：

1. **分布式作业分发**：如何安全地将作业分配给多个 Worker
2. **崩溃恢复**：Worker 崩溃时如何不丢失进度或重复执行
3. **环境隔离**：如何防止敏感凭据泄漏到子进程
4. **事件持久化**：如何确保执行过程中的事件可靠存储
5. **上游凭据注入**：在 CCR 环境中如何安全地向第三方服务注入凭据

### 约束

1. **向后兼容**：不替换 remote-control/daemon，而是互补
2. **可靠性优先**：宁可失败也不要无声丢失数据或重复执行
3. **安全默认**：权限最小化，默认隔离
4. **可观测性**：所有状态转换必须可追踪

## 2. 设计理由与备选方案

### 核心协议设计

#### 选项 A：长期租约 + 显式释放
- **优点**：简单
- **缺点**：Worker 崩溃会导致作业卡住
- **拒绝理由**：可靠性不足

#### 选项 B：租期 + 心跳（选择）
- **优点**：自动恢复，可配置超时
- **缺点**：需要心跳流量
- **选择理由**：在可靠性和开销之间最佳平衡
- **证据**：`src/open-runner/store.ts` expire() 方法

### 并发控制

#### 选项 A：细粒度锁
- **优点**：理论性能更好
- **缺点**：容易死锁
- **拒绝理由**：复杂性过高

#### 选项 B：串行化操作（选择）
- **优点**：无竞态，易推理
- **缺点**：吞吐量受限
- **选择理由**：作业调度不是瓶颈，可靠性更重要
- **证据**：`src/open-runner/store.ts` serialize() 方法

### Worker 隔离

#### 选项 A：仅 runner_id
- **优点**：简单
- **缺点**：多个实例同时运行会冲突
- **拒绝理由**：不安全

#### 选项 B：runner_id + instance_id + worker_epoch（选择）
- **优点**：精确隔离，新实例自动使旧实例失效
- **缺点**：需要持久化 instance_id
- **选择理由**：提供最强的安全保证
- **证据**：`src/open-runner/store.ts` register() 方法

### 事件持久化

#### 选项 A：SQLite
- **优点**：查询能力强
- **缺点**：增加依赖，部署复杂
- **拒绝理由**：过度设计

#### 选项 B：纯 JSON 数组
- **优点**：简单
- **缺点**：追加需要重写整个文件，崩溃时可能损坏
- **拒绝理由**：可靠性不足

#### 选项 C：JSONL + 原子重命名（选择）
- **优点**：追加原子，崩溃可恢复（截断最后一行）
- **缺点**：查询需要扫描
- **选择理由**：事件主要是追加和顺序回放
- **证据**：`src/open-runner/store.ts` appendEvents() + load()

### 环境变量策略

#### 选项 A：黑名单
- **优点**：向后兼容好
- **缺点**：容易遗漏新的敏感变量
- **拒绝理由**：不安全

#### 选项 B：白名单（选择）
- **优点**：默认拒绝，更安全
- **缺点**：需要显式添加
- **选择理由**：安全优先
- **证据**：`src/open-runner/worker.ts` workerEnvironment()

### 绑定地址

#### 选项 A：0.0.0.0 / ::
- **优点**：可远程访问
- **缺点**：需要 TLS + 更强认证
- **拒绝理由**：当前范围不需要

#### 选项 B：仅 localhost（选择）
- **优点**：网络隔离，无需 TLS
- **缺点**：不能远程访问
- **选择理由**：符合当前使用场景
- **证据**：`src/open-runner/server.ts` 第 182-184 行

### 提示词交付不确定性

#### 选项 A：总是重试
- **优点**：可用性高
- **缺点**：可能重复执行有副作用的任务
- **拒绝理由**：不安全

#### 选项 B：从不重试
- **优点**：无重复风险
- **缺点**：可用性低
- **拒绝理由**：用户体验差

#### 选项 C：显式标记不确定性（选择）
- **优点**：让调用方决定
- **缺点**：增加复杂性
- **选择理由**：安全且灵活
- **证据**：`src/open-runner/worker.ts` recoverActiveWork()

### Upstream Proxy 令牌处理

#### 选项 A：保留令牌文件
- **优点**：崩溃后可恢复
- **缺点**：prompt 注入可读取
- **拒绝理由**：不安全

#### 选项 B：仅保留在内存 + prctl（选择）
- **优点**：防止 ptrace 读取堆，防止文件读取
- **缺点**：崩溃后需重新注入
- **选择理由**：安全优先
- **证据**：`src/upstreamproxy/upstreamproxy.ts` 第 140-144 行

## 3. 目标与非目标

### 目标

1. **可靠的作业分发**：Worker 可以拉取作业，租期到期自动转移
2. **崩溃恢复**：Worker 重启后可以恢复或报告失败
3. **事件持久化**：所有 SDK 事件可靠存储，可回放
4. **安全隔离**：防止敏感凭据泄漏，路径遍历防护
5. **幂等性**：重复操作不会导致重复效果
6. **可观测性**：作业状态和事件可查询

### 非目标

1. **不替换 remote-control/daemon**：互补，不重叠
2. **不支持分布式 Store**：当前是单进程文件存储
3. **不支持优先级队列**：当前是 FIFO
4. **不支持多租户限流**：仅占位 CAPACITY_EXCEEDED
5. **不支持 TLS**：当前仅绑定 localhost
6. **不暴露 Metrics**：当前无 Prometheus 等指标

## 4. 架构、模块与数据流

### 架构概览

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

### 模块职责

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

### 作业状态

| 状态 | 含义 | 允许转移 |
|------|------|----------|
| queued | 排队中 | leased |
| leased | 已分配 | running, queued (租期过期) |
| running | 执行中 | succeeded, failed, cancelled, retry_wait |
| retry_wait | 等待重试 | leased |
| succeeded | 成功（终态） | - |
| failed | 失败（终态） | - |
| cancelled | 取消（终态） | - |

### Worker 阶段

| 阶段 | 含义 | 恢复策略 |
|------|------|----------|
| accepted | 已接受作业 | RUNNER_RESTARTED（可重试） |
| spawning | 正在启动子进程 | RUNNER_RESTARTED（可重试） |
| prompt_sending | 正在发送提示词 | DELIVERY_UNKNOWN（需显式重试） |
| prompt_sent | 提示词已发送 | RUNNER_RESTARTED（可重试） |
| running | 执行中 | RUNNER_RESTARTED（可重试） |

## 5. 失败语义与工程取舍

### 失败语义

#### 租期过期
- **语义**：Worker 未在租期内刷新，作业回到队列
- **触发条件**：心跳超时，Worker 崩溃
- **恢复**：新 Worker 可以拉取重试
- **证据**：`src/open-runner/store.ts` expire()

#### Worker Epoch 过期
- **语义**：Runner 有新实例，旧实例请求被拒绝
- **触发条件**：同 runner_id + 新 instance_id 注册
- **恢复**：旧实例退出，新实例接管
- **证据**：`tests/openRunnerProtocol.test.ts`

#### 提示词交付不确定
- **语义**：Worker 在 prompt_sending 阶段崩溃
- **恢复**：标记为 DELIVERY_UNKNOWN，需显式重试
- **证据**：`src/open-runner/worker.ts` recoverActiveWork()

#### 事件重复提交
- **语义**：Worker 重试追加事件
- **恢复**：event_id 去重，返回已分配 seq
- **证据**：`tests/openRunnerProtocol.test.ts`

### 工程取舍

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| 并发模型 | 串行化操作 | 吞吐量受限 | 无竞态，易推理 |
| 绑定地址 | 仅 localhost | 无法远程访问 | 安全，无需 TLS |
| 事件存储 | JSONL | 查询需要扫描 | 追加原子，崩溃可恢复 |
| 环境变量 | 白名单 | 需要显式添加 | 安全默认 |
| 租期 | 心跳刷新 | 额外流量 | 自动恢复 |
| 交付不确定 | 显式标记 | 调用方决策 | 无意外重复 |

## 6. 现状验收标准

### 功能验收

- [x] Server 可以启动，绑定 localhost
- [x] 双令牌认证（Worker/Admin）
- [x] 作业提交与幂等性验证
- [x] Worker 注册与 epoch 递增
- [x] 作业拉取与租期分配
- [x] 心跳与租期刷新
- [x] 事件追加与去重
- [x] 作业完成与重试逻辑
- [x] 作业取消
- [x] 事件查询与分页
- [x] Worker 崩溃恢复
- [x] 进程身份验证（PID + start_token）
- [x] 环境变量白名单/黑名单
- [x] 路径验证（防止遍历）
- [x] Upstream Proxy 初始化
- [x] Relay CONNECT-over-WS
- [x] prctl(PR_SET_DUMPABLE, 0)
- [x] 令牌文件 unlink

### 测试验收

- [x] Protocol 测试覆盖完整生命周期
- [x] Worker 测试覆盖崩溃恢复
- [x] Backends 测试覆盖 Chrome/Computer Use

## 7. 代码与测试证据

### 租期机制证据

代码：`src/open-runner/store.ts`
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

测试：`tests/openRunnerProtocol.test.ts`

### 事件幂等性证据

代码：`src/open-runner/store.ts`
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

测试：`tests/openRunnerProtocol.test.ts`

### 环境隔离证据

代码：`src/open-runner/worker.ts`
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

测试：`tests/openRunnerWorker.test.ts`

### Upstream Proxy 证据

代码：`src/upstreamproxy/upstreamproxy.ts`
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

### 测试文件

| 测试 | 文件 |
|------|------|
| Protocol | tests/openRunnerProtocol.test.ts |
| Worker | tests/openRunnerWorker.test.ts |
| Backends | tests/openBackends.test.ts |

## 8. 文件覆盖与相关子系统

### 核心 Open Runner 文件

- src/open-runner/protocol.ts
- src/open-runner/server.ts
- src/open-runner/store.ts
- src/open-runner/worker.ts
- src/open-runner/client.ts
- src/open-runner/main.ts

### 入口点文件

- src/environment-runner/main.ts
- src/self-hosted-runner/main.ts

### Upstream Proxy 文件

- src/upstreamproxy/upstreamproxy.ts
- src/upstreamproxy/relay.ts

### MoreRight 文件

- src/moreright/useMoreRight.tsx

### Open Backends 文件

- src/external-stubs/claude-for-chrome-mcp.ts
- src/external-stubs/computer-use-mcp.ts

### 支持文件

- src/jobs/state.ts（进程 start_token）
- src/utils/envUtils.ts
- src/utils/debug.ts
- src/utils/cleanupRegistry.ts

### 测试文件

- tests/openRunnerProtocol.test.ts
- tests/openRunnerWorker.test.ts
- tests/openBackends.test.ts

## 9. 改进建议

### 短期改进

1. **MoreRight 持久化**：当前笔记是进程本地的，可以存储到配置目录
2. **状态迁移工具**：如果未来更改状态格式，提供迁移路径

### 中期改进

3. **TLS 支持**：如果需要远程部署 Server，添加 TLS
4. **Metrics**：暴露 Prometheus 指标（作业数量、延迟等）
5. **优先级队列**：支持作业优先级
6. **多租户限流**：按租户限流

### 长期改进

7. **分布式 Store**：支持高可用（如 PostgreSQL 或 Raft）
8. **Web UI**：提供作业管理界面
9. **更多 Backends**：扩展 Open Backends 生态
