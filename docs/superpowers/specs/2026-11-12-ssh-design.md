---
id: ssh
batch: 6
title: SSH 远程执行、认证与重连设计
date: 2026-11-12
status: draft
---

# SSH 远程执行、认证与重连设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理""提高可靠性""保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

当用户希望在远程 Linux 主机上运行 Claude Code 时，需要建立 SSH 连接、验证远程环境、部署可执行工件、通过本地认证代理访问 API、处理网络断线并恢复会话，同时确保不泄露本地凭证给远程主机。

如果直接在远程暴露 API key，任何能访问远程进程的用户都可以窃取凭证；如果每次断线都丢失会话状态，正在进行的工具执行和权限交互会被中断；如果不对远程环境进行验证，可能部署错误架构的二进制文件或在不支持的平台上运行。

因此本子系统必须在以下约束下完成：

- **协议约束**：使用系统 OpenSSH 客户端；通过远程 Unix socket 转发 API 请求；使用 NDJSON 进行远程进程双向通信
- **安全约束**：本地凭证永远不发送到远程；远程只看到占位符；Unix socket 权限 0o600；Host key 验证完全由系统 SSH 处理
- **兼容性约束**：仅支持 Linux glibc 目标；仅支持 macOS/Linux 本地主机；支持 x86_64 和 arm64 架构
- **性能约束**：工件部署使用缓存避免重复上传；重连延迟使用指数退避（1s 首次）
- **并发约束**：一次会话一条 SSH 连接；重连时重建连接但保留会话 ID
- **持久化约束**：工件缓存在远程 `~/.cache/claude-code/ssh/`；本地工件缓存在 `~/.claude/ssh/artifacts/`

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 本地认证代理 + SSH 端口转发 + 远程占位符 | 本地创建 Unix socket 上的 HTTP 代理；SSH 将远程 socket 转发到本地；远程使用占位符 token 连接本地代理；代理注入真实凭证 | 凭证永远不离开本地；远程无法访问真实密钥；使用标准 SSH 转发机制 | 在远程环境变量中传递真实 token：不安全；使用 SSH 代理转发本地密钥环：复杂度高且平台差异大；每次请求从本地发往 API 再转发给远程：延迟高 | 需要维护本地 HTTP 代理；需要处理 Bun 的 Unix socket HTTP 客户端特殊性 | `src/ssh/sshAuthProxy.ts:417-599` |
| 远程环境探测使用单行 shell 脚本输出带标记 JSON | 通过 `ssh host sh -c '<script>'` 执行探测脚本；脚本输出以 `CLAUDE_SSH_V1:` 开头的 JSON 行；解析时只取第一个匹配的标记行 | 避免 shell 配置（如 MOTD）干扰解析；无需在远程部署任何文件即可探测 | 在远程部署临时探测脚本：需要清理；使用 SSH 子系统或 sftp：更复杂；假设远程环境：不可靠 | 需要处理各种 shell 转义；脚本需要同时适配多种 Linux 变体 | `src/ssh/argv.ts:121-233` |
| 工件部署使用 scp + 临时目录 + 原子重命名 + 摘要验证 | 本地验证 artifact manifest；scp 到临时目录；chmod 正确权限；验证远程 sha256sum；原子重命名到目标路径；再次验证 | 避免部分部署导致损坏；防止版本不匹配；失败时自动清理临时目录 | 通过 SSH stdin 流式传输：scp 更成熟且有进度；每次都部署：大文件慢；不验证：可能运行错误版本 | 部署流程复杂且有多个 round-trip；需要远程有 sha256sum 或 shasum -a 256 | `src/ssh/artifact.ts:241-324` |
| 远程进程使用 stream-json 格式，通过 SSH stdio 双向传输 | 远程命令带 `--print --input-format stream-json --output-format stream-json`；SSH 不分配 TTY（-T）；NDJSON 行通过 SSH stdin/stdout 传输 | 复用已有本地 REPL 的 stream-json 路径；不需要额外协议；与本地会话行为一致 | 使用自定义二进制协议：复杂度高；使用 Bridge 协议：SSH 子系统不需要完整 Bridge | SSH 连接丢失时消息可能部分传输；需要处理输出缓冲 | `src/ssh/createSSHSession.ts:206-227` |
| 会话重连使用相同 session ID + 指数退避 + 有限重试 | 重连时传递 `--resume <sessionId>`；首次重连延迟 1s，后续指数退避；最多 3 次（已连接后）或 2 次（从未连接）；非重试错误直接失败 | 远程可以恢复上下文；避免频繁重连；权限请求的 generation 防止旧响应被接受 | 每次创建新会话：用户体验差；无限重试：浪费资源 | 需要记录 generation；重连后之前的 pending prompt 可能 delivery unknown | `src/ssh/SSHSessionManager.ts:508-569` |
| 权限请求按 generation 隔离，旧响应被静默拒绝 | 每次连接（包括重连）generation 递增；权限 request ID 映射包含 generation；响应时验证 generation 匹配 | 防止用户点击之前连接的权限 UI 影响新会话；自然失效旧请求 | 使用全局唯一 ID：需要 UUID 生成和跟踪；在远程处理：需要同步 | 内存占用与未完成权限请求数成正比；旧响应被静默忽略可能让用户困惑 | `src/ssh/SSHSessionManager.ts:364-375` |
| Host key 完全由 OpenSSH 处理，不绕过验证 | 使用系统 ssh 配置（`~/.ssh/config`、`known_hosts`）；不使用 `StrictHostKeyChecking=no` 或 `UserKnownHostsFile=/dev/null`；错误分类检测 host key 失败 | 遵循用户已有 SSH 安全策略；不降低安全性；用户可以用常规方式管理 host key | 自动接受新 host key：不安全；在代码中实现 host key 验证：重复 SSH 功能 | 用户需要预先配置好目标主机的 SSH 访问；第一次连接需要手动确认 | `src/ssh/openSSH.ts:103-134` |
| 错误分类将 stderr 输出分类为 auth failed / host key failed / 其他 | 检查 stderr 中是否包含 `Host key verification failed`、`Permission denied`、`Too many authentication failures` 等关键字；分类后抛出对应错误码 | 向用户提供明确错误提示；可以建议正确解决方案（如先手动 ssh 一次配置认证） | 只返回通用错误：用户体验差；尝试修复错误：越权且易出错 | 需要匹配各种 OpenSSH 版本的错误消息；可能误分类 | `src/ssh/openSSH.ts:103-134` |
| 本地会话模式使用与 SSH 相同的认证代理和 stream-json 格式 | `createLocalSSHSession` 启动本地子进程，也使用认证代理和占位符；复用相同的 `SSHSessionManager` | 统一本地和远程会话路径；代码复用；测试可以使用本地模式而不需要 SSH | 本地模式直接使用真实凭证：代码分叉；单独的本地路径：维护成本高 | 本地也需要启动认证代理；看起来比必要的复杂 | `src/ssh/createSSHSession.ts:269-318` |
| 工件验证检查 manifest、sha256、mode、版本、目标架构 | `loadSSHArtifact` 读取并验证 manifest.json；检查每个文件的 sha256 和 mode；部署前后都在远程验证 | 防止运行被篡改的工件；防止部署错误版本或架构 | 仅验证文件名：不够安全；跳过验证：易出错 | 本地和远程都需要 sha256 计算；工件目录需要预填充 | `src/ssh/artifact.ts:85-158` |
| 远程 socket 路径包含 uid 和随机值防止冲突 | 远程 socket 为 `/tmp/claude-ssh-<uid>-<randomhex>.sock`；本地 socket 也包含 uid 和随机值 | 防止多用户冲突；防止预测和尝试连接其他用户的 socket | 使用固定路径：冲突风险；使用更长随机：没必要 | socket 路径长度有限制（Unix socket 路径限制 ~100 字节） | `src/ssh/argv.ts:328-337` |

