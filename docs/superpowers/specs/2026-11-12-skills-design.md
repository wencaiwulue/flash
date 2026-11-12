---
id: skills
batch: 3
title: Skills 技能发现、加载与执行设计
date: 2026-11-12
status: draft
---

# Skills 技能发现、加载与执行设计

本文是对当前Skills实现的回溯性设计说明，描述技能的来源、frontmatter解析、加载机制、动态发现、条件激活、搜索与执行、缓存失效、权限边界和失败语义。

## 1. 问题与约束

### 1.1 核心问题

技能系统需要解决:
- **多来源技能聚合**: 从用户目录、项目目录、插件、内置、MCP服务器、远程SkillHub等多个来源加载技能
- **frontmatter解析与验证**: 解析技能元数据(name/description/whenToUse/hooks/paths等)
- **动态发现**: 在会话中根据文件操作发现新的技能目录
- **条件激活**: 基于paths模式匹配激活技能
- **搜索与发现**: 支持本地和远程技能语义搜索
- **执行模式**: inline展开和fork子代理两种执行方式
- **缓存与失效**: 技能加载缓存和文件变更自动重载

### 1.2 关键约束

| 约束 | 值 | 说明 |
|------|-----|------|
| 技能目录格式 | 目录名/SKILL.md | 不支持单文件技能(仅legacy commands支持) |
| frontmatter | YAML格式 | 支持name/description/whenToUse/allowedTools/hooks/paths等 |
| 动态发现深度 | cwd以下 | 不从cwd以上发现技能目录 |
| 条件激活匹配 | gitignore语法 | 使用ignore库 |
| 远程技能缓存 | SHA-256哈希 | 基于内容哈希缓存 |
| 远程技能包限制 | 最多100文件，5MB解压 | 安全限制 |
| 搜索查询长度 | 最多2000字符 | 查询截断 |
| 搜索结果限制 | 最多10个 | 本地搜索limit参数 |
| 裸模式 | --bare跳过自动发现 | 只加载显式--add-dir |
| 企业策略 | skillsLocked时只加载企业策略 | policySettings优先级最高 |

### 1.3 来源优先级

```
policySettings (企业) > userSettings (用户) > projectSettings (项目，从cwd向上) > additional dirs (--add-dir) > legacy commands > bundled skills > plugin skills > MCP skills > remote skills
```

### 1.4 边界疑虑

- 符号链接重复: 使用realpath去重，但注意不同路径指向同一文件的情况
- gitignored技能目录: 动态发现时跳过gitignored目录，但启动加载时不检查
- 条件技能激活后的持久化: activatedConditionalSkillNames在缓存清除后仍保留
- MCP技能执行安全: MCP技能不执行shell注入(不同于本地技能)

## 2. 设计理由与备选方案

### 2.1 技能来源分层设计

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|------|---------|-----------|---------------------|------|------|
| 多来源并行加载 | Promise.all同时加载managed/user/project/additional/legacy | 启动更快，各来源独立 | 串行加载: 启动慢 | 需要处理去重 | loadSkillsDir.ts 638-803 |
| realpath去重 | 使用fs.promises.realpath获取规范路径，Map存储已见路径 | 处理符号链接和重复父目录 | 仅按名称去重: 不同路径同名技能冲突 | 需要额外realpath系统调用 | loadSkillsDir.ts 726-763 |
| 条件技能分离存储 | conditionalSkills Map存储未激活技能，激活后移到dynamicSkills | 控制技能可见性，避免污染初始列表 | 全部加载但隐藏: 增加初始加载时间和内存 | 需要维护两套状态 | loadSkillsDir.ts 772-796, 997-1058 |

### 2.2 动态发现机制

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|------|---------|-----------|---------------------|------|------|
| 文件操作触发发现 | Read/Write/Edit时调用discoverSkillDirsForPaths | 按需发现，不提前扫描整个目录树 | 启动时递归扫描: 慢，权限问题 | 每次文件操作需要向上遍历 | loadSkillsDir.ts 861-915 |
| 发现深度限制 | 只在cwd以下发现，cwd本身启动时已加载 | 避免重复加载，控制范围 | 全目录树扫描: 慢，可能发现不需要的技能 | 需要检查路径前缀 | loadSkillsDir.ts 876-878 |
| gitignored目录跳过 | 发现后检查isPathGitIgnored，是则跳过 | 避免加载node_modules等依赖中的技能 | 不检查: 可能加载意外的技能 | 需要git check-ignore调用 | loadSkillsDir.ts 892-897 |
| 目录按深度排序 | 返回结果按深度排序，深目录在前 | 更近目录的技能优先覆盖 | 不排序: 覆盖顺序不确定 | 需要排序开销 | loadSkillsDir.ts 912-915 |

