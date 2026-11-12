# 其余 External Stub 的公开实现契约

- 日期：2026-11-11
- 状态：新公开实现设计，尚未实现
- 范围：direct-connect server、Tungsten、MoreRight、ccshareResume、原 ant 维护 handlers

## 1. 原则与历史边界

这些文件的当前实现均为构造即抛错、固定 false/null 或透传 no-op，Git 历史没有可恢复的公开旧实现。本文给出的是新设计，不声称兼容内部 Tungsten、MoreRight、ccshare 或 server 协议；只有现有调用类型和已实现的相邻模块是必须保持的代码约束。

完成标准不是把 unavailable 文案改得更好听，而是让调用链产生真实结果、失败可按运行环境诊断、具有权限/隐私边界和测试。依赖不存在（例如 tmux 未安装）时，可以在调用时返回具体错误，但注册和实现不得再退化为永久占位。

## 2. Direct-connect server 与 `DangerousBackend`

### 2.1 需要一起完成的调用链

仅实现 `src/server/backends/dangerousBackend.ts` 不足以使命令工作；`src/server/sessionManager.ts`、`server.ts`、`lockfile.ts`、`serverBanner.ts`、`connectHeadless.ts` 也都是 stub，必须同一批次完成。已有可复用代码包括：

- `src/server/types.ts`：`ServerConfig`、`SessionInfo`、`SessionIndexEntry`、`connectResponseSchema`。
- `src/server/createDirectConnectSession.ts`：真实的 `POST /sessions` 客户端与响应校验。
- `src/server/directConnectManager.ts`：真实 WebSocket NDJSON、用户消息、权限响应和 interrupt。
- `src/server/serverLog.ts`、`parseConnectUrl.ts` 及现有 CLI/print 入口。

### 2.2 Backend 进程契约

`DangerousBackend` 提供真实的 `spawn()`、`write()`、`resize()`（若支持 PTY）、`interrupt()`、`kill()` 和 `wait()`，以 argv 启动当前 CLI 的 stream-json print 模式，不经过 shell。父子协议与 `DirectConnectSessionManager` 已接受的 `StdoutMessage`、`control_request/can_use_tool`、`control_response` 和 interrupt 对齐。

名称中的 Dangerous 不等于默认绕过权限：

- 服务端新增显式 `--allow-dangerously-skip-permissions`；只有服务端和 `POST /sessions` 的 `dangerously_skip_permissions` 同时为真，子进程才获得该 flag。
- 默认仍走正常权限请求，经 WebSocket 转发给客户端；headless 客户端没有批准能力时拒绝需要确认的调用，不能默认 allow。
- cwd 经 realpath 验证并限制在配置的 workspace 内，拒绝不存在目录、符号链接逃逸和 NUL；workspace 本身在启动时解析。
- 子进程环境不继承 server bearer token；argv 不传 OAuth token。 stdin/stdout NDJSON 有帧大小上限、背压和断线处理。
- kill 先 interrupt/SIGTERM，超时后才对本 backend 创建的本地子进程组发 SIGKILL；不能按会话名模糊 pkill。

### 2.3 SessionManager、HTTP 与 WebSocket

`SessionManager` 维护 id -> SessionInfo，提供 create/get/list/attach/detach/destroy/destroyAll：

- `maxSessions` 在 spawn 前原子检查；0 按现有选项表示不限制，idleTimeout=0 表示不过期。
- starting/running/detached/stopping/stopped 迁移只能单向合法发生；重复 destroy 幂等，destroyAll 等待全部子进程退出并释放 socket。
- detached session 在 idle deadline 到期后销毁；有活跃 WebSocket 或子进程工作时刷新 lastActiveAt，不能用 wall-clock 定时器误杀活跃任务。
- `POST /sessions` 校验 JSON/cwd/权限组合，返回现有 `session_id`、`ws_url`、可选 `work_dir`；GET 只列元数据，DELETE 终止指定 session。
- HTTP 与 WebSocket 都校验 bearer，比较使用 constant-time；token 不放 URL query，不写访问日志。非 loopback bind 必须显式提供 token并打印安全警告，公开默认 host 改为 `127.0.0.1`。
- WebSocket 每帧经 schema 校验和大小限制；客户端断开后按 detach 策略处理，不自动伪报子进程结束。

