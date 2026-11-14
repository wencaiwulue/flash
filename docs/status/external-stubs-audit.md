# External Stub 总审计与恢复清单

> 历史审计基线：本文中的“当前行为”指 2026-11-11 审计时的源码状态；后续公开实现和验证结果以 `../external-stubs/verification.md` 及 `../STATUS.md` 为准，不将本表逐行视为当前实现清单。

日期：2026-11-11。

## 1. 范围、口径与数量

本清单基于对 `src/` 生产源码的静态扫描及调用入口复核，覆盖显式 external stub、固定 `unavailable`、固定失败、空实现和丢弃输入的实现。测试、生成产物、正常 fallback、以及仓库中已有真实实现但仅受 feature gate 控制的代码不计为 stub。行号以本日期工作树为准。

- **共 82 个审计项**：Wave 1 为 4 项，Wave 2 为 8 项，Wave 3 为 12 项，Wave 4 为 11 项，Wave 5 为 9 项，Wave 6 为 38 项。
- 其中 **81 项已完成公开实现与 offline 验证**；**1 项支持实现也已完成回归**。18 个 slash stub 和 9 个 ant 维护 handler 均逐项计数，未合并凑数。
- `NI`：当前为固定失败、空实现或占位 UI，状态为 **Not implemented**。
- `P`：已有公开后端或部分实现，但目标能力仍不完整，状态为 **Open implementation / partial**；绝不是私有兼容证据。
- `S`：支持代码已有真实行为，不是运行时空 stub；仍需补相应回归测试。
- `V-offline`：公开实现、入口和本地专项/集成测试已完成；真实 Cloud、桌面、SSH、外部 runner 或私有协议兼容仍需独立的 live 证据，不能由 V-offline 推断。
- 表中的“测试”均为**目标测试**。除明确列出的 `tests/openBackends.test.ts`、`tests/udsMessaging.test.ts` 等复用证据外，本次在 `tests/` 未找到这些 stub 的同名专项测试；不得把目标测试写成已执行结果。
- 本阶段只审计和设计，没有修改生产源码，也没有把任何项目提升为 Verified。协议与 live 门禁见 [`../external-stubs/protocol-gates.md`](../external-stubs/protocol-gates.md)，执行证据见 [`../external-stubs/verification.md`](../external-stubs/verification.md)。

**完成口径**：用户要求全部实现，因此最终方案不是保留 NI/P、删除命令或永久显示 unavailable。每项必须完成公开实现、入口、测试和相应 dist 验证；真实私有协议若没有兼容证据，可以如实标记“公开实现已验证、私有兼容未验证”，但不能据此保留 stub 或宣称私有功能恢复。

## 2. Wave 1：入站 sanitizer 与 3 个 renderer

共同测试要求：新增严格 envelope、可信来源、伪造标签、闭合标签、Unicode/超长输入、REPL 与 print 双入口、重放去重和 dist 测试；合法普通 Remote Control 消息在 webhook gate 开启时仍必须入队。目标结构遵循 `contracts/inbound-envelope.md` 与 `contracts/peer-messaging.md`。

| ID | 当前行为、位置、入口与 gate | 可复用实现 → 目标公开实现 | 测试 / 当前状态 |
|---|---|---|---|
| W1-01 | `src/bridge/webhookSanitizer.ts:7-10` 对字符串或 blocks 固定抛错；`src/hooks/useReplBridge.tsx:217-256` 在 `KAIROS_GITHUB_WEBHOOKS` 下对**所有**入站用户内容调用它，故普通消息也会被阻断。 | 复用 `bridge/inboundMessages.ts`、`inboundAttachments.ts`、`utils/sanitization.ts` → 先以可信 transport `source` 分流，普通消息不清洗；webhook 只接受文本，输出带 schema/event/delivery/untrusted 的唯一安全 wrapper，非法输入 fail closed。 | 普通/webhook 分流、伪造 source、坏 block、sanitizer 异常零入队、正文不落日志；**V-offline**。 |
| W1-02 | `src/components/messages/UserGitHubWebhookMessage.ts:5-20` 忽略 `param` 并显示 unavailable；`src/components/messages/UserTextMessage.tsx:94-108` 仅凭正文前缀路由，gate 为 `KAIROS_GITHUB_WEBHOOKS`。 | 复用 `UserChannelMessage`、`UserTeammateMessage` 和 Ink `Box/Text` → 只有可信 `origin.kind=github-webhook` 且完整 JSON schema 匹配才渲染事件摘要和不可信正文；正文标签不再证明来源。 | 合法事件、坏 JSON、伪 origin、伪造片段、普通同标签文本；**V-offline**。 |
| W1-03 | `src/components/messages/UserCrossSessionMessage.ts:5-20` 丢弃消息体并显示 unavailable；`UserTextMessage.tsx:164-174` 在 `UDS_INBOX` 下按 `<cross-session-message` 路由。 | 复用 UDS `udsClient` 消息形状、`UserTeammateMessage` → 与 bridge peer 共用严格 wrapper/escape 解析，显示 from、transport 和正文，回复地址只取结构化 from，UDS/bridge 不混标。 | UDS 与 Sessions 往返、恶意闭合标签/属性、回复地址、本地回归；**V-offline**。 |
| W1-04 | `src/components/messages/UserForkBoilerplateMessage.ts:5-20` 丢弃 `param` 并显示 unavailable；`UserTextMessage.tsx:151-162` 在 `FORK_SUBAGENT` 下路由。 | 复用 fork 消息生成器和可折叠消息组件 → 完整解析唯一 boilerplate wrapper，默认折叠规则/格式，仅展示 directive，保留 margin 和普通消息语义。 | 合法/畸形/多 wrapper、指令中的标签文本、折叠展开和 dist fork；**V-offline**。 |

## 3. Wave 2：snapshot、attribution、分类器与 MCP monitor

