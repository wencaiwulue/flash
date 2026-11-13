---
id: magic-docs
batch: 7
title: Magic Docs 文档生成与同步设计
date: 2026-11-12
status: draft
---

# Magic Docs 文档生成与同步设计

## 1. 问题与约束

Magic Docs 是一个轻量级的文档自动更新系统，它在对话过程中持续跟踪带有特殊标记的 Markdown 文档，并在对话空闲时使用子代理自动更新这些文档，以保持它们与对话内容的同步。

与 documentation-system（用于生成和管理结构化的 commit 设计文档）不同，Magic Docs 是对话驱动的文档更新工具。

**约束条件：**
- 只在文件被读取时通过特殊 header 发现文档
- 不扫描整个仓库或批量生成文档
- 只跟踪单个会话中读取过的文档
- 使用子代理在后台更新单个文档，而非系统级文档

## 2. 设计理由与备选方案

### 通过 FileReadTool 监听发现文档

**设计**：仅在文件被读取时通过 `registerFileReadListener` 发现 Magic Docs。

**备选方案**：
- 启动时扫描整个仓库寻找 `.md` 文件并检测 header → 不采用，避免无必要的文件系统扫描
- 提供显式命令让用户注册 Magic Docs → 不采用，增加用户负担

**选择理由**：
- 保持 Magic Docs 轻量级，只跟踪用户实际使用的文档
- 符合按需原则，不假设用户需要跟踪所有文档

### 仅在对话空闲时更新

**设计**：仅当最后一轮助手消息没有工具调用时才触发更新。

**备选方案**：
- 每次采样后都更新 → 不采用，可能干扰用户正在进行的任务
- 使用固定时间间隔后台更新 → 不采用，信息可能不完整
- 用户显式触发更新 → 不采用，增加用户负担

**选择理由**：
- 避免在用户正在执行操作时干扰（工具调用表示任务进行中）
- 减少不必要的更新（用户可能正在调试或探索，信息还不完整）
- 利用对话空闲时间，不影响用户体验

### 子代理仅允许 Edit 工具且只能编辑目标文档

**设计**：通过自定义 `canUseTool` 限制子代理：
- 只允许 `FILE_EDIT_TOOL_NAME`
- 只允许编辑目标文档路径

**备选方案**：
- 允许更多工具（Read、Bash 等）→ 不采用，安全风险高
- 不限制编辑路径 → 不采用，可能意外修改其他文件

**选择理由**：
- 安全性：防止 Magic Docs 子代理修改其他文件或执行任意命令
- 简单性：限制工具集使行为更可预测
- 完整性：对话历史已通过 `forkContextMessages` 传递，通常不需要再次读取

### 使用 forkContextMessages 传递对话历史

**设计**：通过 `forkContextMessages` 将整个对话历史传递给子代理，而非手动构建消息序列。

**备选方案**：
- 手动提取对话中的关键信息 → 不采用，可能遗漏重要上下文
- 只传递最近 N 条消息 → 不采用，可能丢失重要历史

**选择理由**：
- 完整性：子代理能基于完整对话上下文更新文档
- 简单性：不需要设计摘要或选择逻辑
- 一致性：与 AgentTool 的 fork 行为保持一致

### 每次更新前重新读取文件并重新检测 header

**设计**：每次更新时不依赖缓存的 header 信息，而是：
1. 克隆缓存并删除目标文件条目
2. 重新读取文件内容
3. 重新检测 header 和指令

**备选方案**：
- 首次发现时缓存 header 信息，后续直接使用 → 不采用，用户可能手动修改 header
- 信任缓存的文件内容 → 不采用，文件可能被手动修改

**选择理由**：
- 鲁棒性：用户可能手动修改了 header 或指令
- 正确性：确保基于最新文件状态更新
- 简单性：不需要维护复杂的缓存失效逻辑

### 不提供更新结果反馈

**设计**：Magic Docs 更新在后台完成，不向用户显示任何结果或错误。

