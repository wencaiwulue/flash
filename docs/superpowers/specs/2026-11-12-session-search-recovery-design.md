---
id: session-search-recovery
batch: 3
title: Session Search & Recovery 会话发现与跨项目恢复设计
date: 2026-11-12
status: draft
---

## 1. 概述

Session Search & Recovery 是 Claude Code 中用于发现、搜索和恢复会话的核心功能集。它允许用户：
- 在本地和跨项目中发现历史会话
- 通过语义搜索快速定位相关会话
- 恢复中断的会话，包括跨项目和共享会话
- 处理并发会话冲突
- 兼容历史会话格式并进行回填

## 2. 架构设计

### 2.1 核心模块组成

```
会话发现与恢复架构
├── 会话发现 (Session Discovery)
│   ├── 本地会话列表 (listSessionsImpl)
│   ├── 助手会话发现 (discoverAssistantSessions)
│   └── 工作树扫描 (getWorktreePathsPortable)
├── 会话搜索 (Session Search)
│   ├── 基础过滤 (logContainsQuery)
│   ├── 智能排序 (agenticSessionSearch)
│   └── 转录本提取 (extractTranscript)
├── 会话恢复 (Session Recovery)
│   ├── 消息反序列化 (deserializeMessages)
│   ├── 中断检测 (detectTurnInterruption)
│   ├── 技能状态恢复 (restoreSkillStateFromMessages)
│   └── 跨项目恢复 (checkCrossProjectResume)
├── 并发会话 (Concurrent Sessions)
│   ├── 会话注册 (registerSession)
│   ├── 活动更新 (updateSessionActivity)
│   └── 墓碑记录 (writeSessionTombstone)
└── 历史回填 (Backfill)
    ├── 元数据重建 (backfillSessionMetadata)
    └── 缓存管理 (saveSessionMeta/loadCachedSessionMeta)
```

### 2.2 数据流程

#### 会话发现流程
1. **候选发现阶段**：通过 `listCandidates` 扫描项目目录，仅执行 `stat` 系统调用获取 mtime
2. **排序过滤阶段**：对候选按 mtime 降序排序，批量读取文件头/尾
3. **元数据提取阶段**：通过 `parseSessionInfoFromLite` 从 JSONL 头/尾提取会话信息
4. **去重返回阶段**：按 sessionId 去重，保留最新版本

#### 会话搜索流程
1. **预过滤阶段**：`logContainsQuery` 快速检查标题、标签、分支、摘要等字段
2. **加载阶段**：对 lite 日志调用 `loadFullLog` 获取完整转录本
3. **AI 排序阶段**：`agenticSessionSearch` 使用小模型进行语义相关性排序
4. **结果返回阶段**：按相关性顺序返回会话列表

#### 会话恢复流程
1. **加载阶段**：`loadConversationForResume` 从 sessionId/jsonl/最近会话加载
2. **反序列化阶段**：`deserializeMessagesWithInterruptDetection` 处理消息并检测中断
3. **状态恢复阶段**：恢复技能状态、文件历史、计划等
4. **钩子执行阶段**：运行 `processSessionStartHooks('resume')`
5. **返回结果阶段**：包含消息、中断状态、元数据等

## 3. 核心功能设计

### 3.1 会话发现 (Session Discovery)

#### 3.1.1 本地会话列表 (listSessionsImpl)

**设计目标**：高效列出会话元数据，支持分页和工作树扫描

**关键设计**：
- **双路径策略**：
  - 无 limit/offset 时：`readAllAndSort` — 跳过 stat，直接读取所有文件然后排序
  - 有 limit/offset 时：`applySortAndLimit` — 先 stat 排序，再批量读取头部
- **Lite 读取优化**：`readSessionLite` 仅读取文件头 8KB 和尾 8KB，避免全量解析
- **工作树感知**：支持扫描同一 repo 的多个 git worktree
- **类型安全标签提取**：仅从 `{"type":"tag"}` 行提取 tag，避免与 tool_use 输入中的 tag 参数冲突

**字段提取优先级**：
```typescript
// customTitle > lastPrompt > summary > firstPrompt
const summary = customTitle || extractLastJsonStringField(tail, 'lastPrompt') ||
  extractLastJsonStringField(tail, 'summary') || firstPrompt
```

**分页 I/O 成本**：
- 1000 个会话，limit: 20 → ~1000 stats + ~20 head/tail reads
- 无 limit → 1000 head/tail reads（与原实现一致）

#### 3.1.2 助手会话发现 (discoverAssistantSessions)