## 3. 目标与非目标

### 目标（实际承担）

- **状态与生命周期**：
  - 管理 SSH 会话连接状态（connected/reconnecting/disconnected）
  - 拥有 pending 权限请求映射（generation + request_id → request）
  - 跟踪 session_id 用于重连恢复
  - 拥有认证代理生命周期

- **接口与数据**：
  - 探测远程环境（kernel/libc/arch/cwd/home/sha256 tool）
  - 部署和验证 SSH 工件（bun + main.js + manifest）
  - 提供认证代理注入凭证并过滤 hop-by-hop headers
  - 暴露 `createSSHSession` / `createLocalSSHSession` 入口
  - 提供 `SSHSessionManager` 处理重连和消息路由

- **执行与环境**：
  - 支持 SSH 远程会话（Linux glibc x86_64/arm64）
  - 支持本地会话（macOS/Linux）
  - 支持 `--resume` 重连恢复会话
  - 支持 `--continue` 延续会话
  - 支持 `--model` 覆盖模型
  - 支持 `--permission-mode` 设置权限模式
  - 支持 `--dangerously-skip-permissions`

- **依赖边界**：
  - 调用系统 OpenSSH (`ssh`、`scp`)
  - 调用本地 bun（本地会话或工件）
  - 使用 stream-json 协议（与本地 REPL 共享）
  - 使用权限系统（由 permissions spec 负责）

### 非目标（不承担）

- 不实现 SSH 客户端协议（使用系统 OpenSSH）
- 不管理 SSH 密钥或 ssh-agent（由用户预先配置）
- 不实现终端模式或交互式 shell（仅无 TTY 批处理）
- 不负责文件同步或远程编辑（由工具系统负责）
- 不负责 Bridge 协议（由 bridge spec 负责）
- 不负责远程控制服务器（由 remote-control spec 负责）
- 不支持 Windows 本地或远程目标
- 不支持 musl libc 或非 Linux Unix 系统

## 4. 架构、模块与数据流

### 4.1 模块设计卡

#### 4.1.1 环境探测模块

| 项 | 细节 |
| --- | --- |
| **真实入口签名** | `buildProbeCommand(cwd?: string): string`<br>`buildProbeArgv(host: string): string[]`<br>`parseProbeOutput(stdout: string): SSHProbe` |
| **关键类型** | `SSHProbe: { home: string; kernel: 'Linux'; machine: string; libc: 'glibc'; cwd: string; sha256: 'sha256sum' | 'shasum -a 256'; uid: number; target: SSHTarget }` |
| **输入输出** | 输入：远程 host 字符串，可选 cwd<br>输出：经标记的 JSON 探测结果（前缀 `CLAUDE_SSH_V1:`） |
| **连接/进程状态** | 无状态；单次 `ssh -T -n -o BatchMode=yes` 执行，超时 30s |
| **探测流程** | 1. 构造 POSIX 兼容的探测脚本<br>2. 通过 ssh 执行 `set -eu; cd; uname -s/m; id -u; getconf GNU_LIBC_VERSION`<br>3. 捕获以 `CLAUDE_SSH_V1:` 开头的单行输出<br>4. 验证 kernel=Linux，libc=glibc，架构 x86_64/aarch64<br>5. 确定目标平台：linux-x64/linux-arm64 |
| **错误与安全** | 拒绝非 Linux glibc 目标；验证返回路径绝对且无换行；探测脚本无持久副作用 |
| **设计取舍** | 使用单行标记 JSON 避免 MOTD/shell rc 干扰；不部署文件；拒绝未知架构不做降级 |
| **源码测试证据** | `src/ssh/argv.ts:121-233`<br>`tests/sshSession.test.ts:267-305` |

#### 4.1.2 工件部署模块

| 项 | 细节 |
| --- | --- |
| **真实入口签名** | `loadSSHArtifact(options: { artifactRoot: string; version: string; target: SSHTarget }): Promise<SSHArtifact>`<br>`verifyRemoteArtifact(options: { host: string; probe: SSHProbe; artifact: SSHArtifact; directory: string; commandOptions?: RunCommandOptions }): Promise<'valid' | 'missing'>`<br>`deploySSHArtifact(options: { host: string; probe: SSHProbe; artifact: SSHArtifact; commandOptions?: RunCommandOptions }): Promise<string>` |
| **关键类型** | `SSHArtifactManifest: { protocol: 'ssh-v1'; version: string; target: SSHTarget; files: { bun: { sha256: string; mode: '0o755' }; main.js: { sha256: string; mode: '0o644' } } }`<br>`SSHArtifact: { root: string; directory: string; manifest: SSHArtifactManifest; manifestBytes: Buffer; digest: string }` |
| **输入输出** | 输入：本地工件根目录、版本、目标架构<br>输出：远程工件目录路径（已验证） |
| **连接/进程状态** | 无状态；多轮 scp/ssh 操作；超时：deploy 120s，verify 30s |
| **部署流程** | 1. 本地加载并验证 manifest、sha256、mode、目标匹配<br>2. 计算 manifest 摘要作为远程目录后缀<br>3. 检查远程 `~/.cache/claude-code/ssh/<version>-<digest>/` 是否存在且通过验证<br>4. 若缓存命中，跳过部署<br>5. 若缺失：创建临时目录 `mktemp -d`，scp bun/main.js/manifest.json，chmod 正确权限<br>6. 远程验证所有文件 sha256 与 manifest 一致<br>7. 原子重命名 `mv <temp> <target>`<br>8. 再次验证最终状态；失败清理临时目录 |
| **错误与安全** | 本地工件必须是常规文件，无符号链接；远程权限严格：bun 0755，main.js 0644，manifest 0600；原子重命名避免部分部署；拒绝覆盖不匹配的现有缓存 |
| **设计取舍** | 基于 manifest 摘要的缓存而非时间戳；scp 而非流式更简单；原子重命名避免并发部署损坏；sha256 验证在远程执行以防传输篡改 |
| **源码测试证据** | `src/ssh/artifact.ts:85-324`<br>`tests/sshSession.test.ts:307-343` |

