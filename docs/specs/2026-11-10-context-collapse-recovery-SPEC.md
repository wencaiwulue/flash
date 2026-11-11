---
commit: 31697a0f6d4c66dae4c792583e94410b07aa1bff
title: "Implement context collapse and recovery"
date: 2026-11-10T20:47:04+08:00
status: partial
kind: component
---

# Implement context collapse and recovery

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的 contextCollapse 只有 index、operations、persist 三个文件：功能开关固定为 false，applyCollapsesIfNeeded 原样返回消息，projectView 不做投影，恢复与溢出处理均为空操作，统计固定为零且没有 store.ts。query、session restore、sessionStorage、autoCompact 和 CtxInspect 已经留有 CONTEXT_COLLAPSE 特性门后的接线及日志契约，但外部构建尚未启用该特性，CtxInspect 也不进入工具池。因此本提交是在既有接线下补上运行态、摘要投影和持久化，而不是新增一套查询或会话协议。

需要把接近上下文窗口的历史段转换为可重复投影的摘要，在 90% 时后台生成、95% 时等待结果，并保持 UUID 边界、工具调用与结果配对、恢复后的提交顺序和健康状态可观察。实际实现已经覆盖提交摘要、阈值调度、UUID 投影、日志恢复和 CtxInspect 构建注册，但正常 startSpawn 路径把新摘要直接交给 commitStaged，并未先写入 collapseStore.staged；staged 队列只能由恢复快照填入。因此不能把“恢复快照中的 staged 可排空”扩大成“所有新摘要都会先暂存并可供 413 恢复”，本记录据此标为部分实现。

## 目标与非目标

### 目标

- 建立 committed/staged 两类内存状态、订阅和统计，并以 generation 隔离 reset 前尚未完成的摘要任务。
- 用稳定的消息 UUID 定位归档边界，把已提交段替换为带独立 summaryUuid 的 isMeta 用户消息，且重复投影保持幂等。
- 在有效 token/window 比率达到 90% 时后台摘要、达到 95% 时阻塞等待，并保留 compact/session_memory 与 summarizer 的递归边界。
- 选择不切断相邻 tool_use/tool_result 的归档段，拒绝空摘要并记录 spawn、错误和空结果健康计数。
- 通过既有 transcript commit/snapshot entry 持久化提交与触发状态，在 resume 时重建摘要消息、ID 序列和 staged 边界。
- 对真实 prompt-too-long 提供 staged 排空与同步投影入口，同时明确该 revision 的正常生成路径尚未建立新摘要先 staged 的队列。
- 启用 CONTEXT_COLLAPSE 外部构建，使既有查询接线和 CtxInspect 生效，并以离线回归及 36 工具特性档固定可见行为。

### 非目标

- 不改写 REPL 保存的完整消息历史；折叠是查询时投影，不是从原始转录中物理删除消息。
- 不新增 query、resume、sessionStorage 或 CtxInspect 的平行协议，这些既有文件不在本提交 diff 中。
- 不让摘要 fork 使用工具或继续执行动作，也不把注入的 summarize/recordCommit/recordSnapshot fake 当作真实模型或磁盘验证。
- 不宣称真实模型摘要、真实 API 413、重试及后续 reactive-compact fallback 已做在线端到端验证。
- 不把持久化失败设计成事务回滚；内存提交先发生，写入异常进入 health，而不是撤销已生成的摘要。
- 不实现基于 tool_use_id 的全局配对校验；当前选择器只按相邻消息类型和内容保守回退边界。

## 方案架构与数据流

运行态由新 store.ts 集中承载。CommittedCollapse 保存 16 位 collapseId、summaryUuid、转义后的 summaryContent、纯文本 summary、首尾归档 UUID、summaryMessage 和 archived；StagedCollapse 保存 startUuid/endUuid、summary、risk、stagedAt 及内存 messages。collapseStore 另存 nextId、armed、lastSpawnTokens 和 health。getCollapseStats 从 committed 数量、archived 长度和 staged 数量派生视图，subscribeToCollapses 用 Set 提供订阅及退订，resetCollapseStore 清空数据但保留监听器。

