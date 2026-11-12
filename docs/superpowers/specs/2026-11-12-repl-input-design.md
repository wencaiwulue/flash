---
id: repl-input
batch: 4
title: REPL Input 输入、补全与键盘交互设计
date: 2026-11-12
status: draft
---

# REPL Input 输入、补全与键盘交互设计

## 1. 概述

本文档描述 Claude Code 终端界面的核心输入系统设计，包括文本编辑、自动补全、历史导航、Vim 模式和键盘绑定优先级等关键机制。

### 核心组件

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

## 2. 键盘事件流与优先级

### 事件处理管道

键盘事件自下而上流经以下处理层：

```
终端原始输入
    ↓
ink useInput (原始键解析)
    ↓
TextInput / VimTextInput (基本编辑)
    ↓
KeybindingContexts (上下文按键绑定)
    │
    ├─ Autocomplete (优先级: 最高)
    ├─ Footer (底部导航)
    ├─ Chat (聊天模式)
    ├─ Global (全局命令)
    └─ Help (帮助菜单)
    ↓
PromptInput (顶层协调)
```

### 键绑定上下文优先级

每个上下文通过 `isActive` 条件判断是否激活，同一时间可能有多个上下文活跃，通过 `stopImmediatePropagation()` 实现互斥：

1. **Autocomplete** - 当补全菜单可见或有内联幽灵文本时激活
   - 处理：Tab、Enter、Esc、方向键、Ctrl+N/P
   - 优先级：最高，避免输入与补全冲突

2. **Footer** - 当底部 pill 被选中时激活
   - 处理：方向键导航、Enter 打开、Esc 取消、x 关闭

3. **Help** - 当帮助菜单打开时激活
   - 处理：Esc 关闭菜单

4. **Chat** - 正常聊天输入模式（默认激活）
   - 处理：提交、换行、撤销、外部编辑器、暂存、模型选择等

5. **Global** - 全局始终可用的快捷键
   - 处理：Ctrl+C 中断、快速打开、全局搜索、历史搜索等

### 事件处理示例流程

以 `↑` 键为例：

```
用户按 ↑
    ↓
isAutocompleteActive? → 是 → useTypeahead 处理 (选择上一个) → STOP
    ↓ 否
isFooterPillSelected? → 是 → Footer 处理 (导航上一个) → STOP
    ↓ 否
isCursorOnFirstLine? → 否 → TextInput 处理 (上移一行) → STOP
    ↓ 是
useArrowKeyHistory 处理 (上一条历史)
```

## 3. 文本状态管理

### 核心状态

```typescript
// PromptInput 级别
interface PromptInputState {
  input: string                    // 完整输入文本
  cursorOffset: number            // 光标位置 (UTF-16)
  mode: PromptInputMode           // prompt | bash | etc
  vimMode: VimMode                // INSERT | NORMAL (启用时)
  pastedContents: Record<number, PastedContent>  // 粘贴的图片/长文本
  stash: { text, cursorOffset, pastedContents }? // 暂存的输入
  isSearchingHistory: boolean     // 是否在历史搜索模式
}

// TextInput 级别 (useTextInput)
interface TextInputState {
  offset: number                  // 当前光标位置
  cursor: Cursor                  // 光标对象 (带测量的文本)
  renderedValue: string           // 渲染值 (含光标标记)
  cursorLine: number              // 可视区域中的行号
  cursorColumn: number            // 当前列
}
```

### Cursor 对象设计

`Cursor` 是文本编辑的核心抽象，处理 Unicode 字形簇、终端列宽、换行：

```typescript
class Cursor {
  static fromText(text: string, columns: number, offset: number): Cursor

  text: string                    // 完整文本
  columns: number                 // 终端宽度 (换行计算)
  offset: number                  // 当前位置

  // 基本移动
  left(): Cursor
  right(): Cursor
  up(): Cursor
  down(): Cursor

  // 词级移动
  prevWord(): Cursor
  nextWord(): Cursor

  // 行级操作
  startOfLine(): Cursor
  endOfLine(): Cursor
  deleteToLineEnd(): { cursor: Cursor; killed: string }
  deleteToLineStart(): { cursor: Cursor; killed: string }

  // 编辑操作
  insert(text: string): Cursor
  backspace(): Cursor
  delete(): Cursor
  deleteTokenBefore(): Cursor | null

  // 渲染
  render(cursorChar: string, mask?: string, ...): string

  // 位置测量
  getPosition(): { line: number; column: number }
  getViewportStartLine(maxVisibleLines?: number): number
  getViewportCharOffset(maxVisibleLines?: number): number
}
```

