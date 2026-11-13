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

---

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

---

### 4.3 模块设计卡片

#### 模块：pluginLoader.ts - 插件加载器

**真实入口签名与关键类型：**
```typescript
// 主入口 - 完整加载模式
export const loadAllPlugins: () => Promise<PluginLoadResult> = memoize(async (): Promise<PluginLoadResult> => { ... })

// 缓存仅加载模式 - 启动路径
export const loadAllPluginsCacheOnly: () => Promise<PluginLoadResult> = memoize(async (): Promise<PluginLoadResult> => { ... })

// 缓存插件从外部源
export async function cachePlugin(
  source: PluginSource,
  options?: { manifest?: PluginManifest }
): Promise<{ path: string; manifest: PluginManifest; gitCommitSha?: string }>

// 从路径创建插件对象
export async function createPluginFromPath(
  pluginPath: string,
  source: string,
  enabled: boolean,
  fallbackName: string,
  strict: boolean = true
): Promise<{ plugin: LoadedPlugin; errors: PluginError[] }>

// 复制到版本化缓存
export async function copyPluginToVersionedCache(
  sourcePath: string,
  pluginId: string,
  version: string,
  entry?: PluginMarketplaceEntry,
  marketplaceDir?: string
): Promise<string>

// 版本化缓存路径工具
export function getVersionedCachePath(pluginId: string, version: string): string
export function getVersionedCachePathIn(baseDir: string, pluginId: string, version: string): string
export async function probeSeedCache(pluginId: string, version: string): Promise<string | null>
export async function probeSeedCacheAnyVersion(pluginId: string): Promise<string | null>
```

**输入输出：**
| 函数 | 输入 | 输出 |
|-----|------|-----|
| `loadAllPlugins()` | 无 | `Promise<PluginLoadResult>` |
| `loadAllPluginsCacheOnly()` | 无 | `Promise<PluginLoadResult>` |
| `cachePlugin()` | `source: PluginSource, options?: { manifest?: PluginManifest }` | `Promise<{ path: string; manifest: PluginManifest; gitCommitSha?: string }>` |
| `createPluginFromPath()` | `pluginPath: string, source: string, enabled: boolean, fallbackName: string` | `Promise<{ plugin: LoadedPlugin; errors: PluginError[] }>` |

**状态与文件布局：**
| 状态类型 | 位置/结构 | 持久化 |
|---------|---------|------|
| Memoized load结果 | 内存中，lodash/memoize缓存 | 否，会话级 |
| Settings base | 内存中，`pluginSettingsBase` | 否，会话级 |
| 版本化插件缓存 | `~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/` | 是，磁盘 |
| ZIP缓存（可选） | `~/.claude/plugins/cache/{marketplace}/{plugin}/{version}.zip` | 是，磁盘 |
| 遗留缓存（兼容） | `~/.claude/plugins/cache/{plugin}/` | 是，磁盘，逐步清理 |

**安装/加载/重载/卸载流程：**

**加载流程 (loadAllPlugins)：**
1. Memoize检查：同一session直接返回缓存结果
2. 调用`loadPluginsFromMarketplaces({ cacheOnly: false })`：
   - 读取`enabledPlugins`配置
   - 企业策略检查（`strictKnownMarketplaces`/`blockedMarketplaces`）
   - 并行加载每个插件：
     - 计算版本（manifest版本→marketplace版本→git SHA→`unknown`）
     - 检查版本化缓存是否存在
     - 不存在则调用`cachePlugin()`+`copyPluginToVersionedCache()`
3. 并行加载session-only插件（`--plugin-dir`）
4. 加载builtin插件
5. 调用`mergePluginSources()`合并来源
6. 调用`verifyAndDemote()`做依赖检查与降级
7. 调用`cachePluginSettings()`缓存插件设置
8. 返回`{ enabled, disabled, errors }`

**缓存仅加载流程 (loadAllPluginsCacheOnly)：**
- 相同步骤，但第2步传入`{ cacheOnly: true }`
- 不调用`cachePlugin()`或网络操作
- 直接读取`installed_plugins.json`中的`installPath`
- 缓存缺失时生成`plugin-cache-miss`错误而非下载

**错误隔离与安全：**
- **单插件失败隔离**：使用`Promise.allSettled()`+`try/catch`包裹每个插件加载，单个失败不影响其他
- **错误收集**：所有错误都推入返回值的`errors`数组，类型化区分（`PluginError`）
- **路径验证**：`validatePathWithinBase()`确保相对路径不越界
- **ZIP安全**：解压时检查路径是否在目标目录内
- **企业策略**：加载前检查marketplace是否被允许/阻止
- **Manifest验证**：使用zod schema严格验证，未知字段被静默丢弃（外层非strict）

**设计取舍/备选：**
| 决策 | 采用方案 | 备选方案 | 理由 |
|-----|---------|---------|-----|
| Memoization策略 | lodash/memoize，同一session同结果 | 无memoization，每次重新加载 | 启动路径调用多次，避免重复I/O |
| 缓存结构 | 版本化目录 `{marketplace}/{plugin}/{version}/` | 单一目录，覆盖更新 | 支持多版本共存，安全更新，seed cache兼容 |
| 加载模式分离 | 两套API：`loadAllPlugins` / `loadAllPluginsCacheOnly` | 单API加布尔参数 | 启动路径性能关键，类型区分更清晰 |
| 错误处理 | 返回错误数组，不reject Promise | 第一个错误reject Promise | 单插件失败不应阻止整个系统 |
| 插件组件加载 | 并行`pathExists()`检查，后处理结果 | 串行逐个检查 | 性能优化，减少事件循环开销 |