**设计目标**：从远程 API 发现云端会话

**关键设计**：
- API 端点：`/v1/sessions`，支持 beta header `ccr-byoc-2025-07-29`
- 字段归一化：兼容多种响应格式（`id`/`sessionId`/`session_id`，`lastActiveAt`/`last_active_at`/`updated_at`）
- 超时控制：15 秒超时
- 排序：按 `lastActiveAt` 降序

### 3.2 会话搜索 (Session Search)

#### 3.2.1 智能会话搜索 (agenticSessionSearch)

**设计目标**：结合关键词匹配和语义理解，提供高召回率的搜索

**关键设计**：
- **预过滤优先**：先通过 `logContainsQuery` 快速筛选包含关键词的会话
- **上下文补全**：如果匹配数不足 `MAX_SESSIONS_TO_SEARCH`，用最近的非匹配会话补全
- **转录本提取**：`extractTranscript` 从消息开头和结尾各取部分，总长度限制 `MAX_TRANSCRIPT_CHARS`
- **小模型调用**：使用 `getSmallFastModel()` 进行排序，降低延迟和成本
- **容错设计**：JSON 解析失败、模型调用失败时返回空数组或预过滤结果

**提示词设计要点**：
- 优先级：Exact tag match > Partial tag match > Title match > Branch match > Summary/Transcript
- 高召回策略："When in doubt, INCLUDE the session"
- 输出格式：纯 JSON `{"relevant_indices": [2, 5, 0]}`

**搜索字段**：
```
Session metadata fields:
- Title / Custom Title
- Tag (user-assigned category)
- Branch (git branch name)
- Summary (AI-generated)
- First Prompt
- Transcript excerpt (from beginning and end)
```

#### 3.2.2 基础过滤 (logContainsQuery)

**设计目标**：快速进行关键词匹配，避免不必要的全量加载

**检查顺序**：
1. 显示标题 (`getLogDisplayTitle`)
2. 自定义标题 (`customTitle`)
3. 标签 (`tag`)
4. 分支 (`gitBranch`)
5. 摘要 (`summary`)
6. 首个提示 (`firstPrompt`)
7. 转录本 (`messages`) — 最昂贵，最后检查

### 3.3 会话恢复 (Session Recovery)

#### 3.3.1 消息反序列化 (deserializeMessagesWithInterruptDetection)

**设计目标**：将持久化的 JSONL 消息转换为可执行格式，同时检测会话中断状态

**处理步骤**：
1. **旧格式迁移**：`migrateLegacyAttachmentTypes` 转换 legacy attachment 类型
2. **权限模式验证**：清除无效的 `permissionMode` 值
3. **未解决工具调用过滤**：`filterUnresolvedToolUses` 移除未配对的 tool_use
4. **孤立思考消息过滤**：`filterOrphanedThinkingOnlyMessages` 移除无法配对的 thinking
5. **空白助手消息过滤**：`filterWhitespaceOnlyAssistantMessages` 移除仅含空白的消息
6. **中断检测**：`detectTurnInterruption` 判断会话是否中断
7. **合成哨兵消息**：在最后一条用户消息后添加 `NO_RESPONSE_REQUESTED` 助手消息

#### 3.3.2 中断检测 (detectTurnInterruption)

**设计目标**：准确识别会话中断类型，支持自动继续

**中断类型**：
- `none`：会话正常完成
- `interrupted_prompt`：用户发送了消息但助手未开始响应
- `interrupted_turn`：助手开始响应但未完成（在 streaming 路径中常见）

**判断逻辑**：
```
Last relevant message (skip system/progress/API error):
  - Assistant → none (completed)
  - User:
    - isMeta/isCompactSummary → none
    - tool_result for Brief/SendUserFile → none (terminal)
    - other tool_result → interrupted_turn
    - plain text → interrupted_prompt
  - Attachment → interrupted_turn
```

**终端工具结果检测**：
- Brief Tool (`BRIEF_TOOL_NAME`/`LEGACY_BRIEF_TOOL_NAME`)
- Send User File Tool (`SEND_USER_FILE_TOOL_NAME`)

#### 3.3.3 技能状态恢复 (restoreSkillStateFromMessages)

**设计目标**：从消息附件中恢复技能状态，确保压缩后技能不丢失

**关键设计**：
- 从 `invoked_skills` 附件恢复已调用技能
- 遇到 `skill_listing` 附件时设置 `suppressNextSkillListing()`，避免重复公告
- 仅为主会话恢复（agentId = null）

#### 3.3.4 跨项目恢复 (checkCrossProjectResume)

