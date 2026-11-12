---
id: plan-worktree
batch: 5
title: Plan & Worktree 计划执行与隔离工作区设计
date: 2026-11-12
status: draft
---

# Plan & Worktree 计划执行与隔离工作区设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

复杂任务开发需要两个关键功能：**先探索规划再实施**，以及**在隔离环境中尝试变更而不影响主工作区**。如果没有这两个功能：

- 用户可能在未充分理解代码库的情况下盲目修改，导致返工
- 实验性变更可能意外污染主工作区，需要手动清理
- 多个并行任务之间互相干扰
- 没有明确的计划-批准-执行闭环，责任不清晰
- 计划模式与执行模式的工具权限边界不明确，可能出现意外的写操作

因此本子系统必须在以下约束下完成：

- 计划模式是只读探索阶段：只能读文件、探索代码库，不能写
- 计划模式需要明确的用户批准才能退出并进入执行阶段
- 工作区创建需要快速：避免重复拷贝 node_modules 等大目录
- 工作区退出需要安全：提示用户是否保留变更，防止意外丢失
- 工作区状态需要持久化：会话中断后可以恢复
- 未提交变更需要 fail-closed 保护：删除前必须显式确认
- Ultraplan 远程会话需要支持从浏览器批准计划并 teleport 回本地执行
- 队友（teammate）代理需要支持向 leader 请求计划批准

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 计划模式只读约束：工具权限层剥离 write 权限 | `prepareContextForPlanMode()` 在 `toolPermissionContext` 上标记 `strippedDangerousRules`，阻止写操作 | 确保计划阶段只有探索，没有副作用；用户可以安全查看计划 | 完全禁用工具：探索效率太低；只提示不强制：模型可能忽略提示，用户体验差 | 需要在工具权限层实现，增加复杂度 | `src/utils/permissions/permissionSetup.ts` |
| 计划-批准-执行闭环：`EnterPlanMode` → 写计划文件 → `ExitPlanMode` | 计划内容写入 `~/.claude/plans/{slug}.md`，`ExitPlanMode` 触发用户批准对话框，批准后恢复原始权限模式 | 明确的三阶段流程，用户有机会审查和编辑计划；计划持久化可跨会话恢复 | 计划只在内存中：会话丢失后计划也丢失；不需要用户批准：计划变成可选流程，失去意义 | 需要维护计划文件路径和 slug 映射 | `src/utils/plans.ts:1-116` |
| 计划批准两种路径：本地 UI 批准 + Ultraplan CCR 远程批准 | 本地：`ExitPlanModePermissionRequest` UI；远程：`pollForApprovedExitPlanMode()` 扫描 CCR 事件流中的 `## Approved Plan` 标记或 `__ULTRAPLAN_TELEPORT_LOCAL__` 标记 | 支持纯本地 CLI 场景和 Claude Desktop 远程场景；teleport 标记支持用户选择本地执行 | 只有本地批准：Ultraplan 无法使用；只有远程批准：本地用户体验差 | 需要维护两条批准路径的代码 | `src/utils/ultraplan/ccrSession.ts:1-363` |
| 工作区 git worktree 优先 + hook  fallback：`createWorktreeForSession()` 先检查 hook 再 fallback 到 git | hook 路径：`hasWorktreeCreateHook()` → `executeWorktreeCreateHook()`；git 路径：`getOrCreateWorktree()` + `git worktree add` | 支持非 git 项目（通过 hook）；git 项目使用 git worktree 原生机制，高效可靠 | 只用 git worktree：非 git 项目无法使用；只做完整拷贝：磁盘占用大，慢 | 需要维护 hook 和 git 两条路径 | `src/utils/worktree.ts:677-753` |
| 工作区 slug 扁平化：`flattenSlug()` 将 `/` 替换为 `+` | `user/feature` → `user+feature`，避免 git ref D/F 冲突和嵌套工作区删除问题 | git 不允许 `worktree-user` 文件和 `worktree-user/feature` 目录同时存在；嵌套工作区删除父级会连带删除子级 | 禁止 `/`：用户无法分层命名；不扁平化：随机出现 D/F 冲突 | 需要在创建和查找时统一扁平化 | `src/utils/worktree.ts:219-221` |
| 工作区目录 symlink 优化：`symlinkDirectories()` 选择性 symlink node_modules 等 | `settings.worktree.symlinkDirectories` 配置目录列表，创建时 symlink 而不拷贝 | 避免重复拷贝大目录（如 node_modules），加速工作区创建 | 总是完整拷贝：慢且占磁盘；总是 symlink：某些工具对 symlink 行为敏感 | 需要用户配置，增加认知负担 | `src/utils/worktree.ts:104-140` |
| 工作区 `.worktreeinclude` 复制：`copyWorktreeIncludeFiles()` 复制 gitignored 文件 | 读取 `.worktreeinclude`，用 `ignore` 库匹配，`git ls-files --others --ignored` 列出候选，复制匹配文件 | 需要复制 gitignored 的配置/密钥文件到工作区，但又不复制所有 gitignored 文件（如构建产物） | 复制所有 gitignored 文件：可能复制大量构建产物，慢；让用户手动复制：体验差 | 需要实现精确的模式匹配和目录展开 | `src/utils/worktree.ts:393-506` |
| 工作区退出 fail-closed：`validateInput()` 检查变更，要求 `discard_changes: true` | `countWorktreeChanges()` 调用 `git status --porcelain` 和 `git rev-list --count {base}..HEAD`，有变更时拒绝删除 | 防止用户意外丢弃未提交的工作；fail-closed 策略确保安全 | 直接删除：数据丢失风险高；只提示不阻止：模型可能忽略提示 | 需要在执行前验证，增加交互步骤 | `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:174-223` |
| 工作区 keep/remove 双选项：`ExitWorktree` 接受 `action: keep|remove` | `keepWorktree()` 只切换目录不删除；`cleanupWorktree()` 调用 `git worktree remove` 并删除分支 | 支持临时实验（remove）和长期分支（keep）两种场景；用户明确选择 | 只有 keep：垃圾堆积；只有 remove：无法保留有用工作 | 需要维护两个退出路径 | `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:227-319` |
| 计划 slug 缓存与恢复：`getPlanSlug()` 使用 `planSlugCache`，`copyPlanForResume()` 从日志恢复 | session ID → slug Map 缓存；恢复时从日志提取 slug，尝试读取计划文件，失败则从消息历史提取 | 会话恢复时能找到之前的计划文件；即使计划文件丢失也能从 transcript 恢复 | 每次生成新 slug：计划文件碎片化；不恢复：用户重新写计划，体验差 | 需要在多个恢复路径实现 | `src/utils/plans.ts:32-230` |
| ExitPlanMode 可选的语义化权限请求：`allowedPrompts` 数组，只支持 Bash | `ExitPlanModeV2Tool` 接受 `allowedPrompts: [{tool: 'Bash', prompt: '...'}]`，用户批准后添加到会话权限 | 执行阶段可能需要重复运行某些 Bash 命令（如测试、构建），提前请求可减少批准次数；只支持 Bash 是因为其他工具已有足够的权限控制 | 允许所有工具：权限边界太宽；不支持：每次运行都需要批准，体验差 | 需要限制只支持 Bash，避免权限滥用 | `src/tools/ExitPlanModeTool/ExitPlanModeTool.ts:64-89` |
| Teammate 计划批准路径：`isPlanModeRequired()` 时向 leader 发送 `plan_approval_request` |  teammate 调用 `ExitPlanMode` 时，检查 `isPlanModeRequired()`，写入 leader 的 mailbox 而不是触发本地 UI |  teammate 是代理，没有本地用户界面，需要通过 leader 批准计划；可选路径支持自愿计划模式 | 总是需要 leader 批准：teammate 自主性太低；总是不批准：失去计划控制 | 需要与 teammate mailbox 系统集成 | `src/tools/ExitPlanModeTool/ExitPlanModeTool.ts:264-312` |
| 工作区会话状态持久化：`saveWorktreeState()` 保存到项目配置 | 当前工作区路径、名称、分支等保存到 `saveCurrentProjectConfig()`，`restoreWorktreeSession()` 恢复 | 会话中断后可以恢复工作区状态，继续之前的工作 | 不持久化：每次都要重新创建，体验差 | 需要在启动和退出时处理 | `src/utils/worktree.ts:158-171` |
| 暂态工作树清理：`cleanupStaleAgentWorktrees()` 清理 30 天前的 agent/workflow/worktree | `EPHEMERAL_WORKTREE_PATTERNS` 匹配 `agent-a{hex}`、`wf_{uuid}-{idx}`、`bridge-*`、`job-*-{hex}`，检查 mtime 和 git 状态，安全则删除 | agent/workflow 创建的临时工作树在进程崩溃时会泄漏，定期清理避免磁盘堆积；只清理匹配模式的，不碰用户命名的工作树 | 不清理：垃圾堆积；清理所有：可能删除用户有用的工作 | 需要实现精确的模式匹配和安全检查 | `src/utils/worktree.ts:1005-1111` |