**源码测试证据：**
- `src/utils/plugins/pluginLoader.ts`
- 函数：`loadAllPlugins()` [行范围 3096-3108]
- 函数：`loadAllPluginsCacheOnly()` [行范围 3137-3145]
- 函数：`cachePlugin()` [行范围 911-997]
- 函数：`createPluginFromPath()` [行范围 1348-1769]

---

#### 模块：schemas.ts - 插件Schema与类型定义

**真实入口签名与关键类型：**
```typescript
// Manifest Schema
export function PluginManifestSchema(): z.ZodType<PluginManifest>

// Marketplace Schema
export function PluginMarketplaceSchema(): z.ZodType<PluginMarketplace>

// Marketplace Entry Schema
export function PluginMarketplaceEntrySchema(): z.ZodType<PluginMarketplaceEntry>

// Plugin Source Schema
export function PluginSourceSchema(): z.ZodType<PluginSource>

// Marketplace Source Schema
export function MarketplaceSourceSchema(): z.ZodType<MarketplaceSource>

// Plugin ID Schema
export function PluginIdSchema(): z.ZodType<PluginId>

// Command Metadata Schema
export function CommandMetadataSchema(): z.ZodType<CommandMetadata>

// 安装相关Schemas
export function InstalledPluginSchema(): z.ZodType<InstalledPlugin>
export function InstalledPluginsFileSchemaV1(): z.ZodType<InstalledPluginsFileV1>
export function InstalledPluginsFileSchemaV2(): z.ZodType<InstalledPluginsFileV2>
export function KnownMarketplaceSchema(): z.ZodType<KnownMarketplace>
export function KnownMarketplacesFileSchema(): z.ZodType<KnownMarketplacesFile>

// 官方名称验证
export function isBlockedOfficialName(name: string): boolean
export function validateOfficialNameSource(
  name: string,
  source: { source: string; repo?: string; url?: string }
): string | null

// 类型推断
export type CommandMetadata = z.infer<ReturnType<typeof CommandMetadataSchema>>
export type PluginManifest = z.infer<ReturnType<typeof PluginManifestSchema>>
export type PluginMarketplace = z.infer<ReturnType<typeof PluginMarketplaceSchema>>
export type PluginMarketplaceEntry = z.infer<ReturnType<typeof PluginMarketplaceEntrySchema>>
export type PluginSource = z.infer<ReturnType<typeof PluginSourceSchema>>
export type MarketplaceSource = z.infer<ReturnType<typeof MarketplaceSourceSchema>>
export type InstalledPlugin = z.infer<ReturnType<typeof InstalledPluginSchema>>
export type InstalledPluginsFileV1 = z.infer<ReturnType<typeof InstalledPluginsFileSchemaV1>>
export type InstalledPluginsFileV2 = z.infer<ReturnType<typeof InstalledPluginsFileSchemaV2>>
export type KnownMarketplace = z.infer<ReturnType<typeof KnownMarketplaceSchema>>
export type KnownMarketplacesFile = z.infer<ReturnType<typeof KnownMarketplacesFileSchema>>
```

**输入输出：**
| 函数 | 输入 | 输出 |
|-----|------|-----|
| `PluginManifestSchema()` | 无 | Zod Schema对象 |
| `validateOfficialNameSource()` | `name: string, source: MarketplaceSource` | `string | null` (错误信息) |
| `isBlockedOfficialName()` | `name: string` | `boolean` |

**状态与文件布局：**
| 状态类型 | 位置/结构 | 持久化 |
|---------|---------|------|
| 无状态 | 纯Schema定义模块 | 否 |
| Schema验证 | 运行时，每次parse调用 | 否 |

**Schema设计与验证流程：**
- **Manifest验证**：`PluginManifestSchema()`使用`partial().extend()`，核心字段`name`必选，其他可选
- **插件组件引用**：`commands`/`agents`/`skills`/`outputStyles`支持三种格式：单路径字符串、路径数组、对象映射
- **Marketplace Entry Schema**：继承Manifest但要求`name`和`source`必选，添加`category`/`tags`/`strict`字段
- **依赖引用Schema**：`DependencyRefSchema`支持字符串形式 `"plugin"`, `"plugin@marketplace"`, `"plugin@mkt@^1.2"`（版本被静默丢弃）或对象形式 `{name, marketplace?}`
- **官方名称保护**：`ALLOWED_OFFICIAL_MARKETPLACE_NAMES`白名单，`BLOCKED_OFFICIAL_NAME_PATTERN`防止伪造
- **Settings来源插件限制**：`source === 'settings'`时禁止使用保留官方名称