### 2.3 条件激活设计

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|------|---------|-----------|---------------------|------|------|
| paths frontmatter | YAML中paths字段，接受字符串或数组，使用ignore语法 | 复用熟悉的gitignore模式 | 自定义DSL: 学习成本 | 依赖ignore库 | loadSkillsDir.ts 159-178 |
| 激活后移到dynamicSkills | 从conditionalSkills删除，加入dynamicSkills，记录activatedConditionalSkillNames | 一次性激活，避免重复匹配 | 每次使用都检查: 慢 | 需要维护激活名称集合 | loadSkillsDir.ts 1029-1038 |
| activatedConditionalSkillNames跨缓存持久 | 缓存清除(clearSkillCaches)不清除此集合 | 用户已激活的技能不因缓存清除而消失 | 随缓存一起清除: 用户体验差 | 额外状态管理 | loadSkillsDir.ts 810-811, 829 |

### 2.4 技能搜索设计

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|------|---------|-----------|---------------------|------|------|
| Fuse.js模糊搜索 | 使用Fuse.js库，键权重name:0.3/description:0.5/whenToUse:0.2，阈值0.4 | 好的模糊匹配效果，平衡各字段重要性 | 简单子串匹配: 效果差 | 依赖fuse.js库 | localSearch.ts 68-80 |
| 去词stop words | 第二轮回退: 无结果时移除about/after/before/check/could/from/have/into/please/should/that/this/with/would，拆词搜索 | 提高召回率，去除无意义词 | 仅第一轮: 召回率低 | 额外逻辑复杂度 | localSearch.ts 81-127 |
| 可见性跟踪 | getVisibleSkillNames检查历史skill_discovery附件和Skill调用 | 避免重复推荐同一技能 | 不跟踪: 重复推荐 | 需要遍历消息历史 | localSearch.ts 135-150, 96 |
| 预取触发信号 | user_input/write_pivot/subagent_spawn三种信号 | 在关键时刻提前发现技能 | 不预取: 用户等待 | 状态机复杂度 | prefetch.ts 142-161 |

### 2.5 远程技能设计

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|------|---------|-----------|---------------------|------|------|
| SHA-256内容哈希缓存 | 对baseUrl/namespace/slug@version哈希，缓存目录名用哈希值 | 版本变化自动失效，缓存命中快 | 按名称缓存: 版本更新不失效 | 需要计算哈希 | remoteSkillLoader.ts 93-99 |
| 压缩包安全检查 | 断言无符号链接(检查external attributes)，断言路径安全(无../，非绝对，不含\\) | 防止路径穿越和symlink攻击 | 不检查: 安全风险 | 需要解析zip结构 | remoteSkillLoader.ts 48-69 |
| in-flight请求去重 | Map存储pending请求，同一slug+url共享 | 避免并发重复请求 | 不共享: 浪费网络 | 内存占用 | remoteSkillLoader.ts 174-190 |
| _canonical_前缀命名 | 远程技能命名为_canonical_${namespace}/${slug} | 避免与本地技能冲突，明确标识来源 | 无前缀: 命名冲突风险 | 名称较长 | remoteSearch.ts 32, SkillTool.ts 312 |

### 2.6 技能执行设计

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|------|---------|-----------|---------------------|------|------|
| inline/fork双模式 | frontmatter context: 'fork'时fork，否则inline展开 | fork隔离，inline简单高效 | 仅一种模式: 不够灵活 | 需要两套执行路径 | SkillTool.ts 122-289, 638-840 |
| 安全属性allowlist | 检查PromptCommand所有属性是否在SAFE_SKILL_PROPERTIES中，无危险属性则自动allow | 安全前提下减少用户确认 | 全部需确认: 用户体验差 | 需维护allowlist | SkillTool.ts 875-933 |
| fork时保留agentId | 创建新agentId，执行后清除invoked skills | 隔离子代理状态，内存清理 | 不隔离: 状态污染 | 额外状态管理 | SkillTool.ts 132, 287 |
| MCP技能不执行shell注入 | loadedFrom === 'mcp'时跳过executeShellCommandsInPrompt | MCP技能来自远程，不信任 | 也执行: 安全风险 | 功能限制 | loadSkillsDir.ts 374-396 |

