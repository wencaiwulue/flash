---
id: review-analysis
batch: 5
title: Review & Analysis 代码审查与上下文分析设计
date: 2026-11-12
status: draft
---

# Review & Analysis 代码审查与上下文分析设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用“负责管理”、“提高可靠性”、“保证一致性”等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

### 具体问题场景

**审查输入与 diff 范围问题：**
当模型需要审查代码变更时，需要提供精确的变更范围。如果没有独立的审查机制，模型可能会：
- 审查范围过大（整个文件），浪费 tokens
- 审查范围过小（仅 diff），缺少上下文
- 自己审查自己修改的代码，缺乏独立性

**模型审查协议问题：**
当调用独立审查代理时，需要标准化的输入输出协议。如果没有清晰的 schema，可能发生：
- 审查结果格式不一致，难以解析
- 缺少 severity 分级，无法区分 blocker/warning/nit
- 缺少 verification 状态，无法区分已验证/未验证发现

**Artifact 权限与证据问题：**
当审查文件时，需要复用文件读取权限机制。如果单独实现权限检查，可能导致：
- 权限逻辑重复，维护成本高
- 权限边界不一致，出现安全漏洞
- 用户需要重复授权，体验差

**自动修复边界问题：**
审查工具仅报告问题，不自动修复。如果模糊边界，可能导致：
- 用户期望自动修复但未实现，体验差
- 模型可能误用审查结果尝试修复
- 缺少清晰的工具职责划分

**洞察/上下文分析问题：**
当分析用户会话历史时，需要处理大量日志数据。如果没有缓存和分批机制，可能导致：
- 重复分析相同会话，浪费 API 调用
- 内存占用过高，OOM 风险
- 响应时间过长，用户体验差

**错误与失败处理问题：**
审查和分析过程中可能遇到各种失败（文件过大、JSON 解析失败、模型超时等）。如果没有清晰的失败语义，可能导致：
- 工具静默失败，用户不知道发生了什么
- 部分失败影响整体流程
- 缺少重试/回退策略

### 调用方与责任边界

**调用方：**
- 主 QueryEngine 通过 ToolRunner 调用 ReviewArtifactTool 和 CtxInspectTool
- 用户通过 `/insights` 命令触发洞察生成
- Hunter skill（用户可调用）使用 ReviewArtifactTool

**责任边界：**
- ReviewArtifactTool：独立审查 artifact，返回结构化发现
- CtxInspectTool：检查上下文使用情况和 context collapse 状态
- insights 命令：会话元数据提取、facet 分析、报告生成
- sessionMeta：从会话日志提取统计信息（token 用量、工具调用、响应时间等）

### 实际约束

**审查工具约束：**
- 最大 artifact 大小：1MB（防止 OOM）
- 审查代理工具限制：仅 Read/Grep/Glob（只读，不修改）
- 最大回合数：8 回合（防止无限循环）
- 必须提供 artifact_path 或 content 之一，不能同时提供

**洞察工具约束：**
- 最大 facet 提取并发：50（防止 API 限流）
- 最大会话加载：200（防止内存占用过高）
- 缓存元数据和 facets 到本地文件（减少重复分析）
- 排除 /insights 自身的元会话（防止递归）

**平台差异：**
- 内部用户（USER_TYPE=ant）：支持收集远程 homespace 会话、上传报告到 S3
- 外部用户：仅本地报告，无远程收集和上传

## 2. 设计理由与备选方案

### 决策 1：ReviewArtifactTool 使用独立只读代理进行审查

**实际机制：**
- 启动独立的 GENERAL_PURPOSE_AGENT，仅授予 Read/Grep/Glob 工具
- 代理有自己的 system prompt：“You are an independent artifact reviewer. Do not modify files. Report only evidence-backed problems and clearly mark anything unverified.”
- 最多 8 回合交互
- 返回 JSON 格式：`{summary: string, findings: [{severity: 'blocker'|'warning'|'nit', title: string, description: string, file_path?: string, line?: number, verification?: string, status: 'verified'|'unverified'}]}`

**为什么这样设计：**
- 独立代理避免自我审查偏见（模型审查自己修改的代码）
- 只读工具防止审查代理意外修改文件
- JSON schema 使结果可解析和展示
- verified/unverified 状态帮助用户判断可信度

**备选方案及不采用原因：**
- 方案 A：让主模型直接审查 → 被否决，自我审查偏见风险
- 方案 B：使用专用审查模型而非通用代理 → 被否决，当前通用模型已足够好，且不需要维护额外模型
- 方案 C：允许代理使用所有工具 → 被否决，审查不应修改文件，且 Edit/Write 工具会引入安全风险

