# Open Runner v1 契约

日期：2026-11-11
状态：前瞻设计，尚未实现；协议名称为 `open-runner-v1`。

本文定义一个新的、开放的 reference server + client。它不是 Anthropic 内部 BYOC、CCR v1/v2、Environments API、SelfHostedRunnerWorkerService 或 Session Ingress 的实现，也不提供与这些私有协议的兼容声明。

## 1. 私有边界与目标

当前仓库可见的内部边界包括：

- `src/bridge/bridgeApi.ts` 的环境注册、`/v1/environments/*/work`、server-issued environment ID 和 `metadata.worker_type`；
- `src/bridge/types.ts` 的 base64url `WorkSecret`、session ingress token、auth sources 和 `use_code_sessions`；
- `src/bridge/codeSessionApi.ts` 的 `/v1/code/sessions/*`、worker JWT 和 worker epoch；
- `src/bridge/sessionRunner.ts` 的 `--sdk-url`、session access token 与 CCR transport；
- `src/environment-runner/main.ts`、`src/self-hosted-runner/main.ts` 的私有入口占位。

Open Runner 不使用上述路径、字段、beta headers、token、environment ID 或 epoch 语义。所有开放路由固定在 `/open-runner/v1`，runner token 与 model/API 凭据分离，reference server 不执行模型推理，client 在本地 workspace 启动真实 CLI。

现有 `environmentRunnerMain`/`selfHostedRunnerMain` 若恢复，只能作为显式提供 Open Runner `--server` 与 token 后的薄 alias 调用同一 `openRunnerMain`；不得把私有 BYOC 参数翻译为开放请求，也不得默认连接 Anthropic 内部端点。公开文档以新命令为准。

目标：单用户或小团队的可测试任务队列、至少一次工作分配、持久事件、权限隔离、取消、lease 恢复和真实 CLI 子进程。非目标：多租户隔离、强 exactly-once 副作用、云端自动扩缩容、私有 BYOC 兼容和任意远端 shell 执行。

## 2. 公开命令

### Reference server

```text
claude open-runner-server \
  [--host 127.0.0.1] [--port 0] [--state-dir <dir>] \
  --worker-token-file <path> --admin-token-file <path>
```

默认只绑定 loopback。成功输出实际 `server_url`、state-dir 和 protocol，不输出 token。非 loopback HTTP 必须拒绝；跨主机部署只能在授权 TLS reverse proxy 后运行，并由该代理保留 bearer header 和请求大小限制。

### Worker client

```text
claude open-runner run --server <url> --runner-id <uuid> \
  --workspace <dir> --token-file <path> [--max-work 1] [--once]
```

`--once` 表示处理至多一个 assignment 后退出，供测试和批处理使用。`runner-id` 是长期逻辑身份，每次进程启动另生成 `instance_id`；二者不能混用。

### Admin client

```text
claude open-runner submit --server <url> --token-file <path> \
  --work-id <uuid> --prompt <text> [--cwd <relative-path>] \
  [--model <model>] [--permission-mode default|acceptEdits|plan] \
  [--max-attempts <1..5>] [--max-runtime-ms <n>]
claude open-runner status --server <url> --token-file <path> <work-id>
claude open-runner events --server <url> --token-file <path> <work-id> [--after <seq>]
claude open-runner cancel --server <url> --token-file <path> <work-id> [--reason <text>]
```

默认 JSON 输出，错误统一 stderr 并非零退出。token file 必须为当前用户所有的 `0600` 文件，内容只有一行高熵 token；token 不接受 query 参数，诊断和 child env 不得包含它。

## 3. 认证、授权与输入边界

server 加载两个独立 token：

- worker token：register/poll/ack/heartbeat/events/complete，以及读取自己被分配 work；
- admin token：submit/status/events/cancel，以及列出诊断信息；admin 权限不自动授予 worker lease 操作。

