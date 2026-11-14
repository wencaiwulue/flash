---
id: commands-framework
batch: 4
title: Commands Framework 命令聚合、解析与执行设计
date: 2026-11-12
status: draft
---

# Commands Framework 命令聚合、解析与执行设计

## 1. 问题与约束

Commands Framework 需要解决以下核心问题与约束：

1. **多源命令聚合**：统一处理内建命令、Skill、Plugin、MCP 四种来源
2. **类型安全执行**：三种命令类型（Prompt、Local、Local-JSX）有不同执行模型
3. **远程控制安全**：远程模式下命令执行需严格白名单控制
4. **懒加载性能**：避免启动时加载所有命令实现
5. **歧义处理**：区分斜杠命令与文件路径（如 /var/log）
6. **错误边界**：命令执行失败不应导致整个应用崩溃

## 2. 设计理由与备选方案

### 2.1 懒加载命令实现

- **备选方案**：
  - 静态导入所有命令：增加启动时间和体积
  - 动态 import 但不加封装：错误处理分散
- **选择理由**：减小启动体积（insights 命令单独 110KB），命令按需加载，统一错误处理点
- **证据**：`src/commands.ts` 中 insights 命令的懒加载 shim

### 2.2 Discriminated Union 命令类型

- **备选方案**：
  - 继承层次结构：更复杂，TypeScript 模式匹配不便
  - 单一类型带可选字段：类型不安全
- **选择理由**：TypeScript 类型收窄支持优秀，执行路径清晰分离，便于扩展新命令类型
- **证据**：`src/types/command.ts` 中的类型定义

### 2.3 来源按优先级聚合，同名覆盖

- **备选方案**：
  - 严格去重报错：不够灵活
  - 合并同名命令：语义不清晰
- **选择理由**：用户可通过项目级 Skill 覆盖内建命令，插件可扩展而不修改核心代码
- **证据**：`src/commands.ts` 中 loadAllCommands 的顺序：Bundled → Builtin Plugin → Skill Dir → Workflow → Plugin → Plugin Skill → Builtin

### 2.4 Prompt 命令支持 inline/fork 双模式

- **备选方案**：
  - 仅 inline：无法隔离副作用
  - 仅 fork：简单技能开销过大
- **选择理由**：简单技能用 inline 低延迟，复杂/有副作用技能用 fork 隔离性好
- **证据**：`processSlashCommand.tsx` 中的 `executeForkedSlashCommand`

### 2.5 Remote Control 分层安全模型

- **备选方案**：
  - 全开放：安全风险高
  - 全禁止：远程功能不可用
- **选择理由**：
  - Defense in depth：skipSlashCommands 默认 true
  - 本地 UI 命令（local-jsx）在远程无意义，直接阻止
  - Prompt 命令展开为文本，天然安全
  - Local 命令需显式审核加入白名单
- **证据**：`commands.ts` 中的 `REMOTE_SAFE_COMMANDS`、`BRIDGE_SAFE_COMMANDS`、`isBridgeSafeCommand`

### 2.6 isMeta 消息用于元数据

- **备选方案**：
  - 全部可见：用户界面嘈杂
  - 使用 SystemMessage：模型可能忽略或权重不同
- **选择理由**：保持用户界面简洁，模型看到完整上下文，与常规用户输入格式一致，模型行为可预期
- **证据**：`getMessagesForPromptSlashCommand` 中主消息的 `isMeta: true`

### 2.7 local-jsx 命令用 Promise + onDone 回调

- **备选方案**：
  - async 函数直接返回结果：无法支持长期运行的交互式 UI
  - 纯事件驱动：更复杂
- **选择理由**：支持显示 UI 等待用户交互，Promise 保证与现有异步流程兼容，onDone 提供清晰的完成信号
- **证据**：`getMessagesForSlashCommand` 中 local-jsx 分支的 Promise 封装

### 2.8 动态技能插入特定位置

- **备选方案**：
  - 追加到末尾：内建命令优先级过高
  - 插入开头：可能意外覆盖核心命令
- **选择理由**：动态技能可覆盖内建命令，但仍让位于显式安装的 Plugin/Skill
- **证据**：`getCommands` 中的插入位置逻辑：Plugin Skills 之后，Builtin Commands 之前

### 2.9 Kairos 模式下 fork 命令后台执行

- **备选方案**：
  - 总是同步执行：多个定时任务串行，启动慢
  - 总是后台：前台用户体验不连贯
- **选择理由**：定时任务并行执行提升启动速度，前台交互保持同步，用户体验一致
- **证据**：`executeForkedSlashCommand` 中的 `feature('KAIROS')` 分支

## 3. 目标与非目标

### 3.1 目标

