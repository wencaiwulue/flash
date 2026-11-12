# Commit Attribution 公开契约

- 日期：2026-11-11
- 状态：公开实现设计，尚未实现
- 范围：工具 hook、文件 cache、Git prepare-commit-msg、commit/PR trailers

## 1. 复用边界与现状

真正的计算逻辑已经存在于 `src/utils/commitAttribution.ts`：`AttributionState`、`trackFileModification()`、`trackBulkFileChanges()`、`calculateCommitAttribution()`、`getStagedFiles()`、`isGitTransientState()`、模型名清理和 attribution snapshot 恢复。本契约直接复用这些函数，不另写一套字符 diff 或百分比算法。

空缺位于：

- `src/utils/attributionHooks.ts`：注册、cache 清理均为空。
- `src/utils/postCommitAttribution.ts`：hook 安装固定抛 unavailable。
- `src/utils/attributionTrailer.ts`：`buildPRTrailers()` 固定返回空数组。

`src/types/hooks.ts` 已给内部 callback 提供 `getAppState` 和 `updateAttributionState`；`src/utils/sessionFileAccessHooks.ts` 展示 `registerHookCallbacks()` 的用法。`src/utils/worktree.ts` 会把可选 hooksDirectory 传给安装函数，必须保留这一调用约束。`src/utils/attribution.ts` 已处理用户 `attribution.commit/pr`、旧 `includeCoAuthoredBy`、公开模型名和 PR 摘要。

这些空文件没有历史实现可恢复。下面的 trailer 名称、状态文件与 Git hook 链是新的公开设计，不宣称与内部 trailer 格式兼容。归因是本地估算，不是作者身份、版权或许可证明。

## 2. 端到端数据流

1. 初始化时 `registerAttributionHooks()` 幂等注册内部 PreToolUse/PostToolUse callback；不在模块 import 时执行 I/O。
2. Edit/Write 成功后，从实际工具输出读取 `filePath`、`originalFile`、新内容和 `userModified`，调用 `trackFileModification()`。失败 hook 不记账。
3. Bash 执行前对有界候选文件建立内容快照；成功后重新读取并用 `trackBulkFileChanges()` 记录 created/modified/deleted。失败或中止不记为 Claude 修改。
4. 每次状态更新后，以 `stateToSnapshotMessage()` 保存全量快照。恢复继续使用 `restoreAttributionStateFromSnapshots()` 的“最后一份全量快照”语义，禁止跨快照累加 fileStates。
5. Git 的 prepare-commit-msg 在 staged 集合仍存在时调用 `getStagedFiles()` 与 `calculateCommitAttribution()`，再用 `git interpret-trailers` 更新 commit message。commit 成功后更新 `promptCountAtLastCommit`、`permissionPromptCountAtLastCommit`、`escapeCountAtLastCommit` 和 HEAD baseline。
6. PR 文案复用 `getEnhancedPRAttribution()`；通用、无敏感路径的统计 trailers 由同一个 `buildPRTrailers()` 生成，commit 与 PR 不出现两套数值。

`calculateCommitAttribution([])` 当前会访问 `states[0]!`，实现时必须增加空集合保护并返回零值数据，不能让 hook 在无可归因会话中崩溃。

## 3. 工具 hook 契约

### 3.1 Edit/Write

使用现有工具的 input/output Zod schema 校验 `tool_input` 与 `tool_response`，不信任任意 JSON：

- Edit 使用 `originalFile` 和输出中的新文件内容；Write 使用 `originalFile ?? ''` 与 `content`。
- 路径经 `normalizeFilePath()`，mtime 经 `getFileMtime()`；通过 callback context 的 `updateAttributionState()` 原子更新。
- 在 updater 中保留更新后的 state，随后持久化一份新 snapshot；updater 返回原引用时不写重复快照。
- `_userModified` 目前在真实计算函数中并未用于区分贡献，公开文案不得声称它能精确扣除用户后续修改。

### 3.2 Bash

