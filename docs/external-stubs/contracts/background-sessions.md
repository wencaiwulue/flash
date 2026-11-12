# Background Sessions v1 契约

日期：2026-11-11
状态：前瞻设计，尚未实现；适用于 `BG_SESSIONS` 的开放本地实现。

当前 `/Users/fengcaiwen/GolandProjects/claude-code/src/cli/bg.ts` 全部抛出 unavailable。本文定义真实的 detached tmux 会话，不接受只 spawn 后打印 PID、用 UDS 文本队列假装终端 attach、或只按 PID 发信号的伪实现。

## 1. 范围与调用方约束

公开入口位于 `/Users/fengcaiwen/GolandProjects/claude-code/src/entrypoints/cli.tsx`：`ps`、`logs`、`attach`、`kill` 以及任意位置的 `--bg`/`--background` 都分派给 `bg.ts`。`ps` 接收完整参数数组，其他三个处理器当前各接收一个 session ID，因此 v1 不额外发明未接线的选项。

必须复用：

- `src/utils/concurrentSessions.ts` 的 `~/.claude/sessions/<pid>.json` 注册、session switch 更新和 `busy|idle|waiting` 活动状态；
- `src/utils/tmuxSocket.ts` 的隔离 socket 原则、tmux argv 执行与可用性检查，不能让 Claude/用户默认 tmux socket 被误操作；
- `src/utils/udsRegistry.ts`、`udsClient.ts`、`udsMessaging.ts` 的存活 ping 和身份交叉校验；
- `src/utils/sessionStorage.ts` 的原生 session/transcript 发现与恢复；
- `src/utils/genericProcessUtils.ts` 的进程工具，但 `isProcessRunning(pid)` 只能作为存活提示，不能作为 kill 授权。

非目标：远程任务调度、跨用户管理、自动重启模型 turn、持久终端滚动恢复，以及用 daemon supervisor 替代每个后台会话。

## 2. 公开命令与输出

```text
claude [--bg|--background] <原有 CLI 参数...>
claude ps [--json]
claude logs <session-id>
claude attach <session-id>
claude kill <session-id>
```

### `--bg` / `--background`

1. 两个 flag 完全等价，只能作为 CLI flag 解析；`--` 之后的文本和 prompt 参数值不得被误删。实现应从传给正常 CLI 的 argv 中精确移除该 flag，其余参数原样作为独立 argv 传递。
2. 默认生成新的 UUID session ID。调用方可使用已有 `--session-id <uuid>` 作为 launch 幂等键：同一 live session 且规范化启动参数哈希相同，返回原记录；同 ID 不同参数返回 `SESSION_CONFLICT`。已退出 ID 不得隐式重跑，调用方必须显式使用 `--resume` 发起新 turn。
3. 成功输出一行结构化摘要：session ID、PID、tmux socket/session、logPath 和 `claude attach <session-id>`。`--json` 若原命令支持，则摘要字段为 `{version:"background-sessions-v1",session_id,pid,state,tmux_socket,tmux_session,log_path,attach}`。
4. 在 registry 原子落盘且 tmux 子进程启动令牌核验之前不得报告成功。任何后续失败都执行已创建资源的逆序清理。
5. `--bg` 不与 `--print`、SDK 或另一个 SSH/Direct Connect 远程模式组合；这些模式没有本地交互终端可 attach，返回 `BG_MODE_CONFLICT` 而不是悄悄前台执行。

### `ps`

默认列出当前用户所有 live 顶层 CLI 会话（`interactive|bg|daemon|daemon-worker`），并标明 kind；只有 bg 记录可 attach/kill。每行字段：

```json
{
  "session_id": "uuid",
  "pid": 12345,
  "kind": "bg",
  "state": "idle",
  "waiting_for": null,
  "name": "optional",
  "cwd": "/path",
  "started_at": 1790000000000,
  "updated_at": 1790000001000,
  "attached_clients": 0,
  "tmux_socket": "claude-bg-501-abcd1234",
  "tmux_session": "bg-abcd1234",
  "log_path": "/path/session.log"
}
```

