---
id: ui-rendering
batch: 4
title: UI Rendering 消息、工具结果与终端展示设计
date: 2026-11-12
status: draft
---

# UI Rendering 消息、工具结果与终端展示设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理"、"提高可靠性"、"保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

UI 渲染系统需要解决以下具体问题：

1. **消息类型到组件的多分支映射**：系统有多种消息类型（assistant text、tool use、tool result、user text、system、thinking、attachment、collapsed groups、grouped tool uses），需要精确且可扩展地路由到对应渲染组件。
2. **流式更新的性能优化**：在长会话（2000+ 消息）中，每收到一个 delta 就重渲染所有消息会导致 CPU 100%、GC 死亡螺旋。
3. **文本宽度与 ANSI 处理**：终端输出有 ANSI 颜色码，渲染时需要正确计算显示宽度、切片、保留颜色样式。
4. **Diff 与语法高亮的缓存**：代码 diff 和高亮是 CPU 密集操作，在 ctrl+o 切换 transcript/prompt 时不能重复计算。
5. **错误边界隔离**：单个组件渲染失败不能导致整个会话崩溃。
6. **思考块的可见性控制**：在正常模式下隐藏 thinking，verbose/transcript 模式显示；且只显示当前轮的 thinking，历史轮的 thinking 隐藏。

如果没有消息类型到组件的精确映射，会出现：工具调用渲染成普通文本、用户输入显示为 assistant 消息、思考块在不应该显示时泄露。

如果没有流式更新优化，在长会话中会发生：每收到一个 token 就重渲染所有消息 → Ink 挂载完整 React fiber 树 → Yoga 计算布局 → 屏幕缓冲区重写 → 每次渲染 200ms+ → 最终导致进程无响应。

### 调用方与责任边界

调用方：
- `src/screens/REPL.tsx` 或桌面端等价物渲染 `<Messages>`
- `src/components/Message.tsx` 根据消息类型路由到子组件
- 各个工具（FileEditTool、BashTool 等）通过 `renderToolUseMessage`、`renderToolResultMessage` 提供自定义渲染