| ID | 当前行为、位置、入口与 gate | 可复用实现 → 目标公开实现 | 测试 / 当前状态 |
|---|---|---|---|
| W2-01 | `src/components/agents/SnapshotUpdateDialog.tsx:7-12` 的 `buildMergePrompt` 抛错，`:22-33` 自动 `onCancel` 且忽略全部 props；`src/main.tsx:3277-3305` → `dialogLaunchers.tsx:42-62`；gate 为 `AGENT_MEMORY_SNAPSHOT`。 | 复用 `tools/AgentTool/agentMemory.ts` 的 scope/path、`interactiveHelpers` 和选择对话框 → 提供 merge/keep/replace 三选项与时间戳，merge prompt 明确 agent/scope/路径/保留用户内容，cancel=keep，清理 pending 状态但不能误删记忆。 | 三选项、cancel、三种 scope、merge prompt、实际记忆文件和 dist `--agent`；**V-offline**。 |
| W2-02 | `src/utils/attributionHooks.ts:1-11` 的注册、缓存清理和 sweep 全为 no-op；入口分别为 `src/setup.ts:350-360`、`commands/clear/caches.ts:105-109`、`services/compact/postCompactCleanup.ts:71-75`；gate 为 `COMMIT_ATTRIBUTION`。 | 复用 `sessionFileAccessHooks`、`commitAttribution.ts:402-489` 的文件跟踪、`:872-965` 的快照/恢复 → 注册真实 Pre/PostToolUse 与 prompt/commit 生命周期，维护有界文件缓存，清理幂等且不重复 hook。 | 临时 git 仓库中的创建/修改/删除/批量修改、重复注册、compact/clear、快照恢复；**V-offline**。 |
| W2-03 | `src/utils/postCommitAttribution.ts:1-8` 的 `installPrepareCommitMsgHook` 固定抛错；`src/utils/worktree.ts:603-622` 在 `COMMIT_ATTRIBUTION` 下于 worktree 创建后调用，当前仅记录失败并继续。 | 复用 `utils/git.ts`、`commitAttribution.ts` 和配置目录安全写入 → 幂等安装 prepare-commit-msg 钩子，保留既有用户钩子，支持 worktree 自定义 hooks dir、原子写入和正确权限，不覆盖未管理内容。 | 空/已有/自定义 hook、重复安装、worktree、并发、失败回滚和真实 commit；**V-offline**。 |
| W2-04 | `src/utils/attributionTrailer.ts:6-10` 永远返回 `[]`；`src/utils/attribution.ts:376-389` 仅在 `COMMIT_ATTRIBUTION && isInternal && attributionData` 时调用。 | 复用 `AttributionData`、`AttributionState`、`sanitizeModelName` → 生成合法、稳定、可 squash 保留的公开 git trailers，包含贡献统计但不泄露私有 repo/model；公开仓库也可使用经过 sanitization 的数据。 |  trailer 格式、特殊字符、多文件、零数据、公开/内部模型名和 squash 集成；**V-offline**。 |
| W2-05 | `src/utils/permissions/bashClassifier.ts:14-60`：解析返回 null、三组描述返回 `[]`、enable=false、分类固定不命中，描述生成仅回显 specific；入口 `tools/BashTool/bashPermissions.ts:1463-1618,1860-1895`、两个权限 UI 与 `yoloClassifier.ts:502-506`。 | 复用权限规则解析、`sideQuery`、`permissionExplainer` 的 forced-tool 模式、`classifierDecision` → 实现 `prompt:` 规则解析和 deny/ask/allow 提取，严格校验结构化模型分类及超时/abort；非法、低置信或失败不得自动放行，allow 也不能越过确定性 deny。 | 规则往返、三类优先级、伪造输出、超时/abort/低置信 fail closed、UI 持久规则；**V-offline**。 |
| W2-06 | `src/jobs/classifier.ts:3-8` 固定抛错；`src/query/stopHooks.ts:100-131` 在 `TEMPLATES + CLAUDE_JOB_DIR + repl_main_thread + 非 subagent` 下等待它并仅有 60 秒兜底。 | 复用 assistant messages、`queryHaiku`、原子 JSON 写入 → 生成版本化 job state（状态、摘要、工具进度、时间戳），写临时文件后 rename；分类失败保留最后良好状态且不阻断主 query。 | 空/多 turn、工具摘要、坏模型输出、超时、并发写、原子性和 `claude list`；**V-offline**。 |
| W2-07 | `src/tasks/MonitorMcpTask/MonitorMcpTask.ts:10-30`：kill 返回 false、按 agent 清理返回 0、task kill 抛错；`src/tasks.ts:12-30`、`BackgroundTasksDialog.tsx:150-153,355-357`、`AgentTool/runAgent.ts:851-852`；gate 为已开放的 `MONITOR_TOOL`。 | 复用 local-shell Monitor 的任务语义、`utils/task/framework.ts`，并升级到带公开 Tasks schema 的 MCP SDK → 仅在服务端声明 capability 后建立 localId↔remoteTaskId，使用 `tasks/get/list/cancel` 同步；确认 cancelled 才标 killed，agent 批量清理只计确认终态。 | fake MCP Tasks、迟到状态、cancel 不支持/超时/断连、重复取消、agent 清理和真实 server；**V-offline**。 |
| W2-08 | `src/components/tasks/MonitorMcpDetailDialog.tsx:13-22` 忽略 task/onKill，只显示 unavailable；入口 `BackgroundTasksDialog.tsx:556-562`。 | 复用 `ShellDetailDialog`、`RemoteSessionProgress` → 显示 server/tool/status/最近输出/错误，running 时提供真实 kill，完成态隐藏 kill，长输出有界。 | 各状态、kill callback、长输出、键盘返回和任务集成；**V-offline**。 |

## 4. Wave 3：peer、Chrome 与 Computer Use

