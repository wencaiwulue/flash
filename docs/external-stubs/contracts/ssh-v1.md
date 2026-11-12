# SSH v1 契约

日期：2026-11-11
状态：前瞻设计，尚未实现；协议名称为 `ssh-v1`。

当前 `src/ssh/createSSHSession.ts` 与 `SSHSessionManager.ts` 是占位，但 `main.tsx` 和 `useSSHSession.ts` 已固定公开参数、REPL、权限和重连接口。本文定义 OpenSSH argv、可校验 artifact、auth proxy/socket 和远端生命周期，不声称兼容任何未公开部署协议。

## 1. 公开命令与边界

```text
claude ssh [--permission-mode <mode>] [--dangerously-skip-permissions]
           [--continue|-c] [--resume <session-id>] [--model <model>]
           <user@host | ssh-config-alias> [dir]
claude ssh --local [--permission-mode <mode>] [--dangerously-skip-permissions] [dir]
```

- v1 只支持本地交互 REPL；`-p/--print` 必须在早期解析时非零拒绝，绝不能退回本地执行。
- `--continue`、`--resume`、`--model` 由 `main.tsx` 白名单提取并传给 remote CLI。`createSSHSession` 必须再次验证 `extraCliArgs`，不能把任意参数或 shell 片段透传。
- host 可为 OpenSSH config alias、`user@host` 或合法 IP；拒绝以 `-` 开头、空白、分号、反引号、`$()`、换行和远端路径片段。host 只作为独立 OpenSSH argv，不当 shell 输入。
- `dir` 缺省为远端 `$HOME`；最终 cwd 必须经远端 `pwd -P` 规范化。permission mode 使用当前 CLI 的合法枚举；危险模式必须显式给出并显示警告。
- `--local` 只用于测试：跳过 probe、deploy 和 ssh，但仍启动真实本地 auth proxy、占位 env、stream-json 子进程和同一个 manager；不绕过认证注入。

支持平台为本地 macOS/Linux 及远端 Linux x64/arm64（glibc）。Windows 本地/WSL 和 musl 远端只有在另有对应 artifact 与真实测试时才能加入，不能静默执行错误二进制。

## 2. 总体时序与状态机

```text
validating → probing → artifact-ready → deploying → spawning
           → connected → reconnecting → connected
           → disconnecting → disconnected
                       ↘ failed
```

1. 本地完成 OAuth/API key 解析、必要的 refresh 和 `validateForceLoginOrg()`，失败则不连接远端。
2. probe 获取远端 home、OS/arch/libc、cwd 和 checksum 工具；只接受带唯一 marker 的合法 JSON。
3. 根据 `localVersion` 和远端 target 选择本地 artifact，校验 manifest；缺失/不匹配则失败，不执行临时下载的未校验二进制。
4. 若远端同版本同 digest artifact 已存在则复用；否则上传到随机临时目录、校验、原子 rename。
5. 启动本地 UDS auth proxy，再以 `ssh -R` 启动远端 CLI。收到第一条合法 `system/init` 才 `onConnected`，仅仅 spawn 成功不算 connected。
6. 非预期断开最多重连 3 次，退避 1/2/4 秒并调用 `onReconnecting(attempt,3)`；重连用相同 remote cwd 和显式 `--resume <activeSessionId>`，不使用可能选中其他会话的裸 `--continue`。
7. 用户 disconnect、正常远端 exit 或重试耗尽后停止 proxy 和旧进程，调用一次 `onDisconnected`。清理必须幂等，错误聚合不能遗留转发 socket。

重连不恢复正在执行的模型 HTTP turn，也不重发用户输入；REPL 显示“in-flight request lost”，历史从原生 transcript 恢复。旧 permission request 全部本地 deny/失效，旧 request ID 的迟到响应不得发给新进程。

## 3. OpenSSH argv 契约

所有本地进程通过 `spawn/execFile` 的数组参数启动，禁止 `shell:true`。动态远端命令必须整体经过一个统一 POSIX single-quote 函数（`'` 转为 `'\''`），并对 probe JSON 和 artifact 路径做白名单校验。不得设置 `StrictHostKeyChecking=no`、`UserKnownHostsFile=/dev/null`、`LogLevel=ERROR` 来掩盖 host-key/安全问题；使用调用者现有 OpenSSH config、known_hosts 和 agent。

### 3.1 Probe

