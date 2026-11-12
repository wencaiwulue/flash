# External Stub 协议、兼容与 Live 门禁

日期：2026-11-11。

## 1. 目的与最终决定

本文件规定 [`../status/external-stubs-audit.md`](../status/external-stubs-audit.md) 中 81 个待实现/部分实现项如何取得公开实现、私有兼容和 live 证据。各 `contracts/*.md` 是目标设计，不是当前服务端已支持新字段的声明。

用户要求全部实现，因此：

- 不得以“协议未知”为最终理由保留 throw、固定 false、空数组、no-op 或占位 UI；应先完成本目录定义的**开放、版本化、可测试实现**。
- 开放实现可以使用公开 CDP、MCP、OpenSSH、Sessions API、git/JSONL 或本仓库新定义的协议；它不等价于私有 Chrome 扩展、Swift/Enigo ABI、`go/ccshare`、内部 WorkerService 或内部模板协议。
- 私有兼容证据不足时，状态只能是“开放实现已达到某级验证，私有兼容未验证”。这不会阻碍开放实现落地，但也不允许把 Playwright/Zavora、mock、DCE 或构建成功写成私有功能恢复。
- 契约中有关 unavailable/unsupported 的文字只用于描述**未选择某后端、后端健康检查失败或私有环境未部署**时的运行时错误，不得成为 external 默认路径永久 stub 的借口。

## 2. 证据等级与状态提升

证据按下列顺序累积，不能跳级推断：

| 等级 | 必备证据 | 可以声明 | 不能声明 |
|---|---|---|---|
| E0 静态 | file:line、调用入口、gate、参数和错误路径已审阅 | 知道当前缺口与影响面 | 功能可用、协议正确 |
| E1 单元 | 真实实现的单元测试覆盖成功、非法输入、异常、取消和资源清理 | 本地逻辑通过指定用例 | 入口可达、真实服务兼容 |
| E2 本地集成 | 真实进程/socket/git/tmux/mock server 集成通过，且对应 dist 路径通过 | **Verified (offline)**，公开本地实现可用 | Cloud/OAuth/桌面/私有协议可用 |
| E3 公开 live | 本文指定的授权公开服务、浏览器、桌面、SSH 或 runner 环境通过 | **Verified (live)**，且仅限实际后端和环境 | 另一后端、另一服务或私有协议兼容 |
| E4 私有兼容 | 第 5 节要求的权威契约、差分和授权私有环境证据齐全 | 仅对测得的私有版本/环境声明兼容 | 对所有内部版本或 external 默认路径兼容 |

构建、typecheck、help 和 source import 只属于基础检查。`scripts/build.ts:17-18,34-66` 固定 `USER_TYPE=external` 并选择 feature profile；`tsconfig.json:20-28` 把 6 个 `@ant/*` import 映射到 `src/external-stubs/`。这些是编译边界，不是运行时 sandbox、功能验证或安全证明。

每个功能的 feature 只有在实现、E1/E2 和对应 dist 入口同时通过后才加入 external profile。运行时 GrowthBook、订阅、OAuth、OS/TCC、loopback 和用户确认仍分别有效，不能用编译 feature 绕过。

## 3. 开放实现与私有兼容分流