`GET /open-runner/v1/health` 可匿名返回 `{protocol:"open-runner-v1",server_version,pid}`，其他路由都要求 `Authorization: Bearer`。比较采用常量时间；401/403 不泄露 token 或权限细节。token 与模型凭据无推导关系。

提交不是 shell 命令：只接受结构化 prompt、相对 cwd、model 和有限 permission mode。reference v1 禁止 `bypassPermissions`、任意 env、任意 argv、artifact URL、git token 和宿主绝对 cwd。worker 将 cwd canonicalize 后限制在 workspace 内，拒绝 `..`、绝对路径和符号链接逃逸。prompt 最大 256 KiB，event 单条最大 4 MiB，batch 最大 8 MiB。

worker 子进程只继承本地模型所需的白名单环境，显式删除 `OPEN_RUNNER_*`、admin/worker token、其他 bridge/SSH/direct-connect 变量。server/admin 不需要也不能取得 worker 的模型凭据。

## 4. HTTP API 与 schema

所有成功响应含 `protocol:"open-runner-v1"`；错误统一：

```json
{
  "protocol": "open-runner-v1",
  "error": {
    "code": "STALE_LEASE",
    "message": "safe human-readable message",
    "retryable": false,
    "details": {}
  },
  "request_id": "uuid"
}
```

### 4.1 Runner 注册

`POST /open-runner/v1/runners/register`（worker）

```json
{
  "runner_id": "uuid",
  "instance_id": "boot-uuid",
  "capabilities": {"max_work": 1, "permission_modes": ["default", "acceptEdits", "plan"]}
}
```

返回 `{runner_id,instance_id,worker_epoch,heartbeat_interval_ms:10000,lease_ms:30000,server_time}`。同一 runner 的新 instance 使 epoch 原子加一并fence旧 instance；相同 instance 重放注册返回当前 epoch。旧 epoch 后续请求返回 409 `STALE_WORKER_EPOCH`，worker 必须停止旧 child 后重新注册，不能继续写事件。

### 4.2 提交工作

`POST /open-runner/v1/work`（admin）

```json
{
  "work_id": "uuid",
  "input": {
    "prompt": "task text",
    "cwd": "relative/subdir",
    "model": "optional",
    "permission_mode": "default",
    "session_id": "optional-existing-cli-session"
  },
  "max_attempts": 3,
  "max_runtime_ms": 3600000
}
```

同 work ID 同规范化 body 返回原 work，不同 body 返回 409 `IDEMPOTENCY_CONFLICT`。server 生成或保留 `session_id`，首次状态 `queued`，attempt 从 0 开始。响应为完整 `WorkRecord`：

```json
{
  "protocol": "open-runner-v1",
  "work": {
    "work_id": "uuid",
    "session_id": "uuid",
    "state": "queued",
    "attempt": 0,
    "input": {},
    "max_attempts": 3,
    "max_runtime_ms": 3600000,
    "cancel_requested": false,
    "created_at": "RFC3339",
    "updated_at": "RFC3339",
    "last_seq": 0,
    "result": null,
    "error": null
  }
}
```

### 4.3 长轮询与 assignment

`POST /open-runner/v1/work/poll`（worker）

```json
{"runner_id":"uuid","instance_id":"uuid","worker_epoch":1,"max_work":1,"wait_ms":25000}
```

`wait_ms` 范围 0–25000；poll 同时续 runner 存活。返回 `{server_time,work:[WorkAssignment],cancel_requested:[work_id...]}`。无工作在 wait 后返回空数组。

```json
{
  "work_id": "uuid",
  "session_id": "uuid",
  "attempt": 1,
  "lease_id": "uuid",
  "lease_expires_at": "RFC3339",
  "input": {},
  "max_runtime_ms": 3600000
}
```

分配把 `queued|retry_wait → leased`，attempt 加一。lease ID 每次分配重新生成，旧 lease 不可写。server 不得在 lease 未过期时把同一 work 分给第二个 runner。

