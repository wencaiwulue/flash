# Batch 5 审计报告：Agent Swarms

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | ✅ 已提取 strings | /opt/homebrew/bin/claude 已提取相关 agent/swarm/team 字符串 |
| 官方文档 | ❓ 未访问 | code.claude.com 未实时访问 |
| 审查范围 | agent-swarms 子系统深度审计；help-feedback/plan-worktree/review-analysis/scheduling/task-system/workflow 子系统保持 open 状态 | agent-swarms 完整生命周期审查；其余 6 子系统待审计 |

### 启动状态 RED ✅

```bash
# 门禁运行验证（审计开始前）
# batch-5.md 不存在 → RED
```

## 子系统审查

### agent-swarms

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-agent-swarms-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/agent-swarms.yaml |
| Manifest 注册 | ✅ | id: agent-swarms, batch: 5, status: draft |
| Coverage 覆盖分组 | 10/10 | agent-tool-core, agent-memory, team-tools, swarm-mailbox, swarm-team-state, swarm-permission-sync, swarm-in-process-runner, swarm-backends, swarm-layout-reconnection, coordinator |

#### 文档完整性审查

✅ **问题与约束**：准确描述了多代理并行执行需求、跨进程消息传递、权限同步、团队状态持久化、fork 子代理缓存优化、coordinator 模式等核心约束。

✅ **设计理由与备选方案**：12 项关键决策表格化展示，包含真实证据位置：
- 基于文件系统的 mailbox 消息传递（lockfile 保证原子读写）
- TeamFile 团队状态持久化到 `~/.claude/teams/{teamName}/config.json`
- 双路径权限同步：in-process 通过 UI bridge，跨进程通过 mailbox
- 隐式 fork 继承父系统提示和工具池（最大化 prompt cache 命中率）
- Coordinator 模式分离协调与执行
- Worktree 隔离可选而非强制（git worktree 创建）
- 异步 agent 与同步 agent 双路径
- 团队解散前检查活跃成员（`isActive !== false`）

✅ **目标与非目标**：清晰界定了团队上下文完整生命周期、agent 任务状态管理、mailbox 读写与标记已读、worktree 创建/路径转换/清理等目标；明确了不拥有单代理内部执行逻辑、不拥有工具实现细节等非目标。

✅ **架构、模块与数据流**：
- 10 个模块设计卡（AgentTool 主入口、AgentTool Fork 隐式子代理、AgentTool Worktree 隔离、TeamCreateTool、TeamDeleteTool、SendMessageTool、TeamFile 团队状态持久化、Mailbox 文件邮箱系统、双路径权限同步、Coordinator 模式）
- 完整 Spawn 子代理同步/异步流程、团队创建与成员 spawn 流程、Coordinator 模式执行流程、Mailbox 消息传递流程
- 关键数据结构（TeamFile、TeammateMessage、SwarmPermissionRequest）

✅ **证据链覆盖**：完整的「工具调用 → 决策路径 → 状态变更 → 消息传递 → 资源清理」生命周期证据链已验证：
- AgentTool 调用：feature gate 检查 → team_name 解析 → 权限规则检查 → 执行模式决策（sync/async/teammate/remote）
- Fork 路径：`isForkSubagentEnabled()` → `isInForkChild()` 防递归 → `buildForkedMessages()` 继承上下文 → `useExactTools` 共享工具池
- Mailbox：`ensureInboxDir()` → `lockfile.lock()` → `readMailbox()` 重读最新 → `push()` → `writeFile()` → `release()`
- 团队创建：`generateUniqueTeamName()` → `writeTeamFileAsync()` → `resetTaskList()` → `setLeaderTeamName()` → 更新 AppState
- 权限同步：`createInProcessCanUseTool()` → `getLeaderToolUseConfirmQueue()` → UI 回调 → `applyPermissionUpdates()`

#### 源码验证

**agent-tool-core**（src/tools/AgentTool/）：
- `AgentTool.tsx`：主入口，`baseInputSchema` 与 `fullInputSchema`（多 agent 参数 + isolation），`isBackgroundTasksDisabled` 门控，`getAutoBackgroundMs()` 自动后台，完整 4 路径执行（sync/async/teammate/remote），`registerAgentForeground`/`registerAsyncAgent` 状态管理 ✅
- `forkSubagent.ts`：`isForkSubagentEnabled()` 检查 feature gate + coordinator 互斥 + 非交互会话，`isInForkChild()` 检测 `FORK_BOILERPLATE_TAG` 防递归，`buildForkedMessages()` 保留完整 `assistantMessage` 并为所有 `toolUse` 生成占位，`FORK_AGENT` 定义（`tools: ['*']`, `model: 'inherit'`, `permissionMode: 'bubble'`）✅
- `runAgent.ts`：子代理主执行逻辑 ✅
- `resumeAgent.ts`：恢复已停止 agent ✅
- `agentToolUtils.ts`：`agentToolResultSchema`, `finalizeAgentTool` 等工具 ✅
- `UI.tsx`, `prompt.ts`：UI 渲染与提示构建 ✅
- `builtInAgents.ts`, `loadAgentsDir.ts`：内置 agent 与 agent 目录加载 ✅
- `constants.ts`：常量定义 ✅

**agent-memory**（src/tools/AgentTool/）：
- `agentMemory.ts`：内存管理 ✅
- `agentMemorySnapshot.ts`：快照初始化、时间戳验证、保留变更、回滚机制 ✅
- `agentMemorySnapshotMerge.ts`：快照合并 ✅
- `loadAgentsDir.ts`：agent 目录加载 ✅
- `agentColorManager.ts`：颜色分配 ✅

**team-tools**（src/tools/TeamCreateTool/ + src/tools/TeamDeleteTool/）：
- `TeamCreateTool.ts`：`generateUniqueTeamName()` 检查团队名存在并自动生成，TeamFile 构造（`leadAgentId` 为 `formatAgentId(TEAM_LEAD_NAME, teamName)`），`registerTeamForSessionCleanup` 会话退出清理，`resetTaskList` + `ensureTasksDir` 任务目录创建，`setLeaderTeamName` 设置 leader 团队名，AppState 更新 ✅
- `TeamDeleteTool.ts`：检查活跃成员（`nonLeadMembers.filter(m => m.isActive !== false)`），`cleanupTeamDirectories` 清理目录与 worktree，`unregisterTeamForSessionCleanup`，`clearTeammateColors`，`clearLeaderTeamName` ✅
- 两个工具均有 `UI.tsx`、`prompt.ts`、`constants.ts` ✅

**swarm-mailbox**（src/utils/teammateMailbox.ts）：
- `getInboxPath()`：路径构造，`sanitizePathComponent` 安全化 ✅
- `ensureInboxDir()`：目录创建 ✅
- `readMailbox()`/`readUnreadMessages()`：读取消息 ✅
- `writeToMailbox()`：使用 `proper-lockfile` 锁（`LOCK_OPTIONS` 含重试/退避），锁后重读最新，append 追加，`release()` 释放锁 ✅
- `markMessageAsReadByIndex()`：按索引标记已读，锁保护 ✅
- `markMessagesAsRead()`：批量标记 ✅
- `clearMailbox()`：清空 ✅
- 结构化协议消息（`idle_notification`/`permission_request`/`permission_response`/`shutdown_request`/`shutdown_approved`/`shutdown_rejected`/`plan_approval_request`/`plan_approval_response`/`team_permission_update`/`mode_set_request`/`sandbox_permission_request`/`sandbox_permission_response`/`task_assignment`）嵌套在 `text` 字段 JSON 中 ✅

**swarm-team-state**（src/utils/swarm/teamHelpers.ts）：
- `readTeamFile()`/`readTeamFileAsync()`：同步/异步读取，`ENOENT` 返回 null ✅
- `writeTeamFileAsync()`：原子写入，目录递归创建 ✅
- `writeTeamFile()`：同步版本 ✅
- `getTeamFilePath()`/`getTeamDir()`：路径构造 ✅
- `removeTeammateFromTeamFile()`：移除成员 ✅
- `addHiddenPaneId()`/`removeHiddenPaneId()`：隐藏 pane 管理 ✅
- `removeMemberFromTeamFile()`：移除成员 ✅
- `cleanupTeamDirectories()`：清理团队目录与 worktree ✅
- `sanitizeName()`/`sanitizeAgentName()`：名称安全化 ✅
- TeamFile 完整结构：`name`/`description`/`createdAt`/`leadAgentId`/`leadSessionId`/`hiddenPaneIds`/`teamAllowedPaths`/`members`（每个成员含 `agentId`/`name`/`agentType`/`model`/`prompt`/`color`/`planModeRequired`/`joinedAt`/`tmuxPaneId`/`cwd`/`worktreePath`/`sessionId`/`subscriptions`/`backendType`/`isActive`/`mode`）✅