**备选方案**：
- 显示更新摘要 → 不采用，非侵入性优先
- 显示错误信息 → 不采用，避免干扰主对话
- 提供更新状态指示器 → 不采用，UI 复杂化

**选择理由**：
- 非侵入性：Magic Docs 是后台辅助功能，不应干扰主对话
- 简洁性：避免 UI 复杂化
- 用户可以自行检查文档内容变化

### 支持自定义提示模板

**设计**：允许用户在 `~/.claude/magic-docs/prompt.md` 提供自定义提示模板，使用 `{{variable}}` 语法替换变量。

**备选方案**：
- 只使用内置提示，不支持自定义 → 不采用，灵活性不足
- 提供配置选项而非文件模板 → 不采用，不够直观

**选择理由**：
- 灵活性：用户可以根据自己的需求调整更新行为
- 可扩展性：可以添加新变量而不破坏兼容性
- 符合项目其他自定义机制的模式

### 单轮替换变量避免双重替换

**设计**：在 `substituteVariables` 中使用单次遍历替换，替换函数直接返回值而非使用 `$` 反向引用。

**备选方案**：
- 逐个替换（先替换 `{{docContents}}`，再替换 `{{docPath}}` 等）→ 不采用，可能双重替换
- 使用正则表达式的 `$&` 或 `$1` 反向引用 → 不采用，用户内容中的 `$` 会被误解析

**选择理由**：
- 防止双重替换：如果用户文档内容恰好包含 `{{docTitle}}` 等模式，不会被再次替换
- 防止 `$` 反向引用破坏：用户文档内容中的 `$1`、`$&` 等不会被正则引擎误解析

## 3. 目标与非目标

### 目标

- 提供一个简单的标记机制，让用户可以声明某个文档需要自动更新
- 在对话空闲时自动更新标记的文档，基于对话中的新信息
- 保持文档 header 和自定义指令不变
- 允许用户自定义更新提示模板
- 在会话清理时清除跟踪状态

### 非目标

- 不扫描整个仓库寻找 Magic Docs
- 不提供文档初始化或批量创建
- 不跨会话保留跟踪状态（每次会话重新发现）
- 不提供文档审查或验证
- 不与 Git 集成或自动提交

## 4. 架构、模块与数据流

### 模块设计卡：文档发现与跟踪

**入口签名与关键类型：**

```typescript
// src/services/MagicDocs/magicDocs.ts
const MAGIC_DOC_HEADER_PATTERN = /^#\s*MAGIC\s+DOC:\s*(.+)$/im
const ITALICS_PATTERN = new RegExp('^(?:_|\\*)(.+?)(?:_|\\*)\\s*$', 'm')

type MagicDocInfo = {
  path: string
}

const trackedMagicDocs = new Map<string, MagicDocInfo>()

export function detectMagicDocHeader(
  content: string
): { title: string; instructions?: string } | null

export function registerMagicDoc(filePath: string): void

export function clearTrackedMagicDocs(): void

export async function initMagicDocs(): Promise<void>
```

**输入输出：**
- 输入：文件路径、文件内容字符串
- 输出：`detectMagicDocHeader` 返回 `{ title, instructions? }` 或 `null`
- 副作用：向 `trackedMagicDocs` Map 添加/删除条目

**文档与缓存状态：**
- 文档状态：仅在内存中跟踪，不持久化到磁盘
- 缓存状态：`trackedMagicDocs` 是模块级全局变量，会话结束自动清除
- Header 检测：每次更新时重新检测，不缓存检测结果

**发现流程：**

```
用户/代理调用 Read 工具
      ↓
FileReadTool.call() 执行读取
      ↓
触发 registerFileReadListener 回调
      ├─ 参数: (filePath: string, content: string)
      ↓
detectMagicDocHeader(content)
      ├─ 匹配 /^#\s*MAGIC\s+DOC:\s*(.+)$/im
      ├─ 检查后续行是否有 * &lt;指令&gt; * 斜体行
      └─ 返回 { title, instructions? } 或 null
      ↓
如果是 Magic Doc → registerMagicDoc(filePath)
      └─ trackedMagicDocs.set(filePath, { path: filePath })
         (仅在未跟踪时添加)
```

