---
id: commit-attribution
batch: 3
title: Commit Attribution 提交归因与提交元数据设计
date: 2026-11-12
status: draft
---

# Commit Attribution 提交归因与提交元数据设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

当用户使用 Claude 编辑文件后执行 `git commit` 时，需要将 Claude 的贡献以标准、可追溯的方式附加到提交记录中，同时不破坏用户现有 Git 工作流、不泄露内部模型代号、不因归因失败阻塞提交。

如果没有当前设计：
- 无法区分 Claude vs 人类的代码贡献
- 可能在公共仓库意外泄露内部模型代号
- prepare-commit-msg 钩子可能破坏用户现有钩子
- 归因失败可能阻塞正常提交
- 会话恢复时可能重复计数导致归因数据爆炸

因此本子系统必须在以下约束下完成提交归因职责：

### 约束
- **Git 兼容性**：必须与用户现有 prepare-commit-msg 钩子共存，支持 core.hooksPath
- **安全性**：内部模型名只在白名单仓库暴露；不执行不受信任的 Git 钩子；敏感数据不写入公开 commit message
- **幂等性**：多次运行归因不重复计数；失败后可安全重试
- **跨平台**：支持 macOS（含 `/tmp` → `/private/tmp`）、Linux、Windows
- **性能**：跟踪变更开销可忽略；不阻塞工具执行；准备提交时快速计算
- **降级**：归因失败不影响正常提交；只记录可安全计算的统计
- **内部/外部差异**：外部构建可禁用完整归因；只保留最小 Co-Authored-By 功能

### 责任边界
- **调用方**：Edit/Write 工具钩子、Bash 工具钩子、prepare-commit-msg 独立入口、会话恢复
- **被调用方**：Git（`git diff`、`git interpret-trailers`）、会话存储、文件系统
- **不承担**：不负责实际提交创建（由用户或 Git 完成）；不负责 Git 凭据管理；不负责完整 Git 历史归因

## 2. 设计理由与备选方案

### 2.1 文件变更跟踪：公共前缀/后缀匹配而非完整 diff

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 变更区域识别：前缀/后缀匹配而非 diff 算法 | 从 oldContent 和 newContent 两端同时扫描，找到最长公共前缀和后缀，中间部分视为变更区域 | 简单、O(n)、无外部依赖、适用于 Edit/Write 工具的精确内容场景；避免了 Myers diff 的复杂度和边缘情况 | 使用完整 diff 库（如 diff-match-patch）：依赖重，且对于精确替换场景收益不大；使用 Git diff：需要写入文件再读回，性能差 | 需要处理空文件、全文件替换、同长度替换等边界情况 | src/utils/commitAttribution.ts computeFileModificationState |
| Claude 贡献单位：字符而非行 | 累加每次变更的字符数（取 old 和 new 变更区域的较大值），而非行数 | 字符级比行级更精确；适合小修改（如重命名变量、调整参数）；与最终提交的 diff 统计解耦 | 使用行数：小修改（如把 `Esc` 改成 `esc`）会被计为 0；与最终 diff 解耦意味着即使人类后续调整同一行，Claude 的贡献仍被记录 | 字符累加会导致多次编辑同一位置时计数“膨胀”；不考虑删除后重新添加 | src/utils/commitAttribution.ts computeFileModificationState, trackFileModification |
| 会话基线：只记录首次观察到的状态 | sessionBaselines 记录文件第一次被跟踪时的 contentHash 和 mtime；后续编辑不会更新基线 | 用于最终计算“从会话开始到提交，Claude 贡献了多少”；避免基线漂移 | 每次编辑都更新基线：会丢失从会话开始的净变化；不保存基线：无法区分 Claude vs 人类在会话期间的变更 | 基线只在第一次接触文件时保存，后续变更不会覆盖 | src/utils/commitAttribution.ts trackFileModification, attributionHooks.ts preBash |

---

### 2.2 多会话归因状态管理：按会话隔离，提交时合并

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 会话隔离状态：每个会话独立 AttributionState | AttributionState 包含 fileStates、sessionBaselines、surface、startingHeadSha、promptCount 等；每个会话有自己的状态 | 避免跨会话污染；支持同时运行多个 Claude 实例；会话恢复时只加载自己的历史 | 全局单例：多实例冲突；无法区分不同会话的贡献 | 需要在 prepare-commit-msg 时读取并合并多个会话的状态 | src/utils/commitAttribution.ts createEmptyAttributionState, AttributionState type |
| Git 侧持久化：按会话 ID 保存 JSON，64 会话上限 | persistAttributionStateForGit 将快照写入 `.git/claude-code/attribution/<sha256(sessionId)>.json`；runPrepareCommitMsgAttribution 读取前 64 个（按文件名排序） | Git 仓库内持久化，跨 Claude 重启可用；按会话隔离；上限防止无限增长 | 写入 `.claude/` 目录：可能在 Git 仓库外；写入数据库：依赖重；无限保留：磁盘泄漏风险 | 上限 64 个会话；文件权限 0o600；目录权限 0o700 | src/utils/postCommitAttribution.ts persistAttributionStateForGit, readAttributionStates |
| 快照恢复：只取最后一个快照，不跨快照累加 | restoreAttributionStateFromSnapshots 接收多个快照，但只恢复最后一个的内容 | 每个快照是完整状态（不是增量）；累加会导致计数爆炸（历史观察：837 快照 × 280 文件 → 1.15 万亿字符） | 累加所有快照：会导致二次方膨胀；取最早快照：会丢失中间编辑 | 文档化说明快照是完整状态，不是增量 | src/utils/commitAttribution.ts restoreAttributionStateFromSnapshots, stateToSnapshotMessage |

---