| 功能族 | 开放实现及验收对象 | 私有兼容必须另证的内容 |
|---|---|---|
| Remote inbound/webhook/renderer | `contracts/inbound-envelope.md`：严格 user envelope、可信 `source`、REPL/print 共用 prepare、结构化 origin。旧无 source 普通消息保持合法；服务端必须拒绝普通客户端自报 webhook source。 | Sessions 是否部署该字段、可信 producer 如何写入、事件类型/附件/replay 与内部格式是否一致。伪造 XML 标签绝不是证据。 |
| Peer sessions | `contracts/peer-messaging.md`：复用 `POST /v1/sessions/{compatId}/events` 和 OAuth/org helper；compat ID、可信 from、escape、无自动重试。两个授权 session 双向投递才是 live。 | 内部 peer endpoint、ID 映射、outer wrapper、已读/处理回执。UDS 成功、写自身 bridge transport 或 HTTP 2xx 都不能证明对端已读。 |
| Chrome | `contracts/open-chrome.md`：isolated WebBrowser 与 `chrome-cdp` 分离；CDP 只连 loopback、专用持久 profile，保留默认 context/tabs/cookies，disconnect 不关闭真实 Chrome。 | 私有 native messaging、扩展 socket、配对、bridge/lightning 工具。Playwright isolated 或公开 CDP 均不是这些能力的恢复。 |
| Computer Use | `contracts/computer-use-backends.md`：显式 Zavora 与 native-adapter，严格 schema、坐标/截图、权限交集、Abort/Escape、isError/structuredContent；总审计另要求公开原生 display/apps/input/TCC/hotkey 实现，不能固定 false。 | `@ant/computer-use-swift`、input 的 ABI、私有权限/坐标/应用隐藏细节。Zavora screenshot 或工具目录不能证明 Swift/Enigo 兼容。 |
| Bash prompt rules/job classifier | 公开规则文本、forced-tool 结构化模型响应、本地严格 schema；job state 使用版本化本地 JSON。模型是分类器，不是 sandbox。 | 内部分类 prompt、模型、字段、状态消费方式；离线 mock 不能证明内部分类结果一致。 |
| MCP Monitor | 升级到带公开 Tasks schema 的 MCP SDK；初始化协商 capability，使用 `tasks/get/list/cancel` 和 remoteTaskId。普通 `tools/call` abort 只停止本地等待。 | 内部 monitor 创建/通知/取消扩展。本地 tree-kill、发出 cancel 请求或本地 status=killed 都不是远端取消证据。 |
| Snapshot/attribution | 本地 agent memory、git worktree/hooks、JSONL 快照和公开 git trailers；原子写、保留用户 hook、缓存清理。 | 内部 hook 内容、trailer 字段、私有 repo allowlist 和统计口径。现有核心算法可复用，但接线仍需独立验证。 |
| Direct Connect | `contracts/direct-connect-v1.md`：本仓库版本化 HTTP `/sessions`、鉴权 WebSocket、NDJSON SDK/control 消息、lock/index 和 headless 客户端。loopback reference server + dist client/server 互测。 | 历史内部 direct server 的 URL、auth、WS 子协议、session resume/权限消息。已有客户端类型和 `connectResponseSchema` 只是线索，不是完整兼容证明。 |
| Background sessions | `contracts/background-sessions.md`：版本化本地 registry、PID/log/socket、ps/logs/attach/kill 和 `--bg`。临时 HOME + 真实子进程验证。 | 内部 registry 路径、attach 协议、进程托管语义；daemon 测试通过不等于 bg registry 兼容。 |
| SSH | `contracts/ssh-v1.md`：系统 OpenSSH + 版本化 NDJSON SDK/control 帧、host-key 校验、权限响应和 interrupt。授权 Linux VM 验证。 | 内部 proxy 参数、远端安装/版本协商、重连和 signal 细节。Direct Connect 帧可复用，但不能据此声称私有 SSH 兼容。 |
| Template Jobs | `contracts/local-template-jobs-v1.md`：本地版本化 job dir/state、new/list/reply、分类和恢复。 | 内部模板分发、fleet UI、服务端 reply 和 state schema；本地 `claude list` 通过不是内部模板服务证据。 |
| 两个 runner | `contracts/open-runner-v1.md`：公开 reference server、register/poll/heartbeat、lease/claim、事件/取消和优雅退出。BYOC 与 self-hosted 分别验收。 | BYOC/SelfHostedRunnerWorkerService 的实际路径、JWT/角色、poll 即 heartbeat、worker epoch 和事件语义；不得照注释猜 endpoint。 |
| ccshareResume/teleport | ccshare 使用配置 HTTPS origin 的有界 JSONL 下载、严格 content type/schema/auth 和 fork resume；teleport 复用现有 Sessions 下载/恢复。`/share` 按 public-commands 契约只生成用户选择的本地 HTML，不上传。 | `https://go/ccshare` 的实际下载格式、权限、撤销和内部字段；`parseCcshareId` 成功不代表 load 可用。 |
| Slash/ant/Tungsten/MoreRight/up/rollback/其余项 | 优先本地命令、公开模型/git/GitHub CLI/tmux/发布元数据和版本化配置；私有网络功能未证前使用明确公开后端。 | 私有日志/反馈/issue/trace/limit/onboarding/发布服务与 MoreRight 的具体产品语义。不能仅删除 ant gate 就称功能恢复。 |

## 4. 新公开协议的最低契约要求

任何本仓库新定义的 v1 协议，实现前必须在对应 contract 中冻结：

1. `schema_version`、能力协商和未知版本处理；不允许服务端/客户端静默降级成另一功能。
2. 严格 request/response schema、字段是否允许未知值、大小/深度/超时限制、错误码和取消语义。
3. ID 类型与生命周期：本地 task ID、remote task ID、`cse_*` worker ID、`session_*` compat ID、transcript UUID 不得混用。
4. 认证、授权和组织边界；token 不进 URL 普通日志、transcript、测试快照或分析事件。
5. 重试与去重：可能已接受的写入不得盲目自动重试；UUID/cursor/lease/generation 必须防止旧响应覆盖新状态。
6. 本地与远端状态分离：`sent`、`accepted`、`processed`、`cancelRequested`、`cancelled` 不是同义词。
7. reference server/client 与 dist 互测；只用实现自身的 mock 容易复制同一误解，至少增加独立 schema fixture 或第二实现。
8. 版本化迁移、原子持久化、崩溃恢复和资源清理；测试必须覆盖 malformed/truncated/oversized input。