**代价：**
- 增加延迟（需要启动子代理并进行多轮交互）
- 消耗更多 tokens（独立代理的对话历史）
- 实现复杂度增加（需要解析 JSON 输出）

**证据：**
- `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:42-83` defaultReviewer 实现
- `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:53-58` 工具限制（仅 Read/Grep/Glob）
- `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:66-68` 独立代理 system prompt

### 决策 2：审查输入支持 artifact_path 或 content，不能同时提供

**实际机制：**
- validateInput 检查：`(input.artifact_path === undefined) === (input.content === undefined)`
- artifact_path：从文件系统读取，复用 FileReadTool 的权限检查
- content：直接使用提供的字符串，不访问文件系统
- 两者都限制 1MB 大小

**为什么这样设计：**
- 灵活性：可以审查已存在的文件，也可以审查尚未写入的内容（如 diff）
- 权限一致性：artifact_path 路径复用 FileReadTool.checkPermissions，不重复实现
- 避免歧义：同时提供两者时不知道使用哪个

**备选方案及不采用原因：**
- 方案 A：仅支持 artifact_path → 被否决，无法审查尚未写入的内容（如建议的修改）
- 方案 B：仅支持 content → 被否决，用户需要先读取文件再传给审查，增加步骤
- 方案 C：两者都提供时以 content 优先 → 被否决，用户意图不明确，容易出错

**代价：**
- 需要维护两条读取路径
- 用户需要理解两者区别

**证据：**
- `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:159-168` validateInput 中的互斥检查
- `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:95-109` readArtifact 实现
- `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:152-158` checkPermissions 复用 FileReadTool

### 决策 3：insights 使用两级缓存（会话元数据 + facets）

**实际机制：**
- 第一级：SessionMeta 缓存到 `~/.claude/usage-data/session-meta/<session-id>.json`
- 第二级：Facets 缓存到 `~/.claude/usage-data/facets/<session-id>.json`
- 缓存使用原子写入（临时文件 + rename）防止崩溃时损坏
- 扫描时先尝试加载缓存，只分析未缓存的会话
- 最多分析 200 个会话（防止内存占用过高）

**为什么这样设计：**
- 减少 API 调用：facet 提取需要调用模型，成本高
- 提升响应速度：缓存命中时不需要重新分析
- 原子写入：防止进程崩溃时留下损坏的缓存文件
- 会话限制：平衡覆盖范围和资源消耗

**备选方案及不采用原因：**
- 方案 A：不缓存，每次重新分析 → 被否决，API 成本高，响应慢
- 方案 B：仅在内存中缓存 → 被否决，进程重启后丢失
- 方案 C：无限制分析所有会话 → 被否决，可能 OOM，响应时间过长

**代价：**
- 实现复杂度增加（缓存读取/写入/失效）
- 磁盘占用（每个会话两个 JSON 文件）
- 缓存一致性风险（如果日志格式变化，旧缓存可能无效）

**证据：**
- `src/commands/insights/sessionMeta.ts:460-495` saveSessionMeta 原子写入
- `src/commands/insights/sessionMeta.ts:436-458` loadCachedSessionMeta
- `src/commands/insights.ts:2352-2360` loadCachedFacets / saveFacets
- `src/commands/insights.ts:2430-2432` 会话数量限制（200）

### 决策 4：facet 提取使用 JSON 直接输出而非工具调用

**实际机制：**
- 直接在 user prompt 中要求：“RESPOND WITH ONLY A VALID JSON OBJECT matching this schema: {...}”
- 使用简单的 JSON 解析：找到第一个 `{` 和最后一个 `}`，截取中间内容
- 用 zod schema 验证解析结果
- 如果解析失败或验证失败，视为提取失败（不重试）

**为什么这样设计：**
- 简单：不需要工具调用协议，一轮完成
- 可靠：模型直接输出 JSON，不需要 tool_use 格式
- 快速：仅一轮 API 调用

**备选方案及不采用原因：**
- 方案 A：使用 tool_use 让模型调用 record_facets 工具 → 被否决，增加复杂度，需要多轮
- 方案 B：让模型输出自然语言再解析 → 被否决，解析难度高，可靠性差
- 方案 C：失败时重试 → 被否决，可能无限循环，且 facet 提取是尽力而为

**代价：**
- JSON 解析需要处理额外文本（模型可能先说几句话再输出 JSON）
- 无重试机制，偶尔失败
- schema 变更需要同时修改 prompt 和解析逻辑

**证据：**
- `src/commands/insights.ts:567-611` extractFacetsFromAPI 实现
- `src/commands/insights.ts:86-92` parseReviewerOutput 使用相同策略
- `src/commands/insights.ts:2741-2754` isValidSessionFacets 验证