## 3. 目标与非目标

### 计划模式

- **目标**：`EnterPlanMode` 进入计划模式，工具权限变为只读
- **目标**：`ExitPlanMode` 退出计划模式，触发用户批准对话框
- **目标**：计划内容持久化到 `~/.claude/plans/{slug}.md`
- **目标**：会话恢复时能恢复计划 slug 和内容
- **目标**：支持 Ultraplan CCR 远程批准和 teleport 回本地
- **目标**：支持 teammate 向 leader 请求计划批准
- **非目标**：不提供计划的版本控制或分支（用户自己用 git）

### 工作区

- **目标**：`EnterWorktree` 创建隔离工作区并切换进去
- **目标**：`ExitWorktree` 退出工作区，支持 keep/remove 双选项
- **目标**：工作区创建时 symlink 大目录，复制 gitignored 配置文件
- **目标**：删除工作区前检查未提交变更，fail-closed 保护
- **目标**：会话恢复时能恢复工作区状态
- **目标**：定期清理暂态工作树
- **非目标**：不支持工作区之间的实时同步

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 计划模式工具
EnterPlanModeTool.call()  // 进入计划模式
ExitPlanModeV2Tool.call({allowedPrompts?})  // 退出计划模式

// 工作区工具
EnterWorktreeTool.call({name?})  // 创建并进入工作区
ExitWorktreeTool.call({action: 'keep'|'remove', discard_changes?})  // 退出工作区

