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
| `commitAttribution.ts` | 纯函数模块，无模块级状态 | 创建空状态（createEmptyAttributionState）、跟踪文件修改（trackFileModification）、批量跟踪（trackBulkFileChanges）、计算归因（calculateCommitAttribution）、快照/恢复（stateToSnapshotMessage、restoreAttributionStateFromSnapshots）、Git 工具辅助（getStagedFiles、getGitDiffSize、isFileDeleted、isGitTransientState、isInternalModelRepo、sanitizeModelName） | Git 命令执行（由 git.ts 承担）、持久化（由 postCommitAttribution/会话存储承担） | 调用 git.ts、generatedFiles、model/model.ts |
| `attributionHooks.ts` | fileContentCache（LRU，500 条目，15min 过期）、pendingBash（Map<toolUseId, PendingBash>，5min 过期）、lastHeadByRepo（Map<repoRoot, sha>）、sweepTimer、persistence Promise | registerAttributionHooks、preBash 快照、postBash 差异、reconcileCommitBaseline、cleanupBashHook、sweepFileContentCache、clearAttributionCaches、updateAndPersist | 钩子执行机制（由 hooks.ts 承担）、核心归因计算 | 被 hooks 调用、调用 commitAttribution、postCommitAttribution、sessionStorage |
| `attributionTrailer.ts` | 无（纯函数） | buildPRTrailers、nonNegativeDelta | 实际写入 commit message | 被 commitAttribution、postCommitAttribution 调用 |
| `attribution.ts` | 无（纯函数为主） | getAttributionTexts、getEnhancedPRAttribution、countUserPromptsInMessages、countUserPromptsFromEntries、countMemoryFileAccessFromEntries、getTranscriptStats | 完整归因计算 | 调用 commitAttribution、attributionTrailer、会话存储、settings、model |
| `postCommitAttribution.ts` | 无（模块级缓存为 0） | install/uninstall prepare-commit-msg、persistAttributionStateForGit、readAttributionStates、runPrepareCommitMsgAttribution、atomicWrite、resolveHooksDirectory、dispatcher | 完整 CLI 启动、核心归因计算 | 调用 commitAttribution、attributionTrailer、git.ts、lockfile、execFileNoThrow |
| `AppState.attribution` | AttributionState 序列化快照（仅用于持久化） | updateAttributionState 回调更新 | 状态所有权（实际状态在 attributionHooks 闭包中通过参数传递） | 被 attributionHooks 回调更新、用于会话恢复 |

#### 状态所有权说明
- 核心 AttributionState 通过显式参数传递，不在 commitAttribution.ts 模块级持有
- attributionHooks.ts 在钩子执行期间通过闭包持有当前会话的 AttributionState
- AppState.attribution 仅作为持久化快照，不参与运行时归因计算
- Git 侧持久化通过 postCommitAttribution.ts 读写 `.git/claude-code/attribution/<sessionId>.json`

---

### 4.3 commitAttribution.ts 模块设计卡

#### 真实入口签名与关键类型

```typescript
// 核心状态类型
type AttributionState = {
  fileStates: Map<string, FileAttributionState>
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

type FileAttributionState = {
  contentHash: string
  claudeContribution: number  // 字符级累加，只增不减
  mtime: number
}

// 主要入口函数
createEmptyAttributionState(): AttributionState
trackFileModification(
  state: AttributionState,
  filePath: string,
  oldContent: string,
  newContent: string,
  userModified: boolean,  // 注意：当前实现忽略此参数
  mtime: number = Date.now()
): AttributionState
trackBulkFileChanges(
  state: AttributionState,
  changes: ReadonlyArray<{
    path: string
    type: 'modified' | 'created' | 'deleted'
    oldContent: string
    newContent: string
    mtime?: number
  }>
): AttributionState
calculateCommitAttribution(
  states: AttributionState[],
  stagedFiles: string[]
): Promise<AttributionData>
stateToSnapshotMessage(state: AttributionState, messageId: UUID): AttributionSnapshotMessage
restoreAttributionStateFromSnapshots(snapshots: AttributionSnapshotMessage[]): AttributionState
```

#### 输入输出设计

