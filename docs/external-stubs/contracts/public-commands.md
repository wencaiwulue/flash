# 18 个 External 命令公开契约

- 日期：2026-11-11
- 状态：新公开设计，尚未实现
- 范围：`src/commands/*/index.js` 中明确列出的 18 个 stub

## 1. 共同约束与历史结论

逐项检查了 `share`、`summary`、`teleport`、`onboarding`、`bughunter`、`oauth-refresh`、`good-claude`、`mock-limits`、`ant-trace`、`issue`、`autofix-pr`、`backfill-sessions`、`break-cache`、`ctx_viz`、`debug-tool-call`、`env`、`perf-issue`、`reset-limits`：它们当前均为 `isEnabled: () => false, isHidden: true, name: 'stub'`，Git 历史只有初始快照 `4b9d30f`，没有旧命令实现、参数或输出契约可恢复。

因此，本文每一项都是**新公开设计**。现有类型、注册点、相邻模块以及 `summary` 已在 `BRIDGE_SAFE_COMMANDS` 中出现等事实是实现约束，不构成“与旧版兼容”的声明。不得仅凭命令名称补造 API、endpoint、scenario 或副作用。

实现时共同要求：

- 用 `index.ts` 的 `satisfies Command` 和 lazy `load()` 替代 stub，将命令移出 `INTERNAL_ONLY_COMMANDS` 并加入 external `COMMANDS`；不得再检查 `USER_TYPE === 'ant'`。仅在确有依赖时使用 `availability`、显式测试开关或运行时前置检查。
- 参数只接受本文列出的形式；解析失败给出 usage，不把余下字符串拼进 shell。所有进程调用使用 argv 和现有权限机制。
- 输出不得包含 token、密钥或未经用户确认的 transcript。本地命令标明 `supportsNonInteractive` 后才开放 `-p`；JSX 命令不伪装支持 headless。
- 每个命令都要有注册测试，验证 external 构建中名称真实、非 hidden、`isEnabled` 的前置条件以及 lazy module 的 `call`/prompt 接口，而非只检查对象名称。

## 2. `share`

- **接口**：`local-jsx`，`/share [output.html]`；无参数先预览并输入目标文件，带参数仍需确认内容摘要。输出文件必须不存在，使用 `wx` 写入。
- **语义**：把当前对话渲染成单一、转义正确的静态 HTML 文件，便于用户自行分享；提供是否包含工具输出的选择。它**不创建公网链接、不上传、不生成 ccshare id**，成功结果只报告本地路径。
- **复用**：`src/commands/export/export.tsx`、`src/components/ExportDialog.tsx`、`src/utils/exportRenderer.tsx` 的消息渲染与文件命名思路；HTML escaping 使用专用纯函数，不能拼接未转义正文。
- **隐私/副作用**：只写用户选定文件；预览明确提示对话可能含密钥，不能宣称正则 redaction 完整。无网络，默认不自动打开浏览器。
- **测试**：HTML 中 `<script>`、事件属性和 `</pre>` 均作为文本；空对话、工具输出选择、路径逃逸/拒绝覆盖、写失败，以及全程零网络请求。

## 3. `summary`

- **接口**：`prompt`，`/summary [focus]`，`progressMessage='summarizing conversation'`。
- **语义**：要求当前模型总结已有对话，可选 focus 只影响总结重点；结果是普通 assistant 回复。它**不压缩、不截断、不重写上下文**，不调用 `/compact`，也不创建 checkpoint。
- **复用**：`src/services/compact/compact.ts` 的总结关注点仅作 prompt 参考；实际执行沿用 `PromptCommand.getPromptForCommand()` 和正常 query 流程。保留其进入 `BRIDGE_SAFE_COMMANDS` 的合理性：prompt 展开没有本地 JSX 副作用。
- **隐私/副作用**：对话和 focus 会发送给当前模型提供商，回复写入当前 transcript；无文件或 Git 修改。
- **测试**：focus 正确进入 text block、空参数、确认不调用 `compactConversation`/hooks、空对话提示，以及 bridge prompt 不触发本地 UI。

## 4. `teleport`