### 2.3 Git 钩子安装：无侵入式调度器，保留用户钩子

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| prepare-commit-msg 调度器：先运行用户钩子，再运行我们的逻辑 | 安装的钩子脚本包含 `MANAGED_MARKER`；先执行 `prepare-commit-msg.claude-user`（如果存在），再用 `node <cli> --internal-prepare-commit-msg-attribution` 运行归因逻辑；用户原始钩子在安装时被重命名为 `.claude-user` | 无侵入：保留用户现有钩子；可卸载：恢复到原始状态；幂等：多次安装安全 | 直接覆盖用户钩子：破坏用户工作流；只附加钩子内容：难以卸载，可能冲突；使用 Git 配置 `commit.template`：不支持动态 trailers | 需要处理钩子可执行权限；需要处理原子替换；需要锁防止并发安装 | src/utils/postCommitAttribution.ts installPrepareCommitMsgHook, dispatcher |
| 内部入口独立：不加载完整 CLI，不触发递归钩子 | `--internal-prepare-commit-msg-attribution` 是特殊入口，只加载归因最小依赖，不注册钩子，不启动完整 CLI | 性能：启动快；安全：不触发递归钩子安装；隔离：不依赖完整会话状态 | 复用主 CLI 入口：启动慢，可能触发递归钩子安装 | 内部入口通过 process.argv[1] 检测，不暴露给用户 | src/utils/postCommitAttribution.ts runPrepareCommitMsgAttribution, PREPARE_COMMIT_MSG_ATTRIBUTION_FLAG |
| 钩子安装幂等：检查 marker，保留用户钩子 | 安装时先读取现有钩子，检查是否包含 `MANAGED_MARKER`；如果是未管理的用户钩子，先重命名为 `.claude-user`，再写入调度器；原子写入（tmp + rename）防止部分写入 | 多次运行安全；不丢失用户钩子；并发安装时通过锁保护 | 每次都覆盖：破坏用户钩子；无锁：并发安装可能竞争 | 使用 lockfile（目录锁）保护安装/卸载 | src/utils/postCommitAttribution.ts installPrepareCommitMsgHook, atomicWrite, lock |

---

### 2.4 元数据安全性：内部模型名白名单，公开数据无路径

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 内部模型名白名单：只在允许的仓库暴露 | `isInternalModelRepo` 检查 Git 远程 URL 是否匹配 `INTERNAL_MODEL_REPOS`（如 `github.com/anthropics/*` 私有仓库）；匹配则使用内部模型名，否则使用公共名称（如 `claude-opus-4-6`） | 防止内部代号在公共仓库泄露；白名单比自动检测更安全 | 自动检测“内部”：不可靠，可能误判；总是暴露：有泄露风险；总是隐藏：内部团队无法归因到具体模型 | 需要手动维护白名单；需要正确解析 SSH/HTTPS 两种 URL 格式 | src/utils/commitAttribution.ts isInternalModelRepo, INTERNAL_MODEL_REPOS, sanitizeModelName |
| 公开 Trailer 格式：只有统计，无路径、无会话 ID | `buildPRTrailers` 生成的 trailer 只包含：`Claude-Code-Contribution`（百分比）、`Claude-Code-Prompts`（次数）、`Claude-Code-Permission-Prompts`、`Claude-Code-Escapes`；完整 JSON 只存储在 Git notes 或会话存储（当前未实现 notes） | 公开 commit message 只包含匿名统计，无敏感信息；符合 Git trailer 规范；可被工具解析 | 在 commit message 中包含路径/文件名：可能泄露项目结构；包含会话 ID：无实际价值且可能追踪用户 | 公共 trailers 与完整归因数据分离 | src/utils/attributionTrailer.ts buildPRTrailers, postCommitAttribution.ts runPrepareCommitMsgAttribution |
| 非对称计数：只增不减，只记 Claude，人类通过排除计算 | `calculateCommitAttribution` 对 staged files：如果有 fileStates，Claude 字符 = 累加的贡献；如果无 fileStates 但有 baseline，human 字符 = 文件大小或 diff 大小；否则 human 字符 = 文件大小；百分比 = Claude / (Claude + Human) | 实现简单；不需要跟踪人类变更（因为无法 hook 人类编辑）；保守估计：无跟踪的都算作人类 | 可能高估 Claude 贡献（后续人类修改同一文件但 Claude 仍占 100%）；可能低估（Claude 生成但人类完全重写，仍算 Claude 贡献） | 权衡偏向于“宁可高估 Claude 贡献，不低估” | src/utils/commitAttribution.ts calculateCommitAttribution |

---

### 2.5 失败处理：静默降级，绝不阻塞提交

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| Git 瞬态状态检测：跳过归因 | `isGitTransientState` 检查 `.git/` 下是否存在 `rebase-merge`、`rebase-apply`、`MERGE_HEAD`、`CHERRY_PICK_HEAD`、`BISECT_LOG`；存在则跳过归因 | 避免在 merge/rebase/cherry-pick 中间修改 commit message；避免干扰 Git 自身流程 | 无论如何都尝试：可能在复杂 Git 操作中失败或生成错误信息 | 这些状态下归因被完全跳过 | src/utils/commitAttribution.ts isGitTransientState, postCommitAttribution.ts runPrepareCommitMsgAttribution |
| 钩子失败不阻塞：失败时只打印警告，继续提交 | `runPrepareCommitMsgAttribution` 中所有操作 try/catch；失败时打印 "Claude Code attribution was unavailable; continuing commit."，退出码 0 | 归因失败不应阻塞正常开发；用户提交优先于归因 | 失败时退出非 0：会导致 `git commit` 失败，用户体验差 | 归因是尽力而为 | src/utils/postCommitAttribution.ts runPrepareCommitMsgAttribution |
| 钩子清理：PostToolUseFailure 清理 Bash 跟踪状态 | `attributionHook` 有失败分支；`cleanupBashHook` 在 PostToolUseFailure 时从 `pendingBash` 中删除对应工具 ID 的 entry | 防止失败的 Bash 命令留下不完整状态；防止内存泄漏 | 不清理：`pendingBash` 会无限增长；下次运行可能读错误状态 | 只有 Bash 工具需要失败清理（因为有 pre/post 配对） | src/utils/attributionHooks.ts cleanupBashHook, registerAttributionHooks |

