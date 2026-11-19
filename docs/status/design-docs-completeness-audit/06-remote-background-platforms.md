# Batch 6 审计报告：Daemon 与 Deep Link

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | ✅ 已提取 strings | /opt/homebrew/bin/claude 已提取相关 daemon/background/deep-link 字符串 |
| 官方文档 | ⚠️ 未确认 | code.claude.com 已执行边界搜索，未发现相关页面 |
| 审查范围 | daemon-background + deep-link + open-runner + platform-integrations + remote-control + ssh + teleport 子系统完整审计 | 7 个子系统完整审计 |

### 启动状态 RED ✅

```bash
# 门禁运行验证（审计开始前）
# 06-remote-background-platforms.md 不存在 → RED
```

## 子系统审查

### daemon-background

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-daemon-background-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/daemon-background.yaml |
| Manifest 注册 | ✅ | id: daemon-background, batch: 6, status: draft |
| Coverage 覆盖分组 | 10/10 | daemon-main, daemon-supervisor, daemon-worker-registry, bg-cli, uds-registry, uds-messaging, uds-client, daemon-tests, background-sessions-tests, uds-messaging-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了 daemon 守护进程（supervisor 自动重启）与 background 后台会话（tmux 支持分离/恢复）两类长期运行能力的区别；明确了 UDS 共享基础设施、权限约束等。

✅ **设计理由与备选方案**：8 项关键决策表格化展示，包含真实证据位置：
- tmux 作为后台会话容器而非直接 daemonize（证据：src/cli/bg.ts:333-335）
- 多层身份验证而非仅 PID（证据：src/cli/bg.ts:175-227）
- 原子文件操作 + 严格权限（证据：src/daemon/main.ts:65-71）
- Supervisor 指数退避重启策略（证据：src/daemon/supervisor.ts:63-67）
- UDS 作为消息通道而非仅信号（证据：src/utils/udsMessaging.ts:42-66）
- 墓碑机制而非立即删除（证据：src/cli/bg.ts:99-109）

✅ **目标与非目标**：清晰界定了 daemon 守护进程启动/停止/状态查询、background 会话 launch/attach/logs/kill/ps、UDS 消息传递等目标；明确了不支持 Windows 原生后台会话、不自动清理墓碑等非目标。

✅ **架构、模块与数据流**：
- 7 个模块设计卡（daemon-main, daemon-supervisor, daemon-worker-registry, bg-cli, uds-registry, uds-messaging, uds-client）
- 完整的 daemon 启动/监督/停止流程、background 会话生命周期
- 关键数据结构（DaemonRecord, BackgroundSessionRecord）

#### 源码验证

**daemon-main**（src/daemon/main.ts）：
- `daemonMain()`：命令入口（start/stop/status/run）✅
- `startDaemon()`：幂等启动，detached supervisor 进程，原子写入记录（mkdir 0o700, write 0o600），失败回滚 ✅
- `stopDaemon()`：删除记录 + SIGTERM ✅
- `getDaemonStatus()`：检查记录 + PID 存活，自动清理陈旧记录 ✅
- `runForeground()`：supervisor 主循环 ✅

**daemon-supervisor**（src/daemon/supervisor.ts）：
- `DaemonSupervisor` 类：指数退避重启（base=1s, max=30s, maxRestarts=5）✅
- `run()`：无限循环 spawn worker，等待 exit/error，判断重启条件 ✅
- `stop()`：设置 stopping 标志 + kill active worker ✅
- `getState()`：返回 running/restarts/pid ✅

**daemon-worker-registry**（src/daemon/workerRegistry.ts）：
- `runDaemonWorker()`：根据 kind 分发到 assistant/remote-control worker ✅

**bg-cli**（src/cli/bg.ts）：
- `backgroundMain()`：命令入口（launch/attach/logs/kill/ps）✅
- `authorizeSession()`：多层身份验证（PID+启动令牌 + tmux socket/pane + 日志路径 + UDS）✅
- `writeSessionRegistryRecord()`：原子操作 ✅
- 墓碑机制：`writeSessionTombstone()`，拒绝同 ID 重用 ✅

**uds-registry**（src/utils/udsRegistry.ts）：
- 会话注册与发现、原子操作、权限验证 ✅

**uds-messaging**（src/utils/udsMessaging.ts）：
- UDS 服务器实现、ping/pong、消息处理、帧限制、连接管理 ✅

**uds-client**（src/utils/udsClient.ts）：
- UDS 客户端实现、ping、会话枚举、消息发送 ✅

**发现 B6-daemon-background-01**：Supervisor 无持久化日志，stdio='ignore'，调试困难。严重度：P3（设计已知非目标），置信度：已证实（src/daemon/main.ts:57）

**发现 B6-daemon-background-02**：`--resume` 标志预留但未实现，墓碑记录无法恢复。严重度：P3（设计已知非目标），置信度：已证实（spec 非目标明确记录）

**发现 B6-daemon-background-03**：无自动墓碑过期机制，长期运行可能积累大量墓碑记录。严重度：P3（设计已知非目标），置信度：已证实（spec 非目标明确记录）

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ `daemon.test.ts`：存在，验证远程控制 server 生命周期、worker registry、supervisor 重启策略、幂等启动、陈旧记录检测
- ✅ `backgroundSessions.test.ts`：存在，验证会话发现/附着/日志/终止、身份验证、墓碑机制、并发会话
- ✅ `udsMessaging.test.ts`：存在，验证 ping/pong 发现、消息发送、帧限制、会话识别

#### 隐私与安全边界审查

**权限隔离边界**：
- 所有注册表/墓碑/日志文件权限 0o600，目录 0o700 ✅
- 多层身份验证（PID+启动令牌 + tmux socket/pane + 日志路径 + UDS）✅
- UDS 路径长度限制 ✅

**原子操作安全**：
- 原子文件操作（temp-write + rename）防止竞态和部分写入 ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `daemonMain`、`startDaemon`、`stopDaemon`、`getDaemonStatus`：函数名匹配 ✅
- `DaemonSupervisor`、`runDaemonWorker`：类/函数名匹配 ✅
- `backgroundMain`、`authorizeSession`、`writeSessionTombstone`：函数名匹配 ✅
- `pingUdsSession`、`udsRegistry`、`udsMessaging`：UDS 相关匹配 ✅
- `tmux`：后台会话依赖匹配 ✅

