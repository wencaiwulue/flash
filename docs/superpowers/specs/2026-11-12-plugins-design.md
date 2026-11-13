---
id: plugins
batch: 0
title: Plugins 插件发现、加载与生命周期设计
date: 2026-11-12
status: draft
---

# Plugins 插件发现、加载与生命周期设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

当用户安装第三方插件时，系统必须确保插件加载是安全的、可隔离的，并且单个插件的失败不会导致整个系统崩溃。如果插件加载失败被默默忽略，用户会困惑为什么插件功能不可用；如果插件加载失败导致系统崩溃，会严重影响用户体验。因此，插件系统必须在安全边界、错误隔离、缓存策略和可用性之间取得平衡。

插件系统的调用方、被调用方和责任边界：
- **调用方**：主启动流程、命令系统、Agent系统、MCP系统
- **主入口**：`loadAllPlugins()` / `loadAllPluginsCacheOnly()` → `pluginLoader.ts`
- **被调用方**：市场管理器、已安装插件管理器、组件加载器
- **责任边界**：
  - `pluginLoader.ts`：统一入口、协调各模块、错误收集
  - `marketplaceManager.ts`：市场源管理、缓存
  - `installedPluginsManager.ts`：已安装插件元数据追踪
  - `loadPlugin*`：各类型组件加载
  - UI（`/plugin`）：用户交互，不直接修改内部状态

实际平台、协议、兼容性、安全、性能或feature flag约束：
- **平台**：macOS、Linux、Windows，需要git（可选）用于GitHub/git源
- **安全约束**：
  - 市场源策略：`strictKnownMarketplaces` / `blockedMarketplaces` 企业策略
  - 官方市场名称保留：防止第三方伪造官方市场
  - 跨市场依赖默认阻止：受信任市场不能自动拉取不受信任市场
  - MCP/LSP服务器需要用户配置：敏感环境变量替换
- **性能约束**：
  - 启动时使用缓存版本（`loadAllPluginsCacheOnly()`），不等待网络
  - `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` 环境变量可强制同步加载
  - 插件缓存版本化，避免重复下载相同内容
- **兼容性**：
  - 遗留非版本化缓存目录支持（逐步清理）
  - V1 → V2 installed_plugins.json 自动迁移
  - settings.json 中 enabledPlugins 与 installed_plugins.json 自动同步