### 决策 5：sessionMeta 从会话日志提取丰富统计信息

**实际机制：**
- 基础统计：消息数量、token 用量、工具调用计数、语言统计、Git 操作
- 新增统计：用户中断次数、用户响应时间、工具错误分类、是否使用 task agent/MCP/web search/web fetch
- 额外统计：行数变更、文件修改数量、消息时间分布、多 Claude 检测
- 多 Claude 检测：查找“session A → session B → session A”模式，30 分钟窗口内

**为什么这样设计：**
- 全面：覆盖用户行为的多个维度
- 可聚合：统计信息易于跨会话聚合
- 多 Claude 检测：识别用户并行使用多个 Claude 会话的场景
- 响应时间：测量用户思考时间（仅对实际人类消息，排除 tool_result）

**备选方案及不采用原因：**
- 方案 A：仅基础统计 → 被否决，不足以生成有价值的洞察
- 方案 B：直接存储原始日志而非提取统计 → 被否决，占用空间大，分析慢
- 方案 C：所有用户消息都计入响应时间 → 被否决，tool_result 是自动发送的，不反映用户思考时间

**代价：**
- 实现复杂度高（需要解析消息历史、工具调用、时间戳等）
- 日志格式变化时需要更新提取逻辑
- 多 Claude 检测需要 O(n log n) 排序和窗口滑动

**证据：**
- `src/commands/insights/sessionMeta.ts:70-330` extractToolStats 实现
- `src/commands/insights.ts:619-699` detectMultiClauding 实现
- `src/commands/insights/sessionMeta.ts:227-239` 仅对人类消息计算响应时间

### 决策 6：CtxInspectTool 仅返回 JSON 报告，不包含可视化

**实际机制：**
- 输入无参数（zod strictObject({})）
- 调用 collectContextData 获取上下文数据
- formatContextInspection 序列化为 JSON 字符串
- JSON 包含：model、totalTokens、maxTokens、rawMaxTokens、percentage、categories（含 deferred 状态）、messageBreakdown、apiUsage、contextCollapse 统计
- 不包含可视化 grid（测试中验证了这一点）

**为什么这样设计：**
- 简单：工具职责单一，仅报告数据
- 灵活：调用方可以根据需要渲染可视化
- 可解析：JSON 格式便于程序处理

**备选方案及不采用原因：**
- 方案 A：直接返回可视化 HTML → 被否决，工具不应该负责 UI，且难以程序化使用
- 方案 B：同时返回 JSON 和可视化 → 被否决，增加复杂度，且可视化在工具结果中显示效果差
- 方案 C：让模型渲染可视化 → 被否决，模型不擅长精确的 UI 渲染

**代价：**
- 用户需要自己理解 JSON 数据或等待后续渲染
- 缺少即时可视化反馈

**证据：**
- `src/tools/CtxInspectTool/CtxInspectTool.ts:12-28` formatContextInspection
- `tests/internalTools.test.ts:72-103` CtxInspectTool 测试（验证 gridRows 不存在）

## 3. 目标与非目标

### 状态与生命周期

**目标：**
- ReviewArtifactTool 无持久状态（每次调用启动新代理）
- insights 命令缓存 SessionMeta 和 facets 到本地文件
- SessionMeta 缓存包含完整统计信息，不需要原始日志即可聚合
- Facets 缓存包含模型提取的结构化信息

**非目标：**
- 不跨会话共享审查代理状态
- 不持久化 CtxInspectTool 结果
- 不无限期保留缓存（无自动清理机制）

### 接口与数据

**目标：**
- ReviewArtifactTool 输入输出有 zod schema 验证
- 审查结果是结构化的 tagged union（severity + status）
- insights 输出包含 HTML 报告 + JSON 数据
- SessionMeta 有完整的 TypeScript 类型定义

**非目标：**
- 不保证缓存文件向后兼容（格式变化时旧缓存会被忽略）
- 不提供审查结果的自动修复功能
- 不提供洞察报告的编辑功能

### 执行与环境

**目标：**
- ReviewArtifactTool 的 validateInput 无 fs 操作（权限检查除外）
- insights 命令分批加载会话（每批 50 个缓存，10 个新会话）
- insights 命令使用 Promise.allSettled 处理部分失败
- 临界区操作（文件写入）使用同步 API 防止并发变更

**非目标：**
- 不支持实时流式生成洞察报告
- 不支持分布式分析（仅单机）
- 不支持中断后恢复分析（重新开始）

### 依赖边界

