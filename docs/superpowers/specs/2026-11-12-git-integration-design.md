---
id: git-integration
batch: 3
title: Git Integration 仓库状态、分支与 GitHub 集成设计
date: 2026-11-12
status: draft
---

# Git Integration 仓库状态、分支与 GitHub 集成设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Git 集成需要解决的核心问题是如何高效、安全地与 Git 仓库交互，包括仓库发现、分支管理、Diff 计算、Git Worktree 支持、GitHub 集成、凭据安全、提交归因等。同时需要处理跨平台差异，并在不干扰用户现有 Git 配置的情况下工作。

### 主要问题域

- **仓库发现与识别**：从任意目录向上查找 `.git`，支持普通仓库、Worktree、子模块、裸仓库
- **Git 状态与 Diff**：高效获取变更文件、计算 Diff、处理暂存区和工作区
- **分支与 Worktree**：分支切换、创建、Worktree 管理、跨 Worktree 状态同步
- **GitHub 集成**：PR 操作、Issue 提交、远程仓库识别
- **凭据与进程安全**：避免 Git 凭据提示、防止命令注入、保护敏感 Git 配置
- **提交归因**：跟踪 Claude 的代码贡献并附加到 git commit
- **错误降级**：Git 操作失败时优雅降级，不影响核心功能

### 调用方与责任边界

```
模型/用户请求
    ↓
Git 工具入口 (git.ts)
    ↓
gitFilesystem.ts (直接读取 Git 元数据)
    ↓
execFileNoThrow (执行 Git 命令)
    ↓
实际 Git 进程
```

### 实际约束

- **跨平台**：支持 macOS、Linux、Windows，包括 WSL 和 Git for Windows
- **性能**：频繁调用的操作（HEAD、分支）使用文件监控缓存，避免重复 spawn Git
- **安全**：Ref 名称验证、Git 配置路径限制、裸仓库检测与防护
- **兼容性**：支持 Git 2.x+，不依赖最新特性，处理浅克隆（shallow clone）
- **无侵入**：不修改用户的 Git 配置（除非明确配置），不自动提交

### 内部与外部差异

- CLI 有完整的 Worktree 工具和 GitHub App 集成；SDK 核心 Git 功能共享
- 凭据处理在不同环境（Web vs CLI）有差异
- 提交归因在外部构建中可禁用

## 2. 设计理由与备选方案

### 2.1 Git 仓库发现：从目录向上查找，LRU 缓存

**实际机制**：`findGitRoot` 从起始目录向上遍历，直到根目录，寻找 `.git` 目录或文件。使用 LRU 缓存（50 条目）避免重复 stat 调用。

**为什么采用**：
- 向上查找符合 Git 自身行为（`git rev-parse --show-toplevel`）
- LRU 缓存避免编辑多个文件时重复调用
- 识别 `.git` 文件（Worktree/子模块）和目录（普通仓库）

**备选方案及不采用原因**：
- 直接调用 `git rev-parse --show-toplevel`：需要 spawn 进程，性能差
- 只查找 `.git` 目录：不支持 Worktree 和子模块
- 无限缓存：内存泄漏风险

**代价**：需要处理符号链接（如 macOS `/tmp` → `/private/tmp`），需要规范化路径。

**证据**：`git.ts` findGitRoot 函数。

---

### 2.2 Git 元数据读取：直接文件访问而非 Git 命令

**实际机制**：`gitFilesystem.ts` 直接读取 `.git/HEAD`、`.git/refs/`、`.git/packed-refs`、`.git/config` 解析 Git 状态，不 spawn Git 进程。使用 `GitFileWatcher` 监听文件变化，缓存值失效时重新读取。

**为什么采用**：
- 性能：避免进程 spawn 开销（~15ms × 频繁调用 = 显著延迟）
- 安全：不执行可能触发钩子的 Git 命令
- 可靠：不依赖 Git 输出格式变化

**备选方案及不采用原因**：
- 始终用 Git 命令：性能差，可能触发钩子
- 用 libgit2：Node.js 原生模块编译复杂，跨平台维护成本高
- 只读不缓存：重复读取开销大