依赖层 initContextCollapse 将测试覆盖项与 defaults 合并。生产默认使用 tokenCountWithEstimation、getEffectiveContextWindowSize、defaultSummarize，并动态调用 sessionStorage 的 recordContextCollapseCommit/recordContextCollapseSnapshot。服务本身在 CLAUDE_CONTEXT_COLLAPSE 未定义时默认启用，定义时由 isEnvTruthy 决定；但查询、恢复和工具注册仍受外层 feature(CONTEXT_COLLAPSE) 编译门控制，环境变量不能替代构建特性。

defaultSummarize 动态加载 forkedAgent、消息、prompt 和 context 模块，优先复用 getLastCacheSafeParams 的 systemPrompt/userContext/systemContext，否则按当前 ToolUseContext 重新构造。调用 runForkedAgent 时，它同时把归档 messages 放入 promptMessages 和 cacheSafeParams.forkContextMessages；runForkedAgent 又按 [...forkContextMessages, ...promptMessages] 构造 initialMessages，因此该 revision 的生产摘要输入实际包含两份相同归档消息，随后才是摘要指令。设置 querySource=marble_origami、forkLabel=context_collapse、maxTurns=1、skipCacheWrite=true，并用 canUseTool 永远 deny 禁止工具；最终只连接 assistant 文本并 trim。注入 fake summarizer 的测试不覆盖这条默认 fork 数据流。

投影层 projectView 按 committed 顺序在输入副本上重放。若 summaryUuid 已存在则跳过，保证已投影视图再次进入时稳定；否则分别查找 firstArchivedUuid 和 lastArchivedUuid，只有两端存在且顺序合法时才把闭区间替换为 summaryMessage。每次成功重放还会从当前完整视图刷新 archived，所以恢复时 archived=[] 可以延迟重建。findMessageSpan 提供同样的 UUID 闭区间查询；缺失或乱序边界不会强行折叠，但 committed 项本身仍保留。

selectCollapseSpan 要求至少六条消息，从 end=length-5 开始，因此未回退时归档至少两条并保留末尾四条。若当前候选末条是含 tool_use 的 assistant，或下一保留条是含 tool_result 的 user，就继续向前移动 end；end 到零则放弃选择。这种保守回退让相邻工具调用及其结果一起留在未归档尾部，避免摘要边界把二者拆开，但并不比较具体 tool_use_id。

applyCollapsesIfNeeded 先对普通输入做 projectView；compact 和 session_memory 只取投影而不触发新摘要，marble_origami 直接返回原输入以避免 summarizer 递归。其他来源以 projected 的 token 数除以模型有效窗口：ratio<0.90 直接返回；上次 spawn 后 token 增长不足 5000 也抑制新任务。已有 activeSpawn 时仅在 ratio>=0.95 等待；没有活动任务且选段成功时启动 startSpawn，90% 至不足 95% 后台执行，达到 95% 则等待。risk 记录为 min(1,ratio)，lastSpawnTokens 在任务收口时记录触发值。

startSpawn 增加 generation、totalSpawns 并置 armed，resetContextCollapse 也增加 generation。摘要返回后及 finally 收口前的 generation 检查，可阻止仍在 summarizer 阶段等待的旧任务于 reset 后创建 committed，并避免旧 finally 改写新 armed/lastSpawnTokens；但这不是所有异步写入的全量隔离。commitStaged 与 persistSnapshot 的 await 后没有 generation 检查，reset 时已在持久化中的旧任务仍可继续后续 snapshot，失败时还会更新新 health、lastError 并通知监听器。摘要 trim 后为空时增加 totalEmptySpawns、设置 emptySpawnWarningEmitted 和 lastError，但不创建占位提交；首尾缺少 UUID 或 summarize 抛错则增加 totalErrors。持久化异常不会反向抹除内存状态。