**swarm-permission-sync**（src/utils/swarm/permissionSync.ts）：
- `createPermissionRequest()`/`writePermissionRequest()`/`sendPermissionRequestViaMailbox()`/`generateRequestId()`：权限请求构造与发送 ✅
- 旧路径（`pending`/`resolved` 文件）与新路径（mailbox 协议）并存 ✅

**swarm-in-process-runner**（src/utils/swarm/inProcessRunner.ts）：
- `createInProcessCanUseTool()`：in-process worker 权限检查，`getLeaderToolUseConfirmQueue()` UI 桥接，权限更新通过 `applyPermissionUpdates` 同步给 leader（`preserveMode: true`）✅
- `getLeaderSetToolPermissionContext()`：leader 权限上下文桥接 ✅

**swarm-backends**（src/utils/swarm/backends/）：
- `types.ts`：`BackendType` 类型定义 ✅
- `registry.ts`：后端注册与解析 ✅
- `InProcessBackend.ts`：in-process 后端 ✅
- `TmuxBackend.ts`：tmux 后端 ✅
- `ITermBackend.ts`：iTerm2 后端 ✅
- `PaneBackendExecutor.ts`：pane 执行器 ✅
- `detection.ts`：后端检测 ✅
- `teammateModeSnapshot.ts`：teammate 模式快照 ✅

**swarm-layout-reconnection**（src/utils/swarm/）：
- `teammateLayoutManager.ts`：布局管理、颜色分配 ✅
- `teammatePromptAddendum.ts`：提示补充 ✅
- `teammateModel.ts`：teammate 模型 ✅
- `reconnection.ts`：重连逻辑 ✅

**coordinator**（src/coordinator/）：
- `coordinatorMode.ts`：`isCoordinatorMode()` 检查，`getCoordinatorSystemPrompt()` 注入协调器提示，`getCoordinatorUserContext()` 添加上下文，`INTERNAL_WORKER_TOOLS` 集合限制 worker 可用工具 ✅
- `workerAgent.ts`：worker agent 逻辑 ✅

**发现 B5-agent-swarms-01**：AgentTool 缺少完整测试覆盖 - 尽管有 `agentMemorySnapshot.test.ts`（agent-memory 分组的快照测试），但 AgentTool 核心执行路径（4 模式：sync/async/teammate/remote）、fork 子代理路径、worktree 隔离路径、权限同步路径均无专用测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认，仅 `agentMemorySnapshot.test.ts` 存在）。

**发现 B5-agent-swarms-02**：TeamCreateTool/TeamDeleteTool/SendMessageTool 无专用测试 - 团队创建与解散流程、消息路由（本地 agent/团队成员/UDS/Bridge）无独立测试覆盖。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认）。

**发现 B5-agent-swarms-03**：Mailbox 并发与锁机制无对抗性测试 - 尽管实现了 `proper-lockfile` 锁 + 重试/退避，但无测试验证多个进程并发写同一 inbox 的竞态情况。严重度：P2（测试缺口，非实现缺口），置信度：已证实。

**发现 B5-agent-swarms-04**：权限同步新旧路径并存增加复杂度 - `permissionSync.ts` 中旧路径（`pending`/`resolved` 文件）与新路径（mailbox 协议）并存，spec 中已记录但无测试验证迁移场景。严重度：P3（工程改进建议），置信度：已证实（src/utils/swarm/permissionSync.ts）。

**发现 B5-agent-swarms-05**：worktree 清理依赖 `hasWorktreeChanges()` - 该函数未跟踪未跟踪文件，可能导致意外保留 worktree，spec 中已明确记录此权衡。严重度：P3（文档已记录，无功能问题），置信度：已证实（spec 与源码一致）。

**发现 B5-agent-swarms-06**：in-process worker 与跨进程 worker 的 `isActive` 状态管理 - `isActive` 标记为 `false` 表示空闲/退出/崩溃，但无测试验证崩溃场景的状态转换。严重度：P3（测试缺口），置信度：已证实。

**发现 B5-agent-swarms-07**：mailbox 消息无超时机制 - worker 等待 permission_response 无超时，可能永久阻塞，spec 中已记录此设计权衡。严重度：P3（文档已记录，无功能问题），置信度：已证实（spec 与源码一致）。

**发现 B5-agent-swarms-08**：TeamFile 原子写入使用 `writeFile()` 而非临时文件 rename - `writeTeamFileAsync()` 直接写入目标路径而非先写临时文件再 rename，存在崩溃时文件损坏风险。严重度：P2（低概率但高影响），置信度：已证实（src/utils/swarm/teamHelpers.ts:156-163）。

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ `agentMemorySnapshot.test.ts`：存在且完整，覆盖快照初始化、时间戳验证、保留变更、回滚机制、合并完成验证、删除支持、symlink 拒绝、回滚逻辑
- ❌ 无 AgentTool 核心执行路径测试（sync/async/teammate/remote）
- ❌ 无 fork 子代理测试
- ❌ 无 worktree 隔离测试
- ❌ 无 TeamCreateTool/TeamDeleteTool 测试
- ❌ 无 SendMessageTool 测试
- ❌ 无 mailbox 并发测试
- ❌ 无权限同步双路径测试
- ❌ 无 coordinator 模式测试
- ❌ 无多后端（in-process/tmux/iTerm2）测试

#### 隐私与安全边界审查

**权限隔离边界**：
- in-process worker 通过 `bubble` 权限模式同步给 leader 用户确认 ✅
- 跨进程 worker 通过 mailbox `permission_request`/`permission_response` 协议同步 ✅
- leader 的 `toolPermissionContext` 通过 `preserveMode: true` 更新，不影响 leader 自身模式 ✅
- TeamFile 的 `mode` 字段记录成员当前权限模式 ✅

**团队状态隔离**：
- 每个团队独立目录 `~/.claude/teams/{teamName}/` ✅
- 每个 teammate 独立 inbox `~/.claude/teams/{teamName}/inboxes/{agentName}.json` ✅
- 团队任务目录独立 `~/.claude/tasks/{sanitizedTeamName}/` ✅

**路径安全**：
- `sanitizeName()` 替换所有非字母数字为连字符并小写 ✅
- `sanitizeAgentName()` 替换 `@` 为连字符 ✅
- `sanitizePathComponent()` 安全化路径组件 ✅

**锁机制安全**：
- mailbox 使用 `proper-lockfile` 库，`LOCK_OPTIONS` 含重试与退避 ✅
- 锁后重读消息确保最新状态 ✅

**发现 B5-agent-swarms-09**：TeamFile 写入无原子 rename 保护（见 B5-agent-swarms-08）- 这是安全边界的潜在风险点。严重度：P2，置信度：已证实。

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `AgentTool`, `TeamCreateTool`, `TeamDeleteTool`, `SendMessageTool`：工具名匹配 ✅
- `CLAUDE_CODE_AGENT_ID`, `CLAUDE_CODE_AGENT_NAME`, `CLAUDE_CODE_TEAM_NAME`：环境变量匹配 ✅
- `team-lead`, `teammate`, `swarm`：术语匹配 ✅
- `in-process`, `tmux`, `iTerm2`：后端匹配 ✅
- `worktree`：隔离术语匹配 ✅
- `mailbox`, `inbox`：消息传递匹配 ✅
- `coordinator`：模式匹配 ✅
- `permission_request`, `permission_response`：权限同步匹配 ✅
- `shutdown_request`, `shutdown_response`：关闭协议匹配 ✅
- `isActive`：状态标记匹配 ✅

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，12 项决策，10 个模块设计卡，完整生命周期证据链 | ⚠️ 上游文档未实时访问 |
| 源码一致性 | ✅ 所有 10 个分组源码与 spec 高度一致 | ⚠️ TeamFile 原子写入可改进 |
| 测试覆盖 | ⚠️ 仅 agentMemorySnapshot.test.ts 完整 | ❌ 核心执行路径、团队工具、mailbox 并发、权限同步、coordinator、多后端均无测试 |
| 官方文档 | ❓ 未访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ✅ 已提取 strings，关键术语匹配 | ⚠️ 仅静态证据 |

---

### help-feedback

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-help-feedback-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/help-feedback.yaml |
| Manifest 注册 | ✅ | id: help-feedback, batch: 5, status: draft |
| Coverage 覆盖分组 | 2/2 | additional-files, commands |

#### 文档完整性审查

✅ **问题与约束**：准确描述了用户功能发现、反馈收集、隐私保护、用户打扰最小化、上下文相关性、多语言考虑、组织策略控制等核心约束。

✅ **设计理由与备选方案**：8 项关键决策（数字键响应、低概率随机触发、转录共享分两步、提示冷却+相关性、LogoV2 双模式、敏感信息清理）详细描述了备选方案和选择理由，包含真实证据位置。