**跟踪清理时机：**
1. 文件被删除或不可读（更新时检测）
2. 文件不再包含 Magic Doc header（更新时检测）
3. 调用 `clearSessionCaches()`（`/clear` 命令）
4. 进程退出/会话结束

**错误与隐私：**
- 错误处理：文件读取失败静默从跟踪移除，不抛异常
- 隐私边界：仅读取显式被 Read 工具读取的文件，不扫描仓库
- 权限：通过现有 FileReadTool 权限模型，无额外权限要求

**设计取舍与备选：**
- **按需发现 vs 启动扫描**：选择按需发现，避免无必要的文件系统扫描
  - 备选：启动时扫描 `**/*.md` → 拒绝，性能和隐私考虑
- **仅通过 Read 发现 vs 显式命令**：选择仅通过 Read 发现，保持轻量
  - 备选：`/magic-docs add <path>` 命令 → 拒绝，增加复杂度
- **内存跟踪 vs 持久化**：选择内存跟踪，会话间重置
  - 备选：持久化到 `~/.claude/magic-docs/tracked.json` → 拒绝，用户可能不希望跨会话跟踪

**源码证据：**
- `src/services/MagicDocs/magicDocs.ts:31-94` - 检测、注册、状态管理
- `src/services/MagicDocs/magicDocs.ts:242-254` - `initMagicDocs` 初始化监听器
- `src/commands/clear/caches.ts:25,149` - 会话清理集成

---

### 模块设计卡：文档更新执行

**入口签名与关键类型：**

```typescript
// src/services/MagicDocs/magicDocs.ts
async function updateMagicDoc(
  docInfo: MagicDocInfo,
  context: REPLHookContext
): Promise<void>

const updateMagicDocs = sequential(async function (
  context: REPLHookContext
): Promise<void>)

function getMagicDocsAgent(): BuiltInAgentDefinition {
  return {
    agentType: 'magic-docs',
    whenToUse: 'Update Magic Docs',
    tools: [FILE_EDIT_TOOL_NAME],
    model: 'sonnet',
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => '',
  }
}
```

**输入输出：**
- 输入：`MagicDocInfo`（文档路径）、`REPLHookContext`（消息、上下文、工具上下文）
- 输出：无返回值，异步执行更新
- 副作用：通过子代理调用 Edit 工具修改磁盘文件

**文档与缓存状态：**
- 文档状态：每次更新前重新读取，重新检测 header
- 缓存隔离：克隆 `FileStateCache` 并删除目标文件条目，避免 dedup
  ```typescript
  const clonedReadFileState = cloneFileStateCache(toolUseContext.readFileState)
  clonedReadFileState.delete(docInfo.path)
  ```
- 主线程缓存不受影响：克隆操作隔离了 Magic Docs 的读取

**更新流程：**

```
registerPostSamplingHook 触发
      ↓
updateMagicDocs(context) 检查条件
      ├─ querySource === 'repl_main_thread'?
      ├─ hasToolCallsInLastAssistantTurn(messages)?
      └─ trackedMagicDocs.size > 0?
      ↓
sequential() 串行处理每个文档
      ↓
updateMagicDoc(docInfo, context)
      ├─ 克隆缓存 + 删除目标文件条目
      ├─ FileReadTool.call({ file_path })
      │   ├─ 成功 → currentDoc = content
      │   └─ 失败 (ENOENT/EACCES) → trackedMagicDocs.delete(path) → return
      ├─ detectMagicDocHeader(currentDoc)
      │   └─ 无 header → trackedMagicDocs.delete(path) → return
      ├─ buildMagicDocsUpdatePrompt(...)
      ├─ runAgent() 启动 magic-docs 子代理
      │   ├─ agentDefinition: getMagicDocsAgent()
      │   ├─ promptMessages: [createUserMessage(userPrompt)]
      │   ├─ forkContextMessages: messages (完整对话历史)
      │   ├─ canUseTool: 仅允许 Edit 且仅该路径
      │   ├─ isAsync: true
      │   └─ querySource: 'magic_docs'
      └─ for await 消费消息流 → 静默完成
```