PreToolUse 按 toolUseID 保存 pending 快照，PostToolUse 必须配对并立即删除。候选来自已有 attribution paths、`git diff --name-only` 和未忽略 untracked 文件；排除 `.git`、符号链接逃逸、二进制、生成文件以及超过单文件/总字节上限的内容。命令只经现有 argv Git helper 执行，不经 shell 拼接。

PostToolUse 比较前后内容并构造 `modified | created | deleted` 批量变更；删除不能读取新内容时使用缓存旧内容。无法完整快照的大命令不伪造精确归因：记录诊断并跳过不完整项。pre/post 使用同一 repo root，cwd 或 worktree 改变时丢弃 pending。

## 4. Cache 与清理

`fileContentCache` 的 key 为 repo-root 加规范化相对路径，value 至少含内容、SHA-256、mtime/size。`sessionBaselines` 首次见到路径时建立，后续读取不得覆盖最早 baseline。cache 是归因辅助，不是 fileHistory 的替代品。

必须有明确上限：pending Bash 按 toolUseID 唯一；文件数、单文件字节、总字节和 TTL 均有界，LRU 淘汰不阻塞工具。禁止把文件正文写日志、trailer 或分析事件。

- `clearAttributionCaches()`：清空文件正文、pending Bash、配对状态及过期计时器；不清 AppState 中已经确认的 attribution，也不删除 transcript snapshots。
- `sweepFileContentCache()`：仅移除超 TTL/LRU 超额和已失效 pending，保留仍活跃命令需要的数据。
- `/clear`、compaction 和进程退出按现有调用点执行；清理函数幂等，重复注册不得使旧 cache 被另一套闭包持有。

`AttributionSnapshotMessage` 应增加可选的 `sessionBaselines` 与 `startingHeadSha` 并序列化，否则“全量快照”恢复后丢失人类修改基线。旧日志缺字段时恢复为空 Map/null，保持向后读取；仍只取最后快照，不能把多份 baselines 或贡献相加。

## 5. Git hook 安装且保留用户 hook

`installPrepareCommitMsgHook(worktreePath, hooksDirectory?)` 使用显式目录，否则通过 `git rev-parse --git-path hooks` 解析实际目录，不假定 `.git/hooks`（worktree、common dir 与 core.hooksPath 均可能存在）。安装用锁防止两个进程同时改写，且必须幂等。

### 5.1 链接策略

若已有非 Claude 管理的 `prepare-commit-msg`：

1. 原文件或 symlink 原子改名为同目录 `prepare-commit-msg.claude-user`，保留内容和 executable mode；已存在该备份时停止并报错，绝不覆盖第二份用户文件。
2. 新建带固定管理标记的 `prepare-commit-msg` dispatcher。
3. dispatcher 先以原样 `"$@"` 和 stdin 执行 `prepare-commit-msg.claude-user`；用户 hook 非零退出时原样返回，不运行 attribution。
4. 用户 hook 成功后，dispatcher 才执行 Claude attribution fast-path，使用户对 message 的修改进入最终 trailer 计算。helper 的失败只输出不含正文的警告并返回 0，不能阻止用户 commit。

无用户 hook 时 dispatcher 直接运行 helper。重复安装识别管理标记，不再次改名；更新只替换 Claude dispatcher。提供对应卸载逻辑：移除 dispatcher 并恢复 `.claude-user`，已有其他新文件时停止而非覆盖。用户之后可直接编辑 `.claude-user`，其 hook 不会被升级重写。

helper 走独立、无完整 CLI setup 的 fast-path，不加载项目 hooks、不发起模型请求、不递归安装 Git hook。路径用 argv 传递并正确 shell quote，不使用 `eval`，不把 OAuth token、文件正文或归因 JSON 放进命令行。hook 状态只含当前 repo/session 所需的归因数据，以 `0600` 写入 repo 私有状态目录，commit/进程结束后清理。

