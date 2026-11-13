---
id: plan-worktree
batch: 5
title: Plan & Worktree 计划执行与隔离工作区设计
date: 2026-11-12
status: draft
---

# Plan & Worktree 计划执行与隔离工作区设计

## 1. 问题与约束

复杂任务开发需要两个关键功能：先探索规划再实施，以及在隔离环境中尝试变更而不影响主工作区。面临的约束包括：

- 计划模式必须是只读探索阶段：只能读文件、探索代码库，不能写
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
| 计划模式只读约束 | `prepareContextForPlanMode()` 在 `toolPermissionContext` 上标记 `strippedDangerousRules`，阻止写操作 | 确保计划阶段只有探索，没有副作用；用户可以安全查看计划 | 完全禁用工具（探索效率太低）、只提示不强制（模型可能忽略提示，用户体验差） | 需要在工具权限层实现，增加复杂度 | `src/utils/permissions/permissionSetup.ts` |
| 计划-批准-执行闭环 | `EnterPlanMode` → 写计划文件 → `ExitPlanMode` | 明确的三阶段流程，用户有机会审查和编辑计划；计划持久化可跨会话恢复 | 计划只在内存中（会话丢失后计划也丢失）、不需要用户批准（计划变成可选流程，失去意义） | 需要维护计划文件路径和 slug 映射 | `src/utils/plans.ts:1-116` |
| 计划批准两种路径 | 本地 UI 批准 + Ultraplan CCR 远程批准 | 支持纯本地 CLI 场景和 Claude Desktop 远程场景；teleport 标记支持用户选择本地执行 | 只有本地批准（Ultraplan 无法使用）、只有远程批准（本地用户体验差） | 需要维护两条批准路径的代码 | `src/utils/ultraplan/ccrSession.ts:1-363` |
| 工作区 git worktree 优先 + hook fallback | `createWorktreeForSession()` 先检查 hook 再 fallback 到 git | 支持非 git 项目（通过 hook）；git 项目使用 git worktree 原生机制，高效可靠 | 只用 git worktree（非 git 项目无法使用）、只做完整拷贝（磁盘占用大，慢） | 需要维护 hook 和 git 两条路径 | `src/utils/worktree.ts:677-753` |
| 工作区 slug 扁平化 | `flattenSlug()` 将 `/` 替换为 `+` | `user/feature` → `user+feature`，避免 git ref D/F 冲突和嵌套工作区删除问题 | 禁止 `/`（用户无法分层命名）、不扁平化（随机出现 D/F 冲突） | 需要在创建和查找时统一扁平化 | `src/utils/worktree.ts:219-221` |
| 工作区目录 symlink 优化 | `symlinkDirectories()` 选择性 symlink node_modules 等 | `settings.worktree.symlinkDirectories` 配置目录列表，创建时 symlink 而不拷贝 | 总是完整拷贝（慢且占磁盘）、总是 symlink（某些工具对 symlink 行为敏感） | 需要用户配置，增加认知负担 | `src/utils/worktree.ts:104-140` |
| 工作区 `.worktreeinclude` 复制 | `copyWorktreeIncludeFiles()` 复制 gitignored 文件 | 读取 `.worktreeinclude`，用 `ignore` 库匹配，`git ls-files --others --ignored` 列出候选，复制匹配文件 | 复制所有 gitignored 文件（可能复制大量构建产物，慢）、让用户手动复制（体验差） | 需要实现精确的模式匹配和目录展开 | `src/utils/worktree.ts:393-506` |
| 工作区退出 fail-closed | `validateInput()` 检查变更，要求 `discard_changes: true` | `countWorktreeChanges()` 调用 `git status --porcelain` 和 `git rev-list --count {base}..HEAD`，有变更时拒绝删除 | 直接删除（数据丢失风险高）、只提示不阻止（模型可能忽略提示） | 需要在执行前验证，增加交互步骤 | `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:174-223` |
| 工作区 keep/remove 双选项 | `ExitWorktree` 接受 `action: keep|remove` | `keepWorktree()` 只切换目录不删除；`cleanupWorktree()` 调用 `git worktree remove` 并删除分支 | 支持临时实验（remove）和长期分支（keep）两种场景；用户明确选择 | 只有 keep（垃圾堆积）、只有 remove（无法保留有用工作） | 需要维护两个退出路径 | `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:227-319` |
| 计划 slug 缓存与恢复 | `getPlanSlug()` 使用 `planSlugCache`，`copyPlanForResume()` 从日志恢复 | session ID → slug Map 缓存；恢复时从日志提取 slug，尝试读取计划文件，失败则从消息历史提取 | 每次生成新 slug（计划文件碎片化）、不恢复（用户重新写计划，体验差） | 需要在多个恢复路径实现 | `src/utils/plans.ts:32-230` |
| ExitPlanMode 可选的语义化权限请求 | `allowedPrompts` 数组，只支持 Bash | `ExitPlanModeV2Tool` 接受 `allowedPrompts: [{tool: 'Bash', prompt: '...'}]`，用户批准后添加到会话权限 | 执行阶段可能需要重复运行某些 Bash 命令（如测试、构建），提前请求可减少批准次数；只支持 Bash 是因为其他工具已有足够的权限控制 | 允许所有工具（权限边界太宽）、不支持（每次运行都需要批准，体验差） | 需要限制只支持 Bash，避免权限滥用 | `src/tools/ExitPlanModeTool/ExitPlanModeTool.ts:64-89` |
| Teammate 计划批准路径 | `isPlanModeRequired()` 时向 leader 发送 `plan_approval_request` | teammate 调用 `ExitPlanMode` 时，检查 `isPlanModeRequired()`，写入 leader 的 mailbox 而不是触发本地 UI | teammate 是代理，没有本地用户界面，需要通过 leader 批准计划；可选路径支持自愿计划模式 | 总是需要 leader 批准（teammate 自主性太低）、总是不批准（失去计划控制） | 需要与 teammate mailbox 系统集成 | `src/tools/ExitPlanModeTool/ExitPlanModeTool.ts:264-312` |
| 工作区会话状态持久化 | `saveWorktreeState()` 保存到项目配置 | 当前工作区路径、名称、分支等保存到 `saveCurrentProjectConfig()`，`restoreWorktreeSession()` 恢复 | 会话中断后可以恢复工作区状态，继续之前的工作 | 不持久化（每次都要重新创建，体验差） | 需要在启动和退出时处理 | `src/utils/worktree.ts:158-171` |
| 暂态工作树清理 | `cleanupStaleAgentWorktrees()` 清理 30 天前的 agent/workflow/worktree | `EPHEMERAL_WORKTREE_PATTERNS` 匹配 `agent-a{hex}`、`wf_{uuid}-{idx}`、`bridge-*`、`job-*-{hex}`，检查 mtime 和 git 状态，安全则删除 | agent/workflow 创建的临时工作树在进程崩溃时会泄漏，定期清理避免磁盘堆积；只清理匹配模式的，不碰用户命名的工作树 | 不清理（垃圾堆积）、清理所有（可能删除用户有用的工作） | 需要实现精确的模式匹配和安全检查 | `src/utils/worktree.ts:1005-1111` |