✅ **目标与非目标**：清晰界定了可发现性、反馈收集、隐私保护、低打扰、上下文相关、组织控制、紧急通知等目标；明确不进行 A/B 测试、行为分析、实时聊天支持、收集 PII、多语言支持等非目标。

✅ **架构、模块与数据流**：7 个模块设计卡（HelpV2、FeedbackSurvey、Feedback、Tips、LogoV2、ReleaseNotes、Passes），完整的状态机流程、提交流程、敏感信息清理范围、GitHub Issue URL 截断策略等。

✅ **证据链覆盖**：完整的数字键防抖冲突处理、触发概率控制、冷却期检查、敏感信息正则清理、GitHub Issue URL 长度限制等证据链已验证。

#### 源码验证

**additional-files**（src/commands/feedback/）：
- `feedback.tsx`、`feedbackAvailability.ts`：反馈命令入口、可用性检查 ✅
- `feedbackSurveyShared.ts`：反馈调查共享逻辑、事件记录、转录共享触发 ✅
- `src/utils/dxt/helpers.ts`：DXT 辅助函数 ✅

**commands**（src/commands/）：
- `help.tsx`：Help 命令实现 ✅
- `advisor.ts`、`btw.tsx`：相关命令 ✅
- `issue/index.ts`：Issue 命令 ✅