```text
ssh -T -n -o BatchMode=yes -o ConnectTimeout=10 -- <host> <remoteProbeCommand>
```

`remoteProbeCommand` 是单个 argv，内容为固定 `sh -c` 脚本：输出 `CLAUDE_SSH_V1:` 前缀加 JSON，包含 `home`、`kernel`、`machine`、`libc`、`cwd`、`sha256`。`kernel=Linux`，`machine` 仅映射 `x86_64|amd64 → linux-x64` 和 `aarch64|arm64 → linux-arm64`；其他值返回 `SSH_UNSUPPORTED_TARGET`。

probe 需要验证远端 cwd 可进入并返回其 `pwd -P`，不能仅相信用户输入。远程 motd 不得混入 marker JSON；stderr 只保留有界诊断尾部。`BatchMode=yes` 表示 v1 只支持已有 agent/key/Kerberos 等非交互认证，密码/passphrase prompt 返回 `SSH_AUTH_FAILED` 并提示先配置 `ssh <host>`，不能从 NDJSON stdin 偷读密码。

### 3.2 Artifact 与部署

本地 artifact 目录：

```text
<artifact-root>/<localVersion>/<target>/
  bun
  main.js
  manifest.json
```

`manifest.json`：

```json
{
  "protocol": "ssh-v1",
  "version": "<与 MACRO.VERSION 完全一致>",
  "target": "linux-x64",
  "files": {
    "bun": {"sha256": "hex", "mode": "0755"},
    "main.js": {"sha256": "hex", "mode": "0644"}
  }
}
```

`main.js` 是同一 external feature profile 的 Bun bundle，artifact 中不包含 OAuth/API key、用户 settings 或原生 transcript。构建系统负责提供目标 Bun runtime；本机 macOS binary 不得上传 Linux。默认 artifact root 为 `~/.claude/ssh/artifacts`，测试可用显式路径覆盖。缺 artifact 返回 `SSH_ARTIFACT_MISSING`，不能将“远端已有任意 claude”当作版本匹配。

远端缓存为 `<probe.home>/.cache/claude-code/ssh/<version>-<manifestDigest>/{bun,main.js,manifest.json}`。部署流程：

1. 用固定 remote command 创建权限 `0700` 的随机同级临时目录；
2. 用 `scp -p -q -- <本地三个文件> <host>:<临时目录>/` 上传，host 和路径均按上文校验；
3. 远端用已探测的 `sha256sum` 或 `shasum -a 256` 逐文件核验，chmod 后验证 manifest；
4. 以原子 `mv` 发布完整目录，失败删除临时目录；若目标已存在则重新校验后复用，不覆盖正在运行的版本。

artifact cache 可保留，转发 socket、临时上传目录和远端临时日志必须清理。部署不 sudo、不写 `/usr/local`、不修改远端 shell profile。

### 3.3 主会话与重连

主会话 argv 顺序固定：

```text
ssh -T
    -o BatchMode=yes
    -o ExitOnForwardFailure=yes
    -o StreamLocalBindUnlink=yes
    -o ServerAliveInterval=15
    -o ServerAliveCountMax=3
    -R <remoteSocket>:<localSocket>
    -- <host>
    <remoteCommand>
```

不使用 `-n/-N/-f`，stdin 保留给 NDJSON，stdout 只给 remote CLI stream-json，stderr 由本地 ring buffer 保存最多 32 KiB。`remoteCommand` 是单个参数，逻辑为：

```sh
cd -- <quotedCanonicalRemoteCwd> && exec <quotedArtifactBun> <quotedArtifactMainJs> \
  --print --input-format stream-json --output-format stream-json \
  --session-id <uuid> [白名单模型/权限/resume 参数]
```

初始 session ID 由本地生成并持久于 session 对象；若用户传 `--resume`，则使用该已有 remote ID。重连命令把初始 session 参数替换为 `--resume <activeSessionId>`，并保持同一 cwd、model 和权限配置。`--dangerously-skip-permissions` 只能作为独立 flag 追加；不得通过 artifact/env 默认开启。

local socket 位于 `$TMPDIR/claude-ssh-<uid>-<random>.sock`，remote socket 为 `/tmp/claude-ssh-<remoteUid>-<sameRandom>.sock`，路径均小于 100 字节；proxy/socket 权限 `0600`。每次重连生成新随机对，旧 socket 先关闭再启动新转发，避免串会话。

## 4. Auth proxy 与 socket 协议