**代价**：需要正确实现 Git 格式解析（如 packed-refs 格式、symref 解析、Worktree 共同目录查找）。

**证据**：`gitFilesystem.ts` readGitHead、resolveRef、parseGitConfigValue。

---

### 2.3 Ref 名称验证：白名单过滤防止注入

**实际机制**：`isSafeRefName` 验证从 Git 读取的 ref 名称，只允许 `[a-zA-Z0-9/._+-]`，禁止 `..`、路径遍历、shell 元字符、前导 `-`/`/`。`isValidGitSha` 验证 SHA 为 40/64 位十六进制。

**为什么采用**：
- 防止攻击者通过 `.git/HEAD` 注入路径遍历或 shell 命令
- Git 自身的 ref 格式更宽松，我们需要更严格以适应代码使用场景

**备选方案及不采用原因**：
- 完全信任 Git 输出：攻击者控制的仓库可以通过 `.git/HEAD` 进行注入
- 转义而非验证：容易漏掉某些字符，白名单更安全

**代价**：某些合法但罕见的 ref 名称可能被拒绝。

**证据**：`gitFilesystem.ts` isSafeRefName、isValidGitSha。

---

### 2.4 Worktree 解析：验证双向链接防止伪造

**实际机制**：`resolveCanonicalRoot` 解析 Worktree 时验证：
1. `.git` 文件 → `gitdir: ...` 指向的目录包含 `commondir`
2. `commondir` 指向的目录下有 `worktrees/<name>/gitdir` 回指原 Worktree
3. 两条路径都通过 realpath 规范化

**为什么采用**：
- 防止攻击者通过构造 `.git` 和 `commondir` 指向任意位置，绕过信任对话框
- 确保 Worktree 确实由 `git worktree add` 创建，不是伪造的

**备选方案及不采用原因**：
- 完全信任 `.git` 文件内容：安全风险高
- 不支持 Worktree：功能受限

**代价**：解析逻辑复杂，需要处理多种边缘情况（子模块 vs Worktree、符号链接）。

**证据**：`git.ts` resolveCanonicalRoot。

---

### 2.5 Diff 计算：先 --shortstat 探测，再按需加载详细信息

**实际机制**：`fetchGitDiff` 先用 `git diff --shortstat` 获取总变更量（O(1) 内存），如果文件太多跳过详细解析；然后用 `--numstat` 获取按文件统计；最后按需用 `fetchGitDiffHunks` 获取实际 diff hunks。

**为什么采用**：
- 性能：避免在大型变更（如 `node_modules` 提交）时加载 MB 级 diff
- 内存安全：限制单文件大小、总文件数、每文件行数

**备选方案及不采用原因**：
- 始终加载完整 diff：内存风险大
- 完全不解析 diff：功能受限

**代价**：需要多次 Git 调用，需要处理 transient git 状态（merge/rebase/cherry-pick）。

**证据**：`gitDiff.ts` fetchGitDiff、parseShortstat。

---

### 2.6 Worktree 创建：快速路径恢复已存在 Worktree

**实际机制**：`getOrCreateWorktree` 先尝试直接读取目标路径的 `.git` 指针文件，如果存在且有效，直接返回（跳过 fetch 和创建）；否则才执行 fetch + `git worktree add`。

**为什么采用**：
- 性能：恢复已有 Worktree 时无需网络、无需 Git 命令
- 避免凭据提示：跳过 fetch 避免触发 Git 凭据提示

**备选方案及不采用原因**：
- 每次都重新创建：慢，可能破坏未提交更改
- 每次都 fetch：可能挂起等待凭据

**代价**：需要直接解析 `.git` 指针文件，不能依赖 Git 命令。

**证据**：`worktree.ts` getOrCreateWorktree。

---

### 2.7 Worktree 安全性：slug 验证防止路径遍历

**实际机制**：`validateWorktreeSlug` 验证 Worktree 名称：
- 长度 ≤ 64
- 不含 `.` 或 `..` 段
- 只允许 `[a-zA-Z0-9._-]`（`/` 被展平为 `+`）
- 不允许绝对路径

