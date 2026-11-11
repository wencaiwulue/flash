---
commit: 2bf435a5d3aca3c375da1387f1e33d3ce13db683
title: "Implement history snipping"
date: 2026-11-10T22:42:16+08:00
status: partial
kind: component
---

# Implement history snipping

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交 982ab108e16a0919269629256555d7ef9efea707 已保留 HISTORY_SNIP 的编译分支、query/QueryEngine 调用点、context_efficiency attachment 和 snipProjection 外壳，但核心运行时固定禁用，shouldNudgeForSnips 与 isSnipMarkerMessage 恒为 false，snipCompactIfNeeded 永远返回原数组。SnipTool 与 /force-snip 尚不存在，投影函数也只是返回输入。因而已有的是围绕特性预留的管道，不是可选择删除旧上下文、保护工具对或节约 SDK 内存的实现。

需要让模型用短消息 ID 选择不再需要的旧轮次，并让选择在后续查询处理时生效，而不是由工具直接改写持久转录。删除不能只按 UUID 机械过滤：最近工作必须保留，assistant tool_use 与 user tool_result 不能拆开，token 提醒要以重置点后的增量计算，成功消费后的同一标记也不能再次剪切。REPL 的工具投影路径还要保留可见 scrollback，而无界面的 SDK 长会话需要在回放边界时收缩内存，两种视图必须共享一致的边界语义。

## 目标与非目标

### 目标

- 定义 snip_marker 与 snip_boundary 消息契约，使 Snip 工具只排队请求，query 在后续处理阶段执行一次并产生可观察边界。
- 只接受非保护尾部的 user/assistant 短 ID，保护最后四条原始消息，并以双向不动点扩展保留完整工具调用链。
- 支持显式 ID 与 /force-snip 自动选择，返回 tokensFreed、边界计数、无效 ID 信息和未执行时的原数组。
- 以最近 compact/snip/marker/context_efficiency 为重置点，在每约 10,000 个估算 token 增长后提示使用 Snip。
- 让模型侧投影从最新 snip 边界开始并隐藏内部 marker，同时让工具驱动的 REPL 投影保留 scrollback、SDK 回放收缩可变内存存储。
- 注册 Snip、/force-snip 和 HISTORY_SNIP 外部构建特性，用离线回归明确不重写旧磁盘转录记录的边界。

### 非目标

- 不生成旧对话摘要，也不调用模型决定剪切内容；该组件执行精确消息投影而非语义 compact。
- 不删除或重写 JSONL/on-disk transcript，snip 的效力限于活动模型上下文及各消费端的内存视图。
- 不把短 ID 当成全局持久标识或跨会话寻址协议，解析只针对当前消息数组。
- 不保证保护尾部之后恰好删除固定数量；为避免工具对跨界，相关联的旧消息也可能被保留。
- 不把离线消息数组测试解释为真实模型已主动选择 Snip，或长 SDK 会话已经完成在线内存验证。

## 方案架构与数据流

消息层新增 SystemSnipMarkerMessage 与 SystemSnipBoundaryMessage，并加入 SystemMessage 联合类型。marker 携带 messageIds，boundary 携带 snippedCount/snippedTokens；两者都有独立 UUID 和时间戳。SnipTool 使用严格输入，message_ids 为 1 至 50 个非空字符串，validateInput 先通过同一 resolveSnipTargets 检查可用性，call 仅返回 newMessages 中的 marker。直接数组调用 snipCompactIfNeeded 可以消费 marker；但真实 query 先通过 getMessagesAfterCompactBoundary 默认调用 projectSnippedView 过滤所有 snip_marker，再调用 snipCompactIfNeeded，因此模型工具产生的 marker 实际不会到达执行器。/force-snip 可执行不代表模型入口已接通。