**空闲检测逻辑：**
```typescript
// 仅当最后一轮助手消息没有工具调用时更新
const hasToolCalls = hasToolCallsInLastAssistantTurn(messages)
if (hasToolCalls) return
```

**错误与隐私：**
- 错误处理：
  - 文件不存在/不可读 → 静默从跟踪移除
  - header 消失 → 静默从跟踪移除
  - 子代理失败 → 异常由 `runAgent` 处理，不显示给用户
- 隐私边界：
  - 子代理 `canUseTool` 严格限制：仅 Edit，仅目标路径
  - `forkContextMessages` 传递对话历史，但更新提示明确告诉模型"不要提及 Magic Docs"
- 权限：通过现有工具权限模型，子代理继承受限权限

**设计取舍与备选：**
- **静默更新 vs 反馈显示**：选择静默，非侵入性优先
  - 备选：显示 "Updated magic doc: ..." → 拒绝，干扰主对话
  - 备选：状态指示器 → 拒绝，UI 复杂度
- **完整历史 vs 摘要 vs 最近 N 条**：选择完整历史，上下文完整性优先
  - 备选：仅最近 100 条消息 → 拒绝，可能丢失重要上下文
  - 备选：生成摘要 → 拒绝，增加 token 成本和复杂度
- **空闲更新 vs 每次采样后更新 vs 定时更新**：选择空闲更新
  - 备选：每次采样后都更新 → 拒绝，可能干扰用户任务
  - 备选：每 5 分钟定时更新 → 拒绝，信息可能不完整

**源码证据：**
- `src/services/MagicDocs/magicDocs.ts:114-212` - `updateMagicDoc` 核心实现
- `src/services/MagicDocs/magicDocs.ts:217-240` - `updateMagicDocs` 钩子与串行执行
- `src/utils/hooks/postSamplingHooks.ts` - 采样后钩子系统

---

### 模块设计卡：提示构造与模板

**入口签名与关键类型：**

```typescript
// src/services/MagicDocs/prompts.ts
export async function buildMagicDocsUpdatePrompt(
  docContents: string,
  docPath: string,
  docTitle: string,
  instructions?: string
): Promise<string>

function substituteVariables(
  template: string,
  variables: Record<string, string>
): string

async function loadMagicDocsPrompt(): Promise<string>
function getUpdatePromptTemplate(): string
```

**输入输出：**
- 输入：文档内容、路径、标题、可选指令
- 输出：构造完成的提示字符串
- 副作用：可能读取 `~/.claude/magic-docs/prompt.md`（自定义模板）

**文档与缓存状态：**
- 模板加载：每次调用 `buildMagicDocsUpdatePrompt` 时重新加载，不缓存
- 变量替换：单轮替换，避免双重替换

**提示构造流程：**

```
buildMagicDocsUpdatePrompt(docContents, docPath, docTitle, instructions?)
      ↓
loadMagicDocsPrompt()
      ├─ 尝试读取 ~/.claude/magic-docs/prompt.md
      └─ 不存在/失败 → 使用 getUpdatePromptTemplate() 内置模板
      ↓
构造 customInstructions 块 (如果有)
      ↓
substituteVariables(template, variables)
      ├─ 单轮正则: /\{\{(\w+)\}\}/g
      ├─ 变量: docContents, docPath, docTitle, customInstructions
      └─ 直接返回值，不使用 $ 反向引用
      ↓
返回最终提示字符串
```

**提示模板结构：**
```
IMPORTANT: This message and these instructions are NOT part of the actual user conversation.
Based on the user conversation above...

<current_doc_content>
{{docContents}}
</current_doc_content>

Document title: {{docTitle}}
{{customInstructions}}

Your ONLY task is to use the Edit tool...

CRITICAL RULES FOR EDITING:
- Preserve the Magic Doc header exactly as-is
- Keep the document CURRENT - NOT a changelog
- Update IN-PLACE - don't append historical notes
- Remove outdated information
- Fix errors, keep organized

DOCUMENTATION PHILOSOPHY:
- BE TERSE - high signal only
- Document OVERVIEWS, ARCHITECTURE, ENTRY POINTS
- Focus: WHY, HOW components connect, WHERE to start
- Skip: obvious details, exhaustive API docs

Use the Edit tool with file_path: {{docPath}}
```

