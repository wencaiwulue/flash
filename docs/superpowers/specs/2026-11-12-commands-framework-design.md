---
id: commands-framework
batch: 4
title: "Commands Framework: 命令聚合、解析与执行设计"
date: 2026-11-12
status: draft
---

# Commands Framework: 命令聚合、解析与执行设计

## 1. 概述

Commands Framework 是 Claude Code 中负责命令注册、解析、路由与执行的核心子系统。它统一处理三类命令源（内建命令、Skill、Plugin/MCP），提供一致的执行模型、错误边界与副作用隔离，并支持交互式与非交互式两种运行模式。

## 2. 系统架构

### 2.1 核心模块

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

### 2.2 数据流向

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

## 3. 命令类型与来源聚合

### 3.1 Command 类型

`Command` 是一个带区分联合（discriminated union）的类型，由 `CommandBase` 与三种执行类型之一组合而成：

```typescript
type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
```

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

### 3.2 命令来源聚合

`getCommands(cwd)` 是聚合所有可用命令的入口，按以下优先级顺序加载：

1. **Bundled Skills** (`getBundledSkills()`) - 内建打包技能
2. **Builtin Plugin Skills** (`getBuiltinPluginSkillCommands()`) - 内建插件技能
3. **Skill Directory Commands** (`getSkillDirCommands(cwd)`) - 项目目录技能
4. **Workflow Commands** - 工作流命令（WORKFLOW_SCRIPTS 特性）
5. **Plugin Commands** (`getPluginCommands()`) - 插件命令
6. **Plugin Skills** - 插件提供的技能
7. **Builtin Commands** (`COMMANDS()`) - 内建命令（clear/resume/session 等）

此外，**动态发现的技能**（Dynamic Skills）通过以下方式加入：
- 在文件操作中发现的技能会插入在 Plugin Skills 之后、Builtin Commands 之前
- 去重逻辑确保不重复添加已存在的命令

### 3.3 来源特定处理

| 来源 | 归属模块 | 是否重复归属 |
|------|----------|--------------|
| Plugin 命令 | Plugin 系统 | 否 |
| MCP 命令 | MCP 系统 | 否 |
| Skill 命令 | Skills 系统 | 否 |
| Settings 相关命令 | Settings 系统 | 否 |

## 4. 斜杠命令解析

### 4.1 parseSlashCommand 解析器

`parseSlashCommand(input)` 将原始输入解析为结构化对象：

```typescript
type ParsedSlashCommand = {
  commandName: string
  args: string
  isMcp: boolean
}
```

**解析规则：**
- 必须以 `/` 开头
- 第一个词为命令名
- 若第二个词为 `(MCP)`，则标记为 MCP 命令
- 剩余部分为参数

**示例：**
- `/clear` → `{ commandName: 'clear', args: '', isMcp: false }`
- `/mcp:tool (MCP) arg1` → `{ commandName: 'mcp:tool (MCP)', args: 'arg1', isMcp: true }`

### 4.2 歧义处理

当输入看起来像文件路径时（如 `/var/log`、`/tmp`、`/private`），系统会：
1. 检查是否存在同名命令
2. 若不存在，检查是否为真实文件路径
3. 若是文件路径，当作普通文本提示处理
4. 否则，提示"Unknown skill"

**looksLikeCommand 判断：**
```typescript
function looksLikeCommand(commandName: string): boolean {
  return !/[^a-zA-Z0-9:\-_]/.test(commandName)
}
```

仅允许 `[a-zA-Z0-9:\-_]` 字符的输入才被视为命令名。

## 5. 命令执行模型

### 5.1 Prompt 命令执行

#### inline 模式（默认）

在当前会话上下文中展开执行：

1. 调用 `command.getPromptForCommand(args, context)` 生成内容块
2. 注册钩子（若有 `command.hooks` 且来源可信）
3. 记录技能调用（用于压缩保留）
4. 构建消息序列：
   - 元数据消息（命令加载状态）
   - 主消息（生成的内容，isMeta: true）
   - 附件消息
   - 权限附件消息
5. 返回 `shouldQuery: true` 触发模型查询

#### fork 模式

在子代理中隔离执行：

1. 创建子代理上下文
2. 在后台（Kairos 模式）或前台运行代理
3. 收集代理执行结果
4. 将结果作为本地命令输出返回

**后台执行优化（Kairos）：**
- 等待 MCP 客户端稳定（10s 超时）
- 完成后通过 `enqueuePendingNotification` 重新入队
- 主会话立即返回，不阻塞用户输入

### 5.2 Local 命令执行

1. 显示用户输入消息（敏感参数用 `***` 替代）
2. `load()` 懒加载实现模块
3. 调用 `mod.call(args, context)`
4. 根据返回类型处理：
   - `type: 'skip'` - 不添加任何消息
   - `type: 'compact'` - 执行上下文压缩
   - `type: 'text'` - 显示文本输出