1. **统一命令聚合**：多源命令（Builtin、Skill、Plugin、MCP）统一视图
2. **类型安全执行**：三种命令类型（Prompt、Local、Local-JSX）有明确执行模型
3. **懒加载优化**：命令实现按需加载，减少启动时间和体积
4. **远程控制安全**：分层白名单模型，防止未授权命令执行
5. **错误边界保护**：命令执行失败有明确错误处理，不崩溃整个应用
6. **歧义处理**：正确区分斜杠命令与文件路径

### 3.2 非目标

1. **不替换 Skill 系统**：而是作为 Skill 的执行层
2. **不提供命令热重载**：修改命令需重启应用
3. **不支持命令权限细粒度控制**：当前是全有或全无
4. **不提供命令版本管理**：无命令版本兼容性机制

## 4. 架构、模块与数据流

### 4.1 核心模块

```
src/
├── commands.ts                    # 命令聚合中心
├── types/command.ts               # 命令类型定义
├── utils/
│   ├── processUserInput/
│   │   ├── processUserInput.ts    # 输入分发入口
│   │   ├── processSlashCommand.tsx # 斜杠命令执行
│   │   ├── processBashCommand.tsx # Bash 命令执行
│   │   └── processTextPrompt.ts   # 纯文本提示处理
│   ├── slashCommandParsing.ts     # 命令解析器
│   └── ...
└── commands/                      # 内建命令实现
    ├── clear/
    ├── resume/
    ├── session/
    ├── rename/
    ├── tag/
    ├── export/
    ├── diff/
    ├── status/
    ├── help/
    └── ...
```

### 4.2 数据流向

```
用户输入 (/command args)
    ↓
parseSlashCommand() 解析
    ↓
findCommand() 查找命令
    ↓
根据 type 分发:
    ├─ prompt → getMessagesForPromptSlashCommand()
    │   ├─ context: inline → 直接展开到当前会话
    │   └─ context: fork → executeForkedSlashCommand() → 子代理
    ├─ local → load() → call()
    └─ local-jsx → load() → call() → 渲染 UI
```

### 4.3 命令类型

`Command` 是一个带区分联合（discriminated union）的类型，由 `CommandBase` 与三种执行类型之一组合而成：

#### CommandBase 通用字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 命令唯一标识 |
| `aliases?` | `string[]` | 别名数组 |
| `description` | `string` | 描述文本 |
| `isEnabled?` | `() => boolean` | 可用性检查（默认 true） |
| `isHidden?` | `boolean` | 是否在自动补全/帮助中隐藏 |
| `userFacingName?` | `() => string` | 用户可见名称（默认等于 name） |
| `userInvocable?` | `boolean` | 用户能否直接调用（默认 true） |
| `availability?` | `CommandAvailability[]` | 可用性环境限制 |
| `loadedFrom?` | `'commands_DEPRECATED' \| 'skills' \| 'plugin' \| 'managed' \| 'bundled' \| 'mcp'` | 来源标识 |
| `immediate?` | `boolean` | 是否立即执行（绕过队列） |
| `isSensitive?` | `boolean` | 参数是否敏感（日志中脱敏） |

#### PromptCommand（提示命令）

用于 Skill 和扩展命令，执行时展开为提示文本发送给模型。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'prompt'` | 类型标识 |
| `source` | `SettingSource \| 'builtin' \| 'mcp' \| 'plugin' \| 'bundled'` | 来源 |
| `progressMessage` | `string` | 加载中显示的消息 |
| `contentLength` | `number` | 内容长度（用于 token 估算） |
| `getPromptForCommand` | `(args: string, context: ToolUseContext) => Promise<ContentBlockParam[]>` | 生成提示的函数 |
| `allowedTools?` | `string[]` | 允许的工具列表 |
| `model?` | `string` | 指定模型 |
| `context?` | `'inline' \| 'fork'` | 执行上下文 |
| `agent?` | `string` | fork 时使用的代理类型 |
| `effort?` | `EffortValue` | 努力程度 |
| `hooks?` | `HooksSettings` | 关联钩子 |
| `pluginInfo?` | `{ pluginManifest, repository }` | 插件元数据 |

#### LocalCommand（本地命令）

纯逻辑命令，返回文本结果，不渲染 UI。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'local'` | 类型标识 |
| `supportsNonInteractive` | `boolean` | 是否支持非交互式模式 |
| `load` | `() => Promise<{ call: LocalCommandCall }>` | 懒加载实现 |

#### LocalJSXCommand（本地 JSX 命令）

