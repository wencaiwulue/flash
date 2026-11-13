---
id: settings
batch: 3
title: Settings 设置来源、合并与变更生命周期设计
date: 2026-11-12
status: draft
---

# Settings 设置来源、合并与变更生命周期设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

当用户需要配置 Claude Code 的行为时（权限规则、模型选择、环境变量等），系统需要从多个来源读取配置、合并冲突、检测变更、验证有效性并通知相关模块。如果没有统一的设置系统，会导致：

- 配置来源分散且优先级不明确，用户不知道在哪改配置
- 没有合并策略，多来源配置冲突时行为不可预测
- 没有变更检测，配置文件更新后需要重启才能生效
- 没有 schema 验证，拼写错误导致的配置无效被静默忽略
- 没有迁移机制，旧版本配置在新版本中无法正确加载
- 没有安全边界，auth 凭据、plugins 状态等敏感数据被错误地复制到设置域

因此本子系统必须在以下约束下完成设置管理：

- 支持多来源配置：userSettings、projectSettings、localSettings、flagSettings、policySettings（远程托管、MDM、本地策略文件）
- 明确的优先级：user < project < local < flag < policy（注意：policySettings 作为最高优先级）
- 数组类型的合并：使用 concat+dedupe 而不是覆盖
- 对象类型的合并：深度合并
- 变更检测：支持文件系统监听（chokidar）和 MDM 轮询
- Schema 验证：使用 Zod 验证每个来源的配置，验证失败时保留原始数据但不使用
- 数据安全：绝不把 auth 凭据、plugins 状态、global config 的其他敏感字段复制到设置域
- 兼容性：支持从旧版本 global config 迁移到新的设置结构
- 失败开放策略：配置读取失败时返回默认值，不阻止程序启动

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 多来源优先级：user < project < local < flag < policy | `SETTING_SOURCES` 数组按优先级排序，从低到高合并，policySettings 最后覆盖 | 允许项目配置覆盖全局用户配置，本地（gitignored）配置覆盖项目，临时 flag 覆盖持久配置，企业策略拥有最高控制权 | 只有一个来源：灵活性不足，无法区分共享配置和本地覆盖；倒序优先级：用户无法覆盖企业策略，体验差 | 需按正确顺序合并，调试时需检查多层来源 | `src/utils/settings/constants.ts:7-22` |
| 数组合并：concat + dedupe，而不是覆盖 | `settingsMergeCustomizer` 使用 `uniq([...targetArray, ...sourceArray])` | 权限规则等数组类型需要累加，而不是后面覆盖前面；例如项目允许一条规则，用户本地再添加另一条，两者都应该生效 | 完全覆盖：用户会意外丢失上层来源的规则；只取最后来源：规则来源分散，难以理解 | 数组类型无法精确删除，只能通过 undefined 方式或在前面来源覆盖 | `src/utils/settings/settings.ts:529-547` |
| 对象合并：深度合并，undefined 表示删除 | `mergeWith` 配合自定义合并器，当 srcValue === undefined 时从目标对象中删除该 key | 允许用户明确删除某个配置项（如禁用某个 plugin），而不只能覆盖 | 不支持删除：配置只能增加不能减少，导致堆积；使用 null 表示删除：与某些配置项的有效值 null 冲突 | 需正确使用 undefined 语义，不能误用 null 表示删除 | `src/utils/settings/settings.ts:482-494` |
| 各来源独立验证，验证失败时保留原始文件但不使用该来源的配置 | `parseSettingsFile` 中，先过滤无效权限规则，再用 Zod 验证；验证失败返回 null，不合并该来源 | 单个来源的配置错误不影响其他来源，同时保留原始文件让用户可以修复（而不是覆盖为有效配置，丢失用户数据） | 整体失败：一个来源无效则所有来源都失效，可用性差；自动修复：可能意外丢失用户意图 | 需要容错设计，验证失败不抛出，只记录错误并跳过该来源 | `src/utils/settings/settings.ts:178-246` |
| 设置与 global config 分离：不同域，不同文件 | `settings.json`（设置域）与 `~/.claude.json`（global config 域）完全独立；global config 包含 auth 凭据、用户 ID、会话状态等，设置域只包含可配置的行为选项 | 安全边界清晰：auth 凭据绝不进入设置域；设置可以被远程托管（policySettings），而 global config 是本地状态 | 混用在一起：安全风险高，远程策略可能意外覆盖凭据；需要复杂的过滤逻辑 | 需要维护两套系统，某些历史配置需从 global config 迁移到 settings | `src/utils/config.ts:1-184` |
| 变更检测：chokidar 监听文件 + MDM 轮询 + 内部写入标记 | `settingsChangeDetector` 监听文件，`internalWrites` 标记自身写入避免触发变更；MDM 使用 30 分钟轮询 | 配置文件被外部编辑器修改时可以热加载；自身写入不会引起循环更新；MDM/注册表没有文件变更事件，只能轮询 | 只在启动读取：用户体验差，每次改配置都要重启；不标记内部写入：自身写入也触发变更通知，造成循环 | 需要监听多个位置，处理删除-重建模式，轮询间隔权衡 | `src/utils/settings/changeDetector.ts:66-490` |
| 会话级缓存：避免重复读取和解析文件 | `getSettingsWithErrors` 首次读取后缓存，`resetSettingsCache` 重置；远程设置有独立的 `sessionCache` | 性能：启动阶段多次读取 settings 都走缓存，避免重复 I/O 和解析；一致性：同一会话内 settings 读取结果一致 | 没有缓存：每次读取都读磁盘，慢且可能读到部分写入；永久缓存：变更检测失效 | 需要正确管理缓存失效时机，变更时立即重置 | `src/utils/settings/settingsCache.ts:1-40` |
| policySettings 多来源按优先级选择第一个非空：remote > MDM > file > HKCU | `getSettingsForSourceUncached` 中 policySettings 依次尝试各来源，第一个有内容则返回，不合并 | 企业策略是单一权威来源：远程托管有就用远程，没有则看 MDM，再看本地策略文件，最后是 HKCU（用户级） | 合并多个策略来源：冲突时行为难以预测，管理员无法确定哪个策略生效 | 管理员需确保只配置一个策略来源，或知道优先级顺序 | `src/utils/settings/settings.ts:322-344` |
| 远程托管设置：checksum 缓存 + graceful degradation + 安全检查 | `loadRemoteManagedSettings` 使用 sha256 checksum 做 ETag 缓存，fetch 失败时回退到本地缓存；应用前做安全检查，危险变更需用户确认 | 减少网络传输（304 Not Modified）；网络故障时不影响使用（使用缓存）；安全检查防止恶意配置破坏用户环境 | 每次都 fetch：流量大，延迟高；无缓存：网络故障时完全没有策略；无安全检查：风险太高 | 需要实现缓存、重试、安全检查，增加复杂度 | `src/services/remoteManagedSettings/index.ts:1-639` |
| 权限规则先过滤再验证：无效规则被移除但保留其他 | `filterInvalidPermissionRules` 移除无效规则并生成警告，然后再做整体 schema 验证 | 单个规则的错误不导致整个 settings 文件失效，用户可以逐步修复 | 整体验证失败：一个拼写错误导致所有配置都不生效 | 需要预扫描规则并生成用户友好的警告 | `src/utils/settings/validation.ts:224-265` |
| 迁移系统：按需将旧配置从 global config 移到 settings | `migrateAutoUpdatesToSettings`、`migrateBypassPermissionsAcceptedToSettings` 等迁移函数，在启动时检查并执行 | 平滑升级：旧版本配置在新版本中仍然生效，无需用户手动重新配置 | 不迁移：用户升级后配置丢失，体验差；强制重写：可能破坏用户当前配置 | 需要维护迁移代码，直到足够多用户都升级 | `src/migrations/migrateAutoUpdatesToSettings.ts:1-61` |
| settings sync：只同步允许列表的字段，按项目分离 | `uploadUserSettingsInBackground` 和 `downloadUserSettings` 只同步 userSettings、userMemory 和项目级 localSettings/memory；使用 project hash 区分不同项目 | 用户可以在多设备间同步配置，而不会同步敏感数据（auth 等）；项目级配置与项目绑定 | 同步所有：安全风险高；无项目分离：不同项目的配置混在一起 | 需要同步服务端支持，网络故障时 fail-open | `src/services/settingsSync/index.ts:1-582` |