**components/FeedbackSurvey/**：
- `useFeedbackSurvey.tsx`：反馈调查 Hook，包含完整触发条件逻辑 ✅
- `useDebouncedDigitInput.ts`：数字输入防抖处理 ✅
- `useSurveyState.tsx`：状态管理 ✅
- `TranscriptSharePrompt.tsx`：转录共享提示 ✅
- `FeedbackSurvey.tsx`、`FeedbackSurveyView.tsx`：UI 组件 ✅

**components/Feedback.tsx**：
- 完整反馈表单实现，包含 `redactSensitiveInfo()` 敏感信息清理（支持 Anthropic API key、AWS、GCP、Authorization header、x-api-key、环境变量等）、`createGitHubIssueUrl()` GitHub URL 生成与截断 ✅

**components/HelpV2/**：
- `HelpV2.tsx`：帮助对话框，标签页切换 ✅
- `General.tsx`、`Commands.tsx`：内容组件 ✅

**services/tips/**：
- `tipRegistry.ts`：提示注册表，50+ 提示，相关性检查 ✅
- `tipScheduler.ts`：提示调度 ✅
- `tipHistory.ts`：历史记录 ✅

**utils/releaseNotes.ts**：
- 发布说明获取与解析 ✅

**发现 B5-help-feedback-01**：help-feedback 子系统无任何专用测试覆盖。FeedbackSurvey 数字输入防抖、冷却期检查、触发概率验证、Feedback 敏感信息清理、HelpV2 标签页切换、Tips 相关性检查、ReleaseNotes 解析均无测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认）。

**发现 B5-help-feedback-02**：`useFrustrationDetection()` 仅占位实现，未激活。spec 中提到的挫折检测功能（如连续修正、负面措辞、错误重试后主动触发调查）未实现。严重度：P3（设计已记录但未实现），置信度：已证实（src/components/FeedbackSurvey/useFrustrationDetection.ts）。

**发现 B5-help-feedback-03**：未发现明显上游 deviance，spec 与源码高度一致。

#### 测试验证

检查 coverage 中提及的测试文件：
- ❌ 无任何 help-feedback 子系统专用测试

#### 隐私与安全边界审查

**敏感信息清理边界**：
- `redactSensitiveInfo()` 覆盖 Anthropic API keys、AWS credentials、GCP keys、Authorization headers、x-api-key headers、常见 API/TOKEN/SECRET/PASSWORD 环境变量 ✅
- 清理在提交前执行，用户可在 consent 阶段预览 ✅

**组织策略控制边界**：
- `isPolicyAllowed('allow_product_feedback')` 检查，组织可禁用 ✅
- 环境变量 `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` 可完全禁用 ✅
- ZDR 组织拒绝提交 ✅

**隐私优先设计**：
- 转录共享默认关闭，需要二次确认 ✅
- 评分仅记录响应类型，默认不共享完整对话 ✅
- `transcriptShareDismissed` 永久拒绝选项 ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`：环境变量匹配 ✅
- `allow_product_feedback`：策略检查匹配 ✅
- `redactSensitiveInfo`、`createGitHubIssueUrl`：函数匹配 ✅
- `tipRegistry`、`releaseNotes`：模块匹配 ✅

#### 证据边界总结

| 模块 | 已验证 | 未验证 |
|------|------|------|
| HelpV2 | 标签页切换、命令列表动态获取 | 窄终端截断场景 |
| FeedbackSurvey | 数字键输入防抖、触发条件检查（会话时间、轮次、冷却期、概率）、transcript prompt 二阶段 | 用户输入冲突真实场景（如输入 `300`） |
| Feedback | 敏感信息清理正则、GitHub URL 截断策略、网络超时处理 | 真实 API 提交成功/失败场景 |
| Tips | 相关性检查、冷却期机制、自定义提示覆盖 | 实际提示显示时机与效果 |
| LogoV2 | Condensed/Full 模式切换、发布说明显示 | 窄终端 Compact 模式 |
| ReleaseNotes | GitHub 变更日志获取、解析、版本比较 | 网络失败 fallback 场景 |

---

### plan-worktree

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-plan-worktree-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/plan-worktree.yaml |
| Manifest 注册 | ✅ | id: plan-worktree, batch: 5, status: draft |
| Coverage 覆盖分组 | 8/8 | plan-tools, worktree-tools, verify-plan-execution, plans-utils, worktree-utils, ultraplan-ccr, plan-mode-utils, constants-tools, commands, plan-mode-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了计划只读约束、计划批准执行闭环、worktree 创建速度、退出安全、状态持久化、未提交变更 fail-closed 保护、Ultraplan 远程支持、teammate 代理支持等核心约束。

✅ **设计理由与备选方案**：9 项关键决策表格化（计划模式只读剥离、计划批准闭环、worktree hook 优先、slug 扁平化、symlink 目录优化、.worktreeinclude 复制、退出 fail-closed、keep/remove 双选项、计划 slug 缓存恢复）详细描述了备选方案和选择理由，包含真实证据位置。

✅ **目标与非目标**：清晰界定了计划模式进入/退出、计划持久化、Ultraplan 支持、teammate 支持、worktree 创建/退出、symlink 优化、未提交变更检查等目标；明确不提供计划版本控制、worktree 实时同步等非目标。

✅ **架构、模块与数据流**：6 个模块设计卡（EnterPlanModeTool、ExitPlanModeV2Tool、VerifyPlanExecutionTool（占位）、EnterWorktreeTool、ExitWorktreeTool、plans.ts、worktree.ts、ultraplan/ccrSession.ts），完整的计划模式流程、worktree 创建/退出流程、暂态 worktree 清理策略。

✅ **证据链覆盖**：完整的权限剥离机制、slug 验证规则、git worktree 创建流程、symlink 优化策略、.worktreeinclude 复制逻辑、未提交变更检查 fail-closed、ExitPlanMode 权限委托、Ultraplan 轮询等证据链已验证。

#### 源码验证

**plan-tools**（src/tools/EnterPlanModeTool/、src/tools/ExitPlanModeTool/）：
- `EnterPlanModeTool.ts`：进入计划模式，权限剥离 ✅
- `ExitPlanModeV2Tool.ts`：退出计划模式，用户批准，teammate 路径，allowedPrompts 仅支持 Bash ✅
- `constants.ts`、`prompt.ts`、`UI.tsx`：配套文件 ✅

**worktree-tools**（src/tools/EnterWorktreeTool/、src/tools/ExitWorktreeTool/）：
- `EnterWorktreeTool.ts`：创建并进入 worktree，slug 验证 ✅
- `ExitWorktreeTool.ts`：退出 worktree，keep/remove 双选项，未提交变更检查 ✅
- `constants.ts`、`prompt.ts`、`UI.tsx`：配套文件 ✅

**verify-plan-execution**（src/tools/VerifyPlanExecutionTool/）：
- 仅 `constants.ts` 占位，工具未实现 ✅

**plans-utils**（src/utils/plans.ts）：
- `getPlanSlug()`：获取/生成 word slug，带重试 ✅
- `getPlanFilePath()`、`getPlan()`：计划文件路径和读取 ✅
- `copyPlanForResume()`：从多种来源恢复计划（文件、file snapshot、tool_use、用户消息、plan_file_reference）✅
- `copyPlanForFork()`：fork 计划 ✅
- `persistFileSnapshotIfRemote()`：远程会话快照 ✅
- `getPlansDirectory()`：计划目录，路径遍历保护 ✅

**worktree-utils**（src/utils/worktree.ts）：
- `validateWorktreeSlug()`：slug 验证，拒绝 . / .. / 绝对路径 ✅
- `flattenSlug()`：/ 替换为 +，避免 git ref D/F 冲突 ✅
- `createWorktreeForSession()`：创建 worktree，先检查 hook，再 git worktree add ✅
- `symlinkDirectories()`：symlink 大目录，配置可设置 ✅
- `copyWorktreeIncludeFiles()`：复制 .worktreeinclude 匹配文件 ✅
- `keepWorktree()`、`cleanupWorktree()`：退出策略 ✅
- `countWorktreeChanges()`：未提交变更检查，fail-closed ✅
- `cleanupStaleAgentWorktrees()`：暂态 worktree 清理（agent-a*、wf_*、bridge-*、job-*），检查 mtime、git status、unpushed commits ✅

**ultraplan-ccr**（src/utils/ultraplan/ccrSession.ts）：
- `ExitPlanModeScanner.ingest()`：扫描事件流 ✅
- `pollForApprovedExitPlanMode()`：轮询远程批准，OAuth 刷新，瞬时网络错误重试 ✅
- `extractApprovedPlan()`、`extractTeleportPlan()`：提取批准计划和 teleport 标记 ✅
- 支持 `executionTarget: 'local' | 'remote'`，teleport 通过拒绝工具结果传输 ✅

**plan-mode-utils**（src/utils/planModeV2.ts、src/utils/worktreeModeEnabled.ts）：
- 计划模式 V2 开关 ✅

**发现 B5-plan-worktree-01**：plan-worktree 子系统仅 2 个小型测试文件（`tests/exitPlanModePrompt.test.ts`、`tests/ultraplanPoll.test.ts`），核心功能无测试覆盖。EnterPlanModeTool、ExitPlanModeTool（完整批准流程）、EnterWorktreeTool、ExitWorktreeTool（未提交变更检查、fail-closed）、plans.ts（slug 生成/恢复/ fork）、worktree.ts（slug 验证、symlink、.worktreeinclude、暂态清理）均无专用测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认）。

**发现 B5-plan-worktree-02**：VerifyPlanExecutionTool 仅占位实现，未完成。spec 中提到的计划执行验证、危险操作检测未实现。严重度：P3（设计已记录但未实现），置信度：已证实（src/tools/VerifyPlanExecutionTool/）。

**发现 B5-plan-worktree-03**：ExitPlanMode allowedPrompts 仅支持 Bash 工具，spec 与源码一致，此为显式设计权衡（平衡便利性与安全）。严重度：P3（设计权衡已记录），置信度：已证实。

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ `tests/exitPlanModePrompt.test.ts`：仅验证 ExitPlanMode schema
- ✅ `tests/ultraplanPoll.test.ts`：仅测试 Ultraplan OAuth 刷新
- ❌ 其余核心功能无测试

#### 隐私与安全边界审查

**计划模式只读边界**：
- `prepareContextForPlanMode()` 剥离危险工具权限 ✅
- 仅允许 Read/Grep/Glob 等只读工具 ✅

**worktree 安全边界**：
- `validateWorktreeSlug()` 拒绝路径遍历、绝对路径、. / .. ✅
- ExitWorktree action=remove 时 `countWorktreeChanges()` 检查未提交变更，fail-closed ✅
- `discard_changes: true` 显式确认才允许删除 ✅
- 仅能退出本会话创建的 worktree ✅
- `cleanupStaleAgentWorktrees()` 检查 git status clean 和无 unpushed commits 才删除 ✅

**权限委托边界**：
- ExitPlanMode allowedPrompts 仅支持 Bash ✅
- 语义化权限需要用户批准 ✅

**Ultraplan 安全边界**：
- OAuth token 刷新机制 ✅
- 瞬时网络错误重试（5 次）✅
- teleport 标记通过拒绝工具结果传输，远程保持在 plan mode ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `EnterPlanMode`、`ExitPlanMode`：工具名匹配 ✅
- `EnterWorktree`、`ExitWorktree`：工具名匹配 ✅
- `planSlug`、`worktreeSlug`：slug 匹配 ✅
- `git worktree add`、`git worktree remove`：git 命令匹配 ✅
- `ultraplan`、`teleport`：远程功能匹配 ✅
- `allowedPrompts`：参数匹配 ✅

#### 证据边界总结

| 模块 | 已验证 | 未验证 |
|------|------|------|
| EnterPlanModeTool | 权限剥离、plan mode 设置、--channels 禁用 | KAIROS 模式完整禁用 |
| ExitPlanModeTool | 本地批准流程、teammate mailbox 路径、allowedPrompts Bash 限制 | 实际批准 UI 完整流、语义化权限应用 |
| EnterWorktreeTool | slug 验证、git worktree 创建、symlink 优化、.worktreeinclude 复制 | hook 路径完整流、sparse checkout |
| ExitWorktreeTool | 未提交变更检查、fail-closed、keep/remove 双选项 | tmux session 清理、git worktree remove 真实失败场景 |
| plans.ts | slug 生成/缓存、多来源恢复、fork、路径遍历保护 | 并发 slug 生成竞态 |
| worktree.ts | slug 验证扁平化、symlink 目录、.worktreeinclude 复制、暂态清理模式匹配 | 暂态 worktree 真实泄漏场景、.worktreeinclude 目录展开边界 |
| ultraplan/ccrSession.ts | 事件流扫描、approved/teleport/rejected 检测、OAuth 刷新、瞬时网络错误重试 | 真实远程会话完整流、多用户并发批准 |

---

### review-analysis

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-review-analysis-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/review-analysis.yaml |
| Manifest 注册 | ✅ | id: review-analysis, batch: 5, status: draft |
| Coverage 覆盖分组 | 5/5 | review-artifact-tool, ctx-inspect-tool, insights-command, context-analysis, review-test |

#### 文档完整性审查

✅ **问题与约束**：准确描述了审查输入与 diff 范围、模型审查协议、Artifact 权限与证据复用、自动修复边界、洞察/上下文分析、错误与失败处理等核心约束。

✅ **设计理由与备选方案**：6 项关键决策（ReviewArtifact 独立只读代理、artifact_path/content 二选一、insights 两级缓存、facet 提取 JSON 直接输出、sessionMeta 丰富统计提取、CtxInspect 仅返回 JSON）详细描述了备选方案和选择理由，包含真实证据位置。

✅ **目标与非目标**：清晰界定了 ReviewArtifact 独立审查、CtxInspect 上下文检查、insights 会话分析、缓存策略、错误处理等目标；明确不跨会话共享审查代理状态、不持久化 CtxInspect 结果、不无限期保留缓存、不支持实时流式洞察、不支持分布式分析、不支持中断恢复等非目标。

✅ **架构、模块与数据流**：3 个模块设计卡（ReviewArtifactTool、CtxInspectTool、sessionMeta、facet 提取、detectMultiClauding），完整的审查流程、洞察分析流程、多 Claude 检测滑动窗口算法、缓存原子写入策略。

✅ **证据链覆盖**：完整的独立代理只读工具限制、JSON 提取策略（找第一个 { 和最后一个 }）、1MB 大小限制、权限复用 FileReadTool、两级缓存（sessionMeta 原子写入、facets 直接写入）、并发限制（facet 50、会话 200）等证据链已验证。

#### 源码验证

**review-artifact-tool**（src/tools/ReviewArtifactTool/）：
- `ReviewArtifactTool.ts`：完整实现，`defaultReviewer()` 启动独立 GENERAL_PURPOSE_AGENT，仅允许 Read/Grep/Glob ✅
- `validateInput()`：artifact_path/content 二选一检查 ✅
- `checkPermissions()`：复用 FileReadTool 权限检查 ✅
- `readArtifact()`：读取文件或使用 content，1MB 限制 ✅
- `parseReviewerOutput()`：找第一个 { 和最后一个 }，JSON.parse + zod 验证，status 默认 unverified ✅
- `reviewArtifact()`：构建 prompt，调用 runner ✅

**ctx-inspect-tool**（src/tools/CtxInspectTool/）：
- `CtxInspectTool.ts`：完整实现，`collectContextData()` 获取上下文数据，`formatContextInspection()` 序列化为 JSON，不含 gridRows ✅
- 输出包含 model、totalTokens、maxTokens、rawMaxTokens、percentage、categories（含 deferred）、messageBreakdown、apiUsage、contextCollapse 统计 ✅

**insights-command**（src/commands/insights.ts、src/commands/insights/sessionMeta.ts）：
- `sessionMeta.ts`：`extractToolStats()` 提取丰富统计（工具计数、语言、git、token、用户中断、响应时间、工具错误、task agent/MCP/web search/web fetch 使用、行数变更、文件修改、消息时间分布）✅
- `logToSessionMeta()`：转换为完整 sessionMeta ✅
- `deduplicateSessionBranches()`：去重会话分支（保留用户消息最多的）✅
- `saveSessionMeta()`：原子写入（临时文件 + rename），权限 0o600 ✅
- `loadCachedSessionMeta()`：加载缓存，`isValidSessionMeta()` 验证 ✅
- `insights.ts`：`extractFacetsFromAPI()` 提取 facet，调用 Opus 模型，JSON 直接输出，失败返回 null ✅
- `loadCachedFacets()`、`saveFacets()`：facet 缓存，直接写入非原子 ✅
- `detectMultiClauding()`：多 Claude 检测，30 分钟滑动窗口，找 session A → session B → session A 模式 ✅
- 并发控制：facet 提取 50 并发，会话加载 200 限制 ✅
- Promise.allSettled 处理部分失败 ✅
- ant-only：远程 homespace 会话收集、S3 上传 ✅

**发现 B5-review-analysis-01**：review-analysis 子系统仅 1 个测试文件（`tests/reviewArtifact.test.ts`），其余核心功能无测试覆盖。CtxInspectTool、insights 命令完整流、sessionMeta 提取、facet 提取、detectMultiClauding、两级缓存均无专用测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认）。

**发现 B5-review-analysis-02**：facet 缓存直接写入非原子，与 sessionMeta 原子写入不一致。进程崩溃时可能留下半写 facet 缓存文件。严重度：P3（低概率，可重新提取），置信度：已证实（对比 src/commands/insights/sessionMeta.ts:476-494 和 src/commands/insights.ts:2352-2360）。

**发现 B5-review-analysis-03**：insights 无缓存过期/清理机制，长期使用可能积累大量旧缓存文件。严重度：P3（磁盘空间通常足够），置信度：已证实（代码中无清理逻辑）。

**发现 B5-review-analysis-04**：未发现明显上游 deviance，spec 与源码高度一致。

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ `tests/reviewArtifact.test.ts`：ReviewArtifactTool 测试，覆盖 validateInput 互斥检查、defaultReviewer 调用、parseReviewerOutput JSON 提取、大小限制
- ❌ 其余核心功能无测试

#### 隐私与安全边界审查

**ReviewArtifact 安全边界**：
- 独立代理仅授予 Read/Grep/Glob 只读工具 ✅
- agent 系统 prompt 明确要求 "Do not modify files" ✅
- artifact_path 复用 FileReadTool 权限检查 ✅
- 1MB 大小限制防止 OOM ✅

**CtxInspect 安全边界**：
- 仅返回上下文元数据，不包含实际对话内容 ✅
- 无权限检查，无副作用 ✅

**insights 缓存安全边界**：
- sessionMeta 原子写入（临时文件 + rename）防止半写 ✅
- 缓存文件权限 0o600 仅用户可读 ✅
- 缓存目录权限 0o700 ✅
- 排除 /insights 自身元会话防止递归 ✅

**多 Claude 检测边界**：
- 仅检查时间戳模式，不访问会话内容 ✅
- 30 分钟窗口硬编码，无用户配置 ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `ReviewArtifact`：工具名匹配 ✅
- `CtxInspect`：工具名匹配 ✅
- `insights`：命令名匹配 ✅
- `sessionMeta`、`facet`：模块匹配 ✅
- `multiClaud`：检测匹配 ✅

#### 证据边界总结

| 模块 | 已验证 | 未验证 |
|------|------|------|
| ReviewArtifactTool | 独立代理启动、只读工具限制、JSON 提取策略、1MB 限制、权限复用 | 真实审查代理 8 回合完整流、模型输出 JSON 格式偏差处理 |
| CtxInspectTool | 数据收集、JSON 格式化、不含 gridRows | 真实上下文折叠场景数据准确性 |
| insights sessionMeta | 丰富统计提取、原子写入、缓存验证 | 工具错误分类完整覆盖、响应时间窗口边界 |
| insights facet 提取 | JSON 直接输出、Opus 模型调用、并发 50 限制、失败不重试 | 模型输出格式变化、长会话摘要准确性 |
| detectMultiClauding | 30 分钟滑动窗口、A→B→A 模式检测、去重会话对 | 长会话多重叠场景、边界时间戳处理 |
| insights 缓存 | 两级缓存结构、sessionMeta 原子写入、facet 直接写入 | 缓存失效策略、大量旧缓存积累 |

---

### scheduling

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-scheduling-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/scheduling.yaml |
| Manifest 注册 | ✅ | id: scheduling, batch: 5, status: draft |
| Coverage 覆盖分组 | 22/22 | cron-core, cron-tasks, cron-scheduler, cron-lock, cron-notification, cron-jitter-config, jobs-schema, jobs-supervisor, jobs-state, jobs-classifier, jobs-operations, jobs-discovery, proactive-core, proactive-hooks, cron-create-tool, cron-delete-tool, cron-list-tool, cron-tool-prompt, sleep-tool, remote-trigger-tool, cron-lifecycle-tests, template-jobs-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了 cron 定时任务、模板作业、主动唤醒的核心需求和约束条件（5字段cron、时区、跨会话协调、默认关闭等）。

✅ **设计理由与备选方案**：10项关键决策表格化展示，包含真实证据位置：
- cron任务持久化到`.claude/scheduled_tasks.json`
- PID锁文件防止多会话重复触发
- cron抖动（Jitter）避峰
- 模板作业双进程监督者模式
- 主动唤醒功能开关设计
- SleepTool仅在proactive激活时可用
- 一次性错过任务启动时询问而非自动触发
- 周期性任务7天后自动过期（除非permanent）
- 会话级任务不持久化，仅存内存

✅ **目标与非目标**：清晰界定了cron、模板作业、主动唤醒的目标，明确不支持高级cron语法（L/W/?/名称别名）、跨机器调度、优先级队列等。

✅ **架构、模块与数据流**：11个模块设计卡（CronLock、CronTasks、CronScheduler、CronNotification、JobState、JobSupervisor、JobClassifier、Proactive、SleepTool、RemoteTrigger），完整的cron调度主循环、模板作业监督者流程、proactive状态流转。

✅ **证据链覆盖**：完整的调度锁获取/释放流程、cron任务创建/触发/清理流程、模板作业进程管理流程、proactive状态管理流程、错过任务检测流程已验证。

#### 源码验证

**cron-core** (src/utils/cron.ts)：
- 5字段标准cron表达式解析，支持通配符、N、step (*/N)、范围(N-M)、列表(N,M,...)
- 不支持L/W/?/名称别名
- 时区使用本地时区
- `parseCronExpression`、`computeNextCronRun`、`cronToHuman`完整实现 ✅