## 5. 私有兼容证据包

只有开放实现成功仍不够声明私有兼容。每个需要私有兼容声明的项目必须保存不含秘密的证据包：

1. **权威契约**：对应版本的正式 schema/文档，或在明确授权环境中取得的脱敏协议 trace；注明版本、日期、环境和来源，不从类型名或注释反推线协议。
2. **完整矩阵**：endpoint、方法、auth 类型、必需 header、请求/响应、分页、错误、超时、重试、取消、capability negotiation 和 ID 映射。
3. **独立差分**：同一 fixture 分别经公开实现和私有参考实现运行，比较状态、消息、副作用和错误；mock 必须来自权威契约而非仅复制新实现假设。
4. **真实环境**：在获授权的私有构建/服务中运行，`USER_TYPE=ant` 或私有包环境需单独构建，不能以 external bundle 代替。记录后端版本和实际路径，不记录 token、正文或私有数据。
5. **负面用例**：撤销权限、错误版本、非法响应、断连、重放、超时和服务端部分失败均保持安全，不因兼容而 fail open。
6. **范围限制**：结论只覆盖实测版本和字段。一个 endpoint、一个 renderer、一个 Zavora/Playwright 后端或一次 OAuth 成功不能外推整个私有功能族。

缺少证据包时继续完成开放实现和公开 live；状态写“私有兼容未验证”，而不是阻塞全部工程或宣称恢复完成。

## 6. Live 环境与执行矩阵

所有 live 默认不运行，必须满足对应前置条件并显式选择。使用 isolated `HOME`/临时 cwd、专用测试资源和独立测试账号；不打印、复制或提交凭据。清理只针对本测试创建且有 ownership 标记的资源。

| 环境 | 前置条件与实际执行 | 通过标准与限制 |
|---|---|---|
| 模型：Bash/job 分类、summary、MoreRight、up 等 | 由调用方注入 `ANTHROPIC_AUTH_TOKEN`、base URL、model、timeout；token 是 Bearer，不映射成 `CLAUDE_CODE_OAUTH_TOKEN` 或 `x-api-key`。复用现有 model live 配置。 | 真实 forced-tool/分类/摘要结果及错误矩阵通过。已有 Workflow/context live 结果不能代替新功能。`scripts/live-model-validation.ts:40-48` 在 `enableConfigs()` 前检查 env，因此 standalone 调用方必须先注入 settings，不能假定脚本自行加载。 |
| Cloud/Remote Control/peer/share | 真正的 Claude OAuth、正确 org/scope、授权的 base URL；peer 至少两个同组织 session。模型 Bearer 不可复用为 Cloud OAuth。 | `scripts/live-cloud-validation.ts:13-62` 目前只覆盖 bridge 创建/同 ID resume、Files 和 archive，不能代替 peer、webhook、Direct Connect 或 ccshare。新增用例验证唯一 nonce 双向到达、撤销/404/timeout、无重复处理，只 archive 测试 session。 |
| 真实 Chrome | macOS/Linux 已安装 Google Chrome；专用持久测试 profile；`127.0.0.1` CDP；测试站点账号。不得使用日常默认 profile 或开放局域网端口。 | 两个预开 tabs 和登录态在 attach 后存在；操作当前 tab；disconnect/dist 退出不关闭 tabs/cookies；非 loopback 和错误 endpoint 无 isolated 假成功。结论仅为 `Open CDP / real Chrome verified`。 |
| Computer Use 桌面 | 授权的交互桌面/VM，非生产用户会话；辅助功能/屏幕录制权限、专用测试应用、多屏用例；显式 `CLAUDE_DESKTOP_LIVE=1`。 | `scripts/live-desktop-validation.ts:6-16` 当前只做 Zavora screenshot，不足以验收输入/授权/取消。必须对 click/type/key/scroll 做 readback，验证跨 app/clipboard/system key deny、Abort、unhide 和锁清理；公开 native helper 与 Zavora 分开记录。 |
| Direct Connect/bg/Tungsten | 无需私有云；使用 loopback、临时 HOME、真实 CLI child、WS/NDJSON reference peer 和独立 tmux socket。 | dist server/client 互连、权限/中断/resume、PID/lock 清理、后台日志/attach/kill、Tungsten pane IO。只 bind loopback；对外 host 需另做威胁评估，默认禁止。 |
| SSH | 专用 Linux VM/container 和测试账号；严格 known_hosts/host-key，非生产目录，测试结束后删除测试密钥和远端临时目录。 | 远端实际 turn、权限响应、interrupt、断线重连、host-key 失败零命令执行；本地 fake child 不能替代此环境。 |
| Template Jobs/runners | 本地临时 job dir；runner 使用独立公开 reference server/授权测试 worker、测试 lease/job 和最小权限 token。 | create/list/reply/restart 与状态恢复；runner 的注册、poll/heartbeat、claim、取消、401/过期 lease、SIGTERM。不得清理其他 worker/job，不猜私有 WorkerService。 |
| 私有兼容 | 与公开 live 隔离的授权私有包、ant build、内部服务或参考实现；禁止把私有凭据写入仓库/CI 普通日志。 | 仅用于第 5 节差分与兼容结论，不回填 external 的公开 live 状态，也不要求公开仓库保存私有 trace 正文。 |