## 3. 目标与非目标

### 状态与生命周期

- **目标**：`getSettingsWithErrors` 返回合并后的 settings 和所有来源的验证错误
- **目标**：`settingsChangeDetector.subscribe` 可以监听配置变更并得到通知
- **目标**：`updateSettingsForSource` 可以更新某个来源的配置并持久化
- **目标**：`policyLimits` 从服务器获取企业限制并缓存
- **非目标**：不保证 `updateSettingsForSource` 的并发安全（同一进程内通常串行）

### 接口与数据

- **目标**：`SettingsSchema` 定义完整的设置结构，Zod 验证提供类型安全
- **目标**：`SettingSource` 枚举表示来源类型，`EditableSettingSource` 区分可编辑来源
- **目标**：配置变更时发出 `ConfigChange` hook，hook 可以阻塞变更应用
- **非目标**：不提供设置的 UI 编辑（由 /config 命令和各组件负责）
- **非目标**：不保证跨版本的 `SettingsJson` 格式完全不变（有迁移机制）

### 执行与环境

- **目标**：支持 CLI 模式、SDK 嵌入模式、远程托管模式
- **目标**：支持 feature flag 控制（`TRANSCRIPT_CLASSIFIER`、`TEAM_MEM` 等）
- **目标**：失败开放策略：任何来源读取失败都不阻止程序启动
- **非目标**：不支持 Web 环境的设置同步
- **非目标**：不支持实时双向同步（只单向检测文件变更并重新加载）

