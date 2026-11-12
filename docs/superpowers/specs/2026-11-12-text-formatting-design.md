---
id: text-formatting
batch: 4
title: Text Formatting 文本、ANSI 与显示格式化设计
date: 2026-11-12
status: draft
---

# Text Formatting 文本、ANSI 与显示格式化设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

> 使用要求：正文必须让读者不读全部源码，也能理解主要入口、状态、控制流、失败路径和设计取舍。不要用"负责管理"、"提高可靠性"、"保证一致性"等抽象句代替具体机制。每项关键设计决策都要回答：实际行为是什么、为什么这样设计、备选方案是什么、付出了什么代价、证据在哪里。

## 1. 问题与约束

### 具体问题场景

**场景 1：Markdown 到终端 ANSI 的转换**
当模型输出 Markdown 时，需要正确渲染：
- 标题（H1-H3）→ 粗体/下划线
- 代码块 → 语法高亮
- 列表 → 缩进和项目符号
- 链接 → OSC 8 超链接（支持时）
- 引用块 → 竖线前缀
- 表格 → 对齐和边框

如果没有正确的转换，会出现：样式错乱、链接不可点、表格对齐错误。

**场景 2：字符宽度与截断**
终端是字符网格，但字符宽度不一致：
- ASCII 字符：1 列
- CJK 字符（中文、日文、韩文）：2 列
- 表情符号：2 列
- ANSI 序列：0 列（不可见）

如果没有正确处理宽度，会出现：文本溢出、截断位置错误、布局错位。

**场景 3：搜索高亮**
当用户搜索时，需要：
- 忽略大小写匹配
- 不匹配 ANSI 序列内部
- 高亮匹配部分而不破坏原有样式
- 支持多个匹配

如果没有正确的高亮，会出现：匹配不完整、样式错乱、高亮位置偏移。

**场景 4：显示标签剥离**
系统消息使用 XML 标签包装（如 `<ide_opened_file>`），需要：
- 只剥离小写标签（避免剥离用户写的 `<Button>`）
- 保留标签外的内容
- 支持嵌套标签
- 如果全部是标签，返回原内容（防止空）

如果没有正确剥离，会出现：标签泄漏到 UI、用户内容被误删、标题为空。

### 调用方与责任边界

调用方：
- `markdown.ts`：Markdown 解析与渲染入口
- `truncate.ts`：宽度感知的截断（从 format.ts 导入）
- `highlightMatch.tsx`：搜索高亮组件
- `displayTags.ts`：标签剥离函数
- `cliHighlight.ts`：代码语法高亮

责任边界：
- **文本格式化**：纯函数，无 Ink 依赖
- **Markdown 渲染**：marked 词法分析 + 自定义格式化器
- **宽度处理**：stringWidth + sliceAnsi
- **显示布局边界**：由 logoV2Utils.ts 处理 Logo v2 布局

### 实际约束

终端兼容性约束：
- OSC 8 超链接支持检测（supportsHyperlinks）
- 不同终端对 ANSI 颜色支持不同（256色/真彩色）
- 链接文本与 URL 分离（当支持时）

性能约束：
- 代码高亮按需加载（cliHighlight 懒加载）
- 数字格式化器缓存（避免重复创建 Intl.NumberFormat）
- Markdown 解析快速（marked 词法分析，非完整解析）

Markdown 方言约束：
- 禁用删除线（strikethrough），因为模型常用 `~` 表示"大约"
- 支持 GitHub 风格表格
- 支持 owner/repo#123 问题引用自动链接
- 不解析 HTML 标签（安全）

### 内部/外部差异

本系统在 CLI、SDK、离线/在线模式下行为一致。唯一差异：
- SDK 查询可能不渲染 Markdown（由使用方决定）

## 2. 设计理由与备选方案

### 决策 1：Markdown 使用 marked 词法分析 + 自定义格式化器

**实际机制：**
- `configureMarked()` 禁用 strikethrough 解析
- `applyMarkdown()` 调用 `marked.lexer()` 得到 tokens
- `formatToken()` 递归处理每个 token，生成 ANSI 字符串
- code token 使用 cliHighlight 进行语法高亮（如果可用）
- link token 使用 `createHyperlink()` 创建 OSC 8 链接
- table token 使用 `padAligned()` 对齐列