**trackFileModification 数据流：**
- 输入：旧内容、新内容、文件路径
- 处理：
  - 前缀/后缀匹配找变更区域：`prefixEnd` 和 `suffixLen` 定位中间变更块
  - 计算变更字符数：`Math.max(oldChangedLen, newChangedLen)`
  - 累加至现有贡献（如有）
- 输出：新的 AttributionState（不可变更新）

**computeFileModificationState（内部函数）细节：**
- 新文件或删除：贡献 = 内容长度
- 修改文件：`claudeContribution = existing + max(oldChanged, newChanged)`
- 错误处理：捕获异常返回 null，调用方跳过该文件

**calculateCommitAttribution 数据流：**
- 输入：多个会话状态、暂存文件列表
- 处理：
  1. 合并文件状态：累加跨会话贡献
  2. 合并基线：保留最早的基线（首次观察优先）
  3. 逐个文件处理：
     - 跳过生成文件（isGeneratedFile）
     - 有 fileStates → Claude 贡献 = 累加值
     - 无 fileStates 但有 baseline → 人类贡献 = git diff 估算值
     - 其他 → 人类贡献 = 文件大小
- 输出：AttributionData 包含百分比和明细

#### 模块级与显式状态

**模块级状态（仅缓存）：**
```typescript
let repoClassCache: 'internal' | 'external' | 'none' | null = null
// isInternalModelRepo() 用 sequential() 装饰器保证并发安全
```

**显式状态（AttributionState 完全显式传递）：**
- fileStates：Map<规范化路径, FileAttributionState>
- sessionBaselines：Map<路径, {contentHash, mtime}> - 首次观察后不再更新
- startingHeadSha：会话首次 HEAD，用于检测外部提交
- promptCount*：提示计数，有 "atLastCommit" 版本用于增量计算
- permissionPromptCount*：权限提示计数
- escapeCount*：ESC 取消计数

**关键设计点：**
- 所有状态操作不可变：返回新对象，不修改输入
- userModified 参数存在但被忽略（当前不区分用户修改）
- 路径规范化：处理 macOS /tmp → /private/tmp 符号链接，相对仓库根目录

#### 文件修改跟踪流程

**前缀/后缀匹配算法（computeFileModificationState）：**
```
old: [AAAAA BBBBB CCCCC]
new: [AAAAA DDDDD CCCCC]
       ↑prefixEnd      ↑suffixLen from end
              ↑ changed region
```
- 从前向后找第一个不同字节：prefixEnd
- 从后向前找最后一个不同字节：suffixLen
- 变更长度 = max(oldChangedLen, newChangedLen)
- 设计选择：不使用 Myers diff 算法（依赖重、精确替换场景已足够）

**批量变更优化（trackBulkFileChanges）：**
- 创建单个 Map 副本，多次变异
- 避免 O(n²) 复杂度（每个文件复制 Map 的开销）
- 适用于 Bash 工具后的批量文件检测

#### 提交关联与归因计算

**合并多会话归因策略：**
- 文件状态：累加跨会话 claudeContribution
- 基线：最早基线优先（不覆盖）
- 计数器：取最后快照的完整值（不跨快照累加）

**贡献计算权衡：**
- Claude 贡献：只增不减的累加字符数（可能膨胀）
- 人类贡献：通过排除法估算（无跟踪则全算人类）
- 百分比：Claude / (Claude + Human)
- Git diff 估算：行变更 × 40 字符（经验值）

**文件删除处理：**
- 检查 `git diff --cached --name-status` 是否以 D\t 开头
- 删除前的内容长度计入 Claude 贡献（如被跟踪）

#### 错误恢复与幂等

**Git 瞬态状态检测（isGitTransientState）：**
- 检查 .git 目录下：rebase-merge、rebase-apply、MERGE_HEAD、CHERRY_PICK_HEAD、BISECT_LOG
- 检测到则跳过归因，不阻塞提交

**快照恢复策略：**
- 只取最后一个快照（完整状态，非增量）
- 历史证据：837 快照 × 280 文件 → 累加会导致 1.15 万亿字符膨胀
- 实现：直接取 `snapshots[snapshots.length - 1]`

**错误降级：**
- computeFileModificationState：捕获异常返回 null
- getGitDiffSize、isFileDeleted、getStagedFiles：失败返回安全默认值