交互式命令，渲染 Ink UI 组件。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'local-jsx'` | 类型标识 |
| `load` | `() => Promise<{ call: LocalJSXCommandCall }>` | 懒加载实现 |

### 4.4 命令来源聚合

`getCommands(cwd)` 是聚合所有可用命令的入口，按以下优先级顺序加载：

1. **Bundled Skills** (`getBundledSkills()`) - 内建打包技能
2. **Builtin Plugin Skills** (`getBuiltinPluginSkillCommands()`) - 内建插件技能
3. **Skill Directory Commands** (`getSkillDirCommands(cwd)`) - 项目目录技能
4. **Workflow Commands** - 工作流命令（WORKFLOW_SCRIPTS 特性）
5. **Plugin Commands** (`getPluginCommands()`) - 插件命令
6. **Plugin Skills** - 插件提供的技能
7. **Builtin Commands** (`COMMANDS()`) - 内建命令（clear/resume/session 等）

### 4.5 模块设计卡

#### 4.5.1 Command 类型系统

**入口文件**: `src/types/command.ts`

**核心类型定义**:
```typescript
// 命令基类型：所有命令共享的字段
type CommandBase = {
  availability?: CommandAvailability[]
  description: string
  hasUserSpecifiedDescription?: boolean
  isEnabled?: () => boolean
  isHidden?: boolean
  name: string
  aliases?: string[]
  isMcp?: boolean
  argumentHint?: string
  whenToUse?: string
  version?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
  kind?: 'workflow'
  immediate?: boolean
  isSensitive?: boolean
  userFacingName?: () => string
}

// 三种执行类型的区分联合
type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
```

**CommandBase 通用字段**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 命令唯一标识 |
| `aliases?` | `string[]` | 别名数组 |
| `description` | `string` | 描述文本 |
| `isEnabled?` | `() => boolean` | 可用性检查（默认 true） |
| `isHidden?` | `boolean` | 是否在自动补全/帮助中隐藏 |
| `userFacingName?` | `() => string` | 用户可见名称（默认等于 name） |
| `userInvocable?` | `boolean` | 用户能否直接调用（默认 true） |
| `availability?` | `CommandAvailability[]` | 可用性环境限制 |
| `loadedFrom?` | `'commands_DEPRECATED' \| 'skills' \| 'plugin' \| 'managed' \| 'bundled' \| 'mcp'` | 来源标识 |
| `immediate?` | `boolean` | 是否立即执行（绕过队列） |
| `isSensitive?` | `boolean` | 参数是否敏感（日志中脱敏） |

**PromptCommand（提示命令）**:
用于 Skill 和扩展命令，执行时展开为提示文本发送给模型。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'prompt'` | 类型标识 |
| `source` | `SettingSource \| 'builtin' \| 'mcp' \| 'plugin' \| 'bundled'` | 来源 |
| `progressMessage` | `string` | 加载中显示的消息 |
| `contentLength` | `number` | 内容长度（用于 token 估算） |
| `getPromptForCommand` | `(args: string, context: ToolUseContext) => Promise<ContentBlockParam[]>` | 生成提示的函数 |
| `allowedTools?` | `string[]` | 允许的工具列表 |
| `model?` | `string` | 指定模型 |
| `context?` | `'inline' \| 'fork'` | 执行上下文 |
| `agent?` | `string` | fork 时使用的代理类型 |
| `effort?` | `EffortValue` | 努力程度 |
| `hooks?` | `HooksSettings` | 关联钩子 |
| `pluginInfo?` | `{ pluginManifest, repository }` | 插件元数据 |
| `disableNonInteractive?` | `boolean` | 是否禁用非交互式模式 |
| `skillRoot?` | `string` | 技能资源根目录 |
| `paths?` | `string[]` | 技能适用的文件路径模式 |

**LocalCommand（本地命令）**:
纯逻辑命令，返回文本结果，不渲染 UI。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'local'` | 类型标识 |
| `supportsNonInteractive` | `boolean` | 是否支持非交互式模式 |
| `load` | `() => Promise<LocalCommandModule>` | 懒加载实现 |
| `LocalCommandModule` | `{ call: LocalCommandCall }` | 加载后的模块类型 |
| `LocalCommandCall` | `(args: string, context: LocalJSXCommandContext) => Promise<LocalCommandResult>` | 实际执行函数 |
| `LocalCommandResult` | `{ type: 'text', value: string } \| { type: 'compact', compactionResult: CompactionResult, displayText?: string } \| { type: 'skip' }` | 执行结果类型 |

**LocalJSXCommand（本地 JSX 命令）**:
交互式命令，渲染 Ink UI 组件。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'local-jsx'` | 类型标识 |
| `load` | `() => Promise<LocalJSXCommandModule>` | 懒加载实现 |
| `LocalJSXCommandModule` | `{ call: LocalJSXCommandCall }` | 加载后的模块类型 |
| `LocalJSXCommandCall` | `(onDone: LocalJSXCommandOnDone, context: ToolUseContext & LocalJSXCommandContext, args: string) => Promise<React.ReactNode>` | 实际执行函数 |
| `LocalJSXCommandOnDone` | `(result?: string, options?: { display?: CommandResultDisplay, shouldQuery?: boolean, metaMessages?: string[], nextInput?: string, submitNextInput?: boolean }) => void` | 完成回调函数 |
| `CommandResultDisplay` | `'skip' \| 'system' \| 'user'` | 结果显示方式 |