---

### 2.6 Bash 工具跟踪：pre 快照，post 差异，有界缓存

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| Bash 工具前快照：preBash 读取候选文件并缓存 | `preBash` 调用 `candidatePaths` 获取待跟踪文件（fileStates、sessionBaselines、git diff、git ls-files）；对每个文件调用 `readCandidate`（检查二进制、大小、规范化路径）；保存到 `pendingBash[toolUseId]` | Bash 可以修改任意文件，无法像 Edit/Write 工具那样直接知道变更内容；需要 pre 状态用于对比 | 不跟踪 Bash 变更：归因会漏记 Claude 通过 Bash 创建/修改的文件；总是读取所有文件：性能差 | 有候选文件范围、文件大小、总大小限制；二进制文件被跳过 | src/utils/attributionHooks.ts preBash, candidatePaths, readCandidate |
| Bash 工具后差异：postBash 对比 pre vs post，批量跟踪 | `postBash` 再次读取候选文件；对比 pendingBash 中的 pre 状态；对每个变更文件调用 `trackBulkFileChanges`；最后清理 pendingBash entry | 批量处理多个文件变更，性能更好；复用与 Edit/Write 相同的跟踪逻辑 | 逐个文件处理：重复 Map 复制，O(n²) 复杂度 | 批量处理避免了多次 Map 复制 | src/utils/attributionHooks.ts postBash, trackBulkFileChanges |
| 跟踪限制：MAX_CANDIDATE_FILES、MAX_FILE_BYTES、MAX_TOTAL_BYTES | MAX_CANDIDATE_FILES=200，MAX_FILE_BYTES=256KB，MAX_TOTAL_BYTES=2MB；超出的文件被标记为 incomplete，不跟踪 | 防止 Bash 工具修改大量文件/大文件时内存溢出；防止性能下降 | 无限制：可能 OOM 或严重卡顿 | 超出限制的文件不被跟踪，但不会报错 | src/utils/attributionHooks.ts MAX_CANDIDATE_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES |
| 缓存过期：定期 sweep 清理 | `sweepFileContentCache` 每 60s 运行一次；清理超过 15min 的 fileContentCache 条目；清理超过 5min 的 pendingBash 条目；trim 缓存到 MAX_CACHE_FILES=500 或 MAX_TOTAL_BYTES=2MB | 防止内存泄漏；防止陈旧缓存占用内存 | 不清理：内存无限增长；每次都清理：性能差 | 定时器 unref，不阻止进程退出 | src/utils/attributionHooks.ts sweepFileContentCache, clearAttributionCaches |

---

### 2.7 HEAD 协调：检测外部提交，推进计数器基线

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| startingHeadSha：会话首次检测到的 HEAD | `reconcileCommitBaseline` 在第一次工具运行时读取 HEAD 并保存到 `startingHeadSha`；后续检测到 HEAD 变化时，更新 `promptCountAtLastCommit`、`permissionPromptCountAtLastCommit`、`escapeCountAtLastCommit` 到当前值 | 用于判断是否有外部提交（用户自己执行了 git commit）；用于计算“自上次提交后”的 prompt/escape 增量 | 不跟踪 HEAD：无法区分 Claude 贡献 vs 外部提交；每次都更新：增量计数会错 | 只在检测到 HEAD 变化时推进基线 | src/utils/attributionHooks.ts reconcileCommitBaseline |
| 计数器增量：当前 - 上次提交，非负 | `buildPRTrailers` 中使用 `Math.max(0, current - atLastCommit)` 计算每个计数器的增量 | 确保 trailer 只显示自上次提交后的新活动；防止负数（如计数器被重置） | 直接显示当前值：每次提交都会累加所有历史，不是增量 | 增量只增不减，且非负 | src/utils/attributionTrailer.ts nonNegativeDelta, buildPRTrailers |

---

### 2.8 生成文件排除：不统计 Claude 生成的产物

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 生成文件检测：通过文件名模式匹配 | `isGeneratedFile` 判断是否为生成文件（如 `node_modules/`、`dist/`、`*.min.js`、构建产物等）；`calculateCommitAttribution` 中跳过这些文件 | 避免将 npm install、构建产物等计入 Claude 贡献；这些是“执行结果”，不是“创作内容” | 不排除：归因百分比会被大的生成文件扭曲；内容哈希检查：需要读取内容，性能差 | 需要维护生成文件模式列表；可能误判或漏判某些文件 | src/utils/commitAttribution.ts calculateCommitAttribution, isGeneratedFile（外部依赖） |

---

## 3. 目标与非目标

### 目标（当前实现实际承担）

- **文件级变更跟踪**：通过 Edit/Write 工具钩子和 Bash 工具前后快照跟踪 Claude 修改的文件
- **贡献量化**：以字符为单位累加 Claude 的贡献，使用前缀/后缀匹配识别变更区域
- **多会话状态管理**：每个会话独立状态，Git 侧持久化，提交时合并
- **无侵入 Git 钩子**：prepare-commit-msg 调度器保留用户钩子，失败不阻塞提交
- **安全元数据**：内部模型名白名单控制，公开 trailers 只含统计无路径
- **幂等恢复**：会话恢复时只取最后一个快照，不跨快照累加
- **优雅降级**：Git 瞬态状态、钩子失败、跟踪超限都安全降级