## 3. 目标与非目标

### 计划模式目标
- `EnterPlanMode` 进入计划模式，工具权限变为只读
- `ExitPlanMode` 退出计划模式，触发用户批准对话框
- 计划内容持久化到 `~/.claude/plans/{slug}.md`
- 会话恢复时能恢复计划 slug 和内容
- 支持 Ultraplan CCR 远程批准和 teleport 回本地
- 支持 teammate 向 leader 请求计划批准

### 工作区目标
- `EnterWorktree` 创建隔离工作区并切换进去
- `ExitWorktree` 退出工作区，支持 keep/remove 双选项
- 工作区创建时 symlink 大目录，复制 gitignored 配置文件
- 删除工作区前检查未提交变更，fail-closed 保护
- 会话恢复时能恢复工作区状态
- 定期清理暂态工作树

### 非目标
- 不提供计划的版本控制或分支（用户自己用 git）
- 不支持工作区之间的实时同步

## 4. 架构、模块与数据流

### 入口与公共契约

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
copyPlanForFork(log, targetSessionId): Promise<boolean>  // fork 计划
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

### 模块与状态所有权

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

### 主控制流

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

## 5. 失败语义与工程取舍

| 失败场景 | 处理方式 | 工程取舍 |
|---|---|---|
| 计划文件不存在 | `getPlan()` 返回 null；`copyPlanForResume()` 尝试从 transcript 恢复 | 支持多种恢复路径（file snapshot、ExitPlanMode tool_use、user message planContent、plan_file_reference attachment），提高容错 |
| 工作区创建失败（git worktree add 失败） | 抛出错误，不改变当前目录 | 用户修复问题后重试；hook 失败不 fallback 到 git，保持路径明确 |
| 工作区删除失败（git worktree remove 失败） | 记录日志，不抛出；`currentWorktreeSession` 仍设为 null，不阻止退出 | 工作区目录可能残留，用户手动清理或下次 `cleanupStaleAgentWorktrees()` 可能处理，避免退出流程阻塞 |
| 工作区状态无法验证（git status 失败） | `countWorktreeChanges()` 返回 null；`validateInput()` 拒绝删除，提示用户显式 `discard_changes: true` | fail-closed 策略，防止意外丢弃工作，用户确认后可强制删除 |
| Ultraplan 轮询网络错误 | `isTransientNetworkError()` 判断是否瞬时；瞬时错误时重试，达到 `MAX_CONSECUTIVE_FAILURES`（5次）后抛出 | 自动重试瞬时错误；用户可手动重试，平衡自动化和可控性 |
| Ultraplan 提取计划失败（缺少 marker） | 抛出 `UltraplanPollError` with `reason: 'extract_marker_missing'` | 用户在浏览器重新批准，或 teleport 回本地，提供明确的失败提示 |
| OAuth 刷新失败（Ultraplan 轮询前） | `refreshOAuth` 依赖 `checkAndRefreshOAuthTokenIfNeeded()` 的错误处理 | 由 auth 层的重试/fallback 处理，职责分离 |
| ExitPlanMode 在非计划模式下调用 | `validateInput()` 拒绝，返回错误 | 模型应检查当前模式，或用户已批准后模型无需再调用，提供防御性检查 |
| ExitWorktree 在无活动工作区时调用 | `validateInput()` 拒绝，提示无活动会话 | 模型应检查是否在工作区中，提供防御性检查 |