// 计划工具函数
getPlanSlug(sessionId?): string  // 获取/生成计划 slug
getPlanFilePath(agentId?): string  // 获取计划文件路径
getPlan(agentId?): string | null  // 读取计划内容
copyPlanForResume(log, targetSessionId?): Promise<boolean>  // 恢复计划
copyPlanForFork(log, targetSessionId): Promise<boolean>  //  fork 计划
persistFileSnapshotIfRemote(): Promise<void>  // 远程会话快照计划

// 工作区工具函数
createWorktreeForSession(sessionId, slug, tmuxSessionName?, options?): Promise<WorktreeSession>
keepWorktree(): Promise<void>
cleanupWorktree(): Promise<void>
getCurrentWorktreeSession(): WorktreeSession | null
restoreWorktreeSession(session: WorktreeSession | null): void
validateWorktreeSlug(slug: string): void
hasWorktreeChanges(worktreePath, originalHeadCommit): Promise<boolean>
createAgentWorktree(slug): Promise<{worktreePath, worktreeBranch?, headCommit?, gitRoot?, hookBased?}>
removeAgentWorktree(worktreePath, worktreeBranch?, gitRoot?, hookBased?): Promise<boolean>
cleanupStaleAgentWorktrees(cutoffDate): Promise<number>

// Ultraplan 工具函数
pollForApprovedExitPlanMode(sessionId, timeoutMs, onPhaseChange?, shouldStop?, deps?): Promise<{plan, rejectCount, executionTarget}>
ExitPlanModeScanner.ingest(events): ScanResult  // 扫描事件流
extractApprovedPlan(content): string  // 提取批准的计划
extractTeleportPlan(content): string | null  // 提取 teleport 计划
```

调用方式：

1. **计划模式路径**：
   - 模型调用 `EnterPlanMode` → 权限切换为只读
   - 模型探索代码库，调用 `AskUserQuestion` 澄清需求
   - 模型写计划到 `getPlanFilePath()`
   - 模型调用 `ExitPlanMode` → 用户批准 → 权限恢复，进入执行

2. **工作区路径**：
   - 模型调用 `EnterWorktree({name?})` → 创建 git worktree 或 hook 工作区
   - `process.chdir()` + `setCwd()` + `setOriginalCwd()` 切换目录
   - 模型在工作区中工作
   - 模型调用 `ExitWorktree({action: 'keep'|'remove'})` → 退出并可能删除

3. **Ultraplan 远程路径**：
   - CLI 调用 `teleportToRemote()` 启动远程会话
   - 远程模型调用 `EnterPlanMode` → 探索 → 写计划 → `ExitPlanMode`
   - 本地 `pollForApprovedExitPlanMode()` 扫描事件流
   - 用户在浏览器批准或点击 teleport
   - 本地提取计划，继续执行

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `plans.ts` | `planSlugCache` (Map) | `getPlanSlug()`、`getPlan()`、`copyPlanForResume()`、`persistFileSnapshotIfRemote()` | 计划内容编辑（由模型/用户负责） | 读取/写入 `~/.claude/plans/`，与 `bootstrap/state` 交互 |
| `worktree.ts` | `currentWorktreeSession` (module-level) | `createWorktreeForSession()`、`keepWorktree()`、`cleanupWorktree()`、`validateWorktreeSlug()`、`hasWorktreeChanges()`、`createAgentWorktree()`、`cleanupStaleAgentWorktrees()` | git 底层操作（委托给 git 命令） | 调用 `git worktree` 命令，与 `hooks.ts` 交互，使用 `settings.ts` 配置 |
| `EnterPlanModeTool` | 无（无状态） | `call()` 切换权限模式 | 计划内容编写（由模型负责） | 调用 `prepareContextForPlanMode()`、`handlePlanModeTransition()` |
| `ExitPlanModeTool` | 无（无状态） | `call()` 触发批准、恢复权限、更新状态 | 计划执行验证（由 VerifyPlanExecution 负责） | 读取/写入计划文件，与 `teammateMailbox.ts` 交互，调用 `permissionSetup` |
| `EnterWorktreeTool` | 无（无状态） | `call()` 创建并切换工作区 | 工作区内容操作（由模型/用户负责） | 调用 `createWorktreeForSession()`、`setCwd()`、`clearSystemPromptSections()` |
| `ExitWorktreeTool` | 无（无状态） | `validateInput()` 检查变更、`call()` 退出 | 工作区内容保存（由用户/git 负责） | 调用 `keepWorktree()`、`cleanupWorktree()`、`countWorktreeChanges()` |
| `ccrSession.ts` | `ExitPlanModeScanner.exitPlanCalls`、`results`、`rejectedIds`、`terminated`、`rescanAfterRejection` | `pollForApprovedExitPlanMode()`、`ExitPlanModeScanner.ingest()`、`extractApprovedPlan()`、`extractTeleportPlan()` | 远程会话创建（由 teleport.ts 负责） | 调用 `pollRemoteSessionEvents()`、`checkAndRefreshOAuthTokenIfNeeded()` |
| `bootstrap/state.ts` | `STATE.planSlugCache`、`STATE.hasExitedPlanMode`、`STATE.needsPlanModeExitAttachment` | `getSessionId()`、`getParentSessionId()`、`switchSession()` | 实际状态管理（由 AppState 负责） | 被各模块读取/更新 |
| `tools/VerifyPlanExecutionTool` | 存在但未实现 | - | 计划执行验证（待实现） | - |

状态位置与理由：

- **`currentWorktreeSession`** 放在 `worktree.ts` 模块级：只有当前会话能退出自己创建的工作区，防止误操作其他会话的工作区
- **`planSlugCache`** 放在 `bootstrap/state.ts` 全局 `STATE`：需要在会话恢复、fork、switch 时保持 slug 映射，跨模块访问
- **`ExitPlanModeScanner`** 内部状态（`exitPlanCalls`、`results`、`rejectedIds` 等）放在类实例：纯函数式状态机，方便测试和回放

### 4.3 主控制流

#### 计划模式流程

```
用户请求 → 模型调用 EnterPlanMode
  ↓