### 4.4 Ack、heartbeat 与 cancel

- `POST /work/{id}/ack`：body 带 runner/instance/epoch/lease；`leased → running`，同 lease 重放返回当前 running。
- `POST /work/{id}/heartbeat`：同身份 body；延长 `lease_expires_at=server_time+lease_ms`，返回 `{lease_expires_at,state,cancel_requested}`。只能在 running 且 lease 未过期时续租。
- `POST /work/{id}/cancel`（admin）：body `{reason?}`；queued/retry_wait 直接 `cancelled`，leased/running 设置 `cancel_requested=true` 并保留当前状态，响应幂等。worker 在 poll/heartbeat 发现后 interrupt child，再以 `cancelled` complete。

身份不符返回 409 `STALE_LEASE`，work 不存在返回 404，终态上的 heartbeat 返回 409 `WORK_TERMINAL`。这些冲突不能盲目重试。

### 4.5 事件写入与读取

`POST /work/{id}/events`（worker）：

```json
{
  "runner_id": "uuid",
  "instance_id": "uuid",
  "worker_epoch": 1,
  "lease_id": "lease-uuid",
  "events": [
    {
      "event_id": "uuid",
      "kind": "sdk",
      "occurred_at": "RFC3339",
      "message": {"type": "assistant"}
    }
  ]
}
```

`kind` 为 `sdk|process|log|error`。server 对 `(work_id,event_id)` 去重，先持久化再按写入顺序分配连续 `seq`，响应 `{accepted:[{event_id,seq}],last_seq}`。重复 event ID 同规范哈希返回原 seq，不同内容返回 409 `EVENT_ID_CONFLICT`。事件不直接改变权威 work 状态，终态只能由 complete/cancel/lease policy 改变。

`GET /work/{id}/events?after=<seq>&limit=<1..1000>`（admin 或持有有效 lease 的 worker）返回 `{work_id,events:[{seq,event_id,kind,occurred_at,message}],last_seq,has_more}`，严格按 seq 升序。读取可重试并用 seq 去重，不是无 replay 的 SSE。

### 4.6 完成与状态查询

`POST /work/{id}/complete`（worker）body 含 runner/instance/epoch/lease 和：

```json
{
  "outcome": "succeeded|failed|cancelled",
  "retryable": false,
  "result": {},
  "error": {"code": "CHILD_EXIT", "message": "safe summary"}
}
```

- succeeded/cancelled 进入同名终态；失败且 retryable=true、attempt<max_attempts 时进入 retry_wait，否则 failed。
- 同 lease 同 outcome/result 重放返回原 record；不同结果返回 409 `TERMINAL_CONFLICT`。
- complete 前必须把已收集事件写入并收到 seq；server 不保证未送达的 child stdout 可由它恢复。

`GET /work/{id}` 返回当前 WorkRecord；`GET /work?state=<state>&limit=<n>` 仅 admin 可用于诊断，默认最多 100 条且不包含完整事件正文。

## 5. 状态机与 lease 恢复

```text
queued → leased → running → succeeded|failed|cancelled
   ↑       │        ├→ retry_wait ───────────────┘
   │       │        └→ cancel_requested → cancelled
   └───────┴─ lease expired → retry_wait（有剩余 attempt）
                             或 failed（无剩余 attempt）
```

lease 默认 30 秒、heartbeat 10 秒。server 用单调时钟计算本进程超时，同时持久化 wall-clock deadline 供重启恢复。重启后不立即重分未过期 lease；到期才按剩余 attempt 进入 retry_wait/failed。retry_wait 使用确定性的 `next_attempt_at`，避免多 worker 同时惊群。

reference server 的状态目录：

```text
state.json              work、runner epoch、queue、lease、next attempt
events/<work-id>.jsonl  带 seq 的追加事件
locks/                  单实例与写锁
```