### 依赖边界

- **Global Config**：auth 凭据、会话状态、用户 ID 等由 `config.ts` 管理，本文只描述边界，主设计不属于本文
- **Permissions**：权限规则是 settings 的一部分，但权限裁决逻辑由 permissions spec 负责
- **Hooks**：ConfigChange hook 由 hooks 系统触发，本文只描述通知机制
- **Remote Managed Settings**：远程策略获取属于本文范围，但 API 契约细节不深入

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 主要读取入口
function getSettingsWithErrors(): SettingsWithErrors  // 返回合并设置+所有验证错误
function getInitialSettings(): SettingsJson  // 只返回设置，忽略错误
function getSettingsForSource(source: SettingSource): SettingsJson | null

// 写入入口
function updateSettingsForSource(
  source: EditableSettingSource,
  settings: SettingsJson
): { error: Error | null }

// 变更检测
const settingsChangeDetector = {
  initialize(): Promise<void>,
  dispose(): Promise<void>,
  subscribe(listener: (source: SettingSource) => void): () => void,
  notifyChange(source: SettingSource): void
}

// 远程托管设置
async function loadRemoteManagedSettings(): Promise<void>
async function refreshRemoteManagedSettings(): Promise<void>
function isEligibleForRemoteManagedSettings(): boolean
async function waitForRemoteManagedSettingsToLoad(): Promise<void>

// 策略限制
function isPolicyAllowed(policy: string): boolean
async function loadPolicyLimits(): Promise<void>

// 设置同步
async function uploadUserSettingsInBackground(): Promise<void>
function downloadUserSettings(): Promise<boolean>
```

调用方式：

1. **启动路径**：`main.tsx` 先 `initializePolicyLimitsLoadingPromise()`，再 `loadRemoteManagedSettings()` 和 `loadPolicyLimits()`，最后 `settingsChangeDetector.initialize()`
2. **读取路径**：任何模块调用 `getInitialSettings()` 获取当前合并配置
3. **写入路径**：用户通过 `/config` 或组件修改配置，调用 `updateSettingsForSource()` 持久化
4. **变更路径**：外部编辑配置文件或 MDM 更新，`settingsChangeDetector` 检测到并通知订阅者，订阅者调用 `resetSettingsCache()` 并重新读取

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `settings.ts` | 无（纯函数 + 从缓存读取） | `getSettingsWithErrors`、`getSettingsForSource`、`updateSettingsForSource`、`loadManagedFileSettings` | UI 渲染、权限裁决 | 接收 `SettingSource`，返回 `SettingsJson` 或 `SettingsWithErrors` |
| `settingsCache.ts` | `parsedFiles`、`sourceSettings`、`sessionSettings`（模块级变量） | `getCachedParsedFile`、`setCachedParsedFile`、`resetSettingsCache` | 实际文件 I/O | 提供缓存接口给 `settings.ts` 和变更检测 |
| `changeDetector.ts` | `watcher` (chokidar)、`mdmPollTimer`、`pendingDeletions`、`lastMdmSnapshot` | `initialize`、`dispose`、`subscribe`、`notifyChange` | 变更后的业务逻辑（只负责通知） | 发出 `SettingSource` 变更通知，支持 ConfigChange hooks |
| `validation.ts` | 无（纯函数） | `formatZodError`、`validateSettingsFileContent`、`filterInvalidPermissionRules` | 错误修复（只报告） | 接收原始数据，返回 `ValidationError[]` |
| `permissionValidation.ts` | 无（纯函数） | `validatePermissionRule`、`PermissionRuleSchema` | 规则应用（只验证格式） | 接收规则字符串，返回验证结果 |
| `constants.ts` | 无（常量） | `SETTING_SOURCES`、`getSettingSourceName`、`getEnabledSettingSources` | 优先级逻辑 | 提供来源枚举和工具函数 |
| `internalWrites.ts` | `internalWritePaths` (Set) | `markInternalWrite`、`consumeInternalWrite`、`clearInternalWrites` | 实际写入 | 跟踪自身写入避免触发变更 |
| `managedPath.ts` | 无（纯函数） | `getManagedSettingsPath`、`getManagedSettingsDropInDir` | 读取策略 | 提供策略文件路径 |
| `types.ts` | 无（类型定义） | `SettingsSchema`、`SettingsJson` 类型 | 运行时逻辑 | Zod schema + TypeScript 类型 |
| `remoteManagedSettings/index.ts` | `sessionCache`、`pollingIntervalId`、`loadingCompletePromise` | `loadRemoteManagedSettings`、`refreshRemoteManagedSettings`、`isEligibleForRemoteManagedSettings` | 策略应用（只获取） | 获取远程策略并缓存，通知变更 |
| `policyLimits/index.ts` | `sessionCache`、`pollingIntervalId`、`loadingCompletePromise` | `loadPolicyLimits`、`isPolicyAllowed` | 限制执行（只查询） | 提供 `isPolicyAllowed()` 检查接口 |
| `settingsSync/index.ts` | `downloadPromise`（缓存） | `uploadUserSettingsInBackground`、`downloadUserSettings`、`redownloadUserSettings` | 冲突解决（只上传/下载） | 同步用户设置到服务器或从服务器下载 |

状态位置与理由：

- **会话缓存**放在模块级变量（`settingsCache.ts`）：同一进程内共享，变更时重置
- **变更检测器状态**放在模块级变量（`changeDetector.ts`）：只在启动时初始化一次，清理时 dispose
- **远程设置缓存**放在模块级变量 + 文件缓存：进程内快速读取，进程间通过文件共享，网络故障时回退
- **internalWrite 标记**放在模块级变量（`internalWrites.ts`）：跟踪自身写入，避免循环触发变更通知

### 4.3 主控制流

完整设置加载与合并流（端到端）：

```text
启动初始化
  ↓