| ID | 当前行为、位置、入口与 gate | 可复用实现 → 目标公开实现 | 测试 / 当前状态 |
|---|---|---|---|
| W3-01 | `src/bridge/peerSessions.ts:1-5` 永远 `{ok:false}`；`SendMessageTool.ts:631-655,741-774` 在 `UDS_INBOX`、活动 bridge 和显式跨机器授权后调用。 | 复用 `utils/teleport/api.ts` 的 Sessions event helper、`replBridgeHandle`、`sessionIdCompat` → 向目标 compat `session_*` 发真实事件，生成可信 from 和转义 wrapper；禁止写自身 transport/UDS，200/201 仅表示 accepted。 | mock Sessions、禁止路径、自身/坏 ID、无自动重试、UDS 回归；两个授权 session 双向 live；**V-offline**。 |
| W3-02 | `src/external-stubs/claude-for-chrome-mcp.ts:67-117` 创建 isolated/headless Playwright MCP，`:80-83` 忽略完整 `ClaudeForChromeContext`；入口 `services/mcp/client.ts:905-925`、`claudeInChrome/mcpServer.ts:248-254`、`WebBrowserTool.ts:25-38`；工具 gate 为已开放的 `WEB_BROWSER_TOOL`。 | 保留独立 `isolated` WebBrowser；复用 `@playwright/mcp` 的公开 CDP 能力与 `claudeInChrome/setup.ts` → 增加显式 `chrome-cdp` 后端，只连用户同意的 loopback 专用持久 profile，消费 logger/endpoint/timeout/origins/permission/disconnect/telemetry；旧 socket/pairing 字段明确拒绝，失败不得回退 isolated。 | 现有 `openBackends.test.ts:51-74` 只证明本地 Chromium；补 fake/real CDP 的 tabs/cookie/context 保留、双 client 隔离、非 loopback 拒绝和 isError，并做真实 Chrome live；**V-offline（Open CDP），私有扩展协议未验证**。 |
| W3-03 | `src/external-stubs/computer-use-input.ts:24-25` 固定 `isSupported=false`；`inputLoader.ts:22-29` 因此抛错，`executor.ts` 的鼠标键盘/frontmost 调用不可达。 | 复用 `ComputerUseInputAPI` 与 executor → 实现公开平台输入适配器（macOS CGEvent/辅助功能，后续 XTest/Windows SendInput），支持 move/button/scroll/location/key/keys/type/frontmost，不用 shell 拼命令。 | fake native 全方法、按键释放/异常清理、坐标、Unicode；授权桌面输入 live；**V-offline**。 |
| W3-04 | `computer-use-swift.ts:82-85` 的 `display.getSize/listAll` 经 `:78-80` 抛私有包 unavailable；`swiftLoader.ts:15-20` 仅 darwin 加载。 | 复用 `DisplayGeometry` 和 executor → 公开 macOS 原生 helper 枚举 display ID、逻辑尺寸、scale、origin，多显示器坐标一致。 | 单/多屏、缩放、负 origin、热插拔；**V-offline**。 |
| W3-05 | `computer-use-swift.ts:87-90` 的 `captureExcluding/captureRegion` 全抛错；由 executor screenshot/zoom 进入。 | 复用 `ScreenshotResult`、`drainRunLoop` → 用公开 ScreenCaptureKit/CGWindow API 实现允许应用过滤、区域/目标尺寸、JPEG 和 display metadata；不得截获未授权窗口。 | 尺寸、过滤、区域、错误/取消、无屏幕录制权限；授权桌面截图；**V-offline**。 |
| W3-06 | `computer-use-swift.ts:92-102` 的 9 个 apps 方法全抛错，影响 prepare/preview/window mapping/hit-test/install/icon/running/open/unhide。 | 复用 `ComputerExecutor`、权限 UI 的 AppGrant → 以 NSWorkspace/AXUIElement 等公开 API 实现全部方法，prepare/unhide 可恢复且 hide 集与授权集一致。 | 每方法单测、隐藏失败回滚、应用退出、图标缺失、目标应用切换；**V-offline**。 |
| W3-07 | `computer-use-swift.ts:104-107` 的 accessibility/screenRecording 检查全抛错；`hostAdapter.ts` 的 OS 权限链因此不可用。 | 复用 `ensureOsPermissions` → 实现 AXIsProcessTrusted 与 ScreenCaptureKit 权限预检，区分未授权/已授权，不自动伪造授权。 | 两种权限四组合、授权变更和 fail closed；**V-offline**。 |
| W3-08 | `computer-use-swift.ts:109-113` 的 escape 注册、注销、expected notify 全抛错；`escHotkey.ts:27-53` 直接调用。 | 复用 escHotkey 生命周期 → 实现全局/本地 escape 监听、幂等注销、预期 escape 去重，组件卸载后无回调。 | 注册失败、重复注销、正常/预期 escape、abort；**V-offline**。 |
| W3-09 | `computer-use-swift.ts:115-116` 的 `resolvePrepareCapture` 抛错；executor 的 prepare+capture 主路径不可用。 | 组合公开 display/apps/screenshot 实现 → 支持 preferred display、autoResolve、doHide、allowlist 和隐藏/激活结果，失败时恢复现场。 | 自动选屏、pin、doHide、失败恢复和主 run-loop 不挂起；**V-offline**。 |
| W3-10 | `computer-use-swift.ts:118-119` 的 `_drainMainRunLoop` 抛错；`drainRunLoop.ts:20-27` 需要它避免主线程 API 挂起。 | 复用 drain registry → 用公开 CFRunLoop pump，只 drain 有限周期，嵌套/退出安全，不能变成无限忙循环。 | 重入、停止、异常、无 hang 和资源清理；**V-offline**。 |
| W3-11 | `computer-use-mcp.ts:54-105` 有真实 Zavora client/server，但同步 `:87-99` 只给宽松 schema，`:101-105` 忽略 adapter/coordinateMode；`:115-167` dispatch 只要求 allowedApps 非空，未按 target_app 精确核验。入口 `computerUse/setup.ts:22-50`、`mcpServer.ts:29-41`、`wrapper.tsx:285`。 | 保留 `open-zavora` 后端并分层；真实目录统一来自 ListTools，绑定 adapter/coordinateMode，按 target_app 和 grant flag 精确授权，保留 content/isError；另接 W3-03～10 的原生 executor，不把 Zavora 当 Swift。 | 现有 `openBackends.test.ts:23-49` 仅目录+deny；补成功/拒绝、跨 app、flag、坐标、isError、desktop live；**V-offline**。 |
| W3-12 | `computer-use-sentinel-apps.ts:3-14` 是 4 个 bundle ID 的真实静态分类；`computer-use-types.ts` 是类型/默认 grant；`unavailable.ts:1-4` 只是上述抛错文案工厂。入口 `ComputerUseApproval.tsx:254`。 | 保留公开类型和默认 deny flags；把 sentinel catalog 做成有测试的公开数据，权限不能因未知名称自动放行；所有 NI 项完成后删除不再使用的 unavailable 工厂。 | 已知/未知/大小写 bundle ID、危险类别和默认 flags；**V-offline，支持实现回归通过**。 |