**设计目标**：识别跨项目会话，提供正确的恢复指令

**结果类型**：
- `isCrossProject: false`：当前项目会话，可直接恢复
- `isCrossProject: true, isSameRepoWorktree: true`：同一 repo 的不同 worktree，可直接恢复
- `isCrossProject: true, isSameRepoWorktree: false`：不同 repo，生成 `cd <path> && claude --resume <id>` 命令

**分阶段发布**：worktree 检测仅对 `USER_TYPE=ant` 启用

### 3.4 并发会话 (Concurrent Sessions)

#### 3.4.1 会话注册 (registerSession)

**设计目标**：追踪活跃会话，避免并发冲突

**注册文件**：`$CLAUDE_CONFIG_HOME/sessions/<pid>.json`，权限 0600

**记录字段**：
```typescript
{
  version?: 'background-sessions-v1',
  launchId?: string,
  sessionId: string,
  pid: number,
  processStartToken?: string,
  cwd: string,
  startedAt: number,
  kind: SessionKind, // 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
  entrypoint?: string,
  name?: string,
  logPath?: string,
  messagingSocketPath?: string,
  status?: SessionStatus | 'starting', // 'busy' | 'idle' | 'waiting'
  waitingFor?: string | null,
  updatedAt: number,
  registeredAt: number,
  lifecycle?: 'launching' | 'running' | 'stopping' | 'stopped' | 'failed', // bg only
  tmuxSocket?: string, // bg only
  tmuxSocketPath?: string, // bg only
  tmuxSession?: string, // bg only
  tmuxServerPid?: number, // bg only
  tmuxPanePid?: number, // bg only
  ownerUid?: number, // bg only
  exit?: { code: number | null, signal: string | null, reason: string, ended_at: number } // bg only
}
```

**原子写入**：使用临时文件 + rename 确保原子性

#### 3.4.2 会话墓碑 (writeSessionTombstone)

**设计目标**：记录已结束后台会话的退出信息

**墓碑文件**：`$CLAUDE_CONFIG_HOME/session-tombstones/<sessionId>.json`

**清理时机**：bg 会话退出时，在 cleanup hook 中写入墓碑

#### 3.4.3 活动更新 (updateSessionActivity)

**设计目标**：异步更新会话状态，避免阻塞主流程

**队列机制**：`updateQueue` Promise chain 确保更新按顺序执行

### 3.5 历史回填 (Backfill)

#### 3.5.1 元数据重建 (backfillSessionMetadata)

**设计目标**：为历史会话重建缺失的元数据缓存

**处理流程**：
1. **列出会话文件**：获取所有 `.jsonl` 文件
2. **加载缓存元数据**：检查 `$CLAUDE_CONFIG_HOME/session-meta/<id>.json`
3. **验证/重建**：
   - 有效且非 force：保留
   - 缺失/损坏：从 transcript 重建
4. **去重**：同一 sessionId 多个文件，保留最新
5. **原子保存**：`saveSessionMeta` 使用 0600 权限原子写入

**报告字段**：
```typescript
{
  valid: number,
  rebuilt: number,
  failed: number,
  duplicates: number
}
```

#### 3.5.2 缓存管理

**设计目标**：安全、高效地缓存会话元数据

**安全特性**：
- 权限 0600
- 原子写入（临时文件 + rename）
- 损坏检测（JSON 解析失败返回 null）
- 并发防护（`withLock`）

### 3.6 共享会话恢复 (ccshareResume)

#### 3.6.1 ccshare ID 解析 (parseCcshareId)

**设计目标**：安全解析 ccshare URL 或 ID

**ID 格式**：`/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`

**URL 格式**：`https://<origin>/ccshare/<id>`

#### 3.6.2 转录本下载 (loadCcshare)

**设计目标**：安全下载和加载共享会话

**安全特性**：
- 仅 HTTPS
- 跨域重定向需确认
- 凭证文件权限 0600
- 大小限制（默认 10MB）
- 行数限制（默认 20,000 行）
- 超时控制（默认 15 秒）
- 重定向限制（最多 5 次）
- 下载到临时文件，权限 0600
- **关键**：共享会话的 `projectPath` 设为 `undefined`，防止任意目录切换

**内容类型验证**：`application/x-ndjson` 或 `application/jsonl`

## 4. 设计决策

### 决策 1：Lite 读取策略 — 仅读头 8KB + 尾 8KB

**备选方案**：
1. 全量 JSONL 解析
2. 固定读取前 N 行
3. 索引文件