**输入/输出**:
- 输入：无（类型定义模块）
- 输出：完整的 Command 类型层次结构
- 辅助函数：`getCommandName(cmd: CommandBase): string`、`isCommandEnabled(cmd: CommandBase): boolean`

**状态与上下文**:
- 无内部状态，纯类型定义模块

**源码证据**:
- `src/types/command.ts` 完整实现

---

#### 4.5.2 命令来源聚合模块

**入口签名**:
```typescript
// 主入口：聚合所有可用命令
async function getCommands(cwd: string): Promise<Command[]>

// 辅助查找命令
function findCommand(commandName: string, commands: Command[]): Command | undefined
function hasCommand(commandName: string, commands: Command[]): boolean
function getCommand(commandName: string, commands: Command[]): Command

// 过滤远程安全命令
const REMOTE_SAFE_COMMANDS: Set<Command>
const BRIDGE_SAFE_COMMANDS: Set<Command>
function isBridgeSafeCommand(cmd: Command): boolean
function filterCommandsForRemoteMode(commands: Command[]): Command[]

// 可用性检查
function meetsAvailabilityRequirement(cmd: Command): boolean
```

**输入/输出**:
- 输入：`cwd: string`（当前工作目录）
- 输出：`Promise<Command[]>`（聚合后的命令列表）
- 内部状态：通过 `lodash-es/memoize` 缓存加载结果

**命令发现/解析/执行流程**:
1. **聚合阶段**：
   - 调用 `loadAllCommands(cwd)` 并行加载所有来源
   - 按优先级顺序排列：Bundled → Builtin Plugin → Skill Dir → Workflow → Plugin → Plugin Skill → Builtin
2. **动态技能插入阶段**：
   - 获取 `getDynamicSkills()` 动态发现的技能
   - 去重检查：仅添加未在基础列表中的动态技能
   - 插入位置：在 Plugin Skills 之后、Builtin Commands 之前
3. **过滤阶段**：
   - `meetsAvailabilityRequirement()` 检查可用性
   - `isCommandEnabled()` 检查启用状态

**动态来源优先级**:
```
[最高优先级（后加载覆盖先加载）
  ↑
  7. Builtin Commands (COMMANDS)
  6. Plugin Skills
  5. Plugin Commands
  4. Workflow Commands (WORKFLOW_SCRIPTS)
  3. Skill Directory Commands
  2. Builtin Plugin Skills
  1. Bundled Skills
  ↓
[最低优先级]
```

**命令命名冲突与失败边界**:
- 同名命令：后加载覆盖先加载
- 加载失败：单个来源失败不影响其他来源（通过 try/catch 隔离）
- 动态技能：去重后插入，不覆盖已有命令

**远程安全模型**:
- `REMOTE_SAFE_COMMANDS`：远程模式预初始化可用的白名单
- `BRIDGE_SAFE_COMMANDS`：桥接模式允许的 Local 命令白名单
- `isBridgeSafeCommand()`：Prompt 类型默认允许，Local-JSX 类型默认禁止

**辅助函数**:
```typescript
// 格式化命令描述（带来源标注）
function formatDescriptionWithSource(cmd: Command): string
```

**源码证据**:
- `src/commands.ts` 完整实现
- `getSkills()` 并行加载技能来源
- `loadAllCommands()` memoized 聚合函数
- 缓存清除：`clearCommandMemoizationCaches()`、`clearCommandsCache()`

---

#### 4.5.3 斜杠命令解析器

**入口签名**:
```typescript
// 解析斜杠命令输入
function parseSlashCommand(input: string): ParsedSlashCommand | null

// 判断是否看起来像命令名（vs 文件路径）
function looksLikeCommand(commandName: string): boolean
```

**核心类型**:
```typescript
type ParsedSlashCommand = {
  commandName: string
  args: string
  isMcp: boolean
}
```

**输入/输出**:
- 输入：原始输入字符串（以 `/` 开头）
- 输出：解析后的命令名、参数、MCP 标记，或 `null`
- `isMcp` 标记：检测第二个词是否为 `(MCP)`