staged 与 committed 在该 revision 有明确但不完整的生命周期。commitStaged 在首个 await 之前同步生成自增 16 位 ID 和 randomUUID，将 &、<、> 转义后包成 <collapsed>，推送 committed，并按对象 identity 从 staged 移除，然后才异步写 commit 和 snapshot；所以 overflow 可以立即看到内存投影。然而 startSpawn 构造 StagedCollapse 后直接 await commitStaged，没有 collapseStore.staged.push，正常新摘要不会经历可观察的 staged 阶段。restoreFromEntries 是实际填入 staged 的路径，新增测试也是先恢复快照再验证排空。

恢复层 restoreFromEntries 先 reset，再按日志顺序重建 committed 和原 summaryUuid 的 isMeta 用户消息，以所有数值 collapseId 的最大值加一重设 nextId， archived 初始为空。snapshot 采用最后一份输入，恢复 staged 的摘要、边界、risk、stagedAt，但 messages 置空，同时恢复 armed/lastSpawnTokens。提交日志包含完整 summaryContent 和 UUID 边界，快照只保存 staged 元数据；后续 projectView 或 recoverFromOverflow 用完整历史重新填 archived。

溢出链由既有 query 接线调用。isWithheldPromptTooLong 只在功能启用、来源不是 marble_origami、消息为 assistant API error 且 isPromptTooLongMessage 为真时 withhold。recoverFromOverflow 对 staged 快照逐项 void commitStaged，利用其同步内存段立即 projectView，并返回尝试提交的 staged 数量；禁用或 summarizer 来源则原样返回零。既有 query 在有提交时以 collapse_drain_retry 重试一次，之后仍由既有 reactive compact 或错误 surfacing 处理；该控制流存在不等于真实 413 已运行。

观察与构建层复用既有 CtxInspect：formatContextInspection 在 JSON 报告中附带 getStats() 的 contextCollapse 字段。scripts/build.ts 和独立特性夹具加入 CONTEXT_COLLAPSE 后，既有 tools.ts 条件注册把 CtxInspect 加入外部工具池，组合测试将总数从 35 改为 36 并检查无 null。新增七个服务测试使用注入 token/window/summarizer/persistence 验证阈值、幂等、空摘要、withhold、恢复投影、工具边界和订阅，不覆盖真实模型、真实 transcript I/O 或在线 413。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `src/services/contextCollapse/index.ts`，符号 `applyCollapsesIfNeeded` | 实现依赖注入、无工具摘要 fork、90/95 调度、空摘要健康、同步内存提交、413 withhold/recover，并保留新摘要未先 staged 的实际边界。 |
| 变更 | `src/services/contextCollapse/operations.ts`，符号 `projectView` | 实现 committed 日志的 UUID 幂等投影、闭区间查找和保守工具配对边界选择。 |
| 变更 | `src/services/contextCollapse/persist.ts`，符号 `restoreFromEntries` | 从 commit 日志和最后快照重建 committed/staged、摘要消息、触发状态与下一 ID，并延迟恢复 archived。 |
| 变更 | `src/services/contextCollapse/store.ts`，符号 `collapseStore` | 新增 committed/staged 数据模型、ID 和触发状态、健康计数、统计派生、监听器及 reset。 |
| 变更 | `scripts/build.ts`，符号 `'CONTEXT_COLLAPSE'` | 在外部构建 feature 列表中启用既有 context-collapse 查询、恢复和 CtxInspect 接线。 |
| 变更 | `tests/contextCollapse.test.ts`，符号 `describe('context-collapse execution'` | 新增七个注入式离线测试；溢出恢复通过 restoreFromEntries 预置 staged，而非经过正常 spawn 暂存。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `'CtxInspect'` | 把编译工具池固定为 36 个非空工具并检查 CtxInspect 名称。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `'CONTEXT_COLLAPSE'` | 让独立 Bun 特性构建夹具启用与生产构建相同的 CONTEXT_COLLAPSE 标志。 |
| 变更 | `docs/STATUS.md`，符号 `Context collapse and CtxInspect` | 记录 107/459、36 工具和离线能力矩阵，明确 live model/413 未运行，并更新后续验证顺序。 |
| 变更 | `docs/RELEASE.md`，符号 `## Context collapse` | 新增发布契约及 fake/live 验证边界，并把相关历史段的 compiled feature profile 数量更新为 36。 |
| 复用 | `src/query.ts`，符号 `collapse_drain_retry` | 复用父提交已有的查询投影、withhold、staged drain、单次重试及后续 fallback 状态机。 |
| 复用 | `src/tools/CtxInspectTool/CtxInspectTool.ts`，符号 `formatContextInspection` | 复用既有只读 JSON 报告及其中的 getStats() 输出，本提交只通过构建门使其进入工具池。 |
| 复用 | `src/utils/sessionStorage.ts`，符号 `recordContextCollapseCommit` | 复用既有 transcript appendEntry，分别写 append-only commit 和 last-wins snapshot。 |
| 复用 | `src/types/logs.ts`，符号 `ContextCollapseCommitEntry` | 复用既有 marble-origami commit/snapshot 类型、UUID 边界和恢复注释，没有修改持久化格式。 |
| 复用 | `src/services/compact/autoCompact.ts`，符号 `shouldAutoCompact` | 复用既有 collapse 启用时抑制自动 compact、保留 reactive fallback 的协调逻辑。 |

