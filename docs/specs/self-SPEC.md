---
commit: self
changeId: external-stub-restoration
title: "Document and restore external stub capabilities"
status: implemented
kind: component
---

# Document and restore external stub capabilities

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

external 构建中仍存在多类显式占位：Remote Control sanitizer 会让入站消息在记录错误后退出处理，多个消息 renderer 丢弃正文，peer sessions 固定失败；Direct Connect、后台会话、SSH、模板任务和 runner 的入口与实现一起关闭，另有权限、归因、snapshot、MCP monitor 和十八个 slash command 使用空实现。

这些占位不是单一目录里的同名导出，而是分布在传输、权限、进程生命周期、原生适配、UI 和命令注册中。只开启 feature flag 会把用户导向运行时异常，只用 Playwright 或 Zavora fallback 又会掩盖真实 Chrome 与原生宿主能力的边界。需要先冻结完整清单和公开契约，再按依赖恢复实现、入口和验证证据。

## 目标与非目标

### 目标

- 为全部 external stub 建立可追踪的总审计，记录入口、gate、复用模块、目标行为、测试和实现状态。
- 在修改生产源码前完成入站、peer、权限、浏览器、桌面、服务、任务、归因、监控和公开命令的前瞻设计。
- 按依赖分波替换固定失败和空实现，同时接通用户入口、external feature profile 与对应测试。
- 区分开放实现、offline 验证、live 验证和私有协议兼容性，保留真实失败与环境缺失记录。

### 非目标

- 不把测试桩、生成代码、正常 fallback 或已有真实实现仅由产品 gate 关闭的功能重写为另一套实现。
- 不把新定义的公开协议描述为私有 Chrome、BYOC、runner 或其他内部协议的兼容证明。
- 不通过伪装 ant 用户、默认危险权限或关闭认证来让功能表面上可用。
- 不擅自提交、推送或向外部服务发布测试内容。

## 方案架构与数据流

文档层以总审计为范围事实源，以 docs/external-stubs/contracts 下的版本化公开契约约束数据格式、状态机、安全和失败语义，以 verification 文档保存实际执行证据。

实现层优先复用已有 client、session storage、Bridge transport、commit attribution、snapshot 文件操作、structured model query、MCP、Playwright 和 Zavora；新实现通过明确的后端工厂与私有入口分层，不再静默忽略 context。

入口层使用统一 external feature profile 连接生产构建和 profile 测试。每个功能只有在实现、注册和 dist 测试同时完成后才启用，source 直跑结果不替代打包验证。