### 撤销/重做系统

使用 `useInputBuffer` 实现编辑历史缓冲：

```typescript
interface InputBufferState {
  buffer: Array<{ text: string; cursorOffset: number; pastedContents: Record<number, PastedContent> }>
  maxBufferSize: number
  currentIndex: number
  debounceMs: number  // 防抖合并快速输入
}

pushToBuffer(text, cursorOffset, pastedContents)  // 记录状态
undo(): { text, cursorOffset, pastedContents } | null  // 撤销
canUndo: boolean
clearBuffer(): void  // 提交后清空
```

**设计决策**：使用防抖合并快速连续输入，避免每次按键都创建历史记录。

### 剪切环 (Kill Ring)

Emacs 风格的剪切/粘贴系统：

```typescript
// utils/Cursor.ts
interface KillRing {
  ring: string[]
  index: number
  maxSize: number
}

let lastKill: string
let killAccumulation: 'append' | 'prepend' | null

pushToKillRing(text: string, mode: 'append' | 'prepend')
getLastKill(): string
recordYank(startOffset: number, length: number)
updateYankLength(newLength: number)
yankPop(): { text: string; start: number; length: number } | null
resetKillAccumulation()
resetYankState()
```

**绑定映射**：
- Ctrl+K: killToLineEnd → 追加
- Ctrl+U: killToLineStart → 前置
- Ctrl+W: killWordBefore → 前置
- Meta+Backspace: killWordBefore
- Meta+Delete: killToLineEnd
- Ctrl+Y: yank
- Meta+Y: yankPop (循环剪切环)

## 4. 历史导航与补全优先级

### 双模式上/下键行为

`↑` 和 `↓` 键有条件触发不同行为：

```
onUpKey():
  if AutocompleteActive:
    selectPreviousSuggestion()
  else if FooterSelected:
    navigateFooter(-1)
  else if CursorOnFirstLine AND SuggestionsCount ≤ 1:
    if hasEditableQueuedCommand:
      popAllEditable()
    else:
      navigateHistory(-1)  // 上一条历史
  else:
    moveCursorUp()  // 光标上移一行

onDownKey():
  if AutocompleteActive:
    selectNextSuggestion()
  else if FooterSelected:
    navigateFooter(1)
  else if CursorOnLastLine AND SuggestionsCount ≤ 1:
    if reachedBottomOfHistory:
      selectFirstFooterPill()
    else:
      navigateHistory(1)  // 下一条历史
  else:
    moveCursorDown()  // 光标下移一行
```

**设计决策**：只有当光标位于首行/末行且补全项 ≤ 1 时才触发历史导航，确保多行编辑体验优先。

### 历史搜索模式

两种历史交互方式：

1. **箭头键历史** (`useArrowKeyHistory`)
   - 逐次浏览，保留当前输入
   - 支持重置回到原始输入

2. **Ctrl+R 历史搜索** (`useHistorySearch`)
   - 增量搜索，实时高亮匹配
   - Enter 接受匹配，Esc 退出

## 5. Vim 模式与普通模式集成

### 模式切换

```
┌─────────────────────────────────────────────────────────┐
│  Vim 模式启用时                                          │
├─────────────────────────────────────────────────────────┤
│                                                        │
│  ┌──────────┐     Esc     ┌──────────┐              │
│  │  INSERT  │ ──────────→ │  NORMAL  │              │
│  └──────────┘ ←──────────┘ └──────────┘              │
│               i, a, etc                              │
│                                                        │
│  两种模式共享同一底层 TextInput 状态                     │
│  - INSERT: 委托 useTextInput 处理                      │
│  - NORMAL: Vim 转换层 + useTextInput                   │
│                                                        │
└─────────────────────────────────────────────────────────┘
```

### Vim 键处理流程

`useVimInput` 包装 `useTextInput`：