#### 设计取舍与备选

| 取舍项 | 实际选择 | 备选方案 | 代价 | 收益 | 证据位置 |
|-------|---------|---------|------|------|---------|
| 变更检测 | 前缀/后缀匹配 | Myers diff 算法 | 无法处理非连续变更 | 无依赖、O(n)、适合精确替换 | computeFileModificationState |
| 贡献单位 | 字符级 | 行级 | 多次编辑同位置会膨胀 | 小修改（如 Esc→esc）也被记录 | computeFileModificationState、trackFileModification |
| 快照策略 | 完整状态，取最后一个 | 增量累加 | 单次快照稍大 | 避免二次膨胀，恢复简单 | restoreAttributionStateFromSnapshots |
| 基线策略 | 首次观察后不更新 | 每次编辑更新基线 | 无法计算会话总变化 | 与最终提交比较有稳定基准 | trackFileModification、attributionHooks addBaselines |
| 模型名暴露 | 白名单仓库 | 自动检测内部 | 需手动维护列表 | 防止内部代号泄露 | isInternalModelRepo、INTERNAL_MODEL_REPOS |

#### 源码测试证据

**核心算法证据：**
- `computeFileModificationState`：前缀/后缀循环、只增不减累加
- `restoreAttributionStateFromSnapshots`：明确注释 "只取最后一个快照"
- `calculateCommitAttribution`：分阶段合并、排除生成文件
- `isInternalModelRepo`：INTERNAL_MODEL_REPOS 硬编码列表（23 个仓库）

**测试覆盖：**
- tests/commitAttributionWave2.test.ts（间接覆盖）
- 完整快照恢复测试验证跨快照膨胀防护
- Git 钩子安装/卸载测试

**安全常量：**
- INTERNAL_MODEL_REPOS：私有仓库白名单
- sanitizeModelName：公共模型名映射（opus-4-6、sonnet-4-6 等）

---

### 4.4 attributionHooks.ts 模块设计卡

#### 真实入口签名与关键类型

```typescript
// 配置常量（真实值）
const MAX_CANDIDATE_FILES = 200
const MAX_FILE_BYTES = 256 * 1024        // 256KB
const MAX_TOTAL_BYTES = 2 * 1024 * 1024  // 2MB
const MAX_CACHE_FILES = 500
const MAX_PENDING_BASH = 32
const CACHE_TTL_MS = 15 * 60 * 1000      // 15分钟
const PENDING_TTL_MS = 5 * 60 * 1000     // 5分钟

// 内部类型
type CacheEntry = {
  content: string
  hash: string
  mtime: number
  size: number
  lastUsed: number
}

type PendingBash = {
  repoRoot: string
  createdAt: number
  before: Map<string, CacheEntry | null>
  incomplete: Set<string>  // 超限或无法读取的文件
}

// 公共入口
registerAttributionHooks(): void
sweepFileContentCache(): void
clearAttributionCaches(): void
flushAttributionPersistence(): Promise<void>
```

#### 输入输出设计

**钩子注册（registerAttributionHooks）：**
- 注册 PreToolUse：仅 Bash 工具
- 注册 PostToolUse：Edit、Write、Bash 工具
- 注册 PostToolUseFailure：仅 Bash 工具
- 启动 60 秒间隔的 sweep 定时器（unref，不阻止进程退出）

**PreBash 输入输出：**
- 输入：HookInput（包含 tool_name、tool_input 等）、toolUseID
- 处理：
  1. 获取候选路径（candidatePaths）
  2. 逐个读取候选文件（readCandidate）
  3. 应用大小/总数限制
- 输出：无显式输出，写入 pendingBash Map

**PostBash 输入输出：**
- 输入：同 PreBash
- 处理：
  1. 再次读取候选路径
  2. 对比 before/after 哈希
  3. 批量追踪变更
- 输出：无显式输出，更新 AttributionState

#### 模块级与显式状态

**fileContentCache（LRU 缓存）：**
- 类型：`Map<string, CacheEntry>`
- Key：`${resolvedRepoRoot}\0${normalizedPath}`（空字符分隔）
- 过期策略：
  - 15 分钟 TTL（sweepFileContentCache 清理）
  - 数量限制：MAX_CACHE_FILES=500
  - 大小限制：MAX_TOTAL_BYTES=2MB
  - trimCache：按插入顺序淘汰最早条目