Computer Use 的共同 gate：`CHICAGO_MCP` 已在 `scripts/build.ts:64` 开放，但 `utils/computerUse/gates.ts:36-58` 仍要求 external Max/Pro 与动态配置 enabled；native loader 还有 darwin/TCC 边界。现有 `scripts/live-desktop-validation.ts:6-16` 只在显式 `CLAUDE_DESKTOP_LIVE=1` 下做一次 Zavora screenshot，不覆盖输入、隐藏应用或私有 Swift。

## 5. Wave 4：Direct Connect 与后台会话

Direct Connect 的共同入口为 `src/main.tsx:5538-5639`（`DIRECT_CONNECT` server）及 `:5700-5744`（headless connect）；该 feature 当前不在 `scripts/build.ts:39-66` 的 external profile。目标线协议见 `contracts/direct-connect-v1.md`。后台命令共同 gate/入口为 `src/entrypoints/cli.tsx:183-216` 的 `BG_SESSIONS`，目标见 `contracts/background-sessions.md`。

| ID | 当前行为、位置、入口与 gate | 可复用实现 → 目标公开实现 | 测试 / 当前状态 |
|---|---|---|---|
| W4-01 | `src/server/backends/dangerousBackend.ts:1-5` 构造函数抛错；`main.tsx:5604` 实例化。 | 复用 `bridge/sessionRunner.ts`、structured IO、权限 broker → 先实现默认常规 ProcessBackend，再实现同名危险后端；均以 argv 启动 stream-json 子进程并限制 workspace/env，bypass 只有 client 与 server 双重显式授权才追加，默认走权限请求。 | fake/real child、单/双 dangerous opt-in、权限、僵尸进程、路径/env 注入；**V-offline**。 |
| W4-02 | `src/server/sessionManager.ts:8-18` 构造和 `destroyAll` 均抛错；`main.tsx:5605,5631`。 | 复用 `server/types.ts` 的 SessionInfo/Index、daemon 生命周期 → 实现 create/get/resume/remove、maxSessions、idle timeout、持久 index、崩溃回收和幂等 destroyAll。 | 并发上限、idle、resume、stale child、重复 destroy、重启恢复；**V-offline**。 |
| W4-03 | `src/server/server.ts:10-16` 的 `startServer` 抛错；`main.tsx:5611`。 | 复用 `createDirectConnectSession.ts` 的 `/sessions` 客户端、`directConnectManager.ts` 的 NDJSON/WebSocket 客户端和 Zod schemas → 实现 HTTP POST sessions、鉴权 WS upgrade、双向消息/control/keepalive、body 限制和 stop。 | loopback HTTP/WS、401/非法 body、断线、权限配对、backpressure、stop；**V-offline**。 |
| W4-04 | `src/server/serverBanner.ts:3-9` 抛错；`main.tsx:5613`。 | 复用 server config/bridge UI 的安全输出 → 打印真实 host/port/连接说明；token 只在明确交互场景展示，不写普通日志/CI，支持 unix socket。 | TCP/UDS、port=0、无 token 泄漏、非 TTY；**V-offline**。 |
| W4-05 | `src/server/lockfile.ts:9-18` probe 永远 null，write/remove 抛错；`main.tsx:5582,5615,5632`。 | 复用 `utils/lockfile.ts`、daemon record 的 0700/0600 模式 → 原子写 server lock、校验 schema/PID/端口、清 stale、所有权检查后删除。 | 并发启动、stale PID、坏 JSON、非 owner、重复清理；**V-offline**。 |
| W4-06 | `src/server/connectHeadless.ts:3-10` 抛错；`main.tsx:5731-5742`。 | 复用 `DirectConnectSessionManager`、CLI structured output 和权限 UI → 完成 connect/prompt/stream-json/text、交互输入、control response、SIGINT interrupt 和退出码映射。 | text/json、多个 result、权限、interrupt、服务器错误和 dist；**V-offline**。 |
| W4-07 | `src/cli/bg.ts:5-7` 的 `psHandler` 抛错；`entrypoints/cli.tsx:200-202`。 | 复用 `utils/concurrentSessions.ts` 的 `~/.claude/sessions/<pid>.json`、tmux/UDS 身份核验与 sessionStorage → 原子维护 registry，按 kind/state 列出真实 live 会话，身份不明只显示 unknown，不错误清理。 | 空/多条/stale/坏记录、PID 复用、并发 registry、`--json`；**V-offline**。 |
| W4-08 | `src/cli/bg.ts:9-11` 的 `logsHandler` 抛错；`cli.tsx:203-205`。 | 复用 registry/log 文件 → 按 session ID 读取/follow 日志，处理轮转、EOF、非法 ID 和 SIGINT，不执行日志内容。 | 大日志、follow、退出、路径穿越；**V-offline**。 |
| W4-09 | `src/cli/bg.ts:13-17` 的 `attachHandler` 抛错；`cli.tsx:206-208`。 | 复用 `tmuxSocket` 的隔离 socket 与 concurrentSessions 身份核验 → 只对 kind=bg 执行真实 `tmux -L <socket> attach-session -t <session>`，继承 TTY，detach 只减客户端计数、不杀后台进程。 | 非 TTY、身份冲突、真实 attach/detach、退出码、不得改用 UDS 文本队列；**V-offline**。 |
| W4-10 | `src/cli/bg.ts:19-21` 的 `killHandler` 抛错；`cli.tsx:209-211`。 | 复用 daemon stop/PID liveness → 先 SIGTERM、超时 SIGKILL，校验 registry ownership，清 socket/registry，重复 kill 幂等。 | 已退出/拒绝信号/超时/重复 kill、不得杀错 PID；**V-offline**。 |
| W4-11 | `src/cli/bg.ts:23-25` 的 `handleBgFlag` 抛错；`cli.tsx:212-214`。 | 复用当前 CLI argv、`tmuxSocket`、concurrentSessions/UDS → 精确去除 flag 后以独立持久 tmux socket 启动，pipe-pane 写 0600 日志并登记启动令牌；注册/身份核验成功才返回 session，否则逆序清理。 | prompt 中 `--bg` 不误删、幂等冲突、启动失败回滚、真实 tmux 生命周期和 dist；**V-offline**。 |