`--json` 输出 `{version:"background-sessions-v1",sessions:[...]}`，按 `started_at` 再按 session ID 排序。没有 UDS 的记录仍可列出，但必须经 PID+启动令牌+tmux 三方核验；身份不明显示 `unknown`，不能清理或判死。

### `logs`

输出该 session 的终端日志内容，保持原始 stdout/stderr 顺序，不清空文件、不伪造模型消息。默认最多最后 200 行且最多 1 MiB，截断时在 stderr 明确说明。日志是可能含 prompt 的敏感本机文件，权限必须 `0600`；JSON transcript 与终端日志不是同一格式。session 已退出但 logPath 仍在时允许读取。

### `attach`

只允许 `kind=bg` 且身份核验通过的记录，以真实 argv 执行：

```text
tmux -L <registry.tmux_socket> attach-session -t <registry.tmux_session>
```

attach 使用当前 TTY 的 stdin/stdout/stderr，退出码来自 tmux。分离客户端只减少 `attached_clients`，不得杀后台进程；REPL 的 `/exit`、Ctrl-C/Ctrl-D 继续遵守 `isBgSession()` 的 detach 语义。不是交互 TTY 时返回 `ATTACH_REQUIRES_TTY`。

### `kill`

只接受 bg session，先按第 5 节重新授权，再对该精确进程执行 `SIGTERM`；最多等待 5 秒。仍未退出时再次核验身份后 `SIGKILL`。最后只对 registry 中的精确 socket/session 执行：

```text
tmux -L <socket> kill-session -t <tmux_session>
```

不得使用 `kill-server`（可能误杀同 socket 的其他 bg session）、负数进程组 PID 或仅凭 PID 文件的 `process.kill`。已经由本记录证明退出的 kill 返回成功 `{state:"already_stopped"}`；不存在返回 `SESSION_NOT_FOUND`，身份不明返回 `PID_IDENTITY_MISMATCH` 且绝不发信号。

## 3. 持久记录与文件布局

继续使用 `~/.claude/sessions/<pid>.json`；目录 `0700`、记录 `0600`。只读取严格匹配 `^\d+\.json$` 的文件，不能把其他笔记文件解析成 PID。bg 记录在现有字段上扩展：

```json
{
  "version": "background-sessions-v1",
  "launch_id": "uuid 或 session_id",
  "sessionId": "uuid",
  "pid": 12345,
  "processStartToken": "platform-specific-nonempty-string",
  "argsHash": "sha256",
  "cwd": "/canonical/cwd",
  "startedAt": 1790000000000,
  "kind": "bg",
  "entrypoint": "cli",
  "name": "optional",
  "logPath": "/path/session.log",
  "messagingSocketPath": "/tmp/optional-uds.sock",
  "status": "idle",
  "waitingFor": null,
  "updatedAt": 1790000001000,
  "lifecycle": "running",
  "tmuxSocket": "claude-bg-501-abcd1234",
  "tmuxSocketPath": "/tmp/tmux-501/claude-bg-501-abcd1234",
  "tmuxSession": "bg-abcd1234",
  "tmuxServerPid": 12340,
  "tmuxPanePid": 12345,
  "ownerUid": 501,
  "exit": null
}
```

新记录写入采用同目录临时文件、fsync、原子 rename；`updatePidFile()` 的 read-modify-write 必须串行化并带 `updatedAt`。原进程退出时只有当前记录仍含同一 `processStartToken` 才能删除，避免删除 PID 复用后新进程的记录。老版本缺少启动令牌/tmux 字段的记录可只读展示为 `legacy/unknown`，但 attach/kill 必须失败关闭。

日志位于 `~/.claude/session-logs/<session-id>.log`，由 tmux `pipe-pane` 追加捕获真实终端输出。UDS registry 继续位于 `~/.claude/uds/`，其临时文件和 rename 逻辑保持复用。

## 4. tmux 启动与状态机