目标解析先把 messages.slice(-4) 的全部消息 UUID 放入保护集，再对去重后的 requestedIds 查找保护集之外的 user/assistant，短 ID 由 deriveShortMessageId(uuid) 计算。expandToolPairs 循环收集目标 assistant 的 API message.id 与目标 tool-result 的 sourceToolAssistantUUID，同时向 assistant 分片及 user result 两个方向扩展，直到不再变化。若扩展目标触及保护尾部，算法再从这些保护点扩展整条关联闭包并从 targets 删除，因此不会留下半个工具对跨越保留边界。automaticTargets 复用同一闭包逻辑处理强制模式。

snipCompactIfNeeded 先检查 CLAUDE_HISTORY_SNIP 的运行时 falsy 禁用，再寻找最后一个 marker；非 force 且无 marker 时直接返回。显式 messageIds 优先于 marker 中的 ID，无 ID 的 force 使用自动旧消息集合。实际 removed 由 targets 与该 marker 组成，tokensFreed 采用 roughTokenCountEstimationForMessages 的近似值，boundary 被插回首个被删消息的位置。成功执行时 marker 随删除集合移除，第二次处理结果不会再次执行；无目标、功能禁用或无 marker 都保持 executed=false，其中无目标时 marker 本身也会保留。

提醒节奏不依赖总上下文阈值。shouldNudgeForSnips 找到最后一个 snip/compact boundary、snip marker 或 context_efficiency attachment，只估算其后消息，达到 SNIP_NUDGE_TOKEN_INTERVAL=10,000 才返回 true。既有 getContextEfficiencyAttachment 负责生成 attachment，消息转换层把 SNIP_NUDGE_TEXT 包装成 system reminder；一次提醒、一个待执行 marker 或任一种压缩边界都会开始新的增长窗口，避免每轮重复提示。

projectSnippedView 从最后一个 snip_boundary 开始切片并过滤 snip_marker，重复投影不会改变结果。既有 getMessagesAfterCompactBoundary 默认对模型路径应用它，工具驱动的 REPL 渲染则传 includeSnipped:true 保留旧消息 scrollback。QueryEngine 的 snipReplay 在 SDK 收到 boundary 时对 mutableMessages 再执行 force 剪切，以限制无 UI 长会话内存。/force-snip 通过 context.setMessages 直接替换内存数组，因而该命令路径会收缩当前视图；测试只确认原数组未被插入 boundary。核心与命令不重写旧转录记录，既有追加日志仍可记录 marker/boundary。