lockfile 用 `O_EXCL` 创建，含 pid/port/host/start 时间；probe 验证 PID 与 HTTP 健康信息， stale lock 才清理，shutdown 只删除自己持有的锁。banner 输出真实 bind/port/ws 信息，凭据仅在 loopback 的首次交互输出中展示，不写 server log。

`runConnectHeadless()` 复用 `createDirectConnectSession()` 和 `DirectConnectSessionManager`，发送一次 prompt，按 text/json/stream-json 输出真实 SDK 事件；收到 result 后按 subtype 设置退出码并 disconnect。interactive=false 时遇到权限请求返回明确错误，interactive=true 走结构化批准 UI，网络中断不得打印成功结果。

### 2.4 Server 测试

用临时 workspace、随机 loopback port、fake CLI 子进程和内存 WebSocket 客户端，不调用真实模型：覆盖 auth、workspace 逃逸、双重 dangerous opt-in、max/idle、detach/reattach、NDJSON 背压、permission allow/deny、interrupt、进程退出、destroyAll、stale lock、headless 三种格式与非零 result。另用真实临时目录做一组 spawn 集成测试，验证没有 shell 注入和 token 泄漏。

## 3. Tungsten：公开 tmux 工具与真实 UI

### 3.1 工具接口

`src/tools/TungstenTool/TungstenTool.ts` 改为严格 discriminated union：

```text
list
create { name, cwd?, command? }
send   { name, text, enter? }
capture{ name, lines? }
kill   { name }
```

name 只允许有限字符/长度，lines 有上限，command/text 是数据而不是追加到一条 tmux shell 字符串。输出包含真实 sessions、pane 文本或操作结果，output schema 按 action 保持可判别。

复用 `src/utils/tmuxSocket.ts`：`checkTmuxAvailable()`、`markTmuxToolUsed()`、`ensureSocketInitialized()`、`getClaudeSocketName()`。把受控 argv 执行器提取为共享函数，所有命令强制 `-L <claude-PID>`，绝不使用用户原始 TMUX socket：

- create 用 `new-session` 和独立 argv；command 如需执行，走与 Bash 相同的权限检查，不能借 tmux 绕过 sandbox/permission。
- send 用 `send-keys -l` 传文本，Enter 作为独立键；capture 用有界 `capture-pane -p -S -<lines>`。
- kill 只允许本工具 registry 中创建的 session，不能 kill `base`、整个 server 或外部会话。
- list/capture 只读；create/send/kill 是可变操作并显示目标。tmux 未安装、WSL 不可用或初始化失败时返回具体操作错误，不返回成功空集。

`clearSessionsWithTungstenUsage()` 清除本工具使用记录并返回是否有变化，`resetInitializationState()` 清理可重初始化状态；不得把全局 socket path/pid 清成仍被 Shell 使用的陈旧不一致状态。`src/tools.ts`、REPL 和 footer 去掉 ant-only 限制。

### 3.2 `TungstenLiveMonitor` 与 `TungstenPill`

LiveMonitor 以可清理 interval 读取隔离 socket 的 session/pane 状态，显示名称、活跃命令和有界 capture；卸载时取消定时器，tmux 错误可重试且不刷伪造画面。Pill 显示真实活动 session 数和 selected 状态，点击/键盘行为复用 footer item 选择，不再固定 null。UI 不输出命令中的敏感文本到遥测。

测试使用 fake tmux argv/输出，验证所有调用带隔离 socket、send 的 `-l`、kill allowlist、权限拒绝未 spawn、cache reset 一致性和 UI interval 清理；另提供有 tmux 时的可选集成测试，无 tmux 环境明确 skip，而非以 stub 冒充通过。