**pendingBash（Bash 执行期间状态）：**
- 类型：`Map<string, PendingBash>`
- 数量限制：MAX_PENDING_BASH=32
- 过期策略：5 分钟 TTL
- 内容：pre 快照、incomplete 文件集合

**lastHeadByRepo（HEAD 协调）：**
- 类型：`Map<string, string>`
- 用途：检测外部提交（HEAD 变化）
- 生命周期：进程级缓存

**sweepTimer、persistence：**
- sweepTimer：60 秒间隔定时器，unref
- persistence：Promise 链，用于优雅关闭等待

**关键设计点：**
- fileContentCache 和 pendingBash 在模块闭包中，不暴露
- AttributionState 仍通过显式参数传递（commitAttribution 纯函数）
- AppState.attribution 只是快照，运行时状态在钩子闭包中

#### 文件修改追踪流程

**Edit/Write 工具流程（postFileTool）：**
```
PostToolUse (Edit/Write)
  → 验证工具输入输出 schema
  → 读取文件新内容（Edit 从磁盘读，Write 从响应取）
  → 规范化路径检查
  → 获取 mtime
  → addBaselines（仅首次添加）
  → trackFileModification（前缀/后缀匹配）
  → queuePersistence（后台写入会话存储+Git）
```

**Bash 工具完整流程：**
```
PreToolUse (Bash)
  → candidatePaths() 收集：
    · attribution.fileStates 已有路径
    · attribution.sessionBaselines 已有路径
    · git diff --name-only（已修改未暂存）
    · git ls-files --others（未跟踪未忽略）
  → 截断至 MAX_CANDIDATE_FILES=200
  → 逐个 readCandidate：
    · 检查二进制扩展名、大小超限
    · 检查符号链接、非文件
    · 检查路径规范化后仍在仓库内
    · 检测真实二进制内容（isBinaryContent）
  → 应用 MAX_TOTAL_BYTES=2MB 限制
  → 存入 pendingBash[toolUseId]
  → addBaselines（首次观察保存）

PostToolUse (Bash)
  → 再次获取 candidatePaths（pre 路径 + 新路径）
  → 过滤 incomplete 文件
  → 新文件检查：git ls-files --error-unmatch（已跟踪则跳过）
  → 对比 before/after hash
  → 批量构建 changes[]
  → trackBulkFileChanges（单次 Map 复制）
  → 删除 pendingBash[toolUseId]

PostToolUseFailure (Bash)
  → cleanupBashHook
  → pendingBash.delete(toolUseId)
```

**HEAD 协调流程（reconcileCommitBaseline）：**
```
每次钩子执行前调用
  → git rev-parse HEAD
  → 与 lastHeadByRepo 比较
  → 首次运行：设置 startingHeadSha
  → HEAD 变化（外部提交）：推进 *AtLastCommit 计数器
```

#### 会话基线与 rename/copy 边界

**会话基线（sessionBaselines）策略：**
- 仅在首次观察文件时添加（addBaselines 检查 has(path)）
- 后续编辑不更新基线
- 用途：计算从会话开始到提交的净变化（当前未完全使用）

**rename/copy 边界情况：**
- 当前不处理重命名：Git 检测到重命名但归因只看路径
- 复制文件：计为全新创建（claudeContribution = 完整长度）
- 边界原因：需解析 Git diff rename/copy 检测，复杂度高

#### 贡献计数计算

**Edit/Write 工具计数：**
- 与 commitAttribution.trackFileModification 相同算法
- before 内容来自工具输出（Edit：originalFile，Write：originalFile 或空）
- after 内容来自磁盘（Edit）或响应（Write）

**Bash 工具计数：**
- 批量变更，避免 O(n²) Map 复制
- 只追踪 pre 快照中存在或新创建的文件
- 超限文件标记为 incomplete，不追踪

#### Hook 失败与恢复

**错误降级策略：**
- attributionHook.callback：try/catch 包裹所有操作
- 失败仅记录 debug 日志，不阻塞工具执行
- readCandidate：失败返回 null 或 'incomplete'
- pendingBash 容量满：跳过快照记录