执行层按入站与 renderer、状态与权限、peer 与桌面、Direct Connect 与后台进程、SSH 与任务、公开命令的依赖顺序推进，并在每波更新审计和状态。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `scripts/commit-docs/records/self.ts` | 记录本次文档先行和分波恢复的统一设计与执行状态。 |
| 变更 | `scripts/commit-docs/records/c69c271.ts` | 将上一项 substantive commit docs 工作从 self 落实为其完整 SHA 记录。 |
| 变更 | `docs/external-stubs/README.md` | 定义范围、架构原则、实施波次和验证状态。 |
| 变更 | `docs/external-stubs/verification.md` | 保存基线失败、各波测试和最终验证证据。 |
| 变更 | `docs/status/external-stubs-audit.md` | 提供逐项 stub、入口、复用、目标实现、测试和状态的总矩阵。 |
| 变更 | `docs/external-stubs/protocol-gates.md` | 区分开放新协议、私有兼容证据和 live 环境边界。 |
| 变更 | `docs/external-stubs/contracts` | 包含入站、peer、权限、浏览器、桌面、服务、任务、状态、监控和公开命令的前瞻契约。 |
| 变更 | `docs/STATUS.md` | 同步当前 stub 边界和后续实际实现状态。 |
| 变更 | `docs/RELEASE.md` | 记录公开能力、验证数量和 live/私有兼容边界。 |
| 变更 | `.gitignore` | 排除 Playwright 测试输出，保持测试工作树清洁。 |
| 复用 | `src/bridge/webhookSanitizer.ts` | 入站安全契约对应的现有信任边界。 |
| 复用 | `src/hooks/useReplBridge.tsx` | 普通入站消息、附件处理与 enqueue 的现有调用方。 |
| 复用 | `src/server/createDirectConnectSession.ts` | Direct Connect 开放服务端需要保持的现有 client 行为。 |
| 复用 | `src/utils/commitAttribution.ts` | 提交归因 hook 与 trailer 应复用的真实计算核心。 |
| 复用 | `src/tools/AgentTool/agentMemorySnapshot.ts` | snapshot merge UI 与完成状态应复用的文件操作核心。 |
| 复用 | `src/utils/sideQuery.ts` | Bash prompt 权限分类和任务分类的结构化模型调用基础。 |
| 复用 | `src/utils/claudeInChrome/chromeNativeHost.ts` | 真实 Chrome 开放连接可复用的 native messaging 与 socket 边界。 |
| 复用 | `src/external-stubs/computer-use-mcp.ts` | 开放 Computer Use schemas、权限和客户端生命周期的现有基础。 |
| 测试 | `tests/enabledFeatures.test.ts` | 后续验证 external 构建入口和工具/命令 profile 的现有测试。 |
| 测试 | `tests/openBackends.test.ts` | 验证开放浏览器和 Computer Use 后端的集成测试。 |
| 变更 | `scripts/externalFeatureProfile.ts` | 统一生产构建与 profile 测试的全部 external feature 列表。 |
| 变更 | `scripts/test.ts` | 按文件隔离 Bun 进程并以同一 external profile 运行标准测试。 |
| 变更 | `scripts/build.ts` | 从共享 profile 读取构建 features。 |
| 变更 | `package.json` | 升级 MCP SDK 并接入隔离测试入口。 |
| 变更 | `bun.lock` | 锁定带公开 Tasks schema 的 MCP SDK 安全版本。 |
| 变更 | `src/commands.ts` | 将十八个恢复的 slash command 注册到 external 命令表并保留真实 internal-only 边界。 |
| 变更 | `src/commands` | 实现十八个公开命令及其共享 helper。 |
| 变更 | `src/main.tsx` | 接通维护、ccshare、up、rollback、Direct Connect、SSH 和 runner 的公开入口。 |
| 变更 | `src/tools.ts` | 将真实 Tungsten 工具纳入 external 工具池。 |
| 变更 | `src/bridge/inboundMessages.ts` | 严格解析普通/webhook envelope 并统一附件与来源准备。 |
| 变更 | `src/bridge/crossSessionMessages.ts` | 为 renderer 与 peer 提供共享可逆 cross-session 编解码。 |
| 变更 | `src/bridge/peerSessions.ts` | 通过 Sessions API 向目标 compat session 投递真实 peer 事件。 |
| 变更 | `src/utils/permissions/bashClassifier.ts` | 实现 forced-tool Bash prompt 规则分类与 fail-closed 解析。 |
| 变更 | `src/jobs/classifier.ts` | 实现版本化 job 分类、generation 隔离和原子状态更新。 |
| 变更 | `src/tasks/MonitorMcpTask/MonitorMcpTask.ts` | 实现公开 MCP Tasks 的状态同步和确认后取消。 |
| 变更 | `src/external-stubs/claude-for-chrome-mcp.ts` | 分离 isolated WebBrowser 与真实 Chrome CDP 后端。 |
| 变更 | `src/external-stubs/computer-use-mcp.ts` | 分离 Zavora 与 native adapter、权限和错误传播。 |
| 变更 | `src/external-stubs/computer-use-native.ts` | 提供公开桌面能力到现有 ComputerExecutor 的适配。 |
| 变更 | `src/utils/computerUse/native` | 实现并编译公开 macOS ScreenCaptureKit/CoreGraphics/NSWorkspace/CGEvent helper。 |
| 变更 | `src/server/server.ts` | 实现 Direct Connect 的鉴权 HTTP/WebSocket 服务。 |
| 变更 | `src/cli/bg.ts` | 实现真实 tmux 后台会话全生命周期。 |
| 变更 | `src/ssh/createSSHSession.ts` | 实现 OpenSSH 探测、部署、代理和本地真实会话。 |
| 变更 | `src/open-runner/main.ts` | 实现 Open Runner 公共 worker/server/help 入口。 |
| 变更 | `src/cli/handlers/templateJobs.ts` | 实现本地模板任务命令和公开帮助。 |
| 变更 | `src/cli/handlers/ant.ts` | 实现公开 log/error/export/task/completion 维护命令。 |
| 变更 | `src/components/agents/SnapshotUpdateDialog.tsx` | 实现 snapshot 三选项与真实 merge 完成状态。 |
| 变更 | `src/utils/attributionHooks.ts` | 实现归因 hook、缓存边界和 HEAD 后 baseline 推进。 |
| 变更 | `src/utils/postCommitAttribution.ts` | 实现保留用户 hook 的归因安装与状态持久化。 |
| 变更 | `src/tools/TungstenTool/TungstenTool.ts` | 实现受控 tmux 工具与隔离 registry。 |
| 变更 | `src/moreright/useMoreRight.tsx` | 实现进程内 MoreRight 便签和轮次状态。 |
| 变更 | `src/utils/ccshareResume.ts` | 实现有界 HTTPS transcript 下载和恢复。 |
| 变更 | `src/services/lsp/LSPClient.ts` | 处理 shutdown 时已关闭连接的清理语义。 |
| 变更 | `src/constants/prompts.ts` | 修复 SDK ESM 初始化后的 BriefTool gate 调用。 |
| 变更 | `tests` | 新增并修复各波次专项、dist、隔离和回归测试。 |

## 关键决策与工程取舍