prepareContextForPlanMode() 剥离危险权限
handlePlanModeTransition() 记录模式切换
  ↓
[ 模型探索代码库 - 只读阶段 ]
  ↓
模型写计划到 getPlanFilePath()
  ↓
模型调用 ExitPlanMode
  ↓
如果是 teammate 且 isPlanModeRequired():
  写入 leader 的 mailbox → 等待批准
否则:
  触发 ExitPlanModePermissionRequest UI
  ↓
用户审查、可能编辑计划 → 批准
  ↓
恢复原始权限模式（可能是 auto/default）
如果 allowedPrompts 被批准，添加语义化权限
  ↓
[ 执行阶段 - 可读写 ]
```

#### 工作区创建流程

```
模型调用 EnterWorktree({name?})
  ↓
validateWorktreeSlug(slug) 检查名称
  ↓
如果有 WorktreeCreate hook:
  executeWorktreeCreateHook(slug)
否则:
  getOrCreateWorktree(gitRoot, slug)
    ↓
    检查是否已存在（fast path）
      已存在 → 直接返回
      不存在 → git worktree add -B {branch} {path} {base}
    ↓
    performPostCreationSetup():
      copy settings.local.json
      configure core.hooksPath
      symlinkDirectories()
      copyWorktreeIncludeFiles()
  ↓