- **接口**：`local-jsx`，`availability: ['claude-ai']`，`/teleport [session-id]`。无参数列出并选择远程 session；有参数直接恢复该 session。
- **语义**：把已有 Claude Code on the web session 恢复到本地，复用现有事件下载、校验和进度 UI；它不是“把本地 session 新建到云端”的命令，后者仍由既有 remote 流程负责。
- **复用**：`src/utils/teleport/api.ts` 的 `fetchCodeSessionsFromSessionsAPI()`/`fetchSession()`，`src/utils/teleport.tsx` 的 `teleportResumeCodeSession()`、`teleportFromSessionsAPI()`、`validateSessionRepository()`，`src/components/TeleportProgress.tsx`、`TeleportResumeWrapper.tsx`、`TeleportRepoMismatchDialog.tsx`。
- **隐私/副作用**：OAuth 请求下载 session 与事件；可能 checkout 远程分支并处理本地未提交修改，repo 不匹配和 stash 必须显式确认。失败不得先清工作区。
- **测试**：列表/直 id、未登录、网络失败、错误 session、repo 不匹配、stash 取消和成功恢复；用临时 Git 仓库验证失败路径工作区不变，API 全 mock。

## 5. `onboarding`

- **接口**：`local-jsx`，仅 `/onboarding`，不接受 `--reset`。
- **语义**：显式重跑现有欢迎、主题、认证/API key 确认、安全说明和终端设置向导；完成全部步骤后调用 `completeOnboarding()`。取消只退出，不将未完成状态标为完成，也不清空已有凭据。
- **复用**：`src/components/Onboarding.tsx`、`src/interactiveHelpers.tsx` 的 `completeOnboarding()`、`src/components/ConsoleOAuthFlow.tsx`、`src/commands/terminalSetup/terminalSetup.ts`。
- **隐私/副作用**：主题与 onboarding 配置写入；用户选择认证时会打开浏览器并写 OAuth 安全存储，终端步骤可修改其明确选择的终端配置。命令自身不额外上传 transcript。
- **测试**：步骤顺序、跳过 OAuth、取消不写完成标记、完成只写一次、非 Anthropic auth 环境、API key 不在输出中出现。

## 6. `bughunter`

- **接口**：`local-jsx`，`availability: ['claude-ai']`，`/bughunter [focus]`；`isEnabled` 复用 `isUltrareviewEnabled()`。
- **语义**：作为现有远程审查能力的公开入口，按 focus 启动一次远程 bug review 并注册 RemoteAgentTask；不另造第二类扫描服务，也不在本地假装已审查。
- **复用**：直接复用 `src/commands/review/ultrareviewCommand.tsx` 的 `call`、`src/commands/review/reviewRemote.ts` 的 quota/Extra Usage/teleport 流程和 `src/tasks/RemoteAgentTask/RemoteAgentTask.ts`。
- **隐私/副作用**：推送分支上下文发往云端并可能计费；quota、低余额、超额确认和 Escape 完全沿用现有路径。未确认超额不得创建 session。
- **测试**：focus 透传、未启用、免费额度、低余额、超额取消/确认、teleport 失败和 task 注册；计费与网络全部 mock。

## 7. `oauth-refresh`

- **接口**：`local`，`supportsNonInteractive: true`，`availability: ['claude-ai']`，`/oauth-refresh [--status]`。无参数强制刷新，`--status` 只显示过期时间与 scopes。
- **语义**：无参数读取当前 OAuth token，调用真实 token endpoint，成功才原子保存新 token 并清内存认证缓存；失败保留旧 token。`--status` 不联网、不刷新，不增加 logout/reset 旁路。
- **复用**：`src/services/oauth/client.ts` 的 `refreshOAuthToken()`，`src/utils/auth.ts` 的 `getClaudeAIOAuthTokensAsync()`、`saveOAuthTokensIfNeeded()`、`clearOAuthTokenCache()`。
- **隐私/副作用**：无参数会联网并更新凭据存储；输出只有状态、expiry、scope，不输出 access/refresh token，也不把 token 放 argv 或日志。
- **测试**：临期/有效/无 token、refresh rotation、网络与 4xx 失败保留旧值、status 零网络、保存后缓存失效、输出 secret 扫描。