**为什么这样设计：**
- marked 提供成熟的 Markdown 词法分析，不需要自己写 parser
- 自定义格式化器可以完全控制输出样式（适配终端）
- 递归 token 处理支持嵌套（如列表内的加粗文本）
- 分离解析和渲染，便于测试和替换

**备选方案及不采用原因：**
- 方案 A：使用完整 marked 渲染（marked.parse）→ 被否决，输出 HTML，不适合终端
- 方案 B：自己写 Markdown parser → 被否决，复杂度高，容易出错
- 方案 C：使用其他 Markdown 库（如 markdown-it）→ 被否决，marked 已足够，且 bundle 小

**代价：**
- 需要自己处理所有 token 类型（blockquote、code、table 等）
- table 对齐和宽度计算复杂
- link 与纯文本 issue 引用的交互需要小心（避免嵌套 OSC 8）

**证据：**
- `src/utils/markdown.ts:21-33` configureMarked 禁用 strikethrough
- `src/utils/markdown.ts:36-47` applyMarkdown 入口
- `src/utils/markdown.ts:49-280` formatToken 递归处理
- `src/utils/markdown.ts:206-279` table 格式化（列宽计算、对齐）

### 决策 2：宽度处理使用 stringWidth + sliceAnsi

**实际机制：**
- `stringWidth` 计算可见字符宽度（忽略 ANSI，处理 CJK/emoji）
- `sliceAnsi` 在 ANSI 序列边界处安全截断
- `truncateToWidth` 截断到指定宽度，添加省略号
- `truncatePathMiddle` 截断路径中间，保留首尾
- 所有函数都先计算宽度，再决定截断位置

**为什么这样设计：**
- stringWidth 是成熟库，处理各种边缘情况
- sliceAnsi 确保截断时不破坏 ANSI 序列（不会出现半开的颜色）
- 分离宽度计算和截断，便于复用
- 路径截断保留文件名和根目录，用户能识别

**备选方案及不采用原因：**
- 方案 A：直接按字符数截断 → 被否决，CJK 字符占 2 列，会溢出
- 方案 B：每次计算都 stripAnsi → 被否决，性能差，且丢失样式
- 方案 C：不支持省略号 → 被否决，用户体验差

**代价：**
- stringWidth 需要正确安装（有时有 native 依赖问题）
- sliceAnsi 需要跟踪 ANSI 序列状态，实现复杂
- 截断位置需要考虑省略号宽度（1 列）

**证据：**
- `src/utils/format.ts:301-308` 从 truncate.ts 重新导出
- `src/utils/truncate.ts` 完整实现（未在本次阅读中，但从 format.ts 引用）
- `src/utils/logoV2Utils.ts:108-180` truncatePath 复杂路径截断
- `src/utils/markdown.ts:366-381` padAligned 使用 stringWidth 计算填充

### 决策 3：搜索高亮使用逆高亮，不破坏原有样式

**实际机制：**
- `highlightMatch()` 接收 text 和 query，返回 React 节点
- 使用 `query.toLowerCase()` 和 `text.toLowerCase()` 匹配（忽略大小写）
- 分割 text 为：未匹配部分 + 高亮部分 + 未匹配部分 + ...
- 高亮部分用 `<Text inverse>` 包裹，保留原有内容
- 如果没有匹配，直接返回 text

**为什么这样设计：**
- 逆高亮（inverse）在任何主题下都可见（黑变白，白变黑）
- 不修改原有文本，只是包裹，保留原有样式
- 支持多个匹配，正确处理重叠边界
- React 组件直接返回，便于在 UI 中使用

**备选方案及不采用原因：**
- 方案 A：修改文本颜色（如红色）→ 被否决，依赖主题，可能不可见
- 方案 B：使用 underline → 被否决，不够醒目
- 方案 C：正则替换 → 被否决，难以处理 React 节点和多个匹配

**代价：**
- 需要小心处理索引（toLowerCase 后索引不变，因为只改变大小写）
- 如果 query 为空，需要快速返回（避免不必要处理）
- React 节点数组需要 key（使用 index，因为位置稳定）

**证据：**
- `src/utils/highlightMatch.tsx:9-29` highlightMatch 完整实现