**错误隔离与安全：**
- **Zod验证隔离**：schema验证失败仅影响单个插件/marketplace，不影响其他
- **非ASCII阻止**：marketplace名称禁止非ASCII字符，防止homograph攻击
- **路径分隔符阻止**：marketplace名称禁止`/`/`\`/`..`/`.`，防止目录遍历
- **保留名称验证**：`validateOfficialNameSource()`验证保留名称是否来自官方GitHub组织
- **未知字段静默丢弃**：外层schema使用zod默认行为（非strict），内层配置对象使用`.strict()`，避免schema漂移导致整个加载失败

**设计取舍/备选：**
| 决策 | 采用方案 | 备选方案 | 理由 |
|-----|---------|---------|-----|
| 未知字段处理 | 外层非strict（静默丢弃），内层配置strict（拒绝） | 全部strict，或全部宽松 | 平衡兼容性与错误预防：外层避免单插件失败整个marketplace，内层避免配置打字错误 |
| 依赖版本字段 | 允许但静默丢弃 `@^1.2` | 完整版本约束解析 | 当前apt-style语义仅需存在性，版本约束为未来预留 |
| Command Metadata验证 | 运行时验证source/content互斥 | 编译时类型约束 | TypeScript无法表达XOR类型，运行时验证更可靠 |
| 官方名称验证 | 名称白名单 + GitHub组织验证 | 仅名称验证 | 防止供应链攻击，确保官方插件来自可信来源 |

**源码测试证据：**
- `src/utils/plugins/schemas.ts`
- `PluginManifestSchema` [行范围 884-898]
- `PluginMarketplaceEntrySchema` [行范围 1254-1285]
- `DependencyRefSchema` [行范围 1367-1391]
- `validateOfficialNameSource` [行范围 119-157]

---

#### 模块：marketplaceManager.ts - 市场管理器

**真实入口签名与关键类型：**
```typescript
// 主要入口
export async function addMarketplaceSource(
  source: MarketplaceSource,
  onProgress?: MarketplaceProgressCallback
): Promise<{ name: string; alreadyMaterialized: boolean; resolvedSource: MarketplaceSource }>

export async function removeMarketplaceSource(name: string): Promise<void>

export async function refreshMarketplace(
  name: string,
  onProgress?: MarketplaceProgressCallback,
  options?: { disableCredentialHelper?: boolean }
): Promise<void>

export async function refreshAllMarketplaces(): Promise<void>

export const getMarketplace: (name: string) => Promise<PluginMarketplace> = memoize(async (name: string): Promise<PluginMarketplace> => { ... })

// 缓存仅获取
export async function getMarketplaceCacheOnly(name: string): Promise<PluginMarketplace | null>

// 插件查询
export async function getPluginById(pluginId: string): Promise<{
  entry: PluginMarketplaceEntry;
  marketplaceInstallLocation: string;
} | null>

export async function getPluginByIdCacheOnly(pluginId: string): Promise<{
  entry: PluginMarketplaceEntry;
  marketplaceInstallLocation: string;
} | null>

// 配置管理
export async function loadKnownMarketplacesConfig(): Promise<KnownMarketplacesConfig>
export async function loadKnownMarketplacesConfigSafe(): Promise<KnownMarketplacesConfig>
export async function saveKnownMarketplacesConfig(config: KnownMarketplacesConfig): Promise<void>

// Declared marketplaces (intent层)
export function getDeclaredMarketplaces(): Record<string, DeclaredMarketplace>
export function getMarketplaceDeclaringSource(name: string): 'userSettings' | 'projectSettings' | 'localSettings' | null
export function saveMarketplaceToSettings(
  name: string,
  entry: DeclaredMarketplace,
  settingSource: 'userSettings' | 'projectSettings' | 'localSettings' = 'userSettings'
): void

// Seed管理
export async function registerSeedMarketplaces(): Promise<boolean>

// Auto-update
export function setMarketplaceAutoUpdate(name: string, autoUpdate: boolean): Promise<void>
export function isMarketplaceAutoUpdate(name: string, entry: { autoUpdate?: boolean }): boolean