## 6. 现状验收标准

- 计划模式下工具权限正确剥离写操作
- 计划内容正确持久化到 `~/.claude/plans/{slug}.md`
- ExitPlanMode 正确触发用户批准对话框
- Ultraplan CCR 远程批准和 teleport 正常工作
- Teammate 向 leader 请求计划批准正常工作
- EnterWorktree 创建 git worktree 或 hook 工作区
- worktree slug 正确扁平化处理
- node_modules 等大目录正确 symlink
- `.worktreeinclude` 指定的 gitignored 文件正确复制
- ExitWorktree remove 前检查未提交变更并拒绝（除非 discard_changes: true）
- ExitWorktree keep/remove 双选项正常工作
- 会话恢复时正确恢复计划 slug 和工作区状态
- cleanupStaleAgentWorktrees() 正确清理匹配模式的旧工作树

## 7. 代码与测试证据

### 现有实现
- `src/utils/plans.ts`: 计划管理功能实现
- `src/utils/worktree.ts`: 工作区管理功能实现
- `src/utils/ultraplan/ccrSession.ts`: Ultraplan CCR 会话管理
- `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`: 进入计划模式工具
- `src/tools/ExitPlanModeTool/ExitPlanModeTool.ts`: 退出计划模式工具
- `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts`: 进入工作区工具
- `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts`: 退出工作区工具

### 现有测试
- `tests/exitPlanModePrompt.test.ts:1-49`: ExitPlanMode 语义化权限 schema 验证
- `tests/ultraplanPoll.test.ts:1-34`: Ultraplan OAuth 刷新测试

### 未覆盖测试
- Worktree slug 验证（非法 slug 拒绝、合法嵌套扁平化）
- Worktree 变更检测（未提交文件、新提交、git 命令失败）
- 计划恢复（从 file snapshot、ExitPlanMode tool_use、user message planContent、plan_file_reference attachment）
- 暂态工作树清理（模式匹配、mtime 检查、git 状态检查、unpushed commits 检查）
- Ultraplan CCR 扫描状态机（approved/teleport/rejected/pending/terminated/unchanged 各场景、reject 计数、rescan after rejection）

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/plan-worktree.yaml)

相关子系统：
- permissions: 提供工具权限设置和剥离
- hooks: 提供 WorktreeCreate/WorktreeRemove hook 支持
- settings: 提供 worktree.symlinkDirectories 配置
- bootstrap/state: 提供全局状态管理
- teammate: 提供 teammate mailbox 集成
- teleport: 提供远程会话创建
- ultraplan: 提供 CCR 事件流和计划批准

## 9. 改进建议

1. 实现 VerifyPlanExecutionTool，验证计划中的步骤是否都完成，没有做计划外的危险操作
2. 增加工作区 sparse checkout 测试覆盖
3. 简化 `.worktreeinclude` 目录展开逻辑或增加更多边界情况测试
4. 实现暂态工作树定期清理调用，或让用户配置 cutoff 时间
5. 在 EnterPlanMode 后提示用户使用 EnterWorktree 执行，或在 UX 层面引导流程
6. 增加工作区之间的变更比较功能，方便对比主工作区和工作区的差异
7. 实现工作区模板功能，支持预配置常用的工作区设置
8. 增加计划版本历史，支持查看和恢复之前版本的计划
9. 实现计划模板库，提供常见任务的计划模板
10. 增加工作区活动日志，记录在工作区中的关键操作