**cron-tasks** (src/utils/cronTasks.ts)：
- 任务持久化到`.claude/scheduled_tasks.json`，格式`{tasks: [...]}`
- 任务ID为8字符UUID片段
- 支持durable=false会话级任务（内存存储）
- 抖动计算：周期性任务使用frac*interval cap 15分钟；一次性任务在mod 30分钟时提前0-90秒
- 确定性抖动基于taskId哈希
- `addCronTask`、`removeCronTasks`、`listAllCronTasks`、`markCronTasksFired`完整实现 ✅

**cron-scheduler** (src/utils/cronScheduler.ts)：
- 秒级轮询check()循环
- PID锁持有者处理文件任务
- inFlight防止重复触发
- nextFireAt锚定到lastFiredAt/createdAt而非现在
- 错过任务仅在初始加载时检测一次性任务
- 周期性任务7天自动过期（可配置）
- `createCronScheduler`、`isRecurringTaskAged`完整实现 ✅

**cron-lock** (src/utils/cronTasksLock.ts)：
- `O_EXCL`原子创建锁文件
- PID存活检测（`/proc` on Linux, `ps` on macOS/BSD）
- 锁文件包含sessionId、pid、acquiredAt
- 陈旧锁自动恢复
- 退出时自动清理锁
- `tryAcquireSchedulerLock`、`releaseSchedulerLock`完整实现 ✅

**cron-notification** (src/utils/cronNotification.ts)：
- `buildMissedTaskNotification`格式化错过任务提示
- 使用动态长度反引号围栏防止注入
- 错过任务询问后立即删除 ✅

**jobs-state** (src/jobs/state.ts)：
- 作业目录隔离在`~/.claude/jobs/<uuid>`
- `assertSecureJobDirectory`安全检查（目录在jobs root内、非symlink、权限0o700）
- `writeJsonAtomic`原子写入（临时文件+rename+fsync）
- `withJobLock`使用proper-lockfile（stale 60s, retries 40）
- PID复用防护：`getProcessStartToken`获取进程启动时间
- `reconcileJob`检测崩溃supervisor并标记失败
- 完整的transcript JSONL追加机制 ✅

**jobs-supervisor** (src/jobs/supervisor.ts)：
- `spawnSupervisorProcess` detached启动监督者
- 监督者spawn子进程执行实际任务
- 监控stdout/stderr/exit
- 所有事件追加到transcript
- `mergeProcessOutcome`结合exit code和分类器结果
- 双进程设计保证监控可靠性 ✅