### 非目标（容易误认为属于本 spec，但不承担）

- **完整 Git 历史归因**：只跟踪当前 Claude 会话内的变更，不分析历史提交
- **人类变更精确跟踪**：不 hook 人类编辑器，无跟踪的都算作人类贡献
- **Git notes 存储**：当前完整归因数据只用于计算，不写入 Git notes
- **跨 Git 仓库归因**：状态只在当前 Git 仓库内持久化，不跨仓库
- **用户配置归因偏好**：当前只通过全局设置控制 Co-Authored-By 是否显示，不支持按文件/目录配置
- **相关子系统责任**：
  - 文件读写工具（Edit/Write）：由 file-tools spec 主拥有
  - Bash 工具执行：由 shell-tools spec 主拥有
  - 钩子系统：由 hooks spec 主拥有
  - Git 集成基础：由 git-integration spec 主拥有

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

**工具钩子入口（主会话路径）**：
```typescript
// 注册钩子
registerAttributionHooks(): void

// AttributionState 核心操作
trackFileModification(
  state: AttributionState,
  filePath: string,
  oldContent: string,
  newContent: string,
  userModified: boolean,
  mtime?: number
): AttributionState

trackBulkFileChanges(
  state: AttributionState,
  changes: Array<{ path: string; type: 'modified' | 'created' | 'deleted'; oldContent: string; newContent: string; mtime?: number }>
): AttributionState

// 最终计算
calculateCommitAttribution(
  states: AttributionState[],
  stagedFiles: string[]
): Promise<AttributionData>

// 持久化与恢复
stateToSnapshotMessage(state: AttributionState, messageId: UUID): AttributionSnapshotMessage
restoreAttributionStateFromSnapshots(snapshots: AttributionSnapshotMessage[]): AttributionState
incrementPromptCount(attribution: AttributionState, saveSnapshot: (snapshot: AttributionSnapshotMessage) => void): AttributionState

// Git 钩子入口（独立路径）
installPrepareCommitMsgHook(worktreePath: string, hooksDirectory?: string): Promise<void>
uninstallPrepareCommitMsgHook(worktreePath: string, hooksDirectory?: string): Promise<void>
persistAttributionStateForGit(snapshot: AttributionSnapshotMessage): Promise<void>
runPrepareCommitMsgAttribution(worktreePath: string, messagePath: string): Promise<void>

// 元数据
getAttributionTexts(): AttributionTexts
getEnhancedPRAttribution(getAppState: () => AppState): Promise<string>
buildPRTrailers(data: AttributionData, state: AttributionState): string[]
isInternalModelRepo(): Promise<boolean>
sanitizeModelName(modelName: string): string
```

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `commitAttribution.ts` | AttributionState（内存） | 创建空状态、跟踪文件修改、批量跟踪、计算归因、快照/恢复、Git 工具辅助（getStagedFiles、getGitDiffSize、isFileDeleted、isGitTransientState） | Git 命令执行（由 git.ts 承担）、持久化（由 postCommitAttribution/会话存储承担） | 调用 git.ts、generatedFiles、model/model.ts |
| `attributionHooks.ts` | fileContentCache（LRU，500 条目，15min 过期）、pendingBash（Map<toolUseId, PendingBash>，5min 过期）、lastHeadByRepo（Map<repoRoot, sha>）、sweepTimer | 注册钩子、preBash 快照、postBash 差异、reconcileCommitBaseline、清理缓存、flush 持久化队列 | 钩子执行机制（由 hooks.ts 承担） | 被 hooks 调用、调用 commitAttribution、postCommitAttribution |
| `attributionTrailer.ts` | 无（纯函数） | buildPRTrailers、nonNegativeDelta | 实际写入 commit message | 被 commitAttribution、postCommitAttribution 调用 |
| `attribution.ts` | 无（纯函数为主） | getAttributionTexts、getEnhancedPRAttribution、countUserPromptsInMessages、countUserPromptsFromEntries、countMemoryFileAccessFromEntries、getTranscriptStats | 完整归因计算 | 调用 commitAttribution、attributionTrailer、会话存储、settings、model |
| `postCommitAttribution.ts` | 无（模块级缓存为 0） | install/uninstall prepare-commit-msg、persistAttributionStateForGit、readAttributionStates、runPrepareCommitMsgAttribution、atomicWrite、resolveHooksDirectory、dispatcher | 完整 CLI 启动 | 调用 commitAttribution、attributionTrailer、git.ts、lockfile、execFileNoThrow |
| `AppState.attribution` | 全局 AttributionState（每个会话） | updateAttributionState 回调更新 | 持久化（由 commitAttribution 快照 + 会话存储 + Git 侧持久化承担） | 被 attributionHooks 回调更新 |

### 4.3 主控制流

**Edit/Write 工具跟踪流程**：
```
PostToolUse (Edit/Write)
    → attributionHook 触发
    → validate filePath、parse input/output
    → getFileMtime() 获取文件时间戳
    → read originalContent（从工具输出）和 newContent（从工具输出或文件）
    → updateAndPersist()
        → trackFileModification()
            → computeFileModificationState()（前缀/后缀匹配）
            → newFileStates.set(path, { contentHash, claudeContribution, mtime })
        → stateToSnapshotMessage()
        → persistAttributionStateForGit()（后台）
        → recordAttributionSnapshot()（会话存储）
```

