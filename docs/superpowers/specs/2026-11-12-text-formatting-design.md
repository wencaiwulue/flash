---
id: text-formatting
batch: 4
title: Text Formatting 文本、ANSI 与显示格式化设计
date: 2026-11-12
status: draft
---

# Text Formatting 文本、ANSI 与显示格式化设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 需要处理多种文本格式化场景：

- Markdown 到终端 ANSI 的转换（标题、代码块、列表、链接、引用、表格）
- 字符宽度与截断（ASCII 占 1 列，CJK/表情占 2 列，ANSI 占 0 列）
- 搜索高亮（忽略大小写、不破坏 ANSI、支持多个匹配）
- 显示标签剥离（仅剥离小写标签，保留用户内容）

### 具体问题场景

**Markdown 到终端 ANSI 的转换：**
当模型输出 Markdown 时，需要正确渲染：
- 标题（H1-H3）→ 粗体/下划线
- 代码块 → 语法高亮
- 列表 → 缩进和项目符号
- 链接 → OSC 8 超链接（支持时）
- 引用块 → 竖线前缀
- 表格 → 对齐和边框

如果没有正确的转换，会出现：样式错乱、链接不可点、表格对齐错误。

**字符宽度与截断：**
终端是字符网格，但字符宽度不一致：
- ASCII 字符：1 列
- CJK 字符（中文、日文、韩文）：2 列
- 表情符号：2 列
- ANSI 序列：0 列（不可见）

如果没有正确处理宽度，会出现：文本溢出、截断位置错误、布局错位。

**搜索高亮：**
当用户搜索时，需要：
- 忽略大小写匹配
- 不匹配 ANSI 序列内部
- 高亮匹配部分而不破坏原有样式
- 支持多个匹配

如果没有正确的高亮，会出现：匹配不完整、样式错乱、高亮位置偏移。

**显示标签剥离：**
系统消息使用 XML 标签包装（如 `<ide_opened_file>`），需要：
- 只剥离小写标签（避免剥离用户写的 `<Button>`）
- 保留标签外的内容
- 支持嵌套标签
- 如果全部是标签，返回原内容（防止空）

如果没有正确剥离，会出现：标签泄漏到 UI、用户内容被误删、标题为空。

### 调用方与责任边界

调用方：
- `markdown.ts`：Markdown 解析与渲染入口
- `truncate.ts`：宽度感知的截断（从 format.ts 重新导出）
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
- 禁用删除线（strikethrough），因为模型常用 `~` 表示 "大约"
- 支持 GitHub 风格表格
- 支持 owner/repo#123 问题引用自动链接
- 不解析 HTML 标签（安全）

### 内部与外部差异

本系统在 CLI、SDK、离线/在线模式下行为一致。唯一差异：
- SDK 查询可能不渲染 Markdown（由使用方决定）

## 2. 设计理由与备选方案

### Markdown 使用 marked 词法分析 + 自定义格式化器

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | `configureMarked()` 禁用 strikethrough 解析；`applyMarkdown()` 调用 `marked.lexer()` 得到 tokens；`formatToken()` 递归处理每个 token，生成 ANSI 字符串；code token 使用 cliHighlight 进行语法高亮（如果可用）；link token 使用 `createHyperlink()` 创建 OSC 8 链接；table token 使用 `padAligned()` 对齐列 |
| **为什么采用** | marked 提供成熟的 Markdown 词法分析，不需要自己写 parser；自定义格式化器可以完全控制输出样式（适配终端）；递归 token 处理支持嵌套（如列表内的加粗文本）；分离解析和渲染，便于测试和替换 |
| **备选方案及不采用原因** | 方案 A：使用完整 marked 渲染（marked.parse）→ 被否决，输出 HTML，不适合终端；方案 B：自己写 Markdown parser → 被否决，复杂度高，容易出错；方案 C：使用其他 Markdown 库（如 markdown-it）→ 被否决，marked 已足够，且 bundle 小 |
| **代价** | 需要自己处理所有 token 类型（blockquote、code、table 等）；table 对齐和宽度计算复杂；link 与纯文本 issue 引用的交互需要小心（避免嵌套 OSC 8） |
| **证据** | `src/utils/markdown.ts:21-33` configureMarked 禁用 strikethrough；`src/utils/markdown.ts:36-47` applyMarkdown 入口；`src/utils/markdown.ts:49-280` formatToken 递归处理；`src/utils/markdown.ts:206-279` table 格式化（列宽计算、对齐） |

### 宽度处理使用 stringWidth + sliceAnsi

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | `stringWidth` 计算可见字符宽度（忽略 ANSI，处理 CJK/emoji）；`sliceAnsi` 在 ANSI 序列边界处安全截断；`truncateToWidth` 截断到指定宽度，添加省略号；`truncatePathMiddle` 截断路径中间，保留首尾；所有函数都先计算宽度，再决定截断位置 |
| **为什么采用** | stringWidth 是成熟库，处理各种边缘情况；sliceAnsi 确保截断时不破坏 ANSI 序列（不会出现半开的颜色）；分离宽度计算和截断，便于复用；路径截断保留文件名和根目录，用户能识别 |
| **备选方案及不采用原因** | 方案 A：直接按字符数截断 → 被否决，CJK 字符占 2 列，会溢出；方案 B：每次计算都 stripAnsi → 被否决，性能差，且丢失样式；方案 C：不支持省略号 → 被否决，用户体验差 |
| **代价** | stringWidth 需要正确安装（有时有 native 依赖问题）；sliceAnsi 需要跟踪 ANSI 序列状态，实现复杂；截断位置需要考虑省略号宽度（1 列） |
| **证据** | `src/utils/format.ts:301-308` 从 truncate.ts 重新导出；`src/utils/logoV2Utils.ts:108-180` truncatePath 复杂路径截断；`src/utils/markdown.ts:366-381` padAligned 使用 stringWidth 计算填充 |

### 搜索高亮使用逆高亮，不破坏原有样式

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | `highlightMatch()` 接收 text 和 query，返回 React 节点；使用 `query.toLowerCase()` 和 `text.toLowerCase()` 匹配（忽略大小写）；分割 text 为：未匹配部分 + 高亮部分 + 未匹配部分 + ...；高亮部分用 `<Text inverse>` 包裹，保留原有内容；如果没有匹配，直接返回 text |
| **为什么采用** | 逆高亮（inverse）在任何主题下都可见（黑变白，白变黑）；不修改原有文本，只是包裹，保留原有样式；支持多个匹配，正确处理重叠边界；React 组件直接返回，便于在 UI 中使用 |
| **备选方案及不采用原因** | 方案 A：修改文本颜色（如红色）→ 被否决，依赖主题，可能不可见；方案 B：使用 underline → 被否决，不够醒目；方案 C：正则替换 → 被否决，难以处理 React 节点和多个匹配 |
| **代价** | 需要小心处理索引（toLowerCase 后索引不变，因为只改变大小写）；如果 query 为空，需要快速返回（避免不必要处理）；React 节点数组需要 key（使用 index，因为位置稳定） |
| **证据** | `src/utils/highlightMatch.tsx:9-29` highlightMatch 完整实现 |

### 显示标签只剥离小写标签，使用正则匹配

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | `XML_TAG_BLOCK_PATTERN` 匹配 `<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?`；只匹配小写标签名，避免剥离用户写的 `<Button>` 或 `<!DOCTYPE html>`；`stripDisplayTags()` 剥离后如果为空，返回原内容；`stripDisplayTagsAllowEmpty()` 允许返回空（用于检测是否全部是标签）；`stripIdeContextTags()` 只剥离 IDE 相关标签（ide_opened_file、ide_selection） |
| **为什么采用** | 小写标签是系统注入的（IDE 元数据、任务通知）；用户写的标签通常首字母大写（React 组件）或带 `!`（DOCTYPE）；正则使用非贪婪匹配 `*?` 和反向引用 `\1`，正确处理相邻标签；两个变体适应不同场景（标题显示 vs 检测） |
| **备选方案及不采用原因** | 方案 A：维护允许标签列表 → 被否决，需要不断更新，容易遗漏新标签；方案 B：使用 HTML parser → 被否决，过度设计，且可能解析错误（不是所有标签都是有效 HTML）；方案 C：剥离所有标签 → 被否决，会破坏用户内容 |
| **代价** | 正则复杂，需要正确处理属性、换行、嵌套（虽然实际嵌套很少）；反向引用在某些正则引擎中效率一般，但标签数量少，可接受；如果标签未闭合，不会匹配，可能泄漏到 UI |
| **证据** | `src/utils/displayTags.ts:15` XML_TAG_BLOCK_PATTERN 定义；`src/utils/displayTags.ts:26-29` stripDisplayTags 实现（空时返回原内容）；`src/utils/displayTags.ts:37-39` stripDisplayTagsAllowEmpty 实现（允许空）；`src/utils/displayTags.ts:49-51` stripIdeContextTags 实现（只剥离 IDE 标签） |