**清理机制：**
- PostToolUseFailure：删除 pendingBash[toolUseId]
- sweepFileContentCache：每 60 秒清理过期条目
- clearAttributionCaches：完整清理（测试/关闭用）
- flushAttributionPersistence：等待持久化完成

**幂等保证：**
- registerAttributionHooks：检查 isRegistered 避免重复
- updateAndPersist：比较引用，状态不变则不持久化
- addBaselines：检查 has(path) 避免覆盖

#### 设计取舍与备选

| 取舍项 | 实际选择 | 备选方案 | 代价 | 收益 | 证据位置 |
|-------|---------|---------|------|------|---------|
| Bash 快照范围 | 候选路径（已跟踪+git变更） | 全仓库扫描 | 可能遗漏部分文件 | 性能可控 | candidatePaths |
| 缓存淘汰 | 插入顺序（类 LRU） | 真正 LRU | 可能淘汰仍有用的条目 | 实现简单，无需额外数据结构 | trimCache |
| pending 数量限制 | 32 个并发 Bash | 无限制 | 高并发可能丢失快照 | 防止内存泄漏 | preBash |
| 二进制检测 | 扩展名+内容检测 | 仅扩展名 | 稍慢 | 更准确 | readCandidate |
| 持久化队列 | Promise 链串行 | 并行写入 | 稍慢 | 避免竞态，顺序一致 | queuePersistence |

#### 源码测试证据

**真实常量证据：**
- MAX_CANDIDATE_FILES=200、MAX_FILE_BYTES=256KB、MAX_TOTAL_BYTES=2MB
- MAX_CACHE_FILES=500、MAX_PENDING_BASH=32
- CACHE_TTL_MS=15 分钟、PENDING_TTL_MS=5 分钟
- 定时器间隔 60 秒

**钩子流程证据：**
- attributionHook：switch-case 分发 Bash/File 工具
- preBash/postBash/cleanupBashHook：明确的三阶段处理
- reconcileCommitBaseline：检测 HEAD 变化推进计数器基线
- updateAndPersist：不可变更新+队列持久化

**测试覆盖：**
- tests/commitAttributionWave2.test.ts
- Bash pre/post 批量创建/修改/删除测试
- 失败清理测试
- 缓存清理测试
- HEAD 协调测试

---

### 4.5 attributionTrailer.ts 模块设计卡

#### 真实入口签名与关键类型

```typescript
// 仅两个导出
function nonNegativeDelta(current: number, atLastCommit: number): number
function buildPRTrailers(
  data: AttributionData,
  state: AttributionState
): string[]
```

#### 输入输出设计

**buildPRTrailers 输入输出：**
- 输入：AttributionData（完整归因）、AttributionState（计数器）
- 输出：string[]，Git trailer 格式
  - Claude-Code-Contribution: N（仅当有字符贡献时）
  - Claude-Code-Prompts: N（仅当增量>0时）
  - Claude-Code-Permission-Prompts: N（仅当增量>0时）
  - Claude-Code-Escapes: N（仅当增量>0时）

**nonNegativeDelta 细节：**
- 计算：`Math.max(0, Math.trunc(current) - Math.trunc(atLastCommit))`
- 确保非负、截断小数（安全处理意外浮点）

#### 模块级与显式状态

**纯函数设计：**
- 无模块级状态
- 无缓存
- 输出完全由输入决定

#### Trailer 生成流程

```
buildPRTrailers(data, state)
  → 检查 claudeChars+humanChars>0
  → 计算百分比（clamp 0-100，round）
  → 计算三个计数器的 nonNegativeDelta
  → 收集值>0的trailer
  → 返回string[]
```

#### 错误恢复与幂等

**安全边界：**
- claudePercent：`Number.isFinite()` 检查 → 默认 0
- clamp：`Math.min(100, Math.max(0, ...))` 确保范围
- 非负增量：`Math.max(0, ...)`

#### 设计取舍与备选

| 取舍项 | 实际选择 | 备选方案 | 代价 | 收益 | 证据位置 |
|-------|---------|---------|------|------|---------|
| Trailer 内容 | 仅统计，无路径 | 包含文件明细 | 无法追溯具体文件 | 无敏感信息泄露 | buildPRTrailers |
| 增量计算 | 当前-上次提交 | 显示总数 | 跨提交统计不直观 | 每次提交只显示自上次的活动 | nonNegativeDelta |
| 零值处理 | 省略零值 trailer | 始终显示 | 缺少时可能误以为功能关闭 | 简洁，不干扰 commit message | buildPRTrailers |

