---
id: ink-platform
batch: 4
title: Ink Platform 终端渲染与原生边界设计
date: 2026-11-12
status: draft
---

# Ink Platform 终端渲染与原生边界设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理"、"提高可靠性"、"保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

### 具体问题场景

**场景 1：终端渲染效率与闪烁控制**
当终端宽度变化或屏幕滚动时，如果每帧都重写整个屏幕，会导致：
- 光标移动次数过多 → 终端渲染延迟
- 可见内容闪烁 → 用户体验差
- ANSI 序列传输量过大 → 非本地终端卡顿

如果没有增量 diff 机制，每次渲染都会写入 100% 的屏幕内容，即使 95% 没有变化。

**场景 2：Yoga 布局与终端字符网格的映射**
当使用 Flexbox 布局终端 UI 时，需要解决：
- Yoga 使用浮点数像素，终端使用整数字符
- 字符宽度不一致（CJK 宽字符占 2 列）
- 文本换行与布局测量的耦合

如果没有正确的测量和转换，会出现：文本截断、布局错位、滚动条位置错误。

**场景 3：输入事件解析与状态机**
终端输入是字节流（ESC [ 1 ; 32 A 等），需要解析为：
- 普通按键（a-z、0-9）
- 修饰键组合（Ctrl+C、Shift+Left）
- 特殊序列（Kitty 键盘协议、修改其他键）
- 粘贴事件（bracketed paste）
- 鼠标事件（SGR 或 X10 格式）
- 终端响应（DECRPM、DA1、XTVERSION）

如果没有正确的解析和状态机，会出现：按键识别错误、粘贴内容被拆分、鼠标事件遗漏。

**场景 4：全屏模式与普通模式的边界**
全屏模式（alt buffer）需要：
- 保存/恢复光标位置
- 管理终端私有模式（mouse tracking、kitty keyboard）
- 处理 SIGCONT（从后台恢复）
- 同步屏幕缓冲区（防止部分写入可见）

如果没有正确的模式管理，会出现：退出全屏后终端状态被破坏、鼠标跟踪泄漏到 shell、屏幕撕裂。

### 调用方与责任边界

调用方：
- `src/ink/ink.tsx`：Ink 类，管理整个渲染生命周期
- `src/ink/root.tsx`：createRoot 和 render，提供公开 API
- 各个 UI 组件（Box、Text、Ansi 等）：声明式 UI

责任边界：
- **Ink 平台**：React reconciler、Yoga 布局、屏幕缓冲区、终端写入、输入解析
- **UI 组件**：使用平台提供的 Box/Text 构建 UI
- **消息渲染**：由 ui-rendering spec 负责，本 spec 只提供底层原语

### 实际约束

性能与体验约束：
- 目标帧率：60fps（每帧 ≤16ms）
- 每帧 diff 只写入变化的行/单元格
- Yoga 布局计算尽量缓存（node cache）
- 样式池化（StylePool）避免重复 ANSI 序列
- 字符池化（CharPool）避免重复字符串

终端兼容性约束：
- 支持 Kitty 键盘协议（增强修饰键）
- 支持 modifyOtherKeys（xterm 风格）
- 支持 DEC 私有模式（alt buffer、mouse tracking）
- 支持 bracketed paste
- 支持 OSC 8 超链接
- 支持 SGR 鼠标（推荐）和 X10 鼠标（fallback）

平台约束：
- Node.js 环境（process.stdout/stderr）
- 需要 raw mode 处理输入
- Windows 与非 Windows 终端行为有差异
- 终端大小动态变化（SIGWINCH）

### 内部/外部差异

本系统在 CLI、SDK、离线/在线模式下行为一致。唯一差异：
- 桌面端可能有不同的 stdin/stdout 实现，但核心逻辑共享

## 2. 设计理由与备选方案

### 决策 1：React reconciler 用于声明式 UI + Yoga 用于终端布局

**实际机制：**
- 使用自定义 React reconciler（`reconciler.ts`），调用 `createNode`/`appendChildNode`/`setAttribute` 等构建 DOM
- DOM 节点关联 Yoga 布局节点（`dom.ts`）
- commit 后调用 `rootNode.onComputeLayout()` 计算布局
- 布局计算后调用 `rootNode.onRender()` 渲染到屏幕

**为什么这样设计：**
- React 的声明式模型非常适合 UI 构建（组件复用、状态驱动）
- Yoga 提供成熟的 Flexbox 实现，不需要自己写布局引擎
- 分离 reconciler、layout、paint 三层，职责清晰

**备选方案及不采用原因：**
- 方案 A：不使用 React，直接 imperative API → 被否决，组件复用困难
- 方案 B：不使用 Yoga，自己写布局 → 被否决，Flexbox 复杂，且 Yoga 已优化
- 方案 C：使用第三方 TUI 库（如 blessed）→ 被否决，定制化需求高

**代价：**
- 自定义 reconciler 实现复杂，需要理解 React 内部
- Yoga 是额外的 native 依赖（NAPI 模块）
- 三层架构增加了概念复杂度

**证据：**
- `src/ink/reconciler.ts` reconciler 实现
- `src/ink/dom.ts` DOM 与 Yoga 节点关联
- `src/ink/ink.tsx:203-224` onComputeLayout/onRender 调用

### 决策 2：双缓冲区 + 增量 diff 渲染

**实际机制：**
- `frontFrame` 和 `backFrame` 两个 Screen 缓冲区（`frame.ts`）
- 渲染时写入 `backFrame.screen`，然后交换
- `LogUpdate.render()` 比较 `prevFrame.screen` 和 `nextFrame.screen`，只输出变化
- diff 策略：行级比较，每行内只写变化的单元格
- 使用 `StylePool` 预计算 ANSI 序列转换，避免重复计算

**为什么这样设计：**
- 双缓冲避免部分渲染结果可见（类似图形学的双缓冲）
- 增量 diff 大大减少 ANSI 序列传输量（通常减少 90%+）
- 样式池化和字符池化减少内存分配和 GC 压力

**备选方案及不采用原因：**
- 方案 A：每帧重写整个屏幕 → 被否决，闪烁严重，传输量大
- 方案 B：单缓冲区，边计算边写 → 被否决，撕裂，用户看到中间状态
- 方案 C：不使用样式池，每次计算 ANSI → 被否决，CPU 占用高

**代价：**
- 内存占用翻倍（两个屏幕缓冲区）
- diff 逻辑复杂，需要处理宽字符、软换行、no-select 标记等
- Screen 数据结构优化复杂（TypedArray、packed 格式）

**证据：**
- `src/ink/ink.tsx:268-273` frontFrame/backFrame 初始化
- `src/ink/log-update.ts` LogUpdate 实现
- `src/ink/screen.ts` Screen 数据结构（TypedArray、packed word1）
- `src/ink/render-to-screen.ts` 逐单元格渲染与 blit 优化

### 决策 3：节点缓存（NodeCache）用于 blit 优化

**实际机制：**
- `nodeCache.ts` 维护 DOM 节点到已渲染 ScreenRegion 的映射
- 渲染节点时，先检查：
  1. 节点是否 dirty（需要重渲染）
  2. 位置是否变化（layout shifted）
  3. 是否有兄弟被移除（可能影响 blit）
- 如果可以 blit，直接调用 `blitRegion` 从 prevScreen 复制，不需要重新渲染
- 如果不能 blit，调用 `renderNodeToOutput` 重新渲染

**为什么这样设计：**
- 大部分帧中，大部分节点没有变化，blit 比重新渲染快得多
- blit 直接复制 TypedArray，没有布局、测量、文本处理开销
- dirty 标记确保只在需要时重渲染

**备选方案及不采用原因：**
- 方案 A：总是重新渲染 → 被否决，性能差（特别是静态 UI 多的时候）
- 方案 B：更激进的缓存（如按组件缓存）→ 被否决，复杂度高，收益不明显

**代价：**
- 实现复杂，需要跟踪 many 条件（dirty、layout shift、absolute removed 等）
- 节点缓存占用额外内存
- blit 失效条件容易遗漏（导致旧内容残留）

**证据：**
- `src/ink/node-cache.ts` NodeCache 实现
- `src/ink/render-node-to-output.ts:255-315` blit 检查逻辑
- `src/ink/optimizer.ts` 进一步优化 diff（合并移动）

### 决策 4：输入解析使用 tokenizer + 状态机

**实际机制：**
- `termio/tokenize.ts` 将字节流 token 化为 text 和 sequence
- `parse-keypress.ts` 解析 tokens，支持：
  - CSI u（Kitty 键盘协议）
  - modifyOtherKeys（xterm 风格）
  - SGR 鼠标事件
  - bracketed paste（状态机：NORMAL/IN_PASTE）
  - 终端响应（DECRPM、DA1、XTVERSION 等）
- `parseMultipleKeypresses` 处理不完整输入（保留 `incomplete`）

**为什么这样设计：**
- tokenizer 先分离 text 和 sequence，简化后续解析
- 状态机正确处理粘贴边界（sequence 和 text 混合在粘贴中）
- 分别处理多种键盘协议，兼容性好
- 支持不完整输入（网络延迟或 read 缓冲边界）

**备选方案及不采用原因：**
- 方案 A：直接 regex 整个输入 → 被否决，处理不了不完整输入，难以扩展
- 方案 B：只支持标准 ANSI，不支持增强协议 → 被否决，修饰键区分不够
- 方案 C：不使用状态机，直接解析 → 被否决，粘贴事件处理困难

**代价：**
- tokenizer 和 parser 代码复杂，需要理解各种终端协议
- 多种协议支持增加测试矩阵
- 状态机在边缘情况下可能有 bug（如粘贴中间包含 ESC 序列）

**证据：**
- `src/ink/termio/tokenize.ts` tokenizer 实现
- `src/ink/parse-keypress.ts` 解析器实现
- `src/ink/parse-keypress.ts:188-301` parseMultipleKeypresses 与状态机

### 决策 5：alt buffer 模式使用 BSU/ESU 同步写入

**实际机制：**
- 进入 alt buffer 时，保存光标、隐藏光标、设置私有模式
- 写入前发送 BSU（DEC 2026，Begin Synchronized Update）
- 写入后发送 ESU（End Synchronized Update）
- 如果终端不支持 DEC 2026，fallback 到无同步
- 退出时恢复所有状态（光标、模式、alt buffer）

**为什么这样设计：**
- BSU/ESU 确保屏幕更新是原子的，用户看不到中间状态
- 终端在 BSU 后会缓冲输出，ESU 后一次性显示
- 正确的进入/退出流程确保 shell 恢复正常

**备选方案及不采用原因：**
- 方案 A：不使用同步 → 被否决，屏幕撕裂，特别是长 diff 时
- 方案 B：总是 clear 再重写 → 被否决，闪烁严重
- 方案 C：使用 cursor save/restore 代替 BSU/ESU → 被否决，不是所有终端支持，且不是真正的原子

**代价：**
- 需要检测终端是否支持 DEC 2026（增加复杂度）
- 同步写入可能增加一点点延迟（缓冲等待）
- 退出时需要清理很多状态，容易遗漏

**证据：**
- `src/ink/terminal.ts:138-146` BSU/ESU 写入
- `src/ink/ink.tsx:400-406` alt screen 进入/退出
- `src/ink/ink.tsx:1695-1737` unmount 时的状态清理

### 决策 6：StylePool 编码样式 ID 与可见性标记

**实际机制：**
- `StylePool` 将 AnsiCode[] 编码为整数 id
- id 的 **bit 0** 编码该样式是否对空格可见（有 background、inverse、underline 等）
- diff 时，对不可见的样式变化可以跳过（减少写入）
- `transition(fromId, toId)` 预计算并缓存 ANSI 序列
- `withInverse()`, `withSelectionBg()`, `withCurrentMatch()` 缓存变体

**为什么这样设计：**
- bit 0 让可见性检查变成单位运算，极快
- 样式池化减少重复计算相同的 ANSI 序列
- 选择高亮、搜索高亮通过样式变体实现，不修改原始数据

**备选方案及不采用原因：**
- 方案 A：每次计算 ANSI 序列 → 被否决，CPU 占用高
- 方案 B：不编码可见性，总是比较所有位 → 被否决，diff 会写入更多（不可见的样式变化）
- 方案 C：字符串作为 key → 被否决，比较慢，内存占用高

**代价：**
- 实现复杂，需要理解 AnsiCode 和位操作
- 缓存需要正确失效（如 selection bg 变化时）
- 位编码有溢出风险（当前用 32 位，足够）

**证据：**
- `src/ink/screen.ts:112-260` StylePool 实现
- `src/ink/screen.ts:128-140` bit 0 编码可见性
- `src/ink/log-update.ts:204-209` 可见性检查跳过

### 决策 7：宽字符使用显式 SpacerTail/SpacerHead

**实际机制：**
- Screen 单元格宽度分三类：Narrow（0）、Wide（1）、SpacerTail（2）、SpacerHead（3）
- 写入宽字符时，自动在 x+1 位置写入 SpacerTail
- 渲染时跳过 SpacerTail（不输出）
- 软换行时如果宽字符在边界，使用 SpacerHead

**为什么这样设计：**
- 显式 Spacer 让数据结构自描述，不需要额外宽度表
- diff 时可以正确处理宽字符覆盖（不会遗漏清理 SpacerTail）
- 光标位置计算简单（x 直接加 1）

**备选方案及不采用原因：**
- 方案 A：每个单元格存宽度，但不写 Spacer → 被否决，diff 时容易出错（覆盖宽字符时忘记清除右边）
- 方案 B：单独的宽度数组 → 被否决，内存占用高，访问需要间接
- 方案 C：不支持宽字符 → 被否决，中文/日文/韩文/emoji 无法正确显示

**代价：**
- 写入宽字符时需要多写一个单元格
- 所有访问 x 的代码需要考虑 SpacerTail（不能越界）
- SpacerHead 处理复杂（只用于软换行边界）

**证据：**
- `src/ink/screen.ts:288-303` CellWidth enum
- `src/ink/screen.ts:692-809` setCellAt 处理宽字符与 SpacerTail
- `src/ink/log-update.ts:173-176` 跳过 SpacerTail

### 决策 8：滚动使用 DECSTBM + 区域移动

**实际机制：**
- 检测到纯滚动（一行插入顶部，其他行下移，或反过来）时，使用 DECSTBM（设置滚动区域）+ 插入/删除行
- 如果不是纯滚动，fallback 到完整 diff
- ScrollHint 由 render-node-to-output 检测并传递
- 滚动限制：只影响 alt screen，且是无修饰的纯文本行移动

**为什么这样设计：**
- DECSTBM + insert/delete line 是 O(1) 终端操作，比写入每一行快得多
- 终端硬件加速滚动（许多终端优化此路径）
- fallback 确保正确性（复杂滚动时仍然正确）

**备选方案及不采用原因：**
- 方案 A：总是完整 diff → 被否决，滚动时性能差（每行都要写）
- 方案 B：只使用光标移动，不使用 DECSTBM → 被否决，非滚动区域会被破坏

**代价：**
- 滚动检测逻辑复杂，需要识别纯滚动模式
- DECSTBM 不是所有终端都完全一致（特别是 tmux/screen）
- 同步写入（BSU/ESU）与 DECSTBM 交互需要小心

**证据：**
- `src/ink/render-node-to-output.ts:141-156` scrollHint 计算
- `src/ink/log-update.ts:406-518` 滚动优化检测与 DECSTBM 写入
- `src/ink/termio/csi.ts:174-194` DECSTBM、IL、DL 序列

### 决策 9：输入事件使用 Dispatcher 与 React 更新优先级

**实际机制：**
- `Dispatcher` 类维护 `currentEvent`、`currentUpdatePriority`
- 键盘事件调用 `dispatcher.dispatchDiscrete(target, event)`，设置优先级为 DiscreteEvent
- reconciler 的 `getCurrentUpdatePriority()` 读取 dispatcher 的优先级
- `scheduleRender` 使用 `requestAnimationFrame`（或 `queueMicrotask`）批处理更新

**为什么这样设计：**
- 离散事件（按键、点击）应该有高优先级，尽快响应
- React 19 的更新优先级系统可以优化调度
- 批处理避免每按键一帧（快速输入时合并渲染）

**备选方案及不采用原因：**
- 方案 A：每个按键同步渲染 → 被否决，快速输入时 CPU 占用高
- 方案 B：总是 setTimeout 0 延迟 → 被否决，响应慢，感觉不跟手
- 方案 C：不使用优先级，总是批处理 → 被否决，重要事件可能被延迟

**代价：**
- Dispatcher 需要正确集成到 reconciler（增加复杂度）
- 优先级语义需要理解（React 19 内部概念）
- 批处理窗口需要调优（太长延迟，太短 CPU 高）

**证据：**
- `src/ink/events/dispatcher.ts` Dispatcher 实现
- `src/ink/reconciler.ts:175-183` dispatcher 与 reconciler 集成
- `src/ink/ink.tsx:290-296` scheduleRender 使用 throttle + queueMicrotask

## 3. 目标与非目标

### 目标

**状态与生命周期：**
- 管理双屏幕缓冲区（front/back），正确交换
- 维护终端模式状态（alt buffer、mouse tracking、kitty keyboard 等）
- 管理输入解析状态机（bracketed paste、incomplete input）
- 维护样式池、字符池、超链接池（内存优化）

**接口与数据：**
- 提供 React 风格的公开 API（render、createRoot、unmount）
- 提供 Box、Text、Ansi、RawAnsi 等基础组件
- 提供 useInput、useFocus、useTerminalViewport 等 hooks
- 输出是增量 ANSI 序列，写入 stdout/stderr

**执行与环境：**
- 支持 alt buffer（全屏）和普通模式（滚动）
- 支持键盘、鼠标、粘贴输入
- 支持终端 resize（SIGWINCH）
- 支持 SIGCONT 恢复
- 目标 60fps 渲染性能

**依赖边界：**
- 本 spec 描述 Ink 平台底层，UI 组件使用由 ui-rendering spec 负责
- Yoga 布局引擎（native 依赖）
- react-reconciler（React 内部库）
- Node.js process.stdout/stderr/stdin

### 非目标

- 不实现 Web/桌面端 GUI（只负责 CLI Ink 渲染）
- 不负责消息渲染（只提供底层原语）
- 不重新实现终端模拟器（只输出 ANSI 序列）
- 不支持非 Node.js 环境（如浏览器、Deno）
- 不实现新的终端协议（只使用广泛支持的）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

**主要入口：**
```tsx
// src/ink/root.tsx
export async function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions
): Promise<Instance>;

export async function createRoot(
  options?: RenderOptions
): Promise<Root>;

// Root 接口
interface Root {
  render(node: ReactNode): void;
  unmount(): void;
  waitUntilExit(): Promise<void>;
}
```

**组件 API：**
```tsx
// 基础组件
<Box style={...} />
<Text style={...} textStyles={...} />
<Ansi ansi={...} />
<RawAnsi ansi={...} width={...} height={...} />
<Newline />
<Spacer />

// Hooks
useInput((input, key) => { /* ... */ });
useFocus();
useTerminalViewport();
useTheme();
useDeclaredCursor();
```

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|------|-----------|---------|------------|-----------------|
| ink.tsx | Ink 实例（frames、terminal、logUpdate、stylePool、charPool、hyperlinkPool、selection、altScreenActive 等） | 协调 reconciler、layout、paint、输入、终端模式 | 具体组件渲染 | 公开 API（render/createRoot），接收 ReactNode |
| reconciler.ts | React fiber 树、dispatcher | React 提交、DOM 节点创建/更新/删除 | 布局、渲染 | 调用 dom.ts 的 createNode/appendChildNode/setAttribute，调用 onComputeLayout/onRender |
| dom.ts | DOM 树（DOMNode/DOMElement/TextNode）、dirty 标记 | 节点创建、父子关系、属性/样式设置、dirty 跟踪 | React 协调、布局、渲染 | 供 reconciler 调用，提供 yogaNode 给 layout |
| node-cache.ts | nodeCache（DOMElement → ScreenRegion）、pendingClears | 缓存已渲染区域、提供 blit 决策 | 实际渲染 | render-node-to-output 查询是否可以 blit |
| layout/ | Yoga 节点树、布局结果 | createLayoutNode、计算布局、样式映射 | 渲染、React | dom.ts 调用，提供 getComputedLeft/Top/Width/Height |
| screen.ts | Screen 数据结构（cells、noSelect、softWrap）、StylePool、CharPool、HyperlinkPool | 创建屏幕、setCellAt、blitRegion、clearRegion、diffEach | React、布局 | renderer.ts 写入，log-update.ts 比较 |
| log-update.ts | lastOutput、cursor 位置 | 比较前后 Screen、生成 diff 补丁 | 渲染 | 接收 prev/next Frame，输出 Patch[] |
| terminal.ts | stdout/stderr 引用 | 写入 ANSI 序列、同步更新（BSU/ESU） | 屏幕缓冲区 | 接收 Patch[]，写入终端 |
| parse-keypress.ts | KeyParseState（mode、incomplete、pasteBuffer、_tokenizer） | 解析字节流为 ParsedInput | 事件分发 | 接收 Buffer/string，返回 ParsedInput[] |
| render-node-to-output.ts | layoutShifted、scrollHint、scrollDrainNode、followScroll | 渲染 DOM 节点到 Output、blit 优化、滚动检测 | 屏幕管理、终端写入 | 接收 DOMElement + Output + prevScreen，写入 Output |

**为什么状态放在这里：**
- Ink 实例是根，拥有全局状态（frames、pools、terminal）
- DOM 树是 reconciler 和 layout 之间的共享状态
- Screen 是渲染层的核心数据结构，双缓冲由 Ink 管理
- node cache 是渲染优化，放在 render-node-to-output 旁边

### 4.3 主控制流

**完整渲染流程（成功路径）：**
```
用户输入 / 状态变化
  ↓
React 触发更新（setState、useReducer 等）
  ↓
reconciler.ts: createContainer/updateContainer
  ↓
reconciler commit:
  ├─ createNode/appendChildNode/removeChildNode (dom.ts)
  ├─ setAttribute/setStyle/setTextStyles (dom.ts)
  └─ 标记节点 dirty
  ↓
resetAfterCommit:
  ├─ rootNode.onComputeLayout()
  │   └─ yogaNode.calculateLayout()
  │   └─ recordYogaMs()
  └─ rootNode.onRender()
      ↓
ink.tsx: onRender()
  ├─ flushInteractionTime()
  ├─ renderer(options) → next Frame
  │   └─ renderNodeToOutput(rootNode, output, prevScreen)
  │       ├─ 检查 node cache：是否可以 blit？
  │       ├─ 是：blitRegion
  │       └─ 否：renderNodeToOutput（递归子节点）
  ├─ 选择高亮：applySelectionOverlay
  ├─ 搜索高亮：applySearchHighlight
  ├─ 交换 buffers：frontFrame ↔ backFrame
  ├─ logUpdate.render(prevFrame, nextFrame) → Patch[]
  ├─ optimize(patches) → 优化后的 Patch[]
  └─ writeDiffToTerminal(terminal, patches)
      ├─ BSU（如果 alt screen 且支持）
      ├─ 写入所有补丁
      └─ ESU
```

**输入事件流程：**
```
终端输入字节流
  ↓
App.tsx: stdin 'readable' 事件
  ↓
parseMultipleKeypresses(prevState, chunk) → [ParsedInput[], newState]
  ├─ tokenizer.feed(chunk) → tokens
  ├─ 解析每个 token：
  │   ├─ PASTE_START → 进入 IN_PASTE 模式
  │   ├─ PASTE_END → 退出 IN_PASTE，发出 paste key
  │   ├─ sequence → 检查是否终端响应/鼠标事件/按键
  │   └─ text → 解析为按键
  └─ 返回 ParsedInput[]
  ↓
dispatchKeyboardEvent(parsedKey)
  ├─ dispatcher.dispatchDiscrete(focusManager.activeElement, event)
  ├─ 事件冒泡 DOM 树
  ├─ useInput handlers 调用
  └─ 如果 tab 且未 preventDefault，切换焦点
  ↓
React 更新 → 回到渲染流程
```

**Resize/SIGCONT 流程：**
```
SIGWINCH 或 SIGCONT
  ↓
ink.tsx: handleResize() 或 handleResume()
  ├─ handleResize:
  │   ├─ 更新 terminalColumns/terminalRows
  │   ├─ 如果 alt screen：resetFramesForAltScreen()，needsEraseBeforePaint = true
  │   └─ 重新渲染（render(currentNode)）
  └─ handleResume:
      ├─ 如果 alt screen：reenterAltScreen()（重新进入 + 清除 + 重绘）
      └─ 否则：resetFrames，logUpdate.reset()
  ↓
onComputeLayout() 使用新尺寸
  ↓
onRender() 写入新尺寸的屏幕
```

### 4.4 数据结构与持久化

**关键数据结构：**
```ts
// DOM 节点（dom.ts）
type DOMElement = {
  nodeName: ElementNames,
  style: Styles,
  attributes: Record<string, DOMNodeAttribute>,
  childNodes: DOMNode[],
  parentNode: DOMElement | undefined,
  yogaNode?: LayoutNode,
  dirty: boolean,
  isHidden?: boolean,
  textStyles?: TextStyles,
  _eventHandlers?: Record<string, unknown>,
  scrollTop?: number,
  scrollClampMin?: number,
  scrollClampMax?: number,
  // ... 更多 scroll 相关
};

// Screen（screen.ts）
type Screen = {
  width: number,
  height: number,
  cells: Int32Array,  // packed：word0=charId, word1=packed(styleId|hyperlinkId|width)
  cells64: BigInt64Array,  // same buffer，用于 bulk clear
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
  emptyStyleId: number,
  damage?: Rectangle,
  noSelect: Uint8Array,
  softWrap: Int32Array,
};

// Frame（frame.ts）
type Frame = {
  screen: Screen,
  viewport: Size,
  cursor: Cursor,
  scrollHint?: ScrollHint | null,
  scrollDrainPending?: boolean,
};

// ParsedInput（parse-keypress.ts）
type ParsedInput =
  | ParsedKey  // 普通按键
  | ParsedMouse  // 鼠标事件
  | ParsedResponse;  // 终端响应

// KeyParseState（parse-keypress.ts）
type KeyParseState = {
  mode: 'NORMAL' | 'IN_PASTE',
  incomplete: string,
  pasteBuffer: string,
  _tokenizer?: Tokenizer,
};
```

**持久化：**
- 所有状态都是内存级，不持久化到磁盘
- 退出时清理终端状态（禁用 mouse tracking、退出 alt buffer、显示光标等）
- CharPool/HyperlinkPool 定期重置（防止无限增长）

**恢复策略：**
- SIGCONT 时重置 frame buffers，重新完整渲染
- unmount 时清理所有终端状态
- 进程退出时通过 `onExit` 钩子自动 unmount

### 4.5 跨子系统依赖

| 上游/下游 | 接口 | 责任说明 | 归属 spec |
|----------|------|---------|----------|
| React | createContainer、updateContainerSync、flushSyncWork | React 协调 | 外部依赖 |
| Yoga | createLayoutNode、setWidth、calculateLayout、getComputedLeft/Top/Width/Height | Flexbox 布局 | 外部依赖（native） |
| ui-rendering | Box、Text、Ansi、useInput 等 UI 组件 | 构建消息 UI | ui-rendering |
| terminal | writeSync、setRawMode、SIGWINCH | 终端 I/O | 本 spec |
| parse-keypress | parseMultipleKeypresses | 输入解析 | 本 spec |

---

### 4.6 模块设计卡：Reconciler（React 协调器）

#### 真实入口签名与关键类型

```typescript
// src/ink/reconciler.ts
createReconciler<
  ElementNames,
  Props,
  DOMElement,
  DOMElement,
  TextNode,
  DOMElement,
  unknown,
  unknown,
  DOMElement,
  HostContext,
  null, // UpdatePayload - not used in React 19
  NodeJS.Timeout,
  -1,
  null
>(hostConfig)

// 核心类型
type HostContext = { isInsideText: boolean }
type DOMElement = {
  nodeName: ElementNames
  style: Styles
  attributes: Record<string, DOMNodeAttribute>
  childNodes: DOMNode[]
  yogaNode?: LayoutNode
  dirty: boolean
  isHidden?: boolean
  _eventHandlers?: Record<string, unknown>
  // ... scroll/debug 等
}

export const dispatcher: Dispatcher
export function getOwnerChain(fiber: unknown): string[]
export function isDebugRepaintsEnabled(): boolean
```

#### 输入输出

| 方向 | 内容 |
|------|------|
| 输入 | React 元素树（Box、Text 组件） |
| 输入 | Props 更新（style、children、事件处理器） |
| 输出 | DOM 节点（DOMElement/TextNode）创建/更新/删除 |
| 输出 | rootNode.onComputeLayout() 回调（布局触发） |
| 输出 | rootNode.onRender() 回调（渲染触发） |

#### 渲染与终端状态

- **宿主配置钩子**：createInstance/appendChild/setAttribute/commitUpdate 等
- **resetAfterCommit**：双阶段提交后调用，触发 Yoga 布局 + 终端渲染
- **DevTools 集成**：开发环境连接 React DevTools，失败仅记录警告
- **测试模式特殊处理**：onImmediateRender 而非 throttled onRender，避免 flaky tests

#### 完整 render/damage/output 流程

```
React setState →
  Fiber 树协调 →
    createInstance/appendChild/setAttribute (dom.ts) →
      标记节点 dirty →
    commitUpdate →
  resetAfterCommit →
    onComputeLayout() →
      Yoga.calculateLayout →
      recordYogaMs (perf) →
    onRender() →
      进入 ink.tsx 渲染管道
```

#### 错误恢复与性能

- **React DevTools 降级**：动态 import 失败不影响功能
- **isDebugRepaintsEnabled**：CLAUDE_CODE_DEBUG_REPAINTS 启用调试
- **commit instrumentation**：CLAUDE_CODE_COMMIT_LOG 记录提交统计（创建计数、差距等）
- **getOwnerChain**：从 fiber._debugOwner 提取组件栈，用于 repaint 归因

#### 设计取舍与备选

| 取舍 | 当前选择 | 备选 | 代价 |
|------|---------|------|------|
| Yoga 节点生命周期 | cleanupYogaNode 在 removeChild 时 freeRecursive | 延迟 free 或对象池 | 立即回收内存，但需要小心 use-after-free |
| 事件处理器存储 | 独立 _eventHandlers 而非 attributes | 混入 attributes | blit 优化不受 handler 身份变化影响 |
| 文本嵌套检查 | hostContext.isInsideText 阻止 Box 在 Text 内 | 静默虚拟化嵌套 | 提前捕获错误，避免布局异常 |

#### 源码测试证据

- **reconciler.ts:162-167**：getOwnerChain 使用 fiber._debugOwner
- **reconciler.ts:236-304**：resetAfterCommit 调用 onComputeLayout/onRender
- **reconciler.ts:33-46**：devtools 动态 import 带错误处理
- **reconciler.ts:180-212**：Yoga/Commit 性能打点

---

### 4.7 模块设计卡：Layout（Yoga 布局引擎）

#### 真实入口签名与关键类型

```typescript
// src/ink/layout/engine.ts
export function createLayoutNode(): LayoutNode

// src/ink/dom.ts
export const createNode = (nodeName: ElementNames): DOMElement
export function appendChildNode(node: DOMElement, childNode: DOMElement): void
export function insertBeforeNode(node: DOMElement, newChildNode: DOMNode, beforeChildNode: DOMNode): void

// 布局回调（ink.tsx 中设置）
rootNode.onComputeLayout = () => {
  const start = performance.now()
  rootYogaNode.calculateLayout(undefined, undefined)
  recordYogaMs(performance.now() - start)
}
```

#### 输入输出

| 方向 | 内容 |
|------|------|
| 输入 | style 属性（width、height、flexDirection、padding 等） |
| 输入 | TextNode 内容（用于 measureText） |
| 输出 | LayoutNode.getComputedLeft/Top/Width/Height |
| 输出 | layoutShifted 标志（render-node-to-output 设置） |

#### 渲染与终端状态

- **节点与 Yoga 关联**：DOMElement.yogaNode 存储 LayoutNode
- **测量函数**：TextNode 绑定 measureTextNode，RawAnsi 绑定 measureRawAnsiNode
- **虚拟节点**：ink-virtual-text、ink-link、ink-progress 无 Yoga 节点
- **插入索引计算**：DOM 索引 ≠ Yoga 索引，需要跳过无 YogaNode 的孩子

#### 完整 render/damage/output 流程

```
onComputeLayout →
  rootYogaNode.calculateLayout(availableWidth, availableHeight) →
    递归测量 Text 节点（measureText）→
    Flexbox 布局计算 →
  节点位置/大小写入 YogaNode →
  render-node-to-output 读取 →
    比较 nodeCache 中缓存的布局 →
    如有差异：设置 layoutShifted = true →
    禁用 blit，走完整渲染路径
```

#### 错误恢复与性能

- **尺寸钳制**：width/height 转为整数，非整数时向下取整（warn.ts）
- **Yoga 计数器**：native 模块暴露 getYogaCounters()，记录 visited/measured/hits
- **measureText 缓存**：stringWidth 内部有 cache，避免重复测量相同文本

#### 设计取舍与备选

| 取舍 | 当前选择 | 备选 | 代价 |
|------|---------|------|------|
| Yoga 作为 native 依赖 | NAPI 模块直接绑定 | pure JS Flexbox | 性能好，但加载失败时进程崩溃 |
| 字符网格对齐 | Yoga 返回像素 → 转为整数字符 | 保留小数但渲染时 floor | 简单，但有时文本会溢出 |
| 虚拟文本节点 | 无 YogaNode，不参与布局 | 0 大小 YogaNode | 节省 Yoga 资源，但插入索引计算复杂 |

#### 源码测试证据

- **dom.ts:111-129**：createNode 根据 nodeName 决定是否创建 YogaNode
- **dom.ts:174-180**：insertBeforeNode 计算正确的 Yoga 索引
- **ink.tsx:203-209**：onComputeLayout 打点 Yoga 耗时

---

### 4.8 模块设计卡：Paint（渲染节点到屏幕）

#### 真实入口签名与关键类型

```typescript
// src/ink/render-node-to-output.ts
export function resetLayoutShifted(): void
export function didLayoutShift(): boolean
export function resetScrollHint(): void
export function getScrollHint(): ScrollHint | null
export function resetScrollDrainNode(): void
export function getScrollDrainNode(): DOMElement | null
export function consumeFollowScroll(): FollowScroll | null

type ScrollHint = { top: number; bottom: number; delta: number }
type FollowScroll = { delta: number; viewportTop: number; viewportBottom: number }
```

#### 输入输出

| 方向 | 内容 |
|------|------|
| 输入 | DOMElement（带 Yoga 布局位置） |
| 输入 | prevScreen（用于 blit 决策） |
| 输出 | nextScreen（通过 Output 写入） |
| 输出 | layoutShifted、scrollHint、scrollDrainNode、followScroll |

#### 渲染与终端状态

- **三阶段渲染**：
  1. **布局检查**：比较 nodeCache，决定 blit 还是 full-render
  2. **内容渲染**：边框、文本、RawAnsi
  3. **绝对定位修复**：scroll 后修复 absolute 子节点
- **滚动限速**：drainAdaptive（xterm.js）、drainProportional（native）
- **Sticky Scroll**：内容增长时自动滚动到底部
- **Scroll Anchor**：scrollToElement 延迟读取位置直到 paint time

#### 完整 render/damage/output 流程

```
render-node-to-output(node, output, prevScreen) →
  1. 检查 nodeCache：
    - 节点 dirty？ → full-render
    - 位置/大小变化？ → layoutShifted = true，full-render
    - 有 pendingClears？ → clearRegion，full-render
  2. 可以 blit → blitRegion(prevScreen → nextScreen)，early return
  3. 不能 blit →
    - 渲染边框（renderBorder）
    - 渲染子节点（递归）
    - 处理滚动（drain pendingScrollDelta）
    - 检测纯滚动 → 设置 scrollHint
  4. 保存当前布局到 nodeCache
  5. 如有 follow scroll → 设置 followScroll
  6. 返回 nextScreen
```

#### 错误恢复与性能

- **xterm.js vs native 滚动**：检测 isXtermJsHost()，使用不同 drain 策略
  - xterm.js：SCROLL_STEP_MED/HIGH = 2/3，平滑动画
  - native：SCROLL_MIN_PER_FRAME = 4，3/4 比例 catch-up
- **滚动上限**：SCROLL_MAX_PENDING = 30，超出部分直接 snap
- **scrollClampMin/Max**：useVirtualScroll 设置，防止 race condition 出现空屏

#### 设计取舍与备选

| 取舍 | 当前选择 | 备选 | 代价 |
|------|---------|------|------|
| 滚动限速**：分帧 drain | 不是直接赋值 scrollTop | 单帧应用所有 delta | 快速 flick 有中间帧，但需要多帧才能 catch-up |
| scrollHint 纯滚动检测**：仅在无其他变化时启用 | 总是 diff | DECSTBM 极快，但检测逻辑复杂 |
| absoluteRemoved 标志**：禁用 blit 一整帧 | 追踪绝对节点的影响区域 | 简单但有时过度保守 |

#### 源码测试证据

- **render-node-to-output.ts:21-25**：isXtermJsHost() 检测
- **render-node-to-output.ts:106-157**：drainAdaptive/drainProportional 实现
- **render-node-to-output.ts:34-42**：layoutShifted 全局标志
- **render-node-to-output.ts:44-64**：scrollHint/absoluteRectsPrev/Cur
- **dom.ts:57-82**：scrollTop/pendingScrollDelta/scrollClampMin/Max/scrollAnchor

---

### 4.9 模块设计卡：终端输出与增量刷新（log-update）

#### 真实入口签名与关键类型

```typescript
// src/ink/log-update.ts
export class LogUpdate {
  constructor(options: { isTTY: boolean; stylePool: StylePool })
  render(
    prev: Frame,
    next: Frame,
    altScreen = false,
    decstbmSafe = true
  ): Diff
  renderPreviousOutput_DEPRECATED(prevFrame: Frame): Diff
  reset(): void
}

type Diff = Array<
  | { type: 'stdout'; content: string }
  | { type: 'clear'; count: number }
  | { type: 'clearTerminal'; reason: FlickerReason; debug?: unknown }
  | { type: 'cursorHide' | 'cursorShow' }
  | { type: 'cursorMove'; x: number; y: number }
  | { type: 'cursorTo'; col: number }
  | { type: 'carriageReturn' }
  | { type: 'hyperlink'; uri: string }
  | { type: 'styleStr'; str: string }
>
```

#### 输入输出

| 方向 | 内容 |
|------|------|
| 输入 | prevFrame（frontFrame）、nextFrame（backFrame） |
| 输入 | altScreen 标志、decstbmSafe 标志 |
| 输出 | Diff（补丁数组） |
| 输出 | 内部状态：previousOutput（用于 reset） |

#### 渲染与终端状态

- **VirtualScreen 游标跟踪**：仅使用相对移动，不知道绝对位置
- **Scrollback 检测**：prevHadScrollback 且内容变化 → full reset
- **ViewportY 计算**：跟踪 scrollback 中的行，不可访问时 reset
- **DECSTBM 优化**：有 scrollHint 且 decstbmSafe 时，用硬件 scroll 替代重绘
- **Spacer 跳过**：diff 时跳过 SpacerTail/SpacerHead

#### 完整 render/damage/output 流程

```
logUpdate.render(prev, next, altScreen, decstbmSafe) →
  1. 快速检查：
    - viewport 尺寸变化？ → fullResetSequence
    - nextFrame 有 scrollHint 且 decstbmSafe？ →
      shiftRows(prevScreen) → 生成 DECSTBM + SU/SD 补丁
  2. 检查 scrollback 行是否变化 →
    有变化且不可访问？ → fullResetSequence
  3. 创建 VirtualScreen（prev.cursor 位置）→
    处理 shrink（eraseLines）→
    diffEach(prevScreen, nextScreen) →
      逐单元格比较 →
        相等？跳过
        不等？moveCursorTo 位置，writeCell
  4. 处理 growth（renderFrameSlice 新行）→
  5. 恢复光标（altScreen 跳过，节省字节）→
  6. 返回 Diff 补丁数组
```

#### 错误恢复与性能

- **fullResetSequence_CAUSES_FLICKER**：作为最后手段，闪烁但正确
  - 触发原因：resize、scrollback 行变化、viewportY 越界、shrink→below
  - 记录原因（'resize'/'offscreen'）用于调试
- **damage 限制**：next.damage 存在时，仅扫描该区域
- **visibleCellAtIndex**：跳过 fg-only 样式变化的空格，避免无意义写入
- **慢渲染日志**：elapsed > 50ms 时，记录 damage 信息
- **性能取舍表**：见第5章

#### 设计取舍与备选

| 取舍 | 当前选择 | 备选 | 代价 |
|------|---------|------|------|
| 相对游标**：仅使用 cursorMove，不跟踪绝对位置 | 用 cursorTo 绝对定位 | 健壮，但需要知道起始位置 |
| DECSTBM 有条件启用**：decstbmSafe=false（如 tmux）时禁用 | 总是尝试 | tmux 中不原子，用户看到中间状态 |
| 跳过 Spacer**：diff 时不渲染 SpacerTail/Head | 总是写入 | 节省字节，但 Spacer 数据结构复杂 |
| altScreen 光标恢复**：跳过（cursor 隐藏） | 总是恢复 | 节省 ~10 字节/帧 |

#### 源码测试证据

- **log-update.ts:165-185**：DECSTBM 滚动优化
- **log-update.ts:189-248**：scrollback 检查 + full reset 触发
- **log-update.ts:250-467**：VirtualScreen + diff 主循环
- **log-update.ts:46-63**：reset() 用于 SIGCONT
- **log-update.ts:624-750**：writeCellWithStyleStr + emoji 宽度补偿

---

### 4.10 模块设计卡：键盘输入解析（parse-keypress）

#### 真实入口签名与关键类型

```typescript
// src/ink/parse-keypress.ts
export const INITIAL_STATE: KeyParseState
export function parseMultipleKeypresses(
  prevState: KeyParseState,
  input: Buffer | string | null = ''
): [ParsedInput[], KeyParseState]

export type ParsedInput = ParsedKey | ParsedMouse | ParsedResponse
export type ParsedKey = {
  kind: 'key'
  name?: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean
  super: boolean
  sequence?: string
  raw?: string
  isPasted: boolean
}
export type KeyParseState = {
  mode: 'NORMAL' | 'IN_PASTE'
  incomplete: string
  pasteBuffer: string
  _tokenizer?: Tokenizer
}
```

#### 输入输出

| 方向 | 内容 |
|------|------|
| 输入 | Buffer/string（终端字节流） |
| 输入 | null（flush 不完整序列） |
| 输出 | ParsedInput[]（keys/mouse/responses） |
| 输出 | KeyParseState（用于下一次调用） |

#### 渲染与终端状态

- **Tokenizer 分层**：先 tokenize 分离 text/sequence/paste-start/paste-end，再解析
- **粘贴模式状态机**：PASTE_START → IN_PASTE → PASTE_END，生成单个 PasteKey
- **多协议支持**：
  - CSI u（Kitty 键盘）：ESC [ codepoint [; modifier] u
  - modifyOtherKeys（xterm）：ESC [ 27; modifier; keycode ~
  - SGR Mouse：ESC [ < btn; col; row M/m
  - Terminal Responses：DECRPM、DA1、DA2、XTVERSION、CursorPosition

#### 完整 render/damage/output 流程

```
stdin 'readable' →
  read chunk →
  parseMultipleKeypresses(prevState, chunk) →
    1. tokenizer.feed(chunk) → tokens
    2. 遍历 tokens：
      - PASTE_START → mode=IN_PASTE
      - PASTE_END → createPasteKey(pasteBuffer)，mode=NORMAL
      - sequence →
        尝试 parseTerminalResponse → ParsedResponse
        或 parseMouseEvent → ParsedMouse
        或 parseKeypress → ParsedKey
      - text → parseKeypress
    3. 返回 [parsedInputs, newState]
  dispatchKeyboardEvent(parsedKey) →
    dispatcher.dispatchDiscrete(focusManager.activeElement, event) →
      事件冒泡 → useInput handlers → React 更新
```

#### 错误恢复与性能

- **不完整序列处理**：保存在 state.incomplete，下一 chunk 继续解析
- **孤儿鼠标序列修复**：text token 匹配 "\[<\d+;\d+;\d+[Mm]" → 重新合成 ESC 前缀
- **终端白名单**：supportsExtendedKeys() 仅在 iTerm/kitty/WezTerm/ghostty/tmux/wt 启用增强键
- **isXtermJs()**：XTVERSION 探测 + TERM_PROGRAM 检查，双保险

#### 设计取舍与备选

| 取舍 | 当前选择 | 备选 | 代价 |
|------|---------|------|------|
| Tokenizer + Parser 分层**：分离边界检测与语义解析 | 直接正则解析整个输入 | 清晰，但多一层抽象 |
| 粘贴单键**：整个粘贴作为一个 isPasted=true 的键 | 每个字符单独键 | 下游可区分粘贴与真实输入，但与单键 API 不同 |
| 增强键白名单**：不在白名单的终端不启用 | 总是启用 | 避免某些终端发出不可处理的序列 |

#### 源码测试证据

- **parse-keypress.ts:212-302**：parseMultipleKeypresses 主函数
- **parse-keypress.ts:66-81**：createPasteKey + 粘贴模式
- **parse-keypress.ts:12-64**：各种协议的正则匹配
- **parse-keypress.ts:610-805**：parseKeypress 分发逻辑
- **parse-keypress.ts:148-169**：EXTENDED_KEYS_TERMINALS 白名单

---

### 4.11 模块设计卡：Fullscreen/Scroll（Alt Buffer 与 DECSTBM）

#### 真实入口签名与关键类型

```typescript
// src/ink/terminal.ts
export function isSynchronizedOutputSupported(): boolean
export function writeDiffToTerminal(
  terminal: Terminal,
  diff: Diff,
  skipSyncMarkers = false
): void
export const SYNC_OUTPUT_SUPPORTED: boolean

// src/ink/ink.tsx
enterAlternateScreen() // 私有
exitAlternateScreen() // 私有
handleResume() // SIGCONT 处理

// src/ink/termio/csi.ts
setScrollRegion(top: number, bottom: number): string
scrollUp(n: number): string
scrollDown(n: number): string
```

#### 输入输出

| 方向 | 内容 |
|------|------|
| 输入 | enterAltScreen / exitAltScreen 调用 |
| 输入 | Frame.scrollHint（来自 render-node-to-output） |
| 输出 | BSU/ESU（同步更新标记） |
| 输出 | DECSTBM + SU/SD（滚动区域 + 上滚/下滚） |
| 输出 | 光标隐藏/显示、alt buffer 切换 |

#### 渲染与终端状态

- **Alt Buffer 状态**：ink.tsx 中 altScreenActive 标志，terminal.modes 跟踪
- **进入序列**：DECSET 1049（alt buffer）+ 1000（mouse）+ 1002（SGR mouse）+ 1003（any event）+ 隐藏光标
- **退出序列**：DECRST 1049 + 恢复光标 + 清理所有私有模式
- **SIGCONT 恢复**：重新进入 alt buffer + 完整重绘，防止后台状态损坏
- **同步输出**：BSU（开始）→ 所有补丁 → ESU（结束），tmux 跳过（已分块）

#### 完整 render/damage/output 流程

```
enterAlternateScreen →
  保存光标位置 →
  DECSET 1049（alt buffer）→
  启用 mouse tracking（1000/1002/1003）→
  隐藏光标 →
  设置 altScreenActive = true

onRender（altScreenActive）→
  1. 渲染生成 nextFrame →
  2. logUpdate.render(prev, next, altScreen=true, decstbmSafe=SYNC_OUTPUT_SUPPORTED) →
    有 scrollHint：生成 DECSTBM + SU/SD + shiftRows(prevScreen)
  3. writeDiffToTerminal(terminal, diff, skipSyncMarkers=!SYNC_OUTPUT_SUPPORTED) →
    开始：写入 BSU（如支持）→
    写入所有补丁 →
    结束：写入 ESU（如支持）

exitAlternateScreen →
  显示光标 →
  禁用 mouse tracking →
  DECRST 1049（返回 main buffer）→
  恢复光标位置 →
  设置 altScreenActive = false

SIGCONT →
  handleResume →
  altScreenActive？ → reenterAltScreen → resetFrames + 完整重绘
```

#### 错误恢复与性能

- **SIGCONT 完整重绘**：后台可能有其他程序修改终端，保守重置
- **decstbmSafe 检查**：tmux 不支持原子 DECSTBM+diff，有中间状态时禁用
- **SYNC_OUTPUT_SUPPORTED 模块级常量**：启动时检测一次，避免重复
- **DEC 2026 终端检测**：iTerm/WezTerm/Warp/ghostty/contour/vscode/kitty/foot/alacritty/Zed/WT/VTE ≥0.68

#### 设计取舍与备选

| 取舍 | 当前选择 | 备选 | 代价 |
|------|---------|------|------|
| DEC 2026 白名单**：仅在已知终端启用 BSU/ESU | 总是发送 | 节省字节，避免不兼容终端 |
| tmux 跳过**：skipSyncMarkers=true | 仍然发送 | tmux 已分块，同步无效 |
| SIGCONT 重置**：无条件完整重绘 | 尝试恢复状态 | 简单，防止后台损坏 |

#### 源码测试证据

- **terminal.ts:66-118**：isSynchronizedOutputSupported() 终端检测
- **terminal.ts:190-248**：writeDiffToTerminal BSU/ESU 包装
- **ink.tsx:400-406**：enterAlternateScreen 实现
- **ink.tsx:1695-1737**：exitAlternateScreen + unmount 清理
- **ink.tsx:1630-1646**：handleResume SIGCONT 恢复

---

### 4.12 模块设计卡：Native/CharPool（字符池与样式池）

#### 真实入口签名与关键类型

```typescript
// src/ink/screen.ts
export class CharPool {
  intern(char: string): number
  get(index: number): string
}

export class HyperlinkPool {
  intern(hyperlink: string | undefined): number
  get(id: number): string | undefined
}

export class StylePool {
  intern(styles: AnsiCode[]): number
  get(id: number): AnsiCode[]
  transition(fromId: number, toId: number): string
  withInverse(baseId: number): number
  withCurrentMatch(baseId: number): number
  withSelectionBg(baseId: number): number
  setSelectionBg(bg: AnsiCode | null): void
  readonly none: number
}

export function createScreen(
  width: number,
  height: number,
  styles: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool
): Screen
```

#### 输入输出

| 方向 | 内容 |
|------|------|
| 输入 | char/AnsiCode[]/hyperlink string |
| 输出 | id（整数） |
| 输出 | transition(fromId, toId) → ANSI string（缓存） |

#### 渲染与终端状态

- **CharPool ASCII 快速路径**：char.length === 1 且 code < 128 → this.ascii[code] 直接读取
- **StylePool bit 0 编码可见性**：有 background/inverse/underline → id 为奇数，diff 时快速检查
- **HyperlinkPool 0 = no hyperlink**：避免 undefined 特殊处理
- **Screen 单元格 packed 格式**：
  - word0：charId（Int32）
  - word1：styleId（高 15 位）| hyperlinkId（中 15 位）| width（低 2 位：0=Narrow，1=Wide，2=SpacerTail，3=SpacerHead）

#### 完整 render/damage/output 流程

```
创建 Screen（createScreen）→
  cells: Int32Array（size*2），cells64: BigInt64Array（同 buffer）→
  charPool/hyperlinkPool 共享（全局，跨帧复用）

渲染时写入（setCellAt）→
  charId = charPool.intern(char) →
  hyperlinkId = hyperlinkPool.intern(hyperlink) →
  word1 = (styleId << 17) | (hyperlinkId << 2) | width →
  写入 cells[index*2], cells[index*2+1] →
  更新 damage 矩形

Diff 时读取（diffEach）→
  直接比较 prev.cells[i] 与 next.cells[i]（整数比较，极快）→
  不相等？解包：
    char = charPool.get(word0)
    styleId = word1 >>> 17
    hyperlinkId = (word1 >>> 2) & 0x7fff
    width = word1 & 0x03
  生成写入补丁

Style 转换（stylePool.transition）→
  lookup cache：fromId * 0x100000 + toId → hit 直接返回
  miss：diffAnsiCodes(fromStyle, toStyle) → ansiCodesToString → 缓存 → 返回
```

#### 错误恢复与性能

- **CharPool 无上限但定期重置**：对话轮次间重新创建，防止无限增长
- **migrateScreenPools**：更换池时重新 intern 所有单元格
- **resetScreen 复用 TypedArray**：仅在需要更大时重新分配，BigInt64Array.fill 快速清空
- **diffSameWidth vs diffDifferentWidth**：同宽度时用 findNextDiff 快速跳过相等块

#### 设计取舍与备选

| 取舍 | 当前选择 | 备选 | 代价 |
|------|---------|------|------|
| CharPool ASCII 快速路径**：this.ascii[code] 数组 | 统一 Map | 常见单字符更快，但多一个分支 |
| StylePool bit 0 可见性**：id 奇偶编码 | 单独可见性数组 | 零内存开销，但需要位运算 |
| Screen Int32Array 打包**：word0+word1 | Cell 对象数组 | GC 压力极小，但代码可读性差 |
| 共享池跨帧**：charPool/hyperlinkPool 全局 | 每帧新池 | 避免重复 intern，但需要定期重置防止泄漏 |

#### 源码测试证据

- **screen.ts:22-54**：CharPool ASCII 快速路径
- **screen.ts:112-260**：StylePool intern/transition/withInverse/withSelectionBg
- **screen.ts:288-300**：CellWidth enum（Narrow/Wide/SpacerTail/SpacerHead）
- **screen.ts:366-544**：Screen packed 布局 + createScreen/resetScreen
- **screen.ts:1107-1263**：diffEach 主循环 + findNextDiff 快速路径

---

## 5. 失败语义与工程取舍

### 失败表

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|------------------|--------------|-------------|--------------|
| Yoga NAPI 模块不可用 | native-ts/yoga-layout/index.ts（隐式，import 时） | 抛出异常，向上传播 | 否 | 无（崩溃前） | 进程崩溃 |
| 终端 resize 到 0 宽度/高度 | ink.tsx: handleResize（静默 clamp），renderer.ts:52-81 | 静默 clamp 到有效范围，不抛异常 | 否 | 无特殊清理 | 创建 0x0 Screen，但不渲染（跳过），等待下次 resize |
| 屏幕缓冲区写入越界 | screen.ts: setCellAt 检查 x/y 是否在 0<=x<width && 0<=y<height | 静默跳过，不抛异常 | 否 | 无 | 该单元格不渲染 |
| 输入字节流包含不完整序列 | parse-keypress.ts: incomplete 字段 | 保留 incomplete 到下一 chunk | 是（等待更多输入） | 状态保存在 KeyParseState | 延迟解析，直到序列完整 |
| DECRPM 等终端响应超时 | App.tsx（未详细阅读） | 超时后 fallback 到默认行为 | 是（可能多次查询，但有限） | 无特殊清理 | 使用默认值（如"不支持"） |
| React DevTools 连接失败 | reconciler.ts:32-47 | catch 异常，logForDebugging，继续 | 否（不重试） | 无 | DevTools 不可用，但功能正常 |
| 外部程序接管终端（如编辑器） | ink.tsx: enterAlternateScreen/exitAlternateScreen | 暂停输入，保存状态 | 否（等待用户返回） | 挂起时清理 stdin 监听器，禁用 raw mode | 编辑器正常工作，返回后恢复 |
| process.stdout 不可写 | terminal.ts: write（隐式，Node.js 可能抛出） | 异常向上传播 | 否 | unmount 时清理终端状态 | 进程崩溃 |
| 绝对定位节点被删除，污染了 prevScreen | node-cache.ts: collectRemovedRects + ink.tsx: absoluteRemoved check | 设置 prevFrameContaminated = true，下一帧禁用 blit | 否（自动修复） | 记录 absolute removed | 下一帧完整重绘，无残留 |
| 样式池溢出（理论上） | screen.ts: StylePool（无显式检查，依赖 JS number 足够大） | 无检测（隐式依赖 JS number 范围） | 否 | 无 | 正常工作（JS number 足够大） |

### 性能取舍表

| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|------|
| 双缓冲区 | 两个 Screen，内存翻倍 | 内存占用高 | 无撕裂，增量 diff |
| 节点缓存 | DOMElement → ScreenRegion 映射 | 内存占用增加，实现复杂 | blit 优化，静态 UI 渲染极快 |
| 样式/字符/超链接池化 | 整数 id 代替字符串/数组 | 实现复杂 | 内存占用低，diff 比较快（整数 ==），ANSI 预计算 |
| Screen 使用 TypedArray + packed | 两个 Int32 每单元格 | 代码可读性差 | 内存占用低，GC 压力小，diff 快（整数比较） |
| 滚动优化使用 DECSTBM | 检测纯滚动，使用 insert/delete line | 检测逻辑复杂，终端兼容性风险 | 滚动时 O(1) 终端操作，极快 |
| BSU/ESU 同步写入 | 批量写入后一次性显示 | 兼容性检测复杂，可能增加一点延迟 | 无屏幕撕裂，用户体验好 |
| 渲染批处理使用 throttle + queueMicrotask | 每 16ms 最多一帧，且 layout effect 后渲染 | 响应延迟增加（最多 16ms） | CPU 占用低，避免过度渲染 |
| 宽字符显式 SpacerTail | 每个宽字符占两个单元格 | 内存占用增加，写入时多写一个 | diff 正确，光标位置简单 |

## 6. 现状验收标准

### 验收标准

1. **React 协调正确性：**
   - 给定任何有效的 React 树（Box/Text 组件）
   - 必须：正确创建 DOM 节点，设置属性/样式，管理父子关系
   - 且：dirty 标记正确，布局只在需要时重计算

2. **Yoga 布局正确性：**
   - 给定 Flexbox 样式
   - 必须：正确计算 left/top/width/height（整数字符单位）
   - 且：文本测量正确（考虑换行、宽字符）

3. **增量 diff 正确性：**
   - 给定前一帧和后一帧 Screen
   - 必须：只输出变化的部分
   - 且：结果与重写整个屏幕相同（肉眼不可区分）

4. **输入解析正确性：**
   - 给定各种终端输入（普通键、修饰键、Kitty 协议、modifyOtherKeys、粘贴、鼠标）
   - 必须：正确解析为 ParsedInput
   - 且：不完整输入正确保留到下一 chunk

5. **alt buffer 模式正确性：**
   - 给定进入/退出 alt buffer
   - 必须：正确保存/恢复终端状态
   - 且：退出后 shell 正常工作，无泄漏模式

6. **性能验收：**
   - 给定典型 UI（100 行，50% 变化）
   - 必须：每帧渲染时间 ≤16ms（60fps）
   - 且：ANSI 输出量 ≤ 变化量的 1.5x（无冗余）

7. **失败恢复：**
   - 给定 SIGCONT（后台恢复）
   - 必须：正确重绘屏幕，恢复终端模式
   - 且：用户不需要手动刷新

## 7. 代码与测试证据

### 7.1 核心模块证据

| 设计陈述 | 源码证据 | 证据边界 |
|---------|---------|---------|
| React reconciler 自定义集成 | `src/ink/reconciler.ts` | 只覆盖 React 19，可能需要更新适配未来 React |
| DOM 与 Yoga 节点关联 | `src/ink/dom.ts` | Yoga 是 native 依赖，在某些环境可能不可用 |
| 双缓冲区与增量 diff | `src/ink/ink.tsx:268-273`, `src/ink/log-update.ts` | diff 优化可能在某些终端序列组合下有 bug |
| 节点缓存与 blit 优化 | `src/ink/node-cache.ts`, `src/ink/render-node-to-output.ts:255-315` | blit 失效条件可能遗漏，导致旧内容残留 |
| 样式/字符/超链接池化 | `src/ink/screen.ts:112-260` | 池无上限，定期重置；CharPool ASCII fast-path 优化：`src/ink/screen.ts:29-73` |
| 输入解析与状态机 | `src/ink/parse-keypress.ts`, `src/ink/termio/tokenize.ts` | 不覆盖所有可能的终端协议，只覆盖常见的 |
| alt buffer 模式管理与 BSU/ESU | `src/ink/ink.tsx:400-406`, `src/ink/terminal.ts:138-146` | 不是所有终端支持 DEC 2026，fallback 到无同步 |
| 滚动优化与 DECSTBM | `src/ink/render-node-to-output.ts:141-156`, `src/ink/log-update.ts:406-518` | 只在纯滚动时启用，复杂滚动 fallback 到完整 diff |
| 宽字符与 SpacerTail | `src/ink/screen.ts:288-303`, `src/ink/screen.ts:692-809` | 只处理 Narrow/Wide/SpacerTail，SpacerHead 只用于软换行边界 |
| 事件分发与优先级 | `src/ink/events/dispatcher.ts`, `src/ink/reconciler.ts:175-183` | 只集成 DiscreteEvent 优先级，其他优先级未使用 |

### 7.2 测试覆盖

**测试文件：**
- `tests/inkDevtools.test.ts`：React DevTools 连接测试
- 其他 tests/ 下可能有更多（未详细阅读）

**测试覆盖边界：**
- DevTools 测试只覆盖开发环境，生产环境不连接
- 缺少性能测试（目标 60fps 未自动化验证）
- 缺少终端兼容性测试（只在部分终端手动验证）

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/ink-platform.yaml)

### 8.1 本 spec 主拥有的文件

**核心渲染与协调：**
- `src/ink/ink.tsx`
- `src/ink/reconciler.ts`
- `src/ink/dom.ts`
- `src/ink/root.tsx`

**布局与测量：**
- `src/ink/layout/engine.ts`
- `src/ink/layout/node.ts`
- `src/ink/layout/yoga.ts`
- `src/ink/measure-element.ts`
- `src/ink/measure-text.ts`
- `src/ink/wrap-text.ts`
- `src/ink/squash-text-nodes.ts`
- `src/ink/string-width.ts`

**屏幕与渲染：**
- `src/ink/screen.ts`
- `src/ink/renderer.ts`
- `src/ink/render-to-screen.ts`
- `src/ink/render-node-to-output.ts`
- `src/ink/render-border.ts`
- `src/ink/output.ts`
- `src/ink/log-update.ts`
- `src/ink/optimizer.ts`

**终端与输入：**
- `src/ink/terminal.ts`
- `src/ink/termio/`（所有文件）
- `src/ink/parse-keypress.ts`
- `src/ink/terminal-querier.ts`
- `src/ink/terminal-focus-state.ts`

**事件与焦点：**
- `src/ink/events/`（所有文件）
- `src/ink/focus.ts`
- `src/ink/hit-test.ts`

**滚动与选择：**
- `src/ink/selection.ts`
- `src/ink/searchHighlight.ts`
- `src/ink/cursor.ts`

**组件与 Hooks：**
- `src/ink/components/`（所有文件，注意：Box/Text 等基础组件属于本 spec，不是 ui-rendering）
- `src/ink/hooks/`（所有文件）
- `src/ink/Ansi.tsx`
- `src/ink/styles.ts`
- `src/ink/colorize.ts`
- `src/ink/wrapAnsi.ts`

**工具与状态：**
- `src/ink/node-cache.ts`
- `src/ink/frame.ts`
- `src/ink/constants.ts`
- `src/ink/instances.ts`
- `src/ink/devtools.ts`
- `src/ink/warn.ts`
- `src/ink/get-max-width.ts`
- `src/ink/tabstops.ts`
- `src/ink/clearTerminal.ts`
- `src/ink/supports-hyperlinks.ts`

**Native 绑定：**
- `src/native-ts/`（所有文件，特别是 yoga-layout）

**公开 API：**
- `src/ink.ts`

**测试：**
- `tests/inkDevtools.test.ts`

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/components/design-system/` → ui-rendering spec（ThemedBox/ThemedText 等是更高层）
- `src/components/` 下非 ink/ 的消息组件 → ui-rendering spec
- `src/utils/debug.ts` → 通用工具
- `src/utils/envUtils.ts` → 通用工具

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|--------|-------|-------|
| P0 | 当前 Yoga 是直接 import 的 native 模块，如果在某些环境加载失败，整个进程崩溃，证据：`src/native-ts/yoga-layout/index.ts`（直接 export * from './binding'） | 尝试动态 import，捕获异常；提供纯 JS 的 fallback 布局引擎（简化版，支持基本 Flexbox）；或者提供清晰的错误信息 + 退出码 | 中（需要修改 import 路径，可能影响现有工作环境） | 在没有 Yoga native 模块的环境运行，验证 fallback 正常工作（或清晰错误退出） | M | 已证实（基于代码阅读，native 模块加载确实无降级） |
| P0 | 当前 unmount 时清理终端状态，但如果 unmount 过程中抛出异常，可能部分清理未执行，证据：`src/ink/ink.tsx:1695-1737` unmount 中的清理是顺序执行，无 try/finally | 使用 try/finally 包裹清理代码，确保即使异常也执行；或者将清理拆分为多个独立函数，每个都在 finally 中调用 | 低（只增加错误处理，不改变正常路径） | 构造 unmount 中抛出异常的场景，验证终端状态仍然正确清理 | S | 已证实（基于代码阅读） |
| P2 | 当前无自动化性能测试，性能回归可能漏检；目标 60fps（每帧 ≤16ms）没有自动化验证 | 增加性能测试，测量典型场景的每帧时间；使用基准测试（benchmark）跟踪 Yoga 布局、diff、渲染各阶段耗时；在 CI 中运行性能回归检测（可选，因为 CI 环境性能不稳定） | 无（新增测试，不改变产品代码） | 性能测试套件通过，且典型场景 ≤16ms | L | 设计推断（基于工程最佳实践） |
| P3 | 当前每次 resetScreen 可能重新分配 TypedArray（如果尺寸变大），可以保留一个足够大的缓冲区，只在需要时 grow，绝不 shrink，证据：`src/ink/screen.ts:501-530` resetScreen 中的条件重新分配 | 保留历史最大尺寸，只 grow 不 shrink；或者使用单独的 "scratch" Screen 用于临时渲染 | 低（只改变内存管理策略，不改变渲染结果） | 渲染结果与之前一致，且内存分配次数减少 | M | 设计推断（基于性能优化最佳实践） |
| P2 | 当前支持 Kitty、modifyOtherKeys、SGR mouse，但还有其他可能有用的协议，如：true color 检测（已部分支持？）、sixel 图片（可选）、bracketed paste mode 之外的更多粘贴选项 | 检测并支持更多终端协议（优先级低，因为当前支持已足够）；或者提供插件机制让用户扩展 | 低（默认保持当前行为，只增加可选支持） | 在支持新协议的终端验证功能正常 | M | 设计推断（基于潜在用户需求） |
| P2 | 输入解析是复杂的状态机 + regex，容易有边缘 case bug，特别是不完整序列、混合 sequence/text、异常协议变体，证据：`src/ink/parse-keypress.ts` 代码复杂，regex 多 | 使用 fuzz testing 生成随机输入，验证解析器不崩溃，且状态机正确恢复；使用 coverage 引导 fuzz，覆盖所有分支 | 无（新增测试，不改变产品代码） | Fuzz 测试运行 N 分钟无崩溃 | M | 设计推断（基于安全最佳实践） |
| P3 | 部分模块代码复杂，但注释不足（如 log-update.ts、screen.ts packed 格式），新贡献者理解困难 | 增加更多代码注释，特别是复杂算法；绘制架构图（可选，作为 docs 补充） | 无（只增加注释，不改变代码） | 新贡献者能在 1 小时内理解核心流程 | M | 设计推断（基于可维护性最佳实践） |