- 采用文档先行而非边写边补契约，是为了在涉及私有协议和公开行为变化时先明确兼容边界，避免由实现反推一个看似合理但无法验证的语义。
- 普通远程消息与 webhook 使用不同规范化路径；无效 webhook 失败关闭，合法普通消息继续入队，安全功能不能成为所有入站消息的单点故障。
- Direct Connect、Template Jobs 和 runner 使用本仓库明确命名的开放协议与 reference 实现，不根据入口名称推定内部服务契约。
- Chrome 的独立 WebBrowser 与真实浏览器控制、Computer Use 的开放 MCP 与原生 host adapter 分别验收，防止一个后端的成功掩盖另一层的缺失。
- 测试证据区分前置失败、本次回归、offline 和 live；构建成功不能提升功能验证状态。

### 备选方案与回溯分析

- 直接恢复全部 feature flag 会把显式 stub 暴露给用户，因此采用实现与入口同波交付。
- 永久保留 internal-only 或 unavailable 状态虽然能缩小工作，但不符合用户选择的全部 external stub 范围，故为缺少私有协议的功能编写开放新契约。
- 用关键词分类、dummy kill、写自身 transport 或 headless 浏览器模拟目标功能会降低安全与协议可信度，故采用真实模型结构化输出、远端取消、目标会话事件和独立真实浏览器路径。

## 安全与协议边界

- 入站 envelope 采用白名单、大小限制和严格序列化，伪造或嵌套内部标签不能提升消息类型；sanitizer 不被描述为自然语言 prompt injection 的完整防线。
- 权限分类只有高置信 allow 才可自动放行，模型错误、超时、abort、非法输出和低置信结果均进入 ask 或非交互拒绝路径。
- Direct Connect、SSH 和 runner 契约要求认证、最小权限、原子状态与进程身份校验，dangerous backend 必须显式授权且不是默认路径。
- 公开网络命令和诊断输出需要隐私确认与脱敏，测试不写入真实凭据，不污染真实账户限额或向外部服务发送未批准内容。

## 验收标准

- 总审计覆盖全部已确认 external stub 及后续扫描发现的同族项，每项都有公开行为、关键文件、测试和状态。
- 所有契约在源码修改前存在，明确数据结构、状态机、安全失败语义、非目标、offline/dist/live 验收和私有兼容边界。
- 实现阶段每项不再以 unavailable、固定 false、空数组或忽略参数代替目标行为，且用户入口和 external profile 同步恢复。
- 最终报告包含真实专项与全量结果；任何前置失败、回归或 live skipped 均不得省略。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | webhookSanitizer 无条件抛错，useReplBridge 在启用 KAIROS_GITHUB_WEBHOOKS 时对所有已提取入站消息调用它，catch 后只记录错误而不 enqueue。 | `src/bridge/webhookSanitizer.ts` |
| diff-observed | Direct Connect server、后台会话、SSH、模板任务和两个 runner 均保留显式 unavailable 实现，不能通过单独开启 flag 形成功能闭环。 | `src/server/server.ts` |
| recorded-command-pass | 文档阶段开始前实际执行 bun run typecheck 和 bun run build，二者均以退出码零完成。 | `package.json` |
| not-recorded | 同一基线的 bun test 并非全绿：166 个测试通过、cron recurring lastFiredAt 与 LSP force-kill 两个测试失败；结果已记录为前置失败，不能写成通过证据。 | `docs/external-stubs/verification.md` |
| recorded-command-pass | 修正迁移记录覆盖后，实际执行 docs:generate -- --next 和 docs:check -- --next，192 份 SPEC/PLAN 与索引全部通过结构、引用、证据和重复检查。 | `docs/external-stubs/verification.md` |
| recorded-command-pass | 最终标准测试入口实际完成 87 个独立测试文件，483 个测试和 2415 个断言全部通过、1 个桌面 live 用例跳过、零失败；此前 cron 与 LSP 前置失败也通过。typecheck、CLI/SDK/声明构建、Swift helper 编译和 dist 命令检查通过。 | `docs/external-stubs/verification.md` |
| not-recorded | 可信 webhook、双 session peer、Google Chrome 登录态、交互桌面、授权 Linux SSH、外部 runner 和私有协议差分验证未执行，不能由 offline 通过结果推断。 | `docs/external-stubs/verification.md` |

## 实现状态与剩余范围

- 状态：**implemented**
- 82 个审计项的公开实现、注册入口和专项测试已完成，external feature profile 已覆盖全部恢复功能。
- 真实 Cloud、可信 webhook producer、Google Chrome、交互桌面、Linux SSH 和外部 runner live 验证仍需相应授权环境。
- 公开 CDP、Open Runner、Open Computer Use 和其他新公开契约不证明私有扩展、WorkerService、Swift/Enigo ABI 或内部协议兼容。
- 最终全量隔离测试、typecheck、build 和 dist 检查已通过；所有结果均记录在 verification 文档。
