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

### 9.1 短期改进

1. **命令权限细粒度**：支持按命令/按来源配置权限，而非全有或全无
2. **命令版本兼容性**：当命令签名变更时，提供迁移路径
3. **命令热重载**：开发模式下支持修改 Skill 无需重启

### 9.2 中期改进

4. **命令依赖声明**：命令可以声明依赖其他命令，形成管道
5. **命令输入 Schema**：使用 Zod 定义命令参数 Schema，提供更好的验证和帮助
6. **命令测试框架**：为自定义 Skill 提供测试工具

### 9.3 长期改进

7. **命令市场**：用户可以分享和发现命令
8. **命令组合 UI**：可视化组合多个命令形成工作流
9. **命令遥测**：匿名收集命令使用统计，用于改进默认体验