目录 `0700`、文件 `0600`。`state.json` 更新采用同目录临时文件、fsync、原子 rename；event append/fsync 必须在 accepted 响应前完成。启动时校验 schema、work ID/seq/lease，损坏则拒绝启动而不是清空队列。server 单 state-dir 只能有一个实例，使用身份化 lock，不仅检查 PID。

## 6. Worker 子进程与本地恢复

worker 本地状态目录为 `~/.claude/open-runner/<runner-id>/`，保存 `instance.json`、`active-work.json` 和脱敏日志，权限同上。

正常执行：

1. register 成功后才 poll；ack 先落本地 `accepted` 记录，再写 server ack。
2. 在 spawn 前持久化 work/lease/session ID 和本地阶段 `spawning`。首轮 CLI argv 为 `--print --input-format stream-json --output-format stream-json --session-id <session_id>`；已有 session 的显式重试使用 `--resume <session_id>`，不自动重发初始 prompt。
3. spawn 后立刻记录 PID、进程启动令牌、lease、connection generation，再写一条 SDKUserMessage。权限和 model 是独立 argv，prompt 只走 NDJSON stdin，不经过 shell。
4. 逐行读取 SDK stdout，以持久 event ID 发送事件；优先使用 SDK message UUID 派生 event ID，无 UUID 时生成并在重试前落盘。保留有界 stderr ring buffer，认证信息脱敏。
5. result 后等待进程退出和事件 flush，再 complete。exit 0 且有 success result 才 succeeded；非零、异常 result、timeout 或协议错误均 failed/cancelled，不能仅凭进程 0 标成功。
6. max runtime 到期先 interrupt，2 秒后 SIGTERM，5 秒后在身份复核后 SIGKILL，完成 `WORK_TIMEOUT` 且默认不 retry；cancel 同理但 outcome=cancelled。

worker 崩溃恢复不接管旧 stdio：

- 新 instance 先读取 active-work，只有 PID+启动令牌+session ID 全匹配时才可终止自己的遗留 child；身份不明不 kill，报告 `RECOVERY_CONFLICT`。
- 即使能终止，也把该 attempt 标为 `RUNNER_RESTARTED` 并按 server lease 规则重试；不声称知道旧 prompt 是否已执行。server 重试可复用 session transcript，但 operator 必须看到 at-least-once 警告。
- 旧 instance 被新 epoch fence 后不得继续 heartbeat/events/complete。本地没有 active-work 记录时不得凭 work ID 杀进程。

执行语义是 **at-least-once assignment**，event/complete/submit 幂等，而不是全局 exactly-once。stdin 写入到本地 `prompt_sent` 落盘之间的崩溃可能重复 prompt；自动恢复不得偷偷重发，需以 `delivery_unknown` 失败并由 admin 决定显式重试。

## 7. 重试、退避与错误

- poll/register/heartbeat 遇网络、408、429、500、502、503、504 时使用全 jitter 指数退避，初始 500 ms、上限 30 秒；尊重 `Retry-After`。long-poll client deadline 为 `wait_ms+5s`。
- submit/ack/events/complete 只在相同 work/event/lease/idempotency ID 下重试；不得生成新 ID。
- 400/401/403/404/409/413/422 不重试。`STALE_WORKER_EPOCH` 走重新注册，`STALE_LEASE` 停止该 assignment 并回 poll，`WORK_TERMINAL` 读取状态后结束。
- heartbeat 连续 3 次失败即停止 child，防止 lease 已失效仍执行；停止过程仍要收集可确认事件，但旧 lease 写回被拒时只保留本地恢复记录。
- server 关机停止新 poll/提交，等待最多 10 秒让 running 完成，之后返回 503 `SERVER_DRAINING`；它不替 worker kill 远端子进程，未续租 work 由 lease 规则恢复。