**解析流程**:
1. 检查输入是否以 `/` 开头
2. 去除前缀后按空格分词
3. 检测 MCP 标记：第二个词为 `(MCP)` 时合并到命令名
4. 剩余部分作为参数字符串

**歧义处理**:
- `looksLikeCommand()` 正则：`/[^a-zA-Z0-9:\-_]/`
- 允许字符：字母、数字、冒号、连字符、下划线
- 包含其他字符时当作文件路径处理

**源码证据**:
- `src/utils/slashCommandParsing.ts` 完整实现

---

#### 4.5.4 processUserInput 输入分发入口

**入口签名**:
```typescript
async function processUserInput({
  input: string | Array<ContentBlockParam>,
  preExpansionInput?: string,
  mode: PromptInputMode,
  setToolJSX: SetToolJSXFn,
  context: ProcessUserInputContext,
  pastedContents?: Record<number, PastedContent>,
  ideSelection?: IDESelection,
  messages?: Message[],
  setUserInputOnProcessing?: (prompt?: string) => void,
  uuid?: string,
  isAlreadyProcessing?: boolean,
  querySource?: QuerySource,
  canUseTool?: CanUseToolFn,
  skipSlashCommands?: boolean,
  bridgeOrigin?: boolean,
  isMeta?: boolean,
  skipAttachments?: boolean,
}): Promise<ProcessUserInputBaseResult>
```

**返回类型**:
```typescript
type ProcessUserInputBaseResult = {
  messages: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage | ProgressMessage)[]
  shouldQuery: boolean
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  resultText?: string
  nextInput?: string
  submitNextInput?: boolean
}
```

**输入/输出**:
- 输入：用户输入（字符串或 ContentBlock 数组）
- 输出：处理结果（消息列表 + 是否查询模型）
- 上下文：`ProcessUserInputContext`（ToolUseContext 的扩展）

**分发流程**:
```
processUserInput()
  ├─ 桥接安全检查（bridgeOrigin）
  │   └─ 安全命令放行 / 不安全命令提示
  ├─ Ultraplan 关键词检测
  │   └─ 重定向到 /ultraplan
  ├─ Bash 模式（mode === 'bash'）
  │   └─ processBashCommand()
  ├─ 斜杠命令（以 '/' 开头且 !skipSlashCommands）
  │   └─ processSlashCommand()
  └─ 纯文本提示
      └─ processTextPrompt()
```

**桥接安全逻辑**:
- `bridgeOrigin && skipSlashCommands`：远程模式下，先解析命令
- `isBridgeSafeCommand()` 判断：安全则 `effectiveSkipSlash = false`
- 不安全则直接返回提示消息

**钩子执行阶段**:
- 仅当 `shouldQuery === true` 时执行
- `executeUserPromptSubmitHooks()` 运行钩子
- 钩子阻塞时返回系统错误消息
- 钩子阻止继续时 `shouldQuery = false`

**消息和模型副作用**:
- `setUserInputOnProcessing()`：立即显示用户输入
- `queryCheckpoint()`：性能追踪标记
- 附加消息提取：`getAttachmentMessages()`
- 图片处理：`maybeResizeAndDownsampleImageBlock()`、`storeImages()`
- 图片元数据：`imageMetadataTexts` 作为 isMeta 消息

**源码证据**:
- `src/utils/processUserInput/processUserInput.ts` 完整实现
- `processUserInputBase()` 内部实现
- `addImageMetadataMessage()` 图片元数据添加

---

#### 4.5.5 斜杠命令执行器

**入口签名**:
```typescript
// 主执行入口
async function processSlashCommand(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  imageContentBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
  uuid?: string,
  isAlreadyProcessing?: boolean,
  canUseTool?: CanUseToolFn,
): Promise<ProcessUserInputBaseResult>

// fork 模式执行
async function executeForkedSlashCommand(
  command: CommandBase & PromptCommand,
  args: string,
  context: ProcessUserInputContext,
  precedingInputBlocks: ContentBlockParam[],
  setToolJSX: SetToolJSXFn,
  canUseTool: CanUseToolFn,
): Promise<SlashCommandResult>
```

**输入/输出**:
- 输入：命令字符串 + 上下文 + 工具 JSX 设置器
- 输出：`ProcessUserInputBaseResult`（消息 + shouldQuery）

**执行流程**:
```
processSlashCommand()
  ├─ parseSlashCommand() 解析
  ├─ hasCommand() 查找
  ├─ userInvocable 检查
  ├─ getMessagesForSlashCommand() 分发
  │   ├─ prompt: inline → getMessagesForPromptSlashCommand()
  │   ├─ prompt: fork → executeForkedSlashCommand()
  │   ├─ local → load().call()
  │   └─ local-jsx → load().call() + onDone
  └─ 日志记录 + 结果返回
```