## 6. Wave 5：SSH、Template Jobs 与两个 runner

| ID | 当前行为、位置、入口与 gate | 可复用实现 → 目标公开实现 | 测试 / 当前状态 |
|---|---|---|---|
| W5-01 | `src/ssh/createSSHSession.ts:37-42` 固定 `SSHSessionError`；`main.tsx:4365-4384` 的 `claude ssh <host>`，gate 为 `SSH_REMOTE`。 | 复用系统 OpenSSH、`RemoteMessageContent`、progress UI → 以 argv 启动受控 ssh，保留 host-key 校验、BatchMode/超时、远端 cwd 和 CLI 参数，返回真实 proc/proxy/stderr tail/manager。 | fake ssh argv、坏主机/密钥、cwd 注入、远端版本错误；授权 Linux VM live；**V-offline**。 |
| W5-02 | `createSSHSession.ts:44-48` 的本地 proxy session 也抛错；`main.tsx:4371`。 | 复用 loopback 子进程和 Direct Connect structured IO → 建立本地 stream-json 代理及可停止 proxy，供同一 SSH manager/UI 复用，不伪称网络 SSH。 | 启动/停止、stderr、异常退出、权限模式；**V-offline**。 |
| W5-03 | `src/ssh/SSHSessionManager.ts:18-26` 的 connect/disconnect 都返回 false；由 `createManager` 和 `useSSHSession.ts` 消费。 | 复用 `DirectConnectSessionManager.ts:40-180` 的事件模型 → 管理子进程 stdin/stdout NDJSON、connected/reconnecting/disconnected 回调、有界重连和幂等关闭。 | 连接失败、重连、重复断开、坏帧、回调顺序；**V-offline**。 |
| W5-04 | `SSHSessionManager.ts:28-30` 的 sendMessage 固定 false。 | 复用 SDK user stream-json 格式 → 校验连接状态、写完整 NDJSON frame、处理 backpressure/error，成功仅代表写入 transport。 | 字符串/blocks、部分写、断连、消息边界；**V-offline**。 |
| W5-05 | `SSHSessionManager.ts:32-37` 的权限响应固定 false。 | 复用 `SDKControlPermissionRequest` 与 `RemotePermissionResponse` → 按 request_id 配对 control_response，拒绝未知/重复 ID，保留 updatedInput/规则。 | allow/deny、重复/未知 ID、超时和断连；**V-offline**。 |
| W5-06 | `SSHSessionManager.ts:39-41` 的 interrupt 固定 false。 | 复用 SDK interrupt control 与子进程信号 → 优先协议 interrupt，必要时受控转发 SIGINT，不能误杀本机进程组。 | 正常/超时/重复 interrupt、远端进程组清理；**V-offline**。 |
| W5-07 | `src/cli/handlers/templateJobs.ts:1-3` 固定抛错；`entrypoints/cli.tsx:218-230` 的 new/list/reply，gate 为 `TEMPLATES`；分类出口是 W2-06。 | 复用 cron/session storage、workflow、W2-06 → 实现本地版本化 job create/list/reply、job dir/state/日志、dispatch 与恢复；new/list/reply 参数和退出码一致。 | 临时 HOME 全生命周期、并发 reply、坏 state、重启恢复、dist；**V-offline**。 |
| W5-08 | `src/environment-runner/main.ts:1-3` 固定抛错；`cli.tsx:232-240`，gate 为 `BYOC_ENVIRONMENT_RUNNER`。 | 复用 CCR transport、`bridge/sessionRunner`、file persistence → 实现公开 Open Runner v1 的 register/poll/heartbeat、BYOC work 执行、事件/权限、取消和清理；base URL/token 均显式配置。 | reference server、过期 lease、401/重连、取消、文件清理；授权 BYOC live；**V-offline**。 |
| W5-09 | `src/self-hosted-runner/main.ts:1-3` 固定抛错；`cli.tsx:243-252`，gate 为 `SELF_HOSTED_RUNNER`。 | 复用 daemon supervisor、workerRegistry、CCR worker transport → 实现公开 self-hosted register/poll-as-heartbeat、job claim、stdout/result、优雅 shutdown 和版本能力协商，不猜私有 WorkerService 路径。 | 重复注册、poll/heartbeat、claim 冲突、restart、SIGTERM；授权 self-hosted live；**V-offline**。 |

## 7. Wave 6：公开 slash、ant handler 与剩余占位

### 7.1 18 个 slash stub（逐项）

共同现状与 gate：下列 `src/commands/*/index.js` 都在第 1 行导出 `{isEnabled:()=>false,isHidden:true,name:'stub'}`（reset-limits 为 `:1-4`，另有两个 named export）；`src/commands.ts:224-252` 收入 `INTERNAL_ONLY_COMMANDS`，`:343-345` 又要求 `USER_TYPE=ant && !IS_DEMO`，因此 external 完全不可达。每项都需替换为真实 `Command`、加入公开 `COMMANDS`、移除 `[ANT-ONLY]` 语义，并完成“单测 + 真实调用 + dist help/执行 + 副作用检查”；当前均无专项测试，状态均为 **V-offline**。