initializePolicyLimitsLoadingPromise()
  ↓
loadRemoteManagedSettings()
  ├─ 检查 isEligibleForRemoteManagedSettings()
  ├─ 读取本地缓存文件（如有）
  ├─ fetch 远程设置（带 checksum ETag）
  │   ├─ 304 Not Modified → 使用缓存
  │   ├─ 200 → 验证 schema → 安全检查 → 保存本地缓存
  │   └─ 失败 → 使用缓存（如有）或 null
  └─ notifyChange('policySettings')（如有变更）
  ↓
loadPolicyLimits()
  ├─ 类似远程设置流程
  └─ 缓存到 session 和文件
  ↓
settingsChangeDetector.initialize()
  ├─ 扫描现有设置文件
  ├─ 启动 chokidar 监听
  └─ 启动 MDM 轮询（30 分钟）
  ↓
首次读取 getInitialSettings()
  ↓
getSettingsWithErrors()
  ├─ 检查 sessionSettings 缓存 → 未命中
  ├─ 按优先级顺序读取各来源：
  │   ├─ userSettings → parseSettingsFile() → 验证 → 过滤无效规则
  │   ├─ projectSettings → parseSettingsFile() → 验证 → 过滤无效规则
  │   ├─ localSettings → parseSettingsFile() → 验证 → 过滤无效规则
  │   ├─ flagSettings → parseSettingsFile() + 合并 inline settings
  │   └─ policySettings → 依次尝试 remote → MDM → file → HKCU → 取第一个非空
  ├─ 从低到高合并各来源
  │   ├─ 对象：深度合并
  │   ├─ 数组：concat + dedupe
  │   └─ 字段值为 undefined → 从目标删除
  ├─ 收集所有验证错误
  └─ 缓存到 sessionSettings
  ↓
返回合并后的 SettingsJson
```

配置变更检测与通知流：

```text
外部编辑器修改 settings.json
  ↓
chokidar 检测到 'change' 或 'add' 事件
  ↓
检查是否为 internalWrite（5 秒窗口）
  ├─ 是 → 忽略
  └─ 否 → 继续
  ↓
executeConfigChangeHooks() 先运行 hooks
  ├─ hook 返回 exit code 2 → 阻塞变更
  └─ hook 通过 → 继续
  ↓
fanOut(source)
  ├─ resetSettingsCache() 清空缓存
  └─ settingsChanged.emit(source) 通知订阅者
  ↓
订阅者重新读取 getInitialSettings()
  ↓
应用新配置（如更新环境变量、刷新权限等）
```

删除-重建模式的特殊处理：

```text
文件被删除（'unlink' 事件）
  ↓
创建 pendingDeletion 定时器（6.5 秒）
  ↓
等待...
  ↓
如果在窗口内收到 'add' 或 'change' → 取消定时器，当作变更处理
如果超时 → 当作真正删除处理，通知订阅者
```

### 4.4 数据结构与持久化

关键数据结构：

```typescript
// 设置来源
type SettingSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'

