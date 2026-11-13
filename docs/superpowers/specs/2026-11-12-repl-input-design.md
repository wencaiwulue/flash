---
id: repl-input
batch: 4
title: REPL Input 输入、补全与键盘交互设计
date: 2026-11-12
status: draft
---

# REPL Input 输入、补全与键盘交互设计

## 1. 问题与约束

### 问题空间

Claude Code 终端界面需要提供高效、可学习的输入系统，处理多种冲突需求：
- 文本编辑与历史导航的按键冲突（↑ 是移动光标还是浏览历史）
- 补全菜单激活时的输入优先级问题
- Vim 模式与普通模式的共存
- 大段文本/图片粘贴对终端布局的干扰
- 模态对话框与正常输入的互斥

### 约束条件

1. **向后兼容**：保留用户已习惯的 Emacs 风格键绑定（Ctrl+A/E/K/W/U/Y）
2. **终端限制**：无法区分某些按键（如 macOS Option 与特殊字符）
3. **多模式共存**：Prompt 模式、Bash 模式、Vim 模式需无缝切换
4. **异步输入**：投机执行建议出现时，用户输入可随时中断

## 2. 设计理由与备选方案

### 键绑定优先级设计

**决策**：按 Context 分层解析，优先级 Autocomplete > Footer > Help > Chat > Global

| 备选方案 | 优点 | 缺点 | 最终选择理由 |
|---------|------|------|-------------|
| 单一 Context 管理 | 简单 | 扩展困难 | 分层更易扩展 |
| 硬编码 if-else 链 | 直接 | 难维护 | Context 模式更清晰 |
| 正则表达式匹配 | 灵活 | 性能差 | 分层解析更可控 |

### 多行输入的 ↑/↓ 行为

**决策**：检查 `isCursorOnFirstLine` / `isCursorOnLastLine`，仅在首/末行触发历史

| 备选方案 | 优点 | 缺点 | 最终选择理由 |
|---------|------|------|-------------|
| Alt+↑/↓ 专门导航历史 | 无歧义 | 需学习新快捷键 | 编辑体验优先于历史导航 |
| 始终用 ↑/↓ 导航历史 | 可预测 | 多行编辑困难 | 多行编辑是更常见需求 |
| 始终用 ↑/↓ 移动光标 | 简单 | 无法便捷访问历史 | 混合方案最优 |

### Vim 模式保留 Emacs Ctrl 键

**决策**：NORMAL/INSERT 模式下 Ctrl 组合键始终委托 `useTextInput`

**证据**：代码中 `if (key.ctrl) { textInput.onInput(input, key); return; }`

**备选方案对比**：
- 纯 Vim 模式：禁用所有 Emacs Ctrl 键 → 缺点：失去很多高效快捷键，增加学习曲线
- 当前选择：保留所有 Ctrl 键行为 → 理由：许多用户肌肉记忆依赖这些键，避免两种编辑范式的冲突

### 幽灵文本同步计算

**决策**：Prompt 模式 mid-input slash 补全用 `useMemo` 同步计算，避免闪烁

| 备选方案 | 优点 | 缺点 | 最终选择理由 |
|---------|------|------|-------------|
| 异步 setState | 不阻塞渲染 | 闪烁一帧 | 用户体验优先 |
| 禁用幽灵文本 | 简单 | 功能差 | 保留功能且同步计算足够快 |

**约束**：同步计算必须极快 (<1ms)，只用于简单的命令前缀匹配

### 粘贴大文本自动折叠为引用

**决策**：超过 `PASTE_THRESHOLD` 或 `maxLines` 时显示 `[Pasted Text n]`

| 备选方案 | 优点 | 缺点 | 最终选择理由 |
|---------|------|------|-------------|
| 始终全部显示 | 直接 | 终端布局混乱 | 保持界面整洁更重要 |
| 完全禁止粘贴长文本 | 简单 | 功能受限 | 可接受引用方式 |

**结果**：内容仍存在于 `pastedContents`，提交时可用；用户可编辑/删除引用标记

### 光标位置表示

**决策**：统一使用 UTF-16 code unit offset，`Cursor` 内部处理字形簇

| 备选方案 | 优点 | 缺点 | 最终选择理由 |
|---------|------|------|-------------|
| 字形簇索引 | Unicode 正确 | JS API 不兼容 | 与 string slice/length 一致 |
| 字节偏移 | 底层 | 编码问题多 | UTF-16 是 JS 原生 |

**Cursor 职责**：
- 将 offset → (line, column)（考虑换行、终端宽度）
- 计算显示宽度（`stringWidth` 处理 East Asian Width、emoji、combining marks）

### 撤销历史防抖合并

**决策**：`debounceMs: 1000` 合并快速输入

| 备选方案 | 优点 | 缺点 | 最终选择理由 |
|---------|------|------|-------------|
| 每次按键单独记录 | 精确撤销 | Ctrl+Z 体验差 | 短语级撤销更自然 |
| 空格/标点分割历史 | 语义化 | 中文等语言不友好 | 防抖通用 |

### Footer 导航独立于输入焦点

**决策**：选中 pill 时 `focus: false`，可打印字符自动清除选择

| 备选方案 | 优点 | 缺点 | 最终选择理由 |
|---------|------|------|-------------|
| 始终保持输入焦点 | 简单 | 导航与输入冲突 | 类型退出更便捷 |
| 完全分离模式切换 | 清晰 | 多一步操作 | 自动返回更好 |

### 状态集中存储

**决策**：模态 UI 状态存 `AppStateStore`，而非组件本地

| 备选方案 | 优点 | 缺点 | 最终选择理由 |
|---------|------|------|-------------|
| 组件本地状态 | 简单封装 | 组件通信困难 | 避免 prop drilling |
| Context 树传递 | React 标准 | 重渲染多 | 选择器精确更新 |

### 补全菜单优先级高于历史导航

**决策**：补全激活时，↑/↓ 只操作补全，不导航历史

| 备选方案 | 优点 | 缺点 | 最终选择理由 |
|---------|------|------|-------------|
| 历史始终优先 | 可预测 | 补全操作困难 | 补全是更即时交互 |
| 模式切换控制 | 清晰 | 多一步操作 | 上下文自动感知更好 |

## 3. 目标与非目标

### 目标

1. **高效编辑**：支持 Emacs/Vim 两种范式，满足不同用户群体
2. **可发现性**：合理默认行为，无需手册也能使用
3. **状态一致性**：光标、撤销、粘贴等状态变化可预测
4. **可扩展性**：新增键绑定上下文无需重构核心
5. **跨终端兼容**：处理不同终端/SSH 的转义序列差异

### 非目标

1. **不实现完整 IDE 编辑器**：仅满足 REPL 输入需求
2. **不支持无限撤销历史**：有合理缓冲区大小限制
3. **不解决所有终端兼容性问题**：接受某些终端限制
4. **不强制统一编辑范式**：Vim 与 Emacs 风格共存，不互相取代

## 4. 架构、模块与数据流

### 核心组件层次

```
PromptInput (主组件)
├── TextInput / VimTextInput (底层编辑器)
├── useTextInput (文本编辑逻辑)
├── useVimInput (Vim 模式扩展)
├── useTypeahead (自动补全)
├── useArrowKeyHistory / useHistorySearch (历史导航)
├── useKeybindings (键盘绑定框架)
└── useInputBuffer (撤销/重做缓冲)
```

---

## 模块设计卡

### 模块 1：键盘事件优先级系统

#### 真实入口签名

```typescript
// src/keybindings/resolver.ts
function resolveKeyWithChordState(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null
): ChordResolveResult;
```

#### 关键类型

```typescript
// 优先级顺序（数字越小优先级越高）
type KeybindingContextName = 
  'Autocomplete' | 'Footer' | 'Help' | 'Chat' | 'Global'
  // 额外 Contexts：Scroll、MessageActions、Settings、Confirmation 等

type ParsedBinding = {
  chord: ParsedKeystroke[];  // 支持多键和弦
  action: string | null;     // null = unbind
  context: KeybindingContextName;
};

type ChordResolveResult =
  | { type: 'match'; action: string }
  | { type: 'chord_started'; pending: ParsedKeystroke[] }
  | { type: 'chord_cancelled' }
  | { type: 'unbound' }
  | { type: 'none' };
```

#### 输入输出

| 输入 | 类型 | 描述 |
|------|------|------|
| input | string | 原始字符输入（如 '\x1b[A' 为上箭头）|
| key | Key | Ink 解析的键对象（含 ctrl/alt/meta/shift 标志）|
| activeContexts | KeybindingContextName[] | 当前激活的上下文数组 |
| bindings | ParsedBinding[] | 完整绑定集（默认+用户） |
| pending | ParsedKeystroke[] \| null | 待完成的和弦键序列 |

| 输出 | 类型 | 描述 |
|------|------|------|
| result | ChordResolveResult | 解析结果，含动作或和弦状态 |

#### 状态与上下文

**状态来源**：`KeybindingContextValue.activeContexts`（Set，非数组）