### 5.3 Local-JSX 命令执行

1. 返回 Promise，在 `onDone` 回调中解析
2. `load()` 加载模块后调用 `mod.call(onDone, context, args)`
3. 若返回 JSX，通过 `setToolJSX` 渲染 UI
4. 命令实现调用 `onDone(result, options)` 完成执行

**onDone 选项：**
- `display: 'skip'` - 不显示任何消息
- `display: 'system'` - 显示为系统消息
- `shouldQuery` - 完成后是否触发模型查询
- `metaMessages` - 模型可见但用户隐藏的消息
- `nextInput` / `submitNextInput` - 自动填充下一条输入

## 6. 消息与模型副作用

### 6.1 消息类型

| 消息类型 | 说明 | isMeta | 发送给模型 |
|----------|------|--------|------------|
| `UserMessage` | 用户输入 | 可选 | 是 |
| `AssistantMessage` | 模型输出 | 否 | 是 |
| `SystemMessage` | 系统提示/警告 | 否 | 否 |
| `AttachmentMessage` | 附件（文件、钩子、权限等） | 否 | 是 |
| `ProgressMessage` | 进度显示 | 否 | 否 |

### 6.2 工具权限副作用

Prompt 命令可通过 `allowedTools` 字段指定本次执行可用的工具，通过 `CommandPermissionsAttachment` 传递给权限系统。

### 6.3 钩子副作用

Prompt 命令可定义 `hooks`，在命令执行时注册到当前会话，用于拦截后续事件（UserPromptSubmit、ToolResult 等）。

### 6.4 模型选择副作用

通过 `model` 字段可指定本次执行使用的模型，覆盖全局设置。

## 7. 去重与错误边界

### 7.1 命令去重

- 动态技能添加时检查 `baseCommandNames` Set，避免重复
- 同名命令按来源优先级覆盖（Skill > Plugin > Builtin）

### 7.2 执行错误边界

**processSlashCommand 中的错误处理：**

1. **解析错误** - 返回格式提示消息
2. **未知命令** - 检查是否为文件路径，否则提示"Unknown skill"
3. **userInvocable: false** - 提示该技能只能由模型调用
4. **执行异常** - 捕获异常并显示为本地命令错误输出
5. **AbortError** - 显示"Interrupted"消息

**Local-JSX 命令防挂起：**
- 记录 `doneWasCalled` 标志
- 若 `load()`/`call()` 抛出且 `onDone` 未调用，自动解析 Promise
- 避免队列处理器死锁

## 8. 远程控制安全模型

参见 [Coverage](../../architecture/coverage/commands-framework.yaml) 了解安全分区。

### 8.1 REMOTE_SAFE_COMMANDS

在远程模式初始化前，仅允许以下命令：
- `session` - 显示远程会话 URL
- `exit` - 退出
- `clear` - 清屏
- `help` - 帮助
- `theme` - 主题
- `color` - 颜色
- `vim` - Vim 模式
- `cost` - 成本
- `usage` - 使用情况
- `copy` - 复制
- `btw` - 快速笔记
- `feedback` - 反馈
- `plan` - 计划模式
- `keybindings` - 快捷键
- `statusline` - 状态栏
- `stickers` - 贴纸
- `mobile` - 移动二维码

### 8.2 BRIDGE_SAFE_COMMANDS

通过远程控制桥接收的命令，仅允许：
- **Prompt 类型命令** - 总是允许（展开为文本）
- **Local 类型命令** - 仅在白名单中：
  - `compact`
  - `clear`
  - `cost`
  - `summary`
  - `releaseNotes`
  - `files`
- **Local-JSX 类型命令** - 总是阻止（渲染本地 UI）

### 8.3 Bridge 命令流

```
远程客户端输入
    ↓
skipSlashCommands: true（防御性默认）
    ↓
检查是否匹配 isBridgeSafeCommand
    ├─ 是 → effectiveSkipSlash = false，执行命令
    └─ 否 →
        ├─ 已知但不安全 → 返回"not available over Remote Control"
        └─ 未知 → 当作纯文本处理
```

## 9. 设计决策

### 决策 1：懒加载命令实现

**现状：** 所有 Local/Local-JSX 命令通过 `load()` 函数动态导入，而非内联实现。

**备选方案：**
1. 静态导入所有命令 - 增加启动时间
2. 使用动态 import 但不加封装 - 错误处理分散

**选择：** 懒加载封装

**理由：**
- 减小启动体积（insights 命令单独 110KB）
- 命令按需加载，提升首次启动速度
- 统一错误处理点

**证据：** `src/commands.ts` 中 insights 命令的懒加载 shim

---

### 决策 2： discriminated union 命令类型