每个 bg session 使用独立 socket，名称 `claude-bg-<uid>-<sessionId前8位>`、session 名 `bg-<sessionId前8位>`。禁止复用 `claude-<PID>` 的短命工具 socket，也禁止 launcher 退出时调用该工具 socket 的 `killTmuxServer()` 清理。

启动顺序：

1. `checkTmuxAvailable()`，不可用则 `TMUX_UNAVAILABLE`，不得退化为无管理能力的前台/裸后台进程。
2. 生成 session ID、参数哈希、日志路径和启动记录；校验 socket/session 尚不存在。
3. 用 argv 调用 `tmux -L <socket> new-session -d -s <name> -c <cwd>`，并设置 `CLAUDE_CODE_SESSION_KIND=bg`、`CLAUDE_CODE_SESSION_NAME`、`CLAUDE_CODE_SESSION_LOG`、`CLAUDE_CODE_MESSAGING_SOCKET` 等环境。实际命令为 `exec <bun> <main.js> <原参数>`，每个动态值用统一 POSIX shell quote；不能串接未经转义的 prompt、cwd 或路径。
4. 用 `display-message -p '#{socket_path},#{pid},#{pane_pid}'` 获取真实 socket/server/pane 身份，捕获进程启动令牌，再配置 `pipe-pane -o -t <target> <追加日志命令>`。
5. 等子进程 `registerSession()` 和可选 UDS pong 就绪后返回。UDS pong 的 sessionId 必须与记录一致；UDS_INBOX 未启用时以 PID+tmux+原生 transcript 为核验依据。

生命周期为：

```text
launching → starting → idle ⇄ busy
                     idle ⇄ waiting
starting/busy/idle/waiting → stopping → stopped
starting/busy/idle/waiting → failed
```

`attached`/`detached` 是客户端计数，不是独立进程状态。正常退出、异常退出和被 kill 分别记录 `exit={code,signal,reason,ended_at}`；正常 cleanup 后 PID registry 可删除，但日志和 tombstone 需保留以支持 logs 与幂等 kill。活动 `status` 来自 `updateSessionActivity()`，不得仅从 transcript 尾猜测一个正在运行的进程已经完成。

## 5. 身份核验与 PID 安全

所有 attach/kill 和 stale cleanup 前执行同一 `authorizeSession(record, operation)`：

1. 解析记录并检查 version、UID、绝对规范路径、session ID 和 kind；拒绝符号链接替换的 registry/log。
2. `process.kill(pid,0)` 仅用于初筛；EPERM 不是“已死亡”。Linux 读取 `/proc/<pid>/stat` starttime，其他平台读取等效启动时间并与 `processStartToken` 比较。
3. 用 registry socket 执行 `has-session -t <exact>` 和 `display-message -p '#{pane_pid}'`，要求 pane PID 与 registry PID 相同。socket 必须属于当前 UID 且位于预期 tmux 目录。
4. 若有 UDS，ping 必须返回相同 session ID；若 UDS 超时但其余证据完整，可只读显示 degraded，kill 不得依赖 UDS 可用性。
5. 发每个 SIGTERM/SIGKILL 前重新读取并比较身份，消除检查到信号之间的 PID 复用窗口。无法重新证明时停止操作。

WSL/Windows 跨宿主 PID 不可比较时，不得清理 registry 或发宿主机信号；只有同 WSL 实例且 tmux/启动令牌都能核验时才允许操作。daemon 的 `stopDaemon()` 不具备这些保证，不能拿来代替 bg kill。

## 6. 重试、幂等与恢复