- **工具框架**（`src/Tool.ts`）：本 spec 仅描述如何使用 buildTool，不描述 Tool 接口本身
- **Agent 系统**（`src/tools/AgentTool/`）：ReviewArtifactTool 使用 AgentTool 启动子代理，主设计由 Agent spec 负责
- **查询核心**（`src/services/query/`）：CtxInspectTool 使用 collectContextData，主设计由查询核心 spec 负责
- **权限系统**（`src/utils/permissions/`）：ReviewArtifactTool 复用 FileReadTool 权限检查，主设计由权限 spec 负责
- **模型 API**（`src/services/api/`）：insights 使用 queryWithModel 提取 facets，主设计由模型 API spec 负责

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

#### ReviewArtifactTool 入口

```typescript
type Input = {
  artifact_path?: string;    // 文件路径（与 content 二选一）
  content?: string;          // 内联内容（与 artifact_path 二选一）
  focus?: string;            // 审查重点
  context?: string;          // 预期行为和相关要求
};

type Finding = {
  severity: 'blocker' | 'warning' | 'nit';
  title: string;
  description: string;
  file_path?: string;
  line?: number;
  verification?: string;
  status: 'verified' | 'unverified';
};

type Output = {
  summary: string;
  findings: Finding[];
  message: string;
};
```

执行流程：
1. backfillObservableInput：无操作
2. validateInput：检查 artifact_path/content 互斥 + 大小限制
3. checkPermissions：复用 FileReadTool.checkPermissions（仅当 artifact_path 存在）
4. call：
   → readArtifact（读取文件或使用 content）
   → 构建 prompt（包含 focus/context/artifact）
   → 调用 defaultReviewer（启动子代理）
   → parseReviewerOutput（提取 JSON）
   → 添加 message 字段
5. mapToolResultToToolResultBlockParam：返回完整 JSON

#### CtxInspectTool 入口

```typescript
type Input = {};  // 无参数

type Output = {
  report: string;  // JSON 字符串
};
```

执行流程：
1. backfillObservableInput：无操作
2. validateInput：无操作（空对象）
3. checkPermissions：无操作
4. call：
   → collectContextData(context)
   → formatContextInspection(data)
   → 返回 {report: string}
5. mapToolResultToToolResultBlockParam：直接返回 report 字符串

#### insights 命令入口

```typescript
// /insights [--homespaces]
// 无输入参数，仅可选 flag

type InsightsExport = {
  metadata: {
    username: string;
    generated_at: string;
    claude_code_version: string;
    date_range: {start: string; end: string};
    session_count: number;
    remote_hosts_collected?: string[];
  };
  aggregated_data: AggregatedData;
  insights: InsightResults;
  facets_summary?: {...};
};
```

执行流程：
1. 可选收集远程 homespace 会话（ant-only）
2. Lite scan：扫描所有项目目录，获取会话文件列表（仅元数据，不解析 JSONL）
3. 加载 SessionMeta：尝试加载缓存，仅解析未缓存的会话
4. 去重会话分支（保留用户消息最多的分支）
5. 提取 facets：尝试加载缓存，仅对未缓存的会话调用模型
6. 过滤最小会话（仅 warmup_minimal 的会话）
7. 聚合数据
8. 生成并行洞察（6+ 个 section）
9. 生成 HTML 报告
10. 可选上传到 S3（ant-only）
11. 返回报告 URL

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|------|-----------|---------|------------|----------------|
| ReviewArtifactTool | 无（每次调用新代理） | 读取 artifact、启动审查代理、解析结果 | 自动修复问题 | runner(prompt, context, canUseTool): Promise<string> |
| CtxInspectTool | 无 | 收集上下文数据、格式化 JSON | 可视化渲染 | collectContextData(context): Promise<ContextData> |
| insights 命令 | 内存中的 SessionMeta 列表、facets Map | 扫描会话、提取统计、生成报告 | 实时流报告 | saveSessionMeta(meta), saveFacets(facets) |
| sessionMeta 模块 | 无（纯函数 + 文件 I/O） | 从日志提取统计、加载/保存缓存 | 数据聚合 | extractToolStats(log), logToSessionMeta(log) |

**缓存文件设计说明：**
- SessionMeta 缓存路径：`~/.claude/usage-data/session-meta/<session-id>.json`
- Facets 缓存路径：`~/.claude/usage-data/facets/<session-id>.json`
- 写入策略：临时文件 + rename 原子操作（防止崩溃时损坏）
- 文件权限：0600（仅用户可读）
- 目录权限：0700

### 4.3 主控制流

#### ReviewArtifactTool 完整流程