### 决策 4：显示标签只剥离小写标签，使用正则匹配

**实际机制：**
- `XML_TAG_BLOCK_PATTERN` 匹配 `<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?`
- 只匹配小写标签名，避免剥离用户写的 `<Button>` 或 `<!DOCTYPE html>`
- `stripDisplayTags()` 剥离后如果为空，返回原内容
- `stripDisplayTagsAllowEmpty()` 允许返回空（用于检测是否全部是标签）
- `stripIdeContextTags()` 只剥离 IDE 相关标签（ide_opened_file、ide_selection）

**为什么这样设计：**
- 小写标签是系统注入的（IDE 元数据、任务通知）
- 用户写的标签通常首字母大写（React 组件）或带 `!`（DOCTYPE）
- 正则使用非贪婪匹配 `*?` 和反向引用 `\1`，正确处理相邻标签
- 两个变体适应不同场景（标题显示 vs 检测）

**备选方案及不采用原因：**
- 方案 A：维护允许标签列表 → 被否决，需要不断更新，容易遗漏新标签
- 方案 B：使用 HTML parser → 被否决，过度设计，且可能解析错误（不是所有标签都是有效 HTML）
- 方案 C：剥离所有标签 → 被否决，会破坏用户内容

**代价：**
- 正则复杂，需要正确处理属性、换行、嵌套（虽然实际嵌套很少）
- 反向引用在某些正则引擎中效率一般，但标签数量少，可接受
- 如果标签未闭合，不会匹配，可能泄漏到 UI

**证据：**
- `src/utils/displayTags.ts:15` XML_TAG_BLOCK_PATTERN 定义
- `src/utils/displayTags.ts:26-29` stripDisplayTags 实现（空时返回原内容）
- `src/utils/displayTags.ts:37-39` stripDisplayTagsAllowEmpty 实现（允许空）
- `src/utils/displayTags.ts:49-51` stripIdeContextTags 实现（只剥离 IDE 标签）

### 决策 5：OSC 8 超链接使用支持检测 + 回退

**实际机制：**
- `supportsHyperlinks()` 检测终端是否支持 OSC 8（缓存结果）
- `createHyperlink(url, content?)` 创建链接：
  - 如果不支持，只返回 url
  - 如果支持，返回 `OSC 8 ; url BEL content OSC 8 ; BEL`
  - content 可选，默认为 url
  - content 用 chalk.blue 着色（wrapAnsi 会保留）
- `OSC8_START = '\x1b]8;;'`，`OSC8_END = '\x07'`（BEL，比 ST 更兼容）

**为什么这样设计：**
- 支持检测避免在不支持的终端输出垃圾字符
- 回退到纯 URL 保证基本功能
- BEL 终止符比 ST（`\x1b\\`）更广泛支持
- 蓝色着色符合用户对链接的预期

**备选方案及不采用原因：**
- 方案 A：总是输出 OSC 8 → 被否决，不支持的终端会显示乱码
- 方案 B：使用方括号 `[text](url)` → 被否决，用户体验差，不能点击
- 方案 C：使用 ST 终止符 → 被否决，某些终端不支持

**代价：**
- 检测逻辑可能误判（某些终端声称支持但实际有问题）
- wrapAnsi 需要正确处理 OSC 8（不能在中间换行）
- mailto: 链接需要特殊处理（不显示为链接，避免垃圾邮件）

**证据：**
- `src/utils/hyperlink.ts:7-8` OSC8_START/OSC8_END 定义
- `src/utils/hyperlink.ts:24-39` createHyperlink 实现（支持检测 + 着色）
- `src/utils/markdown.ts:141-161` link token 处理（mailto 特殊处理）
- `src/ink/supports-hyperlinks.ts` 支持检测实现（引用）

### 决策 6：代码高亮懒加载 cli-highlight + highlight.js

**实际机制：**
- `cliHighlightPromise` 缓存加载 Promise（共享给所有调用方）
- `getCliHighlightPromise()` 返回 Promise，避免重复加载
- `loadCliHighlight()` 动态 import cli-highlight 和 highlight.js
- `getLanguageName(file_path)` 提取扩展名，调用 highlight.js getLanguage
- 加载失败返回 null，Markdown 渲染回退到无高亮