```typescript
// hooks/useVimInput.ts
function handleVimInput(rawInput: string, key: Key): void {
  // 1. 先应用 inputFilter (处理粘贴后空格等状态)
  const filtered = inputFilter ? inputFilter(rawInput, key) : rawInput

  // 2. Ctrl 键直接委托底层
  if (key.ctrl) {
    textInput.onInput(input, key)
    return
  }

  // 3. Esc 特殊处理 (INSERT→NORMAL 或取消待定命令)
  if (key.escape && state.mode === 'INSERT') {
    switchToNormalMode()
    return
  }

  // 4. Enter 始终委托 (允许从 NORMAL 提交)
  if (key.return) {
    textInput.onInput(input, key)
    return
  }

  if (state.mode === 'INSERT') {
    // 5. INSERT 模式: 跟踪插入文本用于 . 重复，委托底层
    textInput.onInput(input, key)
  } else if (state.mode === 'NORMAL') {
    // 6. NORMAL 模式: 箭头→hjkl 转换，状态机处理
    const vimInput = key.leftArrow ? 'h'
                   : key.rightArrow ? 'l'
                   : key.upArrow ? 'k'
                   : key.downArrow ? 'j'
                   : input

    const result = transition(state.command, vimInput, ctx)
    result.execute?.()
  }
}
```

### Vim 状态机

Vim 命令通过 `transition()` 函数解析，支持多步骤组合：

```typescript
// vim/transitions.ts
type VimCommand =
  | { type: 'idle' }
  | { type: 'count'; value: number }
  | { type: 'operator'; op: Operator }
  | { type: 'operatorCount'; op: Operator; count: number }
  | { type: 'operatorFind'; op: Operator; find: 'f' | 'F' | 't' | 'T'; char: string }
  | { type: 'replace' }
  | { type: 'find'; type: 'f' | 'F' | 't' | 'T'; char: string }

transition(command: VimCommand, input: string, ctx: TransitionContext): TransitionResult
```

支持的功能：
- 动作: `h/j/k/l/w/b/e/0/$/gg/G` 等
- 操作符: `d/c/y/p/P/gu/gU/g~/r` 等
- 文本对象: `iw/aw/is/as/ip/ap/i(/a(/i[/a[/i"/a"` 等
- 重复: `.`
- 寄存器: `"` (无名), `"0-9a-z`
- 计数前缀: `[1-9]`

### NORMAL 模式下的键例外

某些键绕过 Vim 解析：

- **Ctrl 组合键** → 始终用 Emacs 风格处理
- **Enter** → 可直接从 NORMAL 提交
- **方向键在 idle 时** → 委托 TextInput 处理（保持历史导航等能力）

**设计决策**：NORMAL 模式保留 Emacs Ctrl 键，避免两种编辑范式的冲突。

## 6. 键绑定框架与解析

### 键绑定架构

```typescript
// keybindings/types.ts
type Action = string  // e.g., 'chat:submit'
type Context = string  // e.g., 'Chat'

interface Keybinding {
  key: string
  action: Action
  context: Context
  when?: string
}

// 解析表示例
// 'ctrl+c' → { ctrl: true, key: 'c' }
// 'ctrl+x ctrl+s' → 和弦
// 'shift+tab' → { shift: true, key: 'tab' }
// 'meta+f' → { meta: true, key: 'f' }
```

### 解析器实现

`parseKey()` 处理转义序列和修饰键：

```typescript
// keybindings/parser.ts
function parseKey(input: string): ParsedKey | null {
  // 特殊序列优先
  if (input === '\x1b') return { escape: true }
  if (input === '\x7f') return { backspace: true }
  if (input === '\t') return { tab: true }
  if (input === '\r' || input === '\n') return { return: true }

  // CSI 序列 (光标键、功能键等)
  if (input.startsWith('\x1b[')) {
    return parseCsiSequence(input)
  }

  // Meta 前缀 (Esc + char)
  if (input.startsWith('\x1b') && input.length === 2) {
    return { meta: true, key: input[1] }
  }

  // Ctrl 字符 (0x01-0x1f)
  if (input.length === 1 && input.charCodeAt(0) <= 0x1f) {
    return { ctrl: true, key: String.fromCharCode(input.charCodeAt(0) + 0x60) }
  }

  return { key: input }
}
```

### 绑定匹配与解析

匹配流程：

```
用户按键 → ParsedKey
    ↓
按优先级迭代活跃 Contexts
    ↓
对于每个 Context:
  迭代该 Context 的 bindings
  ↓
  matchKey(parsedKey, binding.key)?
    ↓
    是 → 执行 handler，stopImmediatePropagation() → 结束
    ↓
    否 → 继续
```

### 用户自定义绑定

用户通过 `~/.claude/keybindings.json` 覆盖默认：

```json
{
  "keybindings": [
    {
      "key": "ctrl+g",
      "action": "chat:dismiss-all-overlays",
      "context": "Global"
    }
  ]
}
```