internal/external、CLI/SDK或offline/live差异：
- CLI模式（默认）：启动时缓存优先，后台可更新
- SDK模式（`--plugin-dir`）：session-only插件，不持久化
- live模式（`loadAllPlugins()`）：可触发网络下载
- offline模式（`loadAllPluginsCacheOnly()`）：仅读缓存，无网络

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|-----|---------|-----------|-----------------|----|-----|
| 插件ID格式为name@marketplace | `parsePluginIdentifier()` 只分割第一个'@'，name和marketplace分开存储 | 清晰标识插件来源，避免不同市场同名插件冲突；bare name可继承marketplace | 仅用name，marketplace隐式推断；但用户无法同时安装两个同名不同源的插件 | 解析逻辑稍复杂；UI需要同时显示name和marketplace | src/utils/plugins/pluginIdentifier.ts |
| 分scope安装（user/project/local/managed） | installed_plugins.json V2格式存储数组，每个entry带scope和projectPath | 满足企业管理（managed）、全局用户（user）、项目特定（project/local）需求；settings.json是intent层，installed_plugins.json是state层 | 仅user scope；但无法满足企业策略和项目隔离需求 | 数据结构复杂，需要多scope合并逻辑；migration成本 | src/utils/plugins/installedPluginsManager.ts |
| intent/state分离（settings vs installed_plugins） | settings.json存enabledPlugins（intent），installed_plugins.json存缓存路径和元数据（state）；启动时同步两者 | settings可手动编辑或跨设备同步，installed_plugins跟踪实际本地缓存；intent/state不一致时可修复 | 仅存settings.json；但无法追踪缓存路径、版本、git sha等元数据 | 需要同步逻辑；两个文件可能暂时不一致 | src/utils/plugins/installedPluginsManager.ts |
| 版本化缓存目录 | `~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/`，version从manifest/git/entry计算 | 同一插件不同版本可共存；更新不破坏现有使用；seed cache可预填充 | 单一缓存目录，覆盖更新；但无法回滚，无法多版本 | 缓存占用更多磁盘空间；需要清理orphaned版本逻辑 | src/utils/plugins/pluginLoader.ts |
| 缓存优先启动 + 后台更新 | `loadAllPluginsCacheOnly()`用于启动路径，不等待网络；`loadAllPlugins()`用于显式刷新；pending update检测 | 启动速度优先，避免阻塞用户交互；后台更新不影响当前会话 | 始终同步加载；但可能导致启动慢或超时 | 需要维护两套加载路径（cache-only vs full）；内存/磁盘状态可能暂时不一致 | src/utils/plugins/pluginLoader.ts |
| 错误隔离与继续加载 | `PluginError`类型区分各种失败；单个插件失败不阻止其他插件加载；错误收集后可通过UI显示 | 单个坏插件不应破坏整个系统；用户可看到失败原因并修复 | 遇到第一个错误就抛出；但用户体验差，单个插件失败导致所有插件不可用 | 需要全面的错误类型和恢复逻辑；代码复杂度增加 | src/types/plugin.ts |
| 跨市场依赖默认阻止 | `resolveDependencyClosure()`检查dependency marketplace是否与root相同；root的allowCrossMarketplaceDependenciesOn可例外 | 安全边界：受信任市场不能自动拉取不受信任市场的插件，避免供应链攻击 | 允许跨市场依赖；但安全风险高 | 用户需要手动安装跨市场依赖；稍微增加使用门槛 | src/utils/plugins/dependencyResolver.ts |
| 依赖是存在性保证，不是模块图 | `verifyAndDemote()`在load-time固定点迭代检查，降级依赖不满足的插件，不写settings | apt-style语义，简单易理解；load-time降级是session-only，不持久化，避免意外修改用户设置 | 完整模块图+版本约束；但复杂度太高，插件生态不成熟时不必要 | 无法表达版本约束；降级需要重新启用依赖后手动重新启用被降级的插件 | src/utils/plugins/dependencyResolver.ts |

## 3. 目标与非目标

目标必须是当前实现实际承担的可观察职责，非目标必须列出容易被误认为属于本spec的相邻职责。

**状态与生命周期**：
- 插件来源：marketplace（git/url/github/npm/local）、session-only（`--plugin-dir`）、builtin
- 启用状态：持久化到settings.json（user/project/local/managed scope），或session-only
- 缓存状态：versioned目录、zip可选、seed支持
- 更新状态：pending update检测（内存与磁盘不一致）

**接口与数据**：
- `loadAllPlugins()` / `loadAllPluginsCacheOnly()`：返回`PluginLoadResult = { enabled, disabled, errors }`
- `LoadedPlugin`：包含manifest、各种组件路径、settings、MCP/LSP配置等
- `PluginError`：带类型的错误，包含足够上下文用于UI显示
- 各组件加载入口：`loadPluginCommands()`、`loadPluginAgents()`、`loadPluginHooks()`、`loadPluginOutputStyles()`等

**执行与环境**：
- CLI：`/plugin`命令界面管理安装/卸载/启用/禁用/市场
- SDK：`--plugin-dir` 支持session-only插件
- Headless：`headlessPluginInstall.ts`支持非交互式安装
- 启动：`performStartupChecks.tsx`集成插件启动检查

**依赖边界**：
- MCP/LSP集成由专门模块处理，不在本文详细描述
- 设置合并由`cachePluginSettings()`处理，实际设置层设计由settings spec负责
- 命令/Agent/Skill加载由各自系统处理，本文仅描述插件如何向这些系统贡献内容