// 测试工具
export function clearMarketplacesCache(): void
export function setNpmRunnerForTests(runner?: NpmRunner): void
```

**输入输出：**
| 函数 | 输入 | 输出 |
|-----|------|-----|
| `addMarketplaceSource()` | `source: MarketplaceSource, onProgress?: Callback` | `Promise<{ name: string; alreadyMaterialized: boolean; resolvedSource }>` |
| `removeMarketplaceSource()` | `name: string` | `Promise<void>` |
| `getMarketplace()` | `name: string` | `Promise<PluginMarketplace>` |
| `refreshMarketplace()` | `name: string, onProgress?: Callback` | `Promise<void>` |

**状态与文件布局：**
| 状态类型 | 位置/结构 | 持久化 |
|---------|---------|------|
| known_marketplaces.json | `~/.claude/plugins/known_marketplaces.json` | 是 |
| Marketplaces缓存目录 | `~/.claude/plugins/marketplaces/{name}/` | 是 |
| Marketplaces缓存JSON | `~/.claude/plugins/marketplaces/{name}.json` | 是 |
| Memoized getMarketplace结果 | 内存中，lodash/memoize | 否，会话级 |
| Seed marketplaces | 配置的seed目录（env var） | 只读 |

**安装/加载/重载/卸载流程：**

**Add Marketplace流程 (addMarketplaceSource)：**
1. 企业策略检查：验证source是否被`strictKnownMarketplaces`允许或被`blockedMarketplaces`阻止
2. Source去重检查：检查是否已存在相同source，存在则直接返回
3. 调用`loadAndCacheMarketplace(source)`：
   - 根据source类型分发（`url`/`github`/`git`/`npm`/`file`/`directory`/`settings`）
   - GitHub类型：SSH配置检查 → 尝试SSH → 失败则回退HTTPS
   - Git类型：clone/pull到`marketplaces/{name}/`
   - URL类型：下载并验证schema
   - npm类型：安装到临时工作区，提取到目标
4. 读取返回的marketplace名称（来自manifest的`name`字段）
5. 验证名称是否为官方保留名，是则验证source是否来自官方GitHub组织
6. 更新`known_marketplaces.json`，写入`source`/`installLocation`/`lastUpdated`
7. 清理旧缓存（名称相同source不同时）

**Refresh Marketplace流程 (refreshMarketplace)：**
1. 检查是否为seed-managed，是则抛出错误
2. 检查installLocation是否在marketplaces缓存目录内（防止损坏配置指向任意路径）
3. 官方marketplace特殊处理：优先从GCS下载，失败且feature flag允许时回退git
4. Git类型：
   - reconcile sparse-checkout配置
   - `gitPull()`（带超时），失败则删除并重clone
   - 子模块更新（非sparse时）
5. URL类型：重新下载并验证
6. npm类型：安装到新临时目录，成功后原子替换旧目录
7. 更新`known_marketplaces.json`的`lastUpdated`
8. 清除`getMarketplace` memoization缓存

**Remove Marketplace流程 (removeMarketplaceSource)：**
1. 检查是否为seed-managed，是则抛出错误
2. 从`known_marketplaces.json`删除条目
3. 删除缓存目录/文件
4. 从settings的`extraKnownMarketplaces`删除
5. 调用`removeAllPluginsForMarketplace(name)`从`installed_plugins.json`删除相关插件
6. 删除orphaned版本缓存

**错误隔离与安全：**
- **Git凭证保护**：`GIT_TERMINAL_PROMPT=0`/`GIT_ASKPASS=`禁用提示，防止阻塞；自定义`core.sshCommand`设`StrictHostKeyChecking=yes`防MITM
- **路径验证**：installLocation必须在marketplaces缓存目录内，防止损坏配置指向任意路径
- **下载超时**：git clone/pull有超时配置（默认120s，可通过`CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS`覆盖）
- **官方marketplace GCS优先**：减少GitHub负载，更快更可靠
- **Seed marketplace只读**：seed路径的marketplace不可refresh/remove，启动时被`registerSeedMarketplaces()`覆盖
- **GitHub SSH/HTTPS自动回退**：先尝试SSH（如果配置），失败自动回退HTTPS

**设计取舍/备选：**
| 决策 | 采用方案 | 备选方案 | 理由 |
|-----|---------|---------|-----|
| GitHub协议选择 | SSH配置检查 → 优先SSH → 失败回退HTTPS | 仅HTTPS，或仅SSH | 平衡安全性与可用性：有SSH密钥用SSH，否则HTTPS |
| Refresh策略 | Git用pull，npm用新目录原子替换 | 始终删除重clone | Git pull更快，npm原子替换避免部分更新 |
| Seed管理 | Seed注册覆盖primary，refresh/remove拒绝 | Seed与primary合并 | Seed是管理员控制，应覆盖用户配置 |
| Marketplace名称来源 | Manifest的`name`字段，不是用户输入 | 用户指定名称 | Manifest是权威来源，避免名称冲突 |
| Sparse checkout | 支持sparse paths配置，仅clone需要的目录 | 完整clone | 大型monorepo性能优化 |

**源码测试证据：**
- `src/utils/plugins/marketplaceManager.ts`
- `addMarketplaceSource()` [行范围 1925-1967]
- `refreshMarketplace()` [行范围 2512-2729]
- `loadAndCacheMarketplace()` [行范围 1530-1883]
- `gitClone()` [行范围 809-985]
- `gitPull()` [行范围 529-807]

---

#### 模块：installedPluginsManager.ts - 已安装插件管理器

**真实入口签名与关键类型：**
```typescript
// 初始化入口
export async function initializeVersionedPlugins(): Promise<void>
export function migrateToSinglePluginFile(): void
export async function migrateFromEnabledPlugins(): Promise<void>

// V2格式读写
export function loadInstalledPluginsV2(): InstalledPluginsFileV2
export function loadInstalledPluginsFromDisk(): InstalledPluginsFileV2
export function getInMemoryInstalledPlugins(): InstalledPluginsFileV2

// 安装管理
export function addInstalledPlugin(
  pluginId: string,
  metadata: InstalledPlugin,
  scope: PersistableScope = 'user',
  projectPath?: string
): void

export function addPluginInstallation(
  pluginId: string,
  scope: PersistableScope,
  installPath: string,
  metadata: Partial<PluginInstallationEntry>,
  projectPath?: string
): void

export function removeInstalledPlugin(pluginId: string): InstalledPlugin | undefined

export function removePluginInstallation(
  pluginId: string,
  scope: PersistableScope,
  projectPath?: string
): void

export function removeAllPluginsForMarketplace(marketplaceName: string): {
  orphanedPaths: string[];
  removedPluginIds: string[];
}

// 更新状态查询
export function hasPendingUpdates(): boolean
export function getPendingUpdateCount(): number
export function getPendingUpdatesDetails(): Array<{
  pluginId: string;
  scope: string;
  oldVersion: string;
  newVersion: string;
}>

export function updateInstallationPathOnDisk(
  pluginId: string,
  scope: PersistableScope,
  projectPath: string | undefined,
  newPath: string,
  newVersion: string,
  gitCommitSha?: string
): void