### 2.7 缓存与失效设计

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|------|---------|-----------|---------------------|------|------|
| memoize(getSkillDirCommands) | lodash-es/memoize缓存技能加载结果 | 避免重复加载 | 不缓存: 每次调用都重新加载 | 内存占用 | loadSkillsDir.ts 638 |
| 变更检测debounce 300ms | 快速多次变更合并为一次重载，300ms延迟 | 避免频繁重载，防止死锁 | 立即重载: 可能死锁 | 延迟感知 | skillChangeDetector.ts 43, 258-280 |
| chokidar usePolling (Bun) | Bun的fs.watch有PathWatcherManager死锁问题，用stat polling替代 | 稳定性优先 | 用fs.watch: 可能死锁 | 性能略低 | skillChangeDetector.ts 63, 111-133 |
| 文件稳定性等待 | 等待1000ms稳定，500ms轮询 | 避免读写竞争 | 不等待: 可能读到部分写入 | 延迟感知 | skillChangeDetector.ts 28-34, 114-120 |

## 3. 目标与非目标

### 3.1 目标

- **多来源聚合**: 统一访问policy/user/project/additional/legacy/bundled/plugin/MCP/remote技能
- **动态发现**: 根据文件操作按需发现嵌套技能目录
- **条件激活**: 基于paths模式匹配激活相关技能
- **智能搜索**: 本地和远程技能的模糊搜索，避免重复推荐
- **安全执行**: 权限检查、MCP隔离、shell注入限制
- **自动重载**: 文件变更自动检测并重新加载

### 3.2 非目标

- **不吞并plugins**: plugins有独立spec，技能系统仅集成
- **不吞并query-core**: 技能执行最终通过query-core，不重复
- **不实现通用命令**: /skills等命令由commands模块处理
- **不跨会话持久化动态技能**: dynamicSkills会话级，不保存
- **不实现SkillHub服务器**: 仅客户端，服务器独立

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 技能加载主入口
getSkillDirCommands(cwd: string): Promise<Command[]>
getBundledSkills(): Command[]
getDynamicSkills(): Command[]

// 动态发现
discoverSkillDirsForPaths(paths: string[], cwd: string): Promise<string[]>
addSkillDirectories(dirs: string[]): Promise<void>
activateConditionalSkillsForPaths(paths: string[], cwd: string): string[]

// 搜索
searchLocalSkills(query: string, context: ToolUseContext, options?: {limit?: number, index?: SkillIndexEntry[]}): Promise<LocalSkillMatch[]>
searchRemoteSkills(query: string, options?: {limit?: number}): Promise<RemoteSkillMatch[]>

// 执行
SkillTool.call({skill: string, args?: string}, context, ...)
```

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|-----------|-----------|---------|-------------|----------------|
| loadSkillsDir.ts | memoize缓存、dynamicSkills Map、conditionalSkills Map、activatedConditionalSkillNames Set、dynamicSkillDirs Set、skillsLoaded signal | 从目录加载、动态发现、条件激活、去重 | 插件加载、MCP集成 | 返回Command[]，emit skillsLoaded signal |
| bundledSkills.ts | bundledSkills数组(内部) | registerBundledSkill、getBundledSkills | 文件加载 | 返回Command[] |
| localSearch.ts | indexCache Map(cwd→Promise<SkillIndexEntry[]>) | getLocalSkillIndex、searchSkillIndex、searchLocalSkills、getVisibleSkillNames | 远程搜索 | 返回LocalSkillMatch[]，接受ToolUseContext |
| remoteSearch.ts + remoteSkillLoader.ts + remoteSkillState.ts | discovered Map(slug→DiscoveredRemoteSkill)、inFlight Map(key→Promise) | searchRemoteSkills、loadRemoteSkill、registerDiscoveredRemoteSkill、getDiscoveredRemoteSkill | 本地搜索 | 返回RemoteSkillMatch[]，接受ToolUseContext |
| prefetch.ts | 无(纯函数) | startSkillDiscoveryPrefetch、collectSkillDiscoveryPrefetch、getTurnZeroSkillDiscovery、findWritePivot、buildDiscoveryQuery | 实际搜索 | 返回SkillDiscoveryPrefetch，接受Message[] |
| skillChangeDetector.ts | watcher对象、reloadTimer、pendingChangedPaths Set、initialized/disposed标志、skillsChanged signal | initialize、dispose、subscribe、resetForTesting | 实际重载逻辑 | 调用clearSkillCaches/clearCommandsCache，emit skillsChanged |
| SkillTool.ts | 无(无状态) | validateInput、checkPermissions、call、mapToolResultToToolResultBlockParam | 命令展开(交给processPromptSlashCommand) | 调用getCommands/getAllCommands，返回ToolResult<Output> |
| DiscoverSkillsTool.ts | 无(无状态) | call | 搜索逻辑(委托给localSearch/remoteSearch) | 返回ToolResult<Output> |

### 4.3 主控制流

#### 4.3.1 启动加载流

```
启动
  ↓