**Bash 工具跟踪流程**：
```
PreToolUse (Bash)
    → preBash 触发
    → candidatePaths() 获取待跟踪文件
        → 从 attribution.fileStates
        → 从 attribution.sessionBaselines
        → 从 git diff --name-only
        → 从 git ls-files --others --exclude-standard
        → normalize，过滤生成文件，截断到 200
    → 对每个 candidate 调用 readCandidate()
        → 检查二进制、大小（256KB）、规范化路径
        → 读取内容，计算 hash，保存到 pending[toolUseId].before
    → updateAndPersist()
        → addBaselines()（如果还没有 baseline 则添加）

PostToolUse (Bash)
    → postBash 触发
    → 再次获取 candidatePaths()
    → 对每个文件：
        → pending.incomplete 中有？跳过
        → 读取 post 状态
        → pre hash === post hash？跳过
        → 否则计算变更 type（modified/created/deleted）
    → updateAndPersist()
        → addBaselines()（补充）
        → trackBulkFileChanges()（批量更新 fileStates）
        → 持久化（同 Edit/Write）
    → 清理 pendingBash[toolUseId]

PostToolUseFailure (Bash)
    → cleanupBashHook 触发
    → pendingBash.delete(toolUseId)
```

**prepare-commit-msg 独立流程**：
```
git commit 触发 prepare-commit-msg
    → dispatcher 脚本运行
        → 先执行 prepare-commit-msg.claude-user（如果存在）
        → 失败则终止 commit
        → 成功则执行 node <cli> --internal-prepare-commit-msg-attribution <worktree> <messagePath>
    → runPrepareCommitMsgAttribution 入口
        → setOriginalCwd / setCwdState
        → 检查 isGitTransientState？是则跳过
        → getStagedFiles()
        → readAttributionStates()（从 .git/claude-code/attribution/ 读取前 64 个会话）
        → calculateCommitAttribution(states, stagedFiles)
        → buildPRTrailers()（Claude-Code-Contribution 等）
        → read 原始 commit message
        → 只清理最终段落中的 Claude 相关 trailers，保留用户其他内容
        → git interpret-trailers --if-exists replace --if-missing add
        → atomicWrite 写回 messagePath
```

**会话恢复流程**：
```
会话启动/恢复
    → 从会话存储读取 AttributionSnapshotMessage 列表
    → restoreAttributionStateFromSnapshots(snapshots)
        → 只取最后一个快照
        → 恢复 fileStates、sessionBaselines、startingHeadSha、promptCount 等
    → 设置到 AppState.attribution
```

### 4.4 关键数据结构

**AttributionState**（内存中每个会话的核心状态）：
```typescript
{
  fileStates: Map<string, {
    contentHash: string;        // 当前内容的 SHA-256
    claudeContribution: number; // 累加的字符数（只增不减）
    mtime: number;              // 最后修改时间戳
  }>;

  sessionBaselines: Map<string, {
    contentHash: string;        // 首次观察到的内容哈希
    mtime: number;              // 首次观察到的时间戳
  }>;

  surface: string;              // 'cli' 或其他入口
  startingHeadSha: string | null; // 会话首次看到的 HEAD

  promptCount: number;
  promptCountAtLastCommit: number;

  permissionPromptCount: number;
  permissionPromptCountAtLastCommit: number;

  escapeCount: number;
  escapeCountAtLastCommit: number;
}
```

**AttributionData**（最终计算结果，用于 trailers/notes）：
```typescript
{
  version: 1;
  summary: {
    claudePercent: number;      // 0-100
    claudeChars: number;
    humanChars: number;
    surfaces: string[];
  };
  files: Record<string, {
    claudeChars: number;
    humanChars: number;
    percent: number;
    surface: string;
  }>;
  surfaceBreakdown: Record<string, { claudeChars: number; percent: number }>;
  excludedGenerated: string[];
  sessions: string[];
}
```

**PendingBash**（Bash 工具执行期间的临时状态）：
```typescript
{
  repoRoot: string;
  createdAt: number;
  before: Map<string, {
    content: string;
    hash: string;
    mtime: number;
    size: number;
    lastUsed: number;
  } | null>;
  incomplete: Set<string>;  // 超出限制或无法读取的文件
}
```

**AttributionSnapshotMessage**（持久化到会话存储和 Git 的格式）：
```typescript
{
  type: 'attribution-snapshot';
  messageId: UUID;
  surface: string;
  fileStates: Record<string, { contentHash: string; claudeContribution: number; mtime: number }>;
  sessionBaselines: Record<string, { contentHash: string; mtime: number }>;
  startingHeadSha: string | null;
  promptCount: number;
  promptCountAtLastCommit: number;
  permissionPromptCount: number;
  permissionPromptCountAtLastCommit: number;
  escapeCount: number;
  escapeCountAtLastCommit: number;
}
```

### 4.5 跨子系统依赖

| 依赖 | 用途 | 所属 spec |
|---|---|---|
| `hooks.ts` | 注册 PreToolUse/PostToolUse/PostToolUseFailure 钩子 | hooks |
| `git.ts` | findGitRoot、execFileNoThrow、getStagedFiles、isGitTransientState | git-integration |
| `generatedFiles.ts` | 计算归因时排除生成文件 | file-tools |
| `model/model.ts` | getCanonicalName、sanitizeModelName、getPublicModelName | model-api |
| `settings.ts` | 读取 attribution、includeCoAuthoredBy 配置 | settings |
| `sessionStorage.ts` | recordAttributionSnapshot、读取快照 | session-persistence |
| `execFileNoThrow.ts` | 执行 Git 命令 | shell-tools |
| `lockfile.ts` | 钩子安装期间的并发保护 | （通用工具） |

## 5. 失败语义与工程取舍