加载流程：`loadUserBindings()` → `resolver.resolve()` → 合并默认 + 用户，用户优先。

### 保留快捷键

某些快捷键保留，不可覆盖：

```typescript
// keybindings/reservedShortcuts.ts
const RESERVED = [
  'ctrl+c',  // 中断 (核心安全)
  'ctrl+d',  // 退出 (EOF)
  'ctrl+z',  // 挂起 (终端)
  'ctrl+s',  // 流控 (XON/XOFF)
  'ctrl+q',  // 流控恢复
]
```

## 7. 提交、取消与异步状态

### 提交流程

```typescript
// PromptInput.tsx
async function onSubmit(
  inputParam: string,
  isSubmittingSlashCommand = false
): Promise<void> {
  // 1. 如果 footer pill 选中 → 不提交，只打开
  if (footerItemSelected) return

  // 2. 如果 viewSelectionMode 正在选 agent → 不提交
  if (state.viewSelectionMode === 'selecting-agent') return

  // 3. 检查 prompt suggestion 接受
  const suggestionText = promptSuggestion.text
  const suggestionShown = promptSuggestion.shownAt > 0
  if (inputMatchesSuggestion && suggestionText && !hasImages && !viewingAgent) {
    if (speculation.status === 'active') {
      // 3a. 投机执行活跃 → 立即接受消息
      markAccepted()
      onSubmitProp(suggestionText, helpers, { speculation })
      return
    }
    if (suggestionShown) {
      markAccepted()
      inputParam = suggestionText
    }
  }

  // 4. 检查 @team 直接消息
  if (isAgentSwarmsEnabled()) {
    const dm = parseDirectMemberMessage(inputParam)
    if (dm) {
      const result = await sendDirectMemberMessage(dm.recipient, dm.message)
      if (result.success) {
        // 直接消息发送成功，不进入主循环
        addNotification(...)
        trackAndSetInput('')
        return
      }
    }
  }

  // 5. 检查补全菜单可见性
  // (如果补全可见且不是目录补全 → 不提交，用户需先选择/取消)
  if (suggestions.length > 0 && !isSubmittingSlashCommand && !hasDirectorySuggestions) {
    return
  }

  // 6. 路由到 viewed agent 或主循环
  const activeAgent = getActiveAgentForInput(state)
  if (activeAgent.type !== 'leader' && onAgentSubmit) {
    await onAgentSubmit(inputParam, activeAgent.task, helpers)
  } else {
    await onSubmitProp(inputParam, helpers)
  }
}
```

### 取消流程

取消的多种方式：

1. **请求进行中**
   - Ctrl+C → CancelRequestHandler 中断

2. **投机执行活跃**
   - Ctrl+C (空闲时) → abortSpeculation()
   - Esc → abortSpeculation()

3. **补全菜单**
   - Esc → clearSuggestions()
   - 也可通过 'autocomplete:dismiss' action

4. **Footer 选择**
   - Esc → selectFooterItem(null)

5. **输入清空**
   - Esc (快速双击) → 清空输入 + 保存到历史
   - Ctrl+U → 清空到行首

### 异步状态管理

```typescript
// AppState 中的相关状态
interface AppState {
  // 输入相关
  input: string
  cursorOffset: number
  mode: PromptInputMode

  // 提交状态
  isLoading: boolean
  messages: Message[]

  // 投机执行
  speculation: SpeculationState
  promptSuggestion: PromptSuggestionState

  // 模态状态
  footerSelection: FooterItem | null
  showModelPicker: boolean
  showQuickOpen: boolean
  showGlobalSearch: boolean
  showHistoryPicker: boolean
  showThinkingToggle: boolean
  showBashesDialog: string | boolean
  showTeamsDialog: boolean
  showBridgeDialog: boolean

  // 查看 agent
  viewingAgentTaskId: string | null
  viewSelectionMode: 'idle' | 'selecting-agent' | 'viewing-agent'
}
```

**设计决策**：模态状态集中存储在 AppState，避免组件间传递 props 污染。

## 8. 自动补全系统

### 补全类型

`useTypeahead` 按优先级处理多种补全源：

```typescript
type SuggestionType =
  | 'none'
  | 'command'      // /slash commands
  | 'custom-title' // /resume 自定义标题
  | 'agent'        // @agent 直接消息
  | 'slack-channel' // #channel
  | 'directory'    // @path 路径
  | 'file'         // @file 文件
  | 'shell'        // Bash 补全
```

### 补全触发流程