**为什么采用**：
- 防止通过 Worktree 名称遍历到 `.claude/worktrees/` 之外
- 防止 Git ref 名称冲突（`worktree-<slug>` 分支名）

**备选方案及不采用原因**：
- 完全由用户控制：安全风险高
- 随机生成名称：用户体验差

**代价**：需要展平嵌套 slug（`user/feature` → `user+feature`），需要验证两次（入口和内部）。

**证据**：`worktree.ts` validateWorktreeSlug、flattenSlug。

---

### 2.8 凭据安全：禁用 Git 凭据提示和 AskPass

**实际机制**：Git 命令执行时设置：
- `GIT_TERMINAL_PROMPT=0`
- `GIT_ASKPASS=`（空）
- `stdin: 'ignore'`

**为什么采用**：
- 防止 Git 等待用户输入凭据导致 CLI 挂起
- 在非交互环境下安全降级

**备选方案及不采用原因**：
- 允许提示：用户体验差，可能挂起
- 总是提供凭据：需要存储/管理凭据，复杂度高

**代价**：需要用户事先配置好 Git 凭据，某些操作（如 fetch）可能失败。

**证据**：`worktree.ts` GIT_NO_PROMPT_ENV。

---

### 2.9 裸仓库防护：检测并防止当前目录作为裸仓库

**实际机制**：`isCurrentDirectoryBareGitRepo` 检测：
1. 检查是否有 `.git` 但无效（如 `.git/HEAD` 不是文件）
2. 检查当前目录是否有 `HEAD`、`objects/`、`refs/`（裸仓库标志）

**为什么采用**：
- 防止攻击者构造目录诱导 Git 执行钩子
- Git 的 `is_git_directory()` 逻辑会把有这些文件的目录当作 Git 仓库

**备选方案及不采用原因**：
- 完全信任 Git：安全风险高
- 禁止在裸仓库工作：功能受限

**代价**：需要同步 Git 的检测逻辑，可能滞后于 Git 版本变化。

**证据**：`git.ts` isCurrentDirectoryBareGitRepo。

---

### 2.10 提交归因：跟踪贡献并附加到 commit trailer，可选择性暴露内部模型名

**实际机制**：
- `commitAttribution.ts` 跟踪文件变更（通过 Edit/Write 工具钩子）
- 计算 Claude 贡献的字符数（通过前缀/后缀匹配识别变化区域）
- `formatAttributionTrailer` 生成 Git commit trailer（Co-Authored-By、Claude-Model 等）
- `isInternalModelRepo` 通过远程 URL 白名单控制是否暴露内部模型代号

**为什么采用**：
- 正确归因 Claude 的贡献
- 保护内部模型代号不在公共仓库泄露

**备选方案及不采用原因**：
- 完全不跟踪：无法归因
- 总是暴露模型名：有泄露风险

**代价**：需要维护内部仓库白名单，需要处理重命名/删除等复杂变更。

**证据**：`commitAttribution.ts`、`attributionTrailer.ts`、`attributionHooks.ts`。

---

### 2.11 错误降级：Git 操作失败时返回 null/默认值

**实际机制**：Git 相关函数大多用 `try/catch` 包裹，失败时返回 null/默认值（如 `getBranch` 失败返回 `'HEAD'`）。

**为什么采用**：
- Git 不是核心功能必须 100% 可用
- 避免单个 Git 错误中断整个会话

**备选方案及不采用原因**：
- 抛出异常：用户体验差
- 静默失败但不记录：难以调试

**代价**：需要在调用方处理 null 返回值。

**证据**：`git.ts` getGitState、`gitFilesystem.ts` 各函数。

## 3. 目标与非目标

### 目标

- **高效仓库发现**：通过向上遍历 + LRU 缓存快速定位 Git 根
- **安全 Git 交互**：Ref 验证、路径限制、裸仓库防护、凭据提示禁用
- **高性能状态读取**：直接文件访问 + 文件监控缓存
- **Worktree 支持**：创建、恢复、隔离、清理
- **可靠 Diff 计算**：分阶段加载、大小限制、内存安全
- **GitHub 集成**：PR 解析、远程 URL 标准化、仓库哈希
- **提交归因**：跟踪贡献、附加 trailer、保护内部模型名
- **优雅降级**：Git 失败不影响核心功能