**Context 激活机制**：组件使用 `useRegisterKeybindingContext(name, isActive)` Hook 注册
- `useMemo` 根据 UI 状态计算激活条件
- 注册时添加到 `activeContexts` Set
- 卸载时自动移除

**优先级规则**：
1. 同一键在多个 Context 有绑定 → 激活的 Context 中最具体的优先
2. 和弦匹配优先于单键匹配（即使单键也有绑定）
3. 用户绑定覆盖默认绑定（同 Context 中后出现的 win）

#### 键盘到提交完整流程

```
用户按下键
    ↓
ink useInput 解析为 (input, key) 事件
    ↓
KeybindingResolver.resolveKeyWithChordState()
    ├─ 构建当前 ParsedKeystroke
    ├─ 如果有 pending chord → 先尝试完整匹配
    ├─ 否则检查是否能作为新 chord 前缀
    └─ 检查单键匹配
    ↓
如果有匹配动作 → invokeAction()
    ├─ action = 'autocomplete:accept' → acceptGhostText()
    ├─ action = 'chat:submit' → handleSubmit()
    ├─ action = 'history:previous' → historyUp()
    └─ action = 'footer:openSelected' → openFooterPill()
    ↓
如果无匹配且未停止传播 → TextInput 处理
    └─ useTextInput.onInput() → insert/delete/move
```

**提交流程详情**（PromptInput）：

```
chat:submit 触发
    ↓
检查 1：补全可见且非目录? → 是 → applySuggestion 不提交
    ↓ 否
检查 2：Footer pill 选中? → 是 → open 不提交
    ↓ 否
检查 3：viewSelectionMode? → 是 → 不提交
    ↓ 否
检查 4：prompt suggestion 可接受?
    ├─ 投机执行活跃 → 接受投机
    └─ 有幽灵文本 → applyGhostText()
    ↓
检查 5：@team DM? → sendDirectMessage()
    ↓ 否
检查 6：viewing agent? → onAgentSubmit()
    ↓ 否
正常提交：onSubmitProp(input)
    ├─ 清空输入
    ├─ 重置光标
    ├─ 添加到历史
    └─ 清空撤销缓冲区
```

#### 错误与竞态

| 场景 | 处理策略 | 理由 |
|------|----------|------|
| SSH 下 DEL 字符与 backspace 重复 | 检测 `\x7f` 存在，不插入文本，只执行回退 | 不同终端/SSH 客户端行为不一致 |
| 多 Context 同时激活 | Set 中顺序不影响，同一键只取一个匹配 | 按 Context 语义优先级设计 |
| 和弦序列中用户按其他键 | chord_cancelled，丢弃 pending | 避免用户困惑 |
| pendingChord React state 延迟 | 使用 pendingChordRef 立即访问，state 仅用于渲染 | React state 更新是异步的 |

**竞态示例**：补全异步更新时用户按 Enter
```
用户按 '/' → updateSuggestions() 启动异步查询
    ↓
用户按 Enter（查询还在进行）
    ↓
suggestions 仍为空 → Enter 正常提交
    ↓
稍后查询返回 → suggestions 更新但无影响
```

#### 设计取舍/备选

| 方案 | 优点 | 缺点 | 最终选择理由 |
|------|------|------|-------------|
| 单一全局事件总线 | 简单 | Context 优先级混乱 | 分层 Context 更清晰 |
| 硬编码 if-else 优先级链 | 直接 | 难扩展新 Context | Context 模式更易维护 |
| 正则表达式模式匹配 | 灵活 | 性能差、难调试 | 显式绑定更可预测 |
| 冒泡/捕获分层 | 符合 DOM 直觉 | 复杂度高 | 直接优先级检查更简单 |

#### 源码测试证据

**关键文件**：
- `src/keybindings/resolver.ts`：核心解析逻辑
- `src/keybindings/match.test.ts`：匹配测试
- `src/keybindings/KeybindingContext.tsx`：Context 管理

**测试覆盖**：
- ✓ 单键匹配
- ✓ 多键和弦匹配
- ✓ Context 优先级
- ✓ 用户覆盖默认绑定
- ✓ null 解绑

---

### 模块 2：文本状态与 Cursor 系统

#### 真实入口签名

```typescript
// src/utils/Cursor.ts
class Cursor {
  static fromText(
    text: string,
    columns: number,
    offset: number = 0,
    selection: number = 0
  ): Cursor;
  
  left(): Cursor;
  right(): Cursor;
  up(): Cursor;
  down(): Cursor;
  upLogicalLine(): Cursor;
  downLogicalLine(): Cursor;
  
  prevWord(): Cursor;
  nextWord(): Cursor;
  deleteWordBefore(): { cursor: Cursor; killed: string };
  
  startOfLine(): Cursor;
  endOfLine(): Cursor;
  startOfLogicalLine(): Cursor;
  endOfLogicalLine(): Cursor;
  
  deleteToLineStart(): { cursor: Cursor; killed: string };
  deleteToLineEnd(): { cursor: Cursor; killed: string };
  
  insert(text: string): Cursor;
  backspace(): Cursor;
  del(): Cursor;
  
  findCharacter(
    char: string,
    type: 'f' | 'F' | 't' | 'T',
    count: number = 1
  ): number | null;
  
  render(
    cursorChar: string,
    mask?: string,
    invert?: (text: string) => string,
    ghostText?: { text: string; dim: (text: string) => string },
    maxVisibleLines?: number
  ): string;
}
```

#### 关键类型

```typescript
// 内部 MeasuredText 类（延迟计算以避免不必要的开销）
class MeasuredText {
  text: string;  // 已 NFC 规范化
  columns: number;
  wrappedLines?: WrappedLine[];  // 懒计算
  graphemeBoundaries?: number[];
  wordBoundaries?: Array<{ start: number; end: number; isWordLike: boolean }>;
  navigationCache: Map<string, number>;  // 缓存计算结果
}

type WrappedLine = {
  text: string;
  startOffset: number;
  isPrecededByNewline: boolean;
  endsWithNewline: boolean;
};

// 全局杀环
const killRing: string[] = [];  // 最大 10 条
let killRingIndex: number = 0;
let lastActionWasKill: boolean = false;
let lastActionWasYank: boolean = false;
let lastYankStart: number = 0;
let lastYankLength: number = 0;
```

#### 输入输出

**主要数据流**：
```
输入字符串 → MeasuredText（NFC 规范化）
    ↓
Cursor 操作（不可变，返回新实例）
    ├─ Cursor.left() → 新 Cursor（offset-1）
    ├─ Cursor.insert("x") → 新 Cursor（text+="x", offset+1）
    └─ Cursor.deleteToLineEnd() → 新 Cursor + killed text
    ↓
render() → 带光标位置的显示字符串
```

**关键方法输入输出**：

| 方法 | 输入 | 输出 |
|------|------|------|
| `fromText()` | text, columns, offset | Cursor 实例 |
| `left()` | - | 新 Cursor（向左移动） |
| `insert(t)` | t: string | 新 Cursor（插入文本后） |
| `deleteToLineEnd()` | - | { cursor: Cursor, killed: string } |
| `render()` | cursorChar, mask, invert | 渲染后的字符串 |

#### 状态与上下文

**Cursor 内部状态**（全部只读）：
- `offset: number`：UTF-16 代码单元偏移（不是字形！）
- `selection: number`：选择长度（通常 0）
- `measuredText: MeasuredText`：文本+元数据（共享引用）

**全局共享状态**（杀环）：
- `killRing`：最近 10 次 kill 的文本
- `lastActionWasKill`：是否连续 kill（用于追加模式）
- `lastYankStart/length`：上次 yank 的位置（用于 Alt+Y 循环）

**Context 依赖**：
- `columns`：终端宽度（用于软换行计算）
- `stringWidth()`：East Asian Width 计算（CJK 字符宽度为 2）
- `Intl.Segmenter`：Unicode 字形/分词边界检测

#### 光标到渲染完整流程

```
用户输入 → useTextInput.onInput()
    ↓
Cursor.fromText(currentValue, columns, offset)
    ↓
执行编辑操作（如 insert/deleteToLineEnd）→ newCursor
    ↓
pushToKillRing(killedText, 'append'|'prepend')
    ↓
更新 React state：onChange(newCursor.text), setOffset(newCursor.offset)
    ↓
下次 render 时
    ├─ MeasuredText.getWrappedText() 计算软换行
    ├─ 找到光标所在行和显示列
    ├─ 插入光标字符（反转显示）
    └─ 附加幽灵文本（如果有）
```

**特殊处理**：
- 图像引用 `[Image #1]` 视为单个单位（左右移动直接跳过）
- `\x7f`（DEL）字符不插入文本，只触发退格
- 粘贴引用后光标跳到边界（避免编辑引用中间）

#### 错误与竞态