```
input 更新
    ↓
useTypeahead.updateSuggestions(input)
    ↓
┌─────────────────────────────────────────────────────┐
│ 1. 检查 prompt mode mid-input slash                 │
│    findMidInputSlashCommand() → 有 → 幽灵文本显示      │
├─────────────────────────────────────────────────────┤
│ 2. 检查 bash mode 历史补全                          │
│    getShellHistoryCompletion() → 有 → 幽灵文本显示     │
├─────────────────────────────────────────────────────┤
│ 3. 检查 @team member 补全                           │
│    match /(^|\s)@([\w-]*)$/ → 有 → agent 菜单      │
├─────────────────────────────────────────────────────┤
│ 4. 检查 #slack-channel 补全 (需 Slack MCP)          │
│    match /(^|\s)#([a-z0-9][a-z0-9_-]*)$/ → 有 → 菜单 │
├─────────────────────────────────────────────────────┤
│ 5. 检查 slash command 补全 (/ 开头)                 │
│    isCommandInput() → generateCommandSuggestions()  │
├─────────────────────────────────────────────────────┤
│ 6. 检查 @path 路径补全 (path-like token)           │
│    getPathCompletions() → 目录/文件菜单              │
├─────────────────────────────────────────────────────┤
│ 7. 检查 @file 模糊搜索                              │
│    generateUnifiedSuggestions() → 文件/MCP 资源菜单 │
├─────────────────────────────────────────────────────┤
│ 8. Bash mode: 检查 shell 补全                       │
│    generateBashSuggestions() → shell 补全菜单       │
└─────────────────────────────────────────────────────┘
```

### 幽灵文本 (Ghost Text)

两种内联补全显示，无需打开菜单：

1. **Prompt mode mid-input slash 补全**
   - 例如：`help me /co` → 显示 `/commit` 作为幽灵文本
   - **同步计算**在 `useMemo` 中，避免闪烁

2. **Bash mode 历史补全**
   - 例如：`git st` → 显示 `atus` 作为幽灵文本
   - **异步查询**历史记录

接受方式：
- Tab → `handleTab()` 检查 `effectiveGhostText` 并应用
- Right Arrow → 当 `input === ''` 且有 suggestion 时接受

### Tab 与 Enter 行为

**Tab 键** (`handleTab`)：
```
有内联幽灵文本? → 是 → 应用
    ↓ 否
有补全菜单? → 是 → 应用选中项
    ↓ 否
Bash mode? → 是 → 尝试 shell 补全
    ↓ 否
有 prompt suggestion? → 是 → 接受
    ↓ 否
输入为空? → 是 → 显示 thinking toggle 提示
```

**Enter 键** (`handleEnter`)：
```
有补全菜单?
  ├ command → 应用 + 执行
  ├ custom-title → 应用 + 执行 /resume
  ├ shell → 应用
  ├ agent → 应用 @mention
  ├ slack-channel → 应用 #channel
  ├ directory → 应用路径
  └ file → 应用文件引用
```

**设计决策**：目录补全下 Enter 不自动提交，允许继续编辑路径。

## 9. 粘贴处理

### 图片粘贴

```typescript
// PromptInput.tsx
function onImagePaste(
  image: string,
  mediaType?: string,
  filename?: string,
  dimensions?: ImageDimensions,
  sourcePath?: string
): void {
  const pasteId = nextPasteIdRef.current++  // 从现有消息初始化
  const newContent: PastedContent = {
    id: pasteId,
    type: 'image',
    content: image,
    mediaType: mediaType || 'image/png',
    filename: filename || 'Pasted image',
    dimensions,
    sourcePath,
  }

  // 1. 立即缓存路径用于渲染
  cacheImagePath(newContent)

  // 2. 异步存储到磁盘
  storeImage(newContent)

  // 3. 更新 UI，插入引用标记
  setPastedContents(prev => ({ ...prev, [pasteId]: newContent }))
  insertTextAtCursor(formatImageRef(pasteId))

  // 4. 延迟空格状态：下次输入非空格可打印字符前加空格
  pendingSpaceAfterPillRef.current = true
}

// 粘贴标记格式
formatImageRef(id: number) → `[Image ${id}]`
```

### 文本粘贴