// 安装状态查询
export function isPluginInstalled(pluginId: string): boolean
export function isPluginGloballyInstalled(pluginId: string): boolean
export function isInstallationRelevantToCurrentProject(inst: PluginInstallationEntry): boolean

// 缓存清理
export function deletePluginCache(installPath: string): void

// 测试工具
export function clearInstalledPluginsCache(): void
export function resetInMemoryState(): void
export function resetMigrationState(): void

// 路径工具
export function getInstalledPluginsFilePath(): string
export function getInstalledPluginsV2FilePath(): string

// 类型
export type PersistableScope = Exclude<PluginScope, never> // 'managed' | 'user' | 'project' | 'local'
```

**输入输出：**
| 函数 | 输入 | 输出 |
|-----|------|-----|
| `loadInstalledPluginsV2()` | 无 | `InstalledPluginsFileV2` |
| `addInstalledPlugin()` | `pluginId: string, metadata: InstalledPlugin, scope?: Scope` | `void` |
| `removeInstalledPlugin()` | `pluginId: string` | `InstalledPlugin | undefined` |
| `hasPendingUpdates()` | 无 | `boolean` |
| `updateInstallationPathOnDisk()` | `pluginId, scope, projectPath, newPath, newVersion` | `void` |

**状态与文件布局：**
| 状态类型 | 位置/结构 | 持久化 |
|---------|---------|------|
| installed_plugins.json | `~/.claude/plugins/installed_plugins.json` | 是 |
| V2格式结构 | `{ version: 2, plugins: { [pluginId]: Array<{ scope, installPath, version, installedAt, lastUpdated, gitCommitSha?, projectPath? }> } }` | 是 |
| inMemoryInstalledPlugins | 内存快照，启动时读取一次 | 否，会话级 |
| installedPluginsCacheV2 | 内存缓存，文件修改后清除 | 否，会话级 |

**Intent vs Installed State同步状态机：**

**启动同步流程 (migrateFromEnabledPlugins)：**
1. 读取所有settings源的`enabledPlugins`（user/project/local）
2. 检查`installed_plugins.json`是否存在且为V2格式
3. 对每个在`enabledPlugins`中的插件：
   - 已在installed中且scope匹配：跳过
   - 已在installed中但scope不匹配：更新scope
   - 不在installed中：查询marketplace获取source，从缓存读取manifest，创建entry
4. 写入`installed_plugins.json`（仅当有变更）

**Scope优先级：**
| Scope | 优先级 | 来源 | 适用场景 |
|-----|-------|------|---------|
| managed | 1（最高） | 企业配置 | 强制安装/禁用 |
| local | 2 | .claude/settings.local.json | 个人项目覆盖 |
| project | 3 | .claude/settings.json | 项目共享配置 |
| user | 4（最低） | ~/.claude/settings.json | 全局用户配置 |

**多Scope安装处理：**
- 同一plugin可在多个scope安装（如user + project）
- `mergePluginSources()`时，按优先级选择：session-only > project/local > user > managed
- `isInstallationRelevantToCurrentProject()`判断：
  - `user`/`managed`：始终相关
  - `project`/`local`：仅当`projectPath`匹配当前启动目录
- 查询安装状态时，`isPluginInstalled()`返回是否有任何relevant scope的安装

**缓存命中/更新/失败路径：**

**缓存命中路径：**
1. 加载时调用`loadPluginFromMarketplaceEntryCacheOnly()`
2. 从`installed_plugins.json`读取`installPath`
3. ZIP缓存：解压到session临时目录 → `finishLoadingPluginFromPath()`
4. 目录缓存：直接调用`finishLoadingPluginFromPath()`

**缓存更新路径（后台）：**
1. 显式refresh或install调用`loadPluginFromMarketplaceEntry()`
2. 计算version（优先用installed中的version）
3. 检查版本化缓存是否存在
4. 不存在：`cachePlugin()`下载 → `copyPluginToVersionedCache()`
5. 存在：直接使用
6. 调用`updateInstallationPathOnDisk()`写入新路径到磁盘（仅更新磁盘文件，不修改in-memory）

**缓存失败路径：**
1. `loadPluginFromMarketplaceEntryCacheOnly()`时`installPath`不存在或损坏
2. 生成`plugin-cache-miss`类型`PluginError`
3. 插件不加入enabled/disabled数组
4. 用户通过`/plugin`命令手动refresh修复

**错误隔离与安全：**
- **迁移失败隔离**：`migrateToSinglePluginFile()`捕获所有异常，设置`migrationCompleted = true`避免重试，日志记录但不崩溃
- **磁盘与内存分离**：`updateInstallationPathOnDisk()`仅更新磁盘文件，不修改`inMemoryInstalledPlugins`，同一会话保持一致视图
- **路径验证**：`deletePluginCache()`验证路径在缓存目录内才删除，防止误删
- **空目录清理**：删除版本缓存后，检查父目录是否为空，是则一并删除，避免孤儿目录堆积

**设计取舍/备选：**
| 决策 | 采用方案 | 备选方案 | 理由 |
|-----|---------|---------|-----|
| V2数据结构 | `pluginId → Installation[]`（数组） | `pluginId → { [scope]: Installation }` | 同一scope可多project，数组更灵活 |
| 内存快照策略 | 启动读取一次，in-memory只读，后台更新仅写磁盘 | 每次读取磁盘，或监听文件变更 | 同一会话一致性，避免竞态条件 |
| 迁移策略 | V1→V2自动转换，遗留缓存逐步清理 | 强制重装所有插件 | 平滑升级，减少用户困扰 |
| Scope设计 | 4级scope（managed/user/project/local） | 仅user scope | 满足企业管理、项目共享、个人覆盖需求 |
| Pending更新检测 | 比较in-memory与磁盘状态 | 显式标记需要更新 | 无需额外状态，逻辑简单 |

**源码测试证据：**
- `src/utils/plugins/installedPluginsManager.ts`
- `loadInstalledPluginsV2()` [行范围 307-364]
- `addInstalledPlugin()` [行范围 874-912]
- `migrateFromEnabledPlugins()` [行范围 1048-1268]
- `hasPendingUpdates()` [行范围 595-619]
- `isInstallationRelevantToCurrentProject()` [行范围 800-807]

---

#### 模块：dependencyResolver.ts - 依赖解析器

**真实入口签名与关键类型：**
```typescript
// 主要入口
export async function resolveDependencyClosure(
  rootId: PluginId,
  lookup: (id: PluginId) => Promise<DependencyLookupResult | null>,
  alreadyEnabled: ReadonlySet<PluginId>,
  allowedCrossMarketplaces: ReadonlySet<string> = new Set()
): Promise<ResolutionResult>