**Prompt 命令执行**:
- **inline 模式**：直接展开到当前会话，`isMeta: true` 的消息
- **fork 模式**：
  - Kairos 模式下后台执行，返回空结果
  - 普通模式下同步执行，显示进度 UI
  - `runAgent()` 运行子代理
  - 子代理完成后 `extractResultText()` 提取结果

**Local 命令执行**:
- `load()` 懒加载模块
- `call(args, context)` 执行
- 返回类型处理：
  - `text`：显示为 `<local-command-stdout>`
  - `compact`：触发消息压缩
  - `skip`：不显示任何消息
- 敏感参数脱敏：`command.isSensitive` 时显示 `***`

**Local-JSX 命令执行**:
- Promise + onDone 回调模式
- `onDone(result, options)` 控制：
  - `display`：`'skip'` / `'system'` / `'user'`
  - `shouldQuery`：是否在命令完成后查询模型
  - `metaMessages`：模型可见但用户隐藏的消息
  - `nextInput` / `submitNextInput`：自动提交下一条输入
- 防挂起机制：异常时自动 resolve，防止队列死锁
- 全屏模式优化：跳过某些 transcript 条目

**错误与去重**:
- 解析错误：返回格式提示
- 未知命令：检查 looksLikeCommand，文件路径 fallback
- `userInvocable: false`：提示只能由模型调用
- 执行异常：捕获显示为 `<local-command-stderr>`
- `AbortError`：显示 "Interrupted"
- Local-JSX：超时自动 resolve Promise

**源码证据**:
- `src/utils/processUserInput/processSlashCommand.tsx` 完整实现
- `getMessagesForSlashCommand()` 内部分发函数
- `looksLikeCommand()` 命令/路径判断

---

#### 4.5.6 Prompt 命令执行器

**入口签名**:
```typescript
// Prompt 命令执行主入口（在 processSlashCommand.tsx 中实现）
async function getMessagesForPromptSlashCommand(
  command: CommandBase & PromptCommand,
  args: string,
  context: ToolUseContext,
  precedingInputBlocks: ContentBlockParam[],
  imageContentBlocks: ContentBlockParam[],
  uuid?: string,
): Promise<SlashCommandResult>

// SkillTool 调用入口
async function processPromptSlashCommand(
  commandName: string,
  args: string,
  commands: Command[],
  context: ToolUseContext,
  imageContentBlocks: ContentBlockParam[] = [],
): Promise<SlashCommandResult>
```

**输入/输出**:
- 输入：Prompt 命令对象 + 参数 + 上下文
- 输出：`SlashCommandResult`（消息 + shouldQuery + allowedTools + model + effort）

**执行流程**:
```
getMessagesForPromptSlashCommand()
  ├─ Coordinator Mode 检查（COORDINATOR_MODE）
  │   └─ 返回摘要给 Coordinator
  ├─ getPromptForCommand() 生成内容
  ├─ registerSkillHooks() 注册钩子
  ├─ addInvokedSkill() 记录调用记录
  ├─ formatCommandLoadingMetadata() 格式化元数据
  ├─ getAttachmentMessages() 提取附加消息
  └─ 返回消息列表
```

**shouldQuery**:
- 始终返回 `true`（Prompt 命令展开后需要模型处理）

**allowedTools/model 更新**:
- `command.allowedTools` 解析为 `additionalAllowedTools`
- `command.model` 透传到返回结果
- `command.effort` 透传到返回结果
- 通过 `createAttachmentMessage({ type: 'command_permissions' })` 传递

**元数据消息**:
- 第一条消息：`formatCommandLoadingMetadata()` 生成的元数据
- 第二条消息：`isMeta: true` 的实际技能内容
- 第三条消息：附加消息（@-mentions、MCP 资源等）
- 第四条消息：命令权限附加消息

**Coordinator 模式特殊处理**:
- 仅当 `CLAUDE_CODE_COORDINATOR_MODE` 且无 `agentId` 时触发
- 返回摘要而非完整内容：告诉 Coordinator 如何委托给 Worker
- Worker 调用 SkillTool 时接收真实内容

**钩子安全检查**:
- 仅当 `!isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(command.source)` 时注册钩子
- 防止非受信任来源注册钩子

**源码证据**:
- `src/utils/processUserInput/processSlashCommand.tsx` 中的 `getMessagesForPromptSlashCommand()`
- `addInvokedSkill()` 记录调用记录
- `registerSkillHooks()` 钩子注册
- `formatCommandLoadingMetadata()` 元数据格式化

---

#### 4.5.7 通用会话命令

**内建命令实现位置**: `src/commands/` 目录

