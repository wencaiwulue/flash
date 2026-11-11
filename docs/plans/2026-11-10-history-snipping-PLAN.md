---
commit: 2bf435a5d3aca3c375da1387f1e33d3ce13db683
title: "Implement history snipping"
date: 2026-11-10T22:42:16+08:00
status: partial
kind: component
---

# 实施计划：Implement history snipping

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要让模型用短消息 ID 选择不再需要的旧轮次，并让选择在后续查询处理时生效，而不是由工具直接改写持久转录。删除不能只按 UUID 机械过滤：最近工作必须保留，assistant tool_use 与 user tool_result 不能拆开，token 提醒要以重置点后的增量计算，成功消费后的同一标记也不能再次剪切。REPL 的工具投影路径还要保留可见 scrollback，而无界面的 SDK 长会话需要在回放边界时收缩内存，两种视图必须共享一致的边界语义。

- 以父提交的核心 stub 和已存在 query/QueryEngine/attachment 管道为基线，不重写这些未变更消费者。
- 确认 UserMessage.sourceToolAssistantUUID、AssistantMessage.message.id 与 deriveShortMessageId 能表达双向工具关联。
- 把离线数组回归与真实模型/SDK 长会话验证分开，且不将 snip 解释为持久转录删除。

## 复用与兼容处理

### 复用现有实现

- 复用 buildTool、严格 Zod 输入和 local-jsx Command，分别实现模型入口与人工强制入口。
- 复用 roughTokenCountEstimationForMessages、isCompactBoundaryMessage 和 context_efficiency attachment 计算提醒。
- 复用 query 的 snip 阶段、QueryEngine.snipReplay、getMessagesAfterCompactBoundary 与 REPL includeSnipped 路径。
- 复用 HISTORY_SNIP 条件 require 和特性档夹具，避免引入另一套工具或命令注册表。

### 兼容、迁移与生命周期

- 保留 SnipCompactResult 的 messages/tokensFreed/executed/boundaryMessage 外形，既有 query 与 QueryEngine 调用点无需修改。
- CLAUDE_HISTORY_SNIP 的 falsy 值可在编译启用后运行时关闭，禁用路径即使 force 也返回原数组。
- getMessagesAfterCompactBoundary 默认过滤 snip，但既有 includeSnipped:true 继续为 UI 提供完整历史。
- /force-snip 是可选手动入口，Snip marker 是模型入口；两者共享目标保护，不引入新的 transcript 存储格式。
- message.ts 只扩展 SystemMessage 联合类型，旧消息没有新 subtype 时保持原投影和提醒行为。

## 文件级实施步骤

### 1. 定义边界类型与幂等投影

先在 message.ts 增加 marker/boundary 判别结构并纳入 SystemMessage，再实现 snipProjection.ts 的 boundary type guard、最新边界切片与 marker 过滤。投影不依赖执行器，后续核心可复用同一 boundary 判定。

涉及位置：`src/types/message.ts`、`src/services/compact/snipProjection.ts`

### 2. 实现安全目标解析与 marker 执行

在 snipCompact.ts 建立运行时开关、marker 工厂和短 ID 解析，随后实现双向工具闭包及保护闭包。接上自动目标、强制/标记两条执行路径、近似 token 统计和边界插入，最后以四类重置事件实现 10k 增长提醒，确保无操作路径返回原数组。

涉及位置：`src/services/compact/snipCompact.ts`

### 3. 提供模型工具与明确使用契约

实现 SnipTool 的 1 至 50 ID 严格输入、resolveSnipTargets 预检、只读/非并发属性和 marker newMessages；同步改写 prompt，说明 queued 生效时机、工具对和尾部保护以及不删除磁盘转录。

涉及位置：`src/tools/SnipTool/SnipTool.ts`、`src/tools/SnipTool/prompt.ts`

### 4. 接入强制命令和外部构建

新增 /force-snip 调用自动目标并以 setMessages 替换内存视图，在 commands.ts 的 HISTORY_SNIP 分支注册。随后把同一特性加入 build.ts，使既有 tools.ts 条件分支、query 和 SDK replay 在产物中使用真实实现。

涉及位置：`src/commands/force-snip.ts`、`src/commands.ts`、`scripts/build.ts`

### 5. 建立核心与特性档回归

在 snip.test.ts 用成对 tool_use/tool_result 和四消息保护尾部覆盖七个场景，特别断言第二次执行为 false、跨界工具对保留及 force 命令不修改原数组。特性夹具开启 HISTORY_SNIP 并输出 force-snip 注册，组合测试固定 37 个工具及 Snip。

涉及位置：`tests/snip.test.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`

### 6. 回写离线证据和持久化边界

最后依据实际实现和已有命令记录更新 STATUS/RELEASE：列出 125/546、类型检查、构建和 37 工具特性档，保留 offline/build 限定，并明确 REPL scrollback、SDK 内存回放与不重写旧磁盘记录是三种不同语义。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 短 ID 碰撞会选中多条消息；预检按 ID 是否有匹配而不是唯一匹配，不能把它当成寻址安全边界。
- 保护闭包可能使显式旧 ID 最终不删除，自动模式也可能保留较长工具链；这是避免协议破序的有意取舍。
- token 数量来自启发式估算且 removed 含 marker，自动 compact 阈值与展示数字都存在近似性。
- 工具投影保留 REPL 历史、force 命令直接替换内存、SDK 回放又裁剪存储，若新增消费者遗漏 includeSnipped 或 snipReplay，可能进一步扩大视图分叉。
- 离线测试没有真实模型选 ID、流式分片或长会话内存数据，构建不能覆盖这些在线行为。

## 验收顺序

1. 运行 snip 定向回归，核对无 marker/禁用不执行、marker 只消费一次及 boundary 的计数与位置。
2. 分别正选 assistant 和 tool result，验证双向扩展；让结果落入四消息保护尾部，确认整条链被保留。
3. 构造超过 10,000 估算 token 的消息，逐一检查 snip/compact/marker/context_efficiency 后的重置。
4. 重复调用 projectSnippedView，并分别检查 REPL includeSnipped、QueryEngine snipReplay 和 force-snip 原数组语义。
5. 构建独立特性档，核对 HISTORY_SNIP、37 个非空工具、Snip 与 force-snip；历史通过数字只从 at-commit STATUS/RELEASE 引用。
6. 需要在线验收时分别观察真实模型 Snip 调用和 SDK 长会话内存，不把这类后续结果倒填到本提交。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- marker/boundary 类型、目标闭包、尾部保护、自动/显式执行和 token nudge 已形成确定实现。
- SnipTool、/force-snip、HISTORY_SNIP 构建和 37 工具特性档已经注册；直接核心与 force 路径可执行，但模型 marker→query 执行链未接通。
- 模型投影、REPL scrollback、SDK 内存回放与不重写旧记录的代码约定已经明确；新增回归仅覆盖纯函数和命令内存行为。
- 提交内记录了 125/546 测试及类型检查、构建、声明和特性档结果；本记录仅引用这些历史证据。

### 未完成或后续工作

- 模型 SnipTool marker 在 query 执行前被默认投影过滤，模型入口需要调整投影/执行顺序；复杂流式工具链、实际 REPL/SDK replay 和 resume 精确删除也没有 at-commit 端到端证据。
- 短 ID 碰撞处理、估算 token 精度和持久隐私删除仍是明确限制，未被实现包装所掩盖。