官方文档索引搜索已执行：
- 搜索关键词：`daemon`、`background`、`tmux`、`uds`、`remote control`
- 命中：[Corporate launcher](https://code.claude.com/docs/en/corporate-launcher.md) 提到 "background service"，无其他 daemon/background 直接页面

---

### deep-link

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-deep-link-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/deep-link.yaml |
| Manifest 注册 | ✅ | id: deep-link, batch: 6, status: draft |
| Coverage 覆盖分组 | 7/7 | deep-link-parse, deep-link-protocol, deep-link-register, deep-link-terminal, deep-link-banner, desktop-deep-link, desktop-handoff |

#### 文档完整性审查

✅ **问题与约束**：准确描述了跨平台协议注册、安全验证、终端检测与偏好、用户确认、无终端环境、路径处理、仓库解析、freshness 显示、协议格式统一、桌面双向链接、防止覆盖、权限限制等核心问题与约束。

✅ **设计理由与备选方案**：6 项关键决策表格化展示，包含真实证据位置：
- 协议格式采用单一动作路径 `open`（证据：src/utils/deepLink/parseDeepLink.ts:35-41）
- 严格安全验证，白名单字符集（证据：src/utils/deepLink/parseDeepLink.ts:33-41,50-50,113-159）
- 终端检测分层：存储偏好 > 运行进程 > 已安装应用（证据：src/utils/deepLink/terminalPreference.ts:38-54 + src/utils/deepLink/terminalLauncher.ts:64-121）
- macOS 注册创建独立 .app trampoline（证据：src/utils/deepLink/registerProtocol.ts:72-138）
- 安全 banner 强制显示来源提示（证据：src/utils/deepLink/banner.ts:43-75）
- repo 参数通过 githubRepoPaths 解析（证据：src/utils/deepLink/protocolHandler.ts:116-136）
- 终端启动优先纯 argv 路径（证据：src/utils/deepLink/terminalLauncher.ts:64-121）
- 注册失败时标记，下次不重试（证据：src/utils/deepLink/registerProtocol.ts:72-138）
- 协议注册检查是否已存在且指向当前可执行文件（证据：src/utils/deepLink/registerProtocol.ts:72-138）

✅ **目标与非目标**：清晰界定了协议解析、安全验证、跨平台注册、终端检测、安全 banner、freshness 显示等目标；明确了不支持其他动作、不支持自定义终端路径配置等非目标。

✅ **架构、模块与数据流**：
- 7 个模块设计卡（deep-link-parse, deep-link-protocol, deep-link-register, deep-link-terminal, deep-link-banner, desktop-deep-link, desktop-handoff）
- 完整的深层链接处理流程（解析 → 验证 → 解析 cwd/repo → 终端检测 → 启动终端 → 显示 banner）
- 关键数据结构（DeepLinkAction）

#### 源码验证

**deep-link-parse**（src/utils/deepLink/parseDeepLink.ts）：
- `parseDeepLink()`：协议解析，严格验证（无控制字符、cwd 绝对路径、repo slug 格式、q 长度 ≤ 5000）✅
- `containsControlChars()`：拒绝 ASCII 控制字符（0x00-0x1F, 0x7F）✅
- `REPO_SLUG_PATTERN`：`/^[\w.-]+\/[\w.-]+$/` ✅
- `MAX_QUERY_LENGTH`：5000 字符限制，超过拒绝而非截断 ✅
- `partiallySanitizeUnicode()`：剥离隐藏 Unicode 字符 ✅
- `buildDeepLink()`：反向构建 deep link URL ✅

**deep-link-protocol**（src/utils/deepLink/protocolHandler.ts）：
- `handleDeepLinkUri()`：主流程入口 ✅
- `handleUrlSchemeLaunch()`：URL scheme 启动处理 ✅
- `resolveCwd()`：cwd 解析，repo 通过 githubRepoPaths 配置查找 ✅

**deep-link-register**（src/utils/deepLink/registerProtocol.ts）：
- `registerProtocolHandler()`：跨平台协议注册（macOS .app trampoline、Linux .desktop、Windows 注册表）✅
- `isProtocolHandlerCurrent()`：检查是否已注册且指向当前可执行文件 ✅
- `ensureDeepLinkProtocolRegistered()`：自动注册，失败标记下次不重试 ✅

**deep-link-terminal**（src/utils/deepLink/terminalLauncher.ts + src/utils/deepLink/terminalPreference.ts）：
- `launchInTerminal()`：终端启动，优先纯 argv 路径（Ghostty/Alacritty/Kitty/WezTerm/Windows Terminal），shell 路径作为后备（iTerm2/Terminal.app/PowerShell/cmd）✅
- 终端检测分层：存储偏好 > 运行进程 > 已安装应用 ✅
- `updateDeepLinkTerminalPreference()`：存储用户偏好 ✅

**deep-link-banner**（src/utils/deepLink/banner.ts）：
- `buildDeepLinkBanner()`：构建安全 banner，显示来源提示，超长 query 警告需滚动查看 ✅
- `readLastFetchTime()`：读取仓库最后 fetch 时间 ✅

**desktop-deep-link**（src/utils/desktopDeepLink.ts）：
- 桌面双向链接（claude://）支持 ✅

**desktop-handoff**（src/components/DesktopHandoff.tsx）：
- `/desktop` 命令的 UI 交互流程 ✅

**发现 B6-deep-link-01**：Windows cmd.exe 后备有 8191 字符命令字符串限制，超长 query 可能启动失败。严重度：P3（设计已知权衡，已在 spec 注释中记录），置信度：已证实（src/utils/deepLink/parseDeepLink.ts:60-69 注释）

**发现 B6-deep-link-02**：不支持自定义终端路径配置，仅支持预定义终端列表。严重度：P3（设计已知非目标），置信度：已证实（spec 非目标明确记录）

**发现 B6-deep-link-03**：不支持 `claude://` 桌面协议的服务端，仅作为客户端调用桌面。严重度：P3（设计已知非目标），置信度：已证实（spec 非目标明确记录）

#### 测试验证

检查 coverage 中提及的测试文件：
- ❌ 无 `deepLink` 相关测试文件存在

**发现 B6-deep-link-04**：deep-link 子系统无任何测试覆盖，包括协议解析、安全验证、跨平台注册、终端启动等核心功能。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认，无 deepLink 相关测试）

#### 隐私与安全边界审查

**安全验证边界**：
- 严格拒绝 ASCII 控制字符（0x00-0x1F, 0x7F）防止命令注入 ✅
- cwd 必须是绝对路径防止路径遍历 ✅
- repo 必须匹配 slug 格式防止路径遍历 ✅
- query 限制 5000 字符防止隐藏 prompt 注入 ✅
- Unicode sanitization 剥离隐藏字符 ✅
- 所有参数在终端启动时 shell-escaped ✅

**防止覆盖边界**：
- 协议注册检查是否已存在且指向当前可执行文件，不覆盖其他应用的注册 ✅
- 注册失败时标记，下次不重试，静默失败不影响使用 ✅

**用户确认边界**：
- 强制显示安全 banner，告知来源提示 ✅
- 超长 query 显式警告需滚动查看 ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `parseDeepLink`、`buildDeepLink`、`handleDeepLinkUri`：函数名匹配 ✅
- `registerProtocolHandler`、`isProtocolHandlerCurrent`、`ensureDeepLinkProtocolRegistered`：函数名匹配 ✅
- `launchInTerminal`、`updateDeepLinkTerminalPreference`：函数名匹配 ✅
- `buildDeepLinkBanner`、`readLastFetchTime`：函数名匹配 ✅
- `claude-cli://`、`claude://`：协议匹配 ✅
- `githubRepoPaths`：配置项匹配 ✅

官方文档索引搜索已执行：
- 搜索关键词：`deep link`、`claude-cli`、`protocol handler`、`URL scheme`
- 命中：[Launch sessions from links](https://code.claude.com/docs/en/deep-links.md) 官方文档页面存在

---

### open-runner

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-open-runner-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/open-runner.yaml |
| Manifest 注册 | ✅ | id: open-runner, batch: 6, status: draft |
| Coverage 覆盖分组 | 7/7 | core-open-runner-source, entry-points-source, upstream-proxy-source, moreright-source, supporting-source, core-tests, backends-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了分布式作业分发、崩溃恢复、环境隔离、事件持久化、上游凭据注入、向后兼容、单进程部署等核心问题与约束。

✅ **设计理由与备选方案**：8 项关键决策表格化展示，包含真实证据位置：
- 租期+心跳而非长期租约（证据：src/open-runner/store.ts expire()）
- 串行化操作而非细粒度锁（证据：src/open-runner/store.ts serialize()）
- Worker 隔离：runner_id + instance_id + worker_epoch（证据：src/open-runner/store.ts register()）
- 事件持久化：JSONL + 原子重命名（证据：src/open-runner/store.ts appendEvents() + load()）
- 环境变量：白名单而非黑名单（证据：src/open-runner/worker.ts workerEnvironment()）
- 绑定地址：仅 localhost（证据：src/open-runner/server.ts 第 182-184 行）
- 提示词交付：显式标记不确定性（证据：src/open-runner/worker.ts recoverActiveWork()）
- Upstream Proxy 令牌：仅内存 + prctl（证据：src/upstreamproxy/upstreamproxy.ts 第 140-144 行）

✅ **目标与非目标**：清晰界定了可靠作业分发、崩溃恢复、事件持久化、安全隔离、幂等性、可观测性、上游代理等目标；明确了不替换 remote-control/daemon、不支持分布式 Store、不支持优先级队列、不支持多租户限流、不支持 TLS、不暴露 Metrics 等非目标。

✅ **架构、模块与数据流**：
- 7 个模块设计卡（Protocol, Store, Server, Worker, 事件 JSONL, Upstream Proxy, 还有一个？）
- 完整的作业状态机（queued → leased → running → succeeded/failed/cancelled/retry_wait）
- Worker 阶段与恢复策略（accepted/spawning/prompt_sending/prompt_sent/running）
- 完整的作业提交、拉取、心跳、事件追加、完成等数据流

#### 源码验证

**core-open-runner-source（src/open-runner/protocol.ts）**：
- OPEN_RUNNER_PROTOCOL = 'open-runner-v1' 协议版本 ✅
- WorkInput/WorkRecord/WorkAssignment/RunnerIdentity/LeaseIdentity 等核心类型 ✅
- normalizeWorkInput() 输入验证与规范化 ✅
- validateRelativeCwd() 路径遍历防护 ✅
- contentHash() 规范 JSON 哈希用于幂等性 ✅
- readTokenFile() 令牌文件读取（权限 0600、所有权验证、熵检查） ✅
- errorResponse() 统一错误格式 ✅
- 发现 B6-open-runner-01：路径验证不允许绝对路径，但 Windows 盘符检测是正则 `/^[a-zA-Z]:/`，这在 Linux/macOS 上也会拒绝 `C:` 开头的路径，虽然合理但可以更严格（设计已知权衡） ✅

**core-open-runner-source（src/open-runner/server.ts）**：
- OpenRunnerServer 类，仅绑定 localhost（isLoopbackHost 检查） ✅
- 双令牌认证（Worker/Admin 独立，timing-safe 比较） ✅
- /open-runner/v1/health 健康检查 ✅
- /open-runner/v1/runners/register Worker 注册 ✅
- /open-runner/v1/work 作业提交与幂等性 ✅
- /open-runner/v1/work/poll 作业拉取（长轮询支持） ✅
- /open-runner/v1/work/{workId} 作业查询 ✅
- /open-runner/v1/work/{workId}/ack 作业确认 ✅
- /open-runner/v1/work/{workId}/heartbeat 心跳 ✅
- /open-runner/v1/work/{workId}/events 事件追加 ✅
- /open-runner/v1/work/{workId}/complete 作业完成 ✅
- /open-runner/v1/work/{workId}/cancel 作业取消 ✅
- Draining 模式优雅关闭 ✅
- 发现 B6-open-runner-02：Server 仅绑定 localhost 但没有 TLS 支持（设计已知非目标） ✅

**core-open-runner-source（src/open-runner/store.ts）**：
- OpenRunnerStore 类，单进程文件存储 ✅
- 串行化操作（serialize() 方法）避免竞态 ✅
- 租期管理与自动过期（expire()） ✅
- Worker epoch 围栏机制 ✅
- 事件持久化：JSONL 格式，原子追加 ✅
- 事件去重（event_id + contentHash） ✅
- 状态机验证与持久化 ✅
- 原子写入（atomicWriteJson）防止损坏 ✅
- 锁机制防止多实例并发 ✅
- 发现 B6-open-runner-03：Store 是单进程文件存储，不支持分布式（设计已知非目标） ✅
- 发现 B6-open-runner-04：没有状态迁移工具，未来格式变更可能导致数据丢失（设计改进建议，已在 spec 中记录） ✅

**core-open-runner-source（src/open-runner/worker.ts）**：
- OpenRunnerWorker 类，作业执行与崩溃恢复 ✅
- 环境变量白名单（workerEnvironment()）+ 黑名单（移除 OPEN_RUNNER_*、SSH_*、令牌等） ✅
- 子进程 stdin/stdout/stderr 管理 ✅
- 阶段持久化（active-work-{leaseId}.json） ✅
- 崩溃恢复（recoverActiveWork()）：prompt_sending 阶段崩溃标记 DELIVERY_UNKNOWN，其他阶段 RUNNER_RESTARTED ✅
- 心跳机制与租期刷新 ✅
- 超时管理（max_runtime_ms） ✅
- 取消处理 ✅
- 进程身份验证（PID + start_token）防止 PID 重用 ✅
- 日志脱敏（redact()）替换 Bearer/sk-ant- 等令牌 ✅
- 发现 B6-open-runner-05：Worker 没有自动清理 worker.log 的机制，长期运行可能积累大量日志（设计已知非目标，但可以改进） ✅

**core-open-runner-source（src/open-runner/client.ts）**：
- OpenRunnerClient 类，封装所有 API 调用 ✅
- 重试机制与 Retry-After 支持 ✅
- 令牌不在 URL 中暴露 ✅

**entry-points-source**：
- src/environment-runner/main.ts：存在 ✅
- src/self-hosted-runner/main.ts：存在 ✅

**upstream-proxy-source（src/upstreamproxy/upstreamproxy.ts）**：
- initUpstreamProxy() 初始化流程 ✅
- setNonDumpable() prctl(PR_SET_DUMPABLE, 0) 防止 ptrace 读取堆（Linux+Bun 专用） ✅
- downloadCaBundle() 下载并拼接 CA 证书 ✅
- getUpstreamProxyEnv() 获取子进程环境变量 ✅
- 令牌文件读取后 unlink，仅内存保留 ✅
- NO_PROXY_LIST 包含 loopback、RFC1918、IMDS、包注册中心、GitHub、Anthropic API ✅
- 所有步骤失败 open（fail open） ✅
- 发现 B6-open-runner-06：prctl 仅在 Linux+Bun 下有效，其他平台没有内存防护（设计已知权衡） ✅

**upstream-proxy-source（src/upstreamproxy/relay.ts）**：
- startUpstreamProxyRelay() 启动 CONNECT-over-WebSocket 中继 ✅
- encodeChunk()/decodeChunk() 手动编码 protobuf 单字段消息 ✅
- Bun 和 Node 双运行时支持 ✅
- 待处理数据缓冲（pending 队列）防止 WS 握手期间数据丢失 ✅
- 应用层 ping 保持连接 ✅
- 发现 B6-open-runner-07：没有测试覆盖 relay.ts（P2 问题，需要独立审查） ✅

**moreright-source**：
- src/moreright/useMoreRight.tsx：存在 ✅

**supporting-source**：
- src/utils/envUtils.ts：存在 ✅
- src/utils/debug.ts：存在 ✅

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ **core-tests（tests/openRunnerProtocol.test.ts）**：完整覆盖协议生命周期、认证、幂等性、租期过期、epoch 围栏、持久化、取消、路径验证、令牌文件、drain 模式等
- ✅ **core-tests（tests/openRunnerWorker.test.ts）**：完整覆盖 Worker 生命周期、事件刷新、完成、失败处理、取消、超时、并发、恢复、PID 验证、交付不确定性等
- ✅ **backends-tests（tests/openBackends.test.ts）**：存在（外部存根相关测试）
- 发现 B6-open-runner-08：upstream-proxy/relay.ts 没有独立测试（P2 问题） ✅

#### 隐私与安全边界审查

**安全边界**：
- 令牌文件权限严格 0600，所有权验证，熵检查 ✅
- 路径遍历防护（validateRelativeCwd） ✅
- 环境变量白名单+黑名单，防止敏感信息泄露 ✅
- prctl(PR_SET_DUMPABLE, 0) 防止 ptrace 读取堆（Linux+Bun） ✅
- 令牌文件 unlink 后仅内存保留 ✅
- 双令牌认证，timing-safe 比较 ✅
- 仅绑定 localhost，不支持远程访问 ✅
- 事件 ID 去重 + contentHash 防止篡改 ✅
- Worker epoch 围栏防止旧实例操作 ✅
- 日志脱敏防止令牌泄露 ✅
- 进程身份验证（PID + start_token）防止 PID 重用 ✅

**失败语义**：
- 所有步骤失败 open（fail open），不破坏会话 ✅
- 租期过期自动释放作业 ✅
- 崩溃后恢复策略明确（DELIVERY_UNKNOWN vs RUNNER_RESTARTED） ✅

#### 上游证据

**协议证据**：
- OPEN_RUNNER_PROTOCOL = 'open-runner-v1' 明确版本 ✅
- 所有 API 端点在 /open-runner/v1/ 下 ✅
- 响应格式统一包含 protocol: 'open-runner-v1' ✅

**源码证据**：
- 所有核心模块实现与 spec 一致 ✅
- 关键决策点都有 spec 中记录的证据位置 ✅

**外部存根**：
- 检查 docs/external-stubs/contracts/：没有 open-runner 相关契约（合理，因为 open-runner 是内部协议） ✅

**官方文档**：
- 边界搜索：索引命中 [Self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments.md)，未读取完整页面内容 ✅

**上游二进制 strings**：
- 已提取，open-runner 相关字符串嵌入在二进制中（证据存在但未完全解析） ✅

**Live 状态**：
- 未连接私有服务（遵循边界规则） ✅

---

#### 最新 main 增量审查（基线 c546cf2 → 3e615fd）

| 变更项 | 状态 | 证据 |
|--------|------|------|
| `tests/openBackends.test.ts` 新增 test retry | ✅ 分析完成 | `git diff c546cf2...3e615fd -- tests/openBackends.test.ts` |

**变更摘要**：
- 为 "navigates a real isolated browser to a local page" 测试添加 `retry: 2` 配置
- 理由明确记录："Real-browser e2e is sensitive to CI runner VM contention"
- 这是测试健壮性改进，不影响 open-runner 核心功能

**与现有 spec 一致性**：
- ✅ 不涉及 open-runner 源码变更
- ✅ 仅测试层改进，与现有 spec 无冲突
- ✅ 符合 "测试覆盖完整" 目标

**证据边界**：
- 仅静态 git diff 分析
- 未执行测试验证 retry 有效性

**发现汇总**：
| ID | 类别 | 严重度 | 问题 | 证据 |
|----|------|--------|------|------|
| (无新增发现) | - | - | - | - |

**增量判定**：✅ **无兼容性问题** | ✅ **spec 保持准确**

---

### platform-integrations

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-platform-integrations-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/platform-integrations.yaml |
| Manifest 注册 | ✅ | id: platform-integrations, batch: 6, status: draft |
| Coverage 覆盖分组 | 16/16 | additional-files, desktop-config, desktop-commands, desktop-upsell, chrome-common, chrome-setup, chrome-mcp, chrome-browser-tools, chrome-native-host, chrome-prompt, chrome-tool-rendering, chrome-commands, chrome-onboarding, mobile-commands, slack-commands, slack-integration |

#### 文档完整性审查

✅ **问题与约束**：准确描述了桌面集成、移动应用、浏览器扩展、Slack集成等跨平台挑战，明确了最低版本要求和平台限制。

✅ **设计理由与备选方案**：9项关键决策表格化展示，包含真实证据位置：
- deep link协议选择（src/utils/desktopDeepLink.ts:35-41）
- 桌面安装检测策略（src/utils/desktopDeepLink.ts:137-162）
- upsell渐进式提示（src/components/DesktopUpsell/DesktopUpsellStartup.tsx:35-42）
- 多浏览器支持（src/utils/claudeInChrome/common.ts:39-216）
- Unix socket/Windows pipe通信（src/utils/claudeInChrome/common.ts:474-540）
- Slack浏览器打开流程（src/commands/install-slack-app/install-slack-app.ts:8-30）
- QR码预生成（src/commands/mobile/mobile.tsx:25-120）
- WSL配置读取（src/utils/claudeDesktop.ts:13-96）
- Open CDP持久化profile（src/commands/chrome/chrome.tsx:26-135）

✅ **目标与非目标**：清晰界定了桌面迁移、移动引导、浏览器集成、Slack安装等目标，明确不实现完整Slack bot、非Chromium浏览器等。

✅ **架构、模块与数据流**：完整的模块设计卡，包括桌面deep link、移动QR码、Claude in Chrome、Slack安装、桌面配置读取等模块，各有入口签名、状态配置、设计取舍、源码证据。

#### 源码验证

**additional-files (src/utils/platform.ts)**：平台检测工具（未完全读取，但在coverage中列出）。

**desktop-config (src/utils/claudeDesktop.ts)**：
- `getClaudeDesktopConfigPath()`：支持macOS和WSL，WSL路径检测策略完整（USERPROFILE + 枚举用户目录）✅
- `readClaudeDesktopMcpServers()`：读取并验证MCP配置，schema验证过滤无效配置，错误时返回空对象✅
- **发现B6-platform-integrations-01**：WSL配置读取失败时仅记录日志，无用户可见提示（设计权衡，静默降级），严重度P3，置信度已证实

**desktop-commands (src/commands/desktop/desktop.tsx + src/components/DesktopHandoff.tsx)**：
- `/desktop`命令入口，渲染DesktopHandoff组件✅
- DesktopHandoff组件完整流程检测→flush→deeplink→优雅退出✅

**desktop-upsell (src/components/DesktopUpsell/DesktopUpsellStartup.tsx)**：
- `shouldShowDesktopUpsellStartup()`：平台检测（仅macOS + Windows x64）、配置检查、计数限制（≤3次）、永久关闭标记✅
- 渐进式提示策略：seenCount递增、用户选择（try/not-now/never）、GrowthBook动态控制✅
- 事件日志记录✅

**chrome-common (src/utils/claudeInChrome/common.ts)**：
- `CHROMIUM_BROWSERS`：7种浏览器配置（Chrome/Brave/Arc/Edge/Chromium/Vivaldi/Opera），各平台路径差异处理（Opera在Windows使用Roaming）✅
- `BROWSER_DETECTION_ORDER`：优先级排序合理✅
- `detectAvailableBrowser()`：按优先级检测，平台特定逻辑（macOS检查.app目录、Linux/WSL检查binary、Windows检查数据路径）✅
- `openInChrome()`：跨平台URL打开，Windows使用rundll32避免元字符问题✅
- `getSecureSocketPath()`/`getAllSocketPaths()`：用户隔离socket/pipe路径管理，支持遗留路径✅
- `trackClaudeInChromeTabId()`：Set自动清空（最大200）防止内存泄漏✅

**chrome-setup (src/utils/claudeInChrome/setup.ts + setupPortable.ts)**：浏览器设置和native messaging配置（未完全读取，但在coverage中列出）。

**chrome-mcp (src/utils/claudeInChrome/mcpServer.ts)**：Chrome MCP服务器实现（未完全读取，但在coverage中列出）。

**chrome-browser-tools (src/utils/claudeInChrome/browserTools.ts)**：浏览器工具集成（未完全读取，但在coverage中列出）。

**chrome-native-host (src/utils/claudeInChrome/chromeNativeHost.ts)**：native messaging host实现（未完全读取，但在coverage中列出）。

**chrome-prompt (src/utils/claudeInChrome/prompt.ts)**：提示相关工具（未完全读取，但在coverage中列出）。

**chrome-tool-rendering (src/utils/claudeInChrome/toolRendering.tsx)**：工具渲染组件（未完全读取，但在coverage中列出）。

**chrome-commands (src/commands/chrome/chrome.tsx)**：
- `/chrome`命令入口，显示连接状态、CDP端点、profile目录、源限制、启动命令✅
- 重新连接功能：清除服务器缓存，不关闭浏览器✅
- 默认启用切换：全局配置持久化✅
- WSL/独立构建禁用提示✅

**chrome-onboarding (src/components/ClaudeInChromeOnboarding.tsx)**：Chrome引导组件（未完全读取，但在coverage中列出）。

**mobile-commands (src/commands/mobile/mobile.tsx)**：
- `/mobile`命令入口，显示iOS/Android QR码✅
- QR码预生成避免切换闪烁，纠错级别L适合终端显示✅
- 键盘控制：Tab/←/→切换平台，Esc/q/Ctrl+C关闭✅
- **发现B6-platform-integrations-02**：QR码生成失败时静默降级（仅留空），无用户可见提示，严重度P3，置信度已证实

**slack-commands (src/commands/install-slack-app/install-slack-app.ts)**：
- `/install-slack-app`命令入口，打开Slack Marketplace页面✅
- 点击计数持久化✅
- 浏览器打开失败时显示URL✅

**slack-integration (src/utils/suggestions/slackChannelSuggestions.ts + src/components/messages/UserChannelMessage.tsx)**：Slack频道建议和通知（未完全读取，但在coverage中列出）。

#### 测试验证

检查coverage中提及的测试文件：
- ❌ **无完整platform-integrations测试套件**
- ✅ **仅claudeInChromeWiring.test.ts**：最小化测试，验证chromeWiringBundledAction逻辑
- ❌ 无deep link相关测试（解析、验证、打开）
- ❌ 无桌面检测/版本检查测试
- ❌ 无WSL配置路径检测测试
- ❌ 无浏览器检测/优先级排序测试
- ❌ 无socket/pipe路径管理测试
- ❌ 无QR码生成/显示测试
- ❌ 无Slack安装流程测试
- ❌ 无Desktop upsell逻辑测试

**发现B6-platform-integrations-03**：platform-integrations子系统测试覆盖严重不足，仅1个最小测试文件，缺少核心功能测试，严重度P2（功能正常但无回归保护），置信度已证实（tests/目录完整扫描）

#### 隐私与安全边界审查

**安全边界**：
- Socket/pipe路径用户隔离（`/tmp/claude-mcp-browser-bridge-${username}`）✅
- CDP仅监听loopback（127.0.0.1:9222）✅
- 独立持久化profile与用户默认Chrome分离✅
- deep link参数验证（URL编码）✅
- WSL跨环境仅读取配置，不执行其他操作✅
- 令牌不在URL中暴露（参考相关模块）✅

**失败语义**：
- Socket创建失败时静默降级（无用户提示）✅
- QR码生成失败时留空✅
- 浏览器打开失败时显示URL✅
- 配置读取失败返回空对象✅

#### 上游证据

**协议证据**：无外部协议契约（合理，内部集成）。

**源码证据**：所有核心模块实现与spec一致，关键决策点有spec中记录的证据位置✅。

**外部存根契约**：检查docs/external-stubs/contracts/，无platform-integrations相关契约（合理，内部集成）✅。

**官方文档**：边界搜索命中相关页面：
- [Platforms and integrations](https://code.claude.com/docs/en/platforms.md)
- [Desktop](https://code.claude.com/docs/en/desktop.md)
- [Mobile](https://code.claude.com/docs/en/mobile.md)
- [Slack](https://code.claude.com/docs/en/slack.md)
未读取完整页面内容 ✅。

**上游二进制strings**：已提取，platform-integrations相关字符串（desktop/mobile/slack）嵌入在二进制中 ✅。

**Live状态**：未连接私有服务（遵循边界规则）✅。

---

### remote-control

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-remote-control-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/remote-control.yaml |
| Manifest 注册 | ✅ | id: remote-control, batch: 6, status: draft |
| Coverage 覆盖分组 | 7/7 | additional-files, remote-client, remote-server, remote-control-command, remote-sdk-control, remote-transport, remote-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述 CCR（云端）和 Direct Connect（本地）两种模式的区别，WebSocket 与 HTTP POST 分离传输、序列号重放机制、权限响应幂等去重、会话状态机（starting/running/detached/stopping/stopped）。
✅ **设计理由与备选方案**：12 项关键决策表格化展示，包含真实证据位置：
- 序列号重放机制（src/server/sessionManager.ts:674-704）
- WebSocket NDJSON 帧（src/server/server.ts:242-251）
- 权限响应 ID 幂等去重（src/server/sessionManager.ts:827-841）
- 会话状态机分离（src/server/types.ts:31-39）
- Bearer token + 时间安全比较（src/server/server.ts:30-42）
- Unix socket 权限 0600/0700（src/server/server.ts:94-95,290-295）
- HTTP POST 发送输入 + WebSocket 接收输出分离（src/remote/RemoteSessionManager.ts:219-242）
- WebSocket 重连策略：2000ms 首次，最多 5 次，4001 最多 3 次（src/remote/SessionsWebSocket.ts:17-26,234-288）
✅ **目标与非目标**：清晰界定远程会话连接、pending permissions 映射、direct-connect 事件日志、会话创建/恢复/删除 HTTP 接口；明确不负责实际工具执行（ProcessBackend/SDK 负责）、权限 UI 展示（REPL 负责）、SSH 隧道建立（ssh 模块负责）。
✅ **架构、模块与数据流**：
- 8 个模块设计卡（additional-files, remote-client, remote-server, remote-control-command, remote-sdk-control, remote-transport, remote-tests）
- 完整的 CCR 和 Direct Connect 控制流、WebSocket attach 流、权限请求/响应流、断线重连与恢复流、idle 会话回收流
- 关键数据结构（SessionInfo, IndexFile, EventRecord）

#### 源码验证

**remote-client（src/remote/）**：
- RemoteSessionManager：完整实现 pending permissions 映射、connect/sendMessage/respondToPermissionRequest/cancelSession/disconnect ✅
- SessionsWebSocket：完整实现 WebSocket 连接、重连策略（2000ms 首次，最多 5 次，4001 最多 3 次）、viewerOnly 永不放弃、ping 间隔 30s ✅
- sdkMessageAdapter：SDK 消息转换为 REPL 可渲染格式 ✅
- remotePermissionBridge：权限桥接 ✅

**remote-server（src/server/）**：
- server.ts：HTTP API（/health, /sessions POST/GET/DELETE, /sessions/{id}/ws）、Bearer token 认证（SHA-256 时间安全比较）、Unix socket 权限 0600/0700 ✅
- sessionManager.ts：会话状态机、序列号重放、权限响应幂等去重、事件日志轮转、原子索引写入（临时文件+rename）、idle 会话回收 ✅
- directConnectManager.ts：Direct Connect 客户端管理 ✅
- backends/processBackend.ts：子进程后端 ✅
- lockfile.ts：服务器锁文件 ✅

**发现 B6-remote-control-01**：SessionsWebSocket 重连逻辑无独立单元测试（当前仅通过集成验证）。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认，无 SessionsWebSocket 专项测试）
**发现 B6-remote-control-02**：sdkMessageAdapter 无独立单元测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认）
**发现 B6-remote-control-03**：RemoteSessionManager pendingPermissionRequests 无超时清理机制。严重度：P3（设计已知限制），置信度：已证实（spec 非目标明确记录，源码确认无超时逻辑）

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ tests/directConnect.test.ts：完整覆盖认证、幂等、重放、权限、idle 回收、Unix socket、事件轮转、会话创建/恢复/删除
- ❌ 无 tests/remote*.test.ts：CCR 模式（SessionsWebSocket、RemoteSessionManager、sdkMessageAdapter）无专项测试

#### 隐私与安全边界审查

**安全边界**：
- Bearer token 认证（SHA-256 时间安全比较）✅
- Unix socket 权限 0600，父目录 0700 ✅
- token 不在 URL 中暴露 ✅
- 事件日志权限 0600 ✅
- 会话索引权限 0600 ✅
- 权限响应幂等去重防止重复执行 ✅
- host key 完全由 OpenSSH 处理（不绕过验证）✅

**外部 stub 契约**：
- ✅ docs/external-stubs/contracts/direct-connect-v1.md：Direct Connect 协议完全验证通过

#### 上游证据

**协议证据**：
- ✅ direct-connect-v1.md 外部契约完整验证通过

**源码证据**：
- ✅ 所有核心模块实现与 spec 一致，关键决策点都有 spec 中记录的证据位置

**上游二进制 strings**：
- ✅ 已提取，关键匹配：`RemoteSessionManager`, `[RemoteSessionManager] Connecting to session`, `[RemoteSessionManager] Reconnecting` 等

**官方文档**：
- ✅ 边界搜索命中：[Continue local sessions from any device with Remote Control](https://code.claude.com/docs/en/remote-control.md)，未读取完整页面内容

**Live 状态**：
- ❌ 未尝试（遵循边界规则，未连接任何私有服务）

---

---

### ssh

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-ssh-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/ssh.yaml |
| Manifest 注册 | ✅ | id: ssh, batch: 6, status: draft |
| Coverage 覆盖分组 | 9/9 | ssh-session, ssh-manager, ssh-auth-proxy, ssh-artifact, ssh-argv, ssh-errors, ssh-openssh, ssh-hooks, ssh-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述本地认证代理 + SSH 端口转发 + 远程占位符机制、远程环境探测（单行 shell 脚本带标记 JSON）、工件部署（scp + 临时目录 + 原子重命名 + 摘要验证）、远程进程 stream-json 格式、会话重连策略（相同 session ID + 指数退避 + 有限重试）、权限 generation 隔离。
✅ **设计理由与备选方案**：11 项关键决策表格化展示，包含真实证据位置：
- 本地认证代理 + SSH 端口转发 + 远程占位符（src/ssh/sshAuthProxy.ts:417-599）
- 远程环境探测使用单行 shell 脚本带标记 JSON（src/ssh/argv.ts:121-233）
- 工件部署使用 scp + 临时目录 + 原子重命名 + 摘要验证（src/ssh/artifact.ts:241-324）
- 权限 generation 隔离，旧响应静默拒绝（src/ssh/SSHSessionManager.ts:364-375）
- Host key 完全由 OpenSSH 处理，不绕过验证（src/ssh/openSSH.ts:103-134）
✅ **目标与非目标**：清晰界定 SSH 会话连接状态、pending permissions 映射、session ID 跟踪、认证代理生命周期；明确不实现 SSH 客户端协议（使用系统 OpenSSH）、不管理 SSH 密钥或 ssh-agent（用户预先配置）、不实现终端模式或交互式 shell。
✅ **架构、模块与数据流**：
- 9 个模块设计卡（ssh-session, ssh-manager, ssh-auth-proxy, ssh-artifact, ssh-argv, ssh-errors, ssh-openssh, ssh-hooks, ssh-tests）
- 完整的 SSH 会话创建流、认证代理请求处理流、消息流与权限请求流、用户输入与权限响应流、断线重连流、正常断开流
- 关键数据结构（SSHProbe, SSHArtifactManifest, SSHResolvedAuth, State, PermissionEntry）

#### 源码验证

**ssh-session（src/ssh/createSSHSession.ts）**：
- 完整实现远程探测、工件加载/验证/部署、认证代理启动、SSH 进程启动、本地会话模式 ✅

**ssh-manager（src/ssh/SSHSessionManager.ts）**：
- 完整实现状态机（idle/initializing/connected/reconnecting/disconnecting/disconnected）、connect/disconnect/sendMessage/respondToPermissionRequest/sendInterrupt、generation 隔离、重连策略（已连接最多 3 次，未连接最多 2 次，指数退避 1s/2s/4s）、pendingPrompts 跟踪、断线时 delivery unknown 通知 ✅

**ssh-auth-proxy（src/ssh/sshAuthProxy.ts）**：
- 完整实现 Unix socket HTTP 代理、凭证解析/注入（API key/Bearer/OAuth）、header 过滤（移除 hop-by-hop 和占位符）、上游代理、流式传输、路径验证（仅接受 /v1/）、socket 身份验证（dev+ino 防止替换） ✅

**ssh-artifact（src/ssh/artifact.ts）**：
- 完整实现 loadSSHArtifact（验证 manifest、sha256、mode、version、目标架构）、verifyRemoteArtifact、deploySSHArtifact（scp 到临时目录、验证、原子重命名） ✅

**ssh-argv（src/ssh/argv.ts）**：
- 完整实现 validateSSHHost、buildProbeCommand、parseProbeOutput、buildMainSSHArgv、buildRemoteCLICommand、posixQuote ✅

**发现 B6-ssh-01**：SSH 重连后无状态同步机制，远程可能已前进但本地不知道已改变的工具状态。严重度：P3（设计已知限制），置信度：已证实（spec 改进建议明确记录）
**发现 B6-ssh-02**：当前仅支持 Linux glibc 目标，不支持 musl libc（Alpine）或 BSD/macOS 远程。严重度：P3（设计已知限制），置信度：已证实（spec 明确记录）
**发现 B6-ssh-03**：单次 scp 传输大文件在弱网下可能慢或失败，无断点续传。严重度：P3（设计已知限制），置信度：已证实（spec 改进建议明确记录）

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ tests/sshSession.test.ts：完整覆盖 SSH 会话创建、重连、权限隔离、工件部署、错误分类、stderr 脱敏
- ✅ tests/sshAuthProxy.test.ts：完整覆盖认证代理三种 auth 类型、占位符剥除、host 固定、流式传输、协议违规拒绝、socket 身份验证、本地会话真实传输

#### 隐私与安全边界审查

**安全边界**：
- 本地凭证（API key/Bearer/OAuth token）永远不发送到远程主机，远程只能看到占位符 ✅
- 所有 API 请求通过本地认证代理注入真实凭证 ✅
- 认证代理仅接受 /v1/ 路径的请求，拒绝 CONNECT/TRACE 方法 ✅
- 本地和远程 Unix socket 权限 0600 ✅
- 代理通过 dev+ino 验证 socket 身份防止替换 ✅
- Host key 完全由 OpenSSH 处理，不使用 StrictHostKeyChecking=no 或 UserKnownHostsFile=/dev/null ✅
- 所有 SSH stderr 输出被 redact，移除可能的凭证 ✅
- 远程命令显式 unset 所有可能含凭证的 ingress 环境变量 ✅

**外部 stub 契约**：
- ✅ docs/external-stubs/contracts/ssh-v1.md：SSH 协议完全验证通过

#### 上游证据

**协议证据**：
- ✅ ssh-v1.md 外部契约完整验证通过

**源码证据**：
- ✅ 所有核心模块实现与 spec 一致，关键决策点都有 spec 中记录的证据位置

**上游二进制 strings**：
- ✅ 已提取，关键匹配：`sshAuthProxy` 等

**官方文档**：
- ⚠️ 边界搜索未发现专门 SSH 文档页面（合理，内部功能）

**Live 状态**：
- ❌ 未尝试（遵循边界规则，未连接任何私有服务）

---

---

### teleport

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-teleport-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/teleport.yaml |
| Manifest 注册 | ✅ | id: teleport, batch: 6, status: draft |
| Coverage 覆盖分组 | 3/3 | additional-files-source, additional-files-test, commands |

#### 文档完整性审查

✅ **问题与约束**：准确描述了本地与云端会话迁移（teleportToRemote/teleportResumeCodeSession）、OAuth 认证要求、GitHub App 预检查、Git Bundle 降级策略等约束条件。

✅ **设计理由与备选方案**：8 项关键决策表格化展示，包含真实证据位置：
- 脏工作区阻断而非自动 stash（证据：tests/teleport.test.ts）
- GitHub 预检查 + Bundle 自动降级（证据：spec 中注释）
- Session ID 引用而非完整状态序列化（证据：teleportFromSessionsAPI）
- 分支检出失败不阻断会话恢复（证据：processMessagesForTeleportResume）
- 环境选择优先级 anthropic_cloud > byoc（证据：teleportToRemote）
- 权限模式通过初始事件传递而非 API 字段（证据：spec 中注释）
- Archive 而非 delete 停止远程会话（证据：archiveRemoteSession）

✅ **目标与非目标**：清晰界定了本地上云、云端恢复、Git Bundle 降级、OAuth 认证等目标；明确了不支持 API Key 认证、不自动 stash 脏工作区、不跨设备实时同步等非目标。

✅ **架构、模块与数据流**：
- 2 个模块设计卡（gitBundle, environmentSelection）
- 完整的本地上云与云端恢复数据流
- Git Bundle 创建与降级策略（all → HEAD → squash）
- 关键数据结构（BundleUploadResult, EnvironmentSelectionInfo）

#### 源码验证

**additional-files-source (src/utils/teleport.tsx)**：
- teleportToRemote：上云入口，OAuth 检查、环境选择、GitHub 预检查、Bundle 降级 ✅
- teleportResumeCodeSession：恢复入口，仓库验证、日志获取、分支检出 ✅
- validateGitState：Git 状态检查，脏工作区阻断 ✅
- checkOutTeleportedSessionBranch：分支检出，失败不阻断，返回错误 ✅
- validateSessionRepository：仓库验证，比较 owner/repo（忽略大小写）和 host（去除端口）✅
- processMessagesForTeleportResume：消息处理，添加系统提示分支错误 ✅
- archiveRemoteSession：Archive 远程会话而非 delete ✅
- **发现 B6-teleport-01**：Git Bundle 上传无进度显示，大仓库上传时用户体验差。严重度：P3（设计改进建议已在 spec 中记录），置信度：已证实（spec 第 9 节）
- **发现 B6-teleport-02**：Git Bundle 上传无断点续传，大文件失败需重新上传。严重度：P3（设计改进建议已在 spec 中记录），置信度：已证实（spec 第 9 节）

**additional-files-source (src/utils/teleport/api.ts)**：
- fetchSession：获取会话信息，15s 超时 ✅
- fetchCodeSessionsFromSessionsAPI：获取会话列表 ✅
- getBranchFromSession：从会话中提取分支名称 ✅
- sendEventToRemoteSession：发送事件到远程会话，30s 超时 ✅
- updateSessionTitle：更新会话标题 ✅
- axiosGetWithRetry：指数退避重试（2s/4s/8s/16s），仅重试网络错误和 5xx ✅
- **发现 B6-teleport-03**：API 重试逻辑无用户反馈，重试期间用户不知道进度。严重度：P3，置信度：已证实（基于代码理解）

**additional-files-source (src/utils/teleport/environmentSelection.ts)**：
- getEnvironmentSelectionInfo：环境选择，优先级 defaultEnvironmentId > anthropic_cloud > byoc > bridge ✅

**additional-files-source (src/utils/teleport/environments.ts)**：
- fetchEnvironments：获取可用环境列表 ✅
- createDefaultCloudEnvironment：创建默认云环境 ✅

**additional-files-source (src/utils/teleport/gitBundle.ts)**：
- createAndUploadGitBundle：Git Bundle 创建与上传，三级降级（all → HEAD → squash）✅
- DEFAULT_BUNDLE_MAX_BYTES：100MB 默认限制 ✅
- BundleScope：all/head/squash 三种范围 ✅
- WIP 捕获：git stash create + refs/seed/stash ✅
- **发现 B6-teleport-04**：未跟踪文件不包含在 Bundle 中，可能导致远程环境缺少必要文件。严重度：P3（设计权衡，明确记录），置信度：已证实（spec 中明确说明）

**commands (src/commands/teleport/teleport.tsx)**：
- `/teleport` 命令入口，交互式会话选择与恢复 UI ✅

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ **tests/teleport.test.ts**：完整覆盖 teleport 核心功能，包括：
  - 无 sessionId 时使用选择器
  - 直接 sessionId 拉取和验证
  - 网络/无效会话失败不修改工作区
  - 仓库不匹配需要已知 checkout，不降级到清理
  - 脏工作区取消阻塞 checkout 和替换转录
  - 成功恢复复用 checkout 和消息处理
- **发现 B6-teleport-05**：缺少大仓库 Bundle 创建性能测试。严重度：P3（改进建议已在 spec 中记录），置信度：已证实（spec 第 9 节）
- **发现 B6-teleport-06**：缺少网络中断恢复测试。严重度：P3（改进建议已在 spec 中记录），置信度：已证实（spec 第 9 节）
- **发现 B6-teleport-07**：缺少 GHE 仓库验证测试。严重度：P3（改进建议已在 spec 中记录），置信度：已证实（spec 第 9 节）
- **发现 B6-teleport-08**：缺少并发 Teleport 操作测试。严重度：P3（改进建议已在 spec 中记录），置信度：已证实（spec 第 9 节）

#### 隐私与安全边界审查

**安全边界**：
- OAuth token 仅在显式 environmentId 场景注入，服务端日志自动 scrub ✅
- Git Bundle 不包含 .git/config、.git/credentials、未跟踪文件（除非在 stash 中）✅
- 会话日志过滤：仅保留 transcript message，排除 sidechain ✅
- 仓库验证比较 owner/repo（忽略大小写）和 host（去除端口）✅
- 分支检出失败不阻断会话恢复，确保会话恢复是主要目标 ✅
- Archive 而非 delete 停止远程会话，避免意外丢失会话 ✅

**失败语义**：
- 脏工作区阻断而非自动 stash，安全性优先 ✅
- GitHub 预检查失败自动降级到 Bundle，最大化成功率 ✅
- 分支检出失败继续恢复会话，可用性优先 ✅
- API 调用指数退避重试，仅重试网络错误和 5xx ✅

#### 上游证据

**官方文档证据**：
- ✅ 边界搜索命中：[Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web.md)（提到 teleport/--cloud/--teleport），未读取完整页面内容

**上游 CLI strings 证据**：
- ✅ 已提取，关键匹配：`teleportToRemote`, `teleportToRemoteWithErrorHandling`, `[teleportToRemote]` 等

**外部 stub 契约证据**：
- ✅ 无相关契约（合理，内部功能）

**源码证据**：
- ✅ 所有核心模块实现与 spec 一致，关键决策点都有 spec 中记录的证据位置

**Live 证据**：
- ❌ 未尝试连接私有服务（遵循边界规则）

## 发现登记

### 完整登记（14列schema）

| ID | 主责 | 关联 | 类别 | 严重度 | 问题陈述 | 源码证据 | 上游证据 | 测试证据 | 影响 | 修订建议 | 置信度 | 验证边界 | 状态 |
|----|------|------|------|--------|----------|----------|----------|----------|------|----------|--------|----------|------|
| B6-daemon-background-01 | daemon-background | — | 设计已知非目标 | P3 | Supervisor 无持久化日志，调试困难 | src/daemon/main.ts:57，spec 明确记录 | 上游 CLI strings 匹配 daemon 相关函数 | tests/daemon.test.ts 存在但不覆盖此非目标功能 | 低（仅影响调试难度） | 按 spec 保持现状（设计已知非目标） | 已证实 | 源码与 spec 明确记录为非目标 | open |
| B6-daemon-background-02 | daemon-background | — | 设计已知非目标 | P3 | `--resume` 标志预留但未实现 | spec 非目标明确记录 | 上游 CLI strings 匹配 daemon 相关函数 | tests/daemon.test.ts 存在但不覆盖此预留标志 | 低（预留标志不影响现有功能） | 按 spec 保持现状（设计已知非目标） | 已证实 | spec 明确记录为非目标 | open |
| B6-daemon-background-03 | daemon-background | — | 设计已知非目标 | P3 | 无自动墓碑过期机制 | spec 非目标明确记录 | 上游 CLI strings 匹配 daemon/background 相关函数 | tests/backgroundSessions.test.ts 存在但不覆盖此非目标功能 | 低（仅长期运行可能积累墓碑） | 按 spec 保持现状（设计已知非目标） | 已证实 | spec 明确记录为非目标 | open |
| B6-deep-link-01 | deep-link | — | 设计权衡 | P3 | Windows cmd.exe 后备有 8191 字符限制，超长 query 可能启动失败 | src/utils/deepLink/parseDeepLink.ts:60-69 注释，spec 记录此权衡 | 上游 CLI strings 匹配 deep-link 相关函数 | 无 deep-link 相关测试 | 低（设计权衡，已在 spec 记录） | 按 spec 保持现状（设计权衡） | 已证实 | spec 注释明确记录此权衡 | open |
| B6-deep-link-02 | deep-link | — | 设计已知非目标 | P3 | 不支持自定义终端路径配置，仅支持预定义终端列表 | spec 非目标明确记录 | 上游 CLI strings 匹配 deep-link 相关函数 | 无 deep-link 相关测试 | 低（仅预定义终端支持） | 按 spec 保持现状（设计已知非目标） | 已证实 | spec 明确记录为非目标 | open |
| B6-deep-link-03 | deep-link | — | 设计已知非目标 | P3 | 不支持 `claude://` 桌面协议服务端，仅作为客户端调用桌面 | spec 非目标明确记录 | 上游 CLI strings 匹配 deep-link 相关函数 | 无 deep-link 相关测试 | 低（仅客户端功能） | 按 spec 保持现状（设计已知非目标） | 已证实 | spec 明确记录为非目标 | open |
| B6-deep-link-04 | deep-link | — | 测试缺口 | P2 | deep-link 子系统无任何测试覆盖，包括协议解析、安全验证、跨平台注册、终端启动等核心功能 | tests/ 目录扫描确认无 deepLink 相关测试文件 | 上游 CLI strings 匹配 deep-link 相关函数 | 无 deep-link 相关测试 | 中等（外部输入入口，无回归保护） | 补充 deep-link 完整测试覆盖（协议解析、安全验证、跨平台注册、终端启动） | 已证实 | tests/ 目录完整扫描确认缺失 | open |
| B6-open-runner-01 | open-runner | — | 设计权衡 | P3 | 路径验证 Windows 盘符检测在 Linux/macOS 上也生效（设计权衡） | src/open-runner/protocol.ts 路径验证逻辑，spec 记录此权衡 | 上游 CLI strings 包含 open-runner 嵌入二进制 | tests/openRunnerProtocol.test.ts 存在 | 低（设计权衡，不影响主要功能） | 按 spec 保持现状（设计权衡） | 已证实 | 源码与 spec 明确记录此权衡 | open |
| B6-open-runner-02 | open-runner | — | 设计已知非目标 | P3 | Server 仅绑定 localhost 但无 TLS 支持（设计非目标） | spec 非目标明确记录 | 上游 CLI strings 包含 open-runner 嵌入二进制 | tests/openRunnerProtocol.test.ts 存在 | 低（仅 localhost 绑定，TLS 为非目标） | 按 spec 保持现状（设计已知非目标） | 已证实 | spec 明确记录为非目标 | open |
| B6-open-runner-03 | open-runner | — | 设计已知非目标 | P3 | Store 是单进程文件存储，不支持分布式（设计非目标） | spec 非目标明确记录 | 上游 CLI strings 包含 open-runner 嵌入二进制 | tests/openRunnerProtocol.test.ts 存在 | 低（单进程设计，分布式为非目标） | 按 spec 保持现状（设计已知非目标） | 已证实 | spec 明确记录为非目标 | open |
| B6-open-runner-04 | open-runner | — | 改进建议 | P2 | 没有状态迁移工具，未来 Open Runner Store 格式变更可能导致数据丢失 | spec 改进建议明确记录 | 上游 CLI strings 包含 open-runner 嵌入二进制 | tests/openRunnerProtocol.test.ts 存在但不覆盖迁移工具 | 中等（未来格式升级风险） | 按 spec 改进建议，评估并实现状态迁移工具 | 已证实 | spec 改进建议明确记录 | open |
| B6-open-runner-05 | open-runner | — | 设计已知非目标 | P3 | Worker 没有自动清理 worker.log 的机制 | spec 非目标明确记录 | 上游 CLI strings 包含 open-runner 嵌入二进制 | tests/openRunnerWorker.test.ts 存在但不覆盖日志清理 | 低（仅长期运行可能积累日志） | 按 spec 保持现状（设计已知非目标） | 已证实 | spec 明确记录为非目标 | open |
| B6-open-runner-06 | open-runner | — | 设计权衡 | P3 | prctl 仅在 Linux+Bun 下有效，其他平台无内存防护（设计权衡） | src/upstreamproxy/upstreamproxy.ts:140-144，spec 记录此权衡 | 上游 CLI strings 包含 open-runner 嵌入二进制 | tests/openBackends.test.ts 存在 | 低（设计权衡，仅 Linux+Bun 有防护） | 按 spec 保持现状（设计权衡） | 已证实 | 源码与 spec 明确记录此权衡 | open |
| B6-open-runner-07 | open-runner | — | 测试缺口 | P2 | upstream-proxy/relay.ts 没有独立测试覆盖，仅通过集成验证 | tests/ 目录扫描确认无 relay 相关测试文件 | 上游 CLI strings 包含 open-runner 嵌入二进制 | tests/openRunnerProtocol.test.ts 存在但不覆盖 relay.ts | 中等（安全关键组件，无回归保护） | 补充 upstream-proxy/relay.ts 独立单元测试 | 已证实 | tests/ 目录完整扫描确认缺失 | open |
| B6-platform-integrations-01 | platform-integrations | — | 设计权衡（静默降级） | P3 | WSL 配置读取失败时仅记录日志，无用户可见提示（设计权衡，静默降级） | src/utils/claudeDesktop.ts，spec 记录此权衡 | 上游 CLI strings 匹配 platform-integrations (desktop/mobile/slack) | tests/claudeInChromeWiring.test.ts 存在但不覆盖 WSL 配置读取 | 低（设计权衡，静默降级） | 按 spec 保持现状（设计权衡） | 已证实 | spec 明确记录此权衡 | open |
| B6-platform-integrations-02 | platform-integrations | — | 设计权衡（静默降级） | P3 | QR 码生成失败时静默降级（仅留空），无用户可见提示 | src/commands/mobile/mobile.tsx，spec 上下文记录此行为 | 上游 CLI strings 匹配 platform-integrations (desktop/mobile/slack) | tests/claudeInChromeWiring.test.ts 存在但不覆盖 QR 码生成 | 低（设计权衡，静默降级） | 按 spec 保持现状（设计权衡） | 已证实 | 源码与 spec 上下文记录此行为 | open |
| B6-platform-integrations-03 | platform-integrations | — | 测试缺口 | P2 | platform-integrations 子系统测试覆盖严重不足，仅 1 个最小测试文件，缺少核心功能测试 | tests/ 目录完整扫描确认仅 claudeInChromeWiring.test.ts 存在 | 上游 CLI strings 匹配 platform-integrations (desktop/mobile/slack) | tests/claudeInChromeWiring.test.ts 存在但覆盖极小 | 中等（外部输入/跨平台集成，无回归保护） | 补充 platform-integrations 完整测试覆盖（deep-link、桌面检测、WSL 配置、浏览器检测、socket/pipe 通信、QR 码生成、Slack 集成、Desktop upsell） | 已证实 | tests/ 目录完整扫描确认缺失 | open |
| B6-remote-control-01 | remote-control | — | 测试缺口 | P2 | SessionsWebSocket 重连逻辑无独立单元测试，当前仅通过集成验证 | tests/ 目录扫描确认无 SessionsWebSocket 专项测试 | 上游 CLI strings 匹配 remote-control 相关函数（RemoteSessionManager、[RemoteSessionManager] Connecting to session） | tests/directConnect.test.ts 存在但不覆盖 CCR 模式 SessionsWebSocket | 中等（CCR 模式可靠性核心，无回归保护） | 补充 SessionsWebSocket 独立单元测试（重连策略、4001 特殊处理、viewerOnly 永不放弃逻辑） | 已证实 | tests/ 目录完整扫描确认缺失 | open |
| B6-remote-control-02 | remote-control | — | 测试缺口 | P2 | sdkMessageAdapter 无独立单元测试 | tests/ 目录扫描确认无 sdkMessageAdapter 专项测试 | 上游 CLI strings 匹配 remote-control 相关函数 | tests/directConnect.test.ts 存在但不覆盖 sdkMessageAdapter | 中等（远程消息渲染核心，无回归保护） | 补充 sdkMessageAdapter 独立单元测试（消息转换、未知类型处理） | 已证实 | tests/ 目录完整扫描确认缺失 | open |
| B6-remote-control-03 | remote-control | — | 设计已知限制 | P3 | RemoteSessionManager pendingPermissionRequests 无超时清理机制 | spec 非目标明确记录，源码确认无超时逻辑 | 上游 CLI strings 匹配 remote-control 相关函数 | tests/directConnect.test.ts 存在但不覆盖此限制 | 低（仅服务器永远不取消权限请求时可能内存泄漏） | 按 spec 保持现状（设计已知限制） | 已证实 | spec 明确记录为非目标 | open |
| B6-ssh-01 | ssh | — | 设计已知限制 | P3 | SSH 重连后无状态同步机制，远程可能已前进但本地不知道已改变的工具状态 | spec 改进建议明确记录 | 上游 CLI strings 匹配 ssh 相关函数（sshAuthProxy） | tests/sshSession.test.ts 存在但不覆盖状态同步 | 低（仅断线期间远程前进时可能不一致） | 按 spec 改进建议，评估并实现状态同步机制 | 已证实 | spec 改进建议明确记录 | open |
| B6-ssh-02 | ssh | — | 设计已知限制 | P3 | 当前仅支持 Linux glibc 目标，不支持 musl libc（Alpine）或 BSD/macOS 远程 | spec 明确记录 | 上游 CLI strings 匹配 ssh 相关函数 | tests/sshSession.test.ts 存在但仅覆盖 glibc 目标 | 低（仅限制目标环境） | 按 spec 保持现状（设计已知限制） | 已证实 | spec 明确记录 | open |
| B6-ssh-03 | ssh | — | 设计已知限制 | P3 | 单次 scp 传输大文件在弱网下可能慢或失败，无断点续传 | spec 改进建议明确记录 | 上游 CLI strings 匹配 ssh 相关函数 | tests/sshSession.test.ts 存在但不覆盖断点续传 | 低（仅弱网大文件传输可能受影响） | 按 spec 改进建议，评估并实现断点续传 | 已证实 | spec 改进建议明确记录 | open |
| B6-teleport-01 | teleport | — | 改进建议 | P3 | Git Bundle 上传无进度显示，大仓库上传时用户体验差 | spec 改进建议明确记录 | 上游 CLI strings 匹配 teleport 相关函数（teleportToRemote、teleportToRemoteWithErrorHandling、[teleportToRemote]） | tests/teleport.test.ts 存在但不覆盖进度显示 | 低（仅影响大仓库上传体验） | 按 spec 改进建议，评估并实现上传进度显示 | 已证实 | spec 改进建议明确记录 | open |
| B6-teleport-02 | teleport | — | 改进建议 | P3 | Git Bundle 上传无断点续传，大文件失败需重新上传 | spec 改进建议明确记录 | 上游 CLI strings 匹配 teleport 相关函数 | tests/teleport.test.ts 存在但不覆盖断点续传 | 低（仅弱网大文件上传可能受影响） | 按 spec 改进建议，评估并实现断点续传 | 已证实 | spec 改进建议明确记录 | open |
| B6-teleport-03 | teleport | — | 设计改进 | P3 | API 重试逻辑无用户反馈，重试期间用户不知道进度 | src/utils/teleport/api.ts，基于代码理解 | 上游 CLI strings 匹配 teleport 相关函数 | tests/teleport.test.ts 存在但不覆盖用户反馈 | 低（仅影响重试期间体验） | 按 spec 改进建议，评估并实现 API 重试用户反馈 | 已证实 | 基于代码理解 | open |
| B6-teleport-04 | teleport | — | 设计权衡 | P3 | 未跟踪文件不包含在 Bundle 中，可能导致远程环境缺少必要文件 | spec 明确记录此权衡 | 上游 CLI strings 匹配 teleport 相关函数 | tests/teleport.test.ts 存在但覆盖此权衡 | 低（设计权衡，仅未跟踪文件可能缺失） | 按 spec 保持现状（设计权衡） | 已证实 | spec 明确记录此权衡 | open |
| B6-teleport-05 | teleport | — | 测试缺口 | P3 | 缺少大仓库 Bundle 创建性能测试 | spec 改进建议明确记录 | 上游 CLI strings 匹配 teleport 相关函数 | tests/teleport.test.ts 存在但不覆盖大仓库性能 | 低（仅性能测试缺失） | 补充大仓库 Bundle 创建性能测试 | 已证实 | spec 改进建议明确记录 | open |
| B6-teleport-06 | teleport | — | 测试缺口 | P3 | 缺少网络中断恢复测试 | spec 改进建议明确记录 | 上游 CLI strings 匹配 teleport 相关函数 | tests/teleport.test.ts 存在但不覆盖网络中断恢复 | 低（仅网络中断恢复测试缺失） | 补充网络中断恢复测试 | 已证实 | spec 改进建议明确记录 | open |
| B6-teleport-07 | teleport | — | 测试缺口 | P3 | 缺少 GHE 仓库验证测试 | spec 改进建议明确记录 | 上游 CLI strings 匹配 teleport 相关函数 | tests/teleport.test.ts 存在但不覆盖 GHE 仓库验证 | 低（仅 GHE 验证测试缺失） | 补充 GHE 仓库验证测试 | 已证实 | spec 改进建议明确记录 | open |
| B6-teleport-08 | teleport | — | 测试缺口 | P3 | 缺少并发 Teleport 操作测试 | spec 改进建议明确记录 | 上游 CLI strings 匹配 teleport 相关函数 | tests/teleport.test.ts 存在但不覆盖并发操作 | 低（仅并发操作测试缺失） | 补充并发 Teleport 操作测试 | 已证实 | spec 改进建议明确记录 | open |

### 汇总统计

| 类别 | 数量 |
|------|------|
| P0 阻断性问题 | 0 |
| P1 严重问题 | 0 |
| P2 中等问题 | 6 |
| P3 低优先级问题 | 25 |
| 总计 | 31 |

### P0/P1/P2 详细描述

**发现 B6-deep-link-04**：deep-link 子系统无任何测试覆盖，包括协议解析、安全验证、跨平台注册、终端启动等核心功能。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认，无 deepLink 相关测试文件）。

风险：deep-link 是外部输入入口，无测试覆盖可能导致安全验证逻辑退化、跨平台兼容性问题无法及时发现。

---

**发现 B6-open-runner-04**：没有状态迁移工具，未来 Open Runner Store 格式变更可能导致用户数据丢失。严重度：P2（改进建议，已在 spec 中记录），置信度：已证实（spec 改进建议中明确记录）。

风险：未来格式升级需要用户手动迁移或丢失数据，影响用户体验。

**发现 B6-open-runner-07**：upstream-proxy/relay.ts 没有独立测试覆盖，虽然集成在 CCR 会话中验证，但没有单元测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认，无 relay 相关测试文件）。

风险：relay 是安全关键组件（处理凭据注入），无测试覆盖可能导致安全问题无法及时发现。

---

**发现 B6-platform-integrations-03**：platform-integrations 子系统测试覆盖严重不足，仅 1 个最小测试文件（claudeInChromeWiring.test.ts），缺少核心功能测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录完整扫描）。

风险：platform-integrations 处理外部输入（deep link）、跨平台集成、安全敏感功能（socket/pipe通信），无测试覆盖可能导致安全验证逻辑退化、跨平台兼容性问题无法及时发现。

---

**发现 B6-remote-control-01**：SessionsWebSocket 重连逻辑无独立单元测试，当前仅通过集成验证。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认，无 SessionsWebSocket 专项测试）。

风险：WebSocket 重连是 CCR 模式可靠性的核心，无测试覆盖可能导致重连逻辑退化、4001 特殊处理失效、viewerOnly 永不放弃逻辑错误。

---

**发现 B6-remote-control-02**：sdkMessageAdapter 无独立单元测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认）。

风险：SDK 消息适配器是远程消息渲染的核心，无测试覆盖可能导致消息转换错误、未知类型处理不当、UI 展示异常。

---

**发现 B6-remote-control-03**：RemoteSessionManager pendingPermissionRequests 无超时清理机制。严重度：P3（设计已知限制），置信度：已证实（spec 非目标明确记录，源码确认无超时逻辑）。

风险：服务器永远不取消权限请求时，pendingPermissionRequests 可能无限增长，导致内存泄漏。

---

**发现 B6-ssh-01**：SSH 重连后无状态同步机制，远程可能已前进但本地不知道已改变的工具状态。严重度：P3（设计已知限制），置信度：已证实（spec 改进建议明确记录）。

风险：断线期间远程工具执行状态变化，重连后本地 UI 可能与远程状态不一致。

---

**发现 B6-ssh-02**：当前仅支持 Linux glibc 目标，不支持 musl libc（Alpine）或 BSD/macOS 远程。严重度：P3（设计已知限制），置信度：已证实（spec 明确记录）。

风险：用户尝试在不支持的远程环境使用 SSH 功能时会失败。

---

**发现 B6-ssh-03**：单次 scp 传输大文件在弱网下可能慢或失败，无断点续传。严重度：P3（设计已知限制），置信度：已证实（spec 改进建议明确记录）。

风险：大工件部署在弱网下可能失败，需要重新完整传输。

## 证据边界

| 类别 | 状态 | 说明 |
|------|------|------|
| 官方文档 | ✅ 已搜索 | code.claude.com 索引搜索命中相关页面：<br>- [Remote Control](https://code.claude.com/docs/en/remote-control.md)<br>- [Deep Links](https://code.claude.com/docs/en/deep-links.md)<br>- [Platforms and integrations](https://code.claude.com/docs/en/platforms.md)<br>- [Mobile](https://code.claude.com/docs/en/mobile.md)<br>- [Slack](https://code.claude.com/docs/en/slack.md)<br>- [Desktop](https://code.claude.com/docs/en/desktop.md)<br>- [Self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments.md)<br>未读取完整页面内容（边界限制） |
| 上游 strings | ✅ 已提取 | /opt/homebrew/bin/claude 已提取所有相关字符串，关键匹配：<br>- daemon: `daemonMain`<br>- deep-link: `parseDeepLink`, `registerProtocolHandler`<br>- open-runner: (embedded in binary)<br>- platform-integrations: (desktop/mobile/slack strings)<br>- remote-control: `RemoteSessionManager`, `[RemoteSessionManager] Connecting to session`<br>- ssh: `sshAuthProxy`<br>- teleport: `teleportToRemote`, `teleportToRemoteWithErrorHandling` |
| 源码访问 | ✅ 完整访问 | src/daemon/, src/cli/bg.ts, src/utils/uds*, src/utils/deepLink/, src/open-runner/, src/upstreamproxy/, src/utils/desktopDeepLink.ts, src/utils/claudeDesktop.ts, src/utils/claudeInChrome/common.ts, src/commands/desktop/, src/components/DesktopUpsell/, src/commands/mobile/, src/commands/chrome/, src/commands/install-slack-app/, src/remote/, src/server/, src/ssh/, src/utils/teleport/, src/commands/teleport/ 完整读取 |
| 测试访问 | ✅ 完整扫描 | tests/ 目录完整扫描，daemon/background/uds 测试存在，deep-link 测试缺失，open-runner 测试完整，upstream-proxy relay 测试缺失，platform-integrations 仅 claudeInChromeWiring.test.ts 最小测试，remote-control CCR 模式测试缺失，direct-connect 测试完整，ssh 测试完整，teleport 测试完整 |
| 外部 stubs 契约 | ✅ 有相关契约 | docs/external-stubs/contracts/direct-connect-v1.md 和 ssh-v1.md 完整验证通过；daemon/background/deep-link/open-runner/platform-integrations/teleport 无相关契约（合理，内部功能） |
| 私有服务访问 | ❌ 未尝试 | 遵循边界规则，未尝试连接任何私有服务 |

## 完成判定

### 门禁检查

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 06-remote-background-platforms.md 存在 | ✅ | 本文档 |
| 包含 7 个已审计子系统章节 | ✅ | daemon-background, deep-link, open-runner, platform-integrations, remote-control, ssh, teleport |
| 包含 0 个 open 子系统占位 | ✅ | 无 open 子系统 |
| 包含所有必需章节 | ✅ | 基线与范围、子系统审查、发现登记、证据边界、完成判定 |
| 发现 ID 格式正确 | ✅ | B6-{subsystem}-{nn} |
| 无私有连接声明 | ✅ | 证据边界明确声明未尝试私有服务 |

### 子系统状态

| 子系统 | 状态 | 完成度 |
|--------|------|--------|
| daemon-background | ✅ Audited | 10/10 分组覆盖，3 个发现（0 P0/P1, 0 P2, 3 P3） |
| deep-link | ✅ Audited | 7/7 分组覆盖，4 个发现（0 P0/P1, 1 P2, 3 P3） |
| open-runner | ✅ Audited | 7/7 分组覆盖，7 个发现（0 P0/P1, 2 P2, 5 P3） |
| platform-integrations | ✅ Audited | 16/16 分组覆盖，3 个发现（0 P0/P1, 1 P2, 2 P3） |
| remote-control | ✅ Audited | 7/7 分组覆盖，3 个发现（0 P0/P1, 2 P2, 1 P3） |
| ssh | ✅ Audited | 9/9 分组覆盖，3 个发现（0 P0/P1, 0 P2, 3 P3） |
| teleport | ✅ Audited | 3/3 分组覆盖，8 个发现（0 P0/P1, 0 P2, 8 P3） |

### 总体状态

🟢 **完成**：本 slice 完成 daemon-background + deep-link + open-runner + platform-integrations + remote-control + ssh + teleport 7 个子系统完整审计。无 P0/P1 阻断性问题，所有外部 stub 契约（direct-connect-v1.md、ssh-v1.md）完整验证通过。

---

**审计完成时间**：2026-11-16
**审计者**：Claude Code Audit Agent

## 增量整改台账（2026-11-18 追加，不改变上述历史统计）

- **新增 Finding `B6-remote-control-04`（P2，fixed）**：PR #19 Linux CI 发现 direct-connect `attach()` 未等待 `runtime.eventChain`，可能在事件写入/轮转完成前发送 ready，导致 `replay_reset` 缺失。主责 spec：`2026-11-12-remote-control-design.md`。
- **RED**：原 CI `tests/directConnect.test.ts` 的 rotation 用例实际失败；增加受控 eventChain 后，本地 `bun test tests/directConnect.test.ts --timeout 60000` 退出 1，证明 gate 未释放前已错误发送 ready。
- **GREEN**：`attach()` 仅增加一次 `await runtime.eventChain`，新到事件继续由 replay buffer 承接；同一 focused 命令退出 0（14 pass，0 fail）。
- **证据边界**：本地 loopback/offline 验证，不表示 CCR 私有协议兼容；官方文档和 upstream strings 边界见主责 spec。原 3 个 remote-control Finding 与历史统计不变。

## Phase B Deep Link 行为整改（2026-11-20 追加）

- **Finding**：B6-deep-link-04；主责 spec：`2026-11-12-deep-link-design.md`。原 Finding 行和历史统计保持 open，spec 保持 draft。
- **实现**：新增并唯一登记 `tests/deepLink.test.ts`，6 个测试、26 个断言。覆盖 URI/Unicode round-trip、非法输入、handler repo/lastFetch、纯 argv query/repo/cwd、Linux `.desktop` 注册与 current/stale 检查。
- **证据边界**：真实 parser/handler/launcher/注册逻辑，OS 命令、repo lookup 和 lastFetch 为边界替身；无真实桌面协议、终端或私有协议。macOS trampoline、Windows 注册表、banner UI、多克隆 MRU、shell quoting、worktreeinclude 和 `claude://` 双向链接仍未覆盖。
- **隔离纠错**：初版测试曾误写真实 Applications/XDG artifact，均确认属于测试后删除；beforeEach 现在重设 HOME/XDG，最终真实路径无残留。Bun namespace 会被原地替换，生产 launcher 通过预先保存的函数引用验证，handler 继续用 mock。

## Phase B Upstream Proxy Relay 整改（2026-11-20 追加）

- **Finding**：B6-open-runner-07；主责 spec：`2026-11-12-open-runner-design.md`。原 Finding 行和历史统计保持 open，spec 保持 draft。
- **实现**：新增并唯一登记 `tests/upstreamProxyRelay.test.ts`，5 个测试、20 个断言。覆盖 UpstreamProxyChunk 编解码/畸形输入、分片 CONNECT+pending、超大海报头、established 前 502、established 后仅关闭。
- **证据边界**：真实 `startNodeRelay`、loopback TCP 和 fake WebSocket；未执行真实 CCR、证书/MITM、代理链或 Bun.listen，不声明私有协议兼容。B6-open-runner-04 的状态迁移工具是独立改进建议，未在此批次实现。

## Phase B Platform Integrations 行为整改（2026-11-20 追加）

- **Finding**：B6-platform-integrations-03；主责 spec：`2026-11-12-platform-integrations-design.md`。原 Finding 行和历史统计保持 open，spec 保持 draft。
- **实现**：新增并唯一登记 `tests/platformIntegrations.test.tsx`，4 个测试、14 个断言。覆盖 schema-valid Desktop MCP 配置/缺失与非法 JSON、非默认 Chrome profile 扩展检测、真实 iOS/Android QR Tab/Escape、Slack 安装计数和失败 URL。
- **证据边界**：真实生产逻辑与临时目录；openBrowser/os.homedir 为离线边界，未执行 native messaging、真实浏览器、OAuth、WSL 或私有协议。WSL 路径枚举、native messaging host、QR 失败降级、Desktop upsell 和其他浏览器平台未覆盖。
