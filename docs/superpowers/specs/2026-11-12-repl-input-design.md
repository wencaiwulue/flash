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

### 键事件处理数据流

```
终端原始输入
    ↓
ink useInput (原始键解析)
    ↓
TextInput / VimTextInput (基本编辑，仅无更高优先级 Context 时)
    ↓
KeybindingContexts (按优先级)
├─ Autocomplete (最高：补全菜单/幽灵文本激活)
├─ Footer (底部 pill 导航)
├─ Help (帮助菜单)
├─ Chat (聊天模式)
└─ Global (全局命令)
    ↓
PromptInput (顶层协调，状态更新)
```

### 键绑定上下文激活条件

1. **Autocomplete**：补全菜单可见或有内联幽灵文本 → 处理 Tab、Enter、Esc、方向键、Ctrl+N/P
2. **Footer**：底部 pill 选中 → 处理方向键导航、Enter 打开、Esc 取消、x 关闭
3. **Help**：帮助菜单打开 → 处理 Esc 关闭
4. **Chat**：正常聊天输入（默认激活）→ 处理提交、换行、撤销、外部编辑器、暂存、模型选择等
5. **Global**：全局始终可用 → 处理 Ctrl+C 中断、快速打开、全局搜索、历史搜索等

### 补全触发流程

```
input 更新
    ↓
useTypeahead.updateSuggestions(input)
    ↓
检查顺序：
├─ 1. prompt mode mid-input slash → 幽灵文本显示 (useMemo 同步)
├─ 2. bash mode 历史补全 → 幽灵文本显示 (异步)
├─ 3. @team member → agent 菜单
├─ 4. #slack-channel + Slack MCP → channel 菜单
├─ 5. /slash command → command 菜单
├─ 6. @path-like token → directory/file 菜单
├─ 7. @file 模糊搜索 → file/MCP resource 菜单
└─ 8. bash mode shell → shell 补全菜单
```

### 提交流程

```
用户按 Enter
    ↓
检查：footer pill 选中? → 是 → 不提交，仅打开
    ↓ 否
检查：viewSelectionMode selecting-agent? → 是 → 不提交
    ↓ 否
检查：prompt suggestion match + shown?
    ├─ 投机执行活跃? → 是 → markAccepted + onSubmitProp(speculation)
    └─ suggestion shown? → 是 → markAccepted，inputParam = suggestionText
    ↓
检查：@team direct message?
    └─ success? → addNotification，clear input，不进入主循环
    ↓
检查：suggestions visible + not directory? → 是 → 不提交
    ↓
检查：active agent viewing? → onAgentSubmit / onSubmitProp
```

### 主要模块接口

**Cursor 类**（文本编辑核心抽象）
```typescript
class Cursor {
  static fromText(text: string, columns: number, offset: number): Cursor
  left(): Cursor; right(): Cursor; up(): Cursor; down(): Cursor
  prevWord(): Cursor; nextWord(): Cursor
  startOfLine(): Cursor; endOfLine(): Cursor
  deleteToLineEnd(): { cursor: Cursor; killed: string }
  deleteToLineStart(): { cursor: Cursor; killed: string }
  insert(text: string): Cursor; backspace(): Cursor
  render(cursorChar: string, mask?: string, ...): string
}
```

**Vim 模式状态机**
```typescript
type VimCommand = 'idle' | { count: number } | { operator: Operator }
transition(command: VimCommand, input: string, ctx: TransitionContext)
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