#### 4.1.3 认证代理模块

| 项 | 细节 |
| --- | --- |
| **真实入口签名** | `createSSHAuthProxy(options: SSHAuthProxyOptions): SSHAuthProxy`<br>`resolveSSHAuth(): Promise<SSHResolvedAuth>`<br>`validateSSHAuthentication(resolve?: () => Promise<SSHResolvedAuth>): Promise<SSHAuthKind>` |
| **关键类型** | `SSHAuthProxyOptions: { socketPath: string; resolveAuth?: () => Promise<SSHResolvedAuth>; upstream?: { protocol: 'http:' | 'https:'; hostname: string; port?: number }; onError?: (error: Error) => void }`<br>`SSHAuthProxy: { socketPath: string; ready: Promise<void>; stopped: Promise<void>; stop: () => void }`<br>`SSHResolvedAuth: { kind: 'apiKey' | 'bearer' | 'oauth'; headers: Record<string, string> }` |
| **输入输出** | 输入：本地 Unix socket 路径，可选上游覆盖<br>输出：远程请求经代理注入凭证后转发至 Anthropic API |
| **连接/进程状态** | 有状态：HTTP 服务器监听 Unix socket；跟踪活跃客户端与上游连接；通过 dev+ino 验证 socket 身份防止替换 |
| **代理流程** | 1. 创建 Unix socket，权限 0o600<br>2. 记录 socket 的 dev+ino 身份<br>3. 接收远程连接：验证路径为 `/v1/*`，拒绝 CONNECT/TRACE<br>4. 移除 hop-by-hop headers，移除远程占位符授权头（`ssh-api-key-placeholder` 等）<br>5. 调用 `resolveAuth()` 获取本地真实凭证（apiKey/bearer/oauth）<br>6. 注入真实授权头，设置 `Host: api.anthropic.com`<br>7. 建立到上游的固定连接（TLS pinned）<br>8. 双向流式转发请求体与响应体<br>9. 处理 Bun 特殊情况：接受绝对 URL 但只保留路径部分 |
| **错误与安全** | 私钥/凭证永不离开本地；远程仅见占位符；仅接受 `/v1/*` 路径；请求头大于 64 KiB 拒绝；响应头大于 64 KiB 拒绝；stop 时验证 socket 身份再删除；stderr 输出自动 redact 可能的凭证 |
| **设计取舍** | Unix socket 而非 TCP 避免远程暴露；HTTP 代理而非自定义协议复用现有库；Bun 需要特殊处理因为它在 Unix socket 上发送绝对 URL；请求时才 resolve auth 支持刷新 OAuth token |
| **源码测试证据** | `src/ssh/sshAuthProxy.ts:64-599`<br>`tests/sshAuthProxy.test.ts:67-360` |

#### 4.1.4 远程 stream-json 传输模块

| 项 | 细节 |
| --- | --- |
| **真实入口签名** | `buildRemoteCLICommand(options: { cwd: string; bunPath: string; mainPath: string; remoteSocket: string; authPlaceholder: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'CLAUDE_CODE_OAUTH_TOKEN'; cli: SSHCliConfig; initialSessionId: string; reconnectSessionId?: string }): string`<br>`buildMainSSHArgv(options: { host: string; remoteSocket: string; localSocket: string; remoteCommand: string }): string[]` |
| **关键类型** | `SSHCliConfig: { permissionMode?: string; dangerouslySkipPermissions: boolean; extraCliArgs: string[] }`<br>行限制：stdin 1 MiB，stdout 4 MiB |
| **输入输出** | 输入：远程 cwd、工件路径、socket 路径、CLI 配置<br>输出：通过 ssh stdin/stdout 双向传输的 NDJSON 流 |
| **连接/进程状态** | SSH 进程无 TTY (`-T`)；`ServerAliveInterval=15`，`ServerAliveCountMax=3` 检测断开；`ExitOnForwardFailure=yes` 确保转发可用；`StreamLocalBindUnlink=yes` 清理旧 socket |
| **传输流程** | 1. 远程命令前缀：`cd <cwd> && exec env -u <所有 ingress vars> ANTHROPIC_UNIX_SOCKET=<remote-socket> ANTHROPIC_BASE_URL=http://api.anthropic.com <auth-placeholder>=<placeholder>`<br>2. 启动远程 `bun main.js --print --input-format stream-json --output-format stream-json`<br>3. 远程 stdout → 本地 NDJSON 解析<br>4. 本地 NDJSON 序列化 → 远程 stdin<br>5. 按换行符分割；丢弃超大行；缓冲不完整行 |
| **错误与安全** | 显式 unset 所有可能含凭证的 ingress 环境变量；占位符值无实际意义；远程连接本地代理仅通过转发的 Unix socket；NDJSON 行有大小限制避免 OOM |
| **设计取舍** | 复用现有 stream-json 格式与本地 REPL 相同；不分配 TTY 避免终端控制问题；HTTP 仅在本地 Unix socket 上使用（Bun 限制），代理升级到 TLS 连接上游 |
| **源码测试证据** | `src/ssh/argv.ts:235-318`<br>`src/ssh/createSSHSession.ts:206-251`<br>`tests/sshSession.test.ts:344-381` |

#### 4.1.5 权限 generation 隔离模块