#### 源码测试证据

**实现证据：**
- buildPRTrailers：仅构造四个 Claude-Code-* trailer
- nonNegativeDelta：Math.trunc 防浮点、Math.max(0, ...) 防负
- 公共 trailers 无路径、无会话 ID、无仓库信息

**测试覆盖：**
- tests/commitAttributionWave2.test.ts
- public trailers are ordered, numeric, non-negative and path-free 测试

---

### 4.6 postCommitAttribution.ts 模块设计卡

#### 真实入口签名与关键类型

```typescript
// 常量
const MANAGED_MARKER = '# Claude Code managed prepare-commit-msg dispatcher v1'
const USER_HOOK_SUFFIX = '.claude-user'
const INTERNAL_FLAG = '--internal-prepare-commit-msg-attribution'

// 公共入口
installPrepareCommitMsgHook(worktreePath: string, hooksDirectory?: string): Promise<void>
uninstallPrepareCommitMsgHook(worktreePath: string, hooksDirectory?: string): Promise<void>
persistAttributionStateForGit(snapshot: AttributionSnapshotMessage): Promise<void>
runPrepareCommitMsgAttribution(worktreePath: string, messagePath: string): Promise<void>
```

#### 输入输出设计

**installPrepareCommitMsgHook 流程：**
```
输入：worktreePath、可选 hooksDirectory
  → resolveHooksDirectory（git rev-parse --git-path hooks）
  → mkdir -p hooks 目录
  → lock 钩子目录（20 次重试，指数退避 20-250ms）
  → 读取现有钩子
  → 检查是否已包含 MANAGED_MARKER
  → 未管理且用户钩子存在：重命名为 .claude-user
  → 原子写入 dispatcher 脚本（tmp+rename，权限 0o755）
  → chmod +x（再次确保）
  → 失败回滚：如移动了用户钩子则移回
输出：Promise<void>，失败抛异常
```

**dispatcher 脚本内容（真实生成）：**
```bash
#!/bin/sh
# Claude Code managed prepare-commit-msg dispatcher v1
hook_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
user_hook="$hook_dir/prepare-commit-msg.claude-user"
if [ -f "$user_hook" ] || [ -L "$user_hook" ]; then
  if [ -x "$user_hook" ]; then
    "$user_hook" "$@"
    status=$?
  else
    /bin/sh "$user_hook" "$@"
    status=$?
  fi
  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
fi
'/path/to/node' '/path/to/cli' --internal-prepare-commit-msg-attribution '/path/to/worktree' "$1"
status=$?
if [ "$status" -ne 0 ]; then
  printf '%s\n' 'Claude Code attribution was unavailable; continuing commit.' >&2
fi
exit 0
```

**runPrepareCommitMsgAttribution 流程（独立入口）：**
```
输入：worktreePath、messagePath
  → setOriginalCwd/setCwdState（设置进程状态）
  → 动态 import attribution、attributionTrailer（避免加载完整 CLI）
  → 检查 attributionText 是否启用
  → 检查 Git 瞬态状态（是则跳过）
  → getStagedFiles（空则跳过）
  → readAttributionStates（从 .git/claude-code/attribution 读前 64 个）
  → calculateCommitAttribution
  → 合并计数器（多会话累加）
  → 读取原始 commit message
  → 清理最后一段中的 Claude-Code-* trailer（保留用户其他内容）
  → git interpret-trailers --if-exists replace --if-missing add
  → 原子写入 messagePath
输出：Promise<void>，失败仅警告，不阻塞提交
```

**persistAttributionStateForGit 流程：**
```
输入：AttributionSnapshotMessage
  → resolveGitDirectory
  → 确保 .git/claude-code/attribution 存在（权限 0o700）
  → 文件名：sha256(sessionId).json
  → 原子写入（权限 0o600）
输出：Promise<void>，失败被 queuePersistence 捕获仅记录日志
```