```
模型调用 ReviewArtifactTool
  → validateInput：
    → 检查 artifact_path 或 content 恰好提供一个
    → 检查大小 ≤ 1MB
  → checkPermissions：
    → artifact_path 存在？→ 调用 FileReadTool.checkPermissions
    → content 存在？→ 直接允许
  → call：
    → readArtifact：读取文件或使用 content
    → 构建 prompt：
      → 说明独立审查要求
      → 提供 focus/context
      → 嵌入 artifact 内容
    → defaultReviewer：
      → 导入 AgentTool、GENERAL_PURPOSE_AGENT
      → 限制工具：仅 Read/Grep/Glob
      → 启动子代理，最多 8 回合
      → 返回最后一条 assistant 消息
    → parseReviewerOutput：
      → 查找第一个 { 和最后一个 }
      → JSON.parse + zod 验证
    → 添加 message: "Artifact review completed"
  → mapToolResultToToolResultBlockParam：返回完整 JSON
```

#### insights 命令完整流程（简化）

```
用户运行 /insights [--homespaces]
  → 可选收集远程 homespace 会话（ant-only）：
    → 列出运行的远程主机
    → SCP 复制远程 ~/.claude/projects 到临时目录
  → Lite scan：
    → 遍历 ~/.claude/projects/<project>/*.jsonl
    → 获取 mtime/size，不解析内容
    → 按 mtime 降序排序
  → 加载 SessionMeta：
    → 分批处理（每批 50 个）：
      → 尝试 loadCachedSessionMeta
      → 缓存未命中且未缓存会话 < 200 → 解析 JSONL → logToSessionMeta → saveSessionMeta
  → 去重会话分支（保留用户消息最多的分支）
  → 过滤实质性会话（≥2 用户消息，≥1 分钟）
  → 提取 facets：
    → 分批处理（每批 50 个并发）：
      → 尝试 loadCachedFacets
      → 缓存未命中 → extractFacetsFromAPI（调用模型）→ saveFacets
  → 过滤最小会话（仅 warmup_minimal 的会话）
  → aggregateData：聚合所有统计
  → generateParallelInsights：并行生成 6+ 个 insight sections
  → generateHtmlReport：生成完整 HTML
  → 保存到 ~/.claude/usage-data/report.html
  → 可选上传到 S3（ant-only）
  → 返回报告 URL
```

#### 多 Claude 检测流程

```
detectMultiClauding(sessions):
  → 收集所有用户消息时间戳：
    → 每个消息：{ts: number, sessionId: string}
  → 按 ts 升序排序
  → 滑动窗口（30分钟）：
    → 维护 sessionLastIndex: Map<sessionId, lastIndex>
    → 对每个消息 i：
      → 移除窗口外的旧消息（ts[i] - ts[windowStart] > 30min）
      → sessionLastIndex 有当前 sessionId？
        → 是：遍历 j from sessionLastIndex[sessionId]+1 to i-1
          → 发现不同 sessionId？→ 记录重叠对
      → 更新 sessionLastIndex[sessionId] = i
  → 统计：
    → overlap_events: 重叠对数量（去重）
    → sessions_involved: 涉及的不同 sessionId 数量
    → user_messages_during: 重叠期间的消息数量
```

### 4.4 数据结构与持久化

#### ReviewArtifactTool 核心数据结构

```typescript
// 审查输入
type ArtifactReviewInput = {
  artifact_path?: string;
  content?: string;
  focus?: string;
  context?: string;
};

// 单个发现
type Finding = {
  severity: 'blocker' | 'warning' | 'nit';
  title: string;
  description: string;
  file_path?: string;
  line?: number;
  verification?: string;
  status: 'verified' | 'unverified';
};

// 审查输出
type ReviewOutput = {
  summary: string;
  findings: Finding[];
  message: string;
};
```

#### SessionMeta 核心数据结构

```typescript
type SessionMeta = {
  session_id: string;
  project_path: string;
  start_time: string;
  duration_minutes: number;
  user_message_count: number;
  assistant_message_count: number;
  tool_counts: Record<string, number>;
  languages: Record<string, number>;
  git_commits: number;
  git_pushes: number;
  input_tokens: number;
  output_tokens: number;
  first_prompt: string;
  summary?: string;
  // 新增统计
  user_interruptions: number;
  user_response_times: number[];
  tool_errors: number;
  tool_error_categories: Record<string, number>;
  uses_task_agent: boolean;
  uses_mcp: boolean;
  uses_web_search: boolean;
  uses_web_fetch: boolean;
  // 额外统计
  lines_added: number;
  lines_removed: number;
  files_modified: number;
  message_hours: number[];
  user_message_timestamps: string[];
};
```