## 4. MoreRight：本地轮次便签侧栏

`src/moreright/useMoreRight.tsx` 没有旧公开语义。新设计把它定义为显式 opt-in 的**本地轮次便签/状态侧栏**，不伪造“第二模型意见”，也不访问内部服务。

- `enabled` 由 `CLAUDE_MORERIGHT=1` 控制，不再要求 ant；使用真实 `Message` 与 tool JSX 类型替换 `any`。
- 普通输入的 `onBeforeQuery` 返回 true，不修改输入。以 `@right ` 开头的输入被识别为本地便签：保存文本、清空输入、用 `setMessages` 添加本地确认并返回 false，因此不发送给模型。
- `onTurnComplete(messages, aborted)` 只提取本轮最后 user/assistant 的消息 id、时间和完成/中止状态，更新侧栏；不再发模型请求，不读取文件，不写全局配置。
- `render()` 返回真实 Ink 侧栏，按时间显示有界便签和最后轮次状态，提供清除便签的本地 UI；disabled 时不注册输入拦截且 render null。

这给出三个 hook 的实际可观察行为，而非永久 passthrough。便签只存在当前进程，明确不承诺持久化；模型看不到 `@right` 内容，用户普通 prompt 的隐私行为不变。

测试覆盖 disabled 零副作用、普通输入透传、`@right` 阻止 query 且不入模型消息、空便签、成功/中止状态、便签上限、清除和 unmount 清理。

## 5. `ccshareResume`：有界 HTTPS 下载与既有 resume 解析

`src/utils/ccshareResume.ts` 保留严格的 id 规则，但 `loadCcshare()` 实现真实下载：

1. `parseCcshareId()` 只接受 `https://go/ccshare/<id>` 或管理员配置的 HTTPS ccshare origin 的同形 URL，拒绝 userinfo、query、fragment、非预期端口和非法 id。
2. `loadCcshare(id)` 对配置的 origin 发起 GET，Accept 为 JSONL；默认 origin 可为 `https://go`，也可用 `CLAUDE_CODE_CCSHARE_ORIGIN` 指向自托管公开服务。该 endpoint 是本文新服务契约，不宣称当前 go 服务已支持它。
3. 可选 bearer 从专用安全凭据读取，不放 argv/日志；redirect 人工处理，只允许 HTTPS，跨 origin 必须去掉 Authorization并再次要求用户确认，限制 redirect 次数。
4. 响应要求 2xx 和正确 content type，流式下载设置 timeout、总字节上限和 JSONL 行上限；以 `0600` 写配置目录下由随机名确定的临时文件，拒绝 symlink/覆盖。
5. 复用 `loadTranscriptFromFile()` 与 `loadConversationForResume()` 产生真实 `LogOption`，填充 modified/created/messageCount 等元数据。`src/main.tsx` 对 ccshare 的处理不再包 ant gate，继续 `forkSession: true`，绝不用远程 session id 覆盖本地原文件。

分享内容是不可信输入：只按 transcript 解析，不执行其中的 shell、hooks、frontmatter 或配置，不自动信任其 projectPath；文件引用仍需本地权限。下载失败、schema 失败和超限都删除临时文件并非零退出，不返回空会话假成功。

测试用 mock fetch/本地 HTTPS fixture 覆盖 URL 白名单、id 注入、redirect 跨域去 auth、超时、错误 content type、大小/行数限制、非法 JSONL、临时文件清理、fork 新 session 和不执行 transcript 中伪 hook。

## 6. 原 ant 维护 handlers 公开化

`src/cli/handlers/ant.ts` 拆成有类型的公共维护模块，`src/main.tsx` 中这些命令移出 ant-only 注册块。保留现有 CLI 参数形状是调用点约束，不表示存在旧实现兼容。

### 6.1 `logHandler` / `errorHandler`