| 项 | 细节 |
| --- | --- |
| **真实入口签名** | `SSHSessionManager.respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): boolean` |
| **关键类型** | `PermissionEntry: { generation: number; remoteRequestId: string; serialized: string }`<br>本地请求 ID 格式：`g<generation>:<remoteRequestId>` |
| **输入输出** | 输入：本地请求 ID（含 generation），用户响应（allow/deny）<br>输出：是否成功发送（仅同 generation 且 connected 状态） |
| **连接/进程状态** | generation 从 1 开始，每次 attach/重连递增；权限 Map 键为 `g<generation>:<remoteRequestId>`；跟踪 remoteRequestId 到 serialized request 以检测冲突 |
| **隔离流程** | 1. 新连接 attach 时 generation++<br>2. 收到远程 `control_request subtype=can_use_tool` 时：<br>   a. 检查 remoteRequestId 是否重复，内容不同则报告 CONTROL_ID_CONFLICT<br>   b. 构造本地 ID：`g<generation>:<remoteRequestId>`<br>   c. 记录 permission entry 含 generation<br>   d. 回调 onPermissionRequest 传递本地 ID<br>3. 用户响应时：<br>   a. 验证 entry 存在且 generation === 当前 generation<br>   b. 验证状态 === connected<br>   c. 构造 control_response 发送<br>4. 断开时 invalidatePermissions：清除所有 pending 权限<br>5. 旧 generation 的响应静默返回 false |
| **错误与安全** | generation 隔离防止用户点击旧连接的 UI 影响新会话；相同 remoteRequestId 不同内容视为冲突；权限响应只在 connected 状态发送 |
| **设计取舍** | 本地 ID 嵌入 generation 而非 UUID 更紧凑；旧响应静默丢弃而非报错避免用户困惑；不重播权限请求需要用户重新交互 |
| **源码测试证据** | `src/ssh/SSHSessionManager.ts:324-375, 582-585`<br>`tests/sshSession.test.ts:445-490` |

#### 4.1.6 重连与错误恢复模块

| 项 | 细节 |
| --- | --- |
| **真实入口签名** | `SSHSessionManager.connect(): boolean`<br>`SSHSessionManager.disconnect(): boolean`<br>`SSHSessionManager.isConnected(): boolean`<br>`SSHSessionManager.sendMessage(content: RemoteMessageContent): Promise<boolean>`<br>`SSHSessionManager.sendInterrupt(): boolean` |
| **关键类型** | `State: 'idle' | 'initializing' | 'connected' | 'reconnecting' | 'disconnecting' | 'disconnected'`<br>重连配置：`maxReconnectAttempts?: number; reconnectDelayMs?: (attempt: number) => number; gracefulEofMs?: number; sigkillDelayMs?: number` |
| **输入输出** | 输入：用户消息、中断、权限响应<br>输出：连接状态回调（onConnected/onReconnecting/onDisconnected/onError） |
| **连接/进程状态** | 状态机：idle → initializing → connected → reconnecting → connected 循环，或最终 disconnected；跟踪 activeSessionId 用于重连 `--resume`；pendingPrompts Set 记录未确认的用户输入；initTimer 默认 30s 等待 system/init |
| **重连流程** | 1. SSH 进程 close/error 触发 handleProcessClose<br>2. 若 disconnecting 或已正常退出（code 0 && connected）：finishDisconnected<br>3. 否则：<br>   a. notifyDeliveryUnknown：若有同 generation 的 pendingPrompts，报告 SSH_DELIVERY_UNKNOWN 错误<br>   b. invalidatePermissions：清除所有权限条目<br>   c. 检查是否为非重试错误（auth/host key/artifact 等）：若是，finishDisconnected<br>   d. 否则 scheduleReconnect：<br>      - 已连接过：最多 3 次；未连接过：最多 2 次<br>      - 延迟：1s, 2s, 4s 指数退避（2^(attempt-1)）<br>      - 状态转为 reconnecting，回调 onReconnecting(attempt, max)<br>      - ensureCurrentProcessStopped：SIGKILL 若仍在运行<br>      - 调用 reconnect(activeSessionId) 获取新连接<br>      - attach 新连接：generation++，重置状态为 initializing/reconnecting<br>4. 收到 system/init 后：状态转为 connected，回调 onConnected，reconnectAttempt 清零 |
| **错误与安全** | delivery unknown 明确告知用户消息可能丢失但不重播；重连不重新发送用户输入；旧 generation 的权限静默拒绝；disconnect 流程：先尝试发送 end_session，然后 gracefulEofMs 后 SIGTERM，sigkillDelayMs 后 SIGKILL；Host key 完全由 OpenSSH 处理，代码不绕过验证 |
| **设计取舍** | 有限重连避免资源浪费；指数退避避免快速重试；delivery unknown 而非自动重播因为上下文可能已变化；graceful shutdown 带超时确保最终清理；host key 不内联处理遵循用户已有 SSH 安全策略 |
| **源码测试证据** | `src/ssh/SSHSessionManager.ts:465-624`<br>`tests/sshSession.test.ts:491-530` |

### 4.2 入口与公共契约

#### 主会话入口

```typescript
// src/ssh/createSSHSession.ts
async function createSSHSession(
  options: CreateSSHSessionOptions,
  callbacks: { onProgress?: (message: string) => void }
): Promise<SSHSession>

type CreateSSHSessionOptions = {
  host: string
  cwd?: string
  localVersion: string
  permissionMode?: string
  dangerouslySkipPermissions: boolean
  extraCliArgs: string[]
  artifactRoot?: string
  environment?: NodeJS.ProcessEnv
  socketDirectory?: string
  authProxy?: Pick<SSHAuthProxyOptions, 'resolveAuth' | 'upstream'>
}

type SSHSession = {
  remoteCwd: string
  proc: ChildProcess
  proxy: { stop: () => void }
  getStderrTail: () => string
  createManager: (callbacks: SSHSessionCallbacks) => SSHSessionManager
}
```

#### 本地会话入口

```typescript
// src/ssh/createSSHSession.ts
async function createLocalSSHSession(
  options: CreateLocalSSHSessionOptions
): Promise<SSHSession>

type CreateLocalSSHSessionOptions = {
  cwd?: string
  permissionMode?: string
  dangerouslySkipPermissions: boolean
  environment?: NodeJS.ProcessEnv
  socketDirectory?: string
  executablePath?: string
  cliPath?: string
  authProxy?: Pick<SSHAuthProxyOptions, 'resolveAuth' | 'upstream'>
}
```

#### 会话管理器

```typescript
// src/ssh/SSHSessionManager.ts
class SSHSessionManager {
  constructor(options: SSHSessionManagerOptions, callbacks: SSHSessionCallbacks)
  connect(): boolean
  disconnect(): boolean
  async sendMessage(content: RemoteMessageContent): Promise<boolean>
  respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): boolean
  sendInterrupt(): boolean
  isConnected(): boolean
  getStderrTail(): string
}

type SSHSessionCallbacks = {
  onMessage: (message: SDKMessage) => void
  onPermissionRequest: (request: SDKControlPermissionRequest, requestId: string) => void
  onConnected: () => void
  onReconnecting: (attempt: number, maxAttempts: number) => void
  onDisconnected: () => void
  onError: (error: Error) => void
}

type SSHSessionManagerOptions = {
  connection: SSHManagedConnection
  reconnect?: (activeSessionId: string) => Promise<SSHManagedConnection>
  initTimeoutMs?: number
  maxReconnectAttempts?: number
  reconnectDelayMs?: (attempt: number) => number
  gracefulEofMs?: number
  sigkillDelayMs?: number
}
```

