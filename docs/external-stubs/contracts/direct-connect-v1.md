# Direct Connect v1 契约

日期：2026-11-11
状态：前瞻设计，尚未实现；线协议名称为 `direct-connect-v1`。

当前 external build 保留了 Direct Connect client、URL 解析和 REPL hook，但 server、session manager、lockfile、headless 与 dangerous backend 均为占位。本契约以这些真实调用方为准，不把任何内部服务协议冒充为已兼容协议。

## 1. 公开命令与兼容边界

```text
claude server [--port <n>] [--host <addr>] [--auth-token <token>]
              [--unix <path>] [--workspace <dir>]
              [--idle-timeout <ms>] [--max-sessions <n>]
              [--allow-dangerous-skip-permissions]

claude cc://host:port[/base-path][?token=<token>] [原有参数...]
claude cc+unix:///absolute/socket[?token=<token>] [原有参数...]
claude cc://host:port -p [prompt] [--output-format text|json|stream-json]
```

`open <cc-url>` 仍是 `-p` 路径使用的内部命令，不作为新的公共别名宣传。server 的既有默认值为：port `0`、host `0.0.0.0`、idle timeout `600000`、max sessions `32`；`--idle-timeout 0` 永不超时，`--max-sessions 0` 不限制。未提供 token 时生成高熵 token，banner 仅在用户终端显示一次，日志和 lockfile 不保存 token。

`cc:` 按 `parseConnectUrl()` 转为无 query/hash/userinfo 的 HTTP base URL；`cc+unix:` 转为 Unix socket HTTP 地址。`token` 与 `auth_token` query 继续兼容，但 process list、shell history 和日志必须脱敏；新 client 还应支持 `CLAUDE_DIRECT_CONNECT_TOKEN`，URL query 仅作兼容 fallback。URL 中的 token 不进入 `serverUrl`、`ws_url` 或 transcript。

必须保持的现有 client 行为：

- `createDirectConnectSession()` 向 `${serverUrl}/sessions` POST JSON，使用 `Authorization: Bearer <token>`，并以 `connectResponseSchema` 校验 `session_id/ws_url/work_dir`。
- `DirectConnectSessionManager` 以带 Authorization 的 Bun WebSocket 连接，发送/接收文本 NDJSON，分发 SDK message 和 `can_use_tool`。
- REPL 的 `useDirectConnect` 继续通过 `convertSDKMessage()`、permission bridge 和 `isSessionEndMessage()` 工作。
- 新增响应字段必须可选，新增消息必须让旧 client 能安全忽略；不得改变既有 SDKUserMessage/SDKControlResponse 的嵌套形状。

## 2. 配置、认证与授权

server 必须始终要求 bearer token，包括 loopback 和 Unix socket；不允许以“本机可信”为由关闭认证。`GET /health` 可匿名返回最少版本信息，其余 HTTP 和 WS 都校验同一 token。token 比较使用常量时间，401 不透露是 token 缺失还是错误。Unix socket 及父目录权限分别为 `0600/0700`，TCP 非 loopback 部署需要由外层提供 TLS 和访问控制；v1 原生 `cc:` 只有 HTTP，不能宣称提供传输加密。

默认 ProcessBackend 使用当前用户的常规权限模式。请求里的 `dangerously_skip_permissions:true` 只有在 client 显式传 `--dangerously-skip-permissions` **且** server 显式带 `--allow-dangerous-skip-permissions` 时才允许；否则返回 403 `DANGEROUS_MODE_DISABLED`。该配置不得从 query、settings.env 或子进程输入开启。

workspace 规则：

- server 指定 `--workspace` 时，所有 session 固定在其 canonical path 下启动，client `cwd` 只是提示，响应 `work_dir` 返回真实 workspace；可配置子目录，但禁止 `..`/符号链接逃逸。
- 未指定 workspace 时，server 启动 cwd 是允许根；请求 cwd 必须存在于该根内，否则 `CWD_NOT_ALLOWED`。
- backend 只接受结构化配置并生成 argv，不能把 cwd、prompt 或额外参数拼进 shell。

## 3. HTTP API