| 场景 | 处理策略 | 理由 |
|------|----------|------|
| offset 越界（> text.length）| 自动 clamp 到合法范围 | 容错设计 |
| 非规范化 Unicode（NFD vs NFC） | MeasuredText 自动规范化为 NFC | 避免显示/编辑不一致 |
| 终端宽度变化 | 重新计算软换行，但 offset 保持不变 | 保持用户编辑位置 |
| killRing 并发访问 | 全局变量无锁，假设单线程 | 单线程 React 环境安全 |
| 同一 offset 有多个 grapheme | snapToGraphemeBoundary() | 避免光标落在字形中间 |

**竞态示例**：快速输入时 undo 合并
```
用户快速输入 "hello"（5 次按键）
    ↓
每次 pushToBuffer 检测防抖时间窗口（1000ms）
    ├─ 第 1 次：立即 push，lastPushTime = T
    ├─ 第 2-5 次：防抖，只更新 pending
    ↓
1000ms 后，只 push 一条完整 "hello"
    ↓
Ctrl+Z 一次性撤销整个 "hello"
```

#### 设计取舍/备选

| 方案 | 优点 | 缺点 | 最终选择理由 |
|------|------|------|-------------|
| 字形索引（grapheme index） | Unicode 正确 | JS API 不兼容，需要转换 | UTF-16 offset 更符合 JS 字符串 |
| 字节偏移 | 底层高效 | 编码问题多，UTF-8 变长 | JS 原生 UTF-16 |
| 可变 Cursor 类 | 性能好 | 可预测性差，易出错 | 不可变更安全（React 友好） |
| 每次都重新计算换行 | 简单 | 渲染性能差 | lazy + 缓存策略 |
| 全局杀环 vs 每个输入实例 | 符合用户直觉 | 理论上状态泄露 | 实际用户体验优先 |

#### 源码测试证据

**关键文件**：
- `src/utils/Cursor.ts`：Cursor + MeasuredText 实现
- `src/utils/intl.ts`：字形/分词边界检测
- `src/utils/Cursor.test.ts`：完整测试套件

**测试覆盖**：
- ✓ 基本光标移动（左/右/上/下）
- ✓ 软换行处理
- ✓ 词移动（Intl.Segmenter）
- ✓ 杀/ Yank 环
- ✓ Vim f/t/F/T 查找
- ✓ 图像引用跳过

---

### 模块 3：历史导航与自动补全

#### 真实入口签名

```typescript
// src/hooks/useArrowKeyHistory.tsx
function useArrowKeyHistory(
  onSetInput: (
    value: string,
    mode: HistoryMode,
    pastedContents: Record<number, PastedContent>
  ) => void,
  currentInput: string,
  pastedContents: Record<number, PastedContent>,
  setCursorOffset?: (offset: number) => void,
  currentMode?: HistoryMode
): {
  historyIndex: number;
  setHistoryIndex: (index: number) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => boolean;
  resetHistory: () => void;
  dismissSearchHint: () => void;
};

// src/hooks/useTypeahead.tsx
function useTypeahead(props: Props): UseTypeaheadResult;

type Props = {
  onInputChange: (value: string) => void;
  onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => void;
  setCursorOffset: (offset: number) => void;
  input: string;
  cursorOffset: number;
  commands: Command[];
  mode: string;
  agents: AgentDefinition[];
  setSuggestionsState: (fn: (prev: SuggestionsState) => SuggestionsState) => void;
  suggestionsState: SuggestionsState;
  suppressSuggestions?: boolean;
  markAccepted: () => void;
  onModeChange?: (mode: PromptInputMode) => void;
};
```

#### 关键类型

```typescript
// 补全类型优先级（按检查顺序）
type SuggestionType =
  | 'none'
  | 'agent'         // @team member（最高）
  | 'slack-channel' // #channel
  | 'command'       // /slash command
  | 'directory'     // @path
  | 'file'          // @file 模糊搜索
  | 'shell'         // bash mode 补全
  | 'custom-title'; // /resume 历史

type SuggestionItem = {
  id: string;
  displayText: string;
  description?: string;
  metadata?: unknown;
};

// 历史加载状态（共享批处理）
let pendingLoad: Promise<HistoryEntry[]> | null = null;
let pendingLoadTarget: number = 0;
let pendingLoadModeFilter: HistoryMode | undefined = undefined;
```

#### 输入输出

**补全触发条件表**（按优先级）：

| 输入模式 | 检测内容 | 结果 | 优先级 |
|---------|---------|------|--------|
| prompt | mid-input `/` 不在开头 | 幽灵文本（useMemo 同步）| 1 |
| bash | 任何非空输入 | 历史幽灵文本（异步）| 2 |
| prompt | `^|\s@\w*$` | agent 菜单 | 3 |
| prompt | `#\w*$` + Slack MCP | channel 菜单 | 4 |
| prompt | `^/\w*` | command 菜单 | 5 |
| prompt | `@[\w./]*`（path-like）| directory 菜单 | 6 |
| prompt | `@` + 其他 | file 模糊搜索 | 7 |
| bash | 任何 | shell 补全 | 8 |

#### 状态与上下文

**useArrowKeyHistory 状态**：
- `historyIndex: number`：当前位置（0=草稿，1+=历史）
- `lastShownHistoryEntry`：临时保存的草稿（用户浏览历史前）
- `historyCache`：内存缓存（避免重复读盘）
- `historyIndexRef`：同步 ref（避免 React state 延迟导致的竞态）
- `initialModeFilterRef`：首次浏览时的模式（如 bash 只看 bash 历史）

**useTypeahead 状态**：
- `suggestions`：当前显示的建议列表
- `selectedSuggestion`：选中项索引
- `suggestionType`：当前类型（用于 UI 渲染）
- `inlineGhostText`：内联幽灵文本（同步/异步分别管理）
- `latestSearchTokenRef`：用于丢弃过期查询

**共享状态**：
- `pendingLoad`：批处理并发历史加载（多个快速 Up 共享同一查询）
- `latest*Ref`：用于取消/丢弃过期查询

#### 补全完整流程

```
用户输入变化 → useEffect 触发
    ↓
如果 dismissedForInputRef.current === input → 跳过（用户刚按 Esc）
    ↓
否则按优先级顺序检查：
    ├─ 1. prompt mode + mid-input slash → 幽灵文本（useMemo 同步）
    ├─ 2. bash mode → getShellHistoryCompletion()（异步）
    ├─ 3. @team member → agent suggestions
    ├─ 4. #channel + Slack MCP → channel suggestions
    ├─ 5. /slash command → command suggestions
    ├─ 6. @path-like → directory completion
    └─ 7. @file → fetchFileSuggestions()（防抖 50ms）
    ↓
如果有结果 → setSuggestionsState() + setSuggestionType()
    ↓
用户按 Tab/Enter → applySuggestion()
    ├─ 更新输入
    ├─ 移动光标
    ├─ 如果是 command Enter → 立即执行
    └─ 如果是 directory Tab → 继续显示子目录
```

**条件补全顺序细节**（useTypeahead.updateSuggestions）：
- 路径类 @ 优先用目录补全，不是模糊搜索
- `@~/`、`@./`、`@../` 触发目录补全
- 其他 @ 触发模糊搜索（包括 MCP 资源）
- Command 后有空格且无参数 → 显示 argumentHint，不是列表
- 目录补全接受后继续显示子项（不是自动提交）

#### 错误与竞态

| 场景 | 处理策略 | 理由 |
|------|----------|------|
| 快速 Up 键导致多个并发历史查询 | pendingLoad 共享 + target 计数 | 避免多次磁盘读 |
| 异步查询返回时输入已变 | latestSearchTokenRef 比较丢弃旧结果 | 避免显示过时建议 |
| 防抖期间用户取消（Esc）| dismissedForInputRef 记住当前 input | 避免立即重新弹出 |
| 文件索引在后台构建中 | 先返回部分结果，构建完成后重新查询 | 快速反馈优先 |
| Slack MCP 通道列表变化 | 订阅 + knownChannelsVersion 触发重新计算 | 保持新鲜度 |

**竞态示例**：快速输入 @abc 然后 @def
```
用户输入 @a → latestSearchTokenRef = "a"，启动查询 1
    ↓
用户继续输入 @ab → token="ab"，防抖，取消查询 1，启动查询 2
    ↓
用户继续输入 @abc → token="abc"，防抖，取消查询 2，启动查询 3
    ↓
用户输入 @def → token="def"，防抖，取消查询 3，启动查询 4
    ↓
50ms 后只有查询 4 执行，结果显示
```

#### 设计取舍/备选

| 方案 | 优点 | 缺点 | 最终选择理由 |
|------|------|------|-------------|
| 每次输入都查 | 简单直接 | 性能差，闪烁 | 防抖（50ms）平衡 |
| 用 React state 控制 pending | React 风格 | 有延迟，竞态 | ref 同步访问 |
| 单一补全类型 | 简单 | 功能受限 | 多类型优先级链 |
| 幽灵文本异步 setState | 简单 | 闪烁 | useMemo 同步（仅限 prompt slash） |
| 目录补全后自动关闭 | 简单 | 需要重新触发 | 继续显示子项更流畅 |