process.chdir(worktreePath)
setCwd(worktreePath)
setOriginalCwd(worktreePath)
saveWorktreeState(session)
clearSystemPromptSections()
clearMemoryFileCaches()
  ↓
返回 WorktreeSession
```

#### 工作区退出流程

```
模型调用 ExitWorktree({action, discard_changes?})
  ↓
validateInput():
  检查 currentWorktreeSession 存在（只允许退出自己创建的）
  如果 action === 'remove' 且 !discard_changes:
    countWorktreeChanges(): git status + git rev-list
    有变更 → 拒绝，提示用户确认
  ↓
如果 action === 'keep':
  keepWorktree():
    process.chdir(originalCwd)
    currentWorktreeSession = null
    更新配置
else if action === 'remove':
  cleanupWorktree():
    如果有 tmux 会话，killTmuxSession()
    process.chdir(originalCwd)
    git worktree remove --force {path}
    git branch -D {branch}
    currentWorktreeSession = null
    更新配置
  ↓
restoreSessionToOriginalCwd():
  setCwd(originalCwd)
  setOriginalCwd(originalCwd)
  如果 projectRoot 是工作区，恢复 projectRoot
  updateHooksConfigSnapshot() (if needed)
  saveWorktreeState(null)
  clearSystemPromptSections()
  clearMemoryFileCaches()
  ↓
返回结果
```

#### Ultraplan 远程批准流程

```
本地 CLI 调用 teleportToRemote() → 创建远程会话
  ↓
远程 Claude 运行：
  EnterPlanMode → 探索 → 写计划 → ExitPlanMode
  ↓
远程生成 ExitPlanMode tool_use 事件
  ↓
本地 pollForApprovedExitPlanMode():
  refresh OAuth
  pollRemoteSessionEvents() 获取新事件
  ↓
  ExitPlanModeScanner.ingest(events):
    记录 tool_use
    查找对应的 tool_result
  ↓
  扫描结果判断:
    - Approved: tool_result 有 "## Approved Plan"
    - Teleport: tool_result 有 "__ULTRAPLAN_TELEPORT_LOCAL__"
    - Rejected: tool_result 是 error 且无 teleport 标记
    - Terminated: 有 error result
    - Pending: tool_use 存在但无 tool_result
    - Unchanged: 无新事件
  ↓
  Approved/Teleport → 返回 {plan, executionTarget}
  Rejected → 继续轮询
  Terminated → 抛出错误
  Timeout → 抛出错误
  ↓
本地继续执行计划
```

## 5. 接口与数据格式

### 计划模式数据类型

```typescript
// plans.ts
type PlanSlug = string  // e.g., "swift-fox-1234"

// ExitPlanModeTool input
interface ExitPlanModeInput {
  allowedPrompts?: Array<{
    tool: 'Bash'  // only Bash supported
    prompt: string  // semantic description, e.g., "run tests", "build project"
  }>
}

// ExitPlanModeTool output (SDK-facing - injected by normalizeToolInput)
interface ExitPlanModeSDKInput extends ExitPlanModeInput {
  plan?: string  // injected from file
  planFilePath?: string  // injected
}