### OSC 8 超链接使用支持检测 + 回退

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | `supportsHyperlinks()` 检测终端是否支持 OSC 8（缓存结果）；`createHyperlink(url, content?)` 创建链接：如果不支持，只返回 url；如果支持，返回 `OSC 8 ; url BEL content OSC 8 ; BEL`；content 可选，默认为 url；content 用 chalk.blue 着色（wrapAnsi 会保留）；`OSC8_START = '\x1b]8;;'`，`OSC8_END = '\x07'`（BEL，比 ST 更广泛支持） |
| **为什么采用** | 支持检测避免在不支持的终端输出垃圾字符；回退到纯 URL 保证基本功能；BEL 终止符比 ST（`\x1b\\`）更广泛支持；蓝色着色符合用户对链接的预期 |
| **备选方案及不采用原因** | 方案 A：总是输出 OSC 8 → 被否决，不支持的终端会显示乱码；方案 B：使用方括号 `[text](https://example.com)` → 被否决，用户体验差，不能点击；方案 C：使用 ST 终止符 → 被否决，某些终端不支持 |
| **代价** | 检测逻辑可能误判（某些终端声称支持但实际有问题）；wrapAnsi 需要正确处理 OSC 8（不在中间换行）；mailto: 链接需要特殊处理（不显示为链接，避免垃圾邮件） |
| **证据** | `src/utils/hyperlink.ts:7-8` OSC8_START/OSC8_END 定义；`src/utils/hyperlink.ts:24-39` createHyperlink 实现（支持检测 + 着色）；`src/utils/markdown.ts:141-161` link token 处理（mailto 特殊处理）；`src/ink/supports-hyperlinks.ts` 支持检测实现（引用） |

### 代码高亮懒加载 cli-highlight + highlight.js

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | `cliHighlightPromise` 缓存加载 Promise（共享给所有调用方）；`getCliHighlightPromise()` 返回 Promise，避免重复加载；`loadCliHighlight()` 动态 import cli-highlight 和 highlight.js；`getLanguageName(file_path)` 提取扩展名，调用 highlight.js getLanguage；加载失败返回 null，Markdown 渲染回退到无高亮 |
| **为什么采用** | 懒加载避免启动时加载大依赖（highlight.js 有很多语言）；共享 Promise 避免并行加载多次；回退到无高亮保证基本功能（虽然不美观）；语言检测用于 telemetry（知道用户用什么语言） |
| **备选方案及不采用原因** | 方案 A：同步加载 → 被否决，启动慢；方案 B：不使用 highlight.js，自己写高亮 → 被否决，复杂度高；方案 C：只支持少数语言 → 被否决，用户体验差 |
| **代价** | 首次高亮有延迟（需要加载依赖）；bundle 体积增加（即使懒加载，仍然需要打包）；某些语言可能不支持（回退到 plaintext） |
| **证据** | `src/utils/cliHighlight.ts:20-42` 懒加载实现（cliHighlightPromise 缓存）；`src/utils/cliHighlight.ts:50-55` getLanguageName 实现；`src/utils/markdown.ts:72-87` code token 处理（检查 highlight 是否可用） |

## 3. 目标与非目标

### 目标

- **Markdown 渲染**：正确转换标题、代码块、列表、链接、引用、表格到终端 ANSI
- **宽度处理**：正确计算可见字符宽度，安全截断不破坏 ANSI
- **搜索高亮**：忽略大小写匹配，不破坏原有样式，支持多个匹配
- **显示标签剥离**：只剥离小写标签，保留用户内容，支持嵌套
- **性能**：代码高亮懒加载，数字格式化器缓存，Markdown 解析快速

### 非目标

- 不支持完整 HTML 渲染（只处理 Markdown）
- 不支持所有 Markdown 方言（仅支持 GitHub 风格表格、禁用 strikethrough）
- 不跨终端统一所有样式（接受不同终端的颜色差异）
- 不处理所有边缘情况（如未闭合标签可能泄漏）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// markdown.ts
function applyMarkdown(content: string, theme?: Theme, highlight?: boolean): string

// truncate.ts
function truncateToWidth(text: string, width: number, options?: { ellipsis?: string }): string
function truncatePathMiddle(path: string, width: number): string

// highlightMatch.tsx
function highlightMatch(text: string, query: string): React.ReactNode

// displayTags.ts
function stripDisplayTags(text: string): string
function stripDisplayTagsAllowEmpty(text: string): string
function stripIdeContextTags(text: string): string

// hyperlink.ts
function supportsHyperlinks(): boolean
function createHyperlink(url: string, content?: string): string

// cliHighlight.ts
function getCliHighlightPromise(): Promise<typeof cliHighlight | null>
function getLanguageName(filePath: string): string | undefined
```

### 4.2 模块设计卡

#### marked/Markdown 模块

**真实入口签名**
```typescript
function configureMarked(): void
function applyMarkdown(content: string, theme: ThemeName, highlight?: CliHighlight | null): string
function formatToken(
  token: Token,
  theme: ThemeName,
  listDepth?: number,
  orderedListNumber?: number | null,
  parent?: Token | null,
  highlight?: CliHighlight | null
): string
function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined
): string
```

**关键类型**
- `marked.Token`: heading/code/link/list/table/text/blockquote/codespan/strong/em 等
- `ThemeName`: 主题名称
- `CliHighlight`: { highlight, supportsLanguage }

**输入输出**
- 输入：原始 Markdown 字符串 + ThemeName + CliHighlight（可选）
- 输出：带 ANSI 转义序列的终端渲染字符串

**Token/显示状态**
- Token 流：marked.lexer 生成的抽象语法树
- 显示状态：递归处理过程中跟踪 listDepth、orderedListNumber、parent token
- 内部缓存：markedConfigured 布尔值，避免重复配置

**解析/格式化/渲染流程**
```
1. configureMarked（首次调用）
   └─ marked.use 禁用 strikethrough tokenizer（del 返回 undefined）
   
2. applyMarkdown 主入口
   ├─ stripPromptXMLTags(content) → 先剥离系统标签
   ├─ marked.lexer → 生成 Token 数组
   ├─ tokens.map(formatToken) → 递归处理每个 token
   └─ .join('').trim() → 合并结果

3. formatToken 递归分发
   ├─ heading: H1→bold+italic+underline+双换行; H2/H3→bold+双换行
   ├─ code: 有 highlight 则 cliHighlight.highlight，否则原样 + 换行
   ├─ codespan: permission theme 色
   ├─ link: mailto 特殊处理（只显示邮箱），否则 createHyperlink
   ├─ list: 递归处理 items，传递 listDepth/orderedListNumber
   ├─ list_item: 缩进 + 数字/符号 + text token 处理
   ├─ table: 计算列宽 → padAligned 对齐 → 边框
   ├─ blockquote: 每行前缀 dim 竖线 + italic 内容
   ├─ text: 非 link 父节点时 linkifyIssueReferences
   └─ 其他：escape 返回原字符，def/del/html 返回空
```

**错误与兼容**
- 不抛异常：未知 token 类型返回空字符串
- mailto 链接不渲染为可点击链接（避免垃圾邮件）
- 只支持 owner/repo#NNN 格式 issue 链接（避免误匹配）
- 表格最小宽度 3 字符

**设计取舍/备选**
- 为什么用 marked.lexer + 自定义 formatToken，而不是完整 marked.parse？
  → 输出 HTML → 不适合终端；需要完全控制终端样式
- 为什么禁用 strikethrough？
  → 模型常用 ~ 表示"大约"，而非删除线
- 为什么递归 token 处理？
  → 支持嵌套结构（如 link 内的 text、list 内的 strong）
- 备选：使用 markdown-it 或 remark → 被否决，marked 更轻量且已满足需求

**源码测试证据**
- `src/utils/markdown.ts:21-33`: configureMarked 禁用 strikethrough
- `src/utils/markdown.ts:36-47`: applyMarkdown 入口流程
- `src/utils/markdown.ts:49-280`: formatToken 完整分发逻辑
- `src/utils/markdown.ts:282-308`: ISSUE_REF_PATTERN 与 linkifyIssueReferences
- `src/utils/markdown.ts:366-381`: padAligned 对齐函数

---

#### stringWidth/sliceAnsi 模块

**真实入口签名**
```typescript
// stringWidth.ts
function stringWidth(str: string): number

// sliceAnsi.ts
function sliceAnsi(str: string, start: number, end?: number): string

// truncate.ts
function truncateToWidth(text: string, maxWidth: number): string
function truncateStartToWidth(text: string, maxWidth: number): string
function truncateToWidthNoEllipsis(text: string, maxWidth: number): string
function truncatePathMiddle(path: string, maxWidth: number): string
function truncate(str: string, maxWidth: number, singleLine?: boolean): string
function wrapText(text: string, width: number): string[]
```

**关键类型**
- 无额外类型，纯字符串与数值操作

**输入输出**
- 输入：任意 Unicode 字符串（可含 ANSI 序列、CJK、emoji）
- 输出：可见宽度数值，或截断后的字符串

**Token/显示状态**
- 词法缓存：无（每次重新计算）
- 显示状态：通过 GraphemeSegmenter 分割字素簇，保证不切开 emoji/组合字符
- 内部状态：getGraphemeSegmenter（来自 intl.ts，可能有缓存）

**解析/格式化/渲染流程**
```
1. stringWidth（核心）
   ├─ 优先使用 Bun.stringWidth（如果可用）
   │   └─ { ambiguousIsNarrow: true } 选项
   ├─ 否则 stringWidthJavaScript 回退
   │   ├─ Fast Path 1: 纯 ASCII → 直接数可打印字符
   │   ├─ 有 ANSI → stripAnsi 后计算
   │   ├─ Fast Path 2: 简单 Unicode → 逐字符 eastAsianWidth
   │   └─ 复杂情况 → GraphemeSegmenter + emojiRegex 处理
   │       ├─ 字素簇分割
   │       ├─ emoji 检测（regional indicator 特殊处理）
   │       └─ 非 emoji 字素取第一个非零宽字符宽度
   └─ 零宽字符过滤：控制字符、组合标记、ZWJ、VS16 等不计宽度