### 远端环境

先清除远端继承的 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN` 和其他 session ingress 变量，再设置：

```text
ANTHROPIC_UNIX_SOCKET=<remoteSocket>
ANTHROPIC_BASE_URL=https://api.anthropic.com
```

根据本地实际认证只设置一个占位：`ANTHROPIC_API_KEY=ssh-api-key-placeholder`、`ANTHROPIC_AUTH_TOKEN=ssh-bearer-placeholder` 或 `CLAUDE_CODE_OAUTH_TOKEN=ssh-oauth-placeholder`。OAuth 占位用于让远端保持 OAuth header 形状，真实 token 永不到远端。`managedEnv.ts` 的 `withoutSSHTunnelVars()` 必须继续阻止远端 settings.env 覆盖这些值。

### 本地代理

proxy 只监听上述随机 UDS，接收标准 HTTP/1.1，支持流式/chunked body。安全规则：

1. 仅接受 origin-form path 和以 `/v1/` 开头的请求；拒绝 absolute-form URL、CONNECT、TRACE、任意 Host 重定向和 header 超过 64 KiB。上游固定 `https://api.anthropic.com`，Host 固定 `api.anthropic.com`。
2. 删除入站 `Authorization`、`x-api-key`、Cookie、Proxy-Authorization 及 hop-by-hop headers，绝不把占位透传到上游。其他 headers/body 在大小限制内流式转发。
3. 每次请求在本地重新解析/刷新认证：API key 注入 `x-api-key`，bearer 注入 `Authorization: Bearer`，OAuth 另补当前实现要求的 OAuth beta header。复用现有 auth 函数，不在 proxy 另存长期 token 文件。
4. 响应状态、必要 headers 和 body 原样流式返回，移除 hop-by-hop headers；proxy 不记录 prompt、response、token 或完整请求头。
5. 非 Anthropic API 的 MCP/SSE/fetch 不走此 socket；继续遵守 `getProxyFetchOptions({forAnthropicAPI:true})` 的唯一适用范围。认证失败、上游异常或 socket 协议错误失败关闭，不回退到远端 settings 中的凭据。

本地 `--local` 使用同一个 proxy，只是没有 `ssh -R`，子进程直接连接 local UDS。`proxy.stop()` 必须停止接受新连接、结束现有 socket 并 unlink 自己创建的路径；不得 unlink 已被其他实例替换的 socket。

## 5. NDJSON、权限与幂等

`SSHSessionManager` 的消息形状与 Direct Connect 一致：

- client→remote：`SDKUserMessage`、`control_response`、`control_request/interrupt`；
- remote→client：SDK messages 和 `control_request/can_use_tool`；
- `convertSDKMessage()` 与 `createSyntheticAssistantMessage()` 继续负责 REPL 展示，不在 SSH 层另写 renderer。

每条 stdin 记录以 `\n` 结束，最大 1 MiB；stdout 按跨 chunk 缓冲区逐行解析，单行最大 4 MiB。非法 JSON、未知 control 和错误必须进入 `onError`，未知 control request 回 error，不能静默挂起。`sendMessage`、permission response 和 interrupt 仅在 connected 且 stdin 可写时返回 true，遵守 backpressure；失败返回 false，不缓存后偷偷重放。

request ID 在单次 SSH 连接内去重；同 ID 同内容可忽略重复，不同内容报 `CONTROL_ID_CONFLICT`。进程重启使用新的 connection generation，旧 generation 的响应无效。stdin 已写但远端未确认的 prompt 在断线时标为 `delivery_unknown`；不自动重发，因为无法保证模型和工具副作用 exactly-once。`sendInterrupt()` 只影响当前 generation，不能中断重连后的新 turn。

正常 disconnect 先尝试 `end_session`/EOF，等待最多 2 秒，再对同一 SSH 子进程 SIGTERM；5 秒后仍在才 SIGKILL。只杀本地创建的 ssh/本地测试子进程，不用远端 `pkill`、`killall claude` 或模糊 PID 匹配。

## 6. 错误与恢复语义

稳定错误码：