**可用变量：**
- `{{docContents}}` - 当前文档完整内容
- `{{docPath}}` - 文档绝对路径
- `{{docTitle}}` - 从 header 提取的标题
- `{{customInstructions}}` - 可选的文档特定指令块（或空字符串）

**错误与隐私：**
- 错误处理：自定义模板加载失败 → 静默回退到内置模板
- 隐私边界：模板仅从 `~/.claude/magic-docs/prompt.md` 加载，不从项目目录加载
- 安全：单轮替换避免用户内容中的 `{{var}}` 被再次替换，避免 `$` 反向引用注入

**设计取舍与备选：**
- **单轮替换 vs 逐变量替换**：选择单轮替换，避免双重替换
  - 备选：先替换 `{{docContents}}`，再替换其他 → 拒绝，如果文档内容包含 `{{docTitle}}` 会被再次替换
- **直接返回值 vs `$&` 反向引用**：选择直接返回值，避免 `$` 注入
  - 备选：`return variables[key]` → 接受，替换函数不处理 `$`
- **每次重新加载 vs 缓存模板**：选择每次重新加载，简单性优先
  - 备选：启动时加载一次 → 拒绝，用户可能编辑模板后希望立即生效

**源码证据：**
- `src/services/MagicDocs/prompts.ts:8-59` - 内置模板定义
- `src/services/MagicDocs/prompts.ts:66-76` - 自定义模板加载
- `src/services/MagicDocs/prompts.ts:81-93` - 变量替换
- `src/services/MagicDocs/prompts.ts:98-127` - 提示构造入口

---

### 模块设计卡：backgroundHousekeeping 集成

**入口签名与关键类型：**

```typescript
// src/utils/backgroundHousekeeping.ts
export function startBackgroundHousekeeping(): void

// src/services/MagicDocs/magicDocs.ts
export async function initMagicDocs(): Promise<void> {
  if (process.env.USER_TYPE === 'ant') {
    registerFileReadListener((filePath: string, content: string) => {
      const result = detectMagicDocHeader(content)
      if (result) registerMagicDoc(filePath)
    })
    registerPostSamplingHook(updateMagicDocs)
  }
}
```

**输入输出：**
- 输入：无
- 输出：无
- 副作用：注册监听器和钩子、启动后台任务

**文档与缓存状态：**
- 初始化时机：`startBackgroundHousekeeping()` 在启动时调用
- 功能标志：仅当 `process.env.USER_TYPE === 'ant'` 时启用
- 无持久化状态：所有监听器和钩子在进程退出时自动清理

**集成流程：**

```
CLI 启动
      ↓
startBackgroundHousekeeping()
      ├─ void initMagicDocs()
      ├─ void initSkillImprovement()
      ├─ initAutoDream()
      ├─ void autoUpdateMarketplacesAndPluginsInBackground()
      ├─ (EXTRACT_MEMORIES) extractMemoriesModule.initExtractMemories()
      ├─ (LODESTONE + 交互) ensureDeepLinkProtocolRegistered()
      └─ setTimeout(runVerySlowOps, 10分钟).unref()
      ↓
initMagicDocs()
      ├─ 检查 process.env.USER_TYPE === 'ant'
      ├─ registerFileReadListener(...)
      └─ registerPostSamplingHook(updateMagicDocs)
      ↓
后续对话中：
      ├─ Read 工具触发 → 发现 Magic Docs
      └─ 采样后钩子触发 → 空闲时更新
```