2. truncateToWidth
   ├─ stringWidth(text) ≤ maxWidth → 原样返回
   ├─ maxWidth ≤ 1 → 返回 "…"
   ├─ GraphemeSegmenter 逐字素累加
   └─ 剩余空间 > ellipsis(1) 时才截断 + "…"

3. truncatePathMiddle
   ├─ 先尝试完整显示
   ├─ 提取 filename（最后 / 后部分）
   ├─ filename 过长 → truncateStartToWidth
   ├─ 否则 truncated dir + "…" + filename
```

**错误与兼容**
- 不抛异常：maxWidth ≤ 0 时返回 "…" 或空字符串
- 不切开字素簇：emoji、组合标记、CJK 等完整保留
- ANSI 序列完全不计宽度（stripAnsi 后计算）

**sliceAnsi 模块说明**
sliceAnsi 用于安全截断含 ANSI 序列的字符串，不破坏样式：
- 使用 @alcalzone/ansi-tokenize 正确 tokenize OSC 8 hyperlink 序列
- 按显示宽度（stringWidth）而非字符数追踪位置
- 保留活跃 ANSI 状态，在切片开头重建样式，在末尾正确清理
- 正确处理零宽字符（组合标记、ZWJ、VS16）：组合标记跟随基字符

**设计取舍/备选**
- 为什么用 Bun.stringWidth？
  → 性能更高，且复杂 Devanagari 连字正确返回 2 宽度
- 为什么不直接按字符数截断？
  → CJK/emoji 占 2 列，会溢出终端；ANSI 序列不可见
- 为什么用字素分割？
  → 避免切开 emoji 或组合字符（如 "à" = "a" + "`"）
- 备选：使用 string-width 库 → 被否决，某些字符宽度判断错误（如 ⚠）
- 备选：二分查找截断位置 → 被否决，字素分割更直接且准确
- 为什么自定义 sliceAnsi 而非使用 slice-ansi 包？
  → 正确处理 OSC 8 hyperlink 序列；按显示宽度追踪位置

**源码测试证据**
- `src/ink/stringWidth.ts:20-90`: stringWidthJavaScript 完整实现
- `src/ink/stringWidth.ts:129-203`: isZeroWidth 零宽字符判断
- `src/utils/sliceAnsi.ts:26-91`: sliceAnsi 完整实现
- `src/utils/truncate.ts:16-55`: truncatePathMiddle 路径中间截断
- `src/utils/truncate.ts:63-75`: truncateToWidth 字素安全截断
- `src/utils/truncate.ts:108-123`: truncateToWidthNoEllipsis 无省略号版本

---

#### 搜索高亮模块

**真实入口签名**
```typescript
function highlightMatch(text: string, query: string): React.ReactNode
```

**关键类型**
- `React.ReactNode`: 输出可为纯字符串或 React 元素数组

**输入输出**
- 输入：纯文本（无 ANSI）字符串 + 搜索 query 字符串
- 输出：React 节点（无匹配时为原字符串，有匹配时为 `<>` 包裹的片段数组）

**Token/显示状态**
- 无 token 化，直接字符串切片
- 显示状态：用 `<Text inverse>` 包裹匹配部分，不修改原文本
- React key：使用匹配起始索引 idx（位置稳定）

**解析/格式化/渲染流程**
```
1. 快速路径：!query → 直接返回原 text
2. 准备：queryLower = query.toLowerCase(), textLower = text.toLowerCase()
3. 循环匹配：
   ├─ offset = 0
   ├─ idx = textLower.indexOf(queryLower, offset)
   └─ 当 idx !== -1：
       ├─ idx > offset → push text.slice(offset, idx)（未匹配片段）
       ├─ push <Text inverse key={idx}>{text.slice(idx, idx+query.length)}</Text>
       ├─ offset = idx + query.length
       └─ idx = textLower.indexOf(queryLower, offset)
4. 收尾：offset < text.length → push 最后未匹配片段
5. 返回：单片段 → 直接返回，多片段 → <>{parts}</>
```

**错误与兼容**
- 不抛异常：query 为空返回原文本；无匹配返回原文本
- 逆高亮而非颜色高亮：任何主题下都可见
- 大小写不敏感匹配，但保留原文本大小写
- 不使用正则，indexOf 更安全（不处理正则特殊字符）

**设计取舍/备选**
- 为什么用逆高亮（inverse）而非颜色？
  → 不依赖主题，任何背景色下都可见
- 为什么用 indexOf 而非正则？
  → 不处理正则特殊字符（如 . * + ? 等），更安全
- 为什么 toLowerCase 匹配但保留原文本？
  → 用户需要看到原始大小写，同时找到匹配
- 备选：颜色高亮 → 被否决，主题依赖强
- 备选：正则替换 → 被否决，特殊字符处理复杂

**源码测试证据**
- `src/utils/highlightMatch.tsx:9-29`: highlightMatch 完整实现

---

#### displayTags 模块

**真实入口签名**
```typescript
function stripDisplayTags(text: string): string
function stripDisplayTagsAllowEmpty(text: string): string
function stripIdeContextTags(text: string): string
```

**关键类型**
- 无额外类型

**输入输出**
- 输入：可能包含系统标签的文本
- 输出：
  - stripDisplayTags：剥离后非空返回结果，否则返回原文本
  - stripDisplayTagsAllowEmpty：允许返回空（用于检测是否全是标签）
  - stripIdeContextTags：只剥离 ide_opened_file/ide_selection 标签

**Token/显示状态**
- 无 token 化，直接正则匹配
- 显示状态：只剥离小写标签，保留用户内容（如 <Button>、<!DOCTYPE>）
- 无内部缓存

**解析/格式化/渲染流程**
```
1. XML_TAG_BLOCK_PATTERN 正则匹配
   └─ /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g
       ├─ 只匹配小写标签名 [a-z][\w-]*
       ├─ 允许标签属性 (?:\s[^>]*)?
       ├─ 非贪婪内容 [\s\S]*?
       └─ 反向引用关闭标签 <\/\1>，可选换行

2. stripDisplayTags
   ├─ text.replace(XML_TAG_BLOCK_PATTERN, '').trim()
   └─ result || text → 空则返回原文本

3. stripIdeContextTags
   └─ IDE_CONTEXT_TAGS_PATTERN: /<(ide_opened_file|ide_selection).../
```

**错误与兼容**
- 不抛异常：未闭合标签不匹配，原样保留
- 只剥离小写标签：用户的 <Button>、<MyComponent>、<!DOCTYPE> 等保留
- 嵌套标签只剥离最外层（正则非贪婪）
- stripDisplayTags 空结果返回原文本（避免标题空）

**设计取舍/备选**
- 为什么用正则而非 HTML parser？
  → 过度设计，不是所有标签都是有效 HTML；正则足够简单快速
- 为什么只剥离小写标签？
  → 系统标签用小写，用户标签首字母大写（React 组件）或含 !（DOCTYPE）
- 为什么非贪婪匹配？
  → 避免相邻标签合并匹配
- 备选：维护允许标签列表 → 被否决，需要不断更新新标签类型
- 备选：剥离所有标签 → 被否决，会破坏用户内容

**源码测试证据**
- `src/utils/displayTags.ts:16`: XML_TAG_BLOCK_PATTERN 正则定义
- `src/utils/displayTags.ts:26-29`: stripDisplayTags 空保护
- `src/utils/displayTags.ts:37-39`: stripDisplayTagsAllowEmpty
- `src/utils/displayTags.ts:41-51`: stripIdeContextTags 只剥离 IDE 标签

---

#### OSC 8 Hyperlink 模块

**真实入口签名**
```typescript
// hyperlink.ts
const OSC8_START = '\x1b]8;;'
const OSC8_END = '\x07'
function createHyperlink(
  url: string,
  content?: string,
  options?: { supportsHyperlinks?: boolean }
): string

// supports-hyperlinks.ts
const ADDITIONAL_HYPERLINK_TERMINALS = ['ghostty', 'Hyper', 'kitty', 'alacritty', 'iTerm.app', 'iTerm2']
function supportsHyperlinks(options?: {
  env?: Record<string, string | undefined>,
  stdoutSupported?: boolean
}): boolean
```

**关键类型**
- 无额外类型

**输入输出**
- 输入：url 字符串 + 可选 content 显示文本 + 可选覆盖支持检测
- 输出：
  - 不支持超链接：纯 url
  - 支持超链接：OSC 8 序列包裹的蓝色 content（或 url）

**Token/显示状态**
- 无 token 化，纯字符串拼接
- 显示状态：用 chalk.blue 着色 content（在 OSC 8 内部）
- 无内部缓存（supportsHyperlinks 由调用方决定是否缓存）