外部集成沿用条件 require：src/tools.ts 的 HISTORY_SNIP 分支加载新 SnipTool，src/commands.ts 的同名分支加载 /force-snip，scripts/build.ts 把标志加入两个 Bun build。运行时 isSnipRuntimeEnabled 再提供环境变量关闭开关，提醒附件也检查同一开关，避免引导模型调用不可用工具。特性档把工具总数更新为 37，并核对 Snip 与 force-snip 的实际编译注册。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `src/types/message.ts`，符号 `SystemSnipMarkerMessage` | 把 marker 与 boundary 的结构化字段加入内部消息联合类型。 |
| 变更 | `src/services/compact/snipProjection.ts`，符号 `projectSnippedView` | 实现最新边界切片、marker 隐藏和可重复投影。 |
| 变更 | `src/services/compact/snipCompact.ts`，符号 `snipCompactIfNeeded` | 实现运行时开关、marker 执行、目标闭包、自动剪切、nudge 和 token 统计。 |
| 变更 | `src/tools/SnipTool/SnipTool.ts`，符号 `export const SnipTool` | 提供严格 ID 输入、预检和只排队 marker 的模型工具。 |
| 变更 | `src/tools/SnipTool/prompt.ts`，符号 `SNIP_TOOL_PROMPT` | 说明短 ID、工具对、最近保护、下一处理阶段生效及不重写旧磁盘记录。 |
| 变更 | `src/commands/force-snip.ts`，符号 `name: 'force-snip'` | 以 force 自动目标更新 REPL 内存消息，并报告边界或无可用目标。 |
| 变更 | `src/commands.ts`，符号 `const forceSnip` | 通过 HISTORY_SNIP 条件加载并注册 force-snip 命令。 |
| 变更 | `scripts/build.ts`，符号 `'HISTORY_SNIP'` | 把 snip 特性加入 CLI 与 SDK 的外部 Bun feature 集合。 |
| 变更 | `tests/snip.test.ts`，符号 `describe('snip nudge, tool, and command'` | 添加七项核心、投影、提醒、工具和内存命令回归。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `hasForceSnipCommand` | 核对 37 个非空工具以及 Snip/force-snip 编译注册。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `hasForceSnipCommand` | 在独立特性构建中启用 HISTORY_SNIP 并导出命令存在性。 |
| 变更 | `docs/STATUS.md`，符号 `\| HISTORY_SNIP \|` | 记录 offline/build 验证范围、125/546 结果并移除 stub 边界。 |
| 变更 | `docs/RELEASE.md`，符号 `## HISTORY_SNIP` | 记录 marker、投影、REPL/SDK 和不重写旧磁盘记录的发布契约。 |
| 复用 | `src/query.ts`，符号 `snipCompactIfNeeded(messagesForQuery)` | 复用既有 query 调用点、boundary yield 和 tokensFreed 接线；但默认投影已先过滤 marker，模型入口因此未接通。 |
| 复用 | `src/QueryEngine.ts`，符号 `snipReplay` | 复用 SDK 可变消息存储的 boundary 回放钩子实现内存收缩。 |
| 复用 | `src/utils/messages.ts`，符号 `getMessagesAfterCompactBoundary` | 复用模型切片与 includeSnipped 选择，连接 REPL scrollback 和 snip 投影。 |
| 复用 | `src/utils/attachments.ts`，符号 `getContextEfficiencyAttachment` | 复用提醒 attachment 入口，让运行时开关与 SnipTool 可用性一致。 |
| 复用 | `src/tools.ts`，符号 `feature('HISTORY_SNIP')` | 复用已有条件工具注册位置，新实现由该分支加载。 |
| 复用 | `src/utils/sessionStorage.ts`，符号 `function applySnipRemovals` | 既有 resume 精确删除依赖 snipMetadata.removedUuids；新 boundary 未提供该字段，不能据内存 replay 推断磁盘回放完成。 |

## 关键决策与工程取舍

- 工具调用只产生 marker，不直接对 context.messages 做持久修改；直接数组执行时 marker 被消费后具备幂等性，但实际 query 在执行前先投影过滤 marker，统一处理顺序的设计意图尚未在模型入口兑现。
- 工具对采用双向闭包而不是只补删 tool_result；assistant 分片、父 assistant UUID 与反向结果链接都参与，宁可保留更多消息也不破坏模型输入结构。
- 最近四条按原始消息计数，而不是只计算可见 user/assistant 轮次；system、attachment 与 progress 同样占用保护尾部位置，规则简单且可重复。
- token 提醒以最后一次重置事件后的估算增量为准，不另设跨调用计时器或累计状态；同一消息历史可以独立重算提醒条件。
- 工具驱动的 REPL 与 SDK 不共享一种存储收缩策略：前者为交互回看保留全量，后者在 boundary 回放时裁剪内存；/force-snip 则直接替换 REPL 内存视图，模型侧仍使用同一投影函数。
- tokensFreed 明确采用现有粗略估算并传给后续 compact 阈值，不伪装成提供商返回的精确计费 token。

### 备选方案与回溯分析