**proactive-core** (src/proactive/index.ts)：
- `activateProactive`仅接受'command'源
- 状态管理：active/paused/contextBlocked
- `subscribeToProactiveChanges`通知机制
- 状态变化时`nextTickAt`自动清空
- 仅内存存储，不持久化 ✅

**sleep-tool** (src/tools/SleepTool/SleepTool.ts)：
- `isEnabled()`检查`isProactiveActive()`
- 支持`duration`和`duration_ms`（已弃用）
- 可中断sleep实现
- 最小/最大sleep duration配置 ✅

**cron-create-tool** (src/tools/ScheduleCronTool/CronCreateTool.ts)：
- `MAX_JOBS=50`限制
- cron表达式验证
- 队友agent不支持durable cron
- `setScheduledTasksEnabled(true)`自动启用调度器 ✅

**发现 B5-scheduling-01**：scheduling子系统核心测试不完整，仅有cron-lifecycle-tests覆盖基本生命周期（一次性任务触发、周期性任务调度、锁竞争接管），缺少jobs-classifier、proactive、sleep-tool、remote-trigger-tool的专用测试。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/目录扫描确认）。

**发现 B5-scheduling-02**：错过任务检测仅在初始加载时进行，会话运行期间错过的任务（如电脑休眠唤醒后）静默立即触发，不询问用户。spec已明确记录此权衡，无功能问题。严重度：P3（文档已记录，无功能问题），置信度：已证实（spec与源码一致）。

**发现 B5-scheduling-03**：jobs-classifier模块在spec中提及但未详细展开设计说明，源码实现完整但测试仅template-jobs-tests覆盖部分场景。严重度：P3（可维护性），置信度：已证实。

**发现 B5-scheduling-04**：cron锁的probe interval硬编码为5000ms，可配置性更好但非必需。spec已记录，无功能问题。严重度：P3（文档已记录，无功能问题），置信度：已证实（spec与源码一致）。

**发现 B5-scheduling-05**：proactive功能仅提供状态管理框架，没有默认行为或示例实现。这是显式设计权衡（安全优先，用户显式控制）。严重度：P3（设计权衡已记录），置信度：已证实（spec与源码一致）。

**发现 B5-scheduling-06**：`.claude/scheduled_tasks.json`无显式权限设置，依赖目录umask。建议创建时设置为0o600。严重度：P3（低风险，可改进），置信度：已证实（源码检查）。

#### 测试验证

检查coverage中提及的测试文件：
- ✅ `tests/cronLifecycle.test.ts`：覆盖一次性任务触发、周期性任务调度、锁竞争接管
- ✅ `tests/templateJobs.test.ts`：存在但未详细验证
- ❌ 无 proactive-core专用测试
- ❌ 无 sleep-tool专用测试
- ❌ 无 remote-trigger-tool专用测试
- ❌ 无 jobs-classifier完整场景测试
- ❌ 无 cron-notification注入防护测试

#### 隐私与安全边界审查

**cron任务安全边界**：
- 任务存储在项目目录`.claude/scheduled_tasks.json`
- 无权限检查（同目录多用户场景需注意）
- 错过任务提示使用动态长度反引号围栏防止prompt注入 ✅

**模板作业安全边界**：
- 作业目录在`~/.claude/jobs/<uuid>`，权限0o700
- `assertSecureJobDirectory`防止目录穿越和symlink攻击
- `writeJsonAtomic`原子写入防止崩溃损坏
- proper-lockfile防止并发操作
- PID+startToken双重验证防止PID复用攻击 ✅

**proactive安全边界**：
- 默认关闭，需显式`activateProactive('command')`启用
- 不持久化，会话结束状态丢失
- SleepTool仅在proactive激活时可用，防止普通交互误用 ✅

#### 上游证据

上游CLI strings已提取，关键匹配：
- `scheduled_tasks.json`、`scheduled_tasks.lock`文件名匹配 ✅
- `CronCreate`、`CronDelete`、`CronList`工具名匹配 ✅
- `SleepTool`工具名匹配 ✅
- `RemoteTrigger`工具名匹配 ✅
- `template-job-supervisor`命令匹配 ✅
- cron抖动相关配置匹配 ✅
- 周期性任务过期相关逻辑匹配 ✅

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec完整性 | ✅ 完整，10项决策，11个模块设计卡，完整生命周期证据链 | ⚠️ jobs-classifier模块设计说明较简略 |
| 源码一致性 | ✅ 所有22个coverage分组源码与spec高度对齐 | ⚠️ 无明显上游偏离 |
| 测试覆盖 | ⚠️ 仅有cronLifecycle.test.ts和templateJobs.test.ts两个测试文件，核心模块测试不足 | ❌ proactive、sleep-tool、remote-trigger-tool、jobs-classifier无专用测试 |
| 官方文档 | ❓ 未访问 | ⚠️ 基于现有spec |
| 上游CLI | ✅ 已提取strings，关键术语匹配 | ⚠️ 仅静态证据 |

---

### task-system

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-13-task-system-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/task-system.yaml |
| Manifest 注册 | ✅ | id: task-system, batch: 5, status: draft |
| 审计状态 | ⏸️ 待审计 | 本次仅审计 agent-swarms，task-system 保持 open |

---

### workflow

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-workflow-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/workflow.yaml |
| Manifest 注册 | ✅ | id: workflow, batch: 5, status: draft |
| 审计状态 | ⏸️ 待审计 | 本次仅审计 agent-swarms，workflow 保持 open |

---

## 发现登记

