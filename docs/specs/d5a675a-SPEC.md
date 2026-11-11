---
commit: d5a675a4df66ff620d7577aaf167bb5749cc08a2
title: "Implement open KAIROS functionality"
date: 2026-11-10T23:23:22+08:00
status: implemented
kind: component
---

# Implement open KAIROS functionality

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交中的 KAIROS 多数外部入口只是禁用边界：assistant gate 固定返回 false，团队初始化直接抛错，session discovery 永远为空，session chooser 一挂载便取消。文件上传、通知和 PR 订阅没有开放工具实现，dream 也没有注册。构建虽保留若干条件注册点，但 KAIROS 与 KAIROS_GITHUB_WEBHOOKS 未进入外部特性档，因而这些 stub 不只是缺少 UI，而是缺少从本机团队上下文到远程会话、文件和事件适配器的完整组件。

需要在不伪造私有后端的前提下，把开放运行时的 assistant 模式接到既有 in-process team、OAuth session API、daemon supervisor、Brief 上传、OS 回调和消息通知队列。PR 功能还要避免第一次轮询把历史评论、review 和 check-run 全部当成新事件，并在后续轮询中按事件身份去重。实现必须区分本机状态初始化与真实远端可用性：隔离目录中的团队文件、mock 通知和 fake GitHub 响应可以离线验证，Cloud 文件上传、通知投递及 GitHub 往返则不能由这些测试推定成功。

## 目标与非目标

### 目标

- 实现 assistant 激活来源、forced latch、运行时开关和 in-process leader team 初始化，并保留既有信任与 OAuth 检查位置。
- 通过 OAuth sessions API 发现、规范化并排序远程会话，提供可选择的真实会话列表和 assistant 命令。
- 提供受权限约束的 daemon 安装向导，以私有目录和配置文件启动既有 assistant supervisor。
- 新增 SendUserFile 与 PushNotification，复用 Brief 上传、FileRead 权限、webhook 和 OS 通知适配器。
- 以 GitHub REST 轮询评论、review 和 check-run，建立首次基线、按类型前缀 ID 去重并接入通知队列。
- 注册 dream、assistant、subscribe-pr 及三个工具，在外部构建和独立特性档中验证真实注册结果。

### 非目标

- 不把 leader team 文件初始化解释为已经启动多个模型 teammate 或完成多代理协作。
- 不实现 launchd/systemd 服务安装；向导只写配置并调用现有 detached daemon supervisor。
- 不实现入站 GitHub webhook 服务端，PR 功能是由 gh api 驱动的三十秒轮询。
- 不让 dream 在后台自动改写记忆；该 skill 只生成用户显式调用时的 consolidation prompt。
- 不宣称 OAuth session discovery、真实上传、OS/webhook 投递或 GitHub 在线往返已在此提交验收。

## 方案架构与数据流

assistant/index.ts 将激活状态拆成进程内 forced、CLAUDE_CODE_ASSISTANT 和 settings.assistant 三种来源，并以 getAssistantActivationPath 保留可观察的来源。isKairosRuntimeEnabled 默认开放，只有 CLAUDE_KAIROS 被显式定义为假时关闭；gate.ts 仅委托这一运行时开关，不把开放 gate 当作 OAuth entitlement。既有 main 启动路径仍负责信任对话框、组织和凭据检查，因此项目设置不能在未受信目录中越过原有边界。

initializeAssistantTeam 用 session ID 前八位生成经过 sanitize 的 assistant 团队名，写包含 leadSessionId、主循环模型、cwd 和单个 leader member 的既有 team 文件，再注册 session cleanup、重置任务目录并设置 leader team。setCliTeammateModeOverride 固定为 in-process，返回的 leader layout 使用空 tmux 标识。这个上下文让现有 Agent/team 路径可以工作，但它本身只建立 leader 基础设施，不创建额外模型进程。

sessionDiscovery.ts 通过 prepareApiRequest 取得 OAuth token 与 orgUUID，以 ccr-byoc beta、组织头和十五秒超时请求 /v1/sessions 的一页五十条数据。解析器兼容 data 包装或顶层数组、三种 ID 字段和 snake/camel 活跃时间字段，丢弃无有效 ID 项并按最近活跃排序。AssistantSessionChooser 用 Dialog/Select 展示标题或 ID 及主机线索；/assistant 则分别提供 start、status、sessions，start 先 forced 激活再建立团队。