#### 源码测试证据

**关键文件**：
- `src/hooks/useArrowKeyHistory.tsx`：历史导航
- `src/hooks/useTypeahead.tsx`：补全核心（1800+ 行）
- `src/utils/suggestions/`：各类型补全实现
- `src/hooks/useTypeahead.test.tsx`：补全测试

**测试覆盖**：
- ✓ 历史浏览 Up/Down
- ✓ 草稿保存恢复
- ✓ 各补全类型触发
- ✓ 补全接受/取消
- ✓ 防抖查询
- ✓ 过期结果丢弃

---

### 模块 4：Vim 模式

#### 真实入口签名

```typescript
// src/hooks/useVimInput.tsx
function useVimInput(props: UseVimInputProps): VimInputState;

type UseVimInputProps = Omit<UseTextInputProps, 'inputFilter'> & {
  onModeChange?: (mode: VimMode) => void;
  onUndo?: () => void;
  inputFilter?: UseTextInputProps['inputFilter'];
};

type VimInputState = TextInputState & {
  mode: VimMode;  // 'INSERT' | 'NORMAL'
  setMode: (mode: VimMode) => void;
};

// Vim 状态机
type VimCommand =
  | { type: 'idle' }
  | { type: 'count'; value: number }
  | { type: 'operator'; operator: Operator; count?: number }
  | { type: 'operator_find'; operator: Operator; findType: 'f'|'F'|'t'|'T'; char: string; count?: number }
  | { type: 'replace'; count?: number }
  | { type: 'text_object'; operator: Operator; object: TextObject; count?: number };

function transition(
  command: VimCommand,
  input: string,
  ctx: TransitionContext
): { next?: VimCommand; execute?: () => void };
```

#### 关键类型

```typescript
// Vim 操作符
type Operator = 'd' | 'c' | 'y';

// Vim 动作
type Motion = 'h' | 'j' | 'k' | 'l' | 'w' | 'b' | 'e' | '0' | '$' | '^' | ...;

// Vim 文本对象
type TextObject = 'iw' | 'aw' | 'is' | 'as';

// TransitionContext（操作执行上下文）
type TransitionContext = {
  cursor: Cursor;
  text: string;
  setText: (text: string) => void;
  setOffset: (offset: number) => void;
  enterInsert: (offset?: number) => void;
  getRegister: () => string;
  setRegister: (text: string, linewise: boolean) => void;
  getLastFind: () => { type: 'f'|'F'|'t'|'T'; char: string } | null;
  setLastFind: (type: 'f'|'F'|'t'|'T', char: string) => void;
  recordChange: (change: RecordedChange) => void;
  onUndo?: () => void;
  onDotRepeat: () => void;
};

// Vim 持久状态（跨模式切换保留）
type PersistentState = {
  register: string;  // 无名寄存器
  registerIsLinewise: boolean;
  lastFind: { type: 'f'|'F'|'t'|'T'; char: string } | null;
  lastChange: RecordedChange;  // 用于 . 重复
};
```

#### 输入输出

**模式切换规则**：

| 从 | 到 | 触发 | 光标行为 |
|----|----|------|---------|
| INSERT | NORMAL | Esc | 左移一格（非行首、非零偏移） |
| NORMAL | INSERT | i/a/o/A/O/I | 移动到相应位置 |
| NORMAL | 提交 | Enter | 直接提交（保留在 NORMAL） |

**Vim 状态机流程**：

```
NORMAL mode，状态 idle
    ↓
用户按 'd' → transition('idle', 'd')
    ├─ next = { type: 'operator', operator: 'd' }
    └─ 不 execute
    ↓
状态变为 operator: 'd'
    ↓
用户按 'w' → transition({ operator: 'd' }, 'w')
    ├─ 无 next（回到 idle）
    └─ execute: delete word
```

#### 状态与上下文

**Vim 状态分层**：
1. **Vim 模式**：`vimMode`（React state，用于 UI 显示）
2. **VimCommand**：`vimStateRef.current.command`（NORMAL mode 状态机）
3. **持久状态**：`persistentRef.current`（寄存器、上次查找、上次操作）

**关键 Ref 使用**（避免 React 延迟）：
- `vimStateRef`：状态机立即读写
- `persistentRef`：寄存器/查找历史立即读写

**与 useTextInput 协作**：
- Vim 模式下 Ctrl 键**直接委托**给 useTextInput
- Vim 模式下 Enter 直接委托提交
- 箭头键在 idle 时委托（可触发历史导航）

#### 从按键到执行完整流程

```
用户在 NORMAL mode 按 'd'
    ↓
handleVimInput() 检测非 Ctrl/非 Esc/非 Enter
    ↓
调用 transition(state.command, 'd', ctx)
    ↓
transition 返回：
    ├─ next: { type: 'operator', operator: 'd' }
    └─ execute: undefined
    ↓
更新 vimStateRef.current
    ↓
状态等待动作或文本对象

用户继续按 'w'
    ↓
transition({ operator: 'd' }, 'w', ctx)
    ↓
返回：
    ├─ next: undefined（回到 idle）
    └─ execute: () => executeOperatorMotion('d', 'w', ctx)
    ↓
执行 execute()
    ├─ 计算范围（当前光标到下个词首）
    ├─ 删除文本
    ├─ 保存到寄存器
    ├─ recordChange({ type: 'operator', op: 'd', motion: 'w' })
    └─ 更新 text + offset
```

**. 重复实现**：
- 每次执行操作时调用 `recordChange(change)`
- 用户按 '.' 时调用 `replayLastChange()`
- replay 使用保存的 change 信息重建操作

#### 错误与竞态

| 场景 | 处理策略 | 理由 |
|------|----------|------|
| INSERT → NORMAL 光标左移边界 | 检查 offset>0 且前非换行 | Vim 标准行为 |
| 文本对象在文件边界 | clamp 到有效范围 | 避免崩溃 |
| 查找字符不存在 | 返回 null，不执行 | Vim 标准行为 |
| Vim 命令与 keybinding 冲突 | Ctrl 键优先委托给 useTextInput | 保留肌肉记忆 |
| inputFilter 状态跨模式 | 始终先应用 inputFilter 再决定是否继续 | 避免状态泄露（如粘贴后空格） |

**设计选择**：为什么 Ctrl 键始终委托？
- 用户可能习惯 Ctrl+A/Ctrl+E 等
- 避免两套编辑范式冲突
- 某些 Vim Ctrl 组合（如 Ctrl+F/Ctrl+B）不如终端滚动有用

#### 设计取舍/备选

| 方案 | 优点 | 缺点 | 最终选择理由 |
|------|------|------|-------------|
| 完整 Vim 模拟器 | 功能强大 | 复杂，维护成本高 | 仅常用子集（hjkl/wbe/dc/.） |
| 纯 Vim 模式（禁用 Ctrl 键）| 正宗 | 学习曲线陡，老用户不适应 | Ctrl 键保留 |
| 用 React state 存 VimCommand | React 风格 | 有渲染延迟 | ref 立即更新 |
| 每次都重建 Context | 简单 | GC 压力 | 按需创建 |
| 操作符状态嵌套 | 灵活 | 复杂 | 单层状态机足够 |

#### 源码测试证据

**关键文件**：
- `src/hooks/useVimInput.tsx`：Hook 包装
- `src/vim/transitions.ts`：状态机核心
- `src/vim/operators.ts`：操作符实现
- `src/vim/motions.ts`：动作实现
- `src/vim/text_objects.ts`：文本对象
- `src/vim/transitions.test.ts`：Vim 测试

**测试覆盖**：
- ✓ 模式切换 INSERT ↔ NORMAL
- ✓ 基本移动 hjkl/0/$/^
- ✓ 词移动 w/b/e
- ✓ 操作符 d/c/y
- ✓ 文本对象 iw/aw/is/as
- ✓ f/t/F/T 查找
- ✓ . 重复
- ✓ 数字前缀 3d2w

---

### 模块 5：Keybindings 自定义系统

#### 真实入口签名

```typescript
// src/keybindings/useKeybinding.tsx
function useKeybindings(
  bindings: Partial<Record<string, () => void>>,
  options?: {
    context?: KeybindingContextName;
    isActive?: boolean;
  }
): void;

function useKeybinding(
  action: string,
  handler: () => void,
  options?: {
    context?: KeybindingContextName;
    isActive?: boolean;
  }
): void;

// 用户绑定加载
function loadUserBindings(): KeybindingBlock[];
```

#### 关键类型

```typescript
// 保留快捷键（不可自定义）
const RESERVED_SHORTCUTS = [
  'ctrl+c',  // 中断
  'ctrl+d',  // 退出/删除
  'ctrl+z',  // 挂起
  'ctrl+s',  // 保存
  'ctrl+q',  // 退出
];

// 默认绑定配置
type KeybindingBlock = {
  context: KeybindingContextName;
  bindings: Record<string, string | null>;  // null = unbind
};

// 用户配置格式 (~/.claude/keybindings.json)
type UserBindingsConfig = {
  [context: string]: {
    [key: string]: string | null;
  };
};
```

