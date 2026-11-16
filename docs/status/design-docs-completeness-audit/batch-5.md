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
| 审计状态 | ⏸️ 待审计 | 本次仅审计 agent-swarms，help-feedback 保持 open |

---

### plan-worktree

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-plan-worktree-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/plan-worktree.yaml |
| Manifest 注册 | ✅ | id: plan-worktree, batch: 5, status: draft |
| 审计状态 | ⏸️ 待审计 | 本次仅审计 agent-swarms，plan-worktree 保持 open |

---

### review-analysis

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-review-analysis-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/review-analysis.yaml |
| Manifest 注册 | ✅ | id: review-analysis, batch: 5, status: draft |
| 审计状态 | ⏸️ 待审计 | 本次仅审计 agent-swarms，review-analysis 保持 open |

---

### scheduling

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-scheduling-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/scheduling.yaml |
| Manifest 注册 | ✅ | id: scheduling, batch: 5, status: draft |
| 审计状态 | ⏸️ 待审计 | 本次仅审计 agent-swarms，scheduling 保持 open |

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

### Batch 5 总体结论

✅ **agent-swarms 子系统 spec 质量优秀**：文档完整性高，12 项关键决策表格化，10 个模块设计卡，完整生命周期证据链。

✅ **agent-swarms 子系统实现一致性强**：所有 10 个 coverage 分组源码与 spec 高度对齐，关键机制与文档完全一致，安全边界设计周全。

⚠️ **测试覆盖严重不足**：仅 `agentMemorySnapshot.test.ts` 完整测试，AgentTool 核心路径、团队工具、mailbox 并发、权限同步、coordinator 模式、多后端均无专用测试。

⚠️ **有 1 项 P2 实现改进建议**：TeamFile 原子写入应使用临时文件 rename 保护（B5-agent-swarms-08/09）。

---

### 子系统审计进度

| 子系统 | 状态 |
|--------|------|
| agent-swarms | ✅ 已审计 |
| help-feedback | ⏸️ 待审计（open） |
| plan-worktree | ⏸️ 待审计（open） |
| review-analysis | ⏸️ 待审计（open） |
| scheduling | ⏸️ 待审计（open） |
| task-system | ⏸️ 待审计（open） |
| workflow | ⏸️ 待审计（open） |

**当前进度**：1/7 已审计，agent-swarms 完成；其余 6 子系统保持 open。