**后台任务调度：**
```typescript
// 10 分钟后运行慢速操作
const DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION = 10 * 60 * 1000

// 如果用户最近 1 分钟有交互，推迟运行
if (getIsInteractive() && 
    getLastInteractionTime() > Date.now() - 1000 * 60) {
  setTimeout(runVerySlowOps, 10分钟).unref()
  return
}
```

**错误与隐私：**
- 错误处理：`initMagicDocs()` 使用 `void` 调用，不等待不抛异常
- 隐私边界：仅在 `USER_TYPE === 'ant'` 时启用（内部构建）
- 进程生命周期：所有后台任务使用 `.unref()`，不阻止进程退出

**设计取舍与备选：**
- **条件启用 vs 始终启用**：选择条件启用，仅内部构建可用
  - 备选：始终启用 → 拒绝，该功能仍在实验中
- **void 调用 vs await**：选择 void 调用，不阻塞启动
  - 备选：await initMagicDocs() → 拒绝，启动速度优先
- **启动时初始化 vs 懒加载**：选择启动时初始化，一致性优先
  - 备选：第一次 Read 时初始化 → 拒绝，增加复杂度

**源码证据：**
- `src/utils/backgroundHousekeeping.ts:31-33` - `initMagicDocs()` 调用
- `src/utils/backgroundHousekeeping.ts:1-94` - 完整后台任务系统
- `src/services/MagicDocs/magicDocs.ts:242-254` - `initMagicDocs` 实现

---

### 模块设计卡：缓存与状态管理

**入口签名与关键类型：**

```typescript
// src/services/MagicDocs/magicDocs.ts
const trackedMagicDocs = new Map<string, MagicDocInfo>()
export function clearTrackedMagicDocs(): void

// src/commands/clear/caches.ts
export async function clearSessionCaches(
  preservedAgentIds: ReadonlySet<string> = new Set()
): Promise<SessionCacheClearResult>

// src/utils/fileStateCache.ts
export function cloneFileStateCache(
  cache: FileStateCache
): FileStateCache
```

**输入输出：**
- 输入：`clearSessionCaches` 可选 `preservedAgentIds`
- 输出：`clearSessionCaches` 返回 `{ completed, failed }`
- 副作用：清空 `trackedMagicDocs` Map

**状态设计：**

| 状态项 | 类型 | 位置 | 生命周期 | 持久化 |
|--------|------|------|----------|--------|
| `trackedMagicDocs` | `Map<string, MagicDocInfo>` | 模块级全局 | 会话内 | 否 |
| FileStateCache 克隆 | `FileStateCache` | `updateMagicDoc` 局部 | 单次更新 | 否 |

**状态清理流程：**

```
/clear 命令
      ↓
clearSessionCaches(preservedAgentIds?)
      ├─ ... 其他缓存清理 ...
      ├─ clearTrackedMagicDocs()
      │   └─ trackedMagicDocs.clear()
      └─ ... 更多缓存清理 ...
      ↓
返回 { completed: [..., 'magic docs', ...], failed: [...] }
```

**更新时缓存隔离：**
```typescript
// 克隆缓存并删除目标文件条目
const clonedReadFileState = cloneFileStateCache(toolUseContext.readFileState)
clonedReadFileState.delete(docInfo.path)
const clonedToolUseContext: ToolUseContext = {
  ...toolUseContext,
  readFileState: clonedReadFileState,
}

// 使用克隆的上下文重新读取
const result = await FileReadTool.call(
  { file_path: docInfo.path },
  clonedToolUseContext
)
```

**错误与隐私：**
- 错误处理：`clearSessionCaches` 捕获并记录单个缓存清理失败，继续其他清理
- 隐私边界：`preservedAgentIds` 机制允许后台任务保留状态，`clearTrackedMagicDocs` 无条件清空（无 per-agent 状态）
- 内存安全：`Map.clear()` 立即释放引用，GC 可回收

**设计取舍与备选：**
- **会话间重置 vs 持久化跟踪**：选择会话间重置，隐私和简单性优先
  - 备选：持久化到 `~/.claude/magic-docs/state.json` → 拒绝，用户可能不希望跨会话记住