#### 认证代理

```typescript
// src/ssh/sshAuthProxy.ts
function createSSHAuthProxy(options: SSHAuthProxyOptions): SSHAuthProxy

type SSHAuthProxyOptions = {
  socketPath: string
  resolveAuth?: () => Promise<SSHResolvedAuth>
  upstream?: {
    protocol: 'http:' | 'https:'
    hostname: string
    port?: number
  }
  onError?: (error: Error) => void
}

type SSHAuthProxy = {
  socketPath: string
  ready: Promise<void>
  stopped: Promise<void>
  stop: () => void
}
```

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `createSSHSession` | 无状态（工厂函数） | 探测远程、加载工件、部署工件、启动代理、启动 SSH | 实际消息路由、重连逻辑 | 返回 `SSHSession` 带 `createManager` |
| `SSHSessionManager` | 连接状态、generation、activeSessionId、pendingPrompts、permissions Map、remotePermissionIds、计时器 | connect、disconnect、sendMessage、respondToPermissionRequest、sendInterrupt | 认证代理、工件部署 | `SSHSessionCallbacks` 回调接口 |
| `sshAuthProxy` | Server、sockets Set、upstreamRequests Set、stopping flag、identity (dev+ino) | start、stop、handleRequest、proxyToUpstream | SSH 连接、会话管理 | 本地 Unix socket HTTP 服务 |
| `artifact` | 无状态 | loadSSHArtifact、verifyRemoteArtifact、deploySSHArtifact | 运行时会话、认证 | 本地工件目录、远程缓存目录 |
| `argv` | 无状态 | validateSSHHost、buildProbeCommand、parseProbeOutput、buildMainSSHArgv、buildRemoteCLICommand、posixQuote | 实际执行、状态管理 | 构建命令行参数、解析探测输出 |
| `openSSH` | 无状态 | runCommand、classifyOpenSSHFailure、redactSSHDiagnostic | 会话逻辑、认证 | 封装子进程 spawn、错误分类 |

状态位置选择理由：

- **认证代理在本地**：凭证不离开本地；需要注入请求
- **generation 在 SSHSessionManager**：每次连接递增；权限请求隔离
- **pendingPrompts 在 SSHSessionManager**：跟踪未确认的用户输入；断线时通知 delivery unknown
- **工件缓存在远程**：避免重复上传；按版本 + digest 隔离

复制/共享/重置/清理：

- **复制**：消息对象通过 JSON 序列化传输，不共享内存
- **共享**：认证代理通过 Unix socket 共享给远程进程
- **重置**：重连时 generation 递增，旧 pending 权限失效
- **清理**：disconnect 时停止代理、关闭 SSH、清理计时器

### 4.3 主控制流

#### SSH 会话创建完整流

```text
用户调用 createSSHSession({ host, cwd, localVersion, ... })
  → 验证本地平台（macOS/Linux）
  → 验证 SSH host 格式
  → 解析 extraCliArgs（--continue/--resume/--model）
  → 验证 authentication（调用 resolveAuth）
  → 回调 onProgress('Probing remote host')
  → 探测远程：ssh -T -n -o BatchMode=yes -o ConnectTimeout=10 host sh -c '<probe-script>'
    → 脚本输出 CLAUDE_SSH_V1:{home,kernel,machine,libc,cwd,sha256,uid}
    → 验证 kernel=Linux, libc=glibc
    → 确定目标架构（x86_64/amd64 → linux-x64；aarch64/arm64 → linux-arm64）
  → 回调 onProgress('Validating <target> artifact')
  → loadSSHArtifact：读取本地 ~/.claude/ssh/artifacts/<version>/<target>/manifest.json
    → 验证 manifest 协议=ssh-v1、版本匹配、目标匹配
    → 验证 bun 和 main.js 的 sha256 和 mode（bun 0o755, main.js 0o644）
  → 回调 onProgress('Deploying verified artifact')
  → deploySSHArtifact：
    → 构造远程目录 ~/.cache/claude-code/ssh/<version>-<digest>
    → verifyRemoteArtifact：检查是否已存在且验证通过
    → 如已存在，跳过部署
    → 如不存在：
      → 创建临时目录（mktemp -d）
      → scp -p -q bun main.js manifest.json host:<tempdir>/
      → ssh 执行 chmod 和验证脚本
      → 原子重命名 tempdir → 目标目录
      → 再次验证
      → 清理临时目录（失败时也清理）
  → 回调 onProgress('Starting remote session')
  → 启动 launch()（内部函数）：
    → 生成随机 hex
    → 构造本地 socket 路径
    → 构造远程 socket 路径 /tmp/claude-ssh-<uid>-<randomhex>.sock
    → createSSHAuthProxy：启动本地代理
    → 等待代理 ready
    → 构造远程命令 buildRemoteCLICommand：
      → cd <cwd>
      → exec env -u <ingress vars> ANTHROPIC_UNIX_SOCKET=<remote-socket> ANTHROPIC_BASE_URL=http://api.anthropic.com <auth-placeholder>=<placeholder-value> <bun-path> <main-path> --print --input-format stream-json --output-format stream-json --session-id <id> ...
    → 构造 SSH argv：-T -o BatchMode=yes -o ExitOnForwardFailure=yes -o StreamLocalBindUnlink=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -R <remote-socket>:<local-socket> -- <host> <remote-command>
    → spawn ssh
    → 返回 { proc, proxy, getStderrTail }
  → 创建 session 对象，附加 createManager 闭包
  → 返回 session
```

#### 认证代理请求处理流

```text
远程进程通过 ANTHROPIC_UNIX_SOCKET 连接本地代理
  → 代理接收 HTTP 请求
  →  normalizeRequestPath：
    → 拒绝非 /v1/ 路径
    → 拒绝 CONNECT/TRACE
    → 处理 Bun 特殊情况（将绝对 URL 转换为路径）
  → resolveAuth() 获取本地凭证（apiKey/bearer/oauth）
  → filteredHeaders：
    → 移除 hop-by-hop headers（connection/keep-alive/proxy-*/etc）
    → 移除占位符授权头（authorization/x-api-key/cookie）
    → 注入真实授权头
    → 设置 Host: api.anthropic.com
    → 合并 anthropic-beta（保留远程的，添加本地的）
  → startPinnedUpstream：
    → 连接到真实上游（https://api.anthropic.com）
    → 发送请求（分块或 Content-Length）
    → 接收响应头
    → filteredResponseHeaders：移除 hop-by-hop，保留其他
    → 发送响应头给客户端
    → 双向流式传输响应体
  → 代理错误时返回 502 或其他错误
```