所有错误响应使用：

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "human readable, no secrets",
    "retryable": false,
    "details": {}
  },
  "request_id": "uuid"
}
```

| 方法与路径 | 认证 | 语义 |
|---|---|---|
| `GET /health` | 否 | `{protocol:"direct-connect-v1",pid,server_version}`，用于 lockfile 交叉验证。 |
| `POST /sessions` | 是 | 新建或恢复 session，返回 WS 地址。 |
| `GET /sessions/{id}` | 是 | 返回状态、cwd、transcript ID、created/lastActive、last_seq；不返回进程环境。 |
| `DELETE /sessions/{id}` | 是 | 幂等停止子进程并保留可 resume 的索引；已 stopped 返回同一结果。 |
| `GET /sessions/{id}/ws?after=<seq>` | 是（Upgrade） | 进入 NDJSON WebSocket，`after` 缺省为 0。 |

### 创建/恢复请求

```json
{
  "cwd": "/client/cwd",
  "dangerously_skip_permissions": true,
  "session_id": "可选，存在即恢复",
  "client_request_id": "可选 UUID；新 client 必须发送"
}
```

不含 `session_id` 是创建；含之是恢复。`client_request_id` 的语义：

- 同 token、同 request ID、同规范化请求哈希 ⇒ 返回第一次的同一 session 和 `resumed` 结果，不重复 spawn；
- 同 request ID 不同哈希 ⇒ 409 `IDEMPOTENCY_CONFLICT`；
- 旧 client 不带 ID 仍兼容，但只提供 at-most-once-by-observation，网络重试可能创建多个 session；新 client 不得省略。

成功响应在现有三字段上增加可选字段：

```json
{
  "session_id": "uuid",
  "ws_url": "ws://127.0.0.1:12345/sessions/uuid/ws",
  "work_dir": "/canonical/workspace",
  "protocol": "direct-connect-v1",
  "state": "starting",
  "resumed": false,
  "last_seq": 0
}
```

恢复使用索引中的 `transcriptSessionId` 调 `--resume`，不能根据 client 提供的 cwd 新建另一段历史。session 不存在返回 404；索引损坏、transcript 不存在或属于其他 server 返回 409 `SESSION_NOT_RESUMABLE`。`ws_url` 不含 token。TCP 部署返回普通 `ws://host:port/sessions/<id>/ws`；Unix socket 部署固定返回 `ws://unix/sessions/<id>/ws`，client 根据既有 `serverUrl=http://unix<absolute-socket-path>` 选择 socket，HTTP 实际请求 `http://localhost/sessions`、WS 实际请求 `ws://localhost/sessions/<id>/ws`，二者均通过 Bun 的 `unix:<absolute-socket-path>` transport 选项连接。`ws_url` 只标识逻辑路由，不得被解释为公网主机或直接交给不支持 Unix socket 的 WebSocket 构造函数。

状态码约定：400 参数/schema、401 认证、403 授权、404 session、409 状态/幂等冲突、413 请求过大、429 `MAX_SESSIONS`、500 内部错误、503 正在 shutdown。429/503 和网络错误可在同一 request ID 下重试；其他 4xx 不重试。

## 4. WebSocket NDJSON 与 control

### 帧规则

1. 只接受文本帧。server 每帧包含一条或多条完整 NDJSON 记录，每条以 `\n` 结束；单条记录不得跨帧。旧 client 发送的单行 JSON 无尾换行必须接受。
2. 单条 client 消息最大 1 MiB，server 单条最大 4 MiB；超限关闭 1009，非法 JSON 关闭 1007，二进制关闭 1003。解析失败不得导致无限等待 control response。
3. server 给每条持久 SDK/control 事件附加单调递增 `seq`（从 1 开始），事件 append 到 `~/.claude/server-events/<session-id>.jsonl` 后才发送。`keep_alive` 和首条 ready 不占 seq。
4. client 记录连续已处理 seq；重复事件去重，乱序先缓冲，发现 gap 就重连并带 `after=<最后连续seq>`。server 先重放 `seq>after`，再切 live；重放和 live 交汇处同样按 seq 去重。
5. server 每 15 秒发送 `{"type":"keep_alive","timestamp":"RFC3339"}`；30 秒无帧可判网络异常，但不能仅因模型忙而 kill session。

连接首条为：

```json
{
  "type": "direct_connect",
  "subtype": "ready",
  "session_id": "uuid",
  "state": "running",
  "last_seq": 42,
  "replayed_from": 40
}
```

旧 client 可把未知 `direct_connect` 消息交给 adapter 后忽略；新 client 必须先处理 ready 再发输入。

### client → server

用户消息保持现有形状；server 在写入子进程前把空 `session_id` 替换成实际 session：

```json
{
  "type": "user",
  "message": {"role": "user", "content": "text 或 SDK content blocks"},
  "parent_tool_use_id": null,
  "session_id": ""
}
```