| ID | 命令与证据 | 可复用实现 → 目标公开实现 | 目标测试重点 |
|---|---|---|---|
| W6-01 | `/ant-trace` → `commands/ant-trace/index.js:1` | `utils/telemetry/sessionTracing.ts`、perfetto → 导出并查看本地 trace，敏感字段脱敏。 | 无 trace/有效 trace、文件权限、dist。 |
| W6-02 | `/autofix-pr` → `commands/autofix-pr/index.js:1` | `commands/review.ts`、`pr_comments`、gh/git、QueryEngine → 读取 PR 评论，生成修复计划，经确认修改并测试。 | 无 PR/评论、权限、未确认不写、dist。 |
| W6-03 | `/backfill-sessions` → `commands/backfill-sessions/index.js:1` | 从 `commands/insights.ts` 提取 `SessionMeta/logToSessionMeta`，复用 session reader 与 `statsCache` 原子锁写 → 默认只补缺失 insights metadata，`--dry-run` 零写、`--force` 重建；不上传、不调模型。 | 缺失/有效/坏/重复 session、dry-run/force、并发锁、零网络。 |
| W6-04 | `/break-cache` → `commands/break-cache/index.js:1` | 复用 `commands/clear/caches.ts` 的唯一 `clearSessionCaches()` 聚合 → 清进程内命令/技能/文件建议/repo 等派生缓存，等待动态清理完成；不清对话/磁盘、不声称服务端 prompt cache 失效。 | 各清理被 await、transcript/tasks 不变、重复调用、失败诊断。 |
| W6-05 | `/bughunter` → `commands/bughunter/index.js:1` | 直接复用 `review/ultrareviewCommand.tsx`、`reviewRemote.ts` 和 RemoteAgentTask → 按 focus 启动一次远程 bug review，沿用 quota/Extra Usage/teleport 和确认，不伪造本地审查。 | focus、未启用、低余额、超额取消、task 注册。 |
| W6-06 | `/ctx_viz` → `commands/ctx_viz/index.js:1` | `utils/analyzeContext.ts`、CtxInspect/context-collapse → 输出本地文本/HTML 上下文组成图，内容默认脱敏。 | 空/大上下文、HTML escaping、文件权限。 |
| W6-07 | `/debug-tool-call` → `commands/debug-tool-call/index.js:1` | 消息 tool_use/tool_result 配对、Tool/MCP schema registry 和选择 UI → 只读查看参数/结果/错误/时间，`--validate` 仅校验保存的输入；不提供 replay，不调用工具或权限路径。 | 缺失/重复 ID、schema invalid、spy 断言零执行。 |
| W6-08 | `/env` → `commands/env/index.js:1` | `envUtils`、doctor/config → 显示公开运行环境和配置来源，仅输出 allowlist 字段，秘密永远 redacted。 | token/key 不出现、来源、JSON 输出。 |
| W6-09 | `/good-claude` → `commands/good-claude/index.js:1` | `components/Feedback.tsx` → 收集正向反馈到公开可配置 sink/本地导出，发送前确认，不发私有 endpoint。 | 取消、空输入、网络失败、隐私。 |
| W6-10 | `/issue` → `commands/issue/index.js:1` | 复用 `commands/feedback/feedback.tsx` 与 `components/Feedback.tsx` 的 consent/GitHub issue 流程 → report 只作初始描述，沿用脱敏和确认，不另造 `gh issue create` 或上传到当前仓库。 | 初始描述、取消零网络、consent、URL 上限、目标仓库固定。 |
| W6-11 | `/mock-limits` → `commands/mock-limits/index.js:1` | API error classes、policyLimits → 仅测试/开发环境模拟限流响应，退出后复原，不改变真实配额。 | 生产拒绝、各类 limit、状态复原。 |
| W6-12 | `/oauth-refresh` → `commands/oauth-refresh/index.js:1` | `services/oauth/client.ts` 的 `refreshOAuthToken` 与 auth 的安全保存/缓存清理 → 无参数强制刷新，成功才原子保存；`--status` 只读 expiry/scopes 且零网络，失败保留旧 token。 | rotation、4xx/网络失败保留旧值、status 零网络、无 token 输出。 |
| W6-13 | `/onboarding` → `commands/onboarding/index.js:1` | setup screens、login/theme/permissions → 可重入公开 onboarding，尊重既有设置和非交互模式。 | 首次/重跑/取消/非 TTY。 |
| W6-14 | `/perf-issue` → `commands/perf-issue/index.js:1` | startupProfiler、headlessProfiler、slowOperations、trace → 汇总性能报告和脱敏 issue 草稿。 | 缺失样本、报告生成、无路径/secret 泄漏。 |
| W6-15 | `/share` → `commands/share/index.js:1` | 复用 export 命令/ExportDialog/exportRenderer → `/share [output.html]` 预览后只写用户选择的静态 HTML，提供工具输出选择，`wx` 拒绝覆盖；不上传、不生成 ccshare ID、默认不打开浏览器。 | HTML escaping、空对话、工具输出选择、拒绝覆盖、零网络。 |
| W6-16 | `/summary` → `commands/summary/index.js:1` | compact/sessionMemory → 生成当前 transcript 摘要，不改历史，支持 copy/export。 | 空/长会话、compact boundary、模型失败。 |
| W6-17 | `/teleport` → `commands/teleport/index.js:1` | 复用 `teleport/api.ts` 的 session 列表/下载与 `utils/teleport.tsx:539,747` 等真实恢复/UI → 无参数选择 web session，有 ID 直接恢复到本地；repo 不匹配、stash 和未提交修改必须确认，失败不清工作区。 | 列表/直 ID、未登录、repo 冲突、stash 取消、工作区不变。 |
| W6-18 | `/reset-limits` → `commands/reset-limits/index.js:1-4` | 复用 `mockRateLimits`、`claudeAiLimits.checkQuotaStatus` → `status` 只读、`mocks` 只清模拟 headers、`refresh` 重新获取状态；两个 export 共用 core，绝不重置服务端额度或删除本地使用统计。 | 各子命令、mock 清理、refresh 失败、stats 不变、无假成功。 |

### 7.2 9 个 ant 维护 handler

共同 gate：`src/main.tsx:6228-6386` 以 `USER_TYPE=ant` 注册；external 需改为公开注册。下列目标均复用本地真实数据，不恢复私有日志服务。5 个 task handler 统一直接复用 `src/utils/tasks.ts` 的 create/get/list/update/getTasksDir、文件锁与 high-watermark，而不是另建任务存储。每项状态 **V-offline**，需临时 HOME 单测、错误路径和 dist 命令测试。