assistant.tsx 的 NewInstallWizard 将安装位置固定为 ~/.claude/assistant，用户选择后以 mode 0700 调用 mkdir、以 mode 0600 写入仅含版本和时间的 daemon.json，随后调用 startDaemon('assistant')；这些 mode 只约束新建对象，不会 chmod 已有目录或文件。成功回调仅表示配置写入、detached 子进程已 spawn 且 PID registry 已写入，不确认 supervisor 持续存活，也不代表 worker、bridge 或 Cloud session 已就绪；错误统一交回 onError，而不是显示虚假的安装成功。

SendUserFileTool 先把读取授权委托给 FileReadTool.checkPermissions，再要求活动 Remote Control bridge。路径相对 cwd 解析，lstat 只接受普通文件，实际上传复用 uploadBriefAttachment 的 OAuth、30 MiB 上限、超时、AbortSignal 和 file_uuid 校验。只有返回 fileId 才形成成功结果。该实现没有额外把路径限制在 cwd 内，cwd 外及绝对路径仍依赖 FileRead 的权限判定，而不是上传工具另设隐蔽放行。

PushNotificationTool 优先使用 CLAUDE_NOTIFICATION_WEBHOOK_URL，发送 text、可选 title/url，只有 2xx 算 webhook 成功；没有 webhook 时调用上下文 sendOSNotification，两个适配器都缺失则抛错。OS 回调是既有 fire-and-forget 边界，所以 deliveredVia=os 表示已经交给本机适配器，不等于确认用户看到系统通知。工具提示也要求失败不得描述为已发送。

PRSubscriptionManager 为每个 owner/repo#number 保存 timer、seen 和 initialized。每轮先取 PR head SHA，再并行读取 issue comments、reviews 和该 SHA 的 check-runs，分别形成 comment:、review:、check: 前缀 ID。首轮只填充基线，后续只把未见过的新 ID 送入既有 task-notification/later 队列并加入 seen；重复 poll 不再产生事件。timer unref，unsubscribe 清理计时器和状态，工具与 slash command 共享同一进程级 manager。

dream.ts 复用 auto-memory 路径、项目 transcript 目录和 buildConsolidationPrompt 生成可调用 prompt。build.ts 与独立特性夹具同时打开 KAIROS、KAIROS_GITHUB_WEBHOOKS，使既有条件注册点加载 assistant、subscribe-pr、dream 和三个新工具；enabledFeatures 在干净 Bun 子进程固定 41 个非空工具及 assistant command，避免源文件存在但构建仍裁掉实现。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/RELEASE.md`，符号 `## Open KAIROS functionality` | 记录开放 KAIROS 的组件范围、140/604 和在线未验证边界。 |
| 变更 | `docs/STATUS.md`，符号 `Open KAIROS adapters` | 记录 offline/build 状态、140/604 和 41-tool 特性档；但 STATUS 的 tested 表述超出新增测试范围，session discovery、安装向导和 webhook 没有专项测试。 |
| 变更 | `scripts/build.ts`，符号 `KAIROS_GITHUB_WEBHOOKS` | 在外部构建启用 KAIROS 与 GitHub 适配器条件注册。 |
| 变更 | `src/assistant/AssistantSessionChooser.tsx`，符号 `AssistantSessionChooser` | 把自动取消的占位组件替换为真实 Dialog/Select 会话选择界面。 |
| 变更 | `src/assistant/gate.ts`，符号 `isKairosRuntimeEnabled` | 将固定禁用 gate 委托给可显式关闭的开放运行时开关。 |
| 变更 | `src/assistant/index.ts`，符号 `initializeAssistantTeam` | 实现激活状态、团队提示、leader team 文件及 in-process mode 初始化。 |
| 变更 | `src/assistant/sessionDiscovery.ts`，符号 `discoverAssistantSessions` | 实现 OAuth sessions 请求、响应字段规范化、无效项过滤和活跃时间排序。 |
| 变更 | `src/commands/assistant/assistant.tsx`，符号 `NewInstallWizard` | 实现默认安装路径、私有配置写入、supervisor 启动和错误回调。 |
| 变更 | `src/commands/assistant/index.ts`，符号 `name: 'assistant'` | 提供 start/status/sessions 三个动作，将 forced 激活、团队建立和远程发现接入命令。 |
| 变更 | `src/commands/subscribe-pr.ts`，符号 `name: 'subscribe-pr'` | 提供共享 manager 的订阅、退订和列表命令，并声明非交互支持。 |
| 变更 | `src/services/prSubscriptions.ts`，符号 `PRSubscriptionManager` | 承载 gh api 轮询、首次基线、分类 ID 去重、通知和 timer 生命周期。 |
| 变更 | `src/skills/bundled/dream.ts`，符号 `registerDreamSkill` | 注册用户可调用的记忆整合 prompt，而非自动后台写入器。 |
| 变更 | `src/tools/PushNotificationTool/PushNotificationTool.ts`，符号 `PushNotificationTool` | 实现 webhook 优先、OS 回退和无适配器失败的通知工具。 |
| 变更 | `src/tools/SendUserFileTool/SendUserFileTool.ts`，符号 `SendUserFileTool` | 把 FileRead 权限、bridge 活动状态和普通文件检查接到 Brief 上传。 |
| 变更 | `src/tools/SubscribePRTool/SubscribePRTool.ts`，符号 `SubscribePRTool` | 提供严格工具输入、origin 仓库推导及与命令共享的 PR 订阅单例。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `hasAssistantCommand` | 验证 41 个非空工具、三个新增工具和 assistant 命令进入编译特性档。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `hasAssistantCommand` | 在独立构建中开启相同 KAIROS flags 并输出 assistant 注册信息。 |
| 变更 | `tests/kairos.test.ts`，符号 `describe('assistant mode'` | 以隔离目录、子进程和 fake adapters 固定团队、通知、上传前置和 PR 去重行为。 |
| 复用 | `src/tools/BriefTool/upload.ts`，符号 `uploadBriefAttachment` | 复用既有 OAuth multipart 上传、30 MiB 上限、超时、取消及 file_uuid 响应校验。 |
| 复用 | `src/daemon/main.ts`，符号 `startDaemon` | 复用 daemon PID/registry 与 detached supervisor，不在向导重写服务生命周期。 |
| 复用 | `src/utils/teleport/api.ts`，符号 `prepareApiRequest` | 复用 OAuth access token、orgUUID 和认证头准备逻辑。 |
| 复用 | `src/utils/swarm/teamHelpers.ts`，符号 `writeTeamFileAsync` | 复用团队文件路径、名称清理和 session cleanup 注册协议。 |
| 复用 | `src/utils/messageQueueManager.ts`，符号 `enqueuePendingNotification` | 复用既有任务通知队列及 later 优先级，不建立 PR 专用通知旁路。 |