getSkillDirCommands(cwd)
  ├─ 并行加载:
  │   ├─ managed skills (policySettings)
  │   ├─ user skills (userSettings)
  │   ├─ project skills (从cwd向上遍历)
  │   ├─ additional dirs (--add-dir)
  │   └─ legacy commands (commands目录)
  ├─ 去重: realpath获取规范路径，Map记录已见
  ├─ 分离: unconditionalSkills + conditionalSkills
  └─ 返回: unconditionalSkills
  ↓
getBundledSkills()
  ↓
getPluginSkills() + getBuiltinPluginSkillCommands()
  ↓
MCP技能 (mcpSkills.ts)
  ↓
聚合 → getCommands() → 提供给SkillTool
```

#### 4.3.2 动态发现流

```
文件操作 (Read/Write/Edit)
  ↓
discoverSkillDirsForPaths([path1, path2], cwd)
  ├─ 对每个path:
  │   └─ 向上遍历到cwd(不含cwd)
  │       ├─ 检查dir/.claude/skills是否存在
  │       ├─ 检查是否已在dynamicSkillDirs(跳过重复)
  │       ├─ 检查是否gitignored(是则跳过)
  │       └─ 加入结果
  └─ 按深度排序(深→浅)
  ↓
addSkillDirectories(dirs)
  ├─ 并行加载每个dir的技能
  ├─ 按反向顺序(浅→深)加入dynamicSkills(深覆盖浅)
  └─ emit skillsLoaded signal
  ↓
clearCommandMemoizationCaches()
  ↓
技能对模型可见
```

#### 4.3.3 条件激活流

```
文件操作 (或显式调用)
  ↓
activateConditionalSkillsForPaths(paths, cwd)
  ├─ 遍历conditionalSkills
  ├─ 对每个技能:
  │   ├─ 用ignore库创建匹配器
  │   ├─ 检查paths中的每个相对路径
  │   ├─ 匹配则:
  │   │   ├─ 从conditionalSkills删除
  │   │   ├─ 加入dynamicSkills
  │   │   ├─ 加入activatedConditionalSkillNames
  │   │   └─ 记录到结果
  └─ emit skillsLoaded signal
  ↓
技能激活
```

#### 4.3.4 技能执行流 (inline模式)

```
Skill({skill: 'name', args: '...'})
  ↓
validateInput
  ├─ 去除前缀/
  ├─ 检查是否_canonical_远程技能(是则特殊处理)
  ├─ 检查技能存在
  ├─ 检查disableModelInvocation(否)
  └─ 检查是prompt类型
  ↓
checkPermissions
  ├─ 检查deny规则(匹配则deny)
  ├─ 检查allow规则(匹配则allow)
  ├─ 检查是否仅safe属性(是则allow)
  └─ 否则ask用户
  ↓
call
  ├─ recordSkillUsage
  ├─ 检查context !== 'fork'
  ├─ processPromptSlashCommand
  │   ├─ 解析参数
  │   ├─ 替换${CLAUDE_SKILL_DIR}和${CLAUDE_SESSION_ID}
  │   ├─ 执行shell注入(!`...`) (非MCP)
  │   ├─ addInvokedSkill
  │   └─ 返回处理后的消息
  ├─ tag消息with toolUseId
  └─ 返回newMessages
  ↓
模型继续
```

#### 4.3.5 技能执行流 (fork模式)

```
Skill({skill: 'name', args: '...'})
  ↓
validateInput + checkPermissions (同inline)
  ↓