#### 输入输出

**默认绑定分布**（按 Context）：

| Context | 绑定数 | 示例 |
|---------|--------|------|
| Global | 5+ | `ctrl+l`=app:redraw, `ctrl+r`=history:search |
| Chat | 10+ | `enter`=chat:submit, `up`=history:previous, `ctrl+_`=chat:undo |
| Autocomplete | 4 | `tab`=autocomplete:accept, `escape`=autocomplete:dismiss |
| Footer | 5+ | `up/down/left/right`=导航, `enter`=open, `escape`=clear |
| 其他 | ~30 | Settings/Confirmation/Select/Scroll/MessageActions 等 |

**绑定解析流程**：
```
启动时：
1. 加载 DEFAULT_BINDINGS（编译时常量）
2. 加载 loadUserBindings()（用户 ~/.claude/keybindings.json）
3. 合并（用户覆盖默认，同 Context 后出现的 win）
4. 解析为 ParsedBinding[]（验证保留快捷键）
```

#### 状态与上下文

**KeybindingProvider 状态**：
- `bindings`：合并后的 ParsedBinding[]
- `pendingChord`：当前待完成和弦
- `activeContexts`：当前激活 Context Set
- `handlerRegistry`：动作 → handlers[] 映射（多组件可注册同一 action）

**Context 激活注册**：
```typescript
// 组件内使用
useRegisterKeybindingContext('Autocomplete', suggestions.length > 0 || ghostText);
```
- Mount 时添加到 activeContexts
- Unmount 时移除
- isActive 变化时更新

**Handler 注册**：
```typescript
// 组件内使用
useKeybinding('autocomplete:accept', acceptSuggestion, {
  context: 'Autocomplete',
  isActive: suggestions.length > 0
});
```
- 注册到 handlerRegistry
- 触发时检查 context 是否 active

#### 绑定从配置到执行完整流程

```
用户按下键 → ink useInput
    ↓
ChordInterceptor 捕获，调用 resolveKeyWithChordState()
    ├─ 构建当前 keystroke
    ├─ 遍历 activeContexts 中的 bindings
    ├─ 尝试匹配（包括 pending chord）
    └─ 返回 result
    ↓
如果 match → invokeAction(action)
    ├─ 查找 handlerRegistry.get(action)
    ├─ 筛选 context 仍 active 的 handlers
    ├─ 调用第一个匹配的 handler
    └─ stopImmediatePropagation()
    ↓
如果 chord_started → setPendingChord()
    ↓
如果 none/unbound/chord_cancelled → 传播到 TextInput
```

**保留快捷键验证**：
- 加载用户绑定时检测是否覆盖 RESERVED_SHORTCUTS
- 如果是 → 忽略该绑定，显示警告通知
- 保留快捷键始终有效（硬编码在 useTextInput 中）

#### 错误与竞态

| 场景 | 处理策略 | 理由 |
|------|----------|------|
| 用户配置 JSON 无效 | try-catch，忽略，显示通知 | 容错 |
| 用户绑定保留快捷键 | 忽略，显示警告 | 关键功能不能破坏 |
| 同一 action 多 handler | 调用第一个（通常只有一个）| 简单可预测 |
| 和弦期间 Context 变化 | 和弦状态不绑定到 Context，完成时重新解析 | 避免复杂状态同步 |
| pendingChord React state 延迟 | pendingChordRef 立即读写 | 快速按键不丢失 |

**竞态示例**：和弦期间 Context 失效
```
用户按 Ctrl+X（开始 chord，Autocomplete 仍 active）
    ↓
用户按其他键使 Autocomplete 消失（Context 不再 active）
    ↓
用户按 Ctrl+S → 解析时检查 activeContexts，不匹配 Autocomplete
    ↓
chord_cancelled，Pending 清空
```

#### 设计取舍/备选

| 方案 | 优点 | 缺点 | 最终选择理由 |
|------|------|------|-------------|
| action 字符串标识 | 简单直接 | 可能拼写错误 | 有测试验证 |
| Context 名称枚举 | 类型安全 | 添加新 Context 需要修改 | 稳定性优先 |
| 用户覆盖全局生效 | 符合直觉 | 可能有冲突 | 同 Context 后覆盖前 |
| 和弦在 Context 外跟踪 | 简单 | Context 变化时行为可能意外 | 比绑定到 Context 简单 |
| 完全动态绑定（运行时更新）| 灵活 | 复杂度高 | 启动时加载一次足够 |

#### 源码测试证据

**关键文件**：
- `src/keybindings/defaultBindings.ts`：默认绑定（平台特定）
- `src/keybindings/parser.ts`：键字符串解析
- `src/keybindings/match.ts`：匹配逻辑
- `src/keybindings/loadUserBindings.ts`：用户配置加载
- `src/keybindings/parser.test.ts`：解析测试
- `src/keybindings/match.test.ts`：匹配测试

**测试覆盖**：
- ✓ 键字符串解析（ctrl+c, meta+x, ctrl+x ctrl+s）
- ✓ 修饰键匹配（alt=meta 等价）
- ✓ 用户绑定覆盖默认
- ✓ null 解绑
- ✓ 保留快捷键拒绝覆盖

---

### 模块 6：提交、粘贴与异步状态

#### 真实入口签名

```typescript
// 粘贴处理
// src/components/PromptInput/inputPaste.ts
function maybeTruncateMessageForInput(
  text: string,
  nextPasteId: number
): { truncatedText: string; placeholderContent: string };

function maybeTruncateInput(
  input: string,
  pastedContents: Record<number, PastedContent>
): { newInput: string; newPastedContents: Record<number, PastedContent> };

// 撤销缓冲
// src/hooks/useInputBuffer.ts
function useInputBuffer(props: UseInputBufferProps): UseInputBufferResult;

type UseInputBufferProps = {
  maxBufferSize: number;
  debounceMs: number;  // 1000ms
};

// 图像粘贴
// src/utils/imagePaste.ts
const PASTE_THRESHOLD = 10000;
function getImageFromClipboard(): Promise<{
  base64: string;
  mediaType: string;
  filename?: string;
  dimensions?: ImageDimensions;
  sourcePath?: string;
} | null>;
```

#### 关键类型