- `ps/logs` 可安全重试；stale registry 删除必须带身份和 socketPath 条件。`attach` 不自动反复接管终端，tmux 暂时失败最多重试 2 次（100/200 ms）。
- 创建时只在等待 registry/UDS 就绪阶段做有界退避（50、100、200、400、800 ms，总计不超过 5 秒）；spawn、参数或权限错误不重试。
- `kill` 对同一退出 tombstone 幂等；信号发送后超时就查询真实状态，不因客户端超时而盲目换 PID 重发。
- CLI 崩溃重进后，`ps` 根据 registry+tmux+启动令牌恢复视图。tmux 是进程所有者，原 launcher 不需要常驻；不得由 `DaemonSupervisor` 自动重启并重放 prompt。
- tmux server 消失但 PID 仍在、PID 复用、UDS 指向别的 session、日志被替换均为 `SESSION_IDENTITY_CONFLICT`，需要用户手工处理，不自动接管。

稳定错误包括：`SESSION_NOT_FOUND`、`SESSION_AMBIGUOUS`、`SESSION_NOT_BACKGROUND`、`SESSION_CONFLICT`、`BG_MODE_CONFLICT`、`TMUX_UNAVAILABLE`、`ATTACH_REQUIRES_TTY`、`PID_IDENTITY_MISMATCH`、`SESSION_IDENTITY_CONFLICT`、`LOG_UNAVAILABLE`、`KILL_TIMEOUT`。错误写 stderr 并非零退出；安全冲突不得附带认证内容或完整敏感 argv。

## 7. 关键实现文件

- `/Users/fengcaiwen/GolandProjects/claude-code/src/cli/bg.ts`：五个 handler、参数解析和稳定输出。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/entrypoints/cli.tsx`：保持真实分派，避免把 prompt 中的 `--bg` 当 flag。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/concurrentSessions.ts`：扩展原子 registry、启动令牌、tmux 元数据和条件 cleanup。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/tmuxSocket.ts`：提取/复用不经过 shell 的 tmux argv helper；新 bg 使用独立持久 socket，不能继承工具 socket 的退出 kill-server。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/udsClient.ts`、`udsRegistry.ts`、`udsMessaging.ts`：存活和 session 交叉验证。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/sessionStorage.ts`：原生 transcript 与 resume，不另写会话历史。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/daemon/supervisor.ts`、`daemon/main.ts`：只参考退避和记录模式，不用于 bg 自动重启或 kill。

## 8. 测试与 dist/live 验收

### 单元与真实集成

新增 `tests/backgroundSessions.test.ts`：

1. argv 保留 prompt 中的 `--bg` 文本，session ID 幂等与冲突、非正常模式拒绝、spawn 失败逆序清理。
2. 严格 PID 文件名、原子记录、session switch、PID 复用、EPERM、WSL、错误 socket、错误 pong、tmux pane 不匹配均失败关闭。
3. 用真实本地 tmux 创建长寿但无害的测试进程，完成 `ps → logs → attach/detach → kill`；检查 SIGTERM 超时、SIGKILL 二次身份核验、单 session cleanup 不影响同 socket 其他会话。
4. kill tombstone 幂等、launcher 崩溃后的发现、退出日志仍可读、大日志截断和权限 `0700/0600`。
5. 现有 `tests/udsMessaging.test.ts` 必须继续通过，不能把 UDS 改成 attach 协议。

### dist

实现和 `BG_SESSIONS` 同波加入 feature profile 后，运行 `bun run typecheck`、专项测试、`bun test tests/udsMessaging.test.ts`、`bun run build`。以隔离 `CLAUDE_CONFIG_DIR` 和 loopback fake model API 在 `dist/main.js` 上执行完整 bg 生命周期，验证 dist 打包后的 tmux/UDS/sessionStorage 路径以及 `tests/enabledFeatures.test.ts`。若主机没有 tmux，mock 单测可以运行，但真实 dist 项必须标为 skipped，不能记为通过。

### live

在授权环境用真实模型启动一个交互 bg turn，等待 idle，再 attach/detach 并 kill；另启动两个 session 验证 kill 不串扰，最后检查无遗留 tmux/子进程。真实模型不可用时可完成“真实 tmux+fake child”的离线进程验收，但必须分别记录 model live skipped。最终执行 `bun test`、`bun run typecheck`、`bun run build`，并单独保留仓库既有 cron/LSP 前置失败，不得用本功能结果掩盖。
