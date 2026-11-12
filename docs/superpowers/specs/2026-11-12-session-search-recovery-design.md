---
id: session-search-recovery
batch: 3
title: Session Search & Recovery 会话发现与跨项目恢复设计
date: 2026-11-12
status: draft
---

# Session Search & Recovery 会话发现与跨项目恢复设计

## 1. 问题与约束

Session Search & Recovery 面临以下核心问题与约束：

1. **会话发现效率**：需要在不加载完整文件的情况下快速列出历史会话
2. **跨项目恢复**：支持在不同项目甚至不同 Git worktree 间恢复会话
3. **并发会话隔离**：防止多个 Claude Code 实例同时操作同一会话
4. **历史格式兼容**：兼容旧版本会话格式，无需用户手动迁移
5. **共享会话安全**：ccshare 会话不能自动切换工作目录或执行 hook
6. **元数据缓存**：需要安全、原子的元数据缓存机制，避免损坏

## 2. 设计理由与备选方案

### 2.1 Lite 读取策略：仅读头 8KB + 尾 8KB

- **备选方案**：
  - 全量 JSONL 解析：简单但 I/O 开销大
  - 固定读取前 N 行：元数据可能在末尾
  - 索引文件：额外复杂性和同步问题
- **选择理由**：头包含创建时间，尾包含最新标题/摘要/标签/分支，8KB 足够覆盖大多数会话元数据
- **代价**：某些元数据可能在中间部分丢失，需优雅降级
- **证据**：`parseSessionInfoFromLite` 同时检查头和尾

### 2.2 分页时先 stat 后读取

- **备选方案**：
  - 总是读取所有文件：无 limit 时采用
  - 维护单独索引数据库：同步复杂
- **选择理由**：stat 是 O(1) 系统调用，远快于文件读取，对于 "最近 20 个会话" 场景，I/O 成本从 1000 reads 降为 1000 stats + 20 reads
- **代价**：有 limit 时需要两次 pass

### 2.3 Tag 提取仅从 `{"type":"tag"}` 行

- **备选方案**：从任意 JSON 行提取 tag、使用特殊前缀
- **选择理由**：tool_use 输入中常包含 tag 参数，避免误将工具输入中的 tag 当作会话标签
- **代价**：旧格式会话如果没有 `{"type":"tag"}` 行，无法提取 tag

### 2.4 共享会话的 projectPath 设为 undefined

- **备选方案**：保留原始 projectPath、提示用户确认
- **选择理由**：安全第一，共享会话来自不受信任来源，不应自动切换工作目录
- **代价**：需要用户手动处理目录切换

### 2.5 会话注册使用 pid.json + 原子写入

- **备选方案**：SQLite、单个 JSON 文件、锁文件
- **选择理由**：无数据库依赖，pid 天然唯一，原子写入避免并发损坏
- **代价**：需要定期清理僵尸记录

## 3. 目标与非目标

### 3.1 目标

1. **高效会话发现**：支持分页列出最近会话，仅在必要时读取完整文件
2. **智能搜索**：结合关键词匹配和 AI 排序，提供高召回率搜索
3. **可靠恢复**：支持中断检测、状态恢复、跨项目/跨 worktree 恢复
4. **并发安全**：会话注册、墓碑机制防止冲突
5. **历史兼容**：支持旧格式会话回填和迁移
6. **安全共享**：ccshare 会话隔离执行，不自动切换目录

### 3.2 非目标

1. **云端会话同步**：不在当前范围内（见 Teleport）
2. **实时协作**：不支持多用户同时编辑同一会话
3. **向量索引**：当前不使用嵌入向量进行语义搜索
4. **跨设备同步**：不自动跨设备同步会话

## 4. 架构、模块与数据流

### 4.1 核心模块组成

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

### 4.2 数据流程

#### 4.2.1 会话发现流程

1. **候选发现阶段**：通过 `listCandidates` 扫描项目目录，仅执行 `stat` 系统调用获取 mtime
2. **排序过滤阶段**：对候选按 mtime 降序排序，批量读取文件头/尾
3. **元数据提取阶段**：通过 `parseSessionInfoFromLite` 从 JSONL 头/尾提取会话信息
4. **去重返回阶段**：按 sessionId 去重，保留最新版本

#### 4.2.2 会话搜索流程

1. **预过滤阶段**：`logContainsQuery` 快速检查标题、标签、分支、摘要等字段
2. **加载阶段**：对 lite 日志调用 `loadFullLog` 获取完整转录本
3. **AI 排序阶段**：`agenticSessionSearch` 使用小模型进行语义相关性排序
4. **结果返回阶段**：按相关性顺序返回会话列表

#### 4.2.3 会话恢复流程

1. **加载阶段**：`loadConversationForResume` 从 sessionId/jsonl/最近会话加载
2. **反序列化阶段**：`deserializeMessagesWithInterruptDetection` 处理消息并检测中断
3. **状态恢复阶段**：恢复技能状态、文件历史、计划等
4. **钩子执行阶段**：运行 `processSessionStartHooks('resume')`
5. **返回结果阶段**：包含消息、中断状态、元数据等

## 5. 失败语义与工程取舍

### 5.1 失败语义