**选择理由**：
- 头包含创建时间、初始消息
- 尾包含最新标题、摘要、标签、分支
- 8KB 足够覆盖大多数会话的元数据
- 避免加载可能数十 MB 的完整转录本

**代价**：
- 某些元数据可能在中间部分丢失
- 需要优雅降级（头中找不到时去尾找，反之亦然）

**证据**：`parseSessionInfoFromLite` 实现同时检查头和尾

### 决策 2：分页时先 stat 后读取

**备选方案**：
1. 总是读取所有文件
2. 维护单独的索引数据库

**选择理由**：
- stat 是 O(1) 系统调用，远快于文件读取
- 对于 "最近 20 个会话" 场景，I/O 成本从 1000 reads 降为 1000 stats + 20 reads
- 无外部依赖，无数据库同步问题

**代价**：
- 有 limit 时需要两次 pass（stat pass + read pass）
- mtime 相同的会话通过 sessionId 字符串比较稳定排序

**证据**：`listSessionsImpl` 中的 `doStat` 条件判断

### 决策 3：Tag 提取仅从 `{"type":"tag"}` 行

**备选方案**：
1. 从任意 JSON 行提取 `tag` 字段
2. 使用特殊前缀避免冲突

**选择理由**：
- tool_use 输入中常包含 `tag` 参数（git tag、Docker tag、云资源 tag）
- 避免误将工具输入中的 tag 当作会话标签
- 类型安全，语义明确

**代价**：
- 旧格式会话如果没有 `{"type":"tag"}` 行，无法提取 tag
- 需要向后兼容（优先从尾找，再从头找）

**证据**：代码中的注释："Type-scope tag extraction to the `{"type":"tag"}` JSONL line to avoid collision with tool_use inputs containing a `tag` parameter"

### 决策 4：中断检测时跳过 system/progress/API error 消息

**备选方案**：
1. 总是看最后一条消息
2. 单独的中断标记字段

**选择理由**：
- system/progress 是簿记消息，不表示对话状态
- API error 助手消息已在发送前过滤，不应视为完成
- 兼容历史格式，无需修改持久化数据

**代价**：
- 逻辑稍复杂，需要回溯查找最后一条相关消息

**证据**：`detectTurnInterruption` 中的 `findLastIndex` 条件

### 决策 5：共享会话的 projectPath 设为 undefined

**备选方案**：
1. 保留原始 projectPath
2. 提示用户确认

**选择理由**：
- 安全第一：共享会话来自不受信任来源，不应自动切换工作目录
- 防止目录遍历攻击
- 用户可手动 cd 到目标目录

**代价**：
- 需要用户手动处理目录切换

**证据**：`loadCcshare` 中的 `return { ...log, projectPath: undefined }`

### 决策 6：会话注册使用 pid.json + 原子写入

**备选方案**：
1. 单个 SQLite 数据库
2. 单个 JSON 文件
3. 锁文件

**选择理由**：
- 无数据库依赖
- pid 天然唯一
- 原子写入避免并发损坏
- 故障恢复简单（检查进程是否仍在运行）

**代价**：
- 需要定期清理僵尸记录（不在这里做，留给 bg 清理）
- 枚举需要 readdir

**证据**：`writeSessionRegistryRecord` 中的临时文件 + rename 模式

### 决策 7：agenticSessionSearch 宁可返回过多结果不可遗漏

**备选方案**：
1. 高精确率，低召回率
2. 用户可调整的阈值

**选择理由**：
- 用户体验：找不到相关会话比看到几个不相关的更令人沮丧
- 用户可以快速扫描结果，自己过滤
- 后续可添加相关性分数显示

**代价**：
- 可能包含不相关会话
- 结果列表较长

**证据**：提示词中的 "CRITICAL: Be VERY inclusive in your matching. When in doubt, INCLUDE the session."

### 决策 8：跨项目 worktree 检测仅对 ants 启用

**备选方案**：
1. 对所有用户启用
2. 配置开关

**选择理由**：
- 分阶段发布，降低风险
- 内部 dogfooding 先验证
- 发现问题可快速回滚

**代价**：
- 外部用户暂时无法享受此功能
- 代码中有条件分支

**证据**：`checkCrossProjectResume` 中的 `process.env.USER_TYPE !== 'ant'` 检查

## 5. 失败语义

### 5.1 会话发现失败

| 失败场景 | 处理方式 | 影响 |
|---------|---------|------|
| 项目目录不存在 | 返回空数组 | 无声失败，不报错 |
| 无法 stat 文件 | 跳过该文件 | 部分会话不可见 |
| JSONL 头/尾无法解析 | 跳过该会话 | 部分会话不可见 |
| 工作树检测失败 | 回退到单项目扫描 | 仅扫描当前目录 |