## 关键决策与工程取舍

- 采用 committed 日志驱动读时投影，而不是直接截断原 messages；summaryUuid 先查重、UUID 边界再替换，使完整历史和已投影历史都可进入同一入口。
- 摘要消息使用新建 isMeta user message，并同时持久化 summaryUuid、summaryContent 和首尾 UUID；显示投影与 resume 因而共享同一消息形状，无需从摘要正文反解析位置。
- 90% 与 95% 共用一次 startSpawn，而不是启动两个 worker；低阈值后台准备，高阈值等待同一 activeSpawn，5000 token 增长门抑制过密重试。
- 归档边界遇到相邻 tool_use/tool_result 就向前回退，宁可缩小或放弃归档段，也不把工具调用留在摘要内而把结果留在尾部。
- 空摘要作为健康事件处理且不生成 collapsed 占位符；这样不会用无内容摘要替换真实历史，但原上下文在当次调用中仍然保留。
- commitStaged 将同步内存提交与异步持久化放在一个函数中，recoverFromOverflow 因而不必等待磁盘即可投影；相应代价是写失败只反映到 health，内存与日志可能暂时不一致。
- 恢复 committed 时以最大数值 ID 重设 nextId，而 staged 在恢复时不分配新 ID；只有实际 commitStaged 才生成新的 collapseId 和 summaryUuid。
- 通过构建标志启用既有 CtxInspect 和 query 接线，而不是新增观察工具或改写查询状态机，变更范围保持在服务实现、特性档、测试和文档。

### 备选方案与回溯分析

- 回溯性比较：可以物理删除已归档消息并只保存摘要，实现会更直接，但会丢失完整历史重放能力；实际用 committed UUID 日志做读时投影，保留原始输入并在 resume 后重建视图。
- 回溯性比较：可以每次达到 90% 都同步等待摘要，控制更简单，但会提前阻塞主循环；实际在 90% 后台运行、95% 等待，并用 activeSpawn 和 token 增长门协调重复进入。
- 回溯性比较：可以让摘要 agent 使用常规工具补充上下文，但会引入副作用和递归查询；实际 fork 禁止所有工具、只运行一轮并提取 assistant 文本。
- 回溯性比较：可以只保存最终 projected messages，快照更小，但无法独立重放提交边界；实际持久化 append-only commit 与 last-wins staged snapshot，并接受恢复时按 UUID 重新定位的成本。
- 回溯性比较：可以把归档终点固定在最新消息附近，获得更大压缩比例；实际保留末尾四条并对工具边界继续回退，以较小归档段换取近期上下文和工具协议完整性。

## 安全与协议边界