非目标：
- 命令/Agent/Skill的具体执行语义 → 由commands/agents/skills spec负责
- MCP/LSP服务器的启动和通信 → 由mcp/lsp spec负责
- 设置系统的整体架构 → 由settings spec负责
- 钩子系统的触发时机 → 由hooks spec负责

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 主入口：完整加载（可能触发网络）
export function loadAllPlugins(): Promise<PluginLoadResult>

// 缓存仅加载（启动路径，无网络）
export function loadAllPluginsCacheOnly(): Promise<PluginLoadResult>

// 返回类型
type PluginLoadResult = {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
  errors: PluginError[]
}

// 已加载插件
type LoadedPlugin = {
  name: string
  manifest: PluginManifest
  path: string
  source: string
  repository: string
  enabled?: boolean
  isBuiltin?: boolean
  sha?: string
  commandsPath?: string
  commandsPaths?: string[]
  commandsMetadata?: Record<string, CommandMetadata>
  agentsPath?: string
  agentsPaths?: string[]
  skillsPath?: string
  skillsPaths?: string[]
  outputStylesPath?: string
  outputStylesPaths?: string[]
  hooksConfig?: HooksSettings
  mcpServers?: Record<string, McpServerConfig>
  lspServers?: Record<string, LspServerConfig>
  settings?: Record<string, unknown>
}
```

调用方如何进入：
- 启动时，主流程调用`loadAllPluginsCacheOnly()`获取已启用插件，不等待网络
- `/plugin`命令、`/reload-plugins`命令调用`loadAllPlugins()`或刷新操作
- 显式安装/更新时，`pluginOperations.ts`调用`cachePlugin()` + `copyPluginToVersionedCache()`

返回与完成条件：
- `loadAllPlugins()`是memoized的，同一session多次调用返回相同结果，除非`clearPluginCache()`被调用
- Promise resolve表示加载完成（无论成功/失败多少插件），不reject
- 所有错误都通过返回值的`errors`数组返回

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|----------|---------|---------|-----------|---------------|
| pluginLoader.ts | memoized load结果；settings base | loadAllPlugins()、cachePlugin()、createPluginFromPath()、clearPluginCache() | MCP/LSP启动；命令/Agent执行 | 从marketplaceManager取市场；从installedPluginsManager取已安装；调用各loadPlugin*加载组件 |
| marketplaceManager.ts | known_marketplaces.json缓存；marketplaces目录缓存 | loadKnownMarketplacesConfig()、getMarketplace()、getDeclaredMarketplaces() | 插件安装逻辑 | 返回PluginMarketplace对象给loader；被reconciler调用来同步intent与state |
| installedPluginsManager.ts | installed_plugins.json（V2）；inMemoryInstalledPlugins（会话快照） | loadInstalledPluginsV2()、addInstalledPlugin()、removeInstalledPlugin()、hasPendingUpdates() | 插件加载逻辑 | 被loader调用来查询/写入元数据 |
| dependencyResolver.ts | 无（纯函数） | resolveDependencyClosure()、verifyAndDemote()、findReverseDependents() | 实际安装/卸载 | 被loader调用来验证依赖和降级插件 |
| schemas.ts | 无（schema定义） | PluginManifestSchema()、PluginMarketplaceSchema()、PluginIdSchema()等 | 验证外的逻辑 | 被各处调用来验证输入/配置 |

为什么状态放在这一层：
- memoized load结果放在`pluginLoader.ts`：它是统一入口，可确保同一session多次调用一致性
- `inMemoryInstalledPlugins`会话快照放在`installedPluginsManager.ts`：与磁盘读写同模块，确保会话开始时读取一次后不变

### 4.3 主控制流

主加载流（`loadAllPlugins()`）：
```
调用方
  ↓
loadAllPlugins() [memoized]
  ↓