### 5.1 失败语义表

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| 不是 Git 仓库 | getAttributionRepoRoot 返回 getOriginalCwd | 静默降级 | 否 | 无归因跟踪（但 Edit/Write 工具仍会尝试） | 不安装钩子；归因不写入 commit |
| Git 瞬态状态（merge/rebase/cherry-pick） | isGitTransientState 检查 | 跳过归因，无异常 | 否 | 无 | 提交正常，无归因 trailer |
| Bash pre 读取文件失败 | readCandidate 返回 null/'incomplete' | 跳过该文件，不抛异常 | 否 | incomplete 加入集合，post 时跳过 | 该文件不被跟踪，其他文件正常 |
| Bash 工具失败 | PostToolUseFailure 钩子触发 | 清理 pendingBash 条目，不抛异常 | 否 | pendingBash.delete(toolUseId) | 该次 Bash 变更不被跟踪 |
| 文件超出大小/总大小限制 | readCandidate 检查、postBash 检查 | 标记为 incomplete，跳过 | 否 | 加入 incomplete 集合 | 该文件不被跟踪 |
| 候选文件超出数量限制 | candidatePaths 截断到 200 | 静默截断 | 否 | 只跟踪前 200 | 超出的文件不被跟踪 |
| Git 命令失败（diff/ls-files/interpret-trailers） | execFileNoThrow 返回 code ≠ 0 | 捕获异常，跳过或降级 | 否 | 无 | 归因部分可用或完全跳过 |
| 归因状态读取失败（损坏的 JSON） | readAttributionStates 解析失败 | 跳过该会话文件，不抛异常 | 否 | 只跳过损坏的文件，其他会话正常 | 该会话的归因丢失，其他会话正常 |
| 快照持久化失败 | persistAttributionStateForGit 失败 | 捕获并记录 debug 日志，不抛异常 | 否 | 不阻塞工具执行 | prepare-commit-msg 时可能无法读取该状态 |
| 钩子安装并发冲突 | lockfile 获取超时 | 抛出异常 | 20 次重试，指数退避，min 20ms，max 250ms | 锁自动释放 | 安装失败，需要用户重试 |
| 用户钩子失败 | dispatcher 检查 $? | 用户钩子失败则终止 commit，不运行归因 | 否 | 无 | git commit 失败，由用户处理 |

### 5.2 主要工程取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| 前缀/后缀匹配 vs 完整 diff | 前缀/后缀匹配，简单 O(n) | 无法处理非连续变更；多次编辑同一位置会膨胀计数 | 无外部依赖；性能好；适合精确替换场景 |
| 字符计数 vs 行数 | 字符级累加 | 字符膨胀问题（多次编辑同一位置）；与最终 diff 统计解耦 | 更精确；小修改也被记录 |
| 快照完整状态 vs 增量 | 每次快照是完整状态，恢复只取最后一个 | 单次快照稍大；需要文档化说明 | 避免跨快照累加导致二次方膨胀；恢复逻辑简单 |
| Git 侧持久化 64 会话上限 | 只保留最新 64 个会话 | 旧会话的归因会丢失 | 防止磁盘泄漏；性能可控 |
| 尽力而为 vs 必须成功 | 归因失败绝不阻塞提交 | 某些情况下归因可能缺失；问题不易发现 | 用户体验优先；提交不被归因干扰 |
| 无侵入调度器 vs 直接覆盖 | 先运行用户钩子，再运行归因；可卸载 | 实现复杂；需要处理权限、并发、原子替换 | 保留用户工作流；可安全卸载；幂等安装 |
| 内部模型名白名单 vs 自动检测 | 硬编码仓库列表 | 需要手动维护；新内部仓库需要加列表 | 安全；防止误判泄露 |
| 公共 trailers 无路径 vs 完整数据 | 只统计，无路径/会话 ID | 无法从 commit message 逆向工程出更多信息；完整数据不公开 | 安全；无敏感信息泄露 |
| Bash 有界缓存 vs 无限制 | 200 文件、256KB/文件、2MB 总大小、500 缓存条目、15min/5min 过期 | 超出限制的文件不被跟踪 | 防止 OOM；防止性能下降 |

## 6. 现状验收标准

以下验收可独立验证当前行为，与第 4、5 节对应：

1. **文件变更跟踪验收**：
   - 给定 Edit 工具修改文件（非等长替换），`trackFileModification` 正确计算变更区域（前缀/后缀匹配）
   - 给定 Write 工具创建新文件，Claude 贡献 = 文件长度
   - 给定文件被删除，Claude 贡献 = 删除前内容长度
   - 给定用户修改（userModified=true），仍跟踪 Claude 贡献（当前 userModified 参数实际不影响贡献计算）

2. **Bash 工具跟踪验收**：
   - 给定 Bash 命令修改文件，preBash 保存快照，postBash 检测变更并跟踪
   - 给定 Bash 命令创建新文件，被识别为 created 并跟踪
   - 给定 Bash 命令删除文件，被识别为 deleted 并跟踪
   - 给定 Bash 工具失败，pendingBash 条目被清理，不影响后续跟踪
   - 给定文件 >256KB 或总变更 >2MB，被标记为 incomplete 不跟踪

3. **Git 钩子验收**：
   - 给定已存在用户 prepare-commit-msg 钩子，安装时被重命名为 .claude-user，调度器先运行它
   - 给定用户钩子失败，git commit 失败，归因不运行
   - 给定用户钩子成功，归因运行并添加 trailers
   - 给定 merge/rebase/cherry-pick 进行中，归因跳过
   - 给定归因失败，只打印警告，commit 继续
   - 给定卸载钩子，用户钩子被恢复，调度器被删除

4. **多会话与恢复验收**：
   - 给定多个会话的状态，prepare-commit-msg 时合并它们的归因
   - 给定同一文件被多个会话修改，Claude 贡献累加
   - 给定会话恢复时读取多个快照，只取最后一个，不跨快照累加
   - 给定 >64 个会话，只读取前 64 个（按文件名排序）

