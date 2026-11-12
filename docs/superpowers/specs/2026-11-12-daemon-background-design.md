---
id: daemon-background
batch: 6
title: Daemon & Background 守护进程与后台会话设计
date: 2026-11-12
status: draft
---

## 1. 概述

Daemon 与后台会话系统提供两类互补的长期运行能力：
- 守护进程模式：通过 supervisor 自动重启的独立 worker，支持远程控制会话
- 后台会话模式：基于 tmux 的可分离、可恢复的 CLI 会话，支持日志查看和重新附着

这两个子系统共享 UDS（Unix Domain Socket）消息传递基础设施，但在进程生命周期管理、恢复策略和用户交互模型上有明确区别。

## 2. 架构与组件

### 2.1 守护进程架构

守护进程采用三层进程树结构：

```
CLI (start/stop/status)
  └─ Daemon Supervisor (detached, pid-recorded)
      └─ Worker Process (restarted on failure)
```

**核心组件：**
- `main.ts`：提供 daemon 子命令，管理 pid 记录在 `$CLAUDE_CONFIG/daemon/{kind}.json`
- `supervisor.ts`：实现带指数退避的重启策略，默认最大重启 5 次
- `workerRegistry.ts`：定义 worker 类型（当前仅 `assistant`/`remote-control`）

### 2.2 后台会话架构

后台会话基于 tmux 实现进程隔离与输出捕获：

```
CLI (launch/attach/logs/kill/ps)
  └─ tmux server (per-session socket)
      └─ tmux session (pane pipe to log)
          └─ Claude CLI (background mode, UDS-enabled)
```

**核心组件：**
- `bg.ts`：后台会话生命周期管理与命令处理
- `concurrentSessions.ts`：会话注册表与墓碑机制
- `tmuxSocket.ts`：tmux 抽象与安全验证
- `processIdentity.ts`：PID+启动令牌的进程身份验证

### 2.3 UDS 消息传递

UDS 提供跨会话发现与消息传递：

```
Session Registry ($CLAUDE_CONFIG/uds/{session-id}.json)
  ├─ socket path, session id, pid, kind
  └─ atomic write with 0o600 permissions

Messaging:
  ├─ ping/pong for liveness and session identification
  └─ prompt delivery with JSON framing
```

**核心组件：**
- `udsRegistry.ts`：会话注册与发现
- `udsMessaging.ts`：UDS 服务器实现
- `udsClient.ts`：客户端 ping、列表、消息发送

## 3. 守护进程生命周期

### 3.1 启动流程

1. **状态检查**：读取 `$CLAUDE_CONFIG/daemon/{kind}.json`，验证 PID 存活
2. **避免竞态**：检测到已存在且活跃的 daemon 直接返回现有记录
3. **分离启动**：`spawn(..., { detached: true, stdio: 'ignore' })` 并 `unref()`
4. **原子记录**：mkdir -m 0o700 → write temp → rename 保证原子性，文件权限 0o600
5. **清理回滚**：记录写入失败时 kill 已启动的 supervisor

### 3.2 Supervisor 运行循环

1. **Spawn Worker**：启动指定类型的 worker 进程
2. **等待退出**：监听 `error` 和 `exit` 事件
3. **退出判断**：
   - 主动停止：`stopping=true`，返回退出码
   - 成功退出：code=0，正常返回
   - 失败重启：code≠0 且 `restarts<maxRestarts`
4. **指数退避**：`delay=min(maxDelay, base*2^restarts)`，默认 base=1s, max=30s
5. **超过限制**：连续失败超过 `maxRestarts`（默认 5）后抛出错误

### 3.3 Worker 进程

Worker 当前为 `remote-control` 模式：
- 启动远程控制服务器
- 创建或复用 query 会话
- 禁用远程控制时清理并返回 query
- 支持 `waitForRemoteControlServer()` 等待关闭

## 4. 后台会话生命周期

### 4.1 启动与注册

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

### 4.2 附着与分离

附着流程：
1. **会话查找**：通过 sessionId 查找注册表或墓碑
2. **授权验证**：执行完整的 `authorizeSession()` 检查
3. **tmux attach**：调用 `tmux -L {socket} attach-session -t {session}`
4. **重试逻辑**：最多 3 次，指数退避

分离是标准 tmux 行为（`C-b d`），会话继续后台运行。

### 4.3 日志查看

日志特性：
- 保留最后 200 行或 1 MiB，取较晚者
- 截断时输出警告
- 保持日志文件权限 0o600 不变
- 验证日志路径在预期目录内

### 4.4 终止流程

1. **查找与授权**：同附着流程
2. **SIGTERM**：发送优雅终止信号
3. **等待退出**：默认 5 秒超时，可配置
4. **身份重验证**：每次检查都重新验证进程令牌，防止 PID 复用
5. **SIGKILL 升级**：超时后发送强制终止
6. **清理 tmux**：`kill-session` 销毁 tmux 会话
7. **写入墓碑**：在 `$CLAUDE_CONFIG/session-tombstones/` 保存退出记录
8. **删除注册表**：移除活跃会话记录

### 4.5 会话列表 (`ps`)

列表输出包含：
- `session_id`、`pid`、`kind`
- `state`（idle/busy/unknown）
- `cwd`、`started_at`、`updated_at`
- `attached_clients`（tmux 附着数）
- `tmux_socket`、`tmux_session`、`log_path`（仅后台会话）