**readAttributionStates 流程：**
```
输入：gitDir
  → 读取 .git/claude-code/attribution 目录
  → 文件名排序，取前 64 个
  → 过滤：64 字符 hex.json、文件<8MB、type='attribution-snapshot'
  → 解析失败仅跳过该文件
输出：AttributionState[]
```

#### 模块级与显式状态

**纯函数设计：**
- 无模块级状态
- 无缓存
- 每次操作重新读取 Git 状态

**Git 侧持久化结构：**
```
.git/
  claude-code/
    attribution/
      <sha256(sessionId)>.json  (0o600)
      ... 最多 64 个 ...
  (目录权限 0o700)
```

#### 文件修改追踪/提交关联/Trailer 流程

**完整提交流程：**
```
用户执行 git commit
  → Git 触发 prepare-commit-msg 钩子
  → dispatcher 先执行用户钩子（prepare-commit-msg.claude-user）
  → 用户钩子失败 → 终止提交
  → 用户钩子成功 → 执行 CLI --internal-prepare-commit-msg-attribution
  → 独立入口运行（不加载完整 CLI，不触发递归钩子安装）
  → 读取多会话状态，计算归因
  → 清理旧 Claude trailers，添加新 trailers
  → 归因失败 → 警告但继续提交（exit 0）
  → Git 继续提交
```

**Trailer 清理策略：**
- 仅清理最后一段（final paragraph）中的 Claude-Code-* 开头的行
- 保留用户的所有其他内容和其他 trailers（包括 Co-Authored-By）
- 使用 git interpret-trailers 进行规范替换/添加

#### 错误恢复与幂等

**钩子安装幂等：**
- 检查 MANAGED_MARKER，已管理则跳过
- 原子写入防止部分写入
- 锁防止并发安装/卸载
- 失败回滚用户钩子位置

**持久化失败降级：**
- persistAttributionStateForGit 异常被 queuePersistence 捕获
- 仅记录 debug 日志，不阻塞工具执行
- prepare-commit-msg 时该会话归因丢失，其他会话正常

**归因状态读取降级：**
- 损坏的 JSON 文件仅跳过该文件
- 超限文件（>8MB）跳过
- 错误类型（非 attribution-snapshot）跳过

**提交时降级：**
- Git 瞬态状态 → 跳过归因
- 无暂存文件 → 跳过
- 无会话状态 → 跳过
- git interpret-trailers 失败 → 警告但继续（exit 0）

#### 设计取舍与备选

| 取舍项 | 实际选择 | 备选方案 | 代价 | 收益 | 证据位置 |
|-------|---------|---------|------|------|---------|
| 钩子管理 | dispatcher+用户钩子分离 | 直接覆盖用户钩子 | 实现复杂 | 保留用户现有工作流，可卸载 | installPrepareCommitMsgHook、dispatcher |
| 持久化位置 | .git/claude-code/attribution | .claude 目录 | 仅限 Git 仓库 | 随仓库移动，Git 忽略，不污染工作区 | persistAttributionStateForGit |
| 会话文件限制 | 64 个（文件名排序） | 无限制 | 旧会话归因丢失 | 防止磁盘泄漏，性能可控 | readAttributionStates |
| 独立入口 | --internal-prepare-commit-msg-attribution | 复用主 CLI | 需谨慎避免递归 | 启动快，不触发钩子安装 | runPrepareCommitMsgAttribution |
| 原子写入 | tmp+rename | 直接写入 | 稍复杂 | 防止部分写入损坏文件 | atomicWrite |
| 并发控制 | lockfile（目录锁） | 无锁 | 稍慢 | 防止并发安装/卸载竞态 | installPrepareCommitMsgHook、uninstallPrepareCommitMsgHook |

#### 源码测试证据

**真实常量证据：**
- MANAGED_MARKER 版本 v1
- USER_HOOK_SUFFIX = .claude-user
- 会话文件权限 0o600，目录 0o700
- 64 会话上限，8MB 文件上限
- 锁重试：20 次，指数退避 20-250ms

**实现证据：**
- dispatcher：先执行用户钩子，失败则终止提交
- atomicWrite：临时文件+重命名，确保原子性
- runPrepareCommitMsgAttribution：动态 import 避免加载完整 CLI
- trailer 清理：仅清理最后一段的 Claude-Code-* 行
- 失败处理：归因失败 exit 0，仅警告