5. **安全与元数据验收**：
   - 给定在内部仓库（匹配 INTERNAL_MODEL_REPOS），trailer 包含内部模型名
   - 给定在外部仓库，只包含公共模型名（claude-opus-4-6 等）
   - 给定公共 trailers，不包含路径、会话 ID、文件名等敏感信息
   - 给定内部模型名包含变体（如 -fast、-latest），sanitizeModelName 映射到公共名
   - 给定 Git 侧持久化文件，权限为 0o600，目录为 0o700

6. **HEAD 协调验收**：
   - 给定会话首次运行，startingHeadSha 被设置为当前 HEAD
   - 给定外部提交（HEAD 变化），promptCountAtLastCommit 等被推进到当前值
   - 给定 buildPRTrailers，增量 = 当前 - 上次提交，且非负

7. **降级与边界验收**：
   - 给定不是 Git 仓库，钩子不安装，归因不写入 commit
   - 给定生成文件（node_modules/ 等），被排除在归因计算之外
   - 给定 >200 候选文件，只跟踪前 200
   - 给定二进制文件，被跳过不跟踪

## 7. 代码与测试证据

### 7.1 核心模块证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 前缀/后缀匹配识别变更区域 | src/utils/commitAttribution.ts computeFileModificationState | tests/commitAttributionWave2.test.ts（间接覆盖） | 只适用于精确内容场景；不处理非连续变更 |
| 字符级贡献累加，只增不减 | src/utils/commitAttribution.ts computeFileModificationState, trackFileModification, trackBulkFileChanges | tests/commitAttributionWave2.test.ts（间接覆盖） | 多次编辑同一位置会膨胀计数 |
| 会话基线只保存首次观察状态 | src/utils/commitAttribution.ts trackFileModification, src/utils/attributionHooks.ts addBaselines, preBash | tests/commitAttributionWave2.test.ts（间接覆盖） | 基线在第一次接触文件后不再更新 |
| 快照是完整状态，恢复只取最后一个 | src/utils/commitAttribution.ts stateToSnapshotMessage, restoreAttributionStateFromSnapshots | tests/commitAttributionWave2.test.test.test.ts test "full snapshots restore baselines once without cross-snapshot inflation" | 历史观察：837 快照 × 280 文件 → 累加会导致 1.15 万亿字符，当前方案避免 |
| prepare-commit-msg 调度器保留用户钩子 | src/utils/postCommitAttribution.ts installPrepareCommitMsgHook, dispatcher, uninstallPrepareCommitMsgHook | tests/commitAttributionWave2.test.ts test "preserves an executable user hook, markers, managed trailers and uninstall" | 只处理 prepare-commit-msg；core.hooksPath 支持 |
| Git 侧持久化与 64 会话上限 | src/utils/postCommitAttribution.ts persistAttributionStateForGit, readAttributionStates | tests/commitAttributionWave2.test.ts（间接覆盖） | 上限 64；文件权限 0o600；目录 0o700 |
| 内部模型名白名单控制 | src/utils/commitAttribution.ts isInternalModelRepo, INTERNAL_MODEL_REPOS, sanitizeModelName | tests/commitAttributionWave2.test.ts（间接覆盖） | 白名单需要手动维护 |
| 公共 trailers 只含统计无路径 | src/utils/attributionTrailer.ts buildPRTrailers | tests/commitAttributionWave2.test.ts test "public trailers are ordered, numeric, non-negative and path-free" | 完整 AttributionData 不写入公开 commit message |
| Git 瞬态状态检测 | src/utils/commitAttribution.ts isGitTransientState, src/utils/postCommitAttribution.ts runPrepareCommitMsgAttribution | tests/commitAttributionWave2.test.ts（间接覆盖） | rebase/merge/cherry-pick/bisect 会跳过归因 |
| Bash 工具前后快照与有界缓存 | src/utils/attributionHooks.ts preBash, postBash, cleanupBashHook, sweepFileContentCache, clearAttributionCaches | tests/commitAttributionWave2.test.ts test "Bash pre/post pairs bulk create, modify and delete; failure and clear skip" | MAX_CANDIDATE_FILES=200, MAX_FILE_BYTES=256KB, MAX_TOTAL_BYTES=2MB, MAX_CACHE_FILES=500, CACHE_TTL=15min, PENDING_TTL=5min |
| HEAD 协调与计数器增量 | src/utils/attributionHooks.ts reconcileCommitCommitBaseline, src/utils/attributionTrailer.ts nonNegativeDelta, buildPRTrailers | tests/commitAttributionWave2.test.test.ts test "HEAD reconciliation advances commit counters once only after a commit" | startingHeadSha 只在第一次设置；后续 HEAD 变化只推进基线 |
| 钩子失败不阻塞提交 | src/utils/postCommitAttribution.ts runPrepareCommitMsgAttribution | tests/commitAttributionWave2.test.ts（间接覆盖） | 归因是尽力而为；失败时退出码 0 |
| 幂等钩子安装与原子写入 | src/utils/postCommitAttribution.ts installPrepareCommitMsgHook, atomicWrite, lock | tests/commitAttributionWave2.test.ts test "preserves an executable user hook, markers, managed trailers and uninstall" | 使用目录锁；tmp + rename 原子替换 |

### 7.2 现有测试列表

主要测试覆盖：
- tests/commitAttributionWave2.test.ts：
  - Edit/Write 工具跟踪与幂等注册
  - Bash 工具前后快照、批量变更、失败清理、缓存清理
  - HEAD 协调与计数器推进
  - 完整快照恢复与跨快照膨胀防护
  - 公共 trailers 格式验证
  - prepare-commit-msg 钩子安装/卸载、用户钩子保留、失败处理、core.hooksPath 支持