## 关键决策与工程取舍

- 开放的是运行时与适配器，不新造一套 assistant 协议；team、daemon、OAuth、上传和通知均落在既有模块边界上。
- 团队初始化只创建 leader 上下文，把实际 teammate 创建留给现有 Agent 路径，避免安装阶段隐式产生模型工作量。
- 文件发送复用 FileRead 权限和 Brief 上传，而不是把 file_path 直接交给无授权的网络客户端；只有 file ID 能作为上传成功凭据。
- webhook 优先于 OS 适配器，使远程或 headless 环境有明确投递通道；无适配器时失败优于静默丢失。
- PR 首轮采用基线而非立即通知，防止订阅动作重放全部历史；以带类型前缀的服务端 ID 去重，而非比较易变摘要。
- 构建与特性夹具同步打开两个 flag，并以编译后的工具/命令数量验收，防止只修改源码却没有外部可见能力。

### 备选方案与回溯分析

- 回溯性比较：可以为 assistant 另写团队存储和进程编排，但会分裂既有 Agent、task 和 cleanup 语义；实际实现只生成既有 team 文件及 in-process mode snapshot。
- 回溯性比较：可以实现独立文件上传协议，但会重复 OAuth、大小限制、MIME 和错误处理；实际复用 Brief 上传并保留 FileRead 权限。
- 回溯性比较：可以把首次 PR 结果全部推送以快速展示状态，但会制造历史通知风暴；实际牺牲首轮即时信息，换取后续事件的新增语义。
- 回溯性比较：可以引入持久化 PR 事件数据库和 GitHub webhook 服务以获得跨重启及更新语义；实际选择内存轮询，范围更小，但重启重新基线且同 ID 内容变化不会再次通知。

## 安全与协议边界

- assistant runtime gate 不替代既有信任、OAuth 和组织检查；远程 discovery 必须提供 OAuth token 与 orgUUID。
- daemon 配置目录和文件仅在新建时分别使用 mode 0700/0600，已有路径不会被 chmod；写入内容不含令牌。startDaemon 只确认 spawn/PID registry，不确认 supervisor 持续存活或远端会话成功。
- SendUserFile 继承 FileRead 权限并拒绝非普通文件，上传具有 30 MiB 限制、AbortSignal 和严格响应 ID 校验。
- webhook 仅在 2xx 时报告成功，非 2xx、网络错误和无适配器均显式失败；通知正文不用于推断投递结果。
- PR ID 按事件类型命名空间隔离，首次基线抑制历史事件；GitHub 凭据由 gh CLI 管理，代码不保存 token。
- PR 去重只按 ID，不跟踪同 ID 的编辑或 check 状态迁移；评论/review 每类只取一百条且无分页，这些是有意的实现边界而非完整事件档案。