#### 消息流与权限请求流

```text
SSH 进程启动，stdout 输出 NDJSON
  → SSHSessionManager 附加 stdout 'data' 处理
  → 缓冲数据，按换行符分割
  → 跳过超大行（>4MB）
  → parseLine：
    → 解析 JSON
    → 如果 type=system 且 subtype=init：
      → 提取 session_id
      → 验证 UUID
      → clearInitTimer
      → reconnectAttempt 清零
      → 状态变为 connected
      → 回调 onConnected
    → 如果 type=control_request：
      → 验证 request_id 和 request.subtype
      → 仅支持 subtype=can_use_tool
      → 构造本地 ID：g<generation>:<request_id>
      → 记录到 permissions Map 和 remotePermissionIds Map
      → 如果 remotePermissionIds 已有相同 request_id 但不同内容：
        → 报告 CONTROL_ID_CONFLICT 错误
        → 发送 control_response error
      → 否则：
        → 回调 onPermissionRequest(request, localId)
    → 如果是其他 SDK 消息：
      → 清除 pendingPrompts（如果有）
      → 回调 onMessage
```

#### 用户输入与权限响应流

```text
用户发送消息 sendMessage(content)
  → 检查 writable(generation)
  → 构造 user 消息记录
  → 序列化为 NDJSON 行
  → 检查 <=1MB
  → write 到 proc.stdin
  → 如果 backpressure，等待 drain
  → 记录到 pendingPrompts（generation）
  → 返回是否成功

用户响应权限 respondToPermissionRequest(localId, result)
  → 从 permissions Map 查找 entry
  → 验证存在且 generation 匹配且 state=connected
  → 删除 entry
  → 构造 control_response 记录
  → writeRecordSync
  → 返回是否成功

用户中断 sendInterrupt()
  → 构造 control_request { subtype: 'interrupt' }
  → writeRecordSync
```

#### 断线重连流

```text
SSH 进程 exit 或 error
  → handleProcessClose(generation, code, signal)
  → 如果 state=disconnecting：finishDisconnected
  → 如果 code=0 且 state=connected：finishDisconnected
  → 否则：
    → notifyDeliveryUnknown(generation)
    → invalidatePermissions
    → 如果从未连接过且有特定错误（如 forward failed, host key failed）：
      → finishDisconnected
    → 否则：
      → scheduleReconnect
        → 检查是否有 reconnect factory
        → 检查 reconnectAttempt < maxAttempts（已连接 3 次，未连接 2 次）
        → 状态变为 reconnecting
        → 回调 onReconnecting(attempt, max)
        → 等待 delay（1s, 2s, 4s... 指数退避）
        → ensureCurrentProcessStopped
        → 调用 reconnect(activeSessionId) 获取新连接
        → attach(newConnection)
          → generation 递增
          → 重新设置 stdout/stderr/close 处理
          → 启动 initTimer（默认 30s）
```

#### 正常断开流

```text
用户调用 disconnect()
  → 如果状态已经是 disconnecting/disconnected：返回 false
  → 状态变为 disconnecting
  → clearInitTimer
  → 清除 reconnectTimer
  → invalidatePermissions
  → 尝试发送 control_request { subtype: 'end_session' } 到 stdin
  → end(stdin)
  → gracefulEofMs 计时器（默认 2s）：超时后 SIGTERM
  → sigkillDelayMs 计时器（默认 5s）：超时后 SIGKILL
  → proxy.stop()
  → finishDisconnected
```

### 4.4 数据结构与持久化

#### 关键数据结构

```typescript
// SSH 探测结果
type SSHProbe = {
  home: string
  kernel: 'Linux'
  machine: string
  libc: 'glibc'
  cwd: string
  sha256: 'sha256sum' | 'shasum -a 256'
  uid: number
  target: SSHTarget  // 'linux-x64' | 'linux-arm64'
}

// SSH 工件 manifest
type SSHArtifactManifest = {
  protocol: 'ssh-v1'
  version: string
  target: SSHTarget
  files: {
    bun: { sha256: string; mode: '0o755' }
    'main.js': { sha256: string; mode: '0o644' }
  }
}

// SSH 工件（加载后）
type SSHArtifact = {
  root: string
  directory: string
  manifest: SSHArtifactManifest
  manifestBytes: Buffer
  digest: string
}

// 已解析认证
type SSHResolvedAuth = {
  kind: 'apiKey' | 'bearer' | 'oauth'
  headers: Record<string, string>
}

// SSH 会话管理器状态机
type State = 'idle' | 'initializing' | 'connected' | 'reconnecting' | 'disconnecting' | 'disconnected'

// 权限条目（带 generation）
type PermissionEntry = {
  generation: number
  remoteRequestId: string
  serialized: string
}
```

#### 持久化策略

- **本地工件缓存**：`~/.claude/ssh/artifacts/<version>/<target>/`，包含 `bun`、`main.js`、`manifest.json`
  - 预填充，不运行时修改
  - `loadSSHArtifact` 每次验证完整性

- **远程工件缓存**：`~/.cache/claude-code/ssh/<version>-<digest>/`
  - 部署前验证是否已存在
  - 部署后验证 sha256 和 mode
  - 原子重命名防止部分部署

- **无运行时持久化**：
  - 会话状态只在内存
  - 重连靠远程会话恢复（通过 session_id）

#### 序列与因果约束

- session_id 是 UUID v4，初始创建或从 `--resume` 获取
- generation 每次连接（包括重连）递增，从 1 开始
- pendingPrompts 按 generation 跟踪，只在同 generation 内有效
- 权限 request_id 在同 generation 内唯一；跨 generation 可能重用但被隔离
- NDJSON 行必须 <4MB（stdout）和 <1MB（stdin）
- system/init 消息必须是第一条有效消息，包含有效 session_id

### 4.5 跨子系统依赖