### 7.3 边界与未覆盖

- **重命名/复制跟踪**：当前不跟踪文件重命名（Git 检测到重命名但归因只看路径）；复制文件可能被计为全新创建
- **人类后续修改**：Claude 编辑后人类又修改同一文件，Claude 的贡献仍被 100% 记录，不与人类贡献按比例分配
- **字符膨胀**：多次编辑同一位置会导致 claudeContribution 不断累加，可能超过文件实际大小
- **浅克隆支持**：未明确测试
- **Windows 路径规范化**：某些边缘情况（如混合斜杠）
- **Git notes 存储**：AttributionData 当前计算但不写入 Git notes
- **外部归因 UI**：无用户界面查看详细归因（只有 trailers）

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/commit-attribution.yaml)

### 8.1 本 spec 主拥有的文件组

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|---|---|---|---|
| commit-attribution-core | 状态定义、跟踪逻辑、归因计算、快照/恢复、Git 工具辅助 | tests/commitAttributionWave2.test.ts | 不拥有 |
| attribution-hooks | 钩子注册、Edit/Write/Bash 跟踪、缓存管理、HEAD 协调 | tests/commitAttributionWave2.test.ts | 不拥有 |
| attribution-trailer | 公共 trailer 构建、增量计算 | tests/commitAttributionWave2.test.ts | 不拥有 |
| attribution-ui | 归因文本生成、增强 PR 归因、用户消息计数 | tests/commitAttributionWave2.test.ts（间接） | 不拥有 |
| post-commit-attribution | Git 钩子安装/卸载、Git 侧持久化、prepare-commit-msg 独立入口 | tests/commitAttributionWave2.test.ts | 不拥有 |

### 8.2 相关子系统

- **git-integration**：Git 仓库发现、Git 命令执行、Git 元数据读取；本 spec 只覆盖归因特定的 Git 交互
- **file-tools**：Edit/Write 工具实现；本 spec 只覆盖钩子集成
- **shell-tools**：Bash 工具实现；本 spec 只覆盖钩子集成
- **hooks**：钩子注册与调度机制；本 spec 只覆盖归因特定钩子
- **settings**：attribution 配置读取；本 spec 只覆盖使用
- **model-api**：模型名规范化；本 spec 只覆盖 sanitizeModelName 和白名单逻辑
- **session-persistence**：会话快照存储；本 spec 只覆盖 attribution-snapshot 类型

## 9. 改进建议

### 9.1 P1：解决字符膨胀问题，支持“净贡献”计算

**触发场景与证据**：当前实现多次编辑同一位置会导致 claudeContribution 不断累加（如把 `a` 改成 `b` 再改回 `a`，贡献 = 1 + 1 = 2，而实际净变化为 0）。

**建议方向**：
- 保留累加模式用于“活动量”指标，新增“净贡献”模式用于最终百分比
- 净贡献对比 sessionBaseline vs 最终提交内容，取最大变更区域
- 在 trailer 中可同时显示（或切换）两种指标

**回归风险**：中，需要修改 calculateCommitAttribution，但可以向后兼容（保留现有字段，新增字段）。

**验收方式**：在同一文件多次编辑后验证净贡献正确。

**工作量**：M。

**置信度**：设计推断。

---

### 9.2 P1：文件重命名/复制跟踪

**触发场景与证据**：当前通过 Bash 重命名文件时，归因会按新路径重新开始，丢失旧路径的历史贡献；复制文件会被计为全新创建。

**建议方向**：
- 在 calculateCommitAttribution 时，通过 Git diff 的 rename/copy 检测关联路径
- 把旧路径的贡献迁移到新路径
- 或在跟踪层检测 inode 变化（但跨平台复杂）

**回归风险**：中，需要修改 calculateCommitAttribution 的路径处理逻辑。

**验收方式**：重命名文件后验证贡献被保留。

**工作量**：M。

**置信度**：设计推断。

---

### 9.3 P2：Git notes 存储完整归因数据

**触发场景与证据**：当前 AttributionData 只在内存中计算并用于生成 trailers，不持久化；详细的按文件归因无法追溯。

**建议方向**：
- 在 prepare-commit-msg 时，将完整 AttributionData JSON 写入 Git notes（如 refs/notes/claude-code-attribution）
- 提供工具查看历史归因
- 公共 commit message 仍只包含统计 trailers

**回归风险**：低，新增功能，不影响现有行为。

**验收方式**：提交后验证 Git notes 存在且数据正确。

**工作量**：M。

**置信度**：设计推断。

---

### 9.4 P2：归因配置精细化

**触发场景与证据**：当前只有全局开关（settings.attribution.commit/pr），无法按文件/目录配置（如某些目录关闭归因，某些目录强制归因）。

**建议方向**：
- 支持 .claude-attribution-ignore 文件（类似 .gitignore）
- 支持按路径模式配置是否归因
- 支持配置贡献计算策略（字符 vs 行，净贡献 vs 累加）

**回归风险**：低，新增配置，默认行为不变。

**验收方式**：验证忽略规则生效。

**工作量**：S。

**置信度**：设计推断。

---

### 9.5 P3：归因可视化与调试工具

**触发场景与证据**：当前无用户界面查看详细归因，调试困难；用户无法预览提交前的归因数据。

**建议方向**：
- 新增 `/attribution` 或 `/status` 命令显示当前会话的归因状态
- 在 prepare-commit-msg 前可选地显示预览
- 暴露调试日志开关（当前已有 logForDebugging，但无开关）

**回归风险**：低，新增 UI，不影响核心逻辑。

**验收方式**：验证命令输出正确。

**工作量**：S。

**置信度**：设计推断。