merge、rebase、cherry-pick、bisect 等 `isGitTransientState()`、无 staged 文件、非 Git 目录以及用户关闭 attribution 时跳过 Claude trailer，但仍执行用户 hook。helper 与 post-tool 成功处理以 commit SHA 对账，计数基准最多推进一次。

## 6. Trailer 格式与隐私

采用新的公开、机器可读 key：

```text
Claude-Code-Contribution: <0-100>
Claude-Code-Prompts: <non-negative integer>
Claude-Code-Permission-Prompts: <non-negative integer>
Claude-Code-Escapes: <non-negative integer>
```

规则：

- Contribution 直接取 `AttributionData.summary.claudePercent`，不重新计算；数值为整数，百分号不放在 value 中。
- 后三项分别取当前 state 与对应 `*AtLastCommit` 的非负差值；仅在有数据时出现，空会话不制造无意义零 trailers。
- `buildPRTrailers(data, state)` 是纯、确定性函数，固定上述顺序，不读取 cwd、模型或环境，不返回空行。
- 不包含文件路径、diff、session id、repo URL、内部模型名或用户文本。`AttributionData.files` 与 sessions 只用于本地计算，不能拼进 trailer。
- `getAttributionTexts().commit` 仍决定 Co-Authored-By 或用户自定义文本。相同 managed trailer 通过 `git interpret-trailers` 去重/替换，用户自己的其他 trailer 原样保留，不能重写整段 message。
- `attribution.commit === ''` 或旧 `includeCoAuthoredBy === false` 时不写 Co-Authored-By，也不写上述统计；自定义非空 commit 文本原样使用，不擅自追加默认文本。PR 同理尊重 `attribution.pr === ''`。
- 通用统计不含内部代号，因此不再需要 internal-repo allowlist；模型名称仍走现有 `sanitizeModelName()`/公开名逻辑，不能为支持外部构建而放开内部名。

PR trailers 追加在摘要之后并隔一空行，便于 squash merge 保留；不声称所有代码托管平台都会保留它们。

## 7. 失败与一致性

归因失败不得删除用户修改、阻止正常工具、改变 commit 的退出码或使 commit 部分写入 trailer 后又被 helper 重写。message 先写临时文件并校验，再原子替换 Git 给出的 message 文件。若进程在 prepare 后崩溃，未 commit 的 pending 状态不能推进计数；下次以 HEAD SHA 对账。生成文件沿用 `isGeneratedFile()` 排除，统计始终是非负估算值。

## 8. 验收测试（临时 Git，不触用户配置）

所有 Git 测试使用临时 HOME、`CLAUDE_CONFIG_DIR`、`GIT_CONFIG_NOSYSTEM=1`、指向临时文件的 `GIT_CONFIG_GLOBAL`，并在仓库本地设置 user.name/email；禁止读取或改写开发者真实 hooks、global config 和凭据。

1. Edit/Write 的成功、失败、非法输出、userModified、新建/删除和重复 snapshot；恢复多份快照不膨胀贡献。
2. Bash pre/post 配对、命令失败、中止、cwd 改变、二进制/大文件上限、批量创建/修改/删除及 cache 清理。
3. 空 states、generated 文件、无 staged 文件和 transient Git 状态不崩溃、不写统计。
4. 临时仓库安装无既有 hook、已有普通 hook、已有 executable/symlink hook、core.hooksPath、worktree hooksDirectory、重复安装和卸载。
5. 端到端预置用户 prepare-commit-msg：它写一行 marker/message，Claude dispatcher 必须保留 marker、用户 message 和退出码；用户 hook 失败时无 Claude trailer，成功时两类内容都存在。
6. 用户 hook 在 commit message 中写入同名 trailer 时只按 managed 规则去重，其他 Co-Authored-By/自定义 trailer 不丢。
7. `attribution.commit=''`、自定义 commit、旧开关、PR 空字符串和公开模型清理；trailer 永不泄露路径、session id、正文或 token。
8. helper 故障不阻止 commit；post-commit 对账只推进一次；多 worktree 与并发安装不覆盖用户文件。