- 参数/平台：`SSH_INVALID_ARGUMENT`、`SSH_UNSUPPORTED_TARGET`、`SSH_HEADLESS_UNSUPPORTED`；
- OpenSSH：`SSH_AUTH_FAILED`、`SSH_HOST_KEY_FAILED`、`SSH_PROBE_FAILED`、`SSH_FORWARD_FAILED`、`SSH_CONNECTION_LOST`；
- artifact：`SSH_ARTIFACT_MISSING`、`SSH_ARTIFACT_MISMATCH`、`SSH_DEPLOY_FAILED`；
- proxy：`AUTH_PROXY_FAILED`、`AUTH_PROXY_PROTOCOL_ERROR`；
- 生命周期：`SSH_INIT_TIMEOUT`、`SSH_RECONNECT_EXHAUSTED`、`SSH_DELIVERY_UNKNOWN`、`CONTROL_ID_CONFLICT`。

OpenSSH 认证/host-key/artifact/schema 错误不重试。网络、代理暂时失败和 5xx 只在同一创建阶段重试至多 2 次；已 connected 的进程按第 2 节最多三次重连。`getStderrTail()` 只提供脱敏有界文本，UI 在首次连接失败或非零退出时显示；正常 exit 的 verbose stderr 不冒充错误。

启动超时 30 秒、每次重连 init 超时 30 秒。超时后清理该 generation 再决定重试；不得同时保留两个 remote writer。proxy 或 artifact 失败不能通过“远端直接读 API key”降级。

## 7. 关键文件复用

- `/Users/fengcaiwen/GolandProjects/claude-code/src/main.tsx`：host/dir/flag 解析、headless 拒绝和 `SSHSession` 注入。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/ssh/createSSHSession.ts`：probe、artifact、OpenSSH、proxy 和本地模式。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/ssh/SSHSessionManager.ts`：NDJSON、control、重连与 backpressure。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/hooks/useSSHSession.ts`：保持现有回调、REPL 权限和最终错误展示。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/auth.ts`、`utils/managedEnv.ts`、`utils/proxy.ts`：本地认证、占位 env 和 Unix transport 边界。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/remote/remotePermissionBridge.ts`、`remote/sdkMessageAdapter.ts`：复用权限与消息转换。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/sessionStorage.ts`：远端原生 transcript 的 resume 规则，不复制 supervisor 日志当历史。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/daemon/supervisor.ts`：只参考有界退避，不自动重启用户 turn。

可在 `src/ssh/` 新增 `sshAuthProxy.ts`、`artifact.ts`、`argv.ts` 和 schema；不得把 auth token 写进 artifact 或 registry。

## 8. 测试与 dist/live 验收

### 单元与离线集成

新增 `tests/sshSession.test.ts`、`tests/sshAuthProxy.test.ts`：

1. fake `ssh/scp` 记录精确 argv，验证无 `shell:true`、无关闭 host-key 检查、host/dir/prompt 元字符不能注入、主会话无 `-n` 且 `-R` 正确。
2. probe 非 JSON/伪造 marker/不支持 arch、cwd 规范化、artifact 版本/digest/权限、并发部署和失败清理。
3. 用真实 UDS + loopback fake upstream 验证 API key/bearer/OAuth 注入、占位被剥除、固定 Host、流式响应、非 `/v1/` 与 absolute URL 拒绝、日志无 secret。
4. NDJSON 跨 chunk、非法消息、权限 allow/deny、旧 generation 响应、断线不重发 prompt、三次重连与资源清理。
5. `--local` 同样走 proxy；settings.env 不能覆盖隧道变量；stderr 脱敏和 disconnect 幂等。

### dist

实现与 `SSH_REMOTE` 同波加入 feature profile 后，运行 `bun run typecheck`、专项测试、`bun run build`。在隔离配置目录和 fake model upstream 下执行 `dist/main.js ssh --local <temp-cwd>`，完成 init、两轮消息、权限、interrupt 和 disconnect；检查 `dist/types/ssh/*.d.ts`、external profile 和无残留 socket/子进程。再执行 `tests/enabledFeatures.test.ts`。source 测试或 help 出现 ssh 不代表 dist 通过。

### live

仅在明确授权的 Linux 主机执行：先手工验证 OpenSSH host key 和 `ssh <host>`，再从已批准 artifact 完成 probe/deploy、真实模型 turn、权限确认、一次断网重连和清理；检查远端 env/settings/artifact 中无真实 token。x64 与 arm64 分开记录，未测试的平台不得写 verified。无授权主机或模型则 live 标 skipped，`--local` 和 fake upstream 只能记 offline。最终运行全量 `bun test`、typecheck、build，并保留仓库基线 cron/LSP 失败的独立记录。