- **无条件清空 vs 保留选项**：选择无条件清空，`/clear` 语义明确
  - 备选：`/clear --preserve-magic-docs` → 拒绝，增加复杂度
- **缓存克隆 vs 直接读取并绕过 dedup**：选择缓存克隆，隔离性优先
  - 备选：FileReadTool 添加 `force: true` 选项 → 拒绝，需要修改工具接口

**源码证据：**
- `src/services/MagicDocs/magicDocs.ts:38-46` - 状态定义与清空
- `src/commands/clear/caches.ts:47-198` - 会话缓存清理
- `src/services/MagicDocs/magicDocs.ts:124-129` - 缓存克隆

---

### Header 格式

Magic Doc header 必须出现在文件开头，格式为：

```markdown
# MAGIC DOC: <title>
```

可选地，在 header 后（允许一个空行）添加斜体指令行：

```markdown
# MAGIC DOC: <title>
* &lt;自定义指令&gt; *
```

该指令会被传递给更新代理，作为文档特定的更新指南。

### 跟踪状态（不持久化）

跟踪状态保存在内存中的 `Map<string, MagicDocInfo>`：
- Key：文件绝对路径
- Value：`{ path: string }`（仅保存路径，状态在每次更新时重新读取）

**重要限制：文档跟踪不跨会话持久化**
- 每次启动 Claude Code，`trackedMagicDocs` 为空
- 需要重新读取文档才能重新发现和跟踪
- `/clear` 命令会清空当前会话的所有跟踪状态
- 这是有意的设计：避免跟踪用户可能已不再关心的文档，减少隐私顾虑

跟踪状态在以下情况下被清除：
- 文件被删除或不可读（更新时检测）
- 文件不再包含 Magic Doc header（更新时检测）
- 调用 `clearSessionCaches()`（`/clear` 命令）
- 会话结束/进程退出

### 顺序执行

多个文档通过 `sequential()` 包装器串行更新，避免并发文件编辑冲突。

### 与 documentation-system 的区别

| 维度 | Magic Docs | documentation-system |
|------|------------|---------------------|
| **触发方式** | 对话空闲时后台自动更新 | 显式 `/commit` 命令触发 |
| **文档发现** | 读取时通过 header 发现 | 扫描 `docs/` 目录的特定结构 |
| **更新时机** | 对话进行中持续增量更新 | 提交时一次性生成完整文档 |
| **历史处理** | 保持文档最新，删除过时内容 | 保留历史，按提交组织 |
| **用户控制** | 低侵入，静默更新 | 高控制，显式操作 |
| **用途** | 活文档、笔记、探索记录 | 正式设计文档、变更记录 |
| **实现位置** | `src/services/MagicDocs/` | `src/commands/commit/` |
| **持久化** | 不跨会话跟踪 | 永久文档，Git 版本控制 |

### 已知限制与边界

**1. 文档跟踪不持久化**
- 会话间重置，需要重新读取文档才能跟踪
- 无恢复机制：如果进程崩溃，跟踪状态丢失
- 边界：这是设计选择，而非 bug

**2. 长对话历史的 Token 成本**
- 每次更新通过 `forkContextMessages` 传递完整对话历史
- 长会话可能产生高 token 消耗
- 边界：无摘要、无截断，完整性优先于成本
- 缓解：仅在空闲时更新，不频繁触发

**3. 更新错误不可见**
- 子代理失败静默处理，不显示给用户
- 无更新状态反馈：用户不知道更新是否成功
- 无更新历史：无法查看文档何时被更新、更新了什么
- 边界：非侵入性优先于可观测性

**4. 提示模板与质量边界**
- 更新质量依赖于模型判断"什么是重要的新信息"
- 模型可能遗漏用户认为重要的内容
- 模型可能添加用户认为不重要的内容
- 自定义模板可以调整行为，但需要用户编写
- 边界：这是 LLM 驱动系统的固有特性，文档质量需要用户审核

## 5. 失败语义与工程取舍

