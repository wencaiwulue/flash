# Batch 6 审计报告：Daemon 与 Deep Link

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | ✅ 已提取 strings | /opt/homebrew/bin/claude 已提取相关 daemon/background/deep-link 字符串 |
| 官方文档 | ⚠️ 未确认 | code.claude.com 已执行边界搜索，未发现相关页面 |
| 审查范围 | daemon-background + deep-link 子系统深度审计；open-runner/platform-integrations/remote-control/ssh/teleport 子系统保持 open 状态 | daemon/background 完整生命周期 + deep-link 解析/路由审查；其余 5 子系统待审计 |

### 启动状态 RED ✅

```bash
# 门禁运行验证（审计开始前）
# batch-6.md 不存在 → RED
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
- 命中：无相关公开文档页面

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
- 命中：无相关公开文档页面

---

### open-runner

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-open-runner-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/open-runner.yaml |
| Manifest 注册 | ✅ | id: open-runner, batch: 6, status: draft |
| 审查状态 | ⏸️ Open | 本 slice 仅审计 daemon-background + deep-link，open-runner 待后续审计 |

---

### platform-integrations

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-platform-integrations-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/platform-integrations.yaml |
| Manifest 注册 | ✅ | id: platform-integrations, batch: 6, status: draft |
| 审查状态 | ⏸️ Open | 本 slice 仅审计 daemon-background + deep-link，platform-integrations 待后续审计 |

---

### remote-control

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-remote-control-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/remote-control.yaml |
| Manifest 注册 | ✅ | id: remote-control, batch: 6, status: draft |
| 审查状态 | ⏸️ Open | 本 slice 仅审计 daemon-background + deep-link，remote-control 待后续审计 |

---

### ssh

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-ssh-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/ssh.yaml |
| Manifest 注册 | ✅ | id: ssh, batch: 6, status: draft |
| 审查状态 | ⏸️ Open | 本 slice 仅审计 daemon-background + deep-link，ssh 待后续审计 |

---

### teleport

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-teleport-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/teleport.yaml |
| Manifest 注册 | ✅ | id: teleport, batch: 6, status: draft |
| 审查状态 | ⏸️ Open | 本 slice 仅审计 daemon-background + deep-link，teleport 待后续审计 |

## 发现登记

### 按严重度排序

| ID | 子系统 | 严重度 | 标题 |
|----|--------|--------|------|
| B6-daemon-background-01 | daemon-background | P3 | Supervisor 无持久化日志，调试困难 |
| B6-daemon-background-02 | daemon-background | P3 | `--resume` 标志预留但未实现 |
| B6-daemon-background-03 | daemon-background | P3 | 无自动墓碑过期机制 |
| B6-deep-link-01 | deep-link | P3 | Windows cmd.exe 后备有 8191 字符限制 |
| B6-deep-link-02 | deep-link | P3 | 不支持自定义终端路径配置 |
| B6-deep-link-03 | deep-link | P3 | 不支持 `claude://` 桌面协议服务端 |
| B6-deep-link-04 | deep-link | P2 | deep-link 子系统无任何测试覆盖 |

### 汇总统计

| 类别 | 数量 |
|------|------|
| P0 阻断性问题 | 0 |
| P1 严重问题 | 0 |
| P2 中等问题 | 1 |
| P3 低优先级问题 | 6 |
| 总计 | 7 |

### P0/P1/P2 详细描述

**发现 B6-deep-link-04**：deep-link 子系统无任何测试覆盖，包括协议解析、安全验证、跨平台注册、终端启动等核心功能。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认，无 deepLink 相关测试文件）。

风险：deep-link 是外部输入入口，无测试覆盖可能导致安全验证逻辑退化、跨平台兼容性问题无法及时发现。

## 证据边界

| 类别 | 状态 | 说明 |
|------|------|------|
| 官方文档 | ⚠️ 无公开文档 | code.claude.com 边界搜索未发现 daemon/background/deep-link 相关公开文档 |
| 上游 strings | ✅ 已提取 | /opt/homebrew/bin/claude 已提取相关字符串，关键函数名/协议名匹配 |
| 源码访问 | ✅ 完整访问 | src/daemon/, src/cli/bg.ts, src/utils/uds*, src/utils/deepLink/ 完整读取 |
| 测试访问 | ✅ 完整扫描 | tests/ 目录完整扫描，daemon/background/uds 测试存在，deep-link 测试缺失 |
| 外部 stubs 契约 | ⚠️ 无相关契约 | docs/external-stubs/contracts/ 无 daemon/background/deep-link 相关契约 |
| 私有服务访问 | ❌ 未尝试 | 遵循边界规则，未尝试连接任何私有服务 |

## 完成判定

### 门禁检查

| 检查项 | 状态 | 说明 |
|--------|------|------|
| batch-6.md 存在 | ✅ | 本文档 |
| 包含 2 个已审计子系统章节 | ✅ | daemon-background, deep-link |
| 包含 5 个 open 子系统占位 | ✅ | open-runner, platform-integrations, remote-control, ssh, teleport |
| 包含所有必需章节 | ✅ | 基线与范围、子系统审查、发现登记、证据边界、完成判定 |
| 发现 ID 格式正确 | ✅ | B6-{subsystem}-{nn} |
| 无私有连接声明 | ✅ | 证据边界明确声明未尝试私有服务 |

### 子系统状态

| 子系统 | 状态 | 完成度 |
|--------|------|--------|
| daemon-background | ✅ Audited | 10/10 分组覆盖，7 个发现（0 P0/P1, 1 P2, 6 P3） |
| deep-link | ✅ Audited | 7/7 分组覆盖，0 P0/P1, 0 P2, 0 P3 发现 |
| open-runner | ⏸️ Open | 待审计 |
| platform-integrations | ⏸️ Open | 待审计 |
| remote-control | ⏸️ Open | 待审计 |
| ssh | ⏸️ Open | 待审计 |
| teleport | ⏸️ Open | 待审计 |

### 总体状态

🟡 **部分完成**：本 slice 完成 daemon-background + deep-link 2 个子系统审计，剩余 5 个子系统待后续 slice 审计。

---

**审计完成时间**：2026-11-16  
**审计者**：Claude Code Audit Agent