## 8. `good-claude`

- **接口**：`local-jsx`，仅 `/good-claude`，可用性与 `/feedback` 一样尊重反馈开关、组织策略和隐私级别。
- **语义**：手动打开与被动调查一致的评分/感谢流程并预选 good；只有用户随后明确同意分享 transcript 时才进入分享上传，不允许命令名本身代表上传授权。
- **复用**：从 `src/components/FeedbackSurvey/useFeedbackSurvey.tsx` 提取可复用的 response 记录与 transcript-consent 控制器，`FeedbackSurveyView.tsx`、`TranscriptSharePrompt.tsx` 和 `submitTranscriptShare.ts`。
- **隐私/副作用**：评分产生正常反馈遥测；transcript 上传是独立、可拒绝的第二次确认。拒绝后不得读取 raw JSONL 或调用分享 endpoint。
- **测试**：good 事件、策略禁用、拒绝 transcript 时零上传、接受时沿用 redaction/大小限制、重复提交去重。

## 9. `mock-limits`

- **接口**：`local`，`/mock-limits list|status|clear|<scenario>`；只有启动前显式设置 `CLAUDE_CODE_ENABLE_MOCK_LIMITS=1` 时 enabled，并显示持久 mock 横幅。
- **语义**：列出并设置当前进程内的模拟限额响应；scenario 只能来自导出的有限集合，不能任意伪造 header。`clear` 恢复真实响应处理。它不改变服务端额度。
- **复用**：`src/services/mockRateLimits.ts` 的 `MockScenario`、`setMockRateLimitScenario()`、`getMockStatus()`、`clearMockHeaders()`，`src/services/rateLimitMocking.ts`。把现有 ant 判断改为同一个显式测试开关，并导出只读 scenario 列表。
- **隐私/副作用**：命令本身无网络/磁盘写入，但之后 API 行为会被模拟，可能触发本地 429 UI；必须明显标识，测试进程结束即消失。
- **测试**：未 opt-in 完全无效、list/status/clear、每个公开 scenario、非法名称、真实 header 恢复、429 不进入真实 retry 统计。

## 10. `ant-trace`

- **接口**：`local-jsx`，`/ant-trace start|stop|status|export <path>`；名称保留，公开含义为本地 OpenTelemetry 诊断记录，不代表内部员工 trace 服务。
- **语义**：start 在当前进程安装有界 span recorder，stop 停止并释放；status 显示 span 数/丢弃数；export 在预览后写 JSON。只记录 start 之后的新 span，不 retroactively 读取请求正文。
- **复用**：现有 OpenTelemetry 依赖、`src/utils/telemetry/sessionTracing.ts` 的 span 语义、`src/services/analytics/metadata.ts` 的属性安全约束、`src/utils/queryProfiler.ts` 的计时上下文。
- **隐私/副作用**：默认无网络；ring buffer 有数量/字节上限，导出仅含允许的属性、计时和错误类别，不含 prompt、工具输入/输出、header、token 或文件正文。写文件不覆盖。
- **测试**：start/stop 幂等、buffer 上限、敏感属性过滤、export schema 与拒绝覆盖、停止后无新 span、OTel exporter 不被隐式启用。

## 11. `issue`

- **接口**：`local-jsx`，`/issue [report]`，开关与 `/feedback` 一致。
- **语义**：把 report 作为初始描述，进入现有产品问题反馈/GitHub issue 流程；不再实现第二个 `gh issue create` 路径，也不自动把当前 diff 或 transcript 发到当前仓库。
- **复用**：`src/commands/feedback/feedback.tsx` 的 `renderFeedbackComponent()` 与 `src/components/Feedback.tsx` 的反馈提交、GitHub issue URL、错误和 consent 处理。
- **隐私/副作用**：用户确认后可能创建 `anthropics/claude-code` issue 或提交反馈；transcript、subagent 和错误日志仅在原流程明确 consent 后包含，沿用 redaction。
- **测试**：初始描述、取消零网络、consent 分支、GitHub URL 长度边界、API 失败，以及不会把 issue 建到任意当前工作仓库。

## 12. `autofix-pr`