- summarizer 的 canUseTool 对所有请求返回 deny，maxTurns=1，且 marble_origami 不再进入 collapse 或 autocompact，限制摘要阶段的工具副作用和递归。
- summaryUuid 使用 randomUUID，collapseId 由内部计数器生成；摘要正文对 &、<、> 转义后才进入 collapsed 元素，生成 ID 不接受模型文本。
- 投影只接受当前消息中同时存在且顺序正确的首尾 UUID，staged 快照也只按 UUID 恢复位置，不把外部摘要文本当作索引或代码执行。
- 工具段选择对 assistant tool_use 和 user tool_result 保守回退，降低折叠后产生 orphaned tool result 或不完整调用的概率。
- reset 的 generation 防止尚未进入提交阶段的旧 summarizer 迟到创建 committed，并隔离旧 finally 的触发状态写入；持久化 await 后的 health、通知和后续 snapshot 没有同等检查，不能据此保证所有旧异步写入都被隔离。订阅退订从 Set 删除监听，持久化与摘要异常进入 health 而不是静默生成成功提交。
- 真实模型输出、transcript 文件权限、真实 API 413 和重试副作用不在注入 fake 的测试安全结论内，仍需授权环境单独验证。

## 验收标准

- 低于 90% 不 spawn；90% 至不足 95% 启动后台摘要并先返回原投影；达到 95% 等待活动或新建任务，5000 token 增长门按实现抑制重复 spawn。
- compact/session_memory 只获得已提交投影，marble_origami 不递归折叠；禁用服务时 apply、withhold 和 recover 不改变消息。
- 已提交段以 summaryUuid 幂等替换首尾 UUID 闭区间，重复投影不增加 committed，也不重复调用 summarizer。
- 归档选择至少保留末尾四条，并回退相邻 tool_use/tool_result 边界；无法形成至少两条且不回退到零的段时不提交。
- 空摘要增加 totalEmptySpawns 和警告状态而不增加 collapsedSpans；缺 UUID、摘要异常及持久化异常按实现记录健康错误。
- commitStaged 同步更新 committed/staged 后再写日志；必须区分正常新摘要直接 committed，与 restoreFromEntries 从快照重建 staged 的两条路径。
- recoverFromOverflow 只排空当前 staged，返回其数量并立即投影；恢复快照中的 staged 可验证该行为，但不能据此断言正常 spawn 会先暂存。
- resume 重建 committed 摘要消息、原 UUID 边界和 nextId，snapshot 恢复 staged/armed/lastSpawnTokens；archived 在成功投影时重新填充。
- CtxInspect 报告包含 collapsedSpans、collapsedMessages、stagedSpans 和 health，外部特性档注册 36 个非空工具且包含 CtxInspect。
- 历史结果仅覆盖记录的离线套件、类型检查、构建和特性档；tests/contextCollapse.test.ts、tests/enabledFeatures.test.ts 覆盖各组件行为。

## 实现状态与剩余范围

- 状态：**partial**
- 正常 startSpawn 未把新摘要加入 staged，导致非恢复场景下 stagedSpans 不经历暂存阶段，真实 413 时通常没有本次运行生成的 staged 可排空；当前测试只证明恢复快照可排空。
- 真实模型摘要质量、工具禁用下的 fork 行为、实际 transcript 读写和真实 API 413 重试仍需授权环境验证，历史全量通过不能替代这些路径。
- recordCommit 或 recordSnapshot 失败只增加健康错误，内存 committed 已成立且没有重放补偿协议；边界缺失时 committed 计数也不等于当前视图实际折叠数量。
- 默认 defaultSummarize 将同一归档 span 同时传入 promptMessages 与 forkContextMessages，导致 fork 初始消息重复；需要修正输入接线并增加 defaultSummarize 级回归，现有 fake summarizer 测试未覆盖该生产路径。
- 持久化 await 后的 health、监听通知与后续 snapshot 缺少 generation/会话归属检查；需要补充持久化 pending 时 reset 的定向回归，避免旧任务继续影响新生命周期。