| 失败场景 | 处理方式 | 影响 |
|---------|---------|------|
| 项目目录不存在 | 返回空数组 | 无声失败，不报错 |
| 无法 stat 文件 | 跳过该文件 | 部分会话不可见 |
| JSONL 头/尾无法解析 | 跳过该会话 | 部分会话不可见 |
| 工作树检测失败 | 回退到单项目扫描 | 仅扫描当前目录 |
| loadFullLog 失败 | 使用 lite log（无转录本） | 搜索质量下降 |
| 模型调用失败 | 返回空数组或预过滤结果 | 无 AI 排序，仅关键词匹配 |
| JSON 响应解析失败 | 返回空数组 | 无 AI 排序 |
| 超时 | 返回空数组 | 搜索失败 |
| 会话文件不存在 | 返回 null | 无法恢复 |
| JSONL 解析失败 | 抛出错误 | 恢复失败 |
| 权限模式无效 | 清除该字段 | 继续恢复 |
| 工具调用配对失败 | 过滤未配对调用 | 部分历史丢失，但可继续 |
| 无法写入注册文件 | 记录 debug 日志，继续 | 会话不被追踪，但功能正常 |
| 无法读取注册表 | 返回空数组 | 并发检测失效 |
| 进程已退出但记录仍在 | 不计数，不删除 | 无害僵尸记录 |

### 5.2 工程取舍

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| Lite 读取策略 | 头 8KB + 尾 8KB | 部分元数据可能丢失 | 大幅减少 I/O |
| 分页策略 | 先 stat 后读取 | 两次 pass | 大幅减少读取量 |
| 标签提取 | 仅从 type:tag 行 | 旧格式可能无标签 | 避免与工具输入冲突 |
| 中断检测 | 跳过 system/progress/API error | 逻辑复杂 | 正确识别中断状态 |
| 共享会话 | projectPath undefined | 需手动切换目录 | 安全优先 |
| 会话注册 | pid.json + 原子写入 | 需清理僵尸 | 无数据库依赖 |
| agentic 搜索 |宁可返回过多不要遗漏 | 可能包含不相关 | 用户体验优先 |
| 跨项目 worktree |仅对 ants 启用 |外部用户暂不可用 |分阶段发布降风险 |

## 6. 现状验收标准

### 6.1 功能验收标准

- **会话发现**：
  - 可以无 limit 列出所有会话
  - 可以分页列出最近 N 个会话
  - 可以扫描同一 repo 的多个 worktree
  - 可以从远程 API 发现助手会话
  - 标签提取仅从 `{"type":"tag"}` 行进行

- **会话搜索**：
  - `logContainsQuery` 可以过滤标题、标签、分支、摘要
  - `agenticSessionSearch` 可以按相关性排序
  - 搜索失败时回退到预过滤结果

- **会话恢复**：
  - 可以从 sessionId、jsonl 或最近会话恢复
  - 可以检测 `interrupted_prompt` 和 `interrupted_turn`
  - 可以恢复技能状态
  - 可以识别跨项目/跨 worktree 会话并提供正确指令

- **并发会话**：
  - 会话注册使用 pid.json 原子写入
  - 活动更新使用队列机制
  - 墓碑记录在 bg 会话退出时写入

- **历史回填**：
  - `/backfill-sessions` 可以重建元数据缓存
  - 回填是幂等的
  - 旧格式附件类型正确迁移

- **共享会话**：
  - `ccshare` ID 可以从 URL 解析
  - 下载受大小/行数/超时限制
  - 跨域重定向需要确认
  - projectPath 设为 undefined

## 7. 代码与测试证据

### 7.1 核心实现文件

- **会话发现**：
  - `src/sessions/list.ts` - `listSessionsImpl`、`parseSessionInfoFromLite`
  - `src/sessions/assistant-sessions.ts` - `discoverAssistantSessions`
  - `src/sessions/worktree-paths.ts` - `getWorktreePathsPortable`

- **会话搜索**：
  - `src/sessions/search.ts` - `agenticSessionSearch`、`extractTranscript`
  - `src/sessions/log-contains-query.ts` - `logContainsQuery`

- **会话恢复**：
  - `src/sessions/load.ts` - `loadConversationForResume`
  - `src/sessions/deserialize-messages.ts` - `deserializeMessagesWithInterruptDetection`
  - `src/sessions/detect-turn-interruption.ts` - `detectTurnInterruption`
  - `src/sessions/cross-project-resume.ts` - `checkCrossProjectResume`

- **并发会话**：
  - `src/sessions/concurrent.ts` - `registerSession`、`updateSessionActivity`、`writeSessionTombstone`

- **历史回填**：
  - `src/sessions/backfill.ts` - `backfillSessionMetadata`
  - `src/sessions/session-meta-cache.ts` - `saveSessionMeta`、`loadCachedSessionMeta`

- **共享会话**：
  - `src/sessions/ccshare.ts` - `parseCcshareId`、`loadCcshare`

### 7.2 测试覆盖

现有测试覆盖：
- 会话列表功能
- ccshare 解析与下载
- 中断检测逻辑
- 并发会话注册

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/session-search-recovery.yaml)

### 8.1 相关子系统

- **Commands Framework**：`/resume`、`/session list`、`/backfill-sessions` 命令
- **Session Sharing**：ccshare 恢复与本系统紧密集成
- **Skills System**：技能状态恢复依赖本系统
- **Hook System**：会话恢复时执行 resume hook
- **Git Integration**：worktree 扫描依赖 Git 检测

## 9. 改进建议

### 9.1 短期改进

1. **向量嵌入搜索**：为会话转录本生成向量嵌入，提供更准确的语义搜索
2. **增量索引**：当新会话写入时，增量更新元数据缓存，而非全量重建
3. **会话标签 UI**：提供更友好的标签管理界面，支持标签自动补全

### 9.2 中期改进

4. **云端会话融合**：本地会话与云端会话统一视图
5. **会话分支与合并**：支持从会话某点分叉，或合并多个会话
6. **选择性恢复**：支持仅恢复文件历史、仅恢复计划、或仅恢复技能

### 9.3 长期改进

7. **跨设备同步**：安全地跨设备同步会话
8. **会话分析**：分析用户会话模式，提供个性化建议
9. **团队会话库**：团队共享会话库，支持权限控制和搜索