```typescript
// 粘贴内容存储
type PastedContent =
  | { id: number; type: 'text'; content: string }
  | { id: number; type: 'image'; base64: string; mediaType: string; filename?: string; dimensions?: ImageDimensions };

// 粘贴引用标记格式
type PastedTextRef = `[Pasted Text #${number}]`;
type PastedTextRefWithLines = `[Pasted Text #${number} +${number} lines]`;
type ImageRef = `[Image #${number}]`;
type TruncatedRef = `[...Truncated Text #${number} +${number} lines...]`;

// 撤销缓冲条目
type BufferEntry = {
  text: string;
  cursorOffset: number;
  pastedContents: Record<number, PastedContent>;
  timestamp: number;
};
```

#### 输入输出

**粘贴处理流程**：

| 输入 | 长度/内容 | 输出 |
|------|-----------|------|
| 短文本 | < PASTE_THRESHOLD | 直接插入 |
| 长文本 | ≥ PASTE_THRESHOLD | 插入 `[Pasted Text #N +X lines]`，内容存 pastedContents |
| 图像 | - | 插入 `[Image #N]`，存 base64 到 pastedContents |
| 已有截断引用继续粘贴 | - | 重用引用？不，总是新 ID |

**粘贴后自动空格**：
- 粘贴引用标记后（如 `[Image #1]`）
- `pendingSpaceAfterPillRef.current = true`
- 下一可打印字符输入时自动加空格（`[Image #1]hello` → `[Image #1] hello`）
- 任何其他输入（箭头/退格/换行）取消该状态

#### 状态与上下文

**PromptInput 粘贴相关状态**：
- `pastedContents: Record<number, PastedContent>`：粘贴内容库
- `nextPasteIdRef: number`：下一个粘贴 ID（懒初始化为消息中最大 ID+1）
- `pendingSpaceAfterPillRef: boolean`：是否需要自动加空格
- `isPasting: boolean`：粘贴中状态（用于动画？）

**撤销缓冲状态**（useInputBuffer）：
- `buffer: BufferEntry[]`：历史条目（max 100）
- `currentIndex: number`：当前位置（-1=最新，可后退）
- `pendingPush: Timeout | null`：防抖定时器
- `lastPushTime: number`：上次 push 时间戳

**异步状态管理**：
- `promptSuggestion`：投机建议状态（AppState）
- `speculation`：投机执行状态（AppState）
- `isLoading`：是否正在生成响应

#### 粘贴到提交完整流程

```
用户粘贴（剪贴板检测）
    ↓
getImageFromClipboard() 尝试（平台特定）
    ├─ macOS: AppKit NSPasteboard
    ├─ Windows: Win32 API
    └─ Linux: xclip/primary selection
    ↓
如果有图像 → create `[Image #N]` ref + store in pastedContents
    ↓
否则文本 → 检查长度
    ├─ <10000 → 直接插入
    └─ ≥10000 → 截断为 `[...Truncated #N +X lines...]` + 存
    ↓
如果是空输入 + 粘贴内容以 "!" 开头 → 自动切到 bash mode
    ↓
pendingSpaceAfterPillRef = true（如果插入了引用）
    ↓
用户编辑（可能删除引用、修改文本）
    ↓
用户提交
    ↓
解析输入中的所有 `[...#N...]` 引用
    ↓
从 pastedContents 取回真实内容
    ↓
构建完整消息（引用替换为真实内容）
    ↓
发送
```

**撤销防抖合并详细流程**：
```
用户输入字符
    ↓
pushToBuffer(text, offset, pastedContents)
    ↓
检查 now - lastPushTime < debounceMs（1000ms）
    ├─ 是 → clearTimeout(pendingPush) + setTimeout(pushDebounced)
    └─ 否 → 立即 push，lastPushTime = now
    ↓
防抖时间到 → pushDebounced()（只 push 最后状态）
    ↓
保存一条完整短语到 buffer，currentIndex 更新
    ↓
用户按 Ctrl+Z → undo() 返回 buffer[currentIndex-1]
```

#### 错误与竞态

| 场景 | 处理策略 | 理由 |
|------|----------|------|
| 粘贴剪贴板失败 | try-catch，显示通知，回退到文本 | 容错 |
| 粘贴超大文本（>100KB） | 截断，只保留开始和结束预览 | 避免终端混乱 |
| 用户删除粘贴引用但 pastedContents 未清理 | 正常，只是浪费内存（很少发生）| 简单优先 |
| 引用中间有光标 | 检测并 snap 到最近边界 | 避免编辑引用 |
| 快速输入撤销合并不精确 | 接受，短语级撤销更自然 | 体验优先完美 |
| 投机执行期间用户输入 | 立即 abortPromptSuggestion() + abortSpeculation() | 用户意图优先 |

**竞态示例**：投机建议期间用户输入
```
代理生成建议："帮我写个函数"
    ↓
建议显示为幽灵文本，用户可按 Tab 接受
    ↓
用户输入 "不，等等" → 立即 abort
    ├─ promptSuggestion 清空
    ├─ speculation abort（如果正在运行）
    └─ 用户输入正常处理
```

#### 设计取舍/备选

| 方案 | 优点 | 缺点 | 最终选择理由 |
|------|------|------|-------------|
| 粘贴直接展开 | 简单直接 | 大文本终端混乱 | 截断引用更好 |
| 每次按键单独撤销 | 精确撤销 | Ctrl+Z 体验差（按太多次）| 防抖合并更自然 |
| 空格延迟自动插入 | 简单 | 状态泄露风险 | inputFilter 安全处理 |
| 投机建议用户输入时不中断 | 可能节省时间 | 忽略用户意图 | 立即中断更尊重用户 |
| pastedContents 持久化到历史 | 方便 resume | 历史文件变大 | 已实现（HistoryEntry 包含） |

#### 源码测试证据

**关键文件**：
- `src/components/PromptInput/PromptInput.tsx`：粘贴/提交逻辑
- `src/components/PromptInput/inputPaste.ts`：截断逻辑
- `src/utils/imagePaste.ts`：图像粘贴（平台特定）
- `src/hooks/useInputBuffer.ts`：撤销缓冲
- `src/history.ts`：引用解析

**测试覆盖**：
- ✓ 短/长文本粘贴
- ✓ 粘贴引用检测替换
- ✓ 撤销防抖合并
- ✓ 多次 undo/redo
- ✓ 粘贴后自动空格

---

## 优先级与行为总表

### 键绑定 Context 优先级（从高到低）

| 优先级 | Context | 激活条件 | 占用按键 |
|--------|---------|---------|---------|
| 1 | Autocomplete | suggestions 可见 \|\| ghostText 存在 | Tab, Enter, Esc, 方向键, Ctrl+N/P |
| 2 | Footer | footerSelection != null | 方向键, Enter, Esc, x |
| 3 | Help | helpOpen | Esc |
| 4 | Chat | 默认（无其他时） | Enter, Up/Down, Ctrl+_, Ctrl+O, Ctrl+S 等 |
| 5 | Global | 总是 | Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+R 等 |

### Undo 防抖合并规则

| 时间间隔 | 行为 |
|---------|------|
| < 1000ms | 合并到同一缓冲条目 |
| ≥ 1000ms | 新建缓冲条目 |

**例外**：
- 删除/杀操作总是立即 push（不防抖）
- 粘贴操作总是立即 push

### 补全触发条件优先级

1. Prompt mode 中间 `/` → 幽灵文本（同步）
2. Bash mode 历史补全 → 幽灵文本（异步）
3. `@team` 成员 → agent 菜单
4. `#channel` + Slack MCP → channel 菜单
5. `/command` 开头 → command 菜单
6. `@path-like` → directory 菜单
7. `@file` → 模糊搜索菜单
8. Bash mode shell → shell 补全

### Vim 动作/操作符

| 类别 | 支持 | 不支持（设计） |
|------|------|---------------|
| 移动 | h/j/k/l, 0/$/^, w/b/e, gg/G | Ctrl+F/Ctrl+B（终端滚动用） |
| 操作符 | d/c/y | 其他 |
| 文本对象 | iw/aw/is/as | 更多（如 ip/it 等） |
| 查找 | f/t/F/T, ;/, |  |
| 重复 | . |  |
| 寄存器 | 无名寄存器 | 具名寄存器 "a-"z |

### 保留快捷键（不可自定义）

- `ctrl+c`：中断/双按退出
- `ctrl+d`：删除/空输入退出
- `ctrl+z`：挂起（终端行为）
- `ctrl+s`：保存（历史/暂存）
- `ctrl+q`：退出

### 图像粘贴快捷键（平台特定）

| 平台 | 快捷键 | 理由 |
|------|--------|------|
| macOS/Linux | `ctrl+v` | 标准粘贴 |
| Windows | `alt+v` | `ctrl+v` 是系统粘贴（终端处理） |

### 粘贴阈值

| 项目 | 阈值 | 超过时行为 |
|------|------|-----------|
| 文本长度 | 10000 字符 | 截断为 `[...Truncated #N +X lines...]` |
| 文本行数 | 不单独限制 | 嵌入到截断信息中显示 |
| 图像大小 | 无硬编码 | 由剪贴板限制 |

### 撤销缓冲区限制

| 项目 | 值 |
|------|-----|
| 最大条目数 | 100 |
| 防抖窗口 | 1000ms |
| 历史条目加载块大小 | 10 |

### 键盘事件优先级（快速参考）

```
最高优先级
    ↓
Modal Overlays（确认框/设置等）
    ↓
Autocomplete（补全菜单/幽灵文本）
    ↓
Footer（底部 pill 导航）
    ↓
Help（帮助菜单）
    ↓
Chat（聊天输入）
    ↓
Vim 模式处理（NORMAL/INSERT）
    ↓
TextInput（基础编辑）
    ↓
Global（全局快捷键）
最低优先级
```

### 提交流程决策树

```
Enter 键按下
    ↓
Autocomplete Context 激活？
    ├─ 是 → suggestions 可见？
    │   ├─ 是 → 是目录补全？
    │   │   ├─ 是 → 应用，不提交，继续显示子目录
    │   │   └─ 否 → 应用，不提交
    │   └─ 否 → ghostText 存在？
    │       ├─ 是 → 应用，不提交
    │       └─ 否 → 继续
    └─ 否 → 继续
    ↓
Footer pill 选中？
    ├─ 是 → 打开，不提交
    └─ 否 → 继续
    ↓
viewSelectionMode 中？
    ├─ 是 → 不提交
    └─ 否 → 继续
    ↓
Prompt suggestion 可接受？
    ├─ 投机执行活跃 → 接受投机，提交
    └─ 幽灵文本存在 → 应用，不提交
    ↓
@team DM？
    ├─ 是 → 发送，不进入主循环
    └─ 否 → 继续
    ↓
Viewing agent？
    ├─ 是 → onAgentSubmit()
    └─ 否 → onSubmitProp()
```

## 5. 失败语义与工程取舍

### 终端兼容性处理

| 场景 | 失败模式 | 降级策略 |
|-----|---------|---------|
| SSH 下 Backspace 发送 DEL | 同时收到键事件 + 原始字符 `\x7f` | 检测 `\x7f` 存在，不插入文本，只执行回退操作 |
| macOS Option 产生特殊字符 | 预期 Meta+F，实际输入 `ƒ` | 检测特殊字符，显示提示 "Use Option as Meta in Terminal settings"，仍将字符插入输入 |
| 不同终端 CSI 序列差异 | 功能键不识别 | Ink 层统一解析处理 |

### 粘贴处理边界

| 场景 | 处理策略 | 理由 |
|-----|---------|-----|
| 粘贴到空输入有 `!`/`bash` 前缀 | 自动切换模式 | 与键入行为一致 |
| 粘贴后立即输入可打印字符 | 自动插入空格 | 优化 `[Image n]hello` 体验 |
| 引用标签中间有光标 | 捕捉到最近端点 | 避免编辑标签中间 |
| 光标在引用开始处 | 反转显示整个引用 | 提供可视选择指示 |

### 投机执行交互

| 场景 | 处理策略 | 理由 |
|-----|---------|-----|
| 投机执行中用户输入 | 立即 `abortPromptSuggestion()` + `abortSpeculation()` | 用户意图优先 |
| 空输入按 Enter | 接受投机建议 | 加速常用场景 |
| 查看 agent 时 | 不显示建议 | 避免上下文混淆 |

### 工程取舍

| 取舍项 | 选择 | 代价 | 收益 |
|-------|------|------|------|
| 防抖合并撤销历史 | 1000ms 时间窗口 | 单次字符无法精确撤销 | 短语级撤销更自然 |
| 幽灵文本同步计算 | useMemo | 复杂补全需异步 | 避免闪烁一帧 |
| 状态集中管理 | AppStateStore | 选择器需谨慎设计 | 避免 prop drilling，支持时间旅行调试 |
| Vim 保留 Ctrl 键 | 始终委托底层 | 某些 Vim 组合无法实现 | 肌肉记忆兼容，避免两种编辑范式冲突 |

### 边界情况处理

1. **光标落在引用中间**：检测到 `cursorOffset` 在引用区间 → 捕捉到最近端点
2. **终端窄时文本换行**：Cursor 按 `columns` 正确计算软换行，`up/down` 在软换行行间移动
3. **Option 键产生特殊字符**：检测并显示提示，仍插入字符让用户知道问题
4. **SSH 下 Backspace 发送 DEL**：检测 `\x7f`，不插入文本，只执行回退
5. **投机执行中用户输入**：立即 abort，清除建议，不阻塞用户
6. **粘贴后立即输入字符**：`pendingSpaceAfterPillRef` 标志，`lazySpaceInputFilter` 自动加空格
7. **Viewing Agent 模式下提交**：`getActiveAgentForInput()` 检测，`onAgentSubmit()` 发送

## 6. 现状验收标准

### 输入编辑验收

1. **基本编辑**：
   - [ ] 光标左右移动正常
   - [ ] 删除/退格功能正常
   - [ ] 多行输入的上/下移动正确
   - [ ] 换行显示正确（终端宽度适应软换行）

2. **Emacs 键绑定**：
   - [ ] Ctrl+A → 行首
   - [ ] Ctrl+E → 行尾
   - [ ] Ctrl+K → 杀到行尾，可 yank
   - [ ] Ctrl+U → 杀到行首，可 yank
   - [ ] Ctrl+W → 杀前一词，可 yank
   - [ ] Ctrl+Y → yank
   - [ ] Meta+Y → yankPop（循环剪切环）

3. **撤销系统**：
   - [ ] Ctrl+_ 撤销上一次编辑
   - [ ] 快速输入合并成单次撤销
   - [ ] 提交后清空撤销历史

### Vim 模式验收

1. **模式切换**：
   - [ ] INSERT → NORMAL (Esc)
   - [ ] NORMAL → INSERT (i/a/o/A/O/I)
   - [ ] 退出 INSERT 时光标左移一格（非行首时）

2. **NORMAL 模式**：
   - [ ] h/j/k/l 移动
   - [ ] 箭头键也可移动
   - [ ] w/b/e 词级移动
   - [ ] 0/$ 行首行尾
   - [ ] d 操作符 + 动作/文本对象
   - [ ] c 操作符 + 动作/文本对象
   - [ ] y 操作符 + 动作/文本对象
   - [ ] p/P 粘贴
   - [ ] r 替换
   - [ ] g~ 切换大小写
   - [ ] . 重复上一次操作
   - [ ] 数字前缀计数

3. **共存行为**：
   - [ ] Ctrl 组合键仍可用（Emacs 风格）
   - [ ] Enter 可直接从 NORMAL 提交
   - [ ] 方向键在 idle 时可导航历史

### 历史导航验收

1. **箭头键历史**：
   - [ ] 首行按 ↑ 导航上一条历史
   - [ ] 末行按 ↓ 导航下一条历史
   - [ ] 非首/末行按 ↑/↓ 仅移动光标
   - [ ] 补全可见时 ↑/↓ 操作补全
   - [ ] 有可编辑队列命令时 ↑ 弹出编辑

2. **Ctrl+R 历史搜索**：
   - [ ] 增量搜索，实时高亮匹配
   - [ ] Enter 接受匹配，Esc 退出搜索

### 补全验收

1. **Slash 命令补全**：
   - [ ] / 开头显示命令列表
   - [ ] 实时过滤匹配
   - [ ] Tab 应用选中项
   - [ ] Enter 应用选中项并执行（除目录补全）

2. **路径补全**：
   - [ ] @~ 展开 home 目录
   - [ ] @./ 显示当前目录内容
   - [ ] 目录后自动继续显示子目录
   - [ ] Enter 不自动提交（继续编辑路径）

3. **@mention 补全**：
   - [ ] 空格后 @ 显示 agent/团队成员
   - [ ] Tab 应用带 @ 前缀

4. **幽灵文本显示**：
   - [ ] mid-input / 显示内联补全（如 "help me /co" 显示 "/commit"）
   - [ ] Tab 应用幽灵文本
   - [ ] 无闪烁

### 键绑定验收

1. **Context 优先级**：
   - [ ] 补全激活时，Autocomplete Context 绑定优先
   - [ ] Footer 选中时，Footer Context 绑定优先
   - [ ] Help 打开时，Help Context 绑定优先
   - [ ] 其余情况 Chat + Global Context

2. **用户自定义绑定**：
   - [ ] ~/.claude/keybindings.json 覆盖默认
   - [ ] 保留快捷键无法覆盖（Ctrl+C/D/Z/S/Q）

### 粘贴验收

1. **图片粘贴**：
   - [ ] 插入 `[Image n]` 引用标记
   - [ ] 粘贴后立即输入字符自动加空格
   - [ ] 光标在引用开始处反转高亮显示
   - [ ] 删除引用同时清理 `pastedContents`

2. **文本粘贴**：
   - [ ] 短文本直接插入
   - [ ] 长文本/多行折叠为 `[Pasted Text n]`
   - [ ] 清理 ANSI 转义序列
   - [ ] Tab 转换为空格
   - [ ] 空输入粘贴 `!`/`bash` 自动切换模式

### 提交流程验收

1. **正常提交**：
   - [ ] 发送到主循环
   - [ ] 清空输入
   - [ ] 重置光标到起始
   - [ ] 清空撤销历史

2. **Viewing Agent 提交**：
   - [ ] 路由到对应 agent
   - [ ] 不发送给 leader

3. **投机建议接受**：
   - [ ] 空输入 Enter 接受建议
   - [ ] 投机活跃时立即注入消息

4. **@team 直接消息**：
   - [ ] 发送成功不进入主循环
   - [ ] 显示发送成功通知

### Footer 导航验收

1. **导航操作**：
   - [ ] ↓ 选中第一个 pill
   - [ ] ←/→ 在 pill 间切换
   - [ ] Enter 打开选中 pill
   - [ ] Esc 取消选择
   - [ ] 可打印字符清除选择并插入输入

2. **Tasks 特有操作**：
   - [ ] ↑/↓ 在任务列表滚动
   - [ ] x 关闭选中任务
   - [ ] Enter 进入查看模式

## 7. 代码与测试证据

### Cursor 核心实现

**文件**：`src/utils/Cursor.ts`

Cursor 负责：
- Unicode 字形簇处理
- 终端列宽计算（East Asian Width、emoji、combining marks）
- 软换行支持
- 杀环管理

关键方法：
```typescript
Cursor.fromText(text, columns, offset)
cursor.left() / right() / up() / down()
cursor.insert(text)
cursor.deleteToLineEnd() → { cursor, killed }
cursor.render(cursorChar, mask)
cursor.getPosition() → { line, column }
cursor.getViewportStartLine(maxVisibleLines)
```

### 文本编辑核心

**文件**：`src/hooks/useTextInput.ts`

核心状态：
```typescript
{ offset, renderedValue, cursorLine, cursorColumn }
```

键处理分支：
- Ctrl 组合 → `handleCtrl`（映射到 Ctrl+A/E/K/W/U/Y 等）
- Meta 组合 → `handleMeta`
- 箭头 → `upOrHistoryUp` / `downOrHistoryDown`
- 普通字符 → 插入

关键代码片段：
```typescript
// 处理 SSH 下 DEL 字符
if (!key.backspace && !key.delete && input.includes('\x7f')) {
  // 应用多次回退操作，不插入字符
}
```

### Vim 模式集成

**文件**：`src/hooks/useVimInput.ts`

**设计证据**：
```typescript
function handleVimInput(rawInput: string, key: Key): void {
  if (key.ctrl) {
    textInput.onInput(input, key)
    return
  }
  if (key.return) {
    textInput.onInput(input, key)
    return
  }
  if (key.escape && state.mode === 'INSERT') {
    switchToNormalMode()
    return
  }
  if (state.mode === 'NORMAL') {
    const vimInput = key.leftArrow ? 'h' : ...
    const result = transition(state.command, vimInput, ctx)
    result.execute?.()
  }
}
```

### 补全系统

**文件**：`src/hooks/useTypeahead.tsx`

优先级顺序（在 `updateSuggestions` 中）：
1. prompt 模式 mid-input slash → 幽灵文本（useMemo 同步计算）
2. bash 模式历史补全 → 幽灵文本（异步）
3. @team member → agent 菜单
4. #slack-channel + Slack MCP → channel 菜单
5. /slash command → command 菜单
6. @path-like token → directory/file 菜单
7. @file 模糊搜索 → file/MCP 资源菜单
8. bash 模式 shell 补全 → shell 菜单

幽灵文本接受方式：
- Tab → `handleTab()` 检查 `effectiveGhostText` 并应用
- Right Arrow → 仅当 `input === ''` 且有 suggestion 时接受

### 键绑定框架

**文件**：
- `src/keybindings/types.ts`
- `src/keybindings/parser.ts`
- `src/keybindings/match.ts`
- `src/keybindings/resolver.ts`
- `src/keybindings/defaultBindings.ts`
- `src/keybindings/loadUserBindings.ts`
- `src/keybindings/useKeybindings.ts`
- `src/keybindings/KeybindingContext.tsx`

解析流程：
```
parseKey(input) → ParsedKey
    ↓
按优先级迭代 Contexts
    ↓
对于每个 Context: iterate bindings
    ↓
matchKey(parsedKey, binding.key)
    ↓
执行 handler，stopImmediatePropagation()
```

保留快捷键：
```typescript
const RESERVED = ['ctrl+c', 'ctrl+d', 'ctrl+z', 'ctrl+s', 'ctrl+q']
```

### 粘贴处理

**文件**：
- `src/components/PromptInput/PromptInput.tsx`
- `src/components/PromptInput/inputPaste.ts`
- `src/utils/imagePaste.ts`

关键状态：
```typescript
pendingSpaceAfterPillRef: boolean
pastedContents: Record<number, PastedContent>
nextPasteIdRef: number
```

延迟空格过滤器：
```typescript
lazySpaceInputFilter(input, key) → input'
```

### 测试覆盖

**关键测试文件**：
- `src/utils/Cursor.test.ts`
- `src/hooks/useTextInput.test.ts`
- `src/hooks/useTypeahead.test.tsx`
- `src/vim/transitions.test.ts`
- `src/keybindings/match.test.ts`
- `src/keybindings/parser.test.ts`

## 8. 文件覆盖与相关子系统

### 核心输入模块

| 组号 | 文件 | kind | section | summary |
|-----|------|------|---------|
| 1 | `src/components/PromptInput/PromptInput.tsx` | source | 4,7 | 主组件、协调整个系统，事件处理，提交逻辑 |
| 1 | `src/components/PromptInput/inputModes.ts` | source | 4 | 模式检测与转换（prompt/bash） |
| 1 | `src/components/PromptInput/inputPaste.ts` | source | 4 | 粘贴处理逻辑 |
| 2 | `src/components/TextInput.tsx` | source | 4 | 非 Vim 编辑器视图组件 |
| 2 | `src/components/VimTextInput.tsx` | source | 4 | Vim 编辑器视图组件 |
| 3 | `src/hooks/useTextInput.ts` | source | 4 | 文本编辑核心逻辑，杀环，撤销集成 |
| 3 | `src/hooks/useVimInput.ts` | source | 4 | Vim 模式集成，NORMAL/INSERT 切换，状态机 |
| 4 | `src/hooks/useTypeahead.tsx` | source | 4 | 自动补全，建议生成，幽灵文本 |
| 4 | `src/utils/suggestions/commandSuggestions.ts` | source | 4 | 命令生成、匹配、应用 |
| 4 | `src/utils/suggestions/directoryCompletion.ts` | source | 4 | 路径补全 |
| 4 | `src/utils/suggestions/slackChannelSuggestions.ts` | source | 4 | Slack 频道补全 |
| 4 | `src/utils/suggestions/shellHistoryCompletion.ts` | source | 4 | Bash 历史补全 |
| 4 | `src/hooks/fileSuggestions.ts` | source | 4 | 文件搜索与索引 |
| 4 | `src/hooks/unifiedSuggestions.ts` | source | 4 | 统一建议生成 |
| 5 | `src/hooks/useArrowKeyHistory.tsx` | source | 4 | 箭头键历史导航 |
| 5 | `src/hooks/useHistorySearch.ts` | source | 4 | Ctrl+R 历史搜索 |
| 6 | `src/hooks/useInputBuffer.ts` | source | 4 | 撤销缓冲，防抖合并 |
| 7 | `src/hooks/usePromptSuggestion.ts` | source | 4 | 提示建议显示，投机执行集成 |
| 8 | `src/keybindings/types.ts` | source | 4 | 类型定义（Action, Context, Keybinding） |
| 8 | `src/keybindings/parser.ts` | source | 4 | 键解析（转义序列、修饰键） |
| 8 | `src/keybindings/match.ts` | source | 4 | 绑定匹配（ParsedKey vs binding） |
| 8 | `src/keybindings/resolver.ts` | source | 4 | 绑定解析与合并（默认 + 用户自定义） |
| 8 | `src/keybindings/defaultBindings.ts` | source | 4 | 默认绑定定义 |
| 8 | `src/keybindings/loadUserBindings.ts` | source | 4 | 用户绑定加载（~/.claude/keybindings.json） |
| 8 | `src/keybindings/useKeybindings.ts` | source | 4 | useKeybindings Hook |
| 8 | `src/keybindings/KeybindingContext.tsx` | source | 4 | Context 管理，优先级注册 |
| 8 | `src/keybindings/reservedShortcuts.ts` | source | 4 | 保留快捷键列表 |
| 9 | `src/vim/types.ts` | source | 4 | Vim 状态类型 |
| 9 | `src/vim/transitions.ts` | source | 4 | 命令解析状态机 |
| 9 | `src/vim/operators.ts` | source | 4 | 操作符实现（d/c/y 等） |
| 9 | `src/vim/motions.ts` | source | 4 | 动作实现（h/j/k/l/w/b/e 等） |
| 9 | `src/vim/textObjects.ts` | source | 4 | 文本对象实现（iw/aw/is/ap 等） |
| 10 | `src/utils/Cursor.ts` | source | 4 | Cursor 核心类，文本编辑抽象 |
| 10 | `src/utils/intl.ts` | source | 4 | 字形簇处理，Unicode 宽度计算 |
| 11 | `src/ink/use-input.ts` | source | 4 | Ink 原始输入处理 |
| 11 | `src/ink/events/input-event.ts` | source | 4 | 输入事件类型 |
| 12 | `src/utils/Cursor.test.ts` | test | 7 | Cursor 行为测试 |
| 12 | `src/hooks/useTextInput.test.ts` | test | 7 | 文本编辑测试 |
| 12 | `src/hooks/useTypeahead.test.tsx` | test | 7 | 补全测试 |
| 12 | `src/vim/transitions.test.ts` | test | 7 | Vim 状态机测试 |
| 12 | `src/keybindings/match.test.ts` | test | 7 | 键匹配测试 |
| 12 | `src/keybindings/parser.test.ts` | test | 7 | 键解析测试 |

### Coverage 链接

完整覆盖率定义：[Coverage](../../architecture/coverage/repl-input.yaml)

## 9. 改进建议

### 短期改进

1. **补全模糊匹配增强**：当前命令前缀匹配，可考虑模糊匹配（如 `/dff` 匹配 `/diff`）
2. **撤销历史持久化**：会话间保留撤销历史
3. **更多 Vim 命令支持**：gg/G 跳转、/ 搜索、u 撤销等

### 中期改进

1. **可配置 Context 优先级**：允许用户自定义各 Context 的优先级
2. **更丰富的幽灵文本**：支持多种内联建议同时显示
3. **多光标支持**：高效多行编辑

### 长期探索

1. **智能模式切换**：根据输入内容自动检测意图，动态切换行为
2. **自适应键绑定学习**：观察用户习惯，推荐/优化快捷键，个性化绑定
3. **协作式编辑**：多人共享 REPL 时的编辑状态协调，同步输入

### 已知技术债务

1. **选择器精度优化**：AppState 选择器部分可能导致不必要重渲染，需进一步优化细粒度订阅
2. **Vim 状态机注释**：状态机部分注释不足，影响后续维护
3. **文件索引性能边界**：文件数量极大时，@file 补全可能有延迟（当前预加载索引缓解）
4. **测试覆盖补充**：Footer 导航与 Vim 模式的交互测试可进一步补充，增加更多边界场景