interface ExitPlanModeOutput {
  plan: string | null
  isAgent: boolean
  filePath?: string
  hasTaskTool?: boolean
  planWasEdited?: boolean
  awaitingLeaderApproval?: boolean
  requestId?: string
}

// Teammate plan approval request
interface PlanApprovalRequest {
  type: 'plan_approval_request'
  from: string  // agent name
  timestamp: string  // ISO
  planFilePath: string
  planContent: string
  requestId: string
}
```

### 工作区数据类型

```typescript
// worktree.ts
interface WorktreeSession {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
  creationDurationMs?: number
  usedSparsePaths?: boolean
}

// EnterWorktreeTool input
interface EnterWorktreeInput {
  name?: string  // optional slug
}

// EnterWorktreeTool output
interface EnterWorktreeOutput {
  worktreePath: string
  worktreeBranch?: string
  message: string
}

// ExitWorktreeTool input
interface ExitWorktreeInput {
  action: 'keep' | 'remove'
  discard_changes?: boolean  // required true if removing with changes
}

// ExitWorktreeTool output
interface ExitWorktreeOutput {
  action: 'keep' | 'remove'
  originalCwd: string
  worktreePath: string
  worktreeBranch?: string
  tmuxSessionName?: string
  discardedFiles?: number
  discardedCommits?: number
  message: string
}
```

### Ultraplan CCR 扫描类型

```typescript
// ccrSession.ts
type UltraplanPhase = 'running' | 'needs_input' | 'plan_ready'

type ScanResult =
  | {kind: 'approved', plan: string}
  | {kind: 'teleport', plan: string}
  | {kind: 'rejected', id: string}
  | {kind: 'pending'}
  | {kind: 'terminated', subtype: string}
  | {kind: 'unchanged'}

type PollFailReason =
  | 'terminated'
  | 'timeout_pending'
  | 'timeout_no_plan'
  | 'extract_marker_missing'
  | 'network_or_unknown'
  | 'stopped'

type PollResult = {
  plan: string
  rejectCount: number
  executionTarget: 'local' | 'remote'
}