#### Facets 核心数据结构

```typescript
type SessionFacets = {
  session_id: string;
  underlying_goal: string;
  goal_categories: Record<string, number>;
  outcome: 'fully_achieved' | 'mostly_achieved' | 'partially_achieved' | 'not_achieved' | 'unclear_from_transcript';
  user_satisfaction_counts: Record<string, number>;
  claude_helpfulness: 'unhelpful' | 'slightly_helpful' | 'moderately_helpful' | 'very_helpful' | 'essential';
  session_type: 'single_task' | 'multi_task' | 'iterative_refinement' | 'exploration' | 'quick_question';
  friction_counts: Record<string, number>;
  friction_detail: string;
  primary_success: 'none' | 'fast_accurate_search' | 'correct_code_edits' | 'good_explanations' | 'proactive_help' | 'multi_file_changes' | 'good_debugging';
  brief_summary: string;
  user_instructions_to_claude?: string[];
};
```

#### 持久化策略

- **SessionMeta 缓存**：JSON 文件，原子写入（临时文件 + rename），0600 权限
- **Facets 缓存**：JSON 文件，原子写入，0600 权限
- **HTML 报告**：单文件，0600 权限
- **无 WAL/日志**：崩溃时重新分析即可（仅浪费 API 调用）

### 4.5 跨子系统依赖

| 依赖 | 用途 | 本 spec 中的使用点 | 负责的 spec |
|-----|------|------------------|------------|
| AgentTool | 启动独立审查代理 | ReviewArtifactTool.defaultReviewer | Agent spec |
| FileReadTool | 权限检查复用 | ReviewArtifactTool.checkPermissions | File tools spec |
| collectContextData | 收集上下文数据 | CtxInspectTool.call | Query core spec |
| queryWithModel | 提取 facets | insights.extractFacetsFromAPI | Model API spec |
| getClaudeConfigHomeDir | 缓存目录 | sessionMeta.getSessionMetaDir | Path utils spec |
| jsonParse/jsonStringify | 慢操作封装 | 所有 JSON 读写 | Slow operations spec |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|-----------------|---------------|--------------|-------------|
| artifact_path 和 content 都提供或都不提供 | ReviewArtifactTool.validateInput | return {result: false, message: ..., errorCode: 1} | 否 | 无 | 工具被拒绝，显示错误消息 |
| artifact 超过 1MB | ReviewArtifactTool.readArtifact | throw Error | 否 | 无 | 工具执行失败 |
| 审查代理返回无 JSON | ReviewArtifactTool.parseReviewerOutput | throw Error | 否 | 无 | 工具执行失败 |
| JSON 验证失败 | ReviewArtifactTool.parseReviewerOutput | throw ZodError | 否 | 无 | 工具执行失败 |
| 会话日志不是有效 JSONL | insights.loadAllLogsFromSessionFile | （外层 try/catch） | 否 | 无 | 会话被跳过（Promise.allSettled） |
| facet 提取模型调用失败 | insights.extractFacetsFromAPI | （外层 try/catch） | 否 | 无 | 会话无 facets（仍包含在统计中） |
| S3 上传失败 | insights（ff cp 调用） | （外层 try/catch） | 否 | 无 | 回退到本地文件 URL，提示手动上传 |
| 缓存文件损坏 | loadCachedSessionMeta / loadCachedFacets | JSON.parse 抛出错误 → 捕获返回 null | 否 | 删除损坏文件 | 会话被重新分析 |

### 工程取舍说明

**取舍 1：facet 提取失败不重试**
- 理由：失败可能是模型能力问题，重试不一定成功；且 facet 提取是尽力而为，没有不影响基础统计
- 代价：部分会话无 facet 数据，洞察可能不完整
- 证据：`src/commands/insights.ts:607-610` extractFacetsFromAPI 没有重试逻辑

**取舍 2：审查代理仅允许 Read/Grep/Glob**
- 理由：审查不应修改文件，减少安全风险
- 代价：代理无法使用 Edit/Write 帮助理解代码变更（只能读）
- 证据：`src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:53-58` 工具过滤

**取舍 3：insights 最多分析 200 个会话**
- 理由：平衡覆盖范围和资源消耗（内存 + API 成本）
- 代价：会话很多时仅分析最近 200 个
- 证据：`src/commands/insights.ts:2379` MAX_SESSIONS_TO_LOAD = 200

**取舍 4：SessionMeta 缓存无自动清理**
- 理由：磁盘空间通常足够；用户可以手动删除 ~/.claude/usage-data
- 代价：长期使用可能积累大量旧缓存文件
- 证据：代码中无清理逻辑