- 回溯性比较：可以在 SnipTool.call 内立即过滤消息，但会绕过既有 query 管线和 boundary yield；实际选择 marker 分离请求与直接数组执行，却因 query 先投影过滤 marker 而未兑现模型侧的后续执行。
- 回溯性比较：可以复用语义 compact 生成摘要，但会引入模型调用、摘要质量和延迟；实际选择确定性删除，保留的信息更少但行为可预测。
- 回溯性比较：可以仅按 UUID 删除用户选中的消息，实现更短，却可能产生孤立 tool_result 或残缺 assistant；实际以不动点闭包换取工具链完整性。
- 回溯性比较：可以同步裁剪持久转录以统一所有视图，但会失去 REPL 回看和原始审计记录；实际分离模型投影、UI scrollback、SDK 内存与磁盘历史。

## 安全与协议边界

- Snip 不读写文件，checkPermissions 的 allow 不代表获得文件系统或 shell 权限；其副作用是后续模型上下文变化，isConcurrencySafe 固定为 false。
- 输入 schema 拒绝未知字段并限制 ID 数量，解析只匹配当前数组中的 user/assistant；system、attachment、progress 和最近四条不能由短 ID 直接选中。
- 工具对闭包与保护尾部共同防止把不完整工具调用序列送给模型，避免上下文压缩破坏协议结构。
- marker 是对当前会话的内部控制消息，投影会隐藏它；旧磁盘记录不被重写，追加日志仍可能保存新边界；因此该功能不能被当作删除敏感历史或满足数据擦除要求的机制。
- 编译 feature、运行时环境开关和 nudge 开关保持一致，但启用 Snip 不等于真实模型会正确选择旧 ID，仍需在线交互验收。

## 验收标准

- 核心直接调用在无 marker 且非 force、运行时禁用或没有合法目标时均不执行；有效请求只消费最后一个 marker 并插入一个 snip_boundary。
- 真实模型 SnipTool marker 必须经 query 投影后仍到达执行器；本 revision 默认投影先过滤全部 marker，未达到该端到端验收。
- 重复 ID 被去重，未知、受保护或非 user/assistant ID 进入 invalidIds；SnipTool 对任何无效 ID 或无目标请求拒绝调用。
- 选择 assistant 会联动其结果，选择结果也会联动 assistant；只要工具链触及最后四条消息，相关链不从不保护集合中删除。
- force 自动模式只从保护尾部之前的 user/assistant 建目标，结果保留顺序、首个删除处边界、最近工作及完整工具对。
- snippedCount、snippedTokens 与 removed 集合一致，tokensFreed 为近似估算；无效 ID 数量在存在有效删除时进入边界说明。
- 距最近 snip/compact/marker/context_efficiency 之后增长达到 10,000 估算 token 才提醒，任一新重置点后重新计算。
- 模型视图从最新 boundary 开始且无 marker，重复投影稳定；工具驱动的 REPL 可保留旧 scrollback，SDK boundary 回放可收缩内存，旧磁盘记录不被重写。
- 外部构建包含 Snip 与 /force-snip，特性档为 37 个非空工具；新增测试和历史命令记录不得混写为本次重新执行。

## 实现状态与剩余范围

- 状态：**partial**
- 真实模型能否依据 [id:...] 正确选择旧轮次，以及 marker 与真实流式 tool_use 的交错行为，仍需授权模型环境单独验证。
- 真实 query 会在每轮 snip 执行前过滤全部 marker，因此有效 marker 也不会消费，并可能持续留在原始消息数组中重置 nudge；findLast、无效目标和短 ID 问题只是修复该顺序后的次级限制。
- 短 ID 若发生碰撞会匹配所有同 ID 消息而不是要求唯一；调用者应把选择范围限制在当前历史，不能用该 ID 做安全身份。
- tokensFreed 是粗略估算，边界中的数量还包括被消费的 marker，不能等同于精确计费节省或仅用户可见消息数。
- 新 boundary 没有 sessionStorage.applySnipRemovals 所读取的 snipMetadata.removedUuids，磁盘 resume 会跳过精确删除回放；纯内存测试不覆盖该协议缺口。
- 工具投影路径的旧磁盘历史与 REPL scrollback 保留原内容，/force-snip 则直接替换内存数组；持久删除和隐私擦除必须走独立机制。