- `logHandler(undefined)` 列出当前项目会话索引；number 用 `getLogByIndex()`，UUID 用 session resolver 和 `loadFullLog()`，显示真实消息渲染结果，不存在时非零退出。
- `errorHandler(undefined)` 用 `loadErrorLogs()` 列表；number（含负数）沿用 `getErrorLogByIndex()` 的排序/索引语义并输出错误内容。
- 复用 `src/utils/log.ts`、`src/utils/sessionStorage.ts`、`src/utils/exportRenderer.tsx`，不自行扫描一套不同排序。
- 外部构建若需持久错误日志，去除 `errorLogSink.ts` 的 ant 持久化限制，但仍尊重 `DISABLE_ERROR_REPORTING`/隐私策略，本地 JSONL 权限 `0600`；该写盘不是网络上报。

测试固定日志时间、0/正/负索引、UUID、空列表、损坏行、非 TTY 输出和持久化隐私开关。

### 6.2 `exportHandler`

source 严格分派：存在的 `.json/.jsonl` 文件用 `loadTranscriptFromFile()`，十进制索引用 `getLogByIndex()`，UUID 用 session resolver；其他输入报 usage。用真实 tools 调 `renderMessagesToPlainText()`，output 以 `wx` 写入且不覆盖，失败清理部分文件。无网络、无模型请求，输出可含敏感对话，CLI 不自动 redaction 也不上传。

测试三种 source、未知扩展、目录/symlink、拒绝覆盖、空消息、工具渲染、写失败和零网络。

### 6.3 Task handlers

`taskCreateHandler`、`taskListHandler`、`taskGetHandler`、`taskUpdateHandler`、`taskDirHandler` 直接复用 `src/utils/tasks.ts` 的 `createTask/getTask/listTasks/updateTask/getTasksDir`、`TASK_STATUSES`、`DEFAULT_TASKS_MODE_TASK_LIST_ID`，继承文件锁和 high-watermark：

- create：list 默认 `tasklist`，构造 pending、空 blocks/blockedBy，description 默认空字符串，打印分配的 id。
- list：按数值 id 排序；`--pending` 只保留 status=pending；`--json` 输出完整 Task 数组，其他模式为稳定文本。
- get：不存在返回非零，不创建文件。
- update：status 用 `TaskStatusSchema` 校验；owner 与 clearOwner 互斥；subject/description 可更新，保留 id 和依赖关系，打印更新后 Task。
- dir：只输出 `getTasksDir(list)`，不主动创建目录。

测试使用临时 `CLAUDE_CONFIG_DIR`，覆盖并发 create 不重复 id、pending/json、非法 status、互斥 owner、缺 id、dir 无副作用和锁释放。

### 6.4 `completionHandler`

支持且仅支持 bash/zsh/fish。从传入 Commander `program` 递归读取可见命令、参数和 options，生成静态补全脚本；hidden 命令维持 hidden，description 中的引号、反引号、`$()` 和换行按目标 shell 转义，不能形成可执行注入。stdout 为默认；`--output` 用 `wx` 原子写入，不调用 shell eval source。

测试用小型 Commander fixture 做三种 shell 快照，覆盖嵌套命令、option value、隐藏项、恶意 description、未知 shell、stdout/文件和拒绝覆盖；再在对应 shell 可用时做语法检查。

## 7. 总验收

1. external typecheck/build 后，目标文件不再包含 unavailable/no-op 伪实现；真实命令注册测试覆盖非 ant 环境。
2. server 用 fake 子进程端到端联通 HTTP、WebSocket、权限和 headless；Tungsten 用 fake tmux 验证隔离；MoreRight 验证 `@right` 不进入 query。
3. ccshare 只通过真实 HTTPS 响应恢复，维护 handlers 通过真实临时文件/任务存储产生结果。
4. 所有测试使用临时 HOME、配置目录、workspace、Git 仓库与 mock 网络，不依赖内部 DNS、内部服务、用户 tmux socket或真实凭据。
5. 依赖缺失只在实际调用时报告具体前置错误；成功路径均必须有可观察的真实副作用或读取结果，不能返回固定成功/null 完成验收。