| 上游输入 | 下游副作用 | 相关 spec |
|---|---|---|
| 本地凭证（apiKey/bearer/oauth） | 认证代理注入请求 |（本文描述）|
| 权限系统 | 权限请求 UI 展示和用户响应 | permissions |
| stream-json 协议 | 远程进程通信格式 |（与本地 REPL 共享）|
| SDK query | 远程进程实际执行 | sdk-query-sessions |
| 系统 OpenSSH | 远程连接、端口转发、文件传输 |（外部依赖）|

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| 远程探测失败（连接超时、认证失败、host key 失败） | `createSSHSession` 调用 `runCommand` 后 `classifyOpenSSHFailure` | 抛出 `SSHSessionError`（code: SSH_PROBE_FAILED / SSH_AUTH_FAILED / SSH_HOST_KEY_FAILED） | 不重试（创建时失败） | 无已分配资源 | 异常立即抛出，带 redacted stderr |
| 工件缺失或不匹配 | `loadSSHArtifact` | 抛出 `SSHSessionError`（code: SSH_ARTIFACT_MISSING / SSH_ARTIFACT_MISMATCH） | 不重试（配置问题） | 无已分配资源 | 异常立即抛出 |
| 工件部署失败（scp 失败、验证失败） | `deploySSHArtifact` | 抛出 `SSHSessionError`（code: SSH_DEPLOY_FAILED / SSH_ARTIFACT_MISMATCH） | 不重试（创建时失败） | 清理远程临时目录 | 异常立即抛出 |
| 认证代理启动失败 | `createSSHAuthProxy` ready Promise reject | `createSSHSession` 捕获后抛出 `SSHSessionError`（code: AUTH_PROXY_FAILED） | 不重试 | 代理停止，socket 清理 | 异常立即抛出 |
| 远程命令启动但立即退出（无 system/init） | `SSHSessionManager` initTimer 超时（默认 30s） | `onError` 回调，然后 `scheduleReconnect` | 未连接时最多 2 次重连，已连接后最多 3 次 | 当前代理停止，SSH 关闭，pending 失效 | `onReconnecting` → 成功时 `onConnected`，失败时 `onDisconnected` |
| SSH 连接意外断开（网络中断、ServerAlive 超时） | SSH 进程 'close' 事件 | `handleProcessClose` → `notifyDeliveryUnknown` → `invalidatePermissions` → `scheduleReconnect` | 最多 3 次（已连接后） | 当前代理停止，SSH 关闭，旧权限失效，pending prompts 报告 delivery unknown | `onReconnecting` → 成功时 `onConnected`，失败时 `onDisconnected` |
| 远程转发失败（远程 socket 已存在等） | `classifyOpenSSHFailure` 检测 stderr 中 'remote forward failed' | `onError` 回调，然后 `finishDisconnected` | 不重试（配置或冲突问题） | 清理连接和代理 | 立即 `onDisconnected` |
| pending prompt 期间断线 | `handleProcessClose` 检测 `pendingPrompts.has(generation)` | `onError` 回调（code: SSH_DELIVERY_UNKNOWN） | 不重试此 prompt（用户需要重新发送） | prompt 从 pending 清除 | 用户收到 error 回调，知道 delivery 未知 |
| 用户响应旧 generation 的权限请求 | `respondToPermissionRequest` 检查 `entry.generation === this.generation` | 静默返回 false，不发送 | 不重试 | 不修改状态，不发送 | 返回 false，调用方可以处理 |
| 远程发送无效 JSON | `parseLine` JSON.parse 失败 | `reportProtocolError` → `onError` 回调 | 不重试（继续处理后续行） | 跳过该行，不修改其他状态 | `onError` 收到 SSH_INVALID_ARGUMENT，会话继续 |
| 远程发送超大 NDJSON 行（>4MB） | `onStdout` 检测 line.length > MAX_STDOUT_LINE | `reportProtocolError` → `onError` 回调 | 不重试（继续处理后续行） | 跳过该行，缓冲清空 | 同上 |
| 远程发送相同 request_id 但不同内容的权限请求 | `onControlRequest` 检查 `previous !== undefined && previous !== serialized` | `onError` 回调（code: CONTROL_ID_CONFLICT），发送 control_response error | 不重试 | 记录冲突，不覆盖，不回调 onPermissionRequest | `onError` 收到错误，冲突响应发送回远程 |
| 断开时远程进程不退出 | `disconnect()` 设置 gracefulEofMs 计时器（2s）后 SIGTERM，sigkillDelayMs（5s）后 SIGKILL | 无回调（正常断开） | 不重试 | sigkill 后 finishDisconnected | `onDisconnected` 在进程实际退出后调用 |

## 6. 现状验收标准

1. 当调用 `createSSHSession` 时，系统必须先探测远程环境，验证是 Linux glibc 且架构为 x86_64/arm64，才能继续部署工件；不支持的目标必须抛出 `SSH_UNSUPPORTED_TARGET`。

2. 工件部署前必须验证本地 manifest、sha256 和 mode；部署后必须在远程再次验证；验证失败必须抛出 `SSH_ARTIFACT_MISMATCH` 或 `SSH_ARTIFACT_MISSING`。

3. 本地凭证（apiKey/bearer/oauth token）必须永远不发送到远程主机；远程只能看到占位符值；所有 API 请求必须通过本地认证代理注入真实凭证。

4. 认证代理必须只接受 `/v1/` 路径的请求；必须拒绝 CONNECT/TRACE 方法；必须过滤 hop-by-hop headers；必须移除远程发送的占位符授权头。

5. 当 SSH 连接断开时，系统必须自动重连最多 3 次（已连接后）或 2 次（从未连接），首次延迟 1s，后续指数退避；重连时必须使用相同的 session_id 调用 `--resume`。

6. 权限请求必须按 generation 隔离；旧连接的权限响应必须被静默拒绝；相同 request_id 但不同内容必须报告 `CONTROL_ID_CONFLICT`。

7. 如果用户输入在断线前未收到任何 SDK 消息确认，系统必须通过 `onError` 回调报告 `SSH_DELIVERY_UNKNOWN`。

8. Host key 验证必须完全由系统 OpenSSH 处理；代码不得使用 `StrictHostKeyChecking=no` 或 `UserKnownHostsFile=/dev/null`；host key 失败必须抛出 `SSH_HOST_KEY_FAILED`。

9. 本地和远程 Unix socket 必须设置 0o600 权限；代理必须通过 dev+ino 验证 socket 身份防止替换；停止时必须只清理自己创建的 socket。