**取舍 5：多 Claude 检测使用 30 分钟固定窗口**
- 理由：简单且足够识别大多数并行使用场景
- 代价：窗口大小不适合所有用户（有些用户可能更长/更短时间切换）
- 证据：`src/commands/insights.ts:620` OVERLAP_WINDOW_MS = 30 * 60000

## 6. 现状验收标准

### ReviewArtifactTool 验收

1. 给定同时提供 artifact_path 和 content，当调用 validateInput 时，系统必须拒绝（返回 {result: false}）。
2. 给定仅提供 content 且大小 ≤ 1MB，当调用时，系统必须正常审查，不进行权限检查。
3. 给定审查代理返回的 JSON 前后有额外文本，当 parseReviewerOutput 时，系统必须正确提取中间的 JSON。
4. 给定审查代理返回无效 JSON，当调用时，系统必须抛出错误，不返回部分结果。
5. 给定审查代理的 findings 包含 status 字段，当返回结果时，系统必须保留该字段（verified/unverified）。

### CtxInspectTool 验收

1. 给定无参数输入，当调用时，系统必须返回包含 model、totalTokens、maxTokens、percentage、categories 的 JSON。
2. 给定 categories 包含 deferred 项，当格式化时，系统必须在输出中标记 deferred: true。
3. 给定 ContextData 包含 gridRows，当 formatContextInspection 时，系统必须不包含 gridRows（仅测试验证）。

### insights 命令验收

1. 给定会话已有缓存的 SessionMeta，当扫描时，系统必须使用缓存，不重新解析 JSONL。
2. 给定会话已有缓存的 facets，当分析时，系统必须使用缓存，不调用模型。
3. 给定一个会话有多个分支（多份 JSONL），当去重时，系统必须保留用户消息最多的分支。
4. 给定会话仅包含 warmup_minimal 且无其他 goal，当过滤时，系统必须排除该会话。
5. 给定用户并行使用多个会话，当 detectMultiClauding 时，系统必须识别重叠事件。
6. 给定 S3 上传失败，当完成时，系统必须回退到本地文件 URL，并提示手动上传。
7. 给定 USER_TYPE=ant 且提供 --homespaces，当运行时，系统必须尝试收集远程会话。

### sessionMeta 模块验收

1. 给定用户消息是 tool_result（无实际文本），当统计 user_message_count 时，系统必须不计入。
2. 给定用户消息时间戳在 lastAssistantMessage 后 2-3600 秒，当统计 response time 时，系统必须计入。
3. 给定工具错误消息包含 "exit code"，当分类时，系统必须标记为 "Command Failed"。
4. 给定 Edit 工具调用，当统计 lines_added/lines_removed 时，系统必须根据 diff 计算。
5. 给定保存 SessionMeta 时进程崩溃，当恢复时，系统必须不留下损坏文件（原子写入保证）。

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| ReviewArtifactTool 使用独立只读代理（仅 Read/Grep/Glob） | `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:42-83` | `tests/reviewArtifact.test.ts:31-64` 测试验证代理调用 | 测试使用 mock runner，不实际启动代理 |
| ReviewArtifactTool validateInput 检查 artifact_path/content 互斥 | `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:159-168` | `tests/reviewArtifact.test.ts:17-29` 测试验证互斥检查 | 测试覆盖三种情况：都不提供、都提供、仅提供一个 |
| ReviewArtifactTool parseReviewerOutput 提取 JSON（忽略前后文本） | `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts:86-93` | `tests/reviewArtifact.test.ts:92-95` 测试验证解析 | 测试仅验证空 findings 场景 |
| CtxInspectTool 返回 JSON 不含 gridRows | `src/tools/CtxInspectTool/CtxInspectTool.ts:12-28` | `tests/internalTools.test.ts:72-103` 测试验证不含 gridRows | 测试仅验证格式化函数，不验证完整工具调用 |
| insights 使用两级缓存（SessionMeta + facets） | `src/commands/insights/sessionMeta.ts:436-495` save/load SessionMeta; `src/commands/insights.ts:2352-2360` save/load facets | 无直接测试 | 缓存目录和格式无版本控制 |
| insights 原子写入缓存文件（临时文件 + rename） | `src/commands/insights/sessionMeta.ts:476-494` | 无直接测试 | 仅 SessionMeta 使用原子写入，facets 未验证 |
| insights 最多分析 200 个会话 | `src/commands/insights.ts:2379` | 无直接测试 | 仅未缓存会话受此限制，已缓存会话全部加载 |
| insights facet 提取并发 50 个 | `src/commands/insights.ts:2510-2528` | 无直接测试 | 无 API 限流回退逻辑 |
| sessionMeta 仅对人类消息计算响应时间（排除 tool_result） | `src/commands/insights/sessionMeta.ts:227-239` | 无直接测试 | 响应时间窗口 2-3600 秒硬编码 |
| detectMultiClauding 使用 30 分钟滑动窗口 | `src/commands/insights.ts:619-699` | 无直接测试 | 仅检测 A→B→A 模式，不检测 A→B→C→A |
| sessionMeta 分类工具错误（Command Failed/User Rejected/Edit Failed 等） | `src/commands/insights/sessionMeta.ts:250-283` | 无直接测试 | 仅匹配英文错误消息 |
| insights 过滤元会话（自身 /insights 调用） | `src/commands/insights.ts:2403-2418` | 无直接测试 | 仅匹配特定 prompt 模式 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/review-analysis.yaml)