权限响应保持：

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "server-request-id",
    "response": {"behavior": "allow", "updatedInput": {}}
  }
}
```

deny 时内层为 `{behavior:"deny",message:"reason"}`；不支持请求的 error 为 `{subtype:"error",request_id,error:"..."}`。中断为：

```json
{
  "type": "control_request",
  "request_id": "uuid",
  "request": {"subtype": "interrupt"}
}
```

server 按 request ID 去重 control response/interrupt；同 ID 同内容重放安全，不同内容返回 `CONTROL_ID_CONFLICT`。未知 control subtype 必须收到 error response，不能悬挂。`control_cancel_request`、`control_response`、keepalive 和 streamlined 辅助消息不进入 REPL 的普通 SDK 展示路径。

### server → client

主要是子进程 `--output-format stream-json` 的 `SDKMessage`，以及 `control_request/can_use_tool`。`system/init` 每轮可以重复，REPL 仍只展示首次。普通 assistant/result/system 事件和权限 request 都带 seq；权限 request 在 detach 时保留于子进程，重连后必须重放。server 重启导致原 pending request 失效时，写入一条带新 seq 的 `direct_connect.control_invalidated`，client 必须关闭旧对话框而不是永久等待。

## 5. Session 状态机与进程恢复

沿用现有状态：

```text
starting → running ⇄ detached
starting/running/detached → stopping → stopped
stopped → starting        （仅显式 POST resume）
```

- `running` 表示有存活子进程且至少一个活动 WS；`detached` 表示子进程仍存活但无 WS。模型 busy/idle 由 SDK message 表达，不另造状态。
- `maxSessions` 统计 starting/running/detached/stopping，stopped 不占槽。并发创建必须在同一原子计数路径检查，不能先 spawn 后发现超限。
- `lastActiveAt` 只在 attach、有效 client frame 或显式 resume 时更新；keepalive 和 detached 子进程输出不续租。只有 detached 且超过 `idleTimeoutMs` 才回收，running 永不因 idle timeout 被 kill。
- idle/DELETE/shutdown 都先停止新输入，发送 SIGTERM，等待最多 5 秒，再在身份复核后 SIGKILL。 stopped 保留 `SessionIndexEntry`、事件日志和 transcript 以供恢复；不得把 stopped 当历史删除。
- 子进程退出即进入 stopped 并记录 exit code/signal；正常 turn result 不等于进程/session 停止，长驻 stream-json 子进程仍可接受下一 turn。

持久索引为 `~/.claude/server-sessions.json`，schema version 加上现有 `SessionIndexEntry` 的 `processStartToken`、`state`、`last_seq`、`exit`。目录/文件权限为 `0700/0600`，写入采用临时文件+fsync+原子 rename。事件日志同样为 `0600` 并有大小/轮转上限；轮转不得破坏 client gap 检测，无法重放时 ready 返回 `replay_reset:true` 和当前完整状态，client 不得假装无丢失。

server 正常 shutdown 停止接受连接、WS 以 1001 关闭、`destroyAll()`、最后按相同 PID/start token 删除 lockfile。异常重启只恢复索引；未经验证的旧 PID 不接管、不 kill。旧子进程确认已退出后标 stopped，显式 resume 时用 transcript ID 启动新进程；不得自动重放最后一次用户 prompt。

## 6. Backend 契约

统一 backend 接口至少支持 `create({sessionId,cwd,resumeTranscriptId,permissionMode})`、`write()`、`interrupt()`、`stop()`、`destroyAll()` 和 stdout/stderr/exit 事件。

- 新 session：`--print --input-format stream-json --output-format stream-json --session-id <id>`。
- 恢复：同输出模式加 `--resume <transcriptSessionId>`，不重新发送初始 prompt。
- 常规 backend 始终使用普通 permission mode；dangerous backend 只能追加上述双重授权允许的 bypass flag。
- 子进程环境只继承明确白名单，移除 `CLAUDE_CODE_SESSION_KIND`、其他 server 的 connect/SSH 变量和递归 runner 入口；凭据只从 server 本地认证链获取，不写事件日志。
- stderr 保留有界 ring buffer，错误返回脱敏尾部；不得把完整 env、Authorization 或 prompt 写入 server log。

`DangerousBackend` 不是默认开放实现。可以复用其接口名称完成内部兼容，但公开 server 必须先实现常规 ProcessBackend。

## 7. Lockfile

lockfile 固定为 `~/.claude/server.lock`，不保存 token：

```json
{
  "version": "direct-connect-v1",
  "pid": 1234,
  "processStartToken": "platform-specific",
  "port": 43210,
  "host": "127.0.0.1",
  "httpUrl": "http://127.0.0.1:43210",
  "unix": null,
  "startedAt": 1790000000000
}
```

使用 `wx` 原子创建。`probeRunningServer()` 同时验证 PID/start token 和 `/health` 的 protocol+PID；仅 PID 存在不够，EPERM/身份不明按“可能仍运行”处理并拒绝抢锁，不能删除。stale lock 只有确认进程已死或 health 明确不属于该实例才可条件删除。port 0 必须写实际监听端口。第二个 server 不 kill 旧实例，直接报告现有 httpUrl。

## 8. Headless、重试与错误语义

`runConnectHeadless(config,prompt,outputFormat,interactive)`：

- `interactive=false`：连接 ready 后只发送一次 prompt；`text` 输出 assistant 文本，`json` 输出最终 result JSON，`stream-json` 输出每个过滤后的 SDK message。非交互权限请求默认 deny，除非已双重启用 dangerous 模式；result 失败或断线未恢复则非零退出。
- `interactive=true`：stdin/stdout 是 NDJSON user/control 流，直到 EOF 和当前 turn 完成；仍由本地 control 处理权限，不启动 TUI。
- HTTP 创建失败仅在网络、429、503 时以相同 request ID 重试最多 3 次，退避 250/500/1000 ms 加 jitter；400/401/403/404/409 不重试。
- WS 断线以 250 ms 起步、上限 2 秒指数退避重连，headless 最多 3 次，REPL 最多 5 次并显示 reconnecting。重连只恢复事件流，不重发已写入 WS 的 prompt/control；未确认写入的输入保留在本地队列，连接恢复后按原 request ID 发一次。
- 收到 result 不代表可以立即 DELETE；先确认 session 状态已落盘，避免状态写竞态。REPL 只有重试耗尽或明确 server stopped 才 `gracefulShutdown(1)`，不能在首次暂时断线时直接退出。

`DirectConnectError` 保留名称，但应解析稳定 `error.code`，网络错误、HTTP 非 2xx、响应 schema 错误分别可用 `SERVER_UNREACHABLE`、`HTTP_ERROR`、`INVALID_SESSION_RESPONSE` 区分。旧文案前缀可兼容，不能把 401 当作可重试网络错误。

## 9. 关键文件复用

- `/Users/fengcaiwen/GolandProjects/claude-code/src/main.tsx`：server 参数、cc URL、interactive/headless 分流。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/server/parseConnectUrl.ts`、`createDirectConnectSession.ts`、`directConnectManager.ts`、`types.ts`：URL、HTTP、WS 和 schema 的直接扩展点。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/server/server.ts`、`sessionManager.ts`、`lockfile.ts`、`connectHeadless.ts`、`serverLog.ts`、`backends/dangerousBackend.ts`：替换占位的实现边界。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/hooks/useDirectConnect.ts`、`remote/sdkMessageAdapter.ts`、`remote/remotePermissionBridge.ts`：继续负责 REPL 和权限，不复制 UI 消息转换。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/sessionStorage.ts`：原生 transcript/resume，不复用 supervisor NDJSON 充当原生历史。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/daemon/supervisor.ts`：只参考退避；不得自动重启并重放 turn。