| ID | 主责 | 关联 | 类别 | 严重度 | 问题陈述 | 源码证据 | 上游证据 | 测试证据 | 影响 | 修订建议 | 置信度 | 验证边界 | 状态 |
|----|------|------|------|--------|----------|------|------|------|--------|--------|------|
| B5-agent-swarms-01 | agent-swarms | agent-tool-core | 测试缺口 | P2 | AgentTool 核心执行路径（4 模式：sync/async/teammate/remote）、fork 子代理、worktree 隔离均无专用测试 | src/tools/AgentTool/AgentTool.tsx, src/tools/AgentTool/forkSubagent.ts | ✅ strings 匹配 | ❌ 无测试 | 中（功能正常但无回归保护） | 添加 AgentTool 完整路径测试、fork 缓存命中测试、worktree 隔离测试 | 已证实 | 完整源码审查 | open |
| B5-agent-swarms-02 | agent-swarms | team-tools | 测试缺口 | P2 | TeamCreateTool/TeamDeleteTool/SendMessageTool 无专用测试 | src/tools/TeamCreateTool/TeamCreateTool.ts, src/tools/TeamDeleteTool/TeamDeleteTool.ts, src/tools/SendMessageTool/SendMessageTool.ts | ✅ strings 匹配 | ❌ 无测试 | 中（功能正常但无回归保护） | 添加团队创建/解散测试、消息路由测试（本地 agent/团队成员/broadcast） | 已证实 | 完整源码审查 | open |
| B5-agent-swarms-03 | agent-swarms | swarm-mailbox | 测试缺口 | P2 | Mailbox 并发与锁机制无对抗性测试 | src/utils/teammateMailbox.ts | ✅ strings 匹配 | ❌ 无测试 | 中（功能正常但无回归保护） | 添加多进程并发写 inbox 测试、锁超时/重试测试 | 已证实 | 完整源码审查 | open |
| B5-agent-swarms-04 | agent-swarms | swarm-permission-sync | 工程改进 | P3 | 权限同步新旧路径并存增加复杂度 | src/utils/swarm/permissionSync.ts | ⚠️ 未区分 | ❌ 无测试 | 低（可维护性） | 移除旧路径 pending/resolved 文件，统一使用 mailbox 协议 | 已证实 | 完整源码审查 | open |
| B5-agent-swarms-05 | agent-swarms | agent-tool-core | 设计权衡 | P3 | worktree 清理依赖 hasWorktreeChanges()，未跟踪未跟踪文件可能导致意外保留 | src/tools/AgentTool/AgentTool.tsx, src/utils/worktree.ts | ✅ strings 匹配 | ❌ 无测试 | 低（文档已记录，无功能问题） | 无需变更，spec 已明确记录此权衡 | 已证实 | spec 与源码一致 | open |
| B5-agent-swarms-06 | agent-swarms | swarm-team-state | 测试缺口 | P3 | isActive 状态管理（崩溃场景）无测试 | src/utils/swarm/teamHelpers.ts | ✅ strings 匹配 | ❌ 无测试 | 低（测试缺口） | 添加 in-process worker 崩溃场景测试、跨进程 worker 崩溃检测测试 | 已证实 | 完整源码审查 | open |
| B5-agent-swarms-07 | agent-swarms | swarm-permission-sync | 设计权衡 | P3 | mailbox 消息无超时机制，worker 可能永久阻塞 | src/utils/swarm/permissionSync.ts | ✅ strings 匹配 | ❌ 无测试 | 低（文档已记录，无功能问题） | 无需变更，spec 已明确记录此权衡 | 已证实 | spec 与源码一致 | open |
| B5-agent-swarms-08 | agent-swarms | swarm-team-state | 实现改进 | P2 | TeamFile 写入无原子 rename 保护，崩溃时可能损坏文件 | src/utils/swarm/teamHelpers.ts:156-163 | ✅ strings 匹配 | ❌ 无测试 | 中（低概率但高影响） | 改为先写临时文件再 rename（`{path}.tmp` → `{path}`） | 已证实 | 完整源码审查 | open |
| B5-agent-swarms-09 | agent-swarms | swarm-team-state | 安全改进 | P2 | TeamFile 原子写入缺失是安全边界潜在风险（同 B5-agent-swarms-08） | src/utils/swarm/teamHelpers.ts:156-163 | ✅ strings 匹配 | ❌ 无测试 | 中（低概率但高影响） | 实施临时文件 rename 原子写入 | 已证实 | 完整源码审查 | open |
| B5-help-feedback-01 | help-feedback | additional-files, commands | 测试缺口 | P2 | help-feedback 子系统无任何专用测试覆盖。FeedbackSurvey 数字输入防抖、冷却期检查、触发概率验证、Feedback 敏感信息清理、HelpV2 标签页切换、Tips 相关性检查、ReleaseNotes 解析均无测试 | src/components/FeedbackSurvey/, src/components/Feedback.tsx, src/components/HelpV2/, src/services/tips/, src/utils/releaseNotes.ts | ✅ strings 匹配 | ❌ 无测试 | 中（功能正常但无回归保护） | 添加 FeedbackSurvey 数字输入防抖测试、冷却期逻辑测试、触发概率验证、Feedback 敏感信息清理正则测试、HelpV2 标签页切换测试、Tips 相关性检查测试、ReleaseNotes 解析测试 | 已证实 | 完整源码审查 | open |
| B5-help-feedback-02 | help-feedback | additional-files | 功能未实现 | P3 | `useFrustrationDetection()` 仅占位实现，未激活。spec 中提到的挫折检测功能（如连续修正、负面措辞、错误重试后主动触发调查）未实现 | src/components/FeedbackSurvey/useFrustrationDetection.ts | ✅ strings 匹配 | ❌ 无测试 | 低（设计已记录但未实现） | 实现挫折检测逻辑（连续修正、负面措辞、错误重试检测），主动触发调查 | 已证实 | 完整源码审查 | open |
| B5-plan-worktree-01 | plan-worktree | plan-tools, worktree-tools, plans-utils, worktree-utils, ultraplan-ccr | 测试缺口 | P2 | plan-worktree 子系统仅 2 个小型测试文件（schema 验证、OAuth 刷新），核心功能无测试覆盖。EnterPlanModeTool、ExitPlanModeTool（完整批准流程）、EnterWorktreeTool、ExitWorktreeTool（未提交变更检查、fail-closed）、plans.ts（slug 生成/恢复/fork）、worktree.ts（slug 验证、symlink、.worktreeinclude、暂态清理）均无专用测试 | src/tools/EnterPlanModeTool/, src/tools/ExitPlanModeTool/, src/tools/EnterWorktreeTool/, src/tools/ExitWorktreeTool/, src/utils/plans.ts, src/utils/worktree.ts, src/utils/ultraplan/ccrSession.ts | ✅ strings 匹配 | ⚠️ 仅 2 个小型测试 | 中（功能正常但无回归保护） | 添加 EnterPlanMode 权限剥离测试、ExitPlanMode 批准流程测试、EnterWorktree slug 验证测试、ExitWorktree 未提交变更检查测试、plans.ts slug 生成/恢复/fork 测试、worktree.ts symlink/.worktreeinclude/暂态清理测试、ultraplan ccr 轮询测试 | 已证实 | 完整源码审查 | open |
| B5-plan-worktree-02 | plan-worktree | verify-plan-execution | 功能未实现 | P3 | VerifyPlanExecutionTool 仅占位实现，未完成。spec 中提到的计划执行验证、危险操作检测未实现 | src/tools/VerifyPlanExecutionTool/constants.ts | ✅ strings 匹配 | ❌ 无测试 | 低（设计已记录但未实现） | 实现 VerifyPlanExecutionTool，验证计划步骤是否完成，检测计划外危险操作 | 已证实 | 完整源码审查 | open |
| B5-plan-worktree-03 | plan-worktree | plan-tools | 设计权衡 | P3 | ExitPlanMode allowedPrompts 仅支持 Bash 工具，此为显式设计权衡（平衡便利性与安全），spec 与源码一致 | src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:64-73 | ✅ strings 匹配 | ❌ 无测试 | 低（设计权衡已记录） | 无需变更，spec 已明确记录此权衡 | 已证实 | spec 与源码一致 | open |
| B5-review-analysis-01 | review-analysis | review-artifact-tool, ctx-inspect-tool, insights-command, context-analysis | 测试缺口 | P2 | review-analysis 子系统仅 1 个测试文件（ReviewArtifact 基础测试），其余核心功能无测试覆盖。CtxInspectTool、insights 命令完整流、sessionMeta 提取、facet 提取、detectMultiClauding、两级缓存均无专用测试 | src/tools/CtxInspectTool/, src/commands/insights.ts, src/commands/insights/sessionMeta.ts | ✅ strings 匹配 | ⚠️ 仅 1 个测试文件 | 中（功能正常但无回归保护） | 添加 CtxInspectTool 输出验证测试、insights sessionMeta 提取测试、facet 提取测试、detectMultiClauding 算法测试、两级缓存读写测试 | 已证实 | 完整源码审查 | open |
| B5-review-analysis-02 | review-analysis | insights-command | 实现改进 | P3 | facet 缓存直接写入非原子，与 sessionMeta 原子写入不一致。进程崩溃时可能留下半写 facet 缓存文件 | src/commands/insights.ts:2352-2360 | ✅ strings 匹配 | ❌ 无测试 | 低（低概率，可重新提取） | facet 缓存也使用临时文件 + rename 原子写入，保持与 sessionMeta 一致 | 已证实 | 完整源码审查 | open |
| B5-review-analysis-03 | review-analysis | insights-command | 工程改进 | P3 | insights 无缓存过期/清理机制，长期使用可能积累大量旧缓存文件 | src/commands/insights.ts, src/commands/insights/sessionMeta.ts | ✅ strings 匹配 | ❌ 无测试 | 低（磁盘空间通常足够） | 实现缓存过期机制（如保留最近 90 天），或提供 /insights --clean 命令手动清理 | 已证实 | 完整源码审查 | open |
| B5-scheduling-01 | scheduling | cron-lifecycle-tests, template-jobs-tests | 测试缺口 | P2 | scheduling子系统核心测试不完整，仅有cron-lifecycle-tests覆盖基本生命周期，缺少jobs-classifier、proactive、sleep-tool、remote-trigger-tool的专用测试 | src/proactive/index.ts, src/tools/SleepTool/SleepTool.ts, src/tools/RemoteTriggerTool/RemoteTriggerTool.ts, src/jobs/classifier.ts | ✅ strings 匹配 | ⚠️ 仅2个测试文件 | 中（功能正常但无回归保护） | 添加proactive状态管理测试、sleep-tool启用/禁用测试、remote-trigger工具调用测试、jobs-classifier分类结果验证测试 | 已证实 | 完整源码审查 | open |
| B5-scheduling-02 | scheduling | cron-scheduler | 设计权衡 | P3 | 错过任务检测仅在初始加载时进行，会话运行期间错过的任务（如电脑休眠唤醒后）静默立即触发，不询问用户。spec已明确记录此权衡 | src/utils/cronScheduler.ts:201-234 | ✅ strings 匹配 | ❌ 无测试 | 低（文档已记录，无功能问题） | 无需变更，spec已明确记录此权衡 | 已证实 | spec与源码一致 | open |
| B5-scheduling-03 | scheduling | jobs-classifier | 可维护性 | P3 | jobs-classifier模块在spec中提及但未详细展开设计说明，源码实现完整但测试仅template-jobs-tests覆盖部分场景 | src/jobs/classifier.ts | ✅ strings 匹配 | ⚠️ 仅部分测试 | 低（可维护性） | 补充jobs-classifier模块设计说明，添加完整场景测试 | 已证实 | 完整源码审查 | open |
| B5-scheduling-04 | scheduling | cron-lock | 设计权衡 | P3 | cron锁的probe interval硬编码为5000ms，可配置性更好但非必需。spec已记录，无功能问题 | src/utils/cronTasksLock.ts | ✅ strings 匹配 | ❌ 无测试 | 低（文档已记录，无功能问题） | 无需变更，spec已明确记录此权衡 | 已证实 | spec与源码一致 | open |
| B5-scheduling-05 | scheduling | proactive-core | 设计权衡 | P3 | proactive功能仅提供状态管理框架，没有默认行为或示例实现。这是显式设计权衡（安全优先，用户显式控制） | src/proactive/index.ts | ✅ strings 匹配 | ❌ 无测试 | 低（设计权衡已记录） | 无需变更，spec已明确记录此权衡 | 已证实 | spec与源码一致 | open |
| B5-scheduling-06 | scheduling | cron-tasks | 安全改进 | P3 | `.claude/scheduled_tasks.json`无显式权限设置，依赖目录umask。建议创建时设置为0o600 | src/utils/cronTasks.ts:165-182 | ✅ strings 匹配 | ❌ 无测试 | 低（低风险，可改进） | 在writeCronTasks中添加显式权限设置为0o600 | 已证实 | 完整源码审查 | open |