- **接口**：`prompt`，`/autofix-pr [PR-number-or-URL]`；无参数表示当前分支 PR，引用由 `parsePRReference()` 验证。
- **语义**：模型读取 PR 描述、diff、issue comments 和 review comments，定位可在本地修复的问题，按正常权限编辑并运行相关测试，最后报告修改和未解决项。**不得自动 commit、push、merge、关闭讨论或发 PR 评论**。
- **复用**：`src/commands/pr_comments/index.ts` 的两类 comments API 路径、`src/commands/review.ts` 的本地 review 流程、`src/utils/worktree.ts` 的 `parsePRReference()`；prompt 声明所需 `Bash(gh *)`、Read/Edit/Write 和测试工具权限。
- **隐私/副作用**：`gh` 联网读取 PR，内容发送给当前模型；文件修改与测试需要正常权限。prompt 自身不执行 shell，不预授权 push。
- **测试**：数字/URL/非法引用、当前 PR 分支、评论分页提示、测试失败报告、工作区已有修改提示，以及静态检查 prompt 没有自动 commit/push/merge 指令。

## 13. `backfill-sessions`

- **接口**：`local`，`supportsNonInteractive: true`，`/backfill-sessions [--dry-run] [--force]`。
- **语义**：扫描本地历史 session，为缺失或失效的 insights `SessionMeta` 重建本地 metadata；默认只补缺失，`--force` 重建，`--dry-run` 只报告数量。它不上传 session、不调用模型、不重算 provider 用量。
- **复用**：从 `src/commands/insights.ts` 提取 `SessionMeta`、`logToSessionMeta()`、cache 读写和 session 去重为可复用模块；读取复用 `src/utils/sessionStorage.ts`/`sessionStoragePortable.ts`，原子写与锁参考 `src/utils/statsCache.ts`。
- **隐私/副作用**：只读本地 JSONL并写本地 metadata，权限 `0600`；尊重 cleanupPeriodDays，不恢复已删除 transcript，不访问分享/ingress API。
- **测试**：缺失、有效、损坏、重复 session、dry-run 零写入、force、部分失败、并发锁、原子写和全程零网络/模型调用。

## 14. `break-cache`

- **接口**：`local`，`supportsNonInteractive: true`，仅 `/break-cache`。
- **语义**：同步调用现有 `clearSessionCaches()`，使命令、技能、文件建议、repo 检测等进程内派生缓存下次重建。它**不清对话、不删磁盘文件、不重置 provider 限额，也不承诺使服务端 prompt cache 失效**。
- **复用**：`src/commands/clear/caches.ts` 的唯一清理聚合函数，不另维护一份易漂移的 cache 列表。
- **隐私/副作用**：无网络，只清当前进程派生状态；正在运行的任务与 transcript 保留。动态 import 的清理 Promise 需要可 await 的聚合入口，命令完成时报告实际完成的范围。
- **测试**：各清理函数被调用、transcript/tasks 不变、重复调用、动态清理失败可诊断，以及明确没有删除 stats/session 文件或发“服务端缓存已清”文案。

## 15. `ctx_viz`

- **接口**：`local-jsx`，`/ctx_viz [--json <path>]`；默认显示逐消息/分类上下文图，`--json` 在确认后额外写结构相同的分析数据。
- **语义**：复用 `/context` 的 API-view 变换和 token 分析，增加逐消息 token 表及 JSON 导出；不修改消息、不执行 microcompact 持久化，也不提供删除附件按钮。
- **复用**：`src/commands/context/context.tsx` 的 `toApiView`（提取共享）、`src/utils/analyzeContext.ts` 的 `analyzeContextUsage()`、`src/components/ContextVisualization.tsx`、`src/services/compact/microCompact.ts`。
- **隐私/副作用**：采用与 `/context` 相同的 token-count/fallback 路径，可能向当前提供商发 token-count 请求，不能宣称绝对离线；JSON 不含消息正文，只含 id、角色、类别和 token 数，写文件不覆盖。
- **测试**：与 `/context` 总数一致、collapse 边界、逐消息求和、空上下文、JSON 无正文、路径错误、token-count 失败 fallback 和零意外消息变更。

## 16. `debug-tool-call`