## 10. 测试与 dist/live 验收

### 单元和 loopback 集成

新增 `tests/directConnect.test.ts`，用 fake backend 与真实 HTTP/WS：

1. URL/token 脱敏、无 token/错误 token、Unix socket 权限、dangerous 单双边/双边授权、workspace 逃逸。
2. 创建 schema、request ID 同/异 body、并发 maxSessions、resume stopped/missing/corrupt、DELETE 幂等。
3. NDJSON 分帧、二进制/超限/非法输入、keepalive、control allow/deny/error、未知 subtype、request ID 冲突。
4. 断线 gap、重放去重、事件轮转 reset、pending permission 重放/失效、idle 只在 detached 触发。
5. lockfile PID 复用、EPERM、health 不匹配、条件清理；shutdown 后无子进程和 socket 泄漏。
6. headless 三种格式、非交互权限 deny、重连不重发 prompt、结果与退出码。

### dist

实现与 `DIRECT_CONNECT` 同波加入 feature profile 后，运行 `bun run typecheck`、专项测试、`bun run build`。用隔离 `CLAUDE_CONFIG_DIR`、随机 loopback 端口和 fake model API 在 `dist/main.js server` 与另一个 `dist/main.js cc://...` 间完成创建、两轮消息、权限、中断、detach/resume、idle 和 restart resume；检查 `dist/types/server/*.d.ts` 和 external profile。另跑 `bun test tests/enabledFeatures.test.ts`。仅 help/banner 或 build 成功不算通过。

### live

在授权账户下用真实模型执行 loopback server/client 两轮交互和一次权限确认，再执行 detached resume；如跨主机使用，必须由授权 TLS 边界保护并单独记录 host/key/token 检查。真实模型不可用则模型 live 标 skipped，loopback fake backend 只记 offline。最后清理 server、子进程、lockfile 和临时配置，并保留仓库已有 cron/LSP 前置失败的独立状态。