assemblePluginLoadResult()
  ├─→ loadPluginsFromMarketplaces({ cacheOnly: false })
  │     ├─→ getSettings_DEPRECATED().enabledPlugins
  │     ├─→ 预加载所有市场catalog（避免per-plugin I/O）
  │     ├─→ [parallel for each pluginId in enabledPlugins]
  │     │     ├─→ 企业策略检查
  │     │     ├─→ loadPluginFromMarketplaceEntry()
  │     │     │     ├─→ calculatePluginVersion()
  │     │     │     ├─→ 如果缓存不存在: cachePlugin() → copyPluginToVersionedCache()
  │     │     │     └─→ finishLoadingPluginFromPath()
  │     │     │           ├─→ loadPluginManifest()
  │     │     │           ├─→ createPluginFromPath()
  │     │     │           └─→ [if no manifest] 从marketplace entry补充
  │     │     └─→ errors.push(...) 收集错误，继续下一个插件
  ├─→ [parallel] loadSessionOnlyPlugins()（--plugin-dir）
  ├─→ getBuiltinPlugins()
  ├─→ mergePluginSources()
  ├─→ verifyAndDemote()（固定点检查依赖，降级不满足的）
  ├─→ cachePluginSettings()
  └─→ 返回 { enabled, disabled, errors }
```

依赖降级流（`verifyAndDemote()`）：
```
输入：所有已加载plugins（enabled + disabled）
  ↓
构建：enabledSet, enabledByName（处理bare dep）
  ↓
固定点循环：
  while changed:
    for each enabled plugin:
      for each dependency in manifest:
        check if satisfied
        if not satisfied:
          remove from enabledSet
          push dependency-unsatisfied error
          changed = true
          break
  ↓