| 失败场景 | 处理方式 |
|---|---|
| 文件不存在或不可读 | 从 `trackedMagicDocs` 移除该文档，静默跳过 |
| 文件不再包含 Magic Doc header | 从 `trackedMagicDocs` 移除该文档，静默跳过 |
| 子代理更新失败 | 抛出异常（由 `runAgent` 处理） |
| 文档更新过程中文件被手动修改 | 下次更新会重新读取，使用最新内容 |
| 多个文档同时更新 | 通过 `sequential()` 串行执行，避免冲突 |

### 工程取舍

- **按需发现 vs 扫描仓库**：选择按需发现，避免无必要的文件系统扫描
- **空闲时更新 vs 实时更新**：选择空闲更新，避免干扰用户任务
- **严格工具限制 vs 更多能力**：选择严格限制，安全性优先
- **完整历史传递 vs 摘要传递**：选择完整历史，上下文完整性优先
- **静默更新 vs 结果反馈**：选择静默，非侵入性优先

## 6. 现状验收标准

### 文档发现

- 必须在文件被读取时通过 `registerFileReadListener` 自动发现
- 必须检测 `# MAGIC DOC: <title>` 格式的 header
- 必须支持 header 后的可选斜体指令行

### 文档更新

- 必须仅在最后一轮助手消息没有工具调用时触发
- 必须每次更新前重新读取文件并重新检测 header
- 必须克隆缓存并删除目标文件条目以避免 dedup
- 子代理必须只允许 Edit 工具且只能编辑目标文档

### 状态管理

- 跟踪状态必须保存在内存中，不跨会话持久化
- `/clear` 命令必须清除所有跟踪状态
- 文件不再存在或 header 消失时必须从跟踪中移除

### 自定义提示

- 必须支持用户在 `~/.claude/magic-docs/prompt.md` 提供自定义模板
- 必须使用 `{{variable}}` 语法替换变量
- 必须避免双重替换和 `$` 反向引用问题

## 7. 代码与测试证据

### 现有测试

当前 Magic Docs 功能无专门测试文件，需补充测试覆盖。

### 实现证据

- `src/services/MagicDocs/magicDocs.ts`：Magic Docs 核心实现
- `src/services/MagicDocs/prompts.ts`：提示模板与构造
- `src/commands/clear/caches.ts`：会话清理集成
- `src/utils/backgroundHousekeeping.ts`：后台初始化集成
- `src/tools/FileReadTool/FileReadTool.ts`：文件读取监听器

### 未覆盖场景

- 文档发现与跟踪的完整流程测试
- 子代理更新文档的端到端测试
- 自定义提示模板替换测试
- 并发文档更新冲突测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/magic-docs.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|-----|-----------|------------------|----------------|
| magic-docs-core | 文档发现、跟踪状态、更新执行、子代理调用 | 无 |  |
| magic-docs-prompts | 提示模板、自定义加载、变量替换 | 无 |  |
| magic-docs-init | 初始化与后台集成 | 无 |  |
| magic-docs-caches | 会话清理与缓存清除 | 无 |  |

**相关子系统：**
- FileReadTool：文件读取与监听器注册
- AgentTool / runAgent：子代理运行框架
- postSamplingHooks：采样后钩子系统
- clearSessionCaches：会话缓存清理框架
- `src/tools/read.ts`：FileReadTool 监听器集成

### 相关子系统

- Documentation System：结构化 commit 设计文档生成（不同机制）
- Agent Tool：子代理运行基础
- Session Persistence：会话持久化（不同机制）

## 9. 改进建议

1. **添加测试覆盖**：当前 Magic Docs 功能无专门测试文件，建议补充测试覆盖文档发现、跟踪、更新流程。

2. **提供更新状态反馈**：考虑添加可选的更新状态指示器，让用户知道文档是否已更新及是否成功。

3. **支持批量文档更新**：当前仅跟踪单个会话中读取过的文档，考虑添加显式命令让用户注册多个文档进行批量更新。

4. **添加更新历史**：考虑记录文档更新历史，支持回滚到之前的版本。

5. **与 Git 集成**：考虑添加可选的 Git 集成，自动提交文档更新。