## 验收标准

- forced assistant 首次激活返回 true、重复调用返回 false，激活来源和系统提示能反映 in-process team 语义。
- 隔离配置目录中的初始化写出 assistant-* 团队文件，包含真实 leadSessionId 和单个 leader member，并设置 in-process 模式。
- session discovery 能规范不同响应外形并按活跃时间排序，chooser 与 /assistant sessions 使用同一 AssistantSession 数据。
- 安装向导只在用户确认后以新建 mode 0700/0600 写配置并调用 startDaemon，已有路径权限不保证被修正；异常通过 onError 暴露。
- 无 bridge 时 SendUserFile 在上传前失败；通知在 OS 适配器上传递正确标题和消息，无适配器时明确报错。
- PR 首次 poll 不通知，新增 ID 只通知一次，重复 poll 为空，unsubscribe 后列表移除且 timer 被清理。
- dream prompt 含 consolidation 指令和用户参数；外部特性档包含 41 个非空工具、三个新工具及 assistant command。
- 提交内文档记录 140 tests/604 assertions 和构建结果，同时保留 Cloud、通知、GitHub live 往返未验证的边界。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | 该 revision 的 initializeAssistantTeam 实际写 leader team 文件、注册 cleanup、准备任务目录并切换 in-process teammate mode，不再抛出 unavailable。 | `src/assistant/index.ts`，符号 `initializeAssistantTeam`，revision `commit` |
| diff-observed | PRSubscriptionManager 以 initialized 控制首轮基线，以带类型前缀的 ID 更新 seen，并仅将 fresh 事件送入通知队列。 | `src/services/prSubscriptions.ts`，符号 `class PRSubscriptionManager`，revision `commit` |
| test-added | 新增六项 KAIROS 离线测试，覆盖 forced 状态、隔离 team 文件、dream prompt、OS adapter mock、bridge 前置条件及 PR 基线/去重/退订；它们不证明 OAuth、上传或 GitHub 在线成功。 | `tests/kairos.test.ts`，符号 `describe('assistant mode'`，revision `commit` |
| test-added | 特性档回归把外部工具数固定为 41，新增 SendUserFile、PushNotification、SubscribePR 和 assistant command 断言。 | `tests/enabledFeatures.test.ts`，符号 `expect(profile.toolCount`，revision `commit` |
| recorded-command-pass | 提交内 STATUS 记录 bun test 已通过 140 个测试、604 个断言；这是 at-commit 历史记录，不是本次文档编写重新执行的结果。 | `docs/STATUS.md`，符号 ``bun test``，revision `commit` |
| recorded-command-pass | 提交内 STATUS 记录 bun run typecheck 零错误，bun run build 完成 CLI、SDK 与声明构建。 | `docs/STATUS.md`，符号 ``bun run typecheck``，revision `commit` |
| recorded-command-pass | 提交内 RELEASE 的 Open KAIROS functionality 段记录 140/604、typecheck、build、declarations 和 41-tool profile 通过，并明确 live Cloud、notification、GitHub round trips 仍未验证。 | `docs/RELEASE.md`，符号 `## Open KAIROS functionality`，revision `commit` |
| not-recorded | 没有真实 OAuth session discovery、Cloud 文件上传、webhook/OS 实际投递、GitHub REST 或多模型 teammate 协作的在线证据；后续整体测试数量也不能替代这些专项验收。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**implemented**
- 真实 OAuth session 列表、远程 viewer、daemon worker/bridge 就绪、文件上传、通知投递和 GitHub 往返仍需授权环境逐项验证。
- 新增六项测试没有专项覆盖 session discovery、安装向导或 webhook 请求；STATUS 对这些组件统一使用 tested 的表述比实际直接证据更宽。
- PR 订阅状态仅存内存，重启会重新建立基线；同 ID 内容更新不会再次通知，评论和 review 没有分页，后台 poll 也没有防重入。
- SendUserFile 没有新增 cwd containment，绝对路径及 cwd 外路径依赖 FileRead 权限；提交测试只覆盖无 bridge 的前置失败。
- /subscribe-pr 的实际解析要求显式 subscribe action，与参数提示中的直接 owner/repo#N 形式不完全一致，且没有命令解析专项测试。