**现状：** Command 类型是 CommandBase 与三种执行类型的区分联合，通过 `type` 字段分发。

**备选方案：**
1. 继承层次结构 - 更复杂，TypeScript 中模式匹配不便
2. 单一类型带可选字段 - 类型不安全

**选择：** 区分联合

**理由：**
- TypeScript 类型收窄支持优秀
- 执行路径清晰分离
- 便于扩展新命令类型

**证据：** `src/types/command.ts` 中的类型定义

---

### 决策 3：来源按优先级聚合，同名覆盖

**现状：** getCommands() 按 Bundled → Builtin Plugin → Skill Dir → Workflow → Plugin → Plugin Skill → Builtin 顺序聚合，后出现的同名命令覆盖先出现的。

**备选方案：**
1. 严格去重报错 - 不够灵活
2. 合并同名命令 - 语义不清晰

**选择：** 优先级覆盖

**理由：**
- 用户可通过项目级 Skill 覆盖内建命令
- 插件可扩展而不修改核心代码
- 符合"后来者居上"的直觉

**证据：** `src/commands.ts` 中 loadAllCommands 的顺序

---

### 决策 4：Prompt 命令支持 inline/fork 双模式

**现状：** PromptCommand 通过 `context` 字段选择在当前会话展开或在子代理执行。

**备选方案：**
1. 仅 inline - 无法隔离副作用
2. 仅 fork - 简单技能开销过大

**选择：** 双模式

**理由：**
- 简单技能用 inline，低延迟
- 复杂/有副作用技能用 fork，隔离性好
- 同一命令可根据上下文切换模式

**证据：** `processSlashCommand.tsx` 中的 executeForkedSlashCommand

---

### 决策 5：Remote Control 分层安全模型

**现状：** 两层白名单：REMOTE_SAFE_COMMANDS（预初始化）和 BRIDGE_SAFE_COMMANDS（桥接收），按命令类型进一步区分。

**备选方案：**
1. 全开放 - 安全风险高
2. 全禁止 - 远程功能不可用

**选择：** 分层白名单 + 类型检查

**理由：**
- Defense in depth：skipSlashCommands 默认 true
- 本地 UI 命令（local-jsx）在远程无意义，直接阻止
- Prompt 命令展开为文本，天然安全
- Local 命令需显式审核加入白名单

**证据：** `commands.ts` 中的 REMOTE_SAFE_COMMANDS、BRIDGE_SAFE_COMMANDS、isBridgeSafeCommand

---

### 决策 6：isMeta 消息用于元数据

**现状：** 技能内容、命令权限等作为 isMeta: true 的 UserMessage 发送，模型可见但用户不可见。

**备选方案：**
1. 全部可见 - 用户界面嘈杂
2. 使用 SystemMessage - 模型可能忽略或权重不同

**选择：** isMeta UserMessage

**理由：**
- 保持用户界面简洁
- 模型看到完整上下文
- 与常规用户输入格式一致，模型行为可预期

**证据：** `getMessagesForPromptSlashCommand` 中主消息的 isMeta: true

---

### 决策 7：local-jsx 命令用 Promise + onDone 回调

**现状：** Local-JSX 命令执行返回 Promise，通过 onDone 回调通知完成，而非直接 async/await。

**备选方案：**
1. async 函数直接返回结果 - 无法支持长期运行的交互式 UI
2. 纯事件驱动 - 更复杂

**选择：** Promise + onDone

**理由：**
- 支持显示 UI 等待用户交互
- Promise 确保与现有异步流程兼容
- onDone 提供清晰的完成信号

**证据：** `getMessagesForSlashCommand` 中 local-jsx 分支的 Promise 封装

---

### 决策 8：动态技能插入特定位置

**现状：** 动态发现的技能插入在 Plugin Skills 之后、Builtin Commands 之前，而非简单追加。

**备选方案：**
1. 追加到末尾 - 内建命令优先级过高
2. 插入开头 - 可能意外覆盖核心命令

**选择：** 特定位置插入

**理由：**
- 动态技能可覆盖内建命令
- 但仍让位于显式安装的 Plugin/Skill
- 平衡灵活性与安全性

**证据：** `getCommands` 中的插入位置逻辑

---

### 决策 9：Kairos 模式下 fork 命令后台执行

**现状：** 当 Kairos 启用时，context: fork 的命令在后台执行，完成后重新入队，主调用立即返回。

**备选方案：**
1. 总是同步执行 - 多个定时任务串行，启动慢
2. 总是后台 - 前台用户体验不连贯

**选择：** Kairos 条件后台执行

**理由：**
- 定时任务并行执行，提升启动速度
- 前台交互保持同步，用户体验一致
- 通过 workload 标记保持归因

**证据：** `executeForkedSlashCommand` 中的 feature('KAIROS') 分支