**解析/格式化/渲染流程**
```
1. supportsHyperlinks 检测
   ├─ 先检查 supports-hyperlinks 库（stdoutSupported）
   ├─ 再检查 TERM_PROGRAM（ghostty/Hyper/kitty/alacritty/iTerm）
   ├─ 再检查 LC_TERMINAL（tmux 内保留）
   └─ 最后检查 TERM（xterm-kitty）

2. createHyperlink 创建
   ├─ !supportsHyperlinks → 返回 url
   ├─ content 可选，默认 = url
   ├─ chalk.blue(content) → 蓝色着色
   └─ OSC8_START + url + OSC8_END + coloredText + OSC8_START + OSC8_END
```

**错误与兼容**
- 不抛异常：任何 url 都接受，交给终端处理
- BEL (0x07) 终止符而非 ST (0x1b\\) → 更广泛支持
- wrapAnsi 需要正确处理（不在 OSC 8 中间换行）
- mailto 链接在 Markdown 中不渲染（避免垃圾邮件）

**设计取舍/备选**
- 为什么用 BEL 而非 ST 终止？
  → 更多终端支持 BEL
- 为什么检测额外终端？
  → supports-hyperlinks 库漏检某些终端
- 为什么检查 LC_TERMINAL？
  → tmux 会覆盖 TERM_PROGRAM，但保留 LC_TERMINAL
- 备选：总是输出 OSC 8 → 被否决，不支持终端显示乱码
- 备选：用 \[text\]\(url\) 格式 → 被否决，用户体验差，不可点击

**源码测试证据**
- `src/utils/hyperlink.ts:7-8`: OSC8_START/OSC8_END 定义
- `src/utils/hyperlink.ts:24-39`: createHyperlink 支持检测 + 着色
- `src/ink/supports-hyperlinks.ts:3-12`: ADDITIONAL_HYPERLINK_TERMINALS 列表
- `src/ink/supports-hyperlinks.ts:26-57`: supportsHyperlinks 完整检测逻辑
- `src/utils/markdown.ts:141-161`: link token 处理 mailto 特殊分支

---

#### Heatmap 模块

**真实入口签名**
```typescript
type HeatmapOptions = {
  terminalWidth?: number
  showMonthLabels?: boolean
}
type DailyActivity = { date: string; messageCount: number }
function generateHeatmap(dailyActivity: DailyActivity[], options?: HeatmapOptions): string
```

**关键类型**
- `DailyActivity`: { date: string; messageCount: number }
- `Percentiles`: { p25: number; p50: number; p75: number }

**输入输出**
- 输入：DailyActivity 数组 + HeatmapOptions
- 输出：带 ANSI 颜色的终端热图字符串（多行长文本）