**核心内建命令**:
| 命令 | 类型 | 说明 |
|------|------|------|
| `/clear` | local-jsx | 清空会话历史 |
| `/resume` | local-jsx | 恢复历史会话 |
| `/session` | local-jsx | 会话管理（列表/切换） |
| `/rename` | local-jsx | 重命名当前会话 |
| `/tag` | local-jsx | 会话标签管理 |
| `/export` | local-jsx | 导出会话 |
| `/diff` | local-jsx | 显示 git diff |
| `/status` | local-jsx | 显示 git status |
| `/help` | local-jsx | 显示帮助 |
| `/config` | local-jsx | 配置管理 |
| `/model` | local-jsx | 模型选择 |
| `/compact` | local | 压缩会话历史 |
| `/cost` | local | 显示会话费用 |
| `/review` | prompt | 代码审查 |
| `/commit` | local | 提交更改 |
| `/init` | local-jsx | 初始化项目 |
| `/tasks` | local-jsx | 任务管理 |
| `/skills` | local-jsx | 技能管理 |
| `/theme` | local-jsx | 主题切换 |
| `/color` | local-jsx | 颜色配置 |
| `/vim` | local-jsx | Vim 模式切换 |
| `/logout` | local-jsx | 登出 |
| `/login` | local-jsx | 登录 |

**命令实现模式**:
- Local 命令：`{ type: 'local', load: async () => import(...), supportsNonInteractive: boolean }`
- Local-JSX 命令：`{ type: 'local-jsx', load: async () => import(...) }`
- Prompt 命令：`{ type: 'prompt', getPromptForCommand: async () => [...], ... }`
- 懒加载 shim：大型命令（如 /insights）通过 shim 延迟加载

**设计取舍**:
- 内建命令使用静态导入，保证启动速度
- 大型命令（如 insights）使用懒加载 shim，减小启动体积
- 命令实现按需动态 import，避免一次性加载所有依赖

**源码证据**:
- `src/commands.ts` 中 `COMMANDS()` 函数
- `src/commands/` 目录下各命令实现
- `src/commands/insights.ts` 懒加载 shim 示例

## 5. 失败语义与工程取舍

### 5.1 失败语义

| 失败场景 | 处理方式 | 用户可见效果 |
|---------|---------|-------------|
| 解析错误 | 返回格式提示消息 | 显示 "Usage: /command ..." |
| 未知命令 | 检查是否为文件路径，否则提示 "Unknown skill" | 提示 "Unknown skill: /..." |
| userInvocable: false | 提示该技能只能由模型调用 | 提示 "That skill is not directly invocable." |
| 执行异常 | 捕获异常并显示为本地命令错误输出 | 显示错误堆栈或消息 |
| AbortError | 显示 "Interrupted" 消息 | 显示 "Interrupted" |
| Local-JSX onDone 未调用 | 超时后自动解析 Promise | 防止队列死锁 |
| 远程模式预初始化 | 仅允许 REMOTE_SAFE_COMMANDS | 拒绝其他命令 |
| 桥接模式 | 仅允许 Prompt 和白名单 Local 命令 | 拒绝 Local-JSX 和非白名单 Local |

### 5.2 工程取舍

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| 加载策略 | 懒加载命令实现 | 首次调用稍慢 | 启动更快，体积更小 |
| 类型系统 | Discriminated Union | 模式匹配代码稍多 | 类型安全，清晰分离 |
| 优先级 | 后加载覆盖先加载 | 可能意外覆盖 | 用户可自定义 |
| Fork 模式 | Kairos 下后台执行 | 复杂性增加 | 定时任务并行启动 |
| 远程安全 | 分层白名单 | 配置复杂 | Defense in depth |
| 歧义处理 | 检查 looksLikeCommand | 某些路径无法识别 | 避免误将路径当命令 |
| 元数据消息 | isMeta UserMessage | 模型可见但用户不可见 | 界面简洁，上下文完整 |

## 6. 现状验收标准

### 6.1 功能验收标准

- **命令聚合**：
  - `getCommands(cwd)` 返回所有来源的命令
  - 同名命令按优先级覆盖
  - 动态发现的技能插入正确位置

- **命令解析**：
  - `parseSlashCommand()` 正确解析命令名和参数
  - `looksLikeCommand()` 正确区分命令与路径
  - `(MCP)` 后缀正确标记 MCP 命令

- **Prompt 命令执行**：
  - inline 模式正确展开到当前会话
  - fork 模式在子代理中执行
  - Kairos 模式下后台执行

- **Local 命令执行**：
  - 懒加载正确工作
  - 返回值正确处理（skip、compact、text）
  - 敏感参数在日志中脱敏

- **Local-JSX 命令执行**：
  - UI 正确渲染
  - onDone 回调正确完成执行
  - 异常有正确错误边界