责任边界：
- **Message.tsx**：消息类型到组件的路由、progress messages 聚合
- **Messages.tsx**：消息列表管理、流式处理、缓存策略、虚拟滚动
- **Markdown.tsx**：Markdown 解析、流式稳定边界、token 缓存
- **StructuredDiff.tsx**：Diff 高亮、NAPI 模块调用、结果缓存
- **各个 messages/ 子组件**：单一消息类型的渲染逻辑
- **SentryErrorBoundary.ts**：单个组件的错误隔离
- **permissions/**、**mcp/**、**plugins/**：由其他 spec 负责，本 spec 不重复

### 实际约束

性能与体验约束：
- 非虚拟滚动路径最大消息数：200 条（超过时从第一个可见消息开始切片）
- Markdown token 缓存最大容量：500 条（LRU 淘汰）
- Diff 渲染缓存：WeakMap 按 patch 缓存，每个 patch 最多缓存 4 种宽度/亮度组合
- 流式更新稳定边界只前进（monotonic advance），不后退

平台约束：
- 终端宽度动态变化时需要重新计算布局
- 全屏模式（fullscreen）和普通模式的选择行为不同（全屏模式有独立的 NoSelect  gutter）
- Ink 渲染引擎有特殊的 memo 策略（自定义比较器 `areMessagePropsEqual`）

### 内部/外部差异

本系统在 CLI、SDK、离线/在线模式下行为一致。唯一差异是：
- 桌面端可能有额外的渲染路径（如图片预览、弹出窗口），但核心消息渲染逻辑共享

## 2. 设计理由与备选方案

### 决策 1：消息类型通过 switch-case 显式路由，而非注册表或依赖注入

**实际机制：**
- `Message.tsx` 使用 `switch (message.type)` 精确路由
- assistant 消息内部再次按 content block 类型 switch：`tool_use`、`text`、`thinking`、`redacted_thinking`、`server_tool_use`、`advisor_tool_result`
- user 消息按 content block 类型 switch：`text`、`image`、`tool_result`
- system 消息有 subtype 分支：`compact_boundary`、`microcompact_boundary`、`local_command`、其他

**为什么这样设计：**
- TypeScript 可以穷举检查，确保没有遗漏的消息类型
- 没有动态注册的开销，渲染路径直接
- 工具的自定义渲染通过工具接口的 `renderToolUseMessage`/`renderToolResultMessage` 实现，不影响主路由

**备选方案及不采用原因：**
- 方案 A：注册表模式 `registerRenderer(type, Component)` → 被否决，TypeScript 无法保证覆盖完整性
- 方案 B：依赖注入容器 → 被否决，过度设计，且引入运行时开销

**代价：**
- 新增消息类型需要修改 `Message.tsx`，增加了该文件的修改频率
- 工具自定义渲染需要实现 Tool 接口的相应方法，不能独立注册

**证据：**
- `src/components/Message.tsx:103-282` MessageImpl 中的 switch 结构
- `src/components/Message.tsx:314-353` UserMessage 中的 switch
- `src/components/Message.tsx:416-487` AssistantMessageBlock 中的 switch

### 决策 2：流式 Markdown 渲染使用稳定边界策略，只重渲染不稳定部分

**实际机制：**
- `StreamingMarkdown` 组件维护一个 `stablePrefixRef.current` 指向当前已稳定的文本长度
- 每次收到新 delta 时，用 `marked.lexer` 解析 `stripped.substring(boundary)`，找到最后一个完整 block
- 将 `stablePrefix` 前进到该 block 结束位置，只将 `unstableSuffix` 传递给 `<Markdown>`
- 稳定边界只前进（monotonic），不后退；如果文本被替换（非追加）则重置边界

**为什么这样设计：**
- 完整 block 的解析是稳定的，不会因为后续 tokens 改变
- 只重渲染不稳定部分，减少 React fiber 树的更新范围
- memoization 在 `<Markdown>` 内部，stablePrefix 不变时完全跳过解析

**备选方案及不采用原因：**
- 方案 A：每次 delta 都重渲染全部文本 → 被否决，长文本时性能不可接受
- 方案 B：按行分割，只重渲染最后 N 行 → 被否决，无法处理多行 block（代码块、表格）
- 方案 C：diff 前一次和当前的渲染结果，只更新变化部分 → 被否决，diff 成本高于重渲染

**代价：**
- 实现复杂度增加，需要理解 marked 的 token 结构
- 在某些边界情况下（不完整的代码块），最后一个 block 可能会闪烁（先显示不完整，再显示完整）

**证据：**
- `src/components/Markdown.tsx:163-215` StreamingMarkdown 实现
- `src/components/Markdown.tsx:171` `use no memo` 注释（React Compiler 无法证明边界的单调性）

### 决策 3：Markdown token 缓存按内容 hash 存储，MRU 淘汰策略

**实际机制：**
- 模块级 `tokenCache = new Map<string, Token[]>()`，key 是内容的 hash（通过 `hashContent`）
- 先检查是否有 Markdown 语法：`MD_SYNTAX_RE` 匹配 `#*`[>|_-~` 或 `\n\n` 或 `^\d+\. ` 或 `\n\d+\. `
- 如果没有语法，直接构造单个 paragraph token（跳过 lexer）
- 如果有语法且命中缓存，将该 key 移到 Map 末尾（MRU promotion）
- 缓存超过 500 条时，删除 Map 的第一个 key（最久未使用）

**为什么这样设计：**
- `marked.lexer` 是热路径（约 3ms per message），虚拟滚动时频繁 remount，必须缓存
- LRU 确保活跃消息（最近滚动过的）留在缓存
- 无语法文本的快路径覆盖了大部分短 assistant 响应和用户输入，进一步降低开销
- 用 hash 而不是完整内容作为 key，避免保留大字符串在内存（#24180 的 RSS 回归修复）

**备选方案及不采用原因：**
- 方案 A：React.memo 加 useMemo → 被否决，虚拟滚动时 unmount/remount 会清空 memo 缓存
- 方案 B：LRU 用第三方库 → 被否决，Map 的 insertion order 已足够，不需要额外依赖
- 方案 C：无限缓存 → 被否决，长会话中 RSS 会无限制增长

**代价：**
- 模块级可变状态，在某些测试场景可能需要重置（当前实现没有重置机制）
- 500 条的容量是经验值，可能不适合所有场景

**证据：**
- `src/components/Markdown.tsx:24-73` tokenCache 和 cachedLexer 实现
- `src/components/Markdown.tsx:46-55` 无语法快路径
- `src/components/Markdown.tsx:60-63` MRU promotion

### 决策 4：Diff 渲染使用 WeakMap + NAPI 模块，结果两级缓存

**实际机制：**
- `RENDER_CACHE = new WeakMap<StructuredPatchHunk, Map<string, CachedRender>>()`
- 第一级 key 是 patch 对象本身（WeakMap，patch 被 GC 时缓存自动释放）
- 第二级 key 是 `${theme}|${width}|${dim}|${gutterWidth}|${firstLine}|${filePath}` 的组合
- 每个 patch 的第二级 Map 最多缓存 4 个条目（避免终端 resize 时无限积累）
- 调用 Rust NAPI 模块 `ColorDiff` 进行语法高亮和颜色计算
- 预分割 gutter 和 content 列（`sliceAnsi`），避免每次渲染时重复分割

**为什么这样设计：**
- ctrl+o 切换 transcript/prompt 时，Messages 组件被 unmount/remount，React.memo 缓存失效，必须在模块级缓存
- WeakMap 确保 patch 对象不再被引用时，缓存能被 GC，不会内存泄漏
- 预分割 gutter/content 后，渲染时只需 2 个 RawAnsi 叶子，而不是 N 个 DiffLine 行（PR #21439）
- 全屏模式有独立的 NoSelect gutter，普通模式没有，通过 `splitGutter` flag 分支处理

**备选方案及不采用原因：**
- 方案 A：每次渲染都调用 NAPI → 被否决，切换时会有明显延迟
- 方案 B：只用 Map，不用 WeakMap → 被否决，长会话中旧 patch 无法 GC，内存泄漏
- 方案 C：不分割 gutter/content，每次渲染 slice → 被否决，Yoga 布局成本高（N 行 vs 2 列）

**代价：**
- 实现复杂度高，需要理解 Ansi slice、Yoga 布局、NAPI 模块
- 缓存策略（4 个条目）是经验值，可能不适合极端 resize 场景

**证据：**
- `src/components/StructuredDiff.tsx:21-116` RENDER_CACHE 和 renderColorDiff 实现
- `src/components/StructuredDiff.tsx:109-113` 4 条目的上限
- `src/components/StructuredDiff.tsx:96-101` pre-split gutter/content

### 决策 5：长会话使用 UUID 锚点切片，而非简单的 slice(-N)

**实际机制：**
- 非虚拟滚动路径有 `MAX_MESSAGES_WITHOUT_VIRTUALIZATION = 200` 的上限
- 不使用 `collapsed.slice(-200)`，因为这会导致每次新增消息时所有消息的索引都变 → 所有组件 remount
- 而是维护 `sliceAnchorRef = { uuid: string, idx: number }`
- 当 `collapsed.length - start > 200 + 50`（超过上限+步长）时，将 `start` 前进到 `collapsed.length - 200`，并更新 anchor
- 如果 anchor 的 uuid 在当前 collapsed 中找不到，回退到 anchor 的 idx（clamped）

**为什么这样设计：**
- 简单的 slice(-200) 会导致所有消息的 React key 变化 → Ink 重新挂载所有组件 → 完整的终端重写 → CC-941 问题
- UUID 锚点确保切片边界只有在真正需要前进时才变化，大多数新增消息时边界不变
- 步长 50 避免每次新增消息都前进边界（减少抖动）
- idx 回退处理 collapse/regroup 导致 uuid 消失的情况（CC-1174）

**备选方案及不采用原因：**
- 方案 A：不切片，总是渲染全部 → 被否决，2000+ 消息时会导致 GC 死亡螺旋
- 方案 B：slice(-200) + 稳定 key → 被否决，React key 是 uuid，slice 后 key 还是那些，但 Yoga 布局还是会重算所有行
- 方案 C：固定起始索引 0 → 被否决，用户看不到最新消息

**代价：**
- 实现复杂度增加，需要维护 anchor 状态
- 用户向上滚动时看不到更早的消息（必须用 ctrl+o transcript 模式）

**证据：**
- `src/components/Messages.tsx:344-393` computeSliceStart 实现
- `src/components/Messages.tsx:354-356` MAX_MESSAGES_WITHOUT_VIRTUALIZATION 和 MESSAGE_CAP_STEP
- `src/components/Messages.tsx:372-376` uuid 丢失时的 idx 回退

### 决策 6：错误边界静默降级（返回 null），不显示错误信息

**实际机制：**
- `SentryErrorBoundary` 是 React Component，捕获 child 抛出的异常
- `getDerivedStateFromError` 设置 `hasError: true`
- `render` 在 `hasError` 时返回 `null`，不显示任何错误 UI

**为什么这样设计：**
- UI 组件渲染失败是可恢复的，不应该让整个会话崩溃
- 向用户显示 React 错误堆栈没有帮助（用户看不懂）
- Sentry 会上报错误，开发者可以看到

**备选方案及不采用原因：**
- 方案 A：不使用错误边界 → 被否决，单个组件失败会导致整个会话崩溃
- 方案 B：显示友好的错误信息 → 被否决，用户界面会乱，且没有用户可执行的恢复操作
- 方案 C：重试渲染 → 被否决，可能无限循环

**代价：**
- 用户可能没有意识到某个组件渲染失败了（只是空白）
- 某些关键组件（如工具结果）渲染失败会影响用户体验，但没有反馈

**证据：**
- `src/components/SentryErrorBoundary.ts:11-28` 实现

### 决策 7：Thinking 块可见性通过 lastThinkingBlockId 精确控制

**实际机制：**
- `hidePastThinking` flag 启用时（transcript 模式），只显示最后一个 thinking block
- `lastThinkingBlockId` 计算：从后往前遍历消息，找到第一个 assistant 消息中的最后一个 thinking block，返回 `${msg.uuid}:${idx}`
- 如果有 streaming thinking 可见，设置 `lastThinkingBlockId = 'streaming'`（不匹配任何已完成的 thinking）
- `AssistantThinkingMessage` 比较自己的 `thinkingBlockId` 与 `lastThinkingBlockId`，不匹配时 `hideInTranscript`

**为什么这样设计：**
- 历史轮的 thinking 是噪声，用户通常只关心当前轮的 thinking
- `uuid:idx` 格式确保精确匹配（一个 assistant 消息可能有多个 content blocks）
- streaming thinking 时隐藏所有已完成的，避免重复显示

**备选方案及不采用原因：**
- 方案 A：总是显示所有 thinking → 被否决，verbose 模式太乱
- 方案 B：只显示当前轮但不精确到 idx → 被否决，一个消息中的多个 thinking 会全部显示或全部隐藏

**代价：**
- 每次消息变化时都要遍历计算 lastThinkingBlockId（O(n)，但在 transcript 模式下 n 被切片限制）
- 逻辑较复杂，容易出错

**证据：**
- `src/components/Messages.tsx:454-481` lastThinkingBlockId 计算
- `src/components/Message.tsx:454-466` AssistantThinkingMessage 的 hideInTranscript
- `src/components/Message.tsx:506-513` areMessagePropsEqual 中对 lastThinkingBlockId 的处理

### 决策 8：自定义 memo 比较器，避免不必要的重渲染

**实际机制：**
- `Message` 组件有 `areMessagePropsEqual` 自定义比较器
- `MessageRow` 组件有 `areMessageRowPropsEqual` 自定义比较器
- `Messages` 组件有自定义比较器（内联）
- 比较器跳过某些属性（如 `onOpenRateLimitOptions`、`scrollRef`、`setCursor` 等函数引用）
- 对 `inProgressToolUseIDs` 使用 `setsEqual` 比较（内容相等就算相等，不比较 Set 引用）
- 对 `streamingToolUses` 只比较 `contentBlock` 引用
- 对 `lastThinkingBlockId`，只在消息有 thinking 内容时才比较（否则即使变了也不重渲染，CC-941）

**为什么这样设计：**
- 默认 React.memo 是浅比较，函数引用每次 render 都变，导致不必要的重渲染
- Set 对象即使内容相同，引用也不同，必须自定义比较
- lastThinkingBlockId 变化时，只有有 thinking 内容的消息才需要重渲染，其他消息不需要

**备选方案及不采用原因：**
- 方案 A：不用 memo → 被否决，性能不可接受
- 方案 B：用 useMemo/useCallback 所有地方 → 被否决，代码太乱，容易遗漏
- 方案 C：状态提升到 Context → 被否决，过度设计，且 Context 更新也会导致所有 consumers 重渲染

**代价：**
- 比较器必须手动维护，新增 props 时容易忘记更新
- 比较器有 bug 时会导致 UI 不更新（更难调试）

**证据：**
- `src/components/Message.tsx:500-525` areMessagePropsEqual
- `src/components/MessageRow.tsx:307-355` areMessageRowPropsEqual
- `src/components/Messages.tsx:1037-1094` Messages 的自定义比较器
- `src/components/Message.tsx:506-513` 对 lastThinkingBlockId 的特殊处理

### 决策 9：虚拟滚动只在全屏模式启用，通过 scrollRef presence gate

**实际机制：**
- `VirtualMessageList` 只在 `scrollRef != null` 且 `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL` 不为真时渲染
- 非虚拟滚动路径用 `sliceAnchorRef` 切片
- 虚拟滚动路径渲染所有消息（不切片），但只在视口内的消息挂载 DOM
- `scanElement`、`setPositions` 等 props 只在虚拟滚动路径传递

**为什么这样设计：**
- 全屏模式有完整的 alt buffer，可以自定义滚动；普通模式依赖终端原生滚动，虚拟滚动反而不自然
- scrollRef 是 REPL.tsx 传递的，其 presence 是可靠的 gate（不需要另一个 prop）
- 虚拟滚动完全绕过消息数上限，体验更好

**备选方案及不采用原因：**
- 方案 A：总是启用虚拟滚动 → 被否决，普通模式下原生滚动更好用
- 方案 B：用另一个 prop（如 `enableVirtualScroll`）控制 → 被否决，scrollRef 已足够

**代价：**
- 两套渲染路径，测试覆盖需要同时考虑
- VirtualMessageList 实现复杂

**证据：**
- `src/components/Messages.tsx:551-552` virtualScrollRuntimeGate
- `src/components/Messages.tsx:953-977` 虚拟滚动 vs 非虚拟滚动分支
- `src/components/VirtualMessageList.tsx` 实现（未详细阅读）

## 3. 目标与非目标

### 目标

**状态与生命周期：**
- 消息列表支持流式更新，每个 delta 只重渲染变化部分
- Markdown 解析结果缓存，虚拟滚动 remount 时不重复解析
- Diff 高亮结果缓存，切换 transcript/prompt 时不重复计算
- 错误边界隔离单个组件失败，不影响整个会话

**接口与数据：**
- 消息类型到组件的映射是穷举的，TypeScript 检查覆盖完整性
- 工具可通过 `renderToolUseMessage`、`renderToolResultMessage`、`renderToolUseProgressMessage` 自定义渲染
- ANSI 文本支持正确的宽度计算、切片、颜色保留

**执行与环境：**
- 长会话（2000+ 消息）在普通模式下通过 UUID 锚点切片，性能可接受
- 全屏模式下虚拟滚动，支持无限消息
- 流式 thinking 在当前轮可见，历史轮隐藏（transcript 模式）

**依赖边界：**
- 本 spec 描述 UI 渲染核心，permissions/mcp/plugins 的专用 UI 由对应 spec 负责
- Markdown 解析依赖 `marked` 库，Diff 高亮依赖 Rust NAPI 模块
- 终端渲染依赖 Ink 库，Yoga 布局

### 非目标

- 不负责 Web/桌面端的 GUI 渲染（只负责 CLI Ink 渲染）
- 不实现新的 Markdown 语法（只使用 marked 支持的）
- 不重新实现语法高亮（依赖现有高亮库和 NAPI 模块）
- 不优化冷启动性能（只优化热路径和长会话）
- 不处理权限 UI、MCP 配置 UI、插件 UI 等（由其他 spec 负责）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

**主要入口：**
```tsx
// src/components/Messages.tsx
<Messages
  messages={Message[]}           // 原始消息列表
  tools={Tools}                  // 工具列表，用于 tool use/result 渲染
  commands={Command[]}           // 命令列表
  verbose={boolean}              // 是否显示详细信息（thinking、完整工具结果）
  toolJSX={...}                  // 工具 UI
  inProgressToolUseIDs={Set<string>}  // 正在执行的工具 ID
  streamingToolUses={StreamingToolUse[]}  // 流式 tool use
  streamingThinking={StreamingThinking | null}  // 流式 thinking
  streamingText={string | null}  // 流式文本
  screen={'prompt' | 'transcript'}  // 当前屏幕模式
  hidePastThinking={boolean}     // 是否隐藏历史 thinking
  scrollRef={Ref<ScrollBoxHandle>}  // 滚动容器引用（虚拟滚动 gate）
  isBriefOnly={boolean}          // 是否只显示 brief 工具结果
/>
```

**渲染流程：**
1. `Messages` 接收原始消息，调用 `normalizeMessages` 规范化
2. 应用各种转换：`reorderMessagesInUI`、`collapseReadSearchGroups`、`collapseHookSummaries`、`collapseBackgroundBashNotifications`、`collapseTeammateShutdowns`
3. 应用 brief 过滤（如果启用）
4. 计算切片（非虚拟滚动路径）
5. 渲染 `MessageRow` 列表，每个 `MessageRow` 渲染一个 `Message`
6. `Message` 根据消息类型路由到具体组件
7. 流式内容（text、thinking、tool use）单独渲染在列表末尾

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|------|-----------|---------|------------|-----------------|
| Messages.tsx | sliceAnchorRef, tokenCache (no, tokenCache 在 Markdown.tsx) | 消息规范化、分组、折叠、切片 | 单个消息的渲染 | 接收 Message[]，渲染 MessageRow[] |
| Message.tsx | 无（纯组件） | 消息类型路由 | 消息列表管理 | 接收单个 Message，路由到子组件 |
| Markdown.tsx | tokenCache (module level) | Markdown 解析、流式稳定边界 | 消息类型处理 | 接收 string，渲染 ReactNode |
| StructuredDiff.tsx | RENDER_CACHE (module level) | Diff 高亮、缓存 | 完整消息渲染 | 接收 StructuredPatchHunk，渲染 ReactNode |
| SentryErrorBoundary.ts | this.state.hasError | 错误捕获、降级 | 渲染逻辑 | 包裹 children，出错时返回 null |
| messages/*.tsx | 无（大多纯组件） | 单一消息类型渲染 | 消息列表、路由 | 接收特定类型 props，渲染 ReactNode |
| utils/messages.ts | 无（纯函数） | 消息规范化、查找、分组 | 渲染逻辑 | 工具函数，供 Messages.tsx 调用 |

**为什么状态放在模块级而非组件级：**
- tokenCache 和 RENDER_CACHE 需要在组件 unmount/remount 后保留（ctrl+o 切换）
- 组件级 state/useMemo 在 unmount 后清空，无法满足需求
- WeakMap 确保内存可回收

### 4.3 主控制流

**完整渲染流程（成功路径）：**
```
用户输入 / 模型响应
  ↓
QueryEngine 产生消息
  ↓
REPL.tsx 渲染 <Messages messages=[...]>
  ↓
Messages.tsx: normalizeMessages → reorder → collapse → filter → slice
  ↓
构建 lookups: resolvedToolUseIDs, erroredToolUseIDs, toolUseByToolUseID
  ↓
渲染 MessageRow 列表（虚拟或非虚拟）
  ↓
MessageRow: 判断是否 static → OffscreenFreeze → 渲染 Message
  ↓
Message: switch (message.type) → 路由到子组件
  ├─ assistant: switch (content.type)
  │   ├─ text → AssistantTextMessage → Markdown
  │   ├─ tool_use → AssistantToolUseMessage → tool.renderToolUseMessage
  │   ├─ thinking → AssistantThinkingMessage
  │   └─ ...
  ├─ user: switch (content.type)
  │   ├─ text → UserTextMessage → Markdown
  │   ├─ tool_result → UserToolResultMessage → tool.renderToolResultMessage → StructuredDiff
  │   └─ ...
  ├─ system → SystemTextMessage
  ├─ collapsed_read_search → CollapsedReadSearchContent
  └─ ...
  ↓
流式内容（如果有）单独渲染在列表末尾
  ├─ streamingText → StreamingMarkdown
  └─ streamingThinking → AssistantThinkingMessage
```

**分支路径：**
- 虚拟滚动：scrollRef 存在 → VirtualMessageList 只渲染视口内的行
- 非虚拟滚动：scrollRef 不存在 → sliceAnchorRef 切片 → flatMap 渲染所有可见行
- 静态消息：shouldRenderStatically 返回 true → OffscreenFreeze 缓存，不重渲染
- 动态消息：shouldRenderStatically 返回 false → 每次变化都重渲染

### 4.4 数据结构与持久化

**关键数据结构：**
```ts
// Message 类型（简化）
type Message = 
  | { type: 'user', message: { content: ContentBlock[] }, uuid: string }
  | { type: 'assistant', message: { content: ContentBlock[] }, uuid: string }
  | { type: 'system', subtype?: string, content?: string, uuid: string }
  | { type: 'attachment', attachment: Attachment, uuid: string }
  | { type: 'collapsed_read_search', ... }
  | { type: 'grouped_tool_use', ... }

// ContentBlock 类型
type ContentBlock =
  | { type: 'text', text: string }
  | { type: 'tool_use', id: string, name: string, input: unknown }
  | { type: 'tool_result', tool_use_id: string, content: ..., is_error?: boolean }
  | { type: 'image', source: ... }
  | { type: 'thinking', thinking: string }
  | { type: 'redacted_thinking', ... }

// 消息 Lookups（由 buildMessageLookups 构建）
type MessageLookups = {
  resolvedToolUseIDs: Set<string>,
  erroredToolUseIDs: Set<string>,
  toolUseByToolUseID: Map<string, ToolUseBlock>,
  progressMessagesByToolUseID: Map<string, ProgressMessage[]>,
}
```

**持久化：**
- tokenCache 和 RENDER_CACHE 是内存级缓存，不持久化到磁盘
- 消息本身持久化到 transcript（由 session persistence spec 负责）
- 缓存大小限制：tokenCache 500 条，每个 patch 最多 4 个 diff 缓存

**恢复策略：**
- 缓存是按需重建的，没有持久化，重启后自动重建
- 没有缓存时只是性能稍差，功能正常

### 4.5 跨子系统依赖

| 上游/下游 | 接口 | 责任说明 | 归属 spec |
|----------|------|---------|----------|
| Tool 接口 | renderToolUseMessage, renderToolResultMessage, renderToolUseProgressMessage | 工具自定义渲染 | tool-framework |
| Markdown 工具 | configureMarked, formatToken | Markdown 到 ANSI 转换 | 本 spec |
| ColorDiff NAPI | new ColorDiff(patch, ...).render(theme, width, dim) | Diff 语法高亮 | 本 spec |
| collapseReadSearchGroups | 折叠读取/搜索工具调用 | 消息分组 | context-compaction |
| buildMessageLookups | 构建工具 ID 查找表 | 消息查找 | 本 spec |
| Ink | Box, Text, Ansi, RawAnsi, useTheme | 终端渲染 | （外部依赖） |

## 5. 失败语义与工程取舍

### 失败表

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|------------------|--------------|-------------|--------------|
| 单个消息组件抛出异常 | SentryErrorBoundary | 捕获，不传播 | 否，不重试 | 该组件返回 null，其他继续 | 该消息位置空白，Sentry 上报 |
| ColorDiff NAPI 模块不可用 | StructuredDiff.tsx expectColorDiff() | 返回 null，fallback 到 StructuredDiffFallback | 否 | 无特殊清理 | 使用简单的 diff 渲染，无语法高亮 |
| marked 解析抛出异常 | Markdown.tsx 隐式（未捕获） | 向外传播到 SentryErrorBoundary | 否 | 无特殊清理 | 整个消息空白（如果 Markdown 被 ErrorBoundary 包裹）或会话崩溃（如果没有） |
| 流式文本接收非追加更新 | StreamingMarkdown.tsx !stripped.startsWith(stablePrefixRef.current) | 重置 stablePrefixRef.current 为空 | 否，自动重置 | 稳定边界清空，重新开始 | 可能有短暂闪烁，然后正常渲染 |
| 消息数超过 MAX_MESSAGES_WITHOUT_VIRTUALIZATION | Messages.tsx computeSliceStart | 静默切片，不抛异常 | 否 | sliceAnchorRef 前进 | 用户看不到更早的消息，必须用 ctrl+o |
| 终端宽度变为 0 或负数 | StructuredDiff.tsx safeWidth = Math.max(1, ...) | 静默 clamp 到 1，不抛异常 | 否 | 无 | 渲染宽度为 1，可能显示不全但不崩溃 |
| Diff 缓存超过 4 个条目 | StructuredDiff.tsx perHunk.size >= 4 | 清空该 patch 的所有缓存 | 否 | 缓存清空 | 下次渲染时重建缓存 |
| 工具 renderToolUseMessage 抛出异常 | AssistantToolUseMessage 中的 SentryErrorBoundary | 捕获，不传播 | 否 | 该组件返回 null | 工具调用的自定义渲染空白，但工具名仍显示 |

### 性能取舍表

| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|------|
| Markdown 解析缓存 | 模块级 MRU Map，500 条上限 | 内存占用增加，实现复杂 | 虚拟滚动 remount 时不再重新解析，3ms → ~0 |
| Diff 渲染缓存 | WeakMap 两级缓存，每 patch 4 条上限 | 内存占用增加，实现复杂 | ctrl+o 切换时不再重新高亮，NAPI 调用 → ~0 |
| 流式稳定边界 | 只重渲染不稳定部分 | 实现复杂，可能闪烁 | 长文本流式更新时只重渲染最后几行 |
| 消息切片 | UUID 锚点，不 slice(-N) | 实现复杂，用户看不到更早的消息 | 长会话中不 remount 所有组件，避免 CC-941 |
| 自定义比较器 | areMessagePropsEqual 等跳过某些 props | 维护成本高，容易有 bug | 避免不必要的重渲染，性能提升显著 |
| OffscreenFreeze | 离屏消息冻结，不重渲染 | 实现复杂 | 滚动后旧消息不重渲染，减少 CPU 使用 |
| 预分割 gutter/content | 缓存时就 slice 好，渲染时用 RawAnsi | 内存占用增加 | 渲染时 Yoga 布局节点从 N 行降到 2 列 |

## 6. 现状验收标准

### 验收标准

1. **消息类型路由完整性**：
   - 给定任何有效的 Message 对象，Message 组件必须能路由到对应的子组件
   - TypeScript 编译必须通过，无 `@ts-expect-error` 或 `any` 绕过
   - 证据：`src/components/Message.tsx` 中的 switch 穷举

2. **流式更新性能**：
   - 给定 1000 条历史消息，在流式接收 1000 token 的文本时
   - 必须：每次 delta 的重渲染时间 < 16ms（60fps）
   - 且：历史消息不被重新解析（tokenCache 命中）
   - 不得：CPU 100% 超过 1 秒

3. **缓存有效性**：
   - 给定一个已渲染过的 diff
   - 当 ctrl+o 切换 transcript/prompt 再切换回来时
   - 必须：不重新调用 ColorDiff NAPI 模块（缓存命中）
   - 且：渲染结果与之前一致

4. **错误隔离**：
   - 给定一个会抛出异常的消息组件（如损坏的 diff）
   - 当渲染该消息时
   - 必须：该消息位置空白，但其他消息正常显示
   - 且：整个会话不崩溃

5. **Thinking 可见性控制**：
   - 给定 transcript 模式，hidePastThinking=true
   - 当有多轮 thinking 时
   - 必须：只显示最后一轮的最后一个 thinking block
   - 且：历史 thinking 不显示

6. **长会话切片稳定性**：
   - 给定 2000 条消息，已切片到从第 500 条开始
   - 当新增一条消息时
   - 必须：sliceAnchor 不前进（只要总数 ≤ 200 + 50）
   - 且：已有消息的 React key 不变，不 remount

## 7. 代码与测试证据

### 7.1 核心模块证据

| 设计陈述 | 源码证据 | 证据边界 |
|---------|---------|---------|
| 消息类型通过 switch-case 路由 | `src/components/Message.tsx:103-282` | 只覆盖 CLI 渲染，不包含桌面端 GUI |
| 流式 Markdown 使用稳定边界 | `src/components/Markdown.tsx:163-215` | 只处理文本，不处理图片或其他 media |
| Markdown token 有 LRU 缓存 | `src/components/Markdown.tsx:24-73` | 缓存容量固定为 500，不可配置 |
| Diff 渲染有 WeakMap 两级缓存 | `src/components/StructuredDiff.tsx:21-116` | 每 patch 最多缓存 4 个变体 |
| 长会话使用 UUID 锚点切片 | `src/components/Messages.tsx:344-393` | 只在非虚拟滚动路径启用 |
| SentryErrorBoundary 静默降级 | `src/components/SentryErrorBoundary.ts:11-28` | 只返回 null，不显示错误 UI |
| Thinking 块通过 lastThinkingBlockId 控制 | `src/components/Messages.tsx:454-481`, `src/components/Message.tsx:454-466` | 只在 transcript 模式隐藏历史 thinking |
| 自定义 memo 比较器优化重渲染 | `src/components/Message.tsx:500-525`, `src/components/MessageRow.tsx:307-355`, `src/components/Messages.tsx:1037-1094` | 比较器可能遗漏新 props |

### 7.2 测试覆盖

**无直接测试覆盖**，相关渲染功能可能在其他模块测试中间接验证。

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/ui-rendering.yaml)

### 8.1 本 spec 主拥有的文件

**核心渲染组件：**
- `src/components/Message.tsx`
- `src/components/Messages.tsx`
- `src/components/MessageRow.tsx`
- `src/components/VirtualMessageList.tsx`
- `src/components/OffscreenFreeze.tsx`

**消息类型组件：**
- `src/components/messages/AssistantTextMessage.tsx`
- `src/components/messages/AssistantToolUseMessage.tsx`
- `src/components/messages/AssistantThinkingMessage.tsx`
- `src/components/messages/AssistantRedactedThinkingMessage.tsx`
- `src/components/messages/AdvisorMessage.tsx`
- `src/components/messages/SystemTextMessage.tsx`
- `src/components/messages/UserTextMessage.tsx`
- `src/components/messages/UserToolResultMessage/`
- `src/components/messages/CollapsedReadSearchContent.tsx`
- `src/components/messages/GroupedToolUseContent.tsx`
- `src/components/messages/` 下其他文件

**文本与 Markdown：**
- `src/components/Markdown.tsx`
- `src/components/MarkdownTable.tsx`
- `src/utils/markdown.ts`

**Diff 与高亮：**
- `src/components/StructuredDiff.tsx`
- `src/components/StructuredDiff/`
- `src/components/HighlightedCode.tsx`
- `src/components/diff/`

**Spinner 与加载：**
- `src/components/Spinner.tsx`
- `src/components/Spinner/`
- `src/components/ToolUseLoader.tsx`

**错误边界：**
- `src/components/SentryErrorBoundary.ts`

**工具函数：**
- `src/utils/messages.ts`（与消息处理相关的部分）

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/components/permissions/` → permissions spec
- `src/components/mcp/` → mcp spec
- `src/components/plugins/` → plugins spec
- `src/utils/collapseReadSearch.ts` → context-compaction spec
- `src/tools/*/`（renderToolUseMessage/renderToolResultMessage 实现）→ 各工具 spec

## 9. 改进建议

### P1

#### 9.1.1 Markdown 错误边界包裹

**触发场景与证据：**
- 当前 Markdown.tsx 没有被 SentryErrorBoundary 包裹，如果 marked.lexer 或 formatToken 抛出异常，可能导致整个会话崩溃
- 证据：`src/components/Markdown.tsx` 没有错误边界包裹

**建议方向：**
- 在 Markdown.tsx 和 StreamingMarkdown.tsx 外层包裹 SentryErrorBoundary
- 出错时 fallback 到纯文本渲染（不解析 Markdown），而不是返回 null

**回归风险：**
- 低：只增加包裹，不改变正常路径

**验收方式：**
- 构造会导致 marked 崩溃的输入，验证只该消息降级为纯文本，其他正常

**工作量：**
- S（约 20 行代码）

**置信度：**
- 已证实（基于代码阅读）

#### 9.1.2 为模块级缓存添加重置机制，支持测试隔离

**触发场景与证据：**
- 当前 `tokenCache`（Markdown）和 `RENDER_CACHE`（StructuredDiff）是模块级变量，测试之间没有隔离机制
- 证据：`src/components/Markdown.tsx:26`、`src/components/StructuredDiff.tsx:21`

**建议方向：**
- 导出 `resetMarkdownTokenCache()` 和 `resetDiffRenderCache()` 函数，用于测试间清理状态
- 在测试套件的 `afterEach`/`beforeEach` 中调用这些重置函数，避免测试间污染

**回归风险：**
- 低：仅新增函数，不改变运行时行为

**验收方式：**
- 调用重置函数后，验证缓存已清空

**工作量：**
- S（约 10-20 行代码）

**置信度：**
- 设计推断

#### 9.1.3 缓存可配置化

**触发场景与证据：**
- 当前 tokenCache 上限固定为 500，Diff 缓存上限固定为 4，不可配置
- 在某些极端场景（如超大终端、大量 diff）可能不够用
- 证据：`src/components/Markdown.tsx:25` `TOKEN_CACHE_MAX = 500`；`src/components/StructuredDiff.tsx:113` `perHunk.size >= 4`

**建议方向：**
- 通过环境变量或设置配置缓存容量
- 或者根据终端大小、会话长度动态调整

**回归风险：**
- 低：默认值保持当前行为

**验收方式：**
- 设置 `CLAUDE_CODE_MARKDOWN_CACHE_MAX=1000`，验证缓存容量变大

**工作量：**
- M（约 50 行代码）

**置信度：**
- 设计推断（没有实际性能数据证明需要更大的缓存）

### P2

#### 9.2.1 增加渲染测试覆盖

**触发场景与证据：**
- 当前未找到专门针对 UI 渲染的测试文件（测试目录未详细阅读）
- 自定义比较器、缓存逻辑、流式更新等复杂逻辑没有测试覆盖，容易有回归

**建议方向：**
- 增加组件测试（使用 Ink Test Renderer 或类似库）
- 测试自定义比较器的正确性
- 测试缓存命中/未命中场景
- 测试流式更新的稳定边界

**回归风险：**
- 无（新增测试，不改变产品代码）

**验收方式：**
- 测试套件通过

**工作量：**
- L（约 200-500 行测试代码）

**置信度：**
- 设计推断（基于工程最佳实践）

#### 9.2.2 缓存重置机制

**触发场景与证据：**
- 当前模块级缓存没有重置机制
- 在某些测试场景可能需要重置（测试之间隔离）
- 在某些用户场景（如更换主题后想清空缓存）也可能有用

**建议方向：**
- 导出 `resetMarkdownCache()`、`resetDiffCache()` 函数
- 只在测试或开发模式下可用

**回归风险：**
- 低：默认不调用，不改变现有行为

**验收方式：**
- 调用重置函数，验证缓存清空

**工作量：**
- S（约 10 行代码）

**置信度：**
- 设计推断

### P3

#### 9.3.1 优化 lastThinkingBlockId 计算

**触发场景与证据：**
- 当前每次消息变化都要从后往前遍历计算 lastThinkingBlockId（O(n)）
- 在非 transcript 模式下这个计算是浪费的
- 证据：`src/components/Messages.tsx:454-481` 无条件计算

**建议方向：**
- 只在 hidePastThinking=true 时计算 lastThinkingBlockId
- 或者在状态中缓存，只有新增/更新 assistant 消息时才重新计算

**回归风险：**
- 低：逻辑更严格，不改变可见行为

**验收方式：**
- 非 transcript 模式下不计算，性能微提升

**工作量：**
- S（约 20 行代码）

**置信度：**
- 设计推断