| ID | 当前行为与入口 | 可复用实现 → 目标公开实现 | 目标测试重点 |
|---|---|---|---|
| W6-19 | `cli/handlers/ant.ts:7-11` 的 `logHandler` 抛错；`main.tsx:6235-6247` | `sessionStorage`、`listSessionsImpl` → 按 index/UUID 查看本地 conversation log，非法 index 明确失败。 | index/UUID、空日志、坏文件、脱敏。 |
| W6-20 | `ant.ts:13-17` 的 `errorHandler` 抛错；`main.tsx:6249-6263` | `utils/log.ts`、`errorLogSink` → 查看 0/-1/-2 错误日志，安全分页。 | 相对序号、无日志、大文件。 |
| W6-21 | `ant.ts:19-24` 的 `exportHandler` 抛错；`main.tsx:6265-6287` | `exportRenderer`、portable session reader → 从 UUID/index/JSON(L) 导出文本，`wx` 拒绝覆盖并清理部分文件。 | 三种 source、格式、拒绝覆盖、权限。 |
| W6-22 | `ant.ts:26-31` 的 `taskCreateHandler` 抛错；`main.tsx:6294-6307` | TaskCreateTool 与 `utils/tasks.ts` → 创建 subject/description/list，返回稳定 ID。 | 默认/指定 list、并发 ID、持久化。 |
| W6-23 | `ant.ts:33-39` 的 `taskListHandler` 抛错；`main.tsx:6309-6324` | TaskListTool 与 `utils/tasks.ts` → pending 过滤和稳定文本/完整 JSON 输出。 | 过滤、空列表、JSON schema。 |
| W6-24 | `ant.ts:41-46` 的 `taskGetHandler` 抛错；`main.tsx:6326-6333` | TaskGetTool 与 `utils/tasks.ts` → 按 ID/list 输出详情，未知 ID 非零退出且不创建文件。 | 正常/未知/跨 list。 |
| W6-25 | `ant.ts:48-60` 的 `taskUpdateHandler` 抛错；`main.tsx:6335-6362` | TaskUpdateTool、`utils/tasks.ts`、`TASK_STATUSES` → 原子更新状态/字段，owner 与 clearOwner 互斥并保留依赖。 | 每字段、非法状态、互斥、并发写。 |
| W6-26 | `ant.ts:62-66` 的 `taskDirHandler` 抛错；`main.tsx:6364-6371` | `utils/tasks.ts` 的 `getTasksDir` → 只输出解析后的目录，不主动创建，不额外泄露 env。 | 默认/自定义 list、临时 HOME、零副作用。 |
| W6-27 | `ant.ts:68-74` 的 `completionHandler` 抛错；`main.tsx:6374-6385` | Commander command tree → 生成 bash/zsh/fish completion，隐藏项保持隐藏并转义恶意 description；stdout/--output 用 `wx` 拒绝覆盖。 | 三种 shell、动态命令、注入、未知 shell、文件权限。 |

### 7.3 其余指定项与 7 个新发现同族项

| ID | 当前行为、位置、入口与 gate | 可复用实现 → 目标公开实现 | 测试 / 当前状态 |
|---|---|---|---|
| W6-28 | `tools/TungstenTool/TungstenTool.ts:9-15` 两个状态 helper 返回 false，`:17-40` isEnabled=false/call 抛错；`tools.ts:60-63,226` 与 clear caches 调用；gate 为 `USER_TYPE=ant`。 | 复用 `utils/tmuxSocket.ts`、Shell/LocalShellTask 和 AppState tungsten 字段 → 实现严格 `list/create/send/capture/kill` discriminated union，所有 tmux argv 强制隔离 socket，send 用 `send-keys -l`，kill 仅限本工具 registry，权限与缓存清理真实可达。 | fake/真实 tmux、隔离 socket、send argv、kill allowlist、权限拒绝零 spawn、dist；**V-offline**。 |
| W6-29 | `TungstenLiveMonitor.ts:4-10` 只显示 unavailable；`screens/REPL.tsx:543-546,6224`，gate 为 `USER_TYPE=ant`。 | 复用 terminal panel/ShellProgress → 显示活动 pane、最近命令/输出和自动隐藏状态，订阅可清理。 | 有/无 session、输出更新、unmount、清理；**V-offline**。 |
| W6-30 | `moreright/useMoreRight.tsx:10-25` 永远允许 before query、turn complete no-op、render null；`REPL.tsx:950-954,2240-2250,2886,3930-3932,3966-3969,6746`，gate 为 ant + `CLAUDE_MORERIGHT`。 | 复用真实 Message/Ink 类型与三个生命周期接口 → 新公开语义为本地轮次便签侧栏：普通输入透传，`@right ` 保存有界本地便签、清输入并返回 false 阻止 query；complete/abort 更新轮次状态，render 提供便签/清除 UI，不发模型请求。 | disabled 零副作用、普通输入、`@right` 不入模型、空便签、abort、上限/清除/unmount；**V-offline**。 |
| W6-31 | `utils/ccshareResume.ts:15-17` load 抛错（`:3-13` 私有 `https://go/ccshare` parser 可用）；`main.tsx:4885-4943` 仅 ant resume。 | 复用 `loadTranscriptFromFile`、`loadConversationForResume` → 从 go 或配置的 HTTPS origin 有界下载 JSONL，校验 content type/redirect/auth/大小/行数，0600 随机临时文件，转换真实 `LogOption` 并继续 fork resume；跨 origin 去 auth，失败清文件。 | URL/redirect、401、错误类型、超限/坏 JSONL、fork UUID、伪 hook 不执行；**V-offline**。 |
| W6-32 | **新发现**：`cli/up.ts:1-3` 抛错；`main.tsx:6176-6187` 仅 ant 注册。 | 复用 CLAUDE.md 查找、QueryEngine 和权限系统 → 执行最近 CLAUDE.md 的 `# claude up` 指令，先展示计划，所有命令走正常权限，非交互需显式确认。 | 无 section、嵌套目录、恶意指令不自动执行、取消、dist；**V-offline**。 |
| W6-33 | **新发现**：`cli/rollback.ts:1-6` 抛错；`main.tsx:6189-6211` 仅 ant，支持 target/list/dry-run/safe。 | 复用 `cli/update.ts`、nativeInstaller 和发布元数据 → 列公开版本、解析相对/精确目标、dry-run、校验签名/平台并原子切换；`--safe` 使用公开可验证 safe 元数据。 | list/target/不存在版本/dry-run/失败恢复/safe；**V-offline**。 |
| W6-34 | **新发现**：`tools/ExitPlanModeTool/prompt.ts:1-29` 自称 external stub，省略 allowedPrompts 指南；`ExitPlanModeV2Tool.ts:154-156` 消费，而 input schema `:81` 和权限 UI 已支持 allowedPrompts。 | 复用现有 schema、`ExitPlanModePermissionRequest.tsx:122-140,878-885` → 补全公开 prompt，说明 prompt rule 的用途、用户审核和最小授权，与 W2-05 的真实分类器一致。 | prompt 含指南、schema/UI 端到端、无不必要授权；**NI（部分提示缺失）**。 |
| W6-35 | **新发现**：`hooks/notifs/useAntOrgWarningNotification.ts:1-3` 空 hook；`REPL.tsx:218-224` external 还使用 inline no-op，`:1153` 调用。 | 复用通知队列、managed settings/org 验证 → 实现公开可配置的组织警告/不匹配提示，不内置私有 UUID；external 也调用真实 hook，关闭时无订阅。 | 匹配/不匹配、关闭、重复通知、卸载；**V-offline**。 |
| W6-36 | **新发现**：`utils/protectedNamespace.ts:1-5` 永远 false；`envUtils.ts:125-147` 仅 ant require，调用遍布 `main.tsx:6475`、bridge 和权限 telemetry。 | 复用 Kubernetes namespace/serviceaccount 读取与 managed env → 实现公开、保守的环境检测和可配置 allowlist；无信号为本地 false，模糊受保护信号 fail-safe，不携带私有 cluster 列表。 | 无信号/允许/受保护/模糊/IO 错误、各 telemetry 调用；**V-offline**。 |
| W6-37 | **新发现**：`utils/model/antModelOverrides.ts:20-32` 的 config/models/resolve 固定 undefined/[]；入口 `model.ts:183,403,490`、`modelOptions.ts:275`、`context.ts:93,158`、`effort.ts:284-291`。 | 复用公开 model catalog、settings 和 `antModels.ts` 中真实但 gate 的解析逻辑 → 提供公开模型覆盖配置/别名解析，不泄露私有 codename；未配置才返回空。 | 默认/自定义 catalog、别名、effort/context、公开名 sanitization；**V-offline**。 |
| W6-38 | **新发现**：`ink/devtools.ts:1-4` 的 `connectToDevTools` 是 no-op；`ink/reconciler.ts:30-55` 在 development 动态 import；依赖 `react-devtools-core` 已在 `package.json:99`。 | 复用该官方依赖和 Ink reconciler → 在开发模式实际调用 `connectToDevTools`，生产 DCE，连接失败给可操作诊断且不破坏 TTY。 | development 连接、缺依赖/拒绝连接、生产不加载；**V-offline**。 |