call
  ├─ recordSkillUsage
  ├─ 检查context === 'fork'
  ├─ prepareForkedCommandContext
  ├─ 创建新agentId
  ├─ runAgent
  │   ├─ 子代理独立执行
  │   ├─ 有自己的token预算
  │   └─ 返回执行结果
  ├─ extractResultText
  ├─ clearInvokedSkillsForAgent
  └─ 返回tool_result with status 'forked'
  ↓
模型继续
```

#### 4.3.6 远程技能执行流

```
Skill({skill: '_canonical_namespace/slug'})
  ↓
validateInput
  ├─ stripCanonicalPrefix
  ├─ getDiscoveredRemoteSkill
  └─ 验证存在
  ↓
call
  ├─ loadRemoteSkill(slug, url)
  │   ├─ 检查缓存(命中则直接返回)
  │   ├─ 否则SkillHubClient下载zip
  │   ├─ 安全检查(无symlink，路径安全)
  │   ├─ 解压到缓存目录
  │   └─ 返回SKILL.md内容
  ├─ logRemoteSkillLoaded
  ├─ parseFrontmatter (剥离YAML frontmatter)
  ├─ 替换${CLAUDE_SKILL_DIR}和${CLAUDE_SESSION_ID}
  ├─ addInvokedSkill
  ├─ 包装为user消息
  └─ 返回
```

#### 4.3.7 技能发现预取流

```
用户输入 / 写入操作 / subagent spawn
  ↓
startSkillDiscoveryPrefetch
  ├─ 检查isSkillSearchEnabled
  ├─ 确定signal:
  │   ├─ input不为null → 'user_input'
  │   ├─ 有agentId且无discovery → 'subagent_spawn'
  │   ├─ write pivot存在 → 'write_pivot'
  │   └─ 否则null(不预取)
  ├─ buildDiscoveryQuery
  │   ├─ 有input用input
  │   └─ 否则用latestUserText + (write_pivot时加file_path等)
  └─ 返回prefetch对象 {attachments: Promise}
  ↓
collectSkillDiscoveryPrefetch
  ├─ await prefetch.attachments
  └─ 返回SkillDiscoveryAttachment[]
  ↓
附件加入消息，模型可看到发现的技能
```

### 4.4 数据结构与持久化

#### 4.4.1 核心类型

```typescript
// 技能命令
interface PromptCommand extends CommandBase {
  type: 'prompt'
  name: string
  description: string
  hasUserSpecifiedDescription: boolean
  allowedTools: string[]
  argumentHint?: string
  argNames?: string[]
  whenToUse?: string
  version?: string
  model?: string
  disableModelInvocation: boolean
  userInvocable: boolean
  contentLength: number
  source: 'policySettings' | 'userSettings' | 'projectSettings' | 'plugin' | 'bundled' | 'builtin'
  loadedFrom: 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
  hooks?: HooksSettings
  skillRoot?: string
  context?: 'inline' | 'fork'
  agent?: string
  effort?: EffortValue
  paths?: string[]
  isHidden: boolean
  progressMessage: string
  userFacingName(): string
  getPromptForCommand(args: string, context: ToolUseContext): Promise<ContentBlockParam[]>
}

// 发现的远程技能
interface DiscoveredRemoteSkill {
  slug: string
  name: string
  description: string
  url: string
  shortId?: string
}