### 5.2 会话搜索失败

| 失败场景 | 处理方式 | 影响 |
|---------|---------|------|
| loadFullLog 失败 | 使用 lite log（无转录本） | 搜索质量下降 |
| 模型调用失败 | 返回空数组或预过滤结果 | 无 AI 排序，仅关键词匹配 |
| JSON 响应解析失败 | 返回空数组 | 无 AI 排序 |
| 超时 | 返回空数组 | 搜索失败 |

### 5.3 会话恢复失败

| 失败场景 | 处理方式 | 影响 |
|---------|---------|------|
| 会话文件不存在 | 返回 null | 无法恢复 |
| JSONL 解析失败 | 抛出错误 | 恢复失败 |
| 权限模式无效 | 清除该字段 | 继续恢复 |
| 工具调用配对失败 | 过滤未配对调用 | 部分历史丢失，但可继续 |

### 5.4 并发会话失败

| 失败场景 | 处理方式 | 影响 |
|---------|---------|------|
| 无法写入注册文件 | 记录 debug 日志，继续 | 会话不被追踪，但功能正常 |
| 无法读取注册表 | 返回空数组 | 并发检测失效 |
| 进程已退出但记录仍在 | 不计数，不删除 | 无害僵尸记录 |

### 5.5 共享会话失败

| 失败场景 | 处理方式 | 影响 |
|---------|---------|------|
| ID 格式无效 | 抛出错误 | 无法加载 |
| HTTP 非 2xx | 抛出错误 | 下载失败 |
| 内容类型错误 | 抛出错误 | 下载失败 |
| 超出大小/行数限制 | 抛出错误 | 下载失败 |
| 跨域重定向未确认 | 抛出错误 | 下载中止 |
| 超时 | 抛出错误 | 下载失败 |
| 凭证文件权限错误 | 抛出错误 | 无法使用认证 |

## 6. 历史回填与兼容

### 6.1 历史格式迁移

**Legacy Attachment 类型**：
- `new_file` → `file` + `displayPath`
- `new_directory` → `directory` + `displayPath`
- 无 `displayPath` 的旧附件 → 从 `filename`/`path`/`skillDir` 推断

**权限模式迁移**：
- 无效的 `permissionMode` 值 → 清除为 `undefined`

### 6.2 元数据回填策略

**触发时机**：
- 用户显式运行 `/backfill-sessions`
- 新功能需要元数据时（懒加载）

**回填范围**：
- 所有本地会话文件
- 跳过已有有效元数据的会话（除非 `--force`）
- `--dry-run` 预览不写入

**原子性**：
- 每个会话单独原子写入
- 失败不影响其他会话
- 使用锁防止并发回填

## 7. 安全考虑

### 7.1 文件权限

- 会话注册文件：0600
- 会话墓碑文件：0600
- 元数据缓存文件：0600
- 临时下载文件：0600
- ccshare 凭证文件：必须 0600，否则拒绝加载

### 7.2 输入验证

- ccshare ID：正则验证，防止路径遍历
- URL 解析：仅允许 HTTPS，无 userinfo，无 fragment
- 重定向：限制次数，跨域需确认
- 大小/行数限制：防止资源耗尽

### 7.3 不信任数据

- 共享会话的 `projectPath` 设为 `undefined`
- 权限模式值验证后清除
- Legacy 类型安全转换

## 8. 覆盖范围

[Coverage](../../architecture/coverage/session-search-recovery.yaml)

## 9. 总结与演进方向

### 当前状态

Session Search & Recovery 已提供完整的会话生命周期管理：
- 高效的发现和列表（支持分页、工作树）
- 结合关键词和 AI 的智能搜索
- 可靠的恢复（含中断检测、状态恢复）
- 跨项目/跨 worktree 支持
- 并发会话追踪
- 历史格式兼容和回填

### 演进方向

1. **搜索质量提升**：
   - 向量嵌入索引
   - 会话相似度聚类
   - 个性化排序（考虑用户历史行为）

2. **发现范围扩展**：
   - 云端会话与本地会话融合
   - 跨设备会话同步
   - 团队会话共享视图

3. **恢复增强**：
   - 自动继续中断的长运行任务
   - 选择性恢复（仅恢复文件历史/计划/技能）
   - 会话分支与合并

4. **性能优化**：
   - 增量索引更新
   - 异步预加载
   - 压缩存储