```typescript
function onTextPaste(rawText: string): void {
  pendingSpaceAfterPillRef.current = false

  // 1. 清理：去除 ANSI，规范化换行、Tab → 空格
  let text = stripAnsi(rawText)
    .replace(/\r/g, '\n')
    .replaceAll('\t', '    ')

  // 2. 粘贴到空输入：检查 !/bash 前缀，自动切换模式
  if (input.length === 0) {
    const pastedMode = getModeFromInput(text)
    if (pastedMode !== 'prompt') {
      onModeChange(pastedMode)
      text = getValueFromInput(text)
    }
  }

  // 3. 大文本/多行 → 折叠为 [Pasted Text n] 引用
  const numLines = getPastedTextRefNumLines(text)
  const maxLines = Math.min(rows - 10, 2)
  if (text.length > PASTE_THRESHOLD || numLines > maxLines) {
    const pasteId = nextPasteIdRef.current++
    setPastedContents(prev => ({
      ...prev,
      [pasteId]: { id: pasteId, type: 'text', content: text }
    }))
    insertTextAtCursor(formatPastedTextRef(pasteId, numLines))
  } else {
    // 4. 小文本 → 直接插入
    insertTextAtCursor(text)
  }
}
```

### 延迟空格过滤器

处理 `[Image n]hello` → 自动变成 `[Image n] hello`：

```typescript
function lazySpaceInputFilter(input: string, key: Key): string {
  if (!pendingSpaceAfterPillRef.current) return input
  pendingSpaceAfterPillRef.current = false
  if (isNonSpacePrintable(input, key)) {
    return ' ' + input
  }
  return input
}
```

## 10. 设计决策记录

### 决策 #1：补全优先级高于历史导航

**问题**：用户输入时有补全菜单显示，按 ↑ 应该是选上一个补全还是上一条历史？

**选择**：补全菜单激活时，↑/↓ 只操作补全，不导航历史。

**理由**：
- 补全是更"即时"的交互，用户注意力在补全项上
- 避免用户不小心切换历史丢失正在输入的内容

**替代方案**：
- 只在光标位于行首时才用 ↑ 导航历史（当前使用，稍作调整）
- 代价：用户需要记住不同光标位置的行为差异

---

### 决策 #2：Vim 模式保留 Emacs Ctrl 键

**问题**：Vim 用户期望 hjkl 移动，但 Ctrl 组合键（Ctrl+A/E/K/W/U/Y）应该继续工作吗？

**选择**：保留所有 Emacs Ctrl 键行为，即使在 Vim NORMAL 模式。

**理由**：
- 许多用户肌肉记忆依赖这些键
- Vim 模式主要用于模态编辑，Ctrl 用于常用操作是增强而非冲突
- 避免两种编辑范式的 "宗教战争"

**替代方案**：
- 纯 Vim 模式，禁用所有 Emacs Ctrl 键
- 代价：失去很多高效快捷键，增加学习曲线

**证据**：代码中 `if (key.ctrl) { textInput.onInput(input, key); return; }`

---

### 决策 #3：光标位置用 UTF-16 offset，而非字形簇索引

**问题**：Unicode 文本（如 emoji、组合字符）的光标位置如何表示？

**选择**：统一使用 UTF-16 code unit offset，`Cursor` 类内部处理字形簇宽度。

**理由**：
- 与 JavaScript string API (slice, length) 一致
- 与终端输出一致（终端按 Unicode 宽度列计算，而非字符数）
- 所有状态持久化用简单整数，无歧义

**Cursor 职责**：
- 将 offset → (line, column)（考虑换行、终端宽度）
- 计算显示宽度（`stringWidth` 处理 East Asian Width、emoji、combining marks）

---

### 决策 #4：状态集中存储在 AppState，而非组件本地

**问题**：模态状态（哪个对话框打开、footer 选中项）放在哪里？

**选择**：所有全局 UI 状态存在 `AppStateStore`。

**理由**：
- 避免 props 多层传递 (prop drilling)
- 统一的状态更新路径，便于调试
- 支持时间旅行调试/撤销

**实现**：
- `useAppState(selector)` 读取
- `setAppState(updater)` 更新
- 选择器精确，避免不必要重渲染

---

### 决策 #5：用防抖合并快速输入到撤销历史

**问题**：每次按键都存一条撤销记录，用户按一次 Ctrl+Z 只撤销一个字符，体验差。

**选择**：`useInputBuffer` 用 `debounceMs: 1000` 合并快速连续输入。

**理由**：
- 用户通常连续输入短语，然后才可能需要撤销
- 1000ms 是打字停顿的经验阈值
- 保留大段编辑的可撤销性

**替代方案**：
- 只在空格/标点时分割历史
- 代价：对中文/日文等无空格语言不友好