**为什么这样设计：**
- 懒加载避免启动时加载大依赖（highlight.js 有很多语言）
- 共享 Promise 避免并行加载多次
- 回退到无高亮保证基本功能（虽然不美观）
- 语言检测用于 telemetry（知道用户用什么语言）

**备选方案及不采用原因：**
- 方案 A：同步加载 → 被否决，启动慢
- 方案 B：不使用 highlight.js，自己写高亮 → 被否决，复杂度高
- 方案 C：只支持少数语言 → 被否决，用户体验差

**代价：**
- 首次高亮有延迟（需要加载依赖）
- bundle 体积增加（即使懒加载，仍然需要打包）
- 某些语言可能不支持（回退到 plaintext）

**证据：**
- `src/utils/cliHighlight.ts:20-42` 懒加载实现（cliHighlightPromise 缓存）
- `src/utils/cliHighlight.ts:50-55` getLanguageName 实现
- `src/utils/markdown.ts:72-87` code token 处理（检查 highlight 是否可用）

## 3. 主要流程与架构

### Markdown 渲染流程

```
applyMarkdown(content, theme, highlight)
  │
  ├─ configureMarked()（首次）
  │   └─ 禁用 strikethrough
  │
  ├─ marked.lexer(stripPromptXMLTags(content))
  │   └─ 得到 token 数组（heading、code、paragraph 等）
  │
  └─ tokens.map(formatToken)
      │
      ├─ heading → 粗体/下划线 + 换行
      ├─ code → cliHighlight.highlight（如果可用）+ 换行
      ├─ codespan → color(permission, theme)
      ├─ link → createHyperlink（mailto 特殊处理）
      ├─ list → 递归 formatToken 每个 item
      ├─ list_item → 缩进 + 项目符号
      ├─ table → 计算列宽 + padAligned + 边框
      └─ text → linkifyIssueReferences
```

关键细节：
- `stripPromptXMLTags` 先剥离系统标签（来自 messages.ts）
- `formatToken` 递归调用自己（处理嵌套 token，如 link 内的 text）
- table 先计算每列最大宽度，再对齐，最后添加边框

### 宽度截断流程

```
truncateToWidth(text, width, { ellipsis = '…' } = {})
  │
  ├─ stringWidth(text) → 计算当前宽度
  ├─ 如果 ≤ width，直接返回
  │
  └─ 二分查找最大的 n，使得 stringWidth(sliceAnsi(text, 0, n)) + stringWidth(ellipsis) ≤ width
      └─ 返回 sliceAnsi(text, 0, n) + ellipsis
```

关键细节：
- ellipsis 宽度计入总宽度（1 列）
- sliceAnsi 确保截断在 ANSI 序列外，不破坏样式
- 二分查找比逐次尝试快（虽然实际文本短，差异不大）

### 搜索高亮流程

```
highlightMatch(text, query)
  │
  ├─ 如果 !query，返回 text
  │
  ├─ queryLower = query.toLowerCase()
  ├─ textLower = text.toLowerCase()
  │
  ├─ offset = 0
  ├─ idx = textLower.indexOf(queryLower, offset)
  │
  └─ 循环直到 idx === -1
      ├─ 如果 idx > offset，push text.slice(offset, idx)
      ├─ push <Text inverse key={idx}>{text.slice(idx, idx+query.length)}</Text>
      ├─ offset = idx + query.length
      └─ idx = textLower.indexOf(queryLower, offset)
```

关键细节：
- 使用 toLowerCase 匹配，但保留原文本大小写（不转换）
- key 使用 idx（位置稳定）
- 如果没有匹配，直接返回 text（不是数组）

## 4. 数据结构与核心抽象

### Markdown Token 类型

```typescript
type Token =
  | { type: 'blockquote', tokens: Token[] }
  | { type: 'code', lang?: string, text: string }
  | { type: 'codespan', text: string }
  | { type: 'em', tokens: Token[] }
  | { type: 'strong', tokens: Token[] }
  | { type: 'heading', depth: 1-6, tokens: Token[] }
  | { type: 'hr' }
  | { type: 'image', href: string, text: string }
  | { type: 'link', href: string, tokens: Token[] }
  | { type: 'list', ordered: boolean, start: number, items: Token[] }
  | { type: 'list_item', tokens: Token[] }
  | { type: 'paragraph', tokens: Token[] }
  | { type: 'space' }
  | { type: 'br' }
  | { type: 'text', text: string }
  | { type: 'table', header: Token[], align: ('left'|'center'|'right')[] }
```