稳定错误码至少包括：`AUTHENTICATION_FAILED`、`PERMISSION_DENIED`、`INVALID_REQUEST`、`WORK_NOT_FOUND`、`IDEMPOTENCY_CONFLICT`、`EVENT_ID_CONFLICT`、`TERMINAL_CONFLICT`、`STALE_LEASE`、`STALE_WORKER_EPOCH`、`WORK_TERMINAL`、`CAPACITY_EXCEEDED`、`SERVER_DRAINING`、`RECOVERY_CONFLICT`、`WORK_TIMEOUT`、`RATE_LIMITED`。HTTP 使用 400/401/403/404/409/413/422/429/500/503 的对应语义。

## 8. 关键文件复用与新增模块

新增实现应位于 `src/open-runner/`：`protocol.ts`、`server.ts`、`store.ts`、`client.ts`、`worker.ts`、`main.ts`，并在 `src/entrypoints/cli.tsx` 注册新命令。不得把开放 server 接到 `bridgeApi.ts` 的私有路径。

可复用：

- `/Users/fengcaiwen/GolandProjects/claude-code/src/bridge/sessionRunner.ts`：NDJSON 子进程、stderr ring、interrupt/kill 的工程模式；开放 worker 不使用其 `--sdk-url`、session token 或 CCR env。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/daemon/supervisor.ts`：有界退避和停止语义；不自动重放 turn。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/daemon/main.ts`：原子记录和 spawn 模式的参考，但新 server lock 必须增加启动令牌，不能复用仅 PID 的 stop。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/sessionStorage.ts`：CLI 原生 session/resume，不另造 transcript 解析。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/tmuxSocket.ts`：只在 operator 选择交互 worker 时复用隔离原则；reference worker 不需要 tmux。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/udsRegistry.ts`：临时文件+rename 和条件清理模式。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/entrypoints/sdk/controlTypes.ts`：SDK control 类型，不复制一套不兼容消息。

## 9. 测试与 dist/live 验收

### 单元与 reference 集成

新增 `tests/openRunnerProtocol.test.ts`、`tests/openRunnerWorker.test.ts`：

1. schema、token scope、非 loopback 拒绝、token file 权限、path traversal/symlink、禁止任意 argv/env/bypass。
2. submit 幂等/冲突、poll 互斥、ack/heartbeat/complete 重放、event 去重/乱序读取、cancel queued/running。
3. lease 到期重试与耗尽、server 重启、state/event 损坏、epoch fence、旧 lease 拒绝、Retry-After 和有界退避。
4. fake child 的 result/exit、stdin 写后崩溃、事件 flush 后 complete、timeout/cancel、PID 复用、worker 重启与 `delivery_unknown`。
5. 真实 reference server + client 在临时 state/workspace 下完成 submit→poll→ack→events→complete→events replay，检查权限和无 secret 日志。

### dist

实现与新的 `OPEN_RUNNER` feature 同波加入 profile 后，运行 `bun run typecheck`、专项测试、`bun run build`。启动 `dist/main.js open-runner-server` 和 `dist/main.js open-runner run --once`，用 fake child/model 在隔离环境完成两轮 work、一次 lease 重试和一次 cancel；再用 admin `status/events` 核对 seq。检查 dist declarations、external profile 和进程/socket 清理。`environment-runner`、`self-hosted-runner` 若提供 alias，也必须在 dist 验证它们只走 Open Runner 配置，绝不访问内部 BYOC 端点。

### live

在授权环境以 loopback reference server + 真实 CLI worker + 真实模型执行一次 work 和一次 resume；再模拟 worker 崩溃，确认事件不重复、旧 lease 被 fence、operator 能看到 at-least-once/delivery_unknown。跨主机只在 TLS reverse proxy 下另测并记录；未执行时标 skipped。内部 BYOC 兼容性不在本验收中，也不得根据 Open Runner 成功推断。最终运行 `bun test`、`bun run typecheck`、`bun run build`，并保留基线 cron/LSP 失败的独立结果。