### 非目标

- **不替代 Git CLI**：只提供常用操作的封装，完整 Git 操作通过 BashTool
- **不实现 Git 协议**：只调用系统 Git，不自己实现 Git 网络协议
- **不管理 Git 凭据**：不存储/刷新 Git 凭据，依赖系统 Git 配置
- **不处理 Git 冲突**：冲突解决由用户通过 Git 工具完成
- **不完整的 Worktree 工具**：核心功能独立（commit attribution、worktree），不在此 spec 覆盖范围内

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

**Git 工具主入口**：
```typescript
// 仓库发现
findGitRoot(startPath: string): string | null
findCanonicalGitRoot(startPath: string): string | null
getIsGit(): Promise<boolean>

// 状态读取
getHead(): Promise<string>
getBranch(): Promise<string>
getDefaultBranch(): Promise<string>
getRemoteUrl(): Promise<string | null>
getGitState(): Promise<GitRepoState | null>
getIsClean(options?: { ignoreUntracked?: boolean }): Promise<boolean>

// Diff
fetchGitDiff(): Promise<GitDiffResult | null>
fetchGitDiffHunks(): Promise<Map<string, StructuredPatchHunk[]>>
fetchSingleFileGitDiff(absoluteFilePath: string): Promise<ToolUseDiff | null>

// Worktree
createWorktreeForSession(sessionId: string, slug: string, tmuxSessionName?: string, options?: { prNumber?: number }): Promise<WorktreeSession>
cleanupWorktree(): Promise<void>
keepWorktree(): Promise<void>
```

**Git Filesystem 入口**：
```typescript
resolveGitDir(startPath?: string): Promise<string | null>
readGitHead(gitDir: string): Promise<{ type: 'branch'; name: string } | { type: 'detached'; sha: string } | null>
resolveRef(gitDir: string, ref: string): Promise<string | null>
parseGitConfigValue(gitDir: string, section: string, subsection: string | null, key: string): Promise<string | null>
getCommonDir(gitDir: string): Promise<string | null>
isShallowClone(): Promise<boolean>
```

**GitHub 集成入口**：
```typescript
parseGitRemote(remoteUrl: string): { host: string; owner: string; name: string } | null
normalizeGitRemoteUrl(url: string): string | null
getRepoRemoteHash(): Promise<string | null>
```

**提交归因入口**：
```typescript
trackFileModification(state: AttributionState, filePath: string, oldContent: string, newContent: string, userModified: boolean, mtime?: number): AttributionState
calculateCommitAttribution(states: AttributionState[], stagedFiles: string[]): Promise<AttributionData>
formatAttributionTrailer(attribution: AttributionData, modelName: string): string
isInternalModelRepo(): Promise<boolean>
```

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
| --- | --- | --- | --- | --- |
| `git.ts` | findGitRoot LRU 缓存、resolveCanonicalRoot LRU 缓存 | 仓库发现、分支/状态读取、远程 URL、Git 命令执行 | Git 元数据解析（由 gitFilesystem 承担） | 调用 gitFilesystem、execFileNoThrow |
| `gitFilesystem.ts` | GitFileWatcher 缓存（branch、head、remoteUrl、defaultBranch） | 解析 Git HEAD/refs/config、文件监控、ref 验证 | Git 命令执行（由 git.ts 承担） | 被 git.ts 调用 |
| `gitDiff.ts` | 无（纯函数） | 解析 Git diff、统计、hunks | Git 命令执行 | 被 git.ts 调用 |
| `worktree.ts` | currentWorktreeSession | 验证 slug、创建/恢复/清理 Worktree、tmux 集成、代理 Worktree 清理 | Git 凭据管理 | 调用 git.ts、hooks.ts、commit attribution |
| `github/ghAuthStatus.ts` | 无 | GitHub 认证状态 | GitHub API 调用 | 独立模块 |
| `commitAttribution.ts` | AttributionState（fileStates、sessionBaselines、promptCount） | 跟踪文件变更、计算贡献百分比 | Git 命令执行 | 被 hooks 调用、调用 git.ts、generatedFiles |
| `attributionTrailer.ts` | 无（纯函数） | 格式化 commit trailer | 实际提交 | 被 commit attribution 调用 |
| `attributionHooks.ts` | 无 | 安装 prepare-commit-msg 钩子 | 钩子执行 | 被 worktree 调用 |