type EditableSettingSource = Exclude<SettingSource, 'policySettings' | 'flagSettings'>

// 合并设置结果
type SettingsWithErrors = {
  settings: SettingsJson
  errors: ValidationError[]
}

// 验证错误
type ValidationError = {
  file?: string
  path: FieldPath  // 点号分隔，如 "permissions.defaultMode"
  message: string
  expected?: string
  invalidValue?: unknown
  suggestion?: string
  docLink?: string
  mcpErrorMetadata?: { ... }
}

// 设置 schema（简化）
const SettingsSchema = z.object({
  apiKeyHelper: z.string().optional(),
  awsCredentialExport: z.string().optional(),
  awsAuthRefresh: z.string().optional(),
  gcpAuthRefresh: z.string().optional(),
  env: z.record(z.string(), z.coerce.string()).optional(),
  permissions: PermissionsSchema.optional(),
  model: z.string().optional(),
  availableModels: z.array(z.string()).optional(),
  modelOverrides: z.record(z.string(), z.string()).optional(),
  hooks: HooksSchema.optional(),
  worktree: z.object({
    symlinkDirectories: z.array(z.string()).optional(),
    sparsePaths: z.array(z.string()).optional()
  }).optional(),
  enabledPlugins: z.record(z.string(), z.union([z.array(z.string()), z.boolean()])).optional(),
  // ... 更多字段
}).passthrough()