10. 所有 SSH stderr 输出必须被 redact，移除可能的凭证；`getStderrTail()` 必须返回 redacted 版本。

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 远程环境探测使用带标记 JSON 输出 | `src/ssh/argv.ts:121-233` | `tests/sshSession.test.ts:267-305`（假 OpenSSH 探测解析） | 仅测试 linux-x64/arm64；不测试实际 SSH |
| 工件验证检查 manifest/sha256/mode/version/target | `src/ssh/artifact.ts:85-158` | `tests/sshSession.test.ts:307-323`（工件验证失败模式） | 测试使用假工件；真实工件由构建填充 |
| 部署使用 scp + 临时目录 + 原子重命名 + 远程验证 | `src/ssh/artifact.ts:241-324` | `tests/sshSession.test.ts:325-343`（部署失败清理、缓存命中） | 假 OpenSSH 模拟；不测试真实 scp |
| 认证代理注入凭证并过滤 headers | `src/ssh/sshAuthProxy.ts:417-599` | `tests/sshAuthProxy.test.ts:67-216`（三种 auth 类型、占位符过滤、host 固定、流式传输） | 真实上游测试使用 localhost 假服务器 |
| 认证代理拒绝非 /v1/、CONNECT/TRACE、过大 headers | `src/ssh/sshAuthProxy.ts:450-466` | `tests/sshAuthProxy.test.ts:218-244`（协议违规拒绝） | 测试覆盖主要违规情况 |
| 认证代理验证 socket 身份防止替换 | `src/ssh/sshAuthProxy.ts:564-569` | `tests/sshAuthProxy.test.ts:246-259`（不删除替换的 socket） | 测试仅验证清理逻辑 |
| 会话管理器按 generation 隔离权限 | `src/ssh/SSHSessionManager.ts:364-375` | `tests/sshSession.test.ts:445-490`（重连后旧权限被拒绝、不重播 prompts） | 测试使用本地 fixture 进程 |
| 重连策略：指数退避、有限重试、非重试错误直接失败 | `src/ssh/SSHSessionManager.ts:508-569` | `tests/sshSession.test.ts:491-530`（重连尝试次数、host key 不重试、pre-init 限制 2 次） | 测试使用假 fixture 控制退出 |
| 错误分类检测 auth failed / host key failed | `src/ssh/openSSH.ts:103-134` | `tests/sshSession.test.ts:531-545`（stderr redact、错误分类） | 测试匹配特定错误字符串 |
| 本地会话模式复用代理和 stream-json | `src/ssh/createSSHSession.ts:269-318` | `tests/sshAuthProxy.test.ts:261-360`（本地会话真实传输） | 测试验证本地也使用代理和占位符 |
| delivery unknown 通知未确认 prompts | `src/ssh/SSHSessionManager.ts:571-579` | `tests/sshSession.test.ts:478-490`（断线后通知 delivery unknown） | 测试仅检查通知，不重发 |
| socket 路径包含 uid 和随机值 | `src/ssh/argv.ts:328-337` |（设计推断；测试间接验证） | 路径长度验证在 validateSocketPath |
| 远程命令 unset 敏感环境变量 | `src/ssh/argv.ts:299-313` | `tests/sshSession.test.ts:344-381`（真实传输测试：无真实凭证泄露） | 测试验证占位符替换和 env 清理 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/ssh.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|---|---|---|---|
| ssh-session | SSH 会话创建：探测、工件、代理、SSH 启动 | `tests/sshSession.test.ts` | `src/remote/*`（远程控制，独立） |
| ssh-manager | SSH 会话管理器：状态机、重连、消息路由、权限隔离 | `tests/sshSession.test.ts` | `src/server/*`（direct-connect 服务器，独立） |
| ssh-auth-proxy | SSH 认证代理：Unix socket HTTP 服务、凭证注入、header 过滤、上游代理 | `tests/sshAuthProxy.test.ts` | `src/utils/teleport/*`（teleport API，外部） |
| ssh-artifact | SSH 工件：加载、验证、部署、缓存 | `tests/sshSession.test.ts` | 工件构建流程（不在代码库） |
| ssh-argv | SSH 参数构建：探测脚本、命令行、验证、quoting | `tests/sshSession.test.ts` | 其他命令参数 |
| ssh-errors | SSH 错误码和异常类 |（与其他模块共享） | 其他错误定义 |
| ssh-openssh | OpenSSH 封装：运行命令、分类错误、redact 诊断 | `tests/sshSession.test.ts` | 不包含 sshd 或服务器端 |
| ssh-tests | SSH 测试：会话、认证代理、错误处理 | `tests/sshSession.test.ts`、`tests/sshAuthProxy.test.ts` | 其他测试文件 |

相关子系统：

- `permissions`：权限决策框架，SSH 权限请求的本地仲裁
- `sdk-query-sessions`：SDK query 生命周期，远程进程实际执行
- `session-persistence`：会话 transcript 格式，`--resume` 的基础
- `remote-control`：远程控制服务器（独立，可选传输层）
- `bridge`：Bridge 协议（独立，非本文范围）

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | 当前工件部署需要本地预先存在 `~/.claude/ssh/artifacts/<version>/<target>/`；没有自动下载或打包机制 | 考虑在 CLI 构建时打包 SSH 工件，或首次使用时从可信源下载 | 中（需要构建流程变更） | 验证新用户可以直接使用 ssh 命令而无需手动预填充工件 | L | 已证实（当前需要外部预填充） |
| P2 | SSH 连接没有可视进度条或详细状态；部署大工件时用户可能不知道进度 | 添加更细粒度的 onProgress 回调（如 scp 进度百分比）或更长的超时提示 | 低（仅新增回调） | 验证各个阶段都有进度通知 | S | 已证实（当前只有 3 个进度消息） |
| P2 | `SSHSessionManager` 的重连逻辑在测试中使用 fixture 覆盖，但真实 SSH 断开没有集成测试 | 添加真实 SSH 集成测试（使用 localhost 或容器） | 低（仅新增测试，不改变生产代码） | 验证真实网络断开场景下重连正常 | M | 已证实（测试缺口明显） |
| P3 | 重连时没有任何状态同步机制；远程可能已前进但本地不知道已改变的工具状态 | 考虑在重连后请求远程发送状态摘要，或允许远程请求本地刷新视图 | 高（需要协议变更） | 验证重连后 UI 与远程状态一致 | XL | 设计推断（基于当前限制） |
| P3 | 当前仅支持 Linux glibc；可以考虑扩展到 musl libc（Alpine）或 BSD/macOS 远程目标 | 扩展探测脚本检测更多平台；构建对应架构工件 | 中（需要新增目标支持和测试） | 验证可以在 Alpine Linux 或 macOS 远程上运行 | L | 设计推断（基于当前代码结构） |
| P3 | 单次 scp 传输大文件在弱网下可能慢或失败；没有断点续传 | 考虑使用 rsync 或分块传输与校验 | 中（需要额外依赖或更复杂部署） | 验证大文件在弱网下可以可靠部署 | M | 设计推断 |