// 本地技能索引
interface SkillIndexEntry {
  name: string
  description: string
  whenToUse: string
}
```

#### 4.4.2 持久化

- **远程技能缓存**: ~/.claude/skill-cache/${sha256Hash}/ 目录，含SKILL.md和.skillhub.json元数据
- **无其他持久化**: 动态技能、条件技能激活状态均会话级，不保存

### 4.5 跨子系统依赖

| 依赖 | 用途 | 归属spec | 本文仅描述 |
|------|------|---------|-----------|
| commands.ts | getCommands/getSkillToolCommands聚合所有技能 | query-core | 调用契约 |
| processPromptSlashCommand | inline模式下展开技能 | query-core | 调用契约 |
| ToolUseContext | 工具调用上下文 | tool-framework | 使用方式 |
| plugins.ts | getPluginSkills/getBuiltinPluginSkillCommands | plugins | 调用契约 |
| mcp.ts | MCP命令/技能聚合 | mcp | 调用契约 |
| featureCheck | EXPERIMENTAL_SKILL_SEARCH开关 | (feature flags) | 检查方式 |
| ignore库 | paths模式匹配 | (external dep) | 使用方式 |
| Fuse.js | 模糊搜索 | (external dep) | 使用方式 |
| chokidar | 文件监听 | (external dep) | 使用方式 |

## 5. 失败语义与工程取舍

### 5.1 失败表

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|-----------------|---------------|--------------|-------------|
| 技能目录不存在/不可读 | loadSkillsFromSkillsDir | logError，跳过该目录 | 否 | 无 | 目录不加载，其他继续 |
| SKILL.md不存在/不可读 | loadSkillsFromSkillsDir | logForDebugging(level:warn)，跳过该技能 | 否 | 无 | 技能不加载，其他继续 |
| frontmatter解析失败 | loadSkillsDir内部 | 不明确，可能抛异常 | 否 | 无 | 整个getSkillDirCommands可能失败 |
| realpath失败 | getFileIdentity | 忽略，不用于去重 | 否 | 无 | 可能重复加载 |
| git check-ignore失败 | isPathGitIgnored | 失败开放(不抛异常)，继续加载 | 否 | 无 | 技能仍加载 |
| 远程技能搜索失败 | searchRemoteSkills | catch，返回[]，logForDebugging | 否 | 无 | 本地结果仍可用 |
| 远程技能下载失败 | loadRemoteSkill | 抛异常 | 否(zip fetch无重试) | 无 | Skill调用失败 |
| zip含symlink | assertNoZipSymlinks | 抛异常"SkillHub package contains a symlink" | 否 | 无 | Skill调用失败 |
| zip含危险路径 | assertSafePath | 抛异常"Unsafe path in skill package: ${path}" | 否 | 无 | Skill调用失败 |
| zip文件过多/过大 | loadRemoteSkill | 抛异常"Skill package has an invalid file count"或超过5MB | 否 | 无 | Skill调用失败 |
| 技能不存在 | SkillTool.validateInput | 返回validation失败，errorCode 2 | 否 | 无 | 用户看到"Unknown skill" |
| disableModelInvocation | SkillTool.validateInput | 返回validation失败，errorCode 4 | 否 | 无 | 用户看到错误 |
| 非prompt技能 | SkillTool.validateInput | 返回validation失败，errorCode 5 | 否 | 无 | 用户看到错误 |
| 权限拒绝 | SkillTool.checkPermissions | 返回deny决定 | 否 | 无 | 用户看到"Skill execution blocked" |
| fork执行失败 | executeForkedSkill | runAgent抛异常会向上抛 | 否 | clearInvokedSkillsForAgent | 用户看到错误 |
| 远程技能未发现 | executeRemoteSkill | getDiscoveredRemoteSkill返回undefined | 否 | 无 | 用户看到错误 |
| 文件监听死锁风险 | skillChangeDetector | Bun下用polling避免 | 不适用 | watcher正确dispose | 系统稳定 |

### 5.2 工程取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|------|---------|------|------|
| 启动加载只返回unconditional | conditionalSkills存储不激活 | 首次技能列表短 | 用户需要相关文件操作后才看到条件技能 |
| 条件技能激活后不自动失效 | activatedConditionalSkillNames持久 | 可能加载不再相关的技能 | 用户激活后一直可见 |
| 远程技能_canonical_前缀 | 避免命名冲突 | 名称长，不够美观 | 明确区分来源 |
| Bun下用polling而非fs.watch | 避免PathWatcherManager死锁 | 性能略低，更多stat调用 | 系统稳定 |
| 变更检测debounce 300ms | 避免频繁重载 | 变更后有延迟 | 防止死锁，减少IO |
| 文件稳定等待1000ms | 避免读写竞争 | 变更后有延迟 | 读取完整文件 |
| remoteSkills条件import | 避免在非ANT环境拉依赖 | 代码稍复杂 | 减小bundle大小 |
| MCP技能不执行shell注入 | 安全优先 | 功能限制 | 防止远程代码执行 |

### 5.3 并发与同步

| 场景 | 机制 | 说明 |
|------|------|------|
| 多来源并行加载 | Promise.all | 各来源独立，互不阻塞 |
| in-flight远程请求去重 | Map存储pending Promise | 同一slug+url共享请求 |
| 动态发现同步 | skillsLoaded signal + onDynamicSkillsLoaded回调 | 通知其他模块清除缓存 |
| 变更检测单线程 | debounce + 一次性处理所有pending paths | 避免并发重载 |

## 6. 现状验收标准

| 验收项 | 设计行为 | 验证方式 |
|--------|---------|---------|
| 多来源加载 | policy/user/project/additional/legacy/bundled/plugin/MCP/remote正确聚合 | 检查getCommands返回所有来源技能 |
| realpath去重 | 同一文件从不同路径加载只出现一次 | 创建symlink测试 |
| 动态发现 | 文件操作后发现嵌套的.claude/skills目录 | 在子目录创建.claude/skills，编辑文件，检查技能出现 |
| 条件激活 | paths匹配时技能激活 | 创建带paths的技能，编辑匹配文件，检查技能出现 |
| 本地搜索 | 模糊匹配name/description/whenToUse，不重复推荐 | 搜索关键词，检查结果合理 |
| 远程搜索 | 搜索SkillHub，结果带_canonical_前缀 | 搜索测试关键词 |
| inline执行 | 非fork技能正确展开，参数替换，shell注入执行 | 调用带args的技能，检查结果 |
| fork执行 | fork技能在子代理中隔离执行 | 调用context: 'fork'技能 |
| 远程执行 | _canonical_技能下载并执行 | 调用远程技能 |
| 自动重载 | 编辑SKILL.md后技能自动更新 | 修改技能文件，检查是否重载 |
| 权限检查 | 非safe属性技能需要用户确认 | 创建带危险属性的技能，检查权限对话框 |
| MCP安全 | MCP技能不执行shell注入 | 创建MCP技能带!`注入`，检查不执行 |
| 远程缓存 | 同一远程技能第二次加载命中缓存 | 远程技能调用两次，检查第二次更快 |
| zip安全 | 含symlink/../的zip被拒绝 | 构造恶意zip，检查拒绝 |

## 7. 代码与测试证据

### 7.1 核心模块证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|-----------------|-----------|
| 多来源并行加载 | loadSkillsDir.ts 638-803 | 无直接测试 | 测试覆盖不完整 |
| realpath去重 | loadSkillsDir.ts 726-763 | 无直接测试 | 测试覆盖不完整 |
| 动态发现 | loadSkillsDir.ts 861-915 | 无直接测试 | 测试覆盖不完整 |
| 条件激活 | loadSkillsDir.ts 997-1058 | 无直接测试 | 测试覆盖不完整 |
| 本地搜索Fuse.js | localSearch.ts 68-80 | skillSearch.test.ts 81-96 "ranks matching metadata" | 测试存在 |
| 可见性跟踪 | localSearch.ts 135-150 | skillSearch.test.ts 97-113 "tracks both discovery attachments and Skill invocations" | 测试存在 |
| 预取信号 | prefetch.ts 142-161 | skillSearch.test.ts 115-182 "skill discovery prefetch" | 测试存在 |
| 远程技能缓存 | remoteSkillLoader.ts 93-136 | remoteSkills.test.ts 115-133 "downloads safely, caches by version" | 测试存在 |
| zip安全检查 | remoteSkillLoader.ts 48-69 | remoteSkills.test.ts 135-143 "rejects path traversal"、145-166 "rejects symlink entries" | 测试存在 |
| in-flight去重 | remoteSkillLoader.ts 174-190 | 无直接测试 | 测试覆盖不完整 |
| SkillTool验证 | SkillTool.ts 354-430 | 无直接测试 | 测试覆盖不完整 |
| 权限检查allowlist | SkillTool.ts 875-933 | 无直接测试 | 测试覆盖不完整 |
| fork执行 | SkillTool.ts 122-289 | 无直接测试 | 测试覆盖不完整 |
| 变更检测debounce | skillChangeDetector.ts 258-280 | 无直接测试 | 测试覆盖不完整 |
| Bun polling | skillChangeDetector.ts 63, 111-133 | 无直接测试 | 测试覆盖不完整 |

### 7.2 现有测试总结

| 测试文件 | 覆盖范围 | 缺口 |
|---------|---------|------|
| skillSearch.test.ts | 本地搜索排名、可见性跟踪、预取信号、kill switch | 实际加载、去重、动态发现、条件激活 |
| remoteSkills.test.ts | 远程搜索注册、缓存、zip安全(symlink/路径穿越) | 实际执行流、权限检查 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/skills.yaml)

### 8.1 分组职责

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|------|-----------|-------------------|----------------|
| skills-load | 目录技能加载、frontmatter解析、动态发现、条件激活 | (无直接测试，功能在skillSearch间接涉及) | src/utils/markdownConfigLoader.ts (legacy commands) |
| skills-bundled | 内置技能注册、带files技能的提取 | 无 | (独立，无相邻) |
| skills-mcp | MCP技能集成 | mcp相关测试 | (归属mcp spec) |
| skill-tool | SkillTool实现、inline/fork执行、权限检查 | 无 | processPromptSlashCommand (归属query-core) |
| discover-skills-tool | DiscoverSkillsTool实现 | 无 | (独立) |
| skill-search-local | 本地技能索引、Fuse搜索、可见性 | skillSearch.test.ts | (独立) |
| skill-search-remote | 远程搜索、缓存、加载、SkillHub | remoteSkills.test.ts | (独立) |
| skill-search-prefetch | 预取触发、query构建、write pivot | skillSearch.test.ts | (独立) |
| skill-change-detector | 文件监听、变更检测、自动重载 | 无 | (独立) |

### 8.2 相关子系统

- **query-core**: processPromptSlashCommand、getCommands聚合入口
- **plugins**: getPluginSkills、getBuiltinPluginSkillCommands
- **mcp**: MCP技能集成
- **tool-framework**: ToolUseContext、SkillTool/DiscoverSkillsTool作为工具实现

## 9. 改进建议

### 9.1 P0 高优先级

| 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---------------|---------|---------|---------|--------|--------|
| 条件技能激活后无失效机制，可能长期停留在dynamicSkills中，即使相关文件已不存在 | 增加条件技能失效机制: 定期重检或文件变更时重检paths是否仍匹配 | 中(需谨慎处理已激活状态) | 激活条件技能，删除匹配文件，检查技能是否失效或提示用户 | M | 已证实(基于代码阅读) |
| 远程技能缓存无限增长，无清理策略 | 增加缓存大小限制和LRU清理，或提供/skills cache clean命令 | 低(仅影响缓存) | 下载大量远程技能，检查旧缓存被清理 | S | 设计推断 |
| 条件技能激活失败路径不明确，parseSkillPaths失败等情况无声跳过 | 增加条件技能加载/激活的可观测性，logForDebugging详细信息 | 低(仅加日志) | 构造错误paths frontmatter，检查日志有输出 | S | 已证实(基于代码阅读) |

### 9.2 P1 中优先级

| 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---------------|---------|---------|---------|--------|--------|
| 动态发现仅检测.claude/skills目录存在，不检测其中技能的增删改 | 对动态发现的目录也启动chokidar监听 | 中(需管理多个watcher) | 在动态发现的目录中增删技能，检查自动重载 | M | 已证实(基于代码阅读) |
| getSkillDirCommands是memoize单一cwd键，实际可能有不同的additional dirs/环境变量组合 | 更精确的memoize键，包含所有影响结果的参数 | 低(仅缓存更精确) | 改变环境变量，检查缓存正确失效 | S | 已证实(基于代码阅读) |
| 技能搜索结果无相关性分数显示，用户不知道为什么推荐某个技能 | 在skill_discovery附件中可选包含score，UI中可选显示 | 低(仅增信息) | 搜索技能，检查结果有分数(若实现) | M | 设计推断 |

### 9.3 P2 低优先级

| 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---------------|---------|---------|---------|--------|--------|
| 技能重载时无平滑过渡，可能导致正在执行的技能上下文变化 | 重载时保留旧版本，新会话用新版本 | 高(复杂度增加) | (建议但非紧急) | L | 设计推断 |
| 无技能依赖/组合机制，技能无法调用其他技能 | 设计技能间调用机制(安全前提下) | 高(复杂度和安全风险) | (建议但非紧急) | L | 设计推断 |
| 无技能版本管理和升级提示 | 增加version frontmatter的使用，支持提示更新 | 低(仅增信息) | (建议但非紧急) | M | 设计推断 |

## 边界疑虑总结

1. **符号链接重复**: realpath去重依赖于文件系统支持，某些文件系统可能不可靠
2. **gitignored不一致**: 启动加载不检查gitignore，动态发现检查，可能不一致
3. **条件技能激活持久**: activatedConditionalSkillNames跨缓存清除，可能与期望不符
4. **Bun polling**: 仅在Bun下用polling，其他环境仍用fs.watch，可能仍有罕见死锁
5. **远程技能缓存膨胀**: 无大小限制，长期使用可能占用大量磁盘
6. **错误路径不透明**: 很多失败仅logForDebugging，用户看不到具体错误