- **接口**：`local-jsx`，`/debug-tool-call [tool-use-id]`；无参数列出当前消息中的调用，有参数直接查看。
- **语义**：只读配对 tool_use/tool_result，展示工具名、参数、结果、错误、schema 校验和时间信息；支持 `--validate` 对保存的输入做 schema 校验。**不提供 replay，不调用 `tool.call()`，不重新做权限批准**。
- **复用**：`src/types/message.ts`、`src/Tool.ts` 的 schema/registry、`src/services/mcp/client.ts` 的 MCP 工具映射、`src/components/tasks/BackgroundTasksDialog.tsx` 的选择 UI 模式。
- **隐私/副作用**：仅在当前终端显示用户已有的数据，无网络、文件或进程副作用；导出不在本契约中。
- **测试**：成功/失败/缺失/重复 id、MCP 名称、截断结果、schema invalid，以及用 spy 断言任何查看和 validate 都未执行工具或权限路径。

## 17. `env`

- **接口**：`local`，`supportsNonInteractive: true`，`/env [NAME]`；无参数列出有效 `CLAUDE_*`/`ANTHROPIC_*`，指定 NAME 只查一项。
- **语义**：显示 process env 与合并 settings 后的有效非敏感配置及来源；敏感 key 永远显示 `<redacted>`，没有 reveal 参数，也不提供编辑/预设功能。
- **复用**：`src/utils/envUtils.ts`、`src/utils/managedEnv.ts`、`src/utils/settings/settings.ts`、`src/utils/managedEnvConstants.ts` 的来源和安全键规则。有效值计算应是纯函数，不得为查看而再次 apply 环境。
- **隐私/副作用**：无网络、无 process.env 或设置写入；默认不枚举 PATH、HOME、代理凭据等无关变量。URL 的 userinfo/query 也按敏感处理。
- **测试**：来源优先级、指定 NAME、大小写、secret/URL redaction、非法额外变量、输出无 token，以及调用前后 `process.env` 深度相等。

## 18. `perf-issue`

- **接口**：`local-jsx`，`/perf-issue [output.json]`；无参数预览当前诊断并选择输出路径。
- **语义**：收集当前进程已经存在的 startup/query timings、最近错误类别、版本/平台、MCP 数量和内存概况，生成可随问题报告附上的本地 JSON；不 retroactively 打开 profiler，不自动复现或上传。
- **复用**：`src/utils/startupProfiler.ts` 的 `getStartupPerfLogPath()`，`src/utils/queryProfiler.ts`（提取纯 `getQueryProfileReport()`），`src/utils/log.ts` 的 `getInMemoryErrors()`，`src/utils/env.ts`，以及 `/heapdump` 的显式诊断边界。
- **隐私/副作用**：只写用户确认的 JSON；不包含消息、工具参数、request/response body、环境变量值或 heap 内容，错误先走 `redactSensitiveInfo()`。无网络。
- **测试**：有/无 profile、长错误与大字段上限、redaction、输出 schema、拒绝覆盖、非 TTY headless 不开放，以及不会改变 profiler 开关或发网络请求。

## 19. `reset-limits`

- **接口**：默认导出 `local`，并同时导出 `resetLimits` 与 `resetLimitsNonInteractive`；`/reset-limits [status|mocks|refresh]`，默认 `status`。
- **语义**：status 显示本地/远端限额状态；mocks 只调 `clearMockHeaders()`；refresh 调 `checkQuotaStatus()` 重新获取状态。**没有任何分支能重置服务端额度，也不删除本地使用统计**。
- **复用**：`src/services/mockRateLimits.ts`、`src/services/claudeAiLimits.ts` 的 `checkQuotaStatus()`/`getRateLimitDisplayName()`、`src/services/rateLimitMessages.ts`。默认与 noninteractive 共用同一个 core，避免行为分叉。
- **隐私/副作用**：status/mocks 无网络；refresh 有只读认证请求。mocks 成功文案必须附带“真实 provider 限额未改变”。
- **测试**：四个入口形式、mock 清理、refresh 成功/失败、无凭据、本地 stats 不变、两个导出行为一致，以及绝不出现“服务端额度已重置”的假成功。