- **远程控制安全**：
  - 预初始化阶段仅允许 REMOTE_SAFE_COMMANDS
  - 桥接模式仅允许 Prompt 和白名单 Local 命令
  - Local-JSX 在远程模式下阻止

- **错误处理**：
  - 解析错误有友好提示
  - 执行异常被捕获并显示
  - Local-JSX 防挂起机制工作

## 7. 代码与测试证据

### 7.1 核心实现文件

- **命令聚合**：
  - `src/commands.ts` - `getCommands()`、`COMMANDS`、`REMOTE_SAFE_COMMANDS`、`BRIDGE_SAFE_COMMANDS`
  - `src/types/command.ts` - Command 类型定义
  - `src/skills/load.ts` - `getSkillDirCommands()`、`getBundledSkills()`
  - `src/plugins/commands.ts` - `getPluginCommands()`

- **命令解析**：
  - `src/utils/slashCommandParsing.ts` - `parseSlashCommand()`、`looksLikeCommand()`

- **命令执行**：
  - `src/utils/processUserInput/processSlashCommand.tsx` - `processSlashCommand()`
  - `src/utils/processUserInput/getMessagesForPromptSlashCommand.ts` - `getMessagesForPromptSlashCommand()`
  - `src/utils/processUserInput/executeForkedSlashCommand.ts` - `executeForkedSlashCommand()`
  - `src/utils/processUserInput/processUserInput.ts` - `processUserInput()`

### 7.2 测试覆盖

现有测试覆盖：
- 斜杠命令解析
- 命令执行流程
- 远程控制安全模型
- 各种内建命令功能

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/commands-framework.yaml)

### 8.1 相关子系统

- **Skill System**：Skill 通过本框架暴露为命令
- **Plugin System**：Plugin 命令通过本框架聚合
- **MCP System**：MCP 工具通过本框架暴露为命令
- **Remote Control**：远程控制安全模型由本框架实现
- **Hook System**：Prompt 命令可以定义 hooks
- **Session Search & Recovery**：`/resume`、`/session list` 等命令通过本框架实现

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|--------|-------|-------|
| P3 | 当前命令权限是全有或全无，用户希望更精细地控制哪些命令可用 | 支持按命令/按来源配置权限，而非全有或全无 | 中 (涉及权限检查逻辑，可能影响现有命令执行) | 能为特定命令设置权限，权限设置生效 | M | 设计推断 |
| P3 | 命令签名变更时，用户的 Skill 可能失效，需要平滑的迁移路径 | 当命令签名变更时，提供迁移路径和向后兼容支持 | 低 (仅新增兼容层，不影响现有命令) | 旧版本命令仍能正常工作，有迁移文档 | M | 设计推断 |
| P3 | 开发 Skill 时，每次修改都需要重启应用，影响开发效率 | 开发模式下支持修改 Skill 无需重启，自动热重载 | 中 (涉及模块缓存，可能导致内存泄漏) | 修改 Skill 后自动生效，无需重启 | M | 设计推断 |
| P3 | 用户希望组合多个命令形成工作流，但当前没有依赖声明机制 | 命令可以声明依赖其他命令，形成管道式执行 | 中 (涉及命令执行调度，可能影响现有执行逻辑) | 能声明命令依赖，依赖命令按顺序执行 | L | 设计推断 |
| P2 | 命令参数验证不严格，用户输入错误参数时没有友好的提示 | 使用 Zod 定义命令参数 Schema，提供更好的验证和帮助信息 | 低 (仅新增验证层，不影响现有命令执行) | 命令参数错误时显示友好提示 | M | 设计推断 |
| P2 | 自定义 Skill 没有专门的测试框架，测试困难 | 为自定义 Skill 提供测试工具和测试框架 | 低 (仅新增测试工具，不影响现有功能) | 能为 Skill 编写和运行测试 | M | 设计推断 |
| P3 | 用户希望分享和发现高质量的命令/ Skill，但当前没有集中的平台 | 建立命令市场，用户可以分享和发现命令 | 低 (仅新增平台，不影响现有功能) | 能在市场中搜索和安装命令 | L | 设计推断 |
| P3 | 用户希望可视化地组合多个命令形成工作流，但当前只有文本方式 | 提供命令组合 UI，可视化地编排多个命令形成工作流 | 中 (涉及 UI 组件和状态管理) | 能通过 UI 可视化组合命令 | L | 设计推断 |
| P3 | 希望了解命令使用情况以优化默认体验，但当前没有遥测 | 匿名收集命令使用统计，用于改进默认体验 | 低 (仅新增统计收集，不影响现有功能) | 能收集和查看命令使用统计 | M | 设计推断 |