### 覆盖分组职责说明

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|------|-----------|------------------|----------------|
| review-artifact-tool | ReviewArtifactTool 实现、独立审查代理、JSON 解析 | `tests/reviewArtifact.test.ts` | AgentTool 本身（由 Agent spec 主拥有） |
| ctx-inspect-tool | CtxInspectTool 实现、上下文数据格式化 | `tests/internalTools.test.ts:72-103` | collectContextData（由查询核心 spec 主拥有） |
| insights-command | insights 主流程、报告生成、并行洞察 | 无直接测试 | HTML/CSS/JS 渲染细节 |
| session-meta | SessionMeta 提取、缓存加载/保存、工具统计 | 无直接测试 | 原始 JSONL 日志格式（由会话持久化 spec 主拥有） |

### 相关子系统

- **Agent 系统**：ReviewArtifactTool 使用 AgentTool 启动独立审查代理，本 spec 仅描述调用点
- **查询核心**：CtxInspectTool 使用 collectContextData，本 spec 仅描述格式化输出
- **权限系统**：ReviewArtifactTool 复用 FileReadTool 权限检查，本 spec 仅描述调用点
- **模型 API**：insights 使用 queryWithModel 提取 facets，本 spec 仅描述 prompt 构建
- **会话持久化**：insights 读取 JSONL 会话日志，本 spec 仅描述如何解析，不描述日志格式

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|---------|-------|-------|
| P1 | insights 当前无缓存清理机制，长期使用可能积累大量旧文件 | 添加缓存清理策略（如保留最近 30 天或最近 1000 个会话） | 低：仅删除旧文件 | 给定 30 天前的缓存文件，当清理时必须删除；给定最近的缓存必须保留 | M | 已证实（代码中无清理逻辑） |
| P1 | ReviewArtifactTool 当前无单元测试覆盖代理启动和 JSON 解析的各种边缘情况 | 添加完整测试：无 JSON、JSON 无效、findings 缺少字段、extra 文本等 | 低：仅添加测试 | 测试覆盖各种成功和失败场景 | M | 已证实（测试仅覆盖基本路径） |
| P2 | facet 提取失败不重试，可能因临时 API 故障导致数据缺失 | 添加有限重试（1-2 次），仅对网络错误重试 | 中：需要区分可重试和不可重试错误 | 给定网络超时，当提取时必须重试；给定无效 JSON，当提取时必须不重试 | M | 设计推断 |
| P2 | insights 最多分析 200 个会话，用户可能希望调整 | 添加命令行 flag 允许配置会话数量 | 低：仅添加参数 | 给定 --max-sessions=500，当分析时必须处理 500 个会话 | S | 设计推断 |
| P2 | 审查工具仅报告问题，用户经常需要后续修复 | 添加可选的 "autofix" 模式（仍需要用户确认） | 中：需要清晰的职责边界和权限控制 | 给定审查发现 blocker，当用户确认时必须尝试修复 | L | 设计推断 |
| P3 | 多 Claude 检测窗口固定 30 分钟，可能不适合所有用户 | 使窗口可配置或自适应 | 低：仅添加参数 | 给定 --overlap-window=60，当检测时必须使用 60 分钟窗口 | S | 设计推断 |
| P3 | 当前无针对 insights 完整流程的测试 | 添加端到端测试（使用 fixtures 会话日志） | 低：仅添加测试 | 测试可以运行完整 /insights 流程并生成报告 | L | 已证实（代码存在但无测试） |

### 优先级说明

- **P1**：高影响的可靠性、数据完整性、测试缺口问题。不影响核心正确性，但能显著提升健壮性。
- **P2**：局部可维护性、体验改进、可配置性。明确非紧急，但能提升用户满意度。
- **P3**：可选体验、测试完善。低优先级，可延后处理。