### 4.3 GitFileWatcher 缓存机制

```typescript
GitFileWatcher {
  gitDir: string | null
  commonDir: string | null
  watchedPaths: string[]
  branchRefPath: string | null
  cache: Map<string, { value: any; dirty: boolean; compute: () => Promise<any> }>
}
```

文件监听与失效流程：
1. `ensureStarted()` 解析 gitDir 和 commonDir
2. 监听 `gitDir/HEAD` → 变更时触发 `onHeadChanged()`，标记所有缓存 dirty
3. 监听 `commonDir/config` → 变更时标记所有缓存 dirty
4. `onHeadChanged()` 等待 scroll idle，然后更新当前分支 ref 的监听
5. `get(key, compute)` 检查 dirty 标志，脏则重新计算

### 4.3 主控制流

**仓库发现流程**：
```
findGitRoot(startPath)
    → 检查 LRU 缓存
    → 未命中则从 startPath 向上遍历
    → 对每个目录检查 join(dir, '.git') 是目录或文件
    → 找到则规范化路径并缓存
    → 未找到则缓存 GIT_ROOT_NOT_FOUND
```

**分支与 HEAD 读取流程**：
```
getBranch() / getHead()
    → GitFileWatcher.get('branch' / 'head', compute)
    → 检查 dirty 标志
    → 脏则 resolveGitDir → readGitHead → resolveRef
    → 返回缓存值或重新计算
    → 文件变更时自动失效
```

**Diff 计算流程**：
```
fetchGitDiff()
    → 检查 isInTransientGitState（merge/rebase/cherry-pick）
    → git diff --shortstat 探测
    → 文件太多？只返回统计，跳过详情
    → git diff --numstat 获取按文件统计
    → git ls-files --others --exclude-standard 获取 untracked
    → 返回 GitDiffResult（无 hunks）
fetchGitDiffHunks()（按需）
    → git diff HEAD
    → 解析 hunks，应用大小/行数限制
    → 返回 Map<path, hunks[]>
```

**Worktree 创建流程**：
```
createWorktreeForSession(slug)
    → validateWorktreeSlug
    → 有 WorktreeCreate hook？执行 hook 并返回
    → 否则 findCanonicalGitRoot
    → getOrCreateWorktree()
        → 尝试读取目标路径 .git 指针 → 存在则直接返回
        → 不存在则 mkdir worktrees/
        → 有 prNumber？fetch origin pull/<n>/head
        → 无 prNumber？检查 origin/<default> 是否在本地，是则跳过 fetch
        → git worktree add -B worktree-<slug> <path> <ref>
        → 有 sparsePaths？git sparse-checkout set && git checkout
    → performPostCreationSetup()
        → 复制 settings.local.json
        → 配置 core.hooksPath（可选）
        → 符号链接目录（可选）
        → 复制 .worktreeinclude 文件
        → 安装 attribution 钩子（可选）
    → 保存 currentWorktreeSession
```

**提交归因流程**：
```
Edit/Write 工具执行完成
    → attributionHook.trackFileModification
    → 计算前缀/后缀匹配，识别变化区域
    → 更新 AttributionState.fileStates
Git commit 前
    → attributionHooks 读取 staged files
    → calculateCommitAttribution()
        → 合并多个会话的状态
        → 对每个 staged file，比较 baseline vs 当前
        → 排除 generated files
        → 计算 Claude%、human%
    → formatAttributionTrailer()
        → 检查 isInternalModelRepo() 决定模型名
        → 生成 Co-Authored-By、Claude-Model 等 trailer
    → 写入 Git commit message
```

### 4.4 关键数据结构