---

### 决策 #6：幽灵文本用 useMemo 同步计算

**问题**：内联补全文本如何避免 "闪烁"？

**选择**：
- Prompt 模式 mid-input slash 补全：`useMemo` 同步计算
- Bash 历史补全：异步，但使用较少

**理由**：
- 异步 setState → useEffect → render 会导致一帧显示旧状态
- 同步计算确保幽灵文本与输入同时显示

**约束**：
- 同步计算必须极快 (<1ms)
- 只用于简单的命令前缀匹配，不做重型计算

---

### 决策 #7：Footer 导航独立于输入焦点

**问题**：用户选中 footer pill 后，输入应该失去焦点吗？还是继续接受输入？

**选择**：
- 选中 pill 时：`focus: false` 传给 TextInput
- TextInput 忽略输入（除了方向键等特殊键）
- 可打印字符自动清除选择并插入

**理由**：
- 清晰的视觉指示当前焦点在哪
- 同时保留 "类型退出" 的便捷性

---

### 决策 #8：粘贴大文本自动折叠为引用

**问题**：粘贴大段日志/代码会打乱终端布局。

**选择**：超过 `PASTE_THRESHOLD` (字符数) 或 `maxLines` (行数) 自动折叠为 `[Pasted Text n]`。

**理由**：
- 保持界面整洁
- 内容仍然存在（在 pastedContents 中），提交时可使用
- 用户仍可编辑/删除引用标记

---

### 决策 #9：键绑定通过 Context 分层解析

**问题**：同一个键在不同模式下应该做不同的事。

**选择**：
- 每个 action 有 `context` 属性
- Context 按优先级注册
- 每个 Context 提供 `isActive` 检查
- 事件自顶向下传递，第一个匹配执行并 `stopImmediatePropagation()`

**理由**：
- 可扩展，新功能只需加新 Context
- 明确的优先级顺序，无隐式冲突
- 每个 Context 只需关注自己的状态

**当前 Context 优先级**：
1. Autocomplete
2. Footer
3. Help
4. Chat
5. Global

---

### 决策 #10：多行输入的 ↑/↓ 移动光标，不导航历史

**问题**：多行文本中，用户按 ↑ 是想上移一行，还是看上一条历史？

**选择**：
- 检查 `isCursorOnFirstLine` / `isCursorOnLastLine`
- 只有位于首行按 ↑ 才导航历史
- 只有位于末行按 ↓ 才导航历史

**理由**：
- 多行编辑是强信号用户正在构造复杂输入
- 优先保证编辑体验流畅

**替代方案**：
- 用 Alt+↑/↓ 专门导航历史
- 代价：需要用户学习额外快捷键

---

## 11. 边界情况

### 边界 #1：光标落在图片引用中间

**场景**：输入 `hello [Image 1] world`，光标在 `[Im|age 1]` 中间。

**处理**：
- 检测到 `cursorOffset` 在任何引用区间内时 → 捕捉到最近端点
- 渲染时：当光标正好在引用开始处 → 反转显示整个引用作为选择指示

### 边界 #2：终端窄时文本换行

**场景**：终端 80 列，输入一行 160 字符文本。

**处理**：
- `Cursor` 按 `columns` 参数正确计算软换行
- `up()`/`down()` 在软换行行间移动，像操作真行一样
- `getViewportStartLine()` 确保光标在可视区域

### 边界 #3：Option 键在 macOS 上产生特殊字符而非 Meta

**场景**：macOS 终端，用户按 Option+F 期望移动到下一单词，实际输入 `ƒ`。

**处理**：
- 检测到 `isMacosOptionChar(input)` → 显示提示："Use Option as Meta in Terminal settings"
- 仍将字符插入输入，让用户看到发生了什么

### 边界 #4：SSH 下 Backspace 发送 DEL

**场景**：通过 SSH 连接，Backspace 键发送 `\x7f`，且有时同时发送键事件 + 原始字符。

**处理**：
- `useTextInput` 中有特殊分支：
  ```typescript
  if (!key.backspace && !key.delete && input.includes('\x7f')) {
    // 应用多次回退操作，不插入字符
  }
  ```

### 边界 #5：投机执行进行中时用户输入

**场景**：Claude 正在推测用户下一条问题，显示了建议，用户突然自己输入。

**处理**：
- 任何输入更改立即调用 `abortPromptSuggestion()` + `abortSpeculation()`
- 清除显示的建议
- 不阻塞用户输入流程