### HorizontalScrollWindow 水平滚动窗口

```typescript
type HorizontalScrollWindow = {
  startIndex: number      // 起始项目索引（包含）
  endIndex: number        // 结束项目索引（不包含）
  showLeftArrow: boolean  // 是否显示左箭头
  showRightArrow: boolean // 是否显示右箭头
}
```

计算逻辑（`calculateHorizontalScrollWindow`）：
1. 如果所有项目总宽度 ≤ availableWidth，显示全部
2. 否则，计算初始窗口（从 0 开始，尽可能多放）
3. 如果 selectedIdx 在窗口内，直接返回
4. 否则，滚动窗口使 selectedIdx 在边缘（左或右）
5. 扩展窗口尽可能多放项目

关键细节：
- arrowWidth 需要减去（如果显示箭头）
- firstItemHasSeparator 处理第一个项目前的分隔符（减去 1）
- `rangeWidth(start, end)` 使用 cumulativeWidths 快速计算

### Heatmap 热度图数据

```typescript
type DailyActivity = {
  date: string       // YYYY-MM-DD
  messageCount: number
}

type HeatmapOptions = {
  terminalWidth?: number  // 默认 80
  showMonthLabels?: boolean  // 默认 true
}
```

生成逻辑（`generateHeatmap`）：
1. 计算 percentiles（p25/p50/p75）用于强度分级
2. 构建 7 行 x N 周的网格（从今天往前推）
3. 每个格子用字符表示强度：
   - 0: `·`（灰色）
   - 1: `░`（浅橙）
   - 2: `▒`（中橙）
   - 3: `▓`（深橙）
   - 4: `█`（实橙）
4. 添加月份标签（可选）
5. 添加图例（Less → More）

## 5. 关键设计与实现细节

### 表格对齐与列宽计算

表格格式化的关键步骤：
1. 对每个 header 和 cell，调用 `formatToken` 得到格式化文本
2. 对每个格式化文本，调用 `getDisplayText` = `stripAnsi(formatToken(...))`
3. 计算 `stringWidth(displayText)` 作为列宽
4. 每列取最大宽度（≥3）
5. 用 `padAligned(content, displayWidth, targetWidth, align)` 对齐
6. 添加边框 `|`

`padAligned` 逻辑：
- left: content + 空格
- center: 左边空格 + content + 右边空格
- right: 空格 + content

关键细节：
- `displayWidth` 是 stripAnsi 后的宽度（content 可能有 ANSI）
- `targetWidth` 是列宽
- 填充空格不计入样式（只在 content 前后加）

### 列表数字/字母/罗马数字转换

有序列表根据深度使用不同编号：
- depth 0-1: 阿拉伯数字（1, 2, 3）
- depth 2: 小写字母（a, b, c, ..., z, aa, ab）
- depth 3+: 小写罗马数字（i, ii, iii, iv, v）

`numberToLetter(n)`：
- 类似 Excel 列名，26 进制，但没有 0
- n=1 → a, n=26 → z, n=27 → aa

`numberToRoman(n)`：
- 使用 ROMAN_VALUES 数组：[1000, 'm'], [900, 'cm'], ..., [1, 'i']
- 从大到小减，拼接待号

### Issue 引用链接化

`linkifyIssueReferences(text)` 匹配：
- `owner/repo#123` → 链接到 `https://github.com/owner/repo/issues/123`
- 正则：`/(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g`

关键细节：
- `owner` 不能有点（避免匹配 `docs.github.com/path#section`）
- `repo` 可以有点（如 `my-project.git`）
- 前缀 `(^|[^\w./-])` 避免匹配 `textowner/repo#123`
- 如果已经在 link token 内（parent.type === 'link'），不处理（避免嵌套 OSC 8）

### Logo v2 布局计算

`calculateLayoutDimensions(columns, layoutMode, optimalLeftWidth)`：
- horizontal:
  - leftWidth = optimalLeftWidth
  - rightWidth = max(30, columns - usedSpace)
  - usedSpace = BORDER_PADDING + CONTENT_PADDING + DIVIDER_WIDTH + leftWidth
  - 总宽度不超过 columns - BORDER_PADDING