**Token/显示状态**
- 无 token 化，网格计算
- 显示状态：
  - 5 级强度：0（· 灰色）→ 1（░）→ 2（▒）→ 3（▓）→ 4（█）
  - Claude 橙色 (#da7756)
- 内部状态：activityMap (date → activity)、percentiles 预计算

**解析/格式化/渲染流程**
```
1. 参数处理
   ├─ terminalWidth 默认 80
   ├─ 可用宽度 = terminalWidth - 4（日标签）
   └─ width = min(52, max(10, 可用宽度)) → 最多 1 年，最少 10 周

2. 数据准备
   ├─ activityMap = Map(date → DailyActivity)
   └─ percentiles = calculatePercentiles（p25/p50/p75）

3. 日期范围
   ├─ 结束 = today（00:00:00）
   ├─ 当前周开始 = 本周日
   └─ 开始 = 当前周开始 - (width-1) 周

4. 网格生成
   ├─ 7 行（周日 → 周六）× width 列
   ├─ 逐周逐天填充：
   │   ├─ 未来日期 → ' '
   │   ├─ 强度 = getIntensity(messageCount, percentiles)
   │   └─ 字符 = getHeatmapChar(intensity)
   └─ 同时跟踪 monthStarts（月份变化位置）

5. 输出组装
   ├─ Month labels（可选）：均匀分布
   ├─ Day labels：只显示 Mon/Wed/Fri
   ├─ Grid：每行 = label + ' ' + grid row
   └─ Legend：Less ░ ▒ ▓ █ More
```

**错误与兼容**
- 不抛异常：空数据返回全 · 的网格
- 未来日期显示为空
- 最少 10 周，最多 52 周
- Claude 橙色硬编码 (#da7756)

**设计取舍/备选**
- 为什么用百分位数而非绝对阈值？
  → 适应不同用户的活动水平
- 为什么 5 级强度？
  → 视觉区分清晰，与 GitHub 风格一致
- 为什么周日开始？
  → GitHub 风格惯例
- 备选：绝对阈值（如 0/1-3/4-7/8-15/16+）→ 被否决，不适应不同用户
- 备选：可自定义颜色 → 被否决，当前需求不需要

**源码测试证据**
- `src/utils/heatmap.ts:39-166`: generateHeatmap 完整流程
- `src/utils/heatmap.ts:19-34`: calculatePercentiles 百分位计算
- `src/utils/heatmap.ts:168-178`: getIntensity 5 级强度
- `src/utils/heatmap.ts:183-198`: getHeatmapChar 字符映射
- `src/utils/heatmap.ts:181`: claudeOrange 颜色定义

---

#### LogoV2 模块

**真实入口签名**
```typescript
type LayoutMode = 'horizontal' | 'compact'
type LayoutDimensions = { leftWidth: number; rightWidth: number; totalWidth: number }
function getLayoutMode(columns: number): LayoutMode
function calculateLayoutDimensions(
  columns: number,
  layoutMode: LayoutMode,
  optimalLeftWidth: number
): LayoutDimensions
function calculateOptimalLeftWidth(
  welcomeMessage: string,
  truncatedCwd: string,
  modelLine: string
): number
function formatWelcomeMessage(username: string | null): string
function truncatePath(path: string, maxLength: number): string
function getRecentActivity(): Promise<LogOption[]>
function getRecentActivitySync(): LogOption[]
function formatReleaseNoteForDisplay(note: string, maxWidth: number): string
function getLogoDisplayData(): { version: string; cwd: string; billingType: string; agentSetting?: string }
function formatModelAndBilling(
  modelName: string,
  billingType: string,
  availableWidth: number
): { shouldSplit: boolean; truncatedModel: string; truncatedBilling: string }
```

**关键类型**
- `LayoutMode`: horizontal (≥70 列) | compact (<70 列)
- `LayoutDimensions`: leftWidth, rightWidth, totalWidth
- `LogOption`: 会话日志选项（来自 types/logs）

**输入输出**
- 输入：终端 columns、用户名、路径、模型名、billing 类型等
- 输出：布局参数、截断后文本、格式化后显示数据等

**Token/显示状态**
- 无 token 化，纯布局计算
- 显示状态：
  - MAX_LEFT_WIDTH = 50
  - MAX_USERNAME_LENGTH = 20
  - BORDER_PADDING = 4, DIVIDER_WIDTH = 1, CONTENT_PADDING = 2
- 内部缓存：cachedActivity（最近会话列表）、cachePromise（加载 Promise）

**解析/格式化/渲染流程**
```
1. 布局决策
   ├─ getLayoutMode: columns ≥70 → horizontal，否则 compact
   ├─ calculateOptimalLeftWidth: max(welcome, cwd, modelLine, 20) → min(50)
   └─ calculateLayoutDimensions:
       ├─ horizontal: left = optimal, right = 剩余空间，min(30)
       └─ compact: left/right = total = min(columns-4, 70)

2. 路径截断（不同于 truncatePathMiddle）
   ├─ stringWidth(path) ≤ maxLength → 原样
   ├─ 单部分 → truncateToWidth
   ├─ 从右向左尝试保留更多部分：
   │   ├─ first + … + last
   │   └─ first + … + middle parts + … + last（尽可能多）
   └─ Unix 特殊处理：first 为空 → /…/last

3. 最近活动缓存
   ├─ getRecentActivity: 返回 cachePromise 或新建
   ├─ 加载 10 条 → 过滤非 sidechain、非当前会话、不含 "I apologize"、有 summary/prompt
   └─ 取前 3 条 → cachedActivity
   └─ getRecentActivitySync: 同步返回缓存

4. Model + Billing 格式化
   ├─ 合起来宽度 ≤ available → model · billing（model 截断）
   └─ 否则 → split 为两行，各自截断
```

**错误与兼容**
- 不抛异常：加载失败返回空数组
- 用户名过长 (>20) → "Welcome back!"
- release note 与 activity description 同样截断方式
- 最近活动过滤掉 "I apologize" 会话（避免显示错误会话）

**设计取舍/备选**
- 为什么有两个 truncatePath 实现（logoV2Utils 与 truncate.ts）？
  → logoV2Utils 的 truncatePath 保留更多目录信息（尝试保留中间部分）
- 为什么缓存最近活动？
  → 避免每次渲染都重新加载
- 为什么过滤 "I apologize" 会话？
  → 这些是错误会话，不应该显示在欢迎界面
- 备选：统一 truncatePath → 被否决，logo 需要更智能的截断策略

**源码测试证据**
- `src/utils/logoV2Utils.ts:18-23`: 布局常量定义
- `src/utils/logoV2Utils.ts:35-38`: getLayoutMode 分支点
- `src/utils/logoV2Utils.ts:43-75`: calculateLayoutDimensions 两种模式
- `src/utils/logoV2Utils.ts:80-92`: calculateOptimalLeftWidth 基于内容
- `src/utils/logoV2Utils.ts:108-180`: truncatePath 复杂路径截断
- `src/utils/logoV2Utils.ts:183-219`: getRecentActivity 缓存与过滤
- `src/utils/logoV2Utils.ts:291-305`: formatModelAndBilling 合并/分行

---

### 4.3 主要流程

#### Markdown 渲染流程

```
applyMarkdown(content, theme, highlight)
  ├─ configureMarked()（首次）
  │   └─ 禁用 strikethrough
  ├─ marked.lexer(stripPromptXMLTags(content))
  │   └─ 得到 token 数组（heading、code、paragraph 等）
  └─ tokens.map(formatToken)
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

#### 宽度截断流程

```
truncateToWidth(text, width, { ellipsis = '…' } = {})
  ├─ stringWidth(text) → 计算当前宽度
  ├─ 如果 ≤ width，直接返回
  └─ GraphemeSegmenter 逐字素累加
      └─ 返回截断文本 + ellipsis
```

关键细节：
- ellipsis 宽度计入总宽度（1 列）
- 字素分割确保不切开 emoji/组合字符
- stringWidth 优先用 Bun.stringWidth（性能 + 复杂字符准确）

#### 搜索高亮流程

```
highlightMatch(text, query)
  ├─ 如果 !query，返回 text
  ├─ queryLower = query.toLowerCase()
  ├─ textLower = text.toLowerCase()
  ├─ offset = 0
  ├─ idx = textLower.indexOf(queryLower, offset)
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

---

### 4.4 架构与资源边界图

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Public API Layer (Entry Points)                     │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  applyMarkdown(content, theme, highlight) → string               │  │
│  │  truncateToWidth(text, width, options) → string                 │  │
│  │  truncatePathMiddle(path, width) → string                     │  │
│  │  highlightMatch(text, query) → React.ReactNode               │  │
│  │  stripDisplayTags(text) → string                             │  │
│  │  stripDisplayTagsAllowEmpty(text) → string                  │  │
│  │  stripIdeContextTags(text) → string                         │  │
│  │  createHyperlink(url, content, options) → string            │  │
│  │  getCliHighlightPromise() → Promise<CliHighlight|null>         │  │
│  │  getLanguageName(filePath) → string|undefined                │  │
│  │  generateHeatmap(dailyActivity, options) → string          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Core Formatting Modules                             │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌────────────────┐  │
│  │ markdown.ts          │  │ truncate.ts          │  │ displayTags.ts │  │
│  │  • configureMarked() │  │  • truncateToWidth() │  │  • XML_TAG_BLOCK_PATTERN │ │
│  │  • applyMarkdown()   │  │  • truncatePathMiddle() │ │  • stripDisplayTags() │  │
│  │  • formatToken()     │  │  • truncateStartToWidth() │ │  • stripIdeContextTags() │  │
│  │  • padAligned()      │  │  • truncateToWidthNoEllipsis() │ │  • IDE_CONTEXT_TAGS_PATTERN │  │
│  │  • linkifyIssueReferences() │ │  • stripPromptXMLTags() │  │
│  │  • ISSUE_REF_PATTERN │  │                     │  │                     │  │
│  └─────────────────────────┘  └─────────────────────────┘  └────────────────┘  │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌────────────────┐  │
│  │ hyperlink.ts         │  │ cliHighlight.ts      │  │ highlightMatch.tsx │  │
│  │  • OSC8_START       │  │  • cliHighlightPromise (cached) │ │  • highlightMatch() │  │
│  │  • OSC8_END         │  │  • loadCliHighlight() │  │  • <Text inverse> │  │
│  │  • supportsHyperlinks() │ │  • getLanguageName() │  │                     │  │
│  │  • createHyperlink() │  │                     │  │                     │  │
│  └─────────────────────────┘  └─────────────────────────┘  └────────────────┘  │
│  ┌─────────────────────────┐  ┌─────────────────────────┐                        │
│  │ heatmap.ts           │  │ logoV2Utils.ts      │                        │
│  │  • generateHeatmap() │  │  • getLayoutMode()   │                        │
│  │  • calculatePercentiles() │ │  • calculateLayoutDimensions() │  │
│  │  • getIntensity()    │  │  • calculateOptimalLeftWidth() │  │
│  │  • getHeatmapChar()  │  │  • formatWelcomeMessage() │  │
│  │  • claudeOrange      │  │  • truncatePath()      │                        │
│  │                     │  │  • getRecentActivity() │                        │
│  └─────────────────────────┘  └─────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Ink Platform Utilities (Shared Dependencies)              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  stringWidth (from ink/stringWidth.ts)                          │ │
│  │  • Bun.stringWidth (preferred, with ambiguousIsNarrow: true)      │  │
│  │  • stringWidthJavaScript fallback (GraphemeSegmenter + emojiRegex) │ │
│  │  • isZeroWidth() predicate (control chars, combining marks, etc.) │ │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  sliceAnsi (from utils/sliceAnsi.ts)                             │ │
│  │  • @alcalzone/ansi-tokenizer for tokenizing ANSI/OSC 8 sequences │ │
│  │  • tracks active ANSI state, reconstructs at slice start        │ │
│  │  • properly handles zero-width characters (combining marks)      │ │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  supports-hyperlinks (from ink/supports-hyperlinks.ts)           │ │
│  │  • checks stdout.isTTY, TERM_PROGRAM (ghostty/kitty/alacritty/...) │ │
│  │  • checks LC_TERMINAL (tmux), TERM (xterm-kitty)                 │ │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  marked (external library, configured in markdown.ts)              │ │
│  │  • marked.use({ tokenizer: { del: () => undefined } }) (disable strikethrough) │ │
│  │  • marked.lexer() for tokenizing markdown without full render        │ │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  cli-highlight + highlight.js (lazy loaded)                     │ │
│  │  • dynamically imported on first use, not at startup                │ │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  chalk (for coloring hyperlinks)                                  │ │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  React (only for highlightMatch.tsx JSX output)                  │ │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Cached State & Global Constants                          │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Global Caches (Module-level)                                       │ │
│  │  • cliHighlightPromise: Promise<CliHighlight|null> (shared singleton) │ │
│  │  • cachedActivity: LogOption[] (logoV2Utils)                       │ │
│  │  • cachePromise: Promise<LogOption[]>|null (logoV2Utils)           │ │
│  │  • markedConfigured: boolean (tracks configureMarked() already called) │ │
│  │  • StylePool/CharPool/HyperlinkPool are from ink.tsx (not here)    │ │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Constants (Module-level, immutable)                               │ │
│  │  • XML_TAG_BLOCK_PATTERN: RegExp (matches <lower-case-tag>...</lower-case-tag>) │ │
│  │  • IDE_CONTEXT_TAGS_PATTERN: RegExp (matches <ide_opened_file>, <ide_selection>) │ │
│  │  • ISSUE_REF_PATTERN: RegExp (matches owner/repo#123)             │ │
│  │  • OSC8_START: '\x1b]8;;'                                          │ │
│  │  • OSC8_END: '\x07' (BEL, more compatible than ST '\x1b\\')        │ │
│  │  • claudeOrange: '#da7756' (heatmap color)                        │ │
│  │  • PASTE_THRESHOLD: 10000 (from repl-input spec, shared const)      │ │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Filesystem Paths (Read-only references)                         │ │
│  │  • ~/.claude/ (reference to config directory, not used here)      │ │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

**证据来源**: `src/utils/markdown.ts` (markdown核心), `src/utils/truncate.ts` (截断), `src/utils/displayTags.ts` (标签剥离), `src/utils/hyperlink.ts` (超链接), `src/utils/cliHighlight.ts` (代码高亮), `src/utils/highlightMatch.tsx` (搜索高亮), `src/utils/heatmap.ts` (热图), `src/utils/logoV2Utils.ts` (Logo布局)

---

### 4.5 关键流程与失败路径

```text
[主流程 1: Markdown渲染流程]

调用方调用 applyMarkdown(content, theme, highlight)
  │
  ├─> configureMarked() (首次调用时)
  │       └─> marked.use({ tokenizer: { del: () => undefined } })
  │           └─> 禁用 strikethrough tokenizer (模型常用 ~ 表示"大约")
  │
  ├─> stripPromptXMLTags(content) → 先剥离系统标签 (来自 messages.ts)
  │
  ├─> marked.lexer(strippedContent) → token数组 (heading/code/paragraph/...)
  │
  ├─> tokens.map(formatToken(token, theme, highlight, listDepth, orderedListNumber, parent))
  │       │
  │       ├─> heading token → format with bold/underline + 2 newlines
  │       ├─> code token:
  │       │   ├─> if highlight available → cliHighlight.highlight(code, lang)
  │       │   └─> else → use code as-is + 2 newlines
  │       ├─> codespan token → color with permission theme color
  │       ├─> link token:
  │       │   ├─> if mailto: → show email only, no hyperlink
  │       │   └─> else → createHyperlink(url, content)
  │       ├─> list token → recurse on list items with listDepth+1
  │       ├─> list_item token → indent + bullet/number + format child
  │       ├─> table token:
  │       │   ├─> calculate max width per column
  │       │   ├─> padAligned() for each cell alignment
  │       │   └─> add border lines
  │       ├─> blockquote token → prefix each line with dim "│" + italic content
  │       ├─> text token (parent not link):
  │       │   └─> linkifyIssueReferences() → replace owner/repo#123 with OSC 8 link
  │       ├─> escape/def/del/html tokens → ignore/return empty
  │       └─> unknown token type → return empty string (fail safe)
  │
  └─> join formatted tokens with '' → trim() → return rendered ANSI string


[失败分支: cli-highlight加载失败]
  ├─ loadCliHighlight() tries dynamic import('cli-highlight') + import('highlight.js')
  ├─ if import fails (network? bundle issue?) → catch error → return null
  ├─ applyMarkdown() receives highlight: null
  ├─ code blocks render without syntax highlighting (raw code)
  └─ no error thrown, graceful degradation to plain code display


[失败分支: 未知token类型]
  ├─ marked.lexer() returns token.type we don't handle
  ├─ formatToken() switch hits default case
  ├─ return empty string '' instead of throwing
  └─ that token is omitted from output, no crash


[主流程 2: 字符串宽度计算与截断]

调用方调用 truncateToWidth(text, maxWidth, { ellipsis = '…' } = {})
  │
  ├─> stringWidth(text) → calculate visible width
  │       │
  │       ├─> try Bun.stringWidth(text, { ambiguousIsNarrow: true }) (fastest)
  │       └─> fall back to stringWidthJavaScript(text) if Bun not available
  │           ├─> strip ANSI first
  │           ├─> GraphemeSegmenter for Unicode grapheme clusters
  │           ├─> emojiRegex for emoji sequences
  │           ├─> isZeroWidth() skips control chars/combining marks/ZWNJ/etc.
  │           └─> counts CJK/emoji as 2, others as 1
  │
  ├─> if stringWidth(text) ≤ maxWidth → return text as-is
  │
  ├─> if maxWidth ≤ 1 → return '…' (always enough space for ellipsis)
  │
  └─> else (need truncation):
      ├─> targetWidth = maxWidth - stringWidth(ellipsis) (reserve space)
      ├─> iterate graphemes, accumulate until targetWidth reached
      │   └─> sliceAnsi() used internally to safely truncate with ANSI
      └─> return truncatedText + ellipsis


[失败分支: sliceAnsi半开序列]
  ├─ sliceAnsi() implementation tracks active ANSI state at slice boundaries
  ├─ reconstructs necessary ANSI codes at start of sliced string
  ├─ ensures no half-open sequences in output
  └─ very unlikely to fail, but if it does, minor visual glitches only


[主流程 3: 搜索高亮 (React输出)]

调用方调用 highlightMatch(text, query)
  │
  ├─> if !query (empty/undefined) → return text as-is (no array)
  │
  ├─> queryLower = query.toLowerCase(), textLower = text.toLowerCase()
  │
  ├─> offset = 0
  │
  └─> loop:
      ├─> idx = textLower.indexOf(queryLower, offset)
      ├─> if idx === -1 → break loop
      ├─> if idx > offset → push text.slice(offset, idx) (plain string)
      ├─> push <Text inverse key={idx}>{text.slice(idx, idx+query.length)}</Text>
      ├─> offset = idx + query.length
      └─> repeat loop
  │
  ├─> if offset < text.length → push text.slice(offset) (remaining)
  │
  └─> return <>{parts}</> if multiple parts, else single string/node


[失败分支: query包含正则特殊字符]
  ├─ NOT a problem: we use indexOf(), not regex
  ├─ so searching for "file.txt" just searches for literal string
  └─ no escaping needed, safe and predictable


[主流程 4: 标签剥离]

调用方调用 stripDisplayTags(text)
  │
  ├─> text.replace(XML_TAG_BLOCK_PATTERN, '') → remove lowercase tags
  │       │
  │       └─> XML_TAG_BLOCK_PATTERN: /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g
  │           ├─> only matches tag names starting with [a-z] (lower-case only)
  │           ├─> non-greedy [\s\S]*? for content
  │           └─> \1 back-reference to match closing tag
  │
  ├─> trim() result
  │
  └─> if result is empty string → return original text instead
      └─> prevents empty output when entire content is tags


[失败分支: 标签未闭合]
  ├─ regex doesn't match unclosed tags
  ├─ tags are left in output (leak)
  └─> but better than accidentally stripping user content
  └─> system tags in practice are always properly closed by design


[成功分支: stripDisplayTagsAllowEmpty(text)]
  ├─ same replace logic, but returns empty string if result is empty
  └─> used for detecting if content is all tags


[主流程 5: 超链接创建]

调用方调用 createHyperlink(url, content = url, options = {})
  │
  ├─> check supportsHyperlinks(options):
  │       ├─> checks stdout.isTTY
  │       ├─> checks TERM_PROGRAM (ghostty/kitty/alacritty/iterm/...)
  │       ├─> checks LC_TERMINAL (tmux)
  │       └─> checks TERM (xterm-kitty)
  │
  ├─> if NOT supported → return content (fallback: plain text only)
  │
  └─> if supported:
      ├─> coloredContent = chalk.blue(content)
      └─> return `${OSC8_START}${url}${OSC8_END}${coloredContent}${OSC8_START}${OSC8_END}`


[失败分支: 终端误判支持]
  ├─ rare, can happen if terminal lies about capabilities
  ├─> if claims support but doesn't: user sees OSC 8 raw sequences (garbage)
  ├─> if claims no support but does: user sees plain URLs instead of clickable links
  └─> no crash, just degraded UX


[主流程 6: 热图生成]

调用方调用 generateHeatmap(dailyActivity, options)
  │
  ├─> calculatePercentiles(dailyActivity) → p25/p50/p75
  │
  ├─> determine date range:
  │       ├─> end = today (00:00:00)
  │       ├─> start = this week's Sunday minus (width-1) weeks
  │       └─> width = min(52, max(10, availableWidth)) (10 weeks min, 52 weeks max)
  │
  ├─> build grid: 7 rows (Sun-Sat) × width columns
  │       ├─> for each date:
  │       │   ├─> if future date → ' '
  │       │   ├─> else intensity = getIntensity(count, percentiles) (0-4)
  │       │   └─> char = getHeatmapChar(intensity) (·/░/▒/▓/█)
  │       └─> track month starts for optional month labels
  │
  └─> assemble output:
      ├─> optional month labels line (spaced evenly)
      ├─> day labels (Mon/Wed/Fri only) + grid rows
      └─> legend line: "Less ░ ▒ ▓ █ More"
```

**证据来源**: `src/utils/markdown.ts:21-280` (Markdown流程), `src/utils/truncate.ts` (截断), `src/utils/displayTags.ts` (标签剥离), `src/utils/hyperlink.ts` (超链接), `src/utils/heatmap.ts` (热图)

---

### 4.6 核心对象生命周期

| 对象/资源 | 所有者 | 创建与初始化 | 共享/隔离 | 持久化 | 重置/失效 | 取消与清理 |
|---|---|---|---|---|---|---|
| `cliHighlightPromise: Promise<CliHighlight|null>` | cliHighlight.ts (模块级) | 首次调用 `getCliHighlightPromise()` 时通过 dynamic import 创建 | 全局单例 Promise，所有调用方共享 await | 无（内存状态） | 已 resolved 的 Promise 永远不会失效/重置，模块卸载时 GC | N/A（懒加载只读，无需取消） |
| `markedConfigured: boolean` | markdown.ts (模块级) | 初始化为 false，`configureMarked()` 首次调用时设为 true | 全局单例标志 | 无（内存状态） | 永久 true，除非进程重启 | N/A（单向转换，无需撤销） |
| `cachedActivity: LogOption[]` | logoV2Utils.ts (模块级) | `getRecentActivity()` 首次加载后设置，存储过滤后的会话列表 | 全局单例缓存 | 无（内存状态） | 模块卸载时 GC，对话轮次间通常不重置（除非代码重载） | N/A（只读缓存，无取消） |
| `cachePromise: Promise<LogOption[]>\|null` | logoV2Utils.ts (模块级) | `getRecentActivity()` 首次调用时创建 Promise，加载中存储 | 全局单例 Promise，共享给并发调用 | 无（内存状态） | Promise resolve/reject 后不再需要，GC | N/A（无取消机制，加载完成即结束） |
| `XML_TAG_BLOCK_PATTERN: RegExp` | displayTags.ts (模块级) | 模块初始化时通过正则字面量创建一次 | 全局单例常量，只读 | 无（模块代码中的常量） | 永久有效，模块卸载时 GC | N/A（常量，无状态） |
| `IDE_CONTEXT_TAGS_PATTERN: RegExp` | displayTags.ts (模块级) | 模块初始化时通过正则字面量创建一次 | 全局单例常量，只读 | 无（模块代码中的常量） | 永久有效，模块卸载时 GC | N/A（常量，无状态） |
| `ISSUE_REF_PATTERN: RegExp` | markdown.ts (模块级) | 模块初始化时通过正则字面量创建一次 | 全局单例常量，只读 | 无（模块代码中的常量） | 永久有效，模块卸载时 GC | N/A（常量，无状态） |
| `OSC8_START/OSC8_END: string` | hyperlink.ts (模块级) | 模块初始化时通过字符串字面量创建一次 | 全局单例常量，只读 | 无（模块代码中的常量） | 永久有效，模块卸载时 GC | N/A（常量，无状态） |
| `claudeOrange: string` | heatmap.ts (模块级) | 模块初始化时通过字符串字面量创建一次 | 全局单例常量，只读 | 无（模块代码中的常量） | 永久有效，模块卸载时 GC | N/A（常量，无状态） |
| `GraphemeSegmenter` (隐式) | stringWidthJavaScript (函数内) | 调用 `Intl.Segmenter(undefined, { granularity: 'grapheme' })` 创建，可能 JS 引擎内部缓存 | 每个 stringWidthJavaScript 调用时可能创建，或引擎共享 | 无（内存状态） | 函数返回后丢弃，GC | N/A（临时对象） |

**生命周期证据**: `src/utils/cliHighlight.ts:20-42` (懒加载 Promise), `src/utils/markdown.ts:21-33` (marked配置), `src/utils/logoV2Utils.ts:183-219` (活动缓存), `src/utils/displayTags.ts:16-51` (正则常量), `src/utils/hyperlink.ts:7-8` (OSC常量), `src/ink/stringWidth.ts:20-203` (GraphemeSegmenter使用)

---

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|--------|--------|-----------------|--------------|--------------|--------------|
| cli-highlight 加载失败 | `loadCliHighlight()` | 内部捕获，返回 null | 否 | 无 | Markdown 渲染回退到无高亮，代码块直接显示 |
| token.type 未知 | `formatToken()` | 内部忽略，返回空字符串 | 否 | 无 | 该 token 不显示 |
| table 对齐未知 | `formatToken()` | 默认左对齐 | 否 | 无 | 表格左对齐 |
| link href 无效 | `formatToken()` | 仍然创建链接（交给终端处理） | 否 | 无 | 链接仍显示，可能无效 |
| stringWidth 计算错误 | `truncateToWidth()` | 无异常，可能截断不够或过多（但很少见） | 否 | 无 | 文本可能溢出或截断过早 |
| sliceAnsi 失败 | `truncateToWidth()` | 可能留下半开的 ANSI 序列（但实现已小心） | 否 | 无 | 样式可能错乱 |
| ellipsis 宽度不是 1 | `truncateToWidth()` | 假设为 1（实际上 `…` 确实是 1 列） | 否 | 无 | 截断可能不准确 |
| query 包含正则特殊字符 | `highlightMatch()` | 不使用正则，使用 indexOf，没问题 | 否 | 无 | 正常匹配 |
| 匹配跨越 ANSI 序列 | `highlightMatch()` | 不会发生，因为 text 是纯文本（highlightMatch 接收的 text 没有 ANSI） | 否 | 无 | 正常高亮 |
| key 重复 | `highlightMatch()` | 使用 idx 作为 key，同一个位置不会多次匹配 | 否 | 无 | React 正常渲染 |
| 标签未闭合 | `stripDisplayTags()` | 正则不匹配，标签保留 | 否 | 无 | 标签可能泄漏到 UI |
| 标签嵌套 | `stripDisplayTags()` | 正则只匹配最外层（因为非贪婪），内层可能保留（但实际系统标签不嵌套） | 否 | 无 | 内层标签可能保留 |
| 标签名大写 | `stripDisplayTags()` | 不匹配，保留（正确，因为用户标签） | 否 | 无 | 正确保留用户标签 |
| supportsHyperlinks 误判 | `createHyperlink()` | 可能在不支持的终端输出乱码，或在支持的终端不输出链接 | 否 | 无 | 乱码或无链接 |
| OSC 8 序列中间换行 | `createHyperlink()` | wrapAnsi 会正确处理（不在 OSC 8 中间换行） | 否 | 无 | 正常显示 |
| content 包含 ANSI | `createHyperlink()` | chalk.blue 会正确包裹（先着色，再包裹 OSC 8） | 否 | 无 | 正确显示 |

| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| strikethrough 禁用 | 全局禁用，模型常用 ~ 表示 "大约" | 模型有时确实想用删除线（如修订），但无法使用 | 避免误解析，更符合模型使用习惯 |
| 表格对齐和宽度计算 | 手动计算列宽，padAligned 对齐 | 实现复杂，处理边缘情况多 | 表格对齐准确，用户体验好 |
| sliceAnsi + stringWidth | 两个独立库配合 | 需要正确安装 stringWidth（有时有 native 依赖问题） | 宽度计算准确，截断安全 |
| 逆高亮（inverse） | 不是颜色，是反色 | 在某些主题下可能不够美观 | 在任何主题下都可见，兼容性好 |
| 正则匹配标签 | 不是 HTML parser | 正则复杂，可能未闭合标签泄漏 | 简单快速，不需要完整解析，避免过度设计 |
| OSC 8 支持检测 + 回退 | 不是总是输出或总是不输出 | 检测可能误判 | 兼容性好，支持的终端有链接，不支持的有回退 |
| cli-highlight 懒加载 | 动态 import | 首次高亮有延迟 | 启动快，不加载不需要的依赖 |

## 6. 现状验收标准

1. **给定**Markdown 标题（H1-H3），**当**applyMarkdown 渲染时，**必须**粗体/下划线 + 换行
2. **给定**Markdown 代码块，**当**cli-highlight 可用时，**必须**语法高亮；否则回退到无高亮
3. **给定**Markdown 列表，**当**applyMarkdown 渲染时，**必须**正确缩进和显示项目符号
4. **给定**Markdown 链接，**当**终端支持 OSC 8 时，**必须**可点击链接；否则回退到纯 URL
5. **给定**Markdown 引用块，**当**applyMarkdown 渲染时，**必须**竖线前缀
6. **给定**Markdown 表格，**当**applyMarkdown 渲染时，**必须**正确对齐和显示边框
7. **给定**含 CJK/表情的文本，**当**stringWidth 计算时，**必须**正确计算为 2 列
8. **给定**含 ANSI 的文本，**当**sliceAnsi 截断时，**必须**不破坏 ANSI 序列
9. **给定**搜索 query，**当**highlightMatch 匹配时，**必须**忽略大小写，不破坏原有样式，支持多个匹配
10. **给定**系统小写标签（如 `<ide_opened_file>`），**当**stripDisplayTags 剥离时，**必须**只剥离标签，保留内容
11. **给定**用户大写标签（如 `<Button>`），**当**stripDisplayTags 剥离时，**必须**保留标签
12. **给定**全部是标签的文本，**当**stripDisplayTags 剥离时，**必须**返回原内容（防止空）

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| Markdown 使用 marked 词法分析 + 自定义格式化器 | `src/utils/markdown.ts:21-33` configureMarked 禁用 strikethrough；`src/utils/markdown.ts:36-47` applyMarkdown 入口；`src/utils/markdown.ts:49-280` formatToken 递归处理；`src/utils/markdown.ts:206-279` table 格式化 | 需补充测试 | 不支持完整 HTML，仅支持有限 Markdown 方言 |
| 宽度处理使用 stringWidth + sliceAnsi | `src/utils/format.ts:301-308` 从 truncate.ts 重新导出；`src/utils/logoV2Utils.ts:108-180` truncatePath 复杂路径截断；`src/utils/markdown.ts:366-381` padAligned 使用 stringWidth 计算填充 | 需补充测试 | stringWidth 有时有 native 依赖问题 |
| 搜索高亮使用逆高亮，不破坏原有样式 | `src/utils/highlightMatch.tsx:9-29` highlightMatch 完整实现 | 需补充测试 | 仅适用于纯文本（无 ANSI），不处理跨 ANSI 匹配 |
| 显示标签只剥离小写标签，使用正则匹配 | `src/utils/displayTags.ts:15` XML_TAG_BLOCK_PATTERN 定义；`src/utils/displayTags.ts:26-29` stripDisplayTags 实现（空时返回原内容）；`src/utils/displayTags.ts:37-39` stripDisplayTagsAllowEmpty 实现（允许空）；`src/utils/displayTags.ts:49-51` stripIdeContextTags 实现（只剥离 IDE 标签） | 需补充测试 | 未闭合标签可能泄漏，嵌套标签只剥离最外层 |
| OSC 8 超链接使用支持检测 + 回退 | `src/utils/hyperlink.ts:7-8` OSC8_START/OSC8_END 定义；`src/utils/hyperlink.ts:24-39` createHyperlink 实现（支持检测 + 着色）；`src/utils/markdown.ts:141-161` link token 处理（mailto 特殊处理）；`src/ink/supports-hyperlinks.ts` 支持检测实现（引用） | 需补充测试 | 检测可能误判，某些终端声称支持但实际有问题 |
| 代码高亮懒加载 cli-highlight + highlight.js | `src/utils/cliHighlight.ts:20-42` 懒加载实现（cliHighlightPromise 缓存）；`src/utils/cliHighlight.ts:50-55` getLanguageName 实现；`src/utils/markdown.ts:72-87` code token 处理（检查 highlight 是否可用） | 需补充测试 | 首次高亮有延迟，某些语言可能不支持 |

### 未覆盖

- 并发加载 cli-highlight 竞态测试
- 极端性能边界测试

## 10. 测试矩阵

| 模块 | 已覆盖功能 | 边界条件处理 | 离线/模拟覆盖 | 实测状态 |
|-----|----------|------------|------------|---------|
| markdown | 标题/代码/引用/表格/链接/强调/列表/issue链接/mailto | 表格对齐、空内容、嵌套token | 完整离线测试（无外部依赖） | ✅ `tests/textFormatting.test.tsx` 46个测试 |
| truncate | truncateToWidth/truncateStartToWidth/truncateToWidthNoEllipsis/truncatePathMiddle/truncate/wrapText | CJK/表情宽度、ANSI序列、字素边界、0宽度边界 | 完整离线测试（使用真实stringWidth实现） | ✅ 2026-11-19 实测 |
| stringWidth | ASCII/CJK/表情/ANSI/组合字符/零宽字符 | 组合字素、区域指示符表情、ambiguous宽度 | 完整离线测试（Bun.stringWidth fallback） | ✅ 通过宽度截断测试间接验证 |
| highlightMatch | 大小写不敏感匹配、多个匹配、空query、无匹配 | React节点输出、key稳定性 | 纯离线测试（不渲染DOM，仅验证节点结构） | ✅ 2026-11-19 实测 |
| displayTags | stripDisplayTags/stripDisplayTagsAllowEmpty/stripIdeContextTags | 小写标签、大写标签保留、未闭合标签、嵌套标签、空结果处理 | 纯离线正则测试 | ✅ 2026-11-19 实测 |
| hyperlink | createHyperlink/supportsHyperlinks | OSC8序列、BEL终止符、fallback到纯URL、supportsHyperlinks开关 | 纯离线测试（通过options.supportsHyperlinks覆盖） | ✅ 2026-11-19 实测 |
| cliHighlight | getCliHighlightPromise/getLanguageName | 懒加载singleton、加载失败回退、语言名称提取 | 离线真实行为测试（无mock，测试真实模块接口） | ⚠️ 仅测试接口契约，实际高亮需外部依赖 |
| heatmap | generateHeatmap | 空活动、未来日期、百分位强度、月份标签、日期范围 | 纯离线测试（固定日期2026-11-19） | ✅ 2026-11-19 实测 |
| logoV2Utils | getLayoutMode/calculateLayoutDimensions/calculateOptimalLeftWidth/formatWelcomeMessage/truncatePath/formatModelAndBilling | 70列阈值、不同布局模式、长路径截断、用户名过长 | 纯离线测试 | ✅ 2026-11-19 实测 |

## 11. 三层证据收集

### 官方文档证据

| 功能 | 文档位置与URL | 关键证据引用 |
|-----|-------------|------------|
| Markdown渲染 | 无公开文档 | 基于marked库约定实现 |
| OSC 8超链接 | https://gist.github.com/egmontkob/eb1123ef7c1e88330541345e7c77a92b | 序列格式 `OSC 8 ; params ; URL BEL TEXT OSC 8 ; ; BEL` |
| stringWidth | Unicode East Asian Width文档 https://unicode.org/reports/tr11/ | 宽字符W/Wide计为2，窄字符N/Narrow计为1，ambiguous依上下文 |

### 本机上游strings证据

从上游flash CLI提取（strings `/opt/homebrew/bin/flash` 过滤相关符号）：

| 符号 | 证据片段 |
|-----|--------|
| marked | `marked`, `marked.lexer`, `marked.Renderer` |
| stringWidth | `stringWidth`, `eastAsianWidth`, `grapheme`, `emojiRegex` |
| cli-highlight | `cli-highlight`, `highlight.js`, `getLanguage` |
| OSC8 | `OSC 8`, `\x1b]8;;`, `\x07` BEL终止符 |
| heatmap | `Less`, `More`, `░`, `▒`, `▓`, `█` |

### 仓库契约证据

| 功能 | 文件位置与具体行号 | 代码契约内容 |
|-----|-----------------|------------|
| 禁用strikethrough | `src/utils/markdown.ts:27-33` | `marked.use({ tokenizer: { del: () => undefined } })` |
| stringWidth优先Bun | `src/ink/stringWidth.ts:215-222` | `Bun.stringWidth(str, { ambiguousIsNarrow: true })` |
| OSC8邮件to不渲染 | `src/utils/markdown.ts:141-161` | `href.startsWith('mailto:')` 返回纯邮箱 |
| displayTags小写匹配 | `src/utils/displayTags.ts:15` | `/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g` |
| cliHighlight singleton | `src/utils/cliHighlight.ts:20` | `cliHighlightPromise: Promise<...> | undefined` |
| 70列布局阈值 | `src/utils/logoV2Utils.ts:35-38` | `columns >= 70 ? 'horizontal' : 'compact'` |

## 12. 测试边界分类

### 离线/模拟覆盖范围

✅ **完整离线覆盖：**
- markdown.ts（所有功能，无需外部依赖）
- truncate.ts（所有功能，仅依赖stringWidth）
- stringWidth.ts（JS fallback完整覆盖）
- displayTags.ts（纯正则）
- highlightMatch.tsx（React节点结构，无需DOM）
- logoV2Utils.ts（纯计算）
- hyperlink.ts（可通过options.supportsHyperlinks覆盖）

⚠️ **部分需要外部依赖：**
- cliHighlight.ts（实际高亮需要cli-highlight和highlight.js包）

❌ **无法离线覆盖：**
- 真实终端渲染（需多终端环境）
- 跨终端兼容性（需实测多种终端）

### 未覆盖路径

| 路径 | 原因 | 风险 |
|-----|------|-----|
| cliHighlight.ts:25-42 实际import失败路径 | 需要模拟import异常 | 低（已有catch处理） |
| 真实终端OSC8渲染 | 需要多终端环境 | 低（已有fallback逻辑） |
| 超大文本块性能 | 性能测试非本次目标 | 中 |

## 13. 回滚计划

如果此次测试补充或任何相关变更引入问题，回滚步骤：

| 回滚项 | 具体操作 | 验证方式 |
|-------|--------|---------|
| 新增测试文件 | `git rm tests/textFormatting.test.tsx` | 文件不再存在 |
| coverage更新 | `git restore docs/architecture/coverage/text-formatting.yaml` | coverage回到原始状态 |
| spec变更 | `git restore docs/superpowers/specs/2026-11-12-text-formatting-design.md` | spec回到原始状态 |
| 审计记录更新 | 编辑`docs/status/design-docs-completeness-audit/04-app-state-terminal-ui.md`移除整改台账 | 仅保留原始Finding |

回滚命令序列：
```bash
git rm tests/textFormatting.test.tsx
git restore docs/architecture/coverage/text-formatting.yaml docs/superpowers/specs/2026-11-12-text-formatting-design.md docs/status/design-docs-completeness-audit/04-app-state-terminal-ui.md
git status  # 确认无变更遗漏
```

验证回滚成功：`bun scripts/check-design-docs.ts` 无新增错误，`bun run test` 无失败测试文件。

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/text-formatting.yaml)

### 本 spec 主拥有的文件组

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|-----|----------|------------------|----------------|
| markdown | Markdown 解析与渲染 | 需补充 | 不拥有 |
| truncate | 宽度感知的截断 | 需补充 | 不拥有 |
| highlight-match | 搜索高亮 | 需补充 | 不拥有 |
| display-tags | 显示标签剥离 | 需补充 | 不拥有 |
| hyperlink | OSC 8 超链接 | 需补充 | 不拥有 |
| cli-highlight | 代码语法高亮 | 需补充 | highlight.js（外部） |
| format | 格式化工具（从 truncate.ts 重新导出） | 需补充 | 不拥有 |
| logo-v2-utils | Logo v2 布局（使用 truncatePath） | 需补充 | 不拥有 |

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|--------|-------|-------|
| P2 | strikethrough 被禁用，模型有时确实想用删除线（如修订） | 考虑重新启用 strikethrough，但处理模型常用的 ~ 表示 "大约" 的情况（如单个 ~ 不解析，只有 ~~ 才解析） | 中（改变 Markdown 解析行为） | 测试 ~~text~~ 解析为删除线，单个 ~ 不解析 | M | 待运行验证 |
| P2 | 表格在窄终端溢出，没有自动换行或滚动 | 考虑表格自动换行或水平滚动 | 中（改变表格渲染逻辑） | 测试窄终端下表格不溢出 | M | 待运行验证 |
| P2 | text-formatting 无专门测试文件 | 补充 text-formatting 单元测试：Markdown 各种 token、宽度计算和截断、搜索高亮、标签剥离、链接创建 | 低（仅新增测试） | 每个核心模块有对应测试文件，覆盖主要路径和边界情况 | M | 待运行验证 |
| P2 | markdown.ts 和 truncate.ts 分离（truncate 从 format.ts 重新导出） | 考虑合并或更清晰分离，避免混淆 | 低（仅重构，不改变行为） | 代码结构更清晰 | S | 待运行验证 |
| P2 | cliHighlight 懒加载 Promise 没有超时 | 考虑添加超时，超时后回退到无高亮 | 低（仅改进错误处理） | 测试加载超时时回退到无高亮 | S | 待运行验证 |
| P3 | 热图只支持 GitHub 风格，没有自定义样式或颜色选项 | 考虑添加热图自定义样式或颜色选项 | 低（仅新增功能） | 用户可自定义热图样式 | L | 设计推断 |
| P3 | 水平滚动没有动画，只是切换窗口 | 考虑添加水平滚动动画 | 低（仅 UI 改进） | 滚动更平滑 | L | 待运行验证 |