export function verifyAndDemote(plugins: readonly LoadedPlugin[]): {
  demoted: Set<string>;
  errors: PluginError[];
}

export function findReverseDependents(
  pluginId: PluginId,
  plugins: readonly LoadedPlugin[]
): string[]

export function getEnabledPluginIdsForScope(
  settingSource: EditableSettingSource
): Set<PluginId>

// 工具
export function qualifyDependency(dep: string, declaringPluginId: string): string
export function formatDependencyCountSuffix(installedDeps: string[]): string
export function formatReverseDependentsSuffix(rdeps: string[] | undefined): string

// 类型
export type DependencyLookupResult = { dependencies?: string[] }
export type ResolutionResult =
  | { ok: true; closure: PluginId[] }
  | { ok: false; reason: 'cycle'; chain: PluginId[] }
  | { ok: false; reason: 'not-found'; missing: PluginId; requiredBy: PluginId }
  | { ok: false; reason: 'cross-marketplace'; dependency: PluginId; requiredBy: PluginId }
```

**输入输出：**
| 函数 | 输入 | 输出 |
|-----|------|-----|
| `resolveDependencyClosure()` | `rootId, lookup, alreadyEnabled, allowedCrossMarketplaces?` | `Promise<ResolutionResult>` |
| `verifyAndDemote()` | `plugins: readonly LoadedPlugin[]` | `{ demoted: Set<string>; errors: PluginError[] }` |
| `findReverseDependents()` | `pluginId: string, plugins: readonly LoadedPlugin[]` | `string[]` |

**状态与文件布局：**
| 状态类型 | 位置/结构 | 持久化 |
|---------|---------|------|
| 无状态 | 纯函数模块，计算无副作用 | 否 |
| DFS遍历状态 | `resolveDependencyClosure`内部栈/visited集合 | 否，调用级 |
| Fixed-point迭代状态 | `verifyAndDemote`内部enabled集合 | 否，调用级 |

**依赖不是模块图的边界：**

**Apt-style语义（当前实现）：**
- 依赖仅为**存在性保证**：如果A依赖B，B必须enabled，但A可以有任何版本，B可以有任何版本
- 无版本约束：`manifest.dependencies`中的`@^1.2`被静默丢弃，不参与解析
- 无传递性冲突检测：A→B→C和A→C是允许的，不冲突
- 降级是session-only：`verifyAndDemote()`仅修改内存中`plugin.enabled`标志，不修改settings

**为什么不做完整模块图：**
| 方面 | 完整模块图（备选） | Apt-style（当前） |
|-----|-----------------|-----------------|
| 复杂度 | 高（版本约束求解、冲突检测） | 低 |
| 生态成熟度要求 | 需要严格的semver遵循 | 灵活 |
| 用户认知负担 | 高（理解冲突、选择版本） | 低（仅需知道"需要存在"） |
| 实现成本 | 高（引入sat solver或类似） | 低 |

**Intent vs Installed State同步：**
- **Intent（Settings）**：`enabledPlugins`记录用户想启用什么
- **Installed State（installed_plugins.json）**：记录磁盘上有什么
- **Sync逻辑**：启动时`migrateFromEnabledPlugins()`确保intent中的插件都installed
- **降级不回写**：`verifyAndDemote()`仅内存降级，settings不变，用户下次启动仍可尝试启用

**跨市场依赖阻止条件：**

**默认阻止（安全边界）：**
```typescript
// 伪代码表示规则
if (dependencyMarketplace !== rootMarketplace &&
    !allowedCrossMarketplaces.has(dependencyMarketplace)) {
  return { ok: false, reason: 'cross-marketplace' }
}
```

**规则细节：**
1. **阻止所有跨市场依赖**：来自市场M的插件，依赖默认可来自市场M，其他市场一律阻止
2. **Root的allowlist例外**：root plugin的marketplace manifest中`allowCrossMarketplaceDependenciesOn`数组中的市场被允许
3. **仅root的allowlist生效**：依赖项的allowlist不被考虑，无传递信任
4. **AlreadyEnabled例外**：已在`alreadyEnabled`集合中的跨市场依赖被跳过（用户手动安装的不受阻止）

**Cache-only与Seed Cache：**

**Seed Cache设计：**
- Seed目录结构：`{seedDir}/cache/{marketplace}/{plugin}/{version}/`
- Seed查询优先于主缓存：`probeSeedCache()`先于下载
- Seed只读：不写入seed目录，不更新seed中的marketplace
- Seed注册：启动时`registerSeedMarketplaces()`将seed的marketplace注册到primary

**Cache-only模式处理：**
- `loadAllPluginsCacheOnly()`不触发任何网络/下载
- 插件不在缓存：`plugin-cache-miss`错误，静默跳过
- Seed作为后备：即使primary缓存为空，seed有也可用
- 版本未知时seed查询：`probeSeedCacheAnyVersion()`尝试seed中的任何版本

**安装/加载/重载/卸载流程：**

**安装时依赖解析 (resolveDependencyClosure)：**
1. DFS遍历，从rootId开始
2. 对每个依赖，调用`qualifyDependency()`补全marketplace
3. 检查：
   - 循环检测：栈中有则返回`reason: 'cycle'`
   - 跨市场检测：非root market且不在allowlist则返回`reason: 'cross-marketplace'`
   - 存在性检测：lookup返回null则返回`reason: 'not-found'`
4. 跳过`alreadyEnabled`中的依赖（避免重新安装/修改用户设置）
5. 返回closure数组（不包含alreadyEnabled）

**加载时依赖验证 (verifyAndDemote)：**
1. 构建`enabled`集合和`enabledByName` multiset（处理@inline插件的bare依赖）
2. Fixed-point循环：
   - 对每个enabled plugin，检查所有依赖是否满足
   - 不满足：从enabled移除，添加`dependency-unsatisfied`错误
   - 有变更：继续循环
   - 无变更：退出
3. 返回`demoted`集合（被降级的plugin source）和errors
4. **不修改settings**：降级是session-only

**卸载时反向依赖检查 (findReverseDependents)：**
1. 遍历所有enabled plugins
2. 检查其manifest.dependencies是否包含目标pluginId（或bare name匹配）
3. 返回依赖它的plugin名称列表（用于警告用户）

**Scope优先级重述：**
| Scope | 优先级 | 来源 | 是否可被用户修改 |
|-----|-------|------|---------------|
| session-only (--plugin-dir) | 0（最高） | CLI参数 | 是（重启） |
| managed | 1 | 企业配置 | 否 |
| local | 2 | .claude/settings.local.json | 是 |
| project | 3 | .claude/settings.json | 是 |
| user | 4（最低） | ~/.claude/settings.json | 是 |

**错误隔离与安全：**
- **循环依赖检测**：DFS栈检测，循环存在时安装失败，提供完整chain
- **跨市场依赖阻止**：安全边界，防止受信任marketplace自动拉取不受信任marketplace
- **降级隔离**：单个插件降级不影响其他插件，fixed-point确保传递性降级正确
- **Bare依赖处理**：@inline插件的bare依赖用name-only匹配，更灵活

**设计取舍/备选：**
| 决策 | 采用方案 | 备选方案 | 理由 |
|-----|---------|---------|-----|
| 依赖语义 | Apt-style，仅存在性 | NPM-style，版本约束 | 简单，插件生态不成熟时过度设计 |
| 降级策略 | Session-only，不修改settings | 自动禁用并写settings | 用户应明确知晓，避免意外修改 |
| 跨市场阻止 | 默认阻止，root allowlist例外 | 允许所有，或阻止所有 | 安全第一，同时保留灵活性 |
| AlreadyEnabled处理 | 跳过，不重新安装 | 强制重新安装到同一scope | 避免意外修改用户的scope/设置 |
| Fixed-point迭代 | 多次迭代直到无变化 | 单次迭代，不处理传递降级 | 正确性：A→B→C，禁用C应同时降级A和B |

**源码测试证据：**
- `src/utils/plugins/dependencyResolver.ts`
- `resolveDependencyClosure()` [行范围 95-159]
- `verifyAndDemote()` [行范围 177-234]
- `findReverseDependents()` [行范围 244-262]
- `qualifyDependency()` [行范围 38-46]

---

#### 模块：UI与Commands - /plugin命令与插件UI

**真实入口签名与关键类型：**
```typescript
// 命令入口 - src/commands/plugin/index.tsx
const plugin = {
  type: 'local-jsx',
  name: 'plugin',
  aliases: ['plugins', 'marketplace'],
  description: 'Manage Claude Code plugins',
  immediate: true,
  load: () => import('./plugin.js')
} satisfies Command