**测试覆盖：**
- tests/commitAttributionWave2.test.ts
- preserve an executable user hook, markers, managed trailers and uninstall 测试
- core.hooksPath 支持测试

---

### 4.7 AppState.attribution 快照设计说明

#### 真实状态归属

**AppState.attribution 定位：**
- 仅为持久化快照，不参与运行时归因计算
- 类型：AttributionState（与运行时相同结构）
- 实际运行时状态归属：
  - attributionHooks 闭包中的当前状态（通过 context.getAppState().attribution 访问）
  - Git 侧持久化：.git/claude-code/attribution/<sha256(sessionId)>.json
  - 会话存储：AttributionSnapshotMessage 序列

#### 更新流程

```
updateAndPersist(context, updater)
  → context.updateAttributionState(prev => {
      updated = updater(prev)
      changed = updated !== prev
      return updated
    })
  → changed ? queuePersistence(updated) : 跳过
  → queuePersistence：
    · stateToSnapshotMessage
    · recordAttributionSnapshot（会话存储）
    · persistAttributionStateForGit（Git 侧）
```

#### 会话恢复流程

```
会话启动/恢复
  → 从会话存储读取 AttributionSnapshotMessage[] 列表
  → restoreAttributionStateFromSnapshots(snapshots)
    · 仅取最后一个快照（完整状态）
    · 恢复 fileStates、sessionBaselines、startingHeadSha、promptCount* 等
  → 设置至 AppState.attribution
```

#### 设计要点

- AppState.attribution 与运行时状态同步但独立
- 状态更新不可变（返回新对象）
- 持久化队列化，不阻塞工具执行

### 4.8 主控制流

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

### 4.9 关键数据结构

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

### 4.10 跨子系统依赖

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

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | 当前实现多次编辑同一位置会导致 claudeContribution 不断累加（如把 `a` 改成 `b` 再改回 `a`，贡献 = 1 + 1 = 2，而实际净变化为 0） | 保留累加模式用于”活动量”指标，新增”净贡献”模式用于最终百分比；净贡献对比 sessionBaseline vs 最终提交内容，取最大变更区域；在 trailer 中可同时显示（或切换）两种指标 | 中，需要修改 calculateCommitAttribution，但可以向后兼容（保留现有字段，新增字段） | 在同一文件多次编辑后验证净贡献正确 | M | 设计推断 |
| P1 | 当前通过 Bash 重命名文件时，归因会按新路径重新开始，丢失旧路径的历史贡献；复制文件会被计为全新创建 | 在 calculateCommitAttribution 时，通过 Git diff 的 rename/copy 检测关联路径；把旧路径的贡献迁移到新路径；或在跟踪层检测 inode 变化（但跨平台复杂） | 中，需要修改 calculateCommitAttribution 的路径处理逻辑 | 重命名文件后验证贡献被保留 | M | 设计推断 |
| P2 | 当前 AttributionData 只在内存中计算并用于生成 trailers，不持久化；详细的按文件归因无法追溯 | 在 prepare-commit-msg 时，将完整 AttributionData JSON 写入 Git notes（如 refs/notes/claude-code-attribution）；提供工具查看历史归因；公共 commit message 仍只包含统计 trailers | 低，新增功能，不影响现有行为 | 提交后验证 Git notes 存在且数据正确 | M | 设计推断 |
| P2 | 当前只有全局开关（settings.attribution.commit/pr），无法按文件/目录配置（如某些目录关闭归因，某些目录强制归因） | 支持 .claude-attribution-ignore 文件（类似 .gitignore）；支持按路径模式配置是否归因；支持配置贡献计算策略（字符 vs 行，净贡献 vs 累加） | 低，新增配置，默认行为不变 | 验证忽略规则生效 | S | 设计推断 |
| P2 | 当前无用户界面查看详细归因，调试困难；用户无法预览提交前的归因数据 | 新增 `/attribution` 或 `/status` 命令显示当前会话的归因状态；在 prepare-commit-msg 前可选地显示预览；暴露调试日志开关（当前已有 logForDebugging，但无开关） | 低，新增 UI，不影响核心逻辑 | 验证命令输出正确 | S | 设计推断 |