### 边界 #6：粘贴图片后立即输入可打印字符

**场景**：用户粘贴图片，然后立即输入 `hello`。

**处理**：
- `pendingSpaceAfterPillRef` 标志
- `lazySpaceInputFilter` 检查该标志，自动在字符前插入空格

### 边界 #7：在 Viewing Agent 模式下提交

**场景**：用户正在查看某个 agent 的输出，然后在输入框打字并回车。

**处理**：
- `getActiveAgentForInput()` 检测当前查看的 agent
- `onAgentSubmit()` 将输入发送给该 agent，而非 leader

---

## 12. 文件清单

### 核心输入文件

| 文件 | 职责 | 覆盖章节 |
|------|------|----------|
| `src/components/PromptInput/PromptInput.tsx` | 主组件、协调整个系统 | 2,3,7,9,11 |
| `src/components/PromptInput/inputModes.ts` | 模式检测与转换 | 3 |
| `src/components/PromptInput/inputPaste.ts` | 粘贴逻辑 | 9 |
| `src/components/TextInput.tsx` | 非 Vim 编辑器视图 | 3,5 |
| `src/components/VimTextInput.tsx` | Vim 编辑器视图 | 5 |
| `src/hooks/useTextInput.ts` | 文本编辑核心逻辑、撤销、剪切环 | 3,4,5 |
| `src/hooks/useVimInput.ts` | Vim 模式集成 | 5 |
| `src/hooks/useTypeahead.tsx` | 自动补全 | 8 |
| `src/hooks/useArrowKeyHistory.tsx` | 箭头键历史导航 | 4 |
| `src/hooks/useHistorySearch.ts` | Ctrl+R 历史搜索 | 4 |
| `src/hooks/useInputBuffer.ts` | 撤销缓冲 | 3 |
| `src/hooks/usePromptSuggestion.ts` | 提示建议显示 | 7,8 |

### 补全与建议

| 文件 | 职责 |
|------|------|
| `src/utils/suggestions/commandSuggestions.ts` | 命令生成、匹配、应用 |
| `src/utils/suggestions/directoryCompletion.ts` | 路径补全 |
| `src/utils/suggestions/shellHistoryCompletion.ts` | Bash 历史补全 |
| `src/utils/suggestions/slackChannelSuggestions.ts` | Slack 频道补全 |
| `src/hooks/fileSuggestions.ts` | 文件搜索与索引 |
| `src/hooks/unifiedSuggestions.ts` | 统一建议生成 |

### Vim 模式

| 文件 | 职责 |
|------|------|
| `src/vim/types.ts` | Vim 状态类型 |
| `src/vim/transitions.ts` | 命令解析状态机 |
| `src/vim/operators.ts` | 操作符实现 |
| `src/vim/motions.ts` | 动作实现 |
| `src/vim/textObjects.ts` | 文本对象实现 |

### 键绑定系统

| 文件 | 职责 |
|------|------|
| `src/keybindings/types.ts` | 类型定义 |
| `src/keybindings/parser.ts` | 键解析 |
| `src/keybindings/match.ts` | 绑定匹配 |
| `src/keybindings/resolver.ts` | 绑定解析与合并 |
| `src/keybindings/defaultBindings.ts` | 默认绑定定义 |
| `src/keybindings/loadUserBindings.ts` | 用户绑定加载 |
| `src/keybindings/useKeybindings.ts` | useKeybindings Hook |
| `src/keybindings/KeybindingContext.tsx` | Context 管理 |
| `src/keybindings/reservedShortcuts.ts` | 保留快捷键 |

### 基础设施

| 文件 | 职责 |
|------|------|
| `src/utils/Cursor.ts` | Cursor 核心类 |
| `src/utils/intl.ts` | 字形簇处理 |
| `src/ink/use-input.ts` | Ink 原始输入处理 |
| `src/ink/events/input-event.ts` | 输入事件 |

### 相关测试

| 文件 | 覆盖范围 |
|------|----------|
| `src/hooks/useTextInput.test.ts` | 文本编辑 |
| `src/hooks/useTypeahead.test.tsx` | 补全 |
| `src/vim/transitions.test.ts` | Vim 状态机 |
| `src/utils/Cursor.test.ts` | Cursor |
| `src/keybindings/match.test.ts` | 键匹配 |
| `src/keybindings/parser.test.ts` | 键解析 |

---

## 覆盖率

完整覆盖率定义请见：[Coverage](../../architecture/coverage/repl-input.yaml)