返回：demoted（被降级的source集合）, errors
```

### 4.4 数据结构与持久化

文件系统布局：
```
~/.claude/
├─ plugins/
│  ├─ installed_plugins.json       // 已安装插件元数据（V2格式）
│  ├─ known_marketplaces.json      // 已知市场配置
│  ├─ cache/                       // 插件缓存
│  │  └─ {marketplace}/
│  │     └─ {plugin}/
│  │        └─ {version}/          // 版本化插件目录
│  └─ marketplaces/                // 市场缓存
└─ settings.json                   // enabledPlugins、extraKnownMarketplaces等
```

installed_plugins.json V2格式：
```json
{
  "version": 2,
  "plugins": {
    "plugin-name@marketplace": [
      {
        "scope": "user",
        "installPath": "/Users/me/.claude/plugins/cache/marketplace/plugin-name/version",
        "version": "1.2.3",
        "installedAt": "2026-11-12T10:00:00.000Z",
        "lastUpdated": "2026-11-12T10:00:00.000Z",
        "gitCommitSha": "abc123...",
        "projectPath": null
      }
    ]
  }
}
```

### 4.5 跨子系统依赖

上游输入、下游副作用和相关spec：
- **设置系统**：`getSettings_DEPRECATED()`、`updateSettingsForSource()`、`cachePluginSettings()`
- **命令系统**：`loadPluginCommands()`返回commands路径/元数据
- **Agent系统**：`loadPluginAgents()`返回agents路径
- **Skills系统**：`skillsPath` / `skillsPaths`指向skill目录
- **Hooks系统**：`loadPluginHooks()`返回hooks配置
- **MCP系统**：`mcpPluginIntegration.ts`处理MCP服务器配置
- **LSP系统**：`lspPluginIntegration.ts`处理LSP服务器配置

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|-----------------|--------------|-------------|-------------|
| 插件源路径不存在 | createPluginFromPath() | generic-error或path-not-found加入errors数组，继续加载其他插件 | 否 | 无（插件只是跳过） | errors包含该错误 |
| git clone失败（认证/超时/网络） | cachePlugin() → gitClone() | git-auth-failed / git-timeout / network-error加入errors；安装流则throw | 安装流：否（用户手动重试）；加载流：否 | 失败时删除临时缓存目录 | 安装流：用户看到错误；加载流：errors包含该错误 |
| plugin.json无效 | loadPluginManifest() | manifest-parse-error / manifest-validation-error加入errors | 否 | 无（插件跳过） | errors包含该错误 |
| 市场源被企业策略阻止 | loadPluginsFromMarketplaces() | marketplace-blocked-by-policy加入errors | 否 | 无（该市场所有插件跳过） | errors包含该错误 |
| 插件依赖未满足 | verifyAndDemote() 固定点检查 | dependency-unsatisfied加入errors，插件被降级 | 否（会话内保持降级） | 无（仅内存状态改变） | 插件出现在disabled中 |
| 缓存缺失（cache-only模式） | loadPluginFromMarketplaceEntryCacheOnly() | plugin-cache-miss加入errors | 否（用户需显式刷新） | 无（插件跳过） | errors包含该错误 |

## 6. 现状验收标准

1. **插件加载失败隔离**：两个插件A和B，A的manifest无效，B正常 → B出现在enabled中，errors包含A的错误
2. **依赖降级**：插件A依赖插件B，禁用B → A被降级到disabled，settings.json不被修改
3. **跨市场依赖阻止**：市场M的插件A依赖市场N的插件B，无allowCross → 返回cross-marketplace错误
4. **缓存优先启动**：插件已安装，市场有更新 → 启动时返回缓存版本，不等待网络
5. **多scope安装**：插件在user和project都安装 → 当前项目使用project scope的entry

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| 插件ID格式为name@marketplace | src/utils/plugins/pluginIdentifier.ts | 无直接测试 | 仅处理name@marketplace |
| 分scope安装，V2格式数组 | src/utils/plugins/installedPluginsManager.ts | 无直接测试 | migration仅启动时运行 |
| intent/state分离，启动时同步 | src/utils/plugins/installedPluginsManager.ts | 无直接测试 | sync仅处理新增 |
| 版本化缓存目录 | src/utils/plugins/pluginLoader.ts | 无直接测试 | version计算逻辑复杂 |
| 缓存优先启动，两套路径 | src/utils/plugins/pluginLoader.ts | 无直接测试 | cache-only路径在MCP/LSP初始化时使用 |
| 错误隔离，继续加载 | src/utils/plugins/pluginLoader.ts | 无直接测试 | 用for loop + try/catch实现 |
| 跨市场依赖默认阻止 | src/utils/plugins/dependencyResolver.ts | 无直接测试 | root的allowCross是唯一例外 |
| 依赖固定点降级 | src/utils/plugins/dependencyResolver.ts | 无直接测试 | 降级是session-only |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/plugins.yaml)

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|--------|--------|-------|-------|
| P1 | 插件系统几乎没有测试，关键路径无验证 | 添加集成测试：覆盖安装/卸载/启用/禁用、依赖、migration、cache-only、zip模式、seed cache、企业策略 | 低（纯新增测试） | 所有测试通过，且能在CI中运行 | M | 已证实 |
| P1 | 依赖降级后，用户启用依赖，被降级的插件不会自动重新启用 | 记录降级原因；依赖重新启用后自动提示用户可重新启用被依赖插件 | 中（需要持久化降级原因） | 禁用A→依赖A的B被降级→启用A→UI提示B可重新启用 | S | 已证实 |
| P2 | 缓存版本目录可能累积多个旧版本，占用磁盘 | 添加插件缓存清理功能：保留最近N个版本，或按日期清理 | 低（仅删除未引用的版本） | /plugin中显示缓存大小，提供清理按钮/命令 | S | 设计推断 |
| P2 | installed_plugins.json损坏时回退到空对象，数据丢失风险 | 添加备份机制：写入前备份旧版本，损坏时可恢复/提示用户 | 低（仅添加备份/恢复逻辑） | 损坏时提示用户从备份恢复 | S | 设计推断 |
| P2 | 当前错误类型很多未使用，实际仍用generic-error | 逐步迁移所有错误创建点到带类型的PluginError | 中（需要修改很多错误创建点） | 所有插件错误都有具体类型 | M | 已证实 |