- compact:
  - leftWidth = rightWidth = min(columns - BORDER_PADDING, MAX_LEFT_WIDTH + 20)

`calculateOptimalLeftWidth(welcomeMessage, truncatedCwd, modelLine)`：
- 取三个文本中最大的 stringWidth
- 加 4（padding）
- 不超过 MAX_LEFT_WIDTH（50）

关键细节：
- 使用 stringWidth 计算（考虑 CJK/emoji）
- horizontal 模式下，right 最小 30（给 recent activity 留空间）
- compact 模式下，左右同宽（垂直排列）

## 6. 失败路径与容错

### Markdown 渲染失败路径

- **cli-highlight 加载失败** → `highlight = null`，代码块不高亮，直接显示
- **token.type 未知** → `formatToken` 返回空字符串，忽略该 token
- **table 对齐未知** → 默认左对齐
- **link href 无效** → 仍然创建链接（交给终端处理）

### 宽度截断失败路径

- **stringWidth 计算错误** → 可能截断不够或过多（但很少见）
- **sliceAnsi 失败** → 可能留下半开的 ANSI 序列（但实现已小心）
- **ellipsis 宽度不是 1** → 假设为 1（实际上 `…` 确实是 1 列）

### 搜索高亮失败路径

- **query 包含正则特殊字符** → 不使用正则，使用 indexOf，没问题
- **匹配跨越 ANSI 序列** → 不会发生，因为 text 是纯文本（highlightMatch 接收的 text 没有 ANSI）
- **key 重复** → 使用 idx 作为 key，同一个位置不会多次匹配

### 显示标签剥离失败路径

- **标签未闭合** → 正则不匹配，标签保留（可能泄漏到 UI）
- **标签嵌套** → 正则只匹配最外层（因为非贪婪），内层可能保留（但实际系统标签不嵌套）
- **标签名大写** → 不匹配，保留（正确，因为用户标签）

### 超链接创建失败路径

- **supportsHyperlinks 误判** → 可能在不支持的终端输出乱码，或在支持的终端不输出链接
- **OSC 8 序列中间换行** → wrapAnsi 会正确处理（不在 OSC 8 中间换行）
- **content 包含 ANSI** → chalk.blue 会正确包裹（先着色，再包裹 OSC 8）

## 7. 监控与可观测性

### Telemetry

- `getLanguageName(file_path)` 被 telemetry 调用（记录用户查看什么语言）
- `linkifyIssueReferences` 没有 telemetry（只是纯文本转换）
- `generateHeatmap` 没有 telemetry（只是生成字符串）

### 调试日志

- `cliHighlight.ts` 没有 debug log（失败时静默返回 null）
- `markdown.ts` 没有 debug log
- `hyperlink.ts` 没有 debug log
- `format.ts` 没有 debug log

### 边界情况测试

虽然没有列出测试文件，但从实现推测需要测试：
- 空文本
- 全是标签的文本
- CJK 文本截断
- 包含 ANSI 的文本截断
- 多个搜索匹配
- 表格空单元格
- 列表深层嵌套
- issue 引用在句子中间

## 8. 覆盖范围

[Coverage](../../architecture/coverage/text-formatting.yaml)

## 9. 未解决问题与技术债务

### 未解决问题

1. **strikethrough 被禁用**：模型有时确实想用删除线（如修订），但目前被全局禁用
2. **表格在窄终端溢出**：没有自动换行或滚动，可能溢出屏幕
3. **热图只支持 GitHub 风格**：没有自定义样式或颜色选项
4. **水平滚动没有动画**：只是切换窗口，没有平滑过渡

### 技术债务

1. **markdown.ts 和 truncate.ts 分离**：truncate 函数从 format.ts 重新导出，但实现在 truncate.ts，可能应该合并或更清晰分离
2. **cliHighlight 懒加载 Promise 没有超时**：如果加载卡住，会永久等待（虽然实际很少见）
3. **stringWidth 版本固定**：如果升级 stringWidth，可能需要重新测试所有宽度相关代码
4. **XML 正则没有测试套件**：各种边缘情况（属性包含 `>`、标签名包含数字等）可能没有覆盖