// 权限规则（在 SettingsSchema 内部）
const PermissionsSchema = z.object({
  allow: z.array(PermissionRuleSchema).optional(),
  deny: z.array(PermissionRuleSchema).optional(),
  ask: z.array(PermissionRuleSchema).optional(),
  defaultMode: z.enum(PERMISSION_MODES).optional(),
  disableBypassPermissionsMode: z.enum(['disable']).optional(),
  disableAutoMode: z.enum(['disable']).optional(),
  additionalDirectories: z.array(z.string()).optional()
})
```

持久化：

- **userSettings**：`~/.claude/settings.json`（或 cowork 模式下的 `cowork_settings.json`）
- **projectSettings**：`<cwd>/.claude/settings.json`（受 git 版本控制）
- **localSettings**：`<cwd>/.claude/settings.local.json`（自动添加到 .gitignore）
- **policySettings（file）**：`getManagedSettingsPath()` 的 `managed-settings.json` + `managed-settings.d/*.json`（drop-in 文件按字母顺序合并）
- **policySettings（MDM/HKLM）**：Windows 注册表或 macOS 配置文件（平台相关）
- **policySettings（remote）**：`~/.claude/remote-settings.json`（本地缓存）
- **policyLimits**：`~/.claude/policy-limits.json`（本地缓存）
- **global config**：`~/.claude.json`（完全独立的域，不与 settings 混用）

恢复时：

- 从各文件读取并重新合并
- 远程设置和 policy limits 有本地缓存，网络不可用时使用缓存
- 缓存失效或缺失时重新 fetch

### 4.5 跨子系统依赖

- **Global Config**：`config.ts` 管理 auth 凭据、会话状态等，与 settings 完全独立；某些历史配置需迁移到 settings；本文只描述安全边界
- **Permissions**：权限规则是 settings 的一部分，但权限裁决逻辑由 permissions spec 负责；本文只描述规则的存储和合并
- **Hooks**：ConfigChange hook 由 hooks 系统触发，本文只描述变更检测调用 hooks 的机制；hooks spec 主拥有 hook 执行
- **MCP**：MCP 服务器配置是 settings 的一部分，mcp spec 主拥有实际加载和连接逻辑
- **Plugins**：plugin 配置是 settings 的一部分，plugins spec 主拥有 plugin 加载和生命周期
- **Query Core**：query 读取 settings 但不写入；本文只描述读取接口，query-core spec 主拥有使用方式
- **Settings Sync**：属于本文范围，描述上传和下载逻辑

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| settings.json JSON 语法错误 | `parseSettingsFile` | 记录 `ValidationError`，不抛出 | 否（只在启动或变更时读取一次） | 该来源被跳过，其他来源继续合并 | 返回默认值 + 验证错误 |
| settings.json schema 验证失败 | `parseSettingsFile` | 记录 `ValidationError`，不抛出 | 否 | 该来源被跳过，原始文件保留不被覆盖 | 返回默认值 + 验证错误 |
| 远程设置 fetch 失败 | `fetchRemoteManagedSettings` | 记录日志，不抛出 | 5 次指数退避，然后使用缓存 | 无特殊清理，保留现有缓存 | 使用本地缓存（如有）或无策略 |
| 远程设置 checksum 304 | `fetchRemoteManagedSettings` | 不传播，正常流程 | 否（无需重试） | 无，使用缓存 | 直接使用缓存，不重新应用 |
| 配置文件被删除 | `changeDetector.ts` 'unlink' | 触发删除定时器（6.5 秒） | 否 | 等待看是否重建，是则当变更处理 | 超时后通知订阅者删除 |
| MDM 轮询失败 | `changeDetector.ts` poll 回调 | 记录 debug 日志，不抛出 | 下一次轮询（30 分钟后）自动重试 | 无，保留上次快照 | 不通知变更，继续使用旧值 |
| ConfigChange hook 返回 exit code 2 | `changeDetector.ts` executeConfigChangeHooks | hook 结果被检查，阻塞变更 | 否（只尝试一次） | 不 reset 缓存，不通知订阅者 | 变更被忽略，继续使用旧配置 |
| updateSettingsForSource 写入失败 | `updateSettingsForSource` | 返回 `{ error: Error }` | 否（调用方决定是否重试） | 内存中的缓存已更新？不，写入失败时不更新缓存 | 调用方收到错误，可向用户显示 |
| policyLimits 读取失败 | `loadPolicyLimits` | 记录日志，不抛出 | 5 次指数退避，然后使用缓存或默认 | 无，保留现有状态 | `isPolicyAllowed()` 总是返回 true（fail-open） |
| settings sync 上传/下载失败 | `settingsSync/index.ts` | 记录日志，不抛出 | upload 不重试（后台任务）；download 有 3 次重试 | 无，不影响本地配置 | 静默失败，用户可手动重试 |

工程取舍：

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| 失败开放策略：任何配置错误都不阻止启动 | schema 验证失败只跳过该来源，继续用其他来源 | 配置错误可能被忽略，用户直到使用时才发现 | 极高可用性，一个来源坏了不影响整体使用 |
| internalWrite 5 秒窗口：自身写入在此期间不触发变更 | `markInternalWrite` 记录路径，`consumeInternalWrite` 检查时间窗口 | 窗口太短可能漏过某些慢速写入；太长可能忽略真正的外部变更 | 避免循环触发：自身更新不引起自身重新加载 |
| policySettings 多来源只取第一个非空：不合并 | remote > MDM > file > HKCU，找到第一个有内容就返回 | 管理员需要理解优先级，不能跨来源合并策略 | 单一权威来源，行为可预测 |
| 数组使用 concat+dedupe 而不是覆盖 | 权限规则等数组累加 | 无法精确删除上层来源的某条规则，只能在下层重新定义或用 undefined | 自然的组合行为，用户可以在本地添加规则而不丢失项目规则 |
| MDM 30 分钟轮询：没有文件系统事件只能轮询 | 每 30 分钟对比一次 MDM 快照 | 延迟高，变更最多需要 30 分钟才能生效 | 实现简单，兼容没有文件监听能力的平台 |
| 删除-重建 6.5 秒窗口：避免把原子替换当作删除+变更 | unlink 后等待，收到 add/change 则取消 | 窗口期间删除不会立即生效，需要等超时 | 兼容使用删除-重建模式写入的编辑器（如 vim） |
| 远程设置安全检查：危险变更需要用户确认 | `checkManagedSettingsSecurity` + `handleSecurityCheckResult` | 增加用户交互步骤，可能中断自动化 | 安全：防止恶意配置破坏用户环境 |
| settings 与 global config 分离：两个独立文件系统 | settings.json vs ~/.claude.json，绝不混用 | 需要维护两套系统，某些字段需要迁移 | 清晰的安全边界：auth 绝不进入 settings，settings 可以被远程托管 |

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| userSettings 有一条 allow 规则，projectSettings 有另一条 | 启动读取 getInitialSettings() | 两条规则都在 permissions.allow 数组中 | 后面来源不能覆盖前面来源的数组，只能追加 |
| userSettings 设置 model: 'opus'，projectSettings 设置 model: 'sonnet' | 启动读取 | 最终 model 是 'sonnet'（project 覆盖 user） | 不能是 'opus' 或其他值 |
| 某个来源的 settings.json 有 JSON 语法错误 | 启动读取 | 该来源被跳过，其他来源继续合并；原始文件不被覆盖 | 不能因为一个来源坏了导致所有配置都失效 |
| 用户在编辑器中修改 project/settings.json | 运行中编辑 | settingsChangeDetector 发出通知，订阅者重新读取配置 | 不能需要重启才能生效 |
| updateSettingsForSource 写入 userSettings | 调用写入 API | internalWrite 被标记，不触发变更通知 | 不能自己写入又触发自己重新加载 |
| policySettings 有远程配置和本地文件 | 启动且网络正常 | 使用远程配置，忽略本地文件 | 不能合并远程和本地策略 |
| 远程设置 fetch 失败（网络断开） | 启动且有本地缓存 | 使用本地缓存，不影响使用 | 不能因为网络故障而没有策略 |
| 权限规则有一条格式错误（如拼写错误的工具名） | 启动读取 | 该规则被过滤并生成警告，其他规则保留 | 不能因为一条坏规则导致整个权限配置失效 |
| ConfigChange hook 返回 exit code 2 | 配置文件变更 | 变更被阻塞，缓存不重置，订阅者不被通知 | 不能忽略 hook 的阻塞决定 |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 多来源优先级 user < project < local < flag < policy | `src/utils/settings/constants.ts:7-22` | 需查找相关测试 | 未找到直接测试覆盖 |
| 数组合并 concat+dedupe，对象深度合并 | `src/utils/settings/settings.ts:529-547` | 需查找相关测试 | 未找到直接测试覆盖 |
| undefined 表示删除 | `src/utils/settings/settings.ts:482-494` | 需查找相关测试 | 未找到直接测试覆盖 |
| 各来源独立验证，失败时保留原始文件 | `src/utils/settings/settings.ts:178-246` | 需查找相关测试 | 未找到直接测试覆盖 |
| settings 与 global config 分离，有安全边界 | `src/utils/config.ts:1-184` + `src/utils/settings/types.ts` | 需查找相关测试 | 未找到直接测试覆盖 |
| 变更检测 chokidar + MDM 轮询 + internalWrite | `src/utils/settings/changeDetector.ts:66-490` | 需查找相关测试 | 未找到直接测试覆盖 |
| 会话级缓存避免重复读取 | `src/utils/settings/settingsCache.ts:1-40` | 需查找相关测试 | 未找到直接测试覆盖 |
| policySettings 多来源只取第一个非空 | `src/utils/settings/settings.ts:322-344` | 需查找相关测试 | 未找到直接测试覆盖 |
| 远程设置 checksum 缓存 + graceful degradation + 安全检查 | `src/services/remoteManagedSettings/index.ts:1-639` | 需查找相关测试 | 未找到直接测试覆盖 |
| 权限规则先过滤再验证 | `src/utils/settings/validation.ts:224-265` | 需查找相关测试 | 未找到直接测试覆盖 |
| 迁移系统从 global config 移到 settings | `src/migrations/migrateAutoUpdatesToSettings.ts:1-61` | 需查找相关测试 | 未找到直接测试覆盖 |

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `src/utils/settings/types.ts` | `SettingsSchema`、`SettingsJson`、`PermissionRuleSchema`、`AllowedMcpServerEntrySchema` | 设置类型定义和 Zod schema |
| `src/utils/settings/settings.ts` | `getSettingsWithErrors`、`getInitialSettings`、`getSettingsForSource`、`updateSettingsForSource`、`loadManagedFileSettings`、`settingsMergeCustomizer` | 核心设置读取、合并、写入逻辑 |
| `src/utils/settings/constants.ts` | `SETTING_SOURCES`、`SettingSource`、`EditableSettingSource`、`getEnabledSettingSources`、`getSettingSourceName` | 设置来源枚举和工具函数 |
| `src/utils/settings/changeDetector.ts` | `settingsChangeDetector`、`initialize`、`dispose`、`subscribe`、`notifyChange` | 设置变更检测与通知 |
| `src/utils/settings/validation.ts` | `formatZodError`、`validateSettingsFileContent`、`filterInvalidPermissionRules` | 设置验证与错误格式化 |
| `src/utils/settings/permissionValidation.ts` | `validatePermissionRule`、`PermissionRuleSchema` | 权限规则格式验证 |
| `src/utils/settings/settingsCache.ts` | `resetSettingsCache`、`getCachedParsedFile`、`setCachedParsedFile` | 会话级缓存管理 |
| `src/utils/settings/internalWrites.ts` | `markInternalWrite`、`consumeInternalWrite`、`clearInternalWrites` | 内部写入标记，避免循环触发变更 |
| `src/utils/settings/managedPath.ts` | `getManagedSettingsPath`、`getManagedSettingsDropInDir` | 策略文件路径管理 |
| `src/utils/settings/applySettingsChange.ts` | `applySettingsChange`（如有） | 设置变更应用（需确认是否存在） |
| `src/services/remoteManagedSettings/index.ts` | `loadRemoteManagedSettings`、`refreshRemoteManagedSettings`、`isEligibleForRemoteManagedSettings`、`waitForRemoteManagedSettingsToLoad`、`computeChecksumFromSettings` | 远程托管设置获取与缓存 |
| `src/services/remoteManagedSettings/syncCacheState.ts` | `getRemoteManagedSettingsSyncFromCache`、`setSessionCache`、`resetSyncCache` | 远程设置同步缓存状态（打破循环依赖） |
| `src/services/remoteManagedSettings/securityCheck.tsx` | `checkManagedSettingsSecurity`、`handleSecurityCheckResult` | 远程设置安全检查 |
| `src/services/policyLimits/index.ts` | `loadPolicyLimits`、`isPolicyAllowed`、`refreshPolicyLimits`、`clearPolicyLimitsCache` | 企业策略限制获取与查询 |
| `src/services/settingsSync/index.ts` | `uploadUserSettingsInBackground`、`downloadUserSettings`、`redownloadUserSettings` | 用户设置跨设备同步 |
| `src/migrations/migrateAutoUpdatesToSettings.ts` | `migrateAutoUpdatesToSettings` | autoUpdates 配置迁移 |
| `src/migrations/migrateBypassPermissionsAcceptedToSettings.ts` | `migrateBypassPermissionsAcceptedToSettings` | bypassPermissions 配置迁移 |
| `src/utils/config.ts` | `GlobalConfig`、`getGlobalConfig`、`saveGlobalConfig` | Global config 管理（独立于 settings） |

### 7.2 未覆盖行为（基于代码阅读）

- settings 与 global config 完整边界测试
- 远程设置安全检查的用户交互路径
- MDM/注册表设置在 Windows/macOS 上的实际行为
- ConfigChange hook 阻塞变更的完整流程
- settings sync 的端到端测试（上传+下载）
- policySettings drop-in 文件的合并顺序测试
- 删除-重建模式的完整测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/settings.yaml)

### 8.1 本 spec 主拥有的文件

| 分组 | 主拥有职责 |
|---|---|
| settings-types | SettingsSchema、SettingsJson 类型定义、权限规则验证 schema |
| settings-core | 核心设置读取、合并、写入逻辑 |
| settings-constants | SettingSource 枚举、来源优先级、工具函数 |
| settings-cache | 会话级缓存管理 |
| settings-change-detector | 文件变更监听、MDM 轮询、变更通知 |
| settings-validation | Zod 验证、错误格式化、无效规则过滤 |
| settings-internal-writes | 内部写入标记，避免循环触发 |
| settings-managed-path | 策略文件路径管理 |
| settings-mdm | MDM/注册表设置读取（平台相关） |
| remote-managed-settings | 远程托管设置获取、缓存、安全检查 |
| policy-limits | 企业策略限制获取与查询 |
| settings-sync | 用户设置跨设备同步（上传/下载） |
| settings-migrations | 从旧版本 global config 迁移到 settings |

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/utils/config.ts` → 主归 global config（不属于本文，只描述边界）
- `src/utils/permissions/*` → 主归 permissions spec，本文只描述权限规则的存储和验证
- `src/hooks/*` → 主归 hooks spec，本文只描述 ConfigChange hook 的调用
- `src/services/mcp/*` → 主归 mcp spec，本文只描述 MCP 配置在 settings 中的存储
- `src/services/plugins/*` → 主归 plugins spec，本文只描述 plugin 配置在 settings 中的存储

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | 数组类型无法精确删除，只能追加或覆盖整个数组 | 增加删除标记语法，如 `{ "delete": ["rule1", "rule2"] }`，或允许用特殊前缀的规则表示删除 | 中（需正确处理新旧版本兼容） | 在低优先级来源定义规则，高优先级来源可以精确删除它 | M | 已证实 |
| P2 | policySettings 多来源只取第一个，无法让管理员组合多个策略片段（除了 drop-in 文件） | 允许配置多个策略来源并合并（但需要明确的冲突解决规则） | 高（可能破坏现有单一权威来源的预期） | 两个策略来源都有配置时，能按预期合并 | L | 设计推断 |
| P2 | MDM 轮询间隔 30 分钟太长，变更可能需要很久才生效 | 允许更激进的轮询（如 5 分钟），或监听特定平台事件（如 macOS 的 configuration profile 更新通知） | 低（可配置） | MDM 变更在更短时间内被检测到 | M | 设计推断 |
| P3 | internalWrite 5 秒窗口是硬编码的，某些慢速文件系统可能不够 | 允许通过环境变量或设置配置窗口长度 | 低（向后兼容） | 配置更长窗口后，慢速写入不会误触发变更 | S | 设计推断 |
| P3 | 验证错误只在启动时报告一次，用户容易忽略 | 在 UI（如 /config 命令或状态栏）持续显示验证错误，直到修复 | 低（只影响 UI） | 用户能在 UI 中看到 settings.json 的验证错误 | M | 设计推断 |