**GitRepoState**：
```typescript
{
  commitHash: string
  branchName: string
  remoteUrl: string | null
  isHeadOnRemote: boolean
  isClean: boolean
  worktreeCount: number
}
```

**GitDiffResult**：
```typescript
{
  stats: { filesCount: number; linesAdded: number; linesRemoved: number }
  perFileStats: Map<string, { added: number; removed: number; isBinary: boolean; isUntracked?: boolean }>
  hunks: Map<string, StructuredPatchHunk[]>
}
```

**WorktreeSession**：
```typescript
{
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
```

**AttributionState**：
```typescript
{
  fileStates: Map<string, { contentHash: string; claudeContribution: number; mtime: number }>
  sessionBaselines: Map<string, { contentHash: string; mtime: number }>
  surface: string
  startingHeadSha: string | null
  promptCount: number
  promptCountAtLastCommit: number
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  escapeCount: number
  escapeCountAtLastCommit: number
}
```

### 4.5 跨子系统依赖

| 依赖 | 用途 | 所属 spec |
| --- | --- | --- |
| `execFileNoThrow` | 执行 Git 命令 | shell-tools |
| `hooks.ts` | WorktreeCreate/WorktreeRemove hooks | hooks |
| `generatedFiles.ts` | 提交归因时排除生成文件 | file-tools |
| `permissions/bashPermissions.ts` | Git 命令权限检查（通过 BashTool） | shell-tools |
| `settings.ts` | 读取 Worktree 配置（sparsePaths、symlinkDirectories） | settings |
| `model/model.ts` | 模型名规范化用于归因 | model-api |

## 5. 失败语义与工程取舍

### 5.1 失败语义表

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
| --- | --- | --- | --- | --- | --- |
| 不是 Git 仓库 | findGitRoot 返回 null | 静默降级，无异常 | 否 | 无 | 返回 null/默认值（如 getBranch 返回 'HEAD'） |
| Git 命令执行失败 | execFileNoThrow 返回 code ≠ 0 | 静默降级，无异常 | 否 | 无 | 返回 null/默认值 |
| Git 元数据解析失败 | readGitHead/resolveRef 异常 | 捕获后返回 null | 否 | 无 | 返回 null |
| Ref 名称验证失败 | isSafeRefName 返回 false | 静默忽略该 ref | 否 | 无 | 返回 null |
| Transient Git 状态（merge/rebase/cherry-pick） | isInTransientGitState 检查 | 静默跳过 diff | 否 | 无 | fetchGitDiff 返回 null |
| Worktree slug 验证失败 | validateWorktreeSlug | 抛出异常 | 否 | 无（操作前验证） | 异常传播 |
| Worktree 创建失败 | git worktree add 失败 | 抛出异常 | 否 | 清理部分创建的 worktree（sparse checkout 失败路径） | 异常传播 |
| Git 凭据提示被禁用 | GIT_TERMINAL_PROMPT=0 | Git 命令失败 | 否 | 无 | Git 命令返回错误，上层降级 |
| Shallow clone | isShallowClone 检查 | 问题提交时降级到 HEAD-only 模式 | 否 | 无 | preserveGitStateForIssue 使用简化模式 |
| 提交归因计算失败 | calculateCommitAttribution 异常 | 捕获后返回空 attribution | 否 | 无 | 提交时不附加 trailer |

### 5.2 主要工程取舍

| 取舍 | 当前选择 | 代价 | 收益 |
| --- | --- | --- | --- |
| 直接文件读取 vs Git 命令 | 优先直接文件读取，缓存 + 监听 | 需要实现 Git 格式解析 | 性能提升显著，避免进程开销 |
| LRU 缓存 vs 无缓存 | 50 条目 LRU | 内存占用，路径规范化复杂度 | 避免重复 stat/读取 |
| Ref 白名单验证 vs 信任 Git | 严格白名单 | 某些罕见 ref 可能被拒 | 防止注入攻击 |
| Worktree 双向验证 vs 信任指针 | 双向验证 | 解析逻辑复杂 | 防止伪造 Worktree 攻击 |
| Diff 分阶段加载 vs 一次性加载 | 先 shortstat 探测，按需 hunks | 多次 Git 调用 | 内存安全，避免大 diff 崩溃 |
| 禁用凭据提示 vs 允许提示 | 禁用提示 | 某些网络操作可能失败 | 防止 CLI 挂起 |
| 静默降级 vs 抛出异常 | 大多失败时降级 | 问题可能不易发现 | Git 失败不影响核心功能 |
| 内部模型名白名单 vs 总是暴露 | 白名单控制 | 需要维护列表 | 防止内部代号泄露 |