const ULTRAPLAN_TELEPORT_SENTINEL = '__ULTRAPLAN_TELEPORT_LOCAL__'
```

## 6. 错误处理与恢复

| 场景 | 处理方式 | 恢复策略 | 证据 |
|---|---|---|---|
| 计划文件不存在 | `getPlan()` 返回 null；`copyPlanForResume()` 尝试从 transcript 恢复 | 从 message history 提取 ExitPlanMode tool_use 的注入 plan，或 user message 的 planContent，或 plan_file_reference attachment | `src/utils/plans.ts:180-230` |
| 工作区创建失败（git worktree add 失败） | 抛出错误，不改变当前目录 | 用户修复问题后重试；hook 失败时如果有 git 可能 fallback？（当前没有，hook 优先） | `src/utils/worktree.ts:331-376` |
| 工作区删除失败（git worktree remove 失败） | 记录日志，不抛出；`currentWorktreeSession` 仍设为 null，不阻止退出 | 工作区目录可能残留，用户手动清理或下次 `cleanupStaleAgentWorktrees()` 可能处理 | `src/utils/worktree.ts:888-910` |
| 工作区状态无法验证（git status 失败） | `countWorktreeChanges()` 返回 null；`validateInput()` 拒绝删除，提示用户显式 `discard_changes: true` | 用户确认后重调用 `discard_changes: true` | `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:79-113` |
| Ultraplan 轮询网络错误 | `isTransientNetworkError()` 判断是否瞬时；瞬时错误时重试，达到 `MAX_CONSECUTIVE_FAILURES`（5次）后抛出 | 自动重试瞬时错误；用户可手动重试 | `src/utils/ultraplan/ccrSession.ts:212-319` |
| Ultraplan 提取计划失败（缺少 marker） | 抛出 `UltraplanPollError` with `reason: 'extract_marker_missing'` | 用户在浏览器重新批准，或 teleport 回本地 | `src/utils/ultraplan/ccrSession.ts:344-362` |
| OAuth 刷新失败（Ultraplan 轮询前） | `refreshOAuth` 依赖 `checkAndRefreshOAuthTokenIfNeeded()` 的错误处理 | 由 auth 层的重试/ fallback 处理 | `src/utils/ultraplan/ccrSession.ts:204-215` |
| ExitPlanMode 在非计划模式下调用 | `validateInput()` 拒绝，返回错误 | 模型应检查当前模式，或用户已批准后模型无需再调用 | `src/tools/ExitPlanModeTool/ExitPlanModeTool.ts:195-220` |
| ExitWorktree 在无活动工作区时调用 | `validateInput()` 拒绝，提示无活动会话 | 模型应检查是否在工作区中 | `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:174-194` |

## 7. 测试策略

| 测试类型 | 覆盖范围 | 具体案例 | 证据 |
|---|---|---|---|
| ExitPlanMode 提示规则 | 语义化权限的 schema 验证 | 允许 `{tool: 'Bash', prompt: '...'}`；拒绝其他 tool；测试公开指导文档与实际实现一致 | `tests/exitPlanModePrompt.test.ts:1-49` |
| Ultraplan CCR 扫描状态机 | ExitPlanModeScanner 的 ingest 逻辑 | approved/teleport/rejected/pending/terminated/unchanged 各场景；reject 计数；rescan after rejection | （待实现测试，当前只有 ccrSession.ts 实现） |
| Ultraplan OAuth 刷新 | 每次轮询前刷新 OAuth | 测试 `refreshOAuth` 在每次 `pollEvents` 前被调用；测试并发去重 | `tests/ultraplanPoll.test.ts:1-34` |
| Worktree slug 验证 | 非法 slug 拒绝 | 测试 `../` 路径遍历；测试绝对路径；测试超长；测试合法嵌套 `user/feature` → 扁平化 | （待实现测试） |
| Worktree 变更检测 | `countWorktreeChanges()` 检测未提交文件和新提交 | 测试有未提交文件；测试有新提交；测试两者都有；测试 git 命令失败返回 null | （待实现测试） |
| 计划恢复 | `copyPlanForResume()` 从 transcript 恢复 | 测试从 file snapshot 恢复；测试从 ExitPlanMode tool_use 恢复；测试从 user message planContent 恢复；测试从 plan_file_reference attachment 恢复 | （待实现测试） |
| 暂态工作树清理 | `cleanupStaleAgentWorktrees()` 只清理匹配模式的旧工作树 | 测试匹配 `agent-a{hex}`、`wf_{uuid}-{idx}`、`bridge-*`、`job-*-{hex}`；测试不清理用户命名的；测试检查 mtime；测试检查 git status（不清理有变更的）；测试检查 unpushed commits（不清理） | （待实现测试） |

## 8. 覆盖率

[Coverage](../../architecture/coverage/plan-worktree.yaml)

## 9. 未解决问题与技术债务

| 问题 | 严重性 | 描述 | 可能的解决方案 | 证据 |
|---|---|---|---|---|
| VerifyPlanExecutionTool 未实现 | 中 | 工具目录存在但只有 constants.ts，没有实际实现；计划执行后没有验证步骤 | 实现 VerifyPlanExecutionTool，检查计划中的步骤是否都完成，没有做计划外的危险操作 | `src/tools/VerifyPlanExecutionTool/constants.ts` |
| 工作区 sparse checkout 未测试 | 低 | `settings.worktree.sparsePaths` 支持但可能缺少充分测试 | 添加 sparse checkout 场景测试 | `src/utils/worktree.ts:323-367` |
| `.worktreeinclude` 目录展开逻辑复杂 | 中 | `copyWorktreeIncludeFiles()` 为处理 `config/secrets/api.key` 这样的模式需要展开 collapsed directory，逻辑较绕 | 简化或增加更多测试覆盖边界情况 | `src/utils/worktree.ts:441-480` |
| 暂态工作树清理的 cutoff 硬编码为 30 天 | 低 | `cleanupStaleAgentWorktrees()` 由调用方决定 cutoff，但当前没有实际调用方传入 | 实现定期清理调用，或让用户配置 | `src/utils/worktree.ts:1033` |
| 工作区与计划模式的集成不紧密 | 低 | 当前是两个独立功能，可以进入计划模式不进工作区，也可以进工作区不进计划模式；理想情况下可能推荐"先计划（主工作区只读探索）再执行（工作区隔离实施）" | 考虑在 EnterPlanMode 后提示用户使用 EnterWorktree 执行，或在 UX 层面引导流程 | （无特定文件，UX 设计问题） |