---

## 证据边界

### agent-swarms 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| agent-tool-core | AgentTool 4 路径执行、fork 隐式子代理、worktree 隔离可选、feature gate 控制 | 真实多代理并发执行、远程 agent 路径 |
| agent-memory | agentMemorySnapshot 完整测试覆盖、快照初始化/验证/合并/回滚/删除 | agent 编辑器 UI 完整流、向导流程 |
| team-tools | TeamCreateTool 团队创建与唯一名称生成、TeamDeleteTool 活跃成员检查 | 实际团队解散流程、跨会话团队恢复 |
| swarm-mailbox | mailbox 文件结构、lockfile 锁机制、消息 append 追加、已读标记 | 多进程并发竞态、高负载消息风暴 |
| swarm-team-state | TeamFile 完整结构、读写 API、成员管理 | 原子写入改进前的崩溃场景 |
| swarm-permission-sync | 双路径设计（in-process UI bridge + mailbox）、权限请求/响应协议 | 旧路径迁移场景、权限请求超时场景 |
| swarm-in-process-runner | in-process worker 执行器、leader permission bridge | worker 崩溃恢复、权限同步竞态 |
| swarm-backends | 后端类型定义、registry 注册、多后端支持 | tmux/iTerm2 实际执行、跨平台测试 |
| swarm-layout-reconnection | 布局管理、颜色分配、重连逻辑 | 实际重连场景、teammate 视图切换 |
| coordinator | coordinator mode 开关、系统提示注入、worker 工具限制 | 完整 coordinator 协调流程、多 worker 并行与结果聚合 |

---

### help-feedback 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| HelpV2 | 标签页切换、命令列表动态获取 | 窄终端截断场景 |
| FeedbackSurvey | 数字键输入防抖、触发条件检查（会话时间、轮次、冷却期、概率）、transcript prompt 二阶段 | 用户输入冲突真实场景（如输入 `300`） |
| Feedback | 敏感信息清理正则、GitHub URL 截断策略、网络超时处理 | 真实 API 提交成功/失败场景 |
| Tips | 相关性检查、冷却期机制、自定义提示覆盖 | 实际提示显示时机与效果 |
| LogoV2 | Condensed/Full 模式切换、发布说明显示 | 窄终端 Compact 模式 |
| ReleaseNotes | GitHub 变更日志获取、解析、版本比较 | 网络失败 fallback 场景 |

---

### plan-worktree 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| EnterPlanModeTool | 权限剥离、plan mode 设置、--channels 禁用 | KAIROS 模式完整禁用 |
| ExitPlanModeTool | 本地批准流程、teammate mailbox 路径、allowedPrompts Bash 限制 | 实际批准 UI 完整流、语义化权限应用 |
| EnterWorktreeTool | slug 验证、git worktree 创建、symlink 优化、.worktreeinclude 复制 | hook 路径完整流、sparse checkout |
| ExitWorktreeTool | 未提交变更检查、fail-closed、keep/remove 双选项 | tmux session 清理、git worktree remove 真实失败场景 |
| plans.ts | slug 生成/缓存、多来源恢复、fork、路径遍历保护 | 并发 slug 生成竞态 |
| worktree.ts | slug 验证扁平化、symlink 目录、.worktreeinclude 复制、暂态清理模式匹配 | 暂态 worktree 真实泄漏场景、.worktreeinclude 目录展开边界 |
| ultraplan/ccrSession.ts | 事件流扫描、approved/teleport/rejected 检测、OAuth 刷新、瞬时网络错误重试 | 真实远程会话完整流、多用户并发批准 |

---

### review-analysis 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| ReviewArtifactTool | 独立代理启动、只读工具限制、JSON 提取策略、1MB 限制、权限复用 | 真实审查代理 8 回合完整流、模型输出 JSON 格式偏差处理 |
| CtxInspectTool | 数据收集、JSON 格式化、不含 gridRows | 真实上下文折叠场景数据准确性 |
| insights sessionMeta | 丰富统计提取、原子写入、缓存验证 | 工具错误分类完整覆盖、响应时间窗口边界 |
| insights facet 提取 | JSON 直接输出、Opus 模型调用、并发 50 限制、失败不重试 | 模型输出格式变化、长会话摘要准确性 |
| detectMultiClauding | 30 分钟滑动窗口、A→B→A 模式检测、去重会话对 | 长会话多重叠场景、边界时间戳处理 |
| insights 缓存 | 两级缓存结构、sessionMeta 原子写入、facet 直接写入 | 缓存失效策略、大量旧缓存积累 |

---

### scheduling 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| cron-core | 5字段标准cron解析、本地时区、不支持L/W/?/名称别名 | 极端边界cron表达式处理 |
| cron-tasks | 任务持久化格式、8字符UUID、durable=false会话任务、确定性抖动、7天过期 | 抖动真实避峰效果验证 |
| cron-scheduler | 秒级轮询、锁持有者处理文件任务、inFlight防重复、nextFireAt锚定策略 | 真实长周期调度稳定性 |
| cron-lock | O_EXCL原子创建、PID存活检测、陈旧锁恢复、退出清理 | 多进程高并发锁竞争 |
| cron-notification | 错过任务提示格式化、动态反引号围栏防注入 | 真实注入攻击测试 |
| jobs-state | 作业目录隔离、安全检查、原子写入、proper-lockfile、PID+startToken防护 | 真实PID复用场景测试 |
| jobs-supervisor | detached启动、子进程监控、transcript记录、结果合并 | 真实worker崩溃恢复场景 |
| proactive-core | 仅'command'源激活、状态管理、subscribe通知、不持久化 | 真实proactive agent集成 |
| sleep-tool | 仅proactive激活时可用、可中断sleep、配置限制 | 长时间sleep中断测试 |
| cron-create-tool | MAX_JOBS=50限制、cron验证、teammate限制、自动启用调度器 | 真实用户使用场景测试 |

---

### Batch 5 总体结论

✅ **5 个子系统 spec 质量优秀**：agent-swarms、help-feedback、plan-worktree、review-analysis、scheduling 文档完整性高，关键决策表格化，模块设计卡完整，生命周期证据链清晰。

✅ **5 个子系统实现一致性强**：所有 coverage 分组源码与 spec 高度对齐，关键机制与文档完全一致，安全边界设计周全。

✅ **无上游 deviance**：未发现与上游 CLI 明显不一致的实现，spec 与源码高度匹配。

⚠️ **测试覆盖严重不足**：仅 `agentMemorySnapshot.test.ts`（agent-swarms）、`tests/reviewArtifact.test.ts`（review-analysis）、`tests/exitPlanModePrompt.test.ts`/`tests/ultraplanPoll.test.ts`（plan-worktree）、`tests/cronLifecycle.test.ts`/`tests/templateJobs.test.ts`（scheduling）这 6 个小型测试文件，其余核心功能均无专用测试。

⚠️ **有 3 项 P2 实现改进建议**：TeamFile 原子写入应使用临时文件 rename 保护（B5-agent-swarms-08/09）；facet 缓存也应使用原子写入（B5-review-analysis-02）；scheduling子系统核心测试不完整（B5-scheduling-01）。

⚠️ **有 2 项未完成功能**：`useFrustrationDetection()` 仅占位（B5-help-feedback-02）；VerifyPlanExecutionTool 未实现（B5-plan-worktree-02）。

---

### 子系统审计进度

| 子系统 | 状态 |
|--------|------|
| agent-swarms | ✅ 已审计 |
| help-feedback | ✅ 已审计 |
| plan-worktree | ✅ 已审计 |
| review-analysis | ✅ 已审计 |
| scheduling | ✅ 已审计 |
| task-system | ⏸️ 待审计（open） |
| workflow | ⏸️ 待审计（open） |

**当前进度**：5/7 已审计；剩余 2 子系统保持 open。