环境不可用时写 `skipped` 及原因，保持 **Implemented, unverified** 或已达成的较低等级；不能写 `passed`。公开实现代码、E1/E2 与入口仍须继续完成，不能把缺少 live 当作保留 stub 的最终方案。

## 7. 安全边界（每项均为阻断门禁）

### 7.1 入站内容与模型输出

- transport 元数据才能证明 webhook 来源；正文标签、模型文本和文件名都不能提升信任。普通远程消息不得被 webhook sanitizer 误阻断。
- webhook、peer、页面、MCP 和模型输出始终是不可信数据。严格 schema、限制大小/深度，文本使用安全 wrapper/escape；不使用 HTML 注入或从子串提取可信字段。
- 分类器、生成器和合并 prompt 不能自行授予权限。模型非法输出、超时、abort、低置信度均不能自动 allow；权限服务故障进入人工 ask，非交互无法提示时拒绝执行。

### 7.2 进程、文件与远端动作

- 子进程使用 argv，不经 shell 拼接；cwd/env allowlist、路径归属、PID ownership、文件 0700/0600、原子写和 stale cleanup 必须测试。
- SSH 不关闭 host-key 校验；Direct Connect/CDP 默认 loopback；runner token 最小权限；`dangerouslySkipPermissions` 仅显式授权且默认关闭。
- kill/cancel/rollback/share 是不同级别副作用：本地 kill 不等于远端 cancel，发出请求不等于确认完成，dry-run 不得写文件，分享前必须预览范围。
- 所有异步操作使用真实 AbortSignal、generation/lease 和幂等清理；迟到响应不能覆盖新状态，finally 释放进程、按键、hotkey、锁、socket、tmux 和临时文件。

### 7.3 浏览器与桌面高权限能力

- CDP 可读取登录态，Computer Use 可控制真实输入；两者均不得自动处理支付、OAuth、系统对话框或绕过站点/OS 权限。
- Zavora 与 native 的 app grant、clipboard、system combo 和 OS allow/block 取交集；一个 app 的 grant 不能用于另一个 target，观察类操作也不能默认无限制读取。
- isolated、Chrome CDP、Zavora、native 各有独立 client/cache/cleanup，禁止 cross-close、隐式 backend fallback 或共享不相容的 Escape 语义。

### 7.4 日志、隐私与供应链

- 普通日志只记录错误类别、状态码、延迟、长度/hash；不记录 token、Cookie、OAuth header、完整 prompt/command、剪贴板、截图 base64、页面正文或私有 trace。
- 新协议和 native helper 固定依赖版本并审查安装脚本；不从不可信地址下载可执行文件，rollback/update 校验发布元数据和平台产物。
- 测试 secret 使用独立 CI secret/本地调用方注入；repo 中不得新增 token、私有 trace、cookies、profile 或测试桌面截图。

## 8. 每波实施与最终门禁

每个审计项按同一顺序闭环：

1. 更新/确认公开 contract、威胁模型和复用边界。
2. 实现真实生产代码并接入 CLI/REPL/MCP/UI；删除对应固定失败和参数忽略，不只增加旁路 helper。
3. 完成 E1、E2，包括负面、取消、并发、清理与 dist 测试；再启用相应 external feature/公开命令。
4. 需要真实环境时执行第 6 节对应 E3；需要私有兼容声明时另完成 E4。
5. 更新审计状态、`verification.md` 和 `docs/STATUS.md`，记录实际命令、后端、环境和限制。

最终至少执行并记录：

```sh
bun test
bun run typecheck
bun run build
bun dist/main.js --version
bun dist/main.js --help
bun run docs:generate -- --next
bun run docs:check -- --next
```

另跑所有新增 dist 端到端与已具备环境的 live 脚本。基线中 cron/LSP 失败必须单独复测和报告，不得被其他通过项掩盖。最终完成意味着总审计没有 NI 项，P 项已补足其公开目标，S 项有回归测试；不存在以保留 stub、隐藏命令、伪造成功或把公开 fallback 当作私有兼容来“完成”清单的情况。