## 6. 现状验收标准

以下验收可独立验证当前行为，与第 4、5 节对应：

1. **仓库发现验收**：
   - 给定有 `.git` 目录的目录，`findGitRoot` 返回该目录
   - 给定 Worktree（`.git` 是文件），`findGitRoot` 返回 Worktree 根
   - 给定在 Git 仓库外的目录，返回 null
   - 缓存命中时不重新 stat 目录

2. **Git 状态读取验收**：
   - 给定在分支上，`getBranch` 返回分支名，`getHead` 返回 SHA
   - 给定 detached HEAD，`getBranch` 返回 `'HEAD'`，`getHead` 返回 SHA
   - 修改 `.git/HEAD`，缓存会失效并重新读取

3. **Diff 计算验收**：
   - 给定有变更的仓库，`fetchGitDiff` 返回统计信息
   - 给定 merge 进行中，`fetchGitDiff` 返回 null
   - 给定超大 diff，只返回统计不返回 hunks

4. **Worktree 验收**：
   - 给定有效 slug，`createWorktreeForSession` 创建 Worktree
   - 给定已存在的 Worktree，快速恢复不重新 fetch
   - 给定含 `..` 的 slug，验证失败抛出异常
   - cleanup 时删除 Worktree 和临时分支

5. **安全验收**：
   - 给定含路径遍历的 ref，`isSafeRefName` 返回 false
   - 给定裸仓库布局的目录，`isCurrentDirectoryBareGitRepo` 返回 true
   - Git 命令执行时设置 `GIT_TERMINAL_PROMPT=0`

6. **提交归因验收**：
   - 给定文件被 Claude 修改，`trackFileModification` 记录贡献
   - 给定在内部仓库，trailer 包含内部模型名
   - 给定在外部仓库，trailer 只包含公共模型名

## 7. 代码与测试证据

### 7.1 核心模块证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
| --- | --- | --- | --- |
| 仓库发现与 LRU 缓存 | `src/utils/git.ts` findGitRoot、createFindGitRoot | 需补充 | 最大 50 条缓存 |
| Worktree 双向验证 | `src/utils/git.ts` resolveCanonicalRoot | 需补充 | 只验证 Git 创建的 Worktree 结构 |
| Git 元数据直接读取与监听 | `src/utils/git/gitFilesystem.ts` GitFileWatcher、readGitHead、resolveRef | 需补充 | packed-refs 以外的 ref 存储（如 reftable）未支持 |
| Ref/SHA 验证 | `src/utils/git/gitFilesystem.ts` isSafeRefName、isValidGitSha | 需补充 | 白名单可能拒绝某些合法但罕见的 ref |
| Diff 解析与限制 | `src/utils/gitDiff.ts` fetchGitDiff、parseGitDiff、parseShortstat | 需补充 | 最大文件大小、最大行数、最大文件数限制 |
| Worktree 创建与恢复 | `src/utils/worktree.ts` getOrCreateWorktree、validateWorktreeSlug | 需补充 | hook-based worktree 行为由外部 hook 定义 |
| Worktree 清理与 stale 回收 | `src/utils/worktree.ts` cleanupWorktree、cleanupStaleAgentWorktrees | 需补充 | 只回收匹配 ephemeral 模式的 Worktree |
| 提交归因跟踪与计算 | `src/utils/commitAttribution.ts` trackFileModification、calculateCommitAttribution | 需补充 | 生成文件被排除；重命名/复制跟踪有限 |
| 内部模型名白名单 | `src/utils/commitAttribution.ts` isInternalModelRepo、INTERNAL_MODEL_REPOS | 需补充 | 白名单需要手动维护 |
| 裸仓库防护 | `src/utils/git.ts` isCurrentDirectoryBareGitRepo | 需补充 | 只检测当前 Git 版本的裸仓库标志 |