清理：列表时自动将已停止的后台会话移入墓碑。

## 5. UDS 协议与消息安全

### 5.1 协议帧格式

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

### 5.2 安全模型

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

### 5.3 服务器生命周期

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

## 6. 关闭恢复与持久化

### 6.1 守护进程恢复

守护进程不支持跨重启恢复，但提供：
- 状态查询：`daemon status` 返回当前运行状态和 pid
- 检测陈旧：读取 pid 记录后验证进程存活，不存活则删除记录
- 幂等启动：重复 `daemon start` 返回已有记录而不启动新实例

### 6.2 后台会话恢复

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

## 7. 设计决策

### 决策 1：tmux 作为后台会话容器而非直接 daemonize

| 维度 | 说明 |
|------|------|
| **决策** | 使用 tmux 实现后台会话分离与输出捕获 |
| **备选** | 直接 double-fork + nohup，或使用 PM2 等进程管理器 |
| **代价** | 依赖 tmux 可用，Windows 需 WSL 包装，增加复杂性 |
| **证据** | `src/cli/bg.ts:333-335` 检查 tmux 可用，`tests/backgroundSessions.test.ts:156-205` 验证发现/附着/日志/终止 |
| **理由** | tmux 提供免费的：终端输出缓冲、可重新附着、进程组管理、窗口大小处理 |

### 决策 2：多层身份验证而非仅 PID

| 维度 | 说明 |
|------|------|
| **决策** | PID+启动令牌 + tmux socket/pane + 日志路径 + UDS socket 的链式验证 |
| **备选** | 仅依赖 PID，或仅依赖会话目录 |
| **代价** | 代码复杂，授权路径长，Windows 不可用 |
| **证据** | `src/cli/bg.ts:175-227` `authorizeSession()`，`tests/backgroundSessions.test.ts:129-130,191-214` |
| **理由** | PID 复用是现实风险，尤其在长期运行系统上；fail-closed 安全模型要求多因素验证 |

### 决策 3：原子文件操作 + 严格权限

| 维度 | 说明 |
|------|------|
| **决策** | 所有注册表/墓碑/日志使用 mkdir -m 0o700 + temp-write + rename 原子更新，权限 0o600 |
| **备选** | 直接写入，放宽权限，或使用数据库 |
| **代价** | 代码冗长，需要小心处理每个写入点 |
| **证据** | `src/daemon/main.ts:65-71`、`src/utils/udsRegistry.ts:26-31`、`src/cli/bg.ts:373-376,463` |
| **理由** | 防止竞态、部分写入、其他用户读取敏感信息；0o700/0o600 是类 Unix 系统标准安全实践 |

### 决策 4：Supervisor 指数退避重启策略

| 维度 | 说明 |
|------|------|
| **决策** | 失败重启延迟 = min(maxDelay, baseDelay * 2^restarts)，默认 base=1s, max=30s, maxRestarts=5 |
| **备选** | 固定间隔、立即重启、或不重启 |
| **代价** | 暂时故障时服务不可用时间延长 |
| **证据** | `src/daemon/supervisor.ts:63-67`、`tests/daemon.test.ts:91-114` |
| **理由** | 指数退避防止系统过载，同时保证最终恢复；上限防止等待过长；最大重启次数避免永久故障循环 |

### 决策 5：UDS 作为消息通道而非仅信号

| 维度 | 说明 |
|------|------|
| **决策** | 使用 UDS 进行 ping 发现、会话识别、跨会话提示传递 |
| **备选** | 仅用信号，或使用 TCP localhost，或不提供跨会话通信 |
| **代价** | Socket 路径长度限制，Windows 命名管道差异，需要额外清理逻辑 |
| **证据** | `src/utils/udsMessaging.ts:42-66`、`src/utils/udsClient.ts:58-129`、`tests/udsMessaging.test.ts:42-73` |
| **理由** | UDS 提供可靠的、带身份的消息传递；ping/pong 实现可靠发现；行 JSON 协议简单可扩展 |

### 决策 6：墓碑机制而非立即删除

| 维度 | 说明 |
|------|------|
| **决策** | 后台会话终止后移入墓碑保留退出信息，拒绝同 ID 重用（除非 --resume） |
| **备选** | 立即删除注册表记录，或允许自由重用 ID |
| **代价** | 占用少量磁盘空间，需要额外清理逻辑 |
| **证据** | `src/cli/bg.ts:99-109,282-286,651-665`、`tests/backgroundSessions.test.ts:221-224` |
| **理由** | 用户可能想查看已退出会话的退出原因或日志；防止会话 ID 意外重用导致混淆 |

## 8. 覆盖范围

完整实现覆盖清单见 [Coverage](../../architecture/coverage/daemon-background.yaml)。

## 9. 开放问题与未来工作

1. **Windows 后台会话**：当前 WSL 包装可用性有限，需原生 Windows 方案
2. **守护进程日志**：当前 supervisor/worker 无持久化日志，调试困难
3. **墓碑清理**：无自动墓碑过期机制，长期可能累积
4. **会话 resume**：`--resume` 标志已预留但未实现
5. **远程后台会话**：当前后台会话仅限本地，未来可与 teleport 集成