// 主要UI组件
- ManagePlugins: 插件管理主界面
- DiscoverPlugins: 发现/浏览marketplace插件
- BrowseMarketplace: 浏览单个marketplace
- PluginOptionsDialog: 插件配置选项对话框
- PluginOptionsFlow: 用户配置引导流
- PluginSettings: 插件设置
- ManageMarketplaces: 市场管理
- AddMarketplace: 添加marketplace向导
- ValidatePlugin: 插件验证工具
- PluginErrors: 错误显示

// 关键操作入口（来自pluginOperations.ts）
- installPlugin()
- uninstallPlugin()
- enablePlugin()
- disablePlugin()
- refreshPlugin()
- refreshAllPlugins()
- installMarketplacePlugin()
```

**输入输出：**
| 组件/函数 | 输入 | 输出/交互 |
|----------|------|---------|
| `/plugin`命令 | 可选子命令（`install`/`uninstall`/`enable`/`disable`/`refresh`/`marketplace`） | 启动插件管理UI |
| `ManagePlugins` | 当前插件列表 | 用户交互：install/uninstall/enable/disable/refresh |
| `DiscoverPlugins` | Marketplaces列表 | 插件浏览与安装 |
| `PluginOptionsDialog` | 插件userConfig schema | 配置表单，保存到settings/secure storage |

**状态与文件布局：**
| 状态类型 | 位置/结构 | 持久化 |
|---------|---------|------|
| enabledPlugins | `settings.json`（各scope） | 是 |
| pluginConfigs | `settings.json` → `{ pluginId: { options: {}, optionsVersion: number } }` | 是 |
| 敏感配置 | macOS keychain / Windows Credential / `.credentials.json` | 是（安全存储） |
| UI临时状态 | React状态，会话级 | 否 |
| pluginOptionsStorage | 内存 + 可选持久化 | 部分 |

**UI流程：**

**安装流程：**
1. 用户在`DiscoverPlugins`选择插件 → 点击"Install"
2. 调用`resolveDependencyClosure()`计算closure
3. 显示确认对话框（包含依赖数量）
4. 用户确认 → `installMarketplacePlugin()`逐个安装
5. 调用`enablePlugin()`写入settings
6. 调用`clearPluginCache()`清除memoization
7. UI刷新显示新插件

**配置流程 (PluginOptionsFlow)：**
1. 插件manifest声明`userConfig` schema
2. 用户启用插件或点击"Configure" → `PluginOptionsDialog`
3. 根据schema类型渲染表单：
   - `string`/`number`/`boolean`：基础输入
   - `directory`/`file`：路径选择器
   - `sensitive: true`：密码输入，保存到secure storage
4. 验证用户输入
5. 非敏感值保存到`settings.json`的`pluginConfigs.{pluginId}.options`
6. 敏感值保存到secure storage
7. 递增`optionsVersion`触发重新加载

**Marketplace管理流程：**
1. `/plugin marketplace`或UI入口
2. 显示已知marketplaces列表（`getDeclaredMarketplaces()`）
3. "Add Marketplace" → `AddMarketplace`向导
4. 输入source（URL/GitHub/npm/本地路径）→ 验证 → 调用`addMarketplaceSource()`
5. "Refresh" → `refreshMarketplace()`
6. "Remove" → 确认 → `removeMarketplaceSource()`

**错误隔离与安全：**
- **插件错误不影响主系统**：插件加载错误收集在`errors`数组，主系统继续运行
- **敏感配置分离**：`sensitive: true`的字段不写入settings.json，存入secure storage
- **插件UI隔离**：插件提供的组件在隔离context运行（理论上，当前实现为inline）
- **企业策略UI反映**：UI显示marketplace是否被阻止/允许，不提供安装被阻止插件的按钮

**Coverage核对清单（不吞并MCP/Skills/Settings）：**
| 功能 | 覆盖模块 | 状态 |
|-----|---------|-----|
| 插件专用UI | `src/commands/plugin/` | ✓ 不吞并MCP/Skills UI |
| MCP集成 | `src/services/mcp/mcpPluginIntegration.ts` | ✓ 独立模块 |
| Skills加载 | `src/skills/` | ✓ 插件仅贡献路径，加载由skills模块处理 |
| Settings合并 | `cachePluginSettings()` | ✓ 插件仅提供settings片段，合并由settings系统处理 |
| Hooks集成 | `loadPluginHooks()` | ✓ 插件贡献hooks，触发由hooks系统处理 |
| Commands加载 | `getCommands()`调用`loadPluginCommands()` | ✓ 插件贡献路径，注册由commands系统处理 |
| Agents加载 | `getAgentDefinitionsWithOverrides()` | ✓ 插件贡献路径，加载由agents系统处理 |

**设计取舍/备选：**
| 决策 | 采用方案 | 备选方案 | 理由 |
|-----|---------|---------|-----|
| UI架构 | 集中式`/plugin`命令，JSX组件 | 插件可贡献自定义UI | 当前scope控制，未来可扩展 |
| 设置存储 | 非敏感settings.json，敏感secure storage | 全部settings.json，或全部secure | 安全与便利性平衡 |
| Marketplace源输入 | 接受多种格式（URL/GitHub/npm/本地） | 仅JSON配置 | 用户体验更好 |
| 依赖安装确认 | 显示closure列表，用户确认 | 静默自动安装 | 用户知情，避免意外安装大量插件 |

**源码测试证据：**
- `src/commands/plugin/index.tsx`
- `src/commands/plugin/ManagePlugins.tsx`
- `src/commands/plugin/DiscoverPlugins.tsx`
- `src/commands/plugin/PluginOptionsDialog.tsx`
- `src/commands/plugin/ManageMarketplaces.tsx`
- `src/commands/plugin/AddMarketplace.tsx`

### 4.4 主控制流

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

### 4.5 数据结构与持久化

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

### 4.6 跨子系统依赖

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