## 8. 已扫描但不计为 stub 的实现与排除证据

以下用于防止把正常实现或 fallback 误报为缺口，不计入 82 项：

- `src/hooks/useDirectConnect.ts`、`src/server/directConnectManager.ts`、`src/server/createDirectConnectSession.ts` 已有真实 WebSocket/HTTP 客户端；缺的是 W4 的服务端、进程和 headless 闭环。
- `src/utils/attribution.ts` 与 `src/utils/commitAttribution.ts` 有真实统计、文件跟踪和快照实现；缺的是 W2-02～04 的接线、hook 安装和 trailer，不重写核心算法。
- `src/utils/bash/ShellSnapshot.ts` 有真实 bash/zsh 快照生成与保存逻辑，不是本次“snapshot”占位；W2-01 是 Agent Memory Snapshot 对话框。
- `src/remote/remotePermissionBridge.ts:49-53` 的 `createToolStub` 是未知远端工具到 `FallbackPermissionRequest` 的正常适配，不是 external 功能占位。
- `src/utils/udsClient.ts`、`udsRegistry.ts`、`ListPeersTool` 是真实本机 peer 实现，`tests/udsMessaging.test.ts` 有 socket 证据；它们不能替代 W3-01 的远端 Sessions peer。
- `src/keybindings/loadUserBindings.ts`、`src/utils/slowOperations.ts`、`src/services/internalLogging.ts`、`src/utils/model/antModels.ts` 等均含真实实现，只是 `USER_TYPE`/feature gate 分支；按本次口径不重复列为 external stub。
- `src/utils/swarm/backends/ITermBackend.ts` 的 hide/show 是明确平台能力限制；`src/native-ts/yoga-layout/index.ts` 的未用 API parity 注释、普通 dedup/content stub 和测试 mock 均不属于本清单。
- `src/external-stubs/computer-use-types.ts` 只有公开类型与默认拒绝 flags；`unavailable.ts` 是错误工厂。二者没有独立产品行为缺口，随 W3 项完成而保留类型、删除不再需要的错误路径。

## 9. 执行与验收顺序

1. 按 Wave 1→6 实施；每一波同时完成实现、入口和测试，未通过时不提前打开 external feature。
2. 每波先跑专项，再跑 `bun run typecheck`、`bun run build` 和对应 dist 端到端；最终跑全量 `bun test`，并单独记录基线 cron/LSP 失败是否消除，不能用其他通过项掩盖。
3. 公开本地能力必须达到 **Verified (offline)**；依赖 OAuth/Sessions/Chrome 扩展/桌面/SSH/runner 的能力再按 protocol-gates 跑 **Verified (live)**。
4. Playwright 与 Zavora 只证明各自公开后端；私有 Chrome 扩展、Swift、go/ccshare、内部 runner/模板协议的兼容性必须有独立真实环境证据。
5. 每次完成都更新本表状态、verification 和 `docs/STATUS.md`。最终不得遗留任何 NI 项、固定 unavailable/false/空数组代替实现、忽略核心参数或只能由 ant 入口访问的同名能力。

## 10. 完成结果

全部 82 项现已标为 **V-offline**。最终标准测试入口完成 87 个独立测试文件，483 个测试和 2415 个断言，零失败、1 个桌面 live 用例跳过；typecheck、CLI/SDK/declarations 构建、Swift helper 编译、external profile 和 dist 命令检查通过。生产源码中不再存在本次范围内的 `name: 'stub'`、`unavailable in this build` 或固定 `isEnabled: () => false` 占位。

该结果是公开实现的 offline 状态，不是 live 或私有兼容声明。可信 webhook producer、双 session peer、Google Chrome 登录态、交互桌面、授权 Linux SSH、外部 runner 和私有协议差分验证仍未执行，详见 `../external-stubs/verification.md`。