### 7.2 现有测试列表

- 需补充查找 Git 相关测试

### 7.3 边界与未覆盖

- 浅克隆（shallow clone）某些操作受限
- reftable ref 存储未支持（Git 新版本）
- Windows 路径规范化某些边缘情况
- 并发 Git 操作（如同时在多个 Worktree 执行 Git）
- Git LFS 大文件处理
- 子模块递归操作

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/git-integration.yaml)

### 8.1 本 spec 主拥有的文件组

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
| --- | --- | --- | --- |
| git-core | Git 仓库发现、远程 URL、状态读取、裸仓库防护 | 需补充 | 不拥有 |
| git-filesystem | Git 元数据直接读取、文件监控缓存、ref 验证 | 需补充 | 不拥有 |
| git-diff | Git diff 解析、统计、hunks、单文件 diff | 需补充 | 不拥有 |
| worktree | Worktree 创建/恢复/清理、slug 验证、tmux 集成、stale 回收 | 需补充 | 不拥有 |
| github-integration | GitHub 远程 URL 解析、仓库哈希、认证状态 | 需补充 | 不拥有 |
| commit-attribution | 提交贡献跟踪、计算、trailer 格式化、钩子集成 | 需补充 | 不拥有 |

### 8.2 相关子系统

- **shell-tools**：Git 命令执行最终通过 BashTool/execFileNoThrow；本 spec 覆盖 Git 特定部分
- **file-tools**：文件读写操作，与提交归因集成
- **settings**：Worktree 配置（sparsePaths、symlinkDirectories）
- **hooks**：WorktreeCreate/WorktreeRemove 钩子
- **model-api**：模型名规范化用于提交归因
- **commit attribution**（独立域）：只引用，不详细覆盖
- **worktree 工具**（独立域）：只引用，不详细覆盖

## 9. 改进建议

### 9.1 P1：Git 操作超时与取消

**触发场景与证据**：当前 Git 命令执行（除 gitDiff 外）没有超时，网络操作（如 fetch）可能长时间挂起。

**建议方向**：
- 为 Git 命令统一设置合理超时（如 30s）
- 支持 AbortController 取消进行中的 Git 操作

**回归风险**：低，新增参数，默认行为不变。

**验收方式**：模拟慢 Git 操作，验证超时/取消生效。

**工作量**：M。

**置信度**：设计推断。

---

### 9.2 P2：Git 操作批处理与合并

**触发场景与证据**：当前多个独立 Git 调用（如 getGitState 并行调用多个命令）可以合并为更少的调用。

**建议方向**：
- 将多个状态读取合并为单个 Git 命令脚本
- 批量获取多个文件的 diff 信息

**回归风险**：中，需要确保合并后的输出解析正确。

**验收方式**：性能基准测试，验证行为一致。

**工作量**：M。

**置信度**：设计推断。

---

### 9.3 P2：更完整的子模块支持

**触发场景与证据**：当前对子模块的支持有限（findGitRoot 可以识别，但 diff/status 等操作不区分子模块）。

**建议方向**：
- 正确识别子模块边界
- 子模块变更的 diff 处理
- 子模块路径的权限检查

**回归风险**：中，需要修改 diff/状态解析逻辑。

**验收方式**：在含子模块的仓库验证行为正确。

**工作量**：M。

**置信度**：设计推断。

---

### 9.4 P3：Git 操作事件与可观察性

**触发场景与证据**：当前 Git 失败多静默降级，问题诊断困难。

**建议方向**：
- 记录 Git 操作事件（成功/失败、耗时）
- 暴露 Git 操作统计给用户/调试工具
- 关键失败时提供更明确的反馈

**回归风险**：低，主要是新增观测点。

**验收方式**：验证事件被正确记录，反馈清晰。

**工作量**：S。

**置信度**：设计推断。
