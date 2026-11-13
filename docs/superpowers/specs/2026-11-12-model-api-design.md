---
id: model-api
batch: 1
title: Model API 模型配置、请求与响应设计
date: 2026-11-12
status: draft
---

# Model API 模型配置、请求与响应设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

### 核心问题

当用户通过 `/model` 命令、环境变量或配置设置模型时，系统需要：
1. **多提供商适配**：支持 first-party、Bedrock、Vertex、Foundry 四种 API 提供商，每种有不同的模型 ID 格式
2. **模型别名解析**：用户输入 `opus`、`sonnet[1m]` 等别名时需要解析为完整的模型 ID
3. **降级策略**：Opus 连续 3 次 529 错误时自动降级到 Sonnet
4. **错误映射**：将原始 API 错误转换为用户可理解的消息
5. **流式与非流式回退**：流式失败时自动切换到非流式请求

### 约束条件

- **提供商可用性差异**：第三方提供商（Bedrock/Vertex/Foundry）的模型发布可能滞后于 first-party，默认模型选择需区分
- **1M 上下文访问**：Max/Team Premium 用户需要 `extraUsage` 启用才能访问 1M 上下文
- **模型白名单**：企业可通过 `availableModels` 配置限制可选模型
- **Mock 与 Live 验证分离**：测试时使用 VCR 或 mock，`live-model-validation.ts` 用于实际验证
- **不要复制 query-core 的恢复逻辑**：query-core 处理对话恢复，model-api 只处理 API 层的重试/降级

### 调用方与责任边界

```
┌─────────────────────────────────────────────────────────────┐
│  调用方                                                     │
│  ├─ Query Core (query.ts)        → 对话模型调用             │
│  ├─ Side Query (sideQuery.ts)    → 辅助模型调用             │
│  ├─ SDK (sdkQuery.ts)            → SDK 模型调用             │
│  └─ /model 命令                  → 模型选择 UI             │
└────────────────────────────────┬────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────┐
│  Model API (本 spec)                                          │
│  ├─ 模型配置与选择 (src/utils/model/)                        │
│  ├─ API 请求构造 (src/utils/api.ts)                          │
│  ├─ API 客户端 (src/services/api/client.ts)                  │
│  ├─ 模型调用 (src/services/api/claude.ts)                    │
│  ├─ 重试/降级 (src/services/api/withRetry.ts)                │
│  ├─ 错误处理 (src/services/api/errors.ts)                    │
│  └─ Live 验证 (scripts/live-model-validation.ts)             │
└────────────────────────────────┬────────────────────────────┘
                                 │
┌────────────────────────────────▼────────────────────────────┐
│  外部 API                                                    │
│  ├─ api.anthropic.com  (first-party)                         │
│  ├─ AWS Bedrock                                             │
│  ├─ Google Vertex                                           │
│  └─ Azure Foundry                                           │
└─────────────────────────────────────────────────────────────┘
```

## 2. 设计理由与备选方案

### 2.1 模型选择优先级

**当前设计**：
1. 会话覆盖（`setMainLoopModelOverride()`）
2. 启动参数 `--model`
3. 环境变量 `ANTHROPIC_MODEL`
4. 保存的设置 `settings.model`
5. 内置默认（Max/Team Premium→Opus，其他→Sonnet）

**证据位置**：`src/utils/model/model.ts` 的 `getUserSpecifiedModelSetting()` 和 `getMainLoopModel()`

**为什么这样设计**：
- 会话覆盖最高优先级，允许用户在不改变全局设置的情况下临时切换
- 环境变量和参数便于脚本和 CI/CD 使用
- 默认模型区分订阅层级，合理分配资源

**备选方案**：
- 备选 1：单一配置源。缺点是不够灵活，无法支持临时切换
- 备选 2：配置优先级反转（设置最高）。缺点是用户难以临时覆盖

**代价**：
- 配置来源多，调试时需要检查多个位置
- `resolveSkillModelOverride()` 需要处理 `[1m]` 后缀继承

---

### 2.2 模型 ID 归一化与别名

**当前设计**：
- 别名层：`opus`、`sonnet`、`haiku`、`best`、`opusplan`
- 后缀层：`[1m]` 表示 1M 上下文
- 解析层：`parseUserSpecifiedModel()` 转换为完整模型 ID
- 去除层：`normalizeModelStringForAPI()` 去除 `[1m]` 用于 API 调用
- 规范层：`getCanonicalName()` 转换为统一短名称（去除日期和提供商后缀）

**证据位置**：`src/utils/model/model.ts`、`src/utils/model/aliases.ts`

**为什么这样设计**：
- 别名便于用户记忆和输入
- `[1m]` 后缀独立于模型版本，同一别名可选择不同上下文窗口
- 归一化后便于成本计算、能力检查等跨提供商操作

**代价**：
- 多层转换容易混淆，需要注意每一层的输入输出
- `resolveSkillModelOverride()` 必须处理后缀继承，避免技能模型从 1M 降级

---

### 2.3 多提供商配置映射

**当前设计**：
- 每个模型在 `configs.ts` 中有四个提供商的对应 ID
- `getAPIProvider()` 根据环境变量确定当前提供商
- Bedrock 支持跨区域推理前缀（`us.`、`eu.`、`apac.`、`global.`）

**证据位置**：`src/utils/model/configs.ts`、`src/utils/model/providers.ts`、`src/utils/model/bedrock.ts`

**为什么这样设计**：
- 同一模型在不同提供商有不同的命名约定（日期格式、前缀等）
- 集中管理映射，避免散落各处的字符串替换
- Bedrock 跨区域前缀可动态切换，无需硬编码所有组合

**备选方案**：
- 备选 1：让用户直接输入提供商特定 ID。缺点是跨提供商迁移困难
- 备选 2：运行时查询可用模型。缺点是增加启动延迟，需要网络访问

**代价**：
- 发布新模型时需要在多处更新（`@[MODEL LAUNCH]` 标记帮助定位）
- 第三方提供商可能还没有最新模型，默认选择需保持旧版本

---

### 2.4 重试策略与降级触发

**当前设计**：
- 默认最多 10 次重试，指数退避（基础 500ms，最大 32s）
- 529 错误仅前台查询源重试（repl_main_thread、sdk、agent、compact 等），后台源直接失败
- Opus 连续 3 次 529 抛出 `FallbackTriggeredError`，触发模型降级
- 流式失败自动降级到非流式请求

**证据位置**：`src/services/api/withRetry.ts`、`src/services/api/claude.ts`

**为什么这样设计**：
- 前台查询用户在等待，值得重试；后台查询失败不影响用户体验，避免级联重试放大过载
- Opus 是高端模型，容量更容易受限，降级到 Sonnet 可保持可用性
- 流式比非流式更容易失败（连接中断、超时等），提供回退路径

**代价**：
- 降级可能导致模型能力下降（思考、工具等），用户需接受
- 重试期间用户体验为"等待"，需要进度提示（`SystemAPIErrorMessage`）

---

### 2.5 错误分类与用户友好消息

**当前设计**：
- `getAssistantMessageFromError()` 是中心转换函数
- 细分错误类型：认证错误（401/403）、限流（429）、过载（529）、提示过长（400）、媒体过大（400）、模型不存在（404）等
- 3P 提供商有专门的降级建议（Opus 4.6 → 4.1，Sonnet 4.6 → 4.5）
- 可恢复错误（prompt_too_long、max_output_tokens）由 query-core withhold，不立即显示

**证据位置**：`src/services/api/errors.ts`、`src/query.ts`

**为什么这样设计**：
- 原始 API 错误消息可能技术性过强，用户需要指导（如"请运行 /login"）
- 细分错误类型有助于触发正确的恢复路径（提示过长→压缩，媒体过大→移除，限流→等待）
- withhold 机制避免用户看到中间错误，只在恢复失败时显示

**备选方案**：
- 备选 1：直接显示原始错误。缺点是用户体验差，缺少指导
- 备选 2：所有错误立即显示。缺点是恢复过程中用户看到闪烁的错误消息

**代价**：
- 需要保持与 API 错误消息格式同步，API 变更可能导致匹配失败
- withhold 延迟了错误反馈，调试更困难

---

### 2.6 Live 验证与 Mock 的分离

**当前设计**：
- `validateModel()` 通过最小化 API 调用（`max_tokens: 1`）验证模型
- 验证结果缓存到 `validModelCache`，避免重复验证
- `scripts/live-model-validation.ts` 是独立脚本，实际调用 API 验证工作流
- 测试使用 VCR（`withVCR`/`withStreamingVCR`）或 mock，不依赖网络

**证据位置**：`src/utils/model/validateModel.ts`、`scripts/live-model-validation.ts`

**为什么这样设计**：
- Live 验证确保实际部署环境中的配置正确
- 测试需要快速、可重复，不依赖外部服务
- 分离关注点：模型选择逻辑测试与 API 连通性测试分开

**代价**：
- Live 验证需要真实凭据，不能在 CI 中自动运行
- VCR 磁带可能过期，需要定期更新

---

### 2.7 模型白名单匹配层级

**当前设计**：
1. 家族别名（`opus`）：整个系列通配，除非有更具体条目
2. 版本前缀（`opus-4-5` 或 `claude-opus-4-5`）：匹配该版本的任何构建
3. 完整模型 ID：精确匹配

**特殊逻辑**：当 allowlist 同时包含 `opus` 和 `opus-4-5` 时，家族通配符被忽略，仅匹配 4.5 版本

**证据位置**：`src/utils/model/modelAllowlist.ts`

**为什么这样设计**：
- 灵活支持不同粒度的限制（"仅允许 Opus" vs "仅允许 Opus 4.5"）
- 版本前缀匹配避免因日期后缀变化导致的配置失效

**代价**：
- 三层匹配逻辑复杂，容易产生意外结果（例如同时包含家族和具体版本时）
- 需要 `familyHasSpecificEntries()` 检测来处理特殊情况

## 3. 目标与非目标

### 3.1 目标

- **统一模型配置接口**：通过 `/model`、环境变量、设置一致地配置模型
- **多提供商透明适配**：同一别名在不同提供商解析为对应模型 ID
- **可靠的重试与降级**：在过载、限流等情况下自动恢复或降级
- **用户友好的错误**：将原始 API 错误转换为有指导意义的消息
- **灵活的白名单机制**：支持企业按家族、版本或精确 ID 限制模型
- **Live 验证能力**：能够验证模型配置在实际环境中的可用性

### 3.2 非目标

- **不处理对话恢复逻辑**：query-core 处理提示压缩、历史管理等对话恢复，model-api 只负责 API 层
- **不实现推理引擎**：调用外部 API，不自己运行模型
- **不管理访问控制策略**：只检查 `availableModels`，不定义策略
- **不保证跨提供商模型等价**：仅适配 ID，不保证不同提供商的同一模型行为完全一致
- **不处理计费集成**：只计算成本（`modelCost.ts`），不处理账单

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

**模型选择入口**：
```typescript
// 获取当前主模型
function getMainLoopModel(): ModelName

// 解析用户指定的模型（别名 → 完整 ID）
function parseUserSpecifiedModel(modelInput: ModelName | ModelAlias): ModelName

// 获取模型选项列表（用于 UI）
function getModelOptions(fastMode?: boolean): ModelOption[]

// 验证模型是否可用（通过实际 API 调用）
async function validateModel(model: string): Promise<{ valid: boolean; error?: string }>
```

**API 调用入口**：
```typescript
// 主查询函数（流式或非流式）
async function* queryModel(options: Options): AsyncGenerator<...>

// 重试装饰器
async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client: Anthropic, attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions
): AsyncGenerator<SystemAPIErrorMessage, T>
```

### 4.2 模块设计卡片

#### 4.2.1 `model.ts` — 模型选择与解析

**真实入口签名：**
```typescript
export type ModelName = string
export type ModelAlias = 'opus' | 'sonnet' | 'haiku' | 'best' | 'opusplan'
export type ModelSetting = ModelName | ModelAlias | null

export function getMainLoopModel(): ModelName
export function getUserSpecifiedModelSetting(): ModelSetting | undefined
export function parseUserSpecifiedModel(modelInput: ModelName | ModelAlias): ModelName
export function resolveSkillModelOverride(skillModel: string, currentModel: string): string
export function normalizeModelStringForAPI(model: string): string
export function getCanonicalName(fullModelName: ModelName): ModelShortName
export function renderModelName(model: ModelName): string
export function getDefaultOpusModel(): ModelName
export function getDefaultSonnetModel(): ModelName
export function getDefaultHaikuModel(): ModelName
export function isNonCustomOpusModel(model: ModelName): boolean
export function isLegacyModelRemapEnabled(): boolean
export function getSmallFastModel(): ModelName
```

**关键类型：**
```typescript
type ModelShortName = string
type ModelName = string
type ModelSetting = ModelName | ModelAlias | null
```

**输入输出：**
- 输入：用户配置（环境变量、设置、命令行参数、会话覆盖）
- 输出：解析后的完整模型ID（含[1m]后缀）
- 输入输出示例：
  - `parseUserSpecifiedModel('opus')` → `'claude-opus-4-6[1m]'`
  - `parseUserSpecifiedModel('sonnet[1m]')` → `'claude-sonnet-4-6[1m]'`
  - `normalizeModelStringForAPI('claude-opus-4-6[1m]')` → `'claude-opus-4-6'`

**状态与配置来源：**
- 无持久化状态（纯函数）
- 配置来源优先级：
  1. 会话覆盖：`getMainLoopModelOverride()`
  2. 环境变量：`ANTHROPIC_MODEL`
  3. 保存设置：`settings.model`
  4. 内置默认：订阅层级相关
- Allowlist检查：`isModelAllowed()`

**设计取舍/备选：**
- 选择：多层别名+后缀分离方案
- 理由：用户友好，跨提供商统一
- 代价：转换链复杂，需注意每一层的输入输出
- 备选：直接使用完整模型ID
- 备选缺点：用户体验差，不易记忆
- 选择理由：用户体验优先级高于实现复杂度

**源码测试证据：**
- `tests/antModelOverrides.test.ts`：验证模型覆盖、别名解析、[1m]处理
- 证据边界：不包含实际API调用，仅测试逻辑

**职责说明：**
- ✅ 模型别名解析
- ✅ [1m]后缀处理
- ✅ 订阅层级默认模型选择
- ✅ 旧版模型重定向
- ❌ 模型可用性验证
- ❌ API调用
- ❌ 对话恢复

---

#### 4.2.2 `providers.ts` — API提供商确定

**真实入口签名：**
```typescript
export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

export function getAPIProvider(): APIProvider
export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
export function isFirstPartyAnthropicBaseUrl(): boolean
```

**关键类型：**
```typescript
type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
```

**输入输出：**
- 输入：环境变量
- 输出：提供商类型
- 输入输出示例：
  - `CLAUDE_CODE_USE_BEDROCK=1` → `'bedrock'`
  - `CLAUDE_CODE_USE_VERTEX=1` → `'vertex'`
  - `CLAUDE_CODE_USE_FOUNDRY=1` → `'foundry'`
  - 无环境变量 → `'firstParty'`

**状态与配置来源：**
- 无持久化状态
- 纯环境变量驱动（优先级互斥）：
  - `CLAUDE_CODE_USE_BEDROCK`
  - `CLAUDE_CODE_USE_VERTEX`
  - `CLAUDE_CODE_USE_FOUNDRY`
- `ANTHROPIC_BASE_URL`用于`isFirstPartyAnthropicBaseUrl()`

**设计取舍/备选：**
- 选择：互斥环境变量开关
- 理由：简单明确，用户一次只使用一个提供商
- 代价：不能同时测试多个提供商
- 备选：配置文件或SDK参数
- 备选缺点：增加复杂度
- 选择理由：用户通常只使用一个提供商，简单更好

**源码测试证据：**
- 无独立测试，集成在其他测试中

**职责说明：**
- ✅ 确定当前API提供商
- ✅ 检查是否为第一方API端点
- ❌ 认证凭证管理
- ❌ 提供商特定客户端创建
- ❌ API调用

---

#### 4.2.3 `configs.ts` — 模型配置映射

**真实入口签名：**
```typescript
export type ModelConfig = Record<APIProvider, ModelName>
export type ModelKey = keyof typeof ALL_MODEL_CONFIGS
export type CanonicalModelId = (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

export const ALL_MODEL_CONFIGS: Record<string, ModelConfig>
export const CANONICAL_MODEL_IDS: [CanonicalModelId, ...CanonicalModelId[]]
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey>
```

**关键类型：**
```typescript
type ModelConfig = {
  firstParty: ModelName
  bedrock: ModelName
  vertex: ModelName
  foundry: ModelName
}
```

**输入输出：**
- 输入：配置键（如`'opus46'`、`'sonnet45'`）
- 输出：各提供商对应的完整模型ID
- 输入输出示例：
  - `ALL_MODEL_CONFIGS.opus46.firstParty` → `'claude-opus-4-6'`
  - `ALL_MODEL_CONFIGS.opus46.bedrock` → `'us.anthropic.claude-opus-4-6-v1'`
  - `ALL_MODEL_CONFIGS.sonnet45.vertex` → `'claude-sonnet-4-5@20250929'`

**状态与配置来源：**
- 编译时常量表（无运行时状态）
- 维护约定：新模型发布时更新，标记`@[MODEL LAUNCH]`

**设计取舍/备选：**
- 选择：集中式常量配置表
- 理由：单一事实来源，易于更新和验证
- 代价：发布新模型时需多处更新
- 备选：分散在各模块
- 备选缺点：容易遗漏，难以追踪
- 选择理由：可维护性优先级高于便利性（通过标记辅助）

**源码测试证据：**
- 无独立测试（配置表本身是规范）
- 测试边界：仅验证配置结构，不验证实际模型可用性

**职责说明：**
- ✅ 第一方ID与各提供商ID映射
- ✅ 规范模型键定义
- ❌ 运行时配置加载
- ❌ 模型可用性验证
- ❌ 模型选择逻辑

---

#### 4.2.4 `validateModel.ts` — 模型可用性验证

**真实入口签名：**
```typescript
export async function validateModel(model: string): Promise<{
  valid: boolean
  error?: string
}>
```

**关键类型：**
```typescript
type ValidationResult = {
  valid: boolean
  error?: string
}
```

**输入输出：**
- 输入：模型名称/别名
- 输出：验证结果（有效/无效 + 错误消息）
- 输入输出示例：
  - `validateModel('opus')` → `{ valid: true }`
  - `validateModel('invalid-model')` → `{ valid: false, error: "Model 'invalid-model' not found" }`

**状态与配置来源：**
- 缓存：`validModelCache: Map<string, boolean>`（内存缓存，避免重复API调用）
- 验证流程：
  1. 检查allowlist：`isModelAllowed()`
  2. 检查已知别名：`MODEL_ALIASES`
  3. 检查自定义模型：`ANTHROPIC_CUSTOM_MODEL_OPTION`
  4. 检查缓存
  5. 实际API调用：`sideQuery()`（max_tokens=1）

**Live与Mock的验证差异：**
- Live：真实API调用，`scripts/live-model-validation.ts`独立脚本
- Mock：测试使用VCR（`withVCR`/`withStreamingVCR`），不依赖网络

**设计取舍/备选：**
- 选择：最小API调用验证（max_tokens=1）
- 理由：快速验证，成本低
- 代价：不能验证模型所有能力（但足以验证存在性和权限）
- 备选：完整测试调用
- 备选缺点：慢，成本高
- 选择理由：验证存在性即可，完整能力在实际使用中验证

**源码测试证据：**
- 无独立测试，集成在模型选择器中
- 证据边界：不包含实际API调用（测试使用Mock）

**职责说明：**
- ✅ 验证模型存在性和权限
- ✅ 3P提供商降级建议
- ❌ 模型能力验证
- ❌ 对话恢复

---

#### 4.2.5 `bedrock.ts` — Bedrock特定适配

**真实入口签名：**
```typescript
export const getBedrockInferenceProfiles: memoize(async function (): Promise<string[]>)
export function findFirstMatch(profiles: string[], substring: string): string | null
export async function getInferenceProfileBackingModel(profileId: string): Promise<string | null>
export function isFoundationModel(modelId: string): boolean
export function extractModelIdFromArn(modelId: string): string
export type BedrockRegionPrefix = 'us' | 'eu' | 'apac' | 'global'
export function getBedrockRegionPrefix(modelId: string): BedrockRegionPrefix | undefined
export function applyBedrockRegionPrefix(modelId: string, prefix: BedrockRegionPrefix): string
export async function createBedrockClient(): Promise<BedrockClient>
export async function createBedrockRuntimeClient(): Promise<BedrockRuntimeClient>
```

**关键类型：**
```typescript
type BedrockRegionPrefix = 'us' | 'eu' | 'apac' | 'global'
```

**输入输出：**
- 输入：模型ID、区域前缀、ARN
- 输出：处理后的模型ID、推理配置文件列表、Backing model
- 输入输出示例：
  - `applyBedrockRegionPrefix('anthropic.claude-sonnet-4-5-v1:0', 'eu')` → `'eu.anthropic.claude-sonnet-4-5-v1:0'`
  - `getBedrockRegionPrefix('us.anthropic.claude-opus-4-6-v1')` → `'us'`
  - `extractModelIdFromArn('arn:aws:bedrock:us-east-1:123:inference-profile/global.anthropic.claude-opus-4-6-v1')` → `'global.anthropic.claude-opus-4-6-v1'`

**状态与配置来源：**
- 缓存：`getBedrockInferenceProfiles()`使用`lodash-es/memoize`
- 环境变量：
  - `AWS_REGION`/`AWS_DEFAULT_REGION`
  - `ANTHROPIC_BEDROCK_BASE_URL`
  - `AWS_BEARER_TOKEN_BEDROCK`
  - `CLAUDE_CODE_SKIP_BEDROCK_AUTH`
- 认证：`refreshAndGetAwsCredentials()`（来自`auth.ts`）

**设计取舍/备选：**
- 选择：跨区域推理前缀方案
- 理由：灵活支持Bedrock多区域部署
- 代价：模型ID格式复杂，需特殊处理
- 备选：每种组合单独配置
- 备选缺点：配置爆炸，难以维护
- 选择理由：动态前缀方案更灵活

**源码测试证据：**
- 无独立测试，集成在Bedrock客户端中
- 证据边界：不包含实际AWS API调用

**职责说明：**
- ✅ Bedrock客户端创建
- ✅ 推理配置文件查询
- ✅ 区域前缀处理
- ✅ ARN解析
- ✅ Backing model查找
- ❌ Vertex/Foundry适配
- ❌ 通用API客户端创建

---

#### 4.2.6 `client.ts` — Anthropic客户端创建

**真实入口签名：**
```typescript
export async function getAnthropicClient(options: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic>

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'
```

**关键类型：**
```typescript
type ClientOptions = Anthropic.ClientOptions | Bedrock.BedrockClientOptions | Vertex.VertexClientOptions | Foundry.FoundryClientOptions
```

**输入输出：**
- 输入：API密钥、最大重试次数、模型、fetch覆盖、来源标识
- 输出：对应提供商的Anthropic SDK客户端
- 输入输出示例：
  - `getAnthropicClient({ maxRetries: 10, model: 'claude-opus-4-6' })` → `Anthropic`实例（first-party）
  - `CLAUDE_CODE_USE_BEDROCK=1` → `AnthropicBedrock`实例（类型伪装）

**状态与配置来源：**
- 无持久化状态
- 提供商配置不可变：启动后不能切换
- 运行时覆盖：认证错误时重建客户端
- 环境变量驱动（优先级互斥）：
  - `CLAUDE_CODE_USE_BEDROCK`
  - `CLAUDE_CODE_USE_VERTEX`
  - `CLAUDE_CODE_USE_FOUNDRY`
- 其他配置：
  - `ANTHROPIC_API_KEY`
  - `ANTHROPIC_BASE_URL`
  - `CLAUDE_CODE_CONTAINER_ID`
  - `CLAUDE_CODE_REMOTE_SESSION_ID`
  - `CLAUDE_AGENT_SDK_CLIENT_APP`
  - `ANTHROPIC_CUSTOM_HEADERS`
  - `CLAUDE_CODE_ADDITIONAL_PROTECTION`
- 认证来源：
  - `getAnthropicApiKey()`（API key）
  - `getClaudeAIOAuthTokens()`（OAuth token）
  - `refreshAndGetAwsCredentials()`（Bedrock）
  - `refreshGcpCredentialsIfNeeded()`（Vertex）

**设计取舍/备选：**
- 选择：类型伪装统一接口（Bedrock/Vertex/Foundry SDK都伪装成Anthropic）
- 理由：调用层无需感知提供商差异
- 代价：类型系统不安全，需小心维护
- 备选：各提供商独立接口
- 备选缺点：调用层复杂，条件分支多
- 选择理由：调用层简洁性优先级高于类型安全（通过测试保证）

**源码测试证据：**
- 无独立测试，集成在API调用中
- 证据边界：不包含实际网络请求

**职责说明：**
- ✅ 四提供商客户端创建（first-party/Bedrock/Vertex/Foundry）
- ✅ 认证配置
- ✅ 代理配置
- ✅ 自定义Header注入
- ✅ Client Request ID生成（用于超时关联）
- ❌ API请求构造
- ❌ 响应处理

---

#### 4.2.7 `claude.ts` — API请求构造与模型调用

**真实入口签名（简化）：**
```typescript
export async function* queryModel(options: Options): AsyncGenerator<...>
export async function* queryModelWithStreaming(options: Options): AsyncGenerator<...>
export async function queryModelWithoutStreaming(options: Options): Promise<AssistantMessage>
export async function* executeNonStreamingRequest(...): AsyncGenerator<SystemAPIErrorMessage, BetaMessage>
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject
export function getPromptCachingEnabled(model: string): boolean
export function getCacheControl(options: { scope?: CacheScope; querySource?: QuerySource }): {...}
export function userMessageToMessageParam(...): MessageParam
export function assistantMessageToMessageParam(...): MessageParam
export async function verifyApiKey(apiKey: string, isNonInteractiveSession: boolean): Promise<boolean>
export function getAPIMetadata(): { user_id: string }

export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto | undefined
  isNonInteractiveSession: boolean
  extraToolSchemas?: BetaToolUnion[]
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId
  outputFormat?: BetaJSONOutputFormat
  fastMode?: boolean
  advisorModel?: string
  addNotification?: (notif: Notification) => void
  taskBudget?: { total: number; remaining?: number }
}
```

**关键类型：**
```typescript
type QuerySource =
  | 'repl_main_thread'
  | 'repl_main_thread:outputStyle:custom'
  | 'repl_main_thread:outputStyle:Explanatory'
  | 'repl_main_thread:outputStyle:Learning'
  | 'sdk'
  | 'agent:custom'
  | 'agent:default'
  | 'agent:builtin'
  | 'compact'
  | 'hook_agent'
  | 'hook_prompt'
  | 'verification_agent'
  | 'side_question'
  | 'auto_mode'
  | 'model_validation'
  | 'bash_classifier'
```

**输入输出：**
- 输入：完整查询选项（消息、工具、配置等）
- 输出：流式/非流式响应
- **Usage/Stream Event边界：**
  - Usage仅在最终事件中提供完整统计
  - Stream Event逐个产生，`content_block_delta`累积
  - `content_block_stop`标记块完成
  - `message_delta`提供最终usage和stop_reason

**状态与配置来源：**
- 闭包状态：流式过程中累积`contentBlocks`
- 无持久化状态
- Beta Headers：动态根据功能和模型注入
- Prompt Caching：`getPromptCachingEnabled()` + `cache_control`配置
- Fast Mode：`getFastModeHeaderLatched()`（粘性开关）
- Thinking：`modelSupportsThinking()` + `modelSupportsAdaptiveThinking()`
- 缓存编辑：`consumePendingCacheEdits()` + `getPinnedCacheEdits()`

**请求/流式响应生命周期：**
```
1. 参数准备（paramsFromContext）
   ├─ Beta headers组装
   ├─ Output config（effort、taskBudget、outputFormat）
   ├─ Thinking配置
   ├─ Prompt Caching控制
   └─ Cache edits注入
2. 客户端获取（通过withRetry）
3. 流式请求发起
   ├─ message_start → 初始化partialMessage、usage
   ├─ content_block_start → 初始化contentBlock
   ├─ content_block_delta → 累积text/input/signature
   ├─ content_block_stop → 完成块，yield assistantMessage
   ├─ message_delta → 更新usage、stop_reason
   └─ message_stop → 结束
4. 失败处理
   ├─ 流中断 → 降级到非流式重试
   ├─ 看门狗超时（STREAM_IDLE_TIMEOUT_MS）→ 中断+重试
   └─ 其他错误 → 传递给withRetry
```

**设计取舍/备选：**
- 选择：流式优先 + 非流式降级
- 理由：流式用户体验好，非流式更可靠
- 代价：双路径维护，行为可能不一致
- 备选：仅非流式
- 备选缺点：用户体验差
- 选择理由：用户体验优先级高于维护成本

**源码测试证据：**
- 无独立单元测试，集成在完整流程中
- **query-core的恢复逻辑只作调用方，不复制：** query-core处理压缩、历史管理等对话恢复，model-api只负责API层

**职责说明：**
- ✅ API请求参数构造
- ✅ 流式响应处理
- ✅ 非流式降级
- ✅ Prompt Caching配置
- ✅ Beta Headers管理
- ✅ Thinking配置
- ✅ Fast Mode控制
- ❌ 对话历史管理
- ❌ 对话恢复（query-core负责）
- ❌ 工具执行

---

#### 4.2.8 `withRetry.ts` — 重试与降级逻辑

**真实入口签名：**
```typescript
export const DEFAULT_MAX_RETRIES = 10
export const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

export interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  constructor(public readonly originalError: unknown, public readonly retryContext: RetryContext)
}

export class FallbackTriggeredError extends Error {
  constructor(public readonly originalModel: string, public readonly fallbackModel: string)
}

export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client: Anthropic, attempt: number, context: RetryContext) => Promise<T>,
  options: RetryOptions
): AsyncGenerator<SystemAPIErrorMessage, T>

export function getRetryDelay(attempt: number, retryAfterHeader?: string | null, maxDelayMs?: number): number
export function parseMaxTokensContextOverflowError(error: APIError): { inputTokens: number; maxTokens: number; contextLimit: number } | undefined
export function is529Error(error: unknown): boolean
export function getDefaultMaxRetries(): number
```

**关键类型：**
```typescript
interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  initialConsecutive529Errors?: number
}

class CannotRetryError extends Error {
  originalError: unknown
  retryContext: RetryContext
}

class FallbackTriggeredError extends Error {
  originalModel: string
  fallbackModel: string
}
```

**输入输出：**
- 输入：客户端工厂、操作函数、重试选项
- 输出：成功结果或错误，中间yield SystemAPIErrorMessage
- 输入输出示例：
  - 529前台源 → 重试（最多10次），Opus连续3次 → FallbackTriggeredError
  - 529后台源 → 直接失败（CannotRetryError）
  - 401 → 清除缓存+刷新凭证+重试
  - 429 → 非订阅/企业版重试，订阅用户不重试
  - 连接错误（ECONNRESET/EPIPE）→ 禁用keep-alive+重试
  - Max tokens溢出 → 调整maxTokensOverride+重试

**状态与配置来源：**
- 闭包状态：
  - `retryContext`（可变，每次尝试可调整）
  - `consecutive529Errors`（计数Opus连续529）
- **529重试白名单：**
  ```typescript
  const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
    'repl_main_thread',
    'repl_main_thread:outputStyle:custom',
    'repl_main_thread:outputStyle:Explanatory',
    'repl_main_thread:outputStyle:Learning',
    'sdk',
    'agent:custom',
    'agent:default',
    'agent:builtin',
    'compact',
    'hook_agent',
    'hook_prompt',
    'verification_agent',
    'side_question',
    'auto_mode',
    'bash_classifier',
  ])
  ```
- 环境变量配置：
  - `CLAUDE_CODE_MAX_RETRIES`（覆盖DEFAULT_MAX_RETRIES）
  - `CLAUDE_CODE_UNATTENDED_RETRY`（持久重试模式，无限+心跳）
  - `FALLBACK_FOR_ALL_PRIMARY_MODELS`（扩展降级触发范围）

**请求/流式响应生命周期：**
```
1. 初始化
   ├─ 确定maxRetries
   ├─ 初始化retryContext
   ├─ 初始化consecutive529Errors（来自initialConsecutive529Errors）
   └─ 客户端为null（首次获取）
2. 尝试循环
   ├─ 检查signal.aborted
   ├─ 检查mock限流
   ├─ 获取客户端（首次或认证错误后重建）
   ├─ 执行operation
   ├─ 成功 → 返回
   └─ 失败 → 错误处理分支
3. 错误处理
   ├─ Fast Mode处理
   │  ├─ 429/529且retry-after短 → 重试（保持fast mode）
   │  ├─ 429/529且retry-after长 → 进入cooldown（禁用fast mode）
   │  └─ fast mode不支持 → 禁用+重试
   ├─ 529处理
   │  ├─ 后台源 → 直接失败
   │  ├─ 前台源 → 计数consecutive529Errors
   │  ├─ Opus且≥3次且有fallbackModel → FallbackTriggeredError
   │  └─ 否则 → 继续重试
   ├─ 检查是否可重试
   │  ├─ Persistent模式：429/529始终重试
   │  ├─ x-should-retry: true → 非订阅/企业版重试
   │  ├─ x-should-retry: false → 仅ANT且5xx重试
   │  ├─ 401 → 清除缓存+重试
   │  ├─ 403 OAuth revoked → 刷新+重试
   │  ├─ 连接错误 → 重试
   │  ├─ 408/409 → 重试
   │  ├─ 5xx → 重试
   │  └─ 其他 → 不可重试 → CannotRetryError
   ├─ Max tokens溢出调整
   │  ├─ 解析error获取inputTokens/contextLimit
   │  ├─ 计算adjustedMaxTokens（预留safety buffer + thinking budget）
   │  ├─ 设置retryContext.maxTokensOverride
   │  └─ 继续重试
   ├─ 指数退避等待
   │  ├─ 读取Retry-After header（优先）
   │  ├─ 否则：BASE_DELAY_MS × 2^(attempt-1)，上限maxDelayMs
   │  ├─ 加随机抖动
   │  └─ Persistent模式：429可等待到reset time，上限6小时
   ├─ Persistent模式心跳
   │  ├─ 延迟>60s时，每30s yield SystemAPIErrorMessage
   │  └─ 保持会话活跃，避免被宿主环境关闭
   └─ 超过maxRetries → CannotRetryError
```

**重试/Fallback与错误映射：**

| 错误类型 | 触发条件 | 重试策略 | Fallback | 调用方可见结果 |
|---------|---------|---------|---------|--------------|
| 529/overloaded_error | 前台源 | 最多10次，指数退避 | Opus连续3次触发 | SystemAPIErrorMessage；FallbackTriggeredError |
| 529/overloaded_error | 后台源 | 不重试 | - | CannotRetryError |
| 429 | 非订阅/企业版 | 最多10次，指数退避 | - | SystemAPIErrorMessage |
| 429 | 订阅用户（非企业） | 不重试 | - | 直接错误 |
| 401 | 认证失败 | 清除缓存+刷新凭证+重试 | - | 重试后仍失败 → 认证错误 |
| 403 | OAuth revoked | 刷新token+重试 | - | 重试后仍失败 → 认证错误 |
| 400 | prompt too long | 不重试 | - | 由query-core withhold并处理恢复 |
| 400 | max tokens溢出 | 调整maxTokensOverride+重试 | - | 调整后重试 |
| 连接错误 | ECONNRESET/EPIPE | 禁用keep-alive+重试 | - | 重试 |
| 408/409 | 超时/锁冲突 | 重试 | - | 重试 |
| 5xx | 服务器错误 | 重试 | - | 重试 |
| 流式失败 | 任意流式错误 | 降级到非流式重试 | - | 非流式响应 |

**设计取舍/备选：**
- 选择：529前台/后台二分决策
- 理由：用户等待的请求值得重试，后台任务失败不影响体验，避免过载放大
- 代价：需维护来源白名单
- 备选：统一策略（都重试或都不重试）
- 备选缺点：要么用户体验差，要么过载放大
- 选择理由：平衡用户体验与系统稳定性
- 选择：Opus 3次529降级硬编码阈值
- 理由：Opus容量更受限，快速降级保持可用性
- 代价：可能过于敏感或不够敏感
- 备选：动态阈值或配置
- 备选缺点：增加复杂度
- 选择理由：简单有效，当前经验3次合适

**源码测试证据：**
- 无独立测试，集成在API调用中
- 证据边界：降级后的对话适配在query-core（tombstone、重建StreamingToolExecutor等）

**职责说明：**
- ✅ 重试策略执行
- ✅ 529前台/后台区分
- ✅ Opus降级触发
- ✅ Fast Mode cooldown
- ✅ Max tokens溢出调整
- ✅ Persistent模式心跳
- ❌ 降级后的对话适配
- ❌ 模型切换逻辑
- ❌ 错误用户友好化（errors.ts负责）

---

#### 4.2.9 `errors.ts` — 错误分类与用户友好消息

**真实入口签名：**
```typescript
export const API_ERROR_MESSAGE_PREFIX = 'API Error'
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = 'Credit balance is too low'
export const INVALID_API_KEY_ERROR_MESSAGE = 'Not logged in · Please run /login'
export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL = 'Invalid API key · Fix external API key'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH = 'Your ANTHROPIC_API_KEY belongs to a disabled organization · Unset the environment variable to use your subscription instead'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY = 'Your ANTHROPIC_API_KEY belongs to a disabled organization · Update or unset the environment variable'
export const TOKEN_REVOKED_ERROR_MESSAGE = 'OAuth token revoked · Please run /login'
export const CUSTOM_OFF_SWITCH_MESSAGE = 'Opus is experiencing high load, please use /model to switch to Sonnet'
export const API_TIMEOUT_ERROR_MESSAGE = 'Request timed out'

export function startsWithApiErrorPrefix(text: string): boolean
export function isPromptTooLongMessage(msg: AssistantMessage): boolean
export function parsePromptTooLongTokenCounts(rawMessage: string): { actualTokens: number | undefined; limitTokens: number | undefined }
export function getPromptTooLongTokenGap(msg: AssistantMessage): number | undefined
export function isMediaSizeError(raw: string): boolean
export function isMediaSizeErrorMessage(msg: AssistantMessage): boolean
export function getPdfTooLargeErrorMessage(): string
export function getPdfPasswordProtectedErrorMessage(): string
export function getPdfInvalidErrorMessage(): string
export function getImageTooLargeErrorMessage(): string
export function getRequestTooLargeErrorMessage(): string
export function getTokenRevokedErrorMessage(): string
export function getOauthOrgNotAllowedErrorMessage(): string

export function getAssistantMessageFromError(
  error: unknown,
  model: string,
  options?: {
    messages?: Message[]
    messagesForAPI?: (UserMessage | AssistantMessage)[]
  }
): AssistantMessage

export function classifyAPIError(error: unknown): string
export function categorizeRetryableAPIError(error: APIError): SDKAssistantMessageError
export function getErrorMessageIfRefusal(stopReason: BetaStopReason | null, model: string): AssistantMessage | undefined
export function isValidAPIMessage(value: unknown): value is BetaMessage
export function extractUnknownErrorFormat(value: unknown): string | undefined
```

**关键类型：**
```typescript
type AssistantMessage = {
  type: 'assistant'
  message: BetaMessage
  isApiErrorMessage?: boolean
  errorDetails?: string
  requestId?: string
}
```

**输入输出：**
- 输入：原始错误（SDK Error、APIError、任意unknown）
- 输出：用户友好AssistantMessage
- 输入输出示例：
  - 401认证失败 → `{ content: "Not logged in · Please run /login · API Error: ...", error: "authentication_failed" }`
  - 404模型不存在 → `{ content: "The model claude-invalid is not available...", error: "invalid_request" }`
  - 429限流 → `{ content: "Rate limit reached...", error: "rate_limit" }`
  - 529过载 → `{ content: "Opus is experiencing high load...", error: "rate_limit" }`
  - prompt too long → `{ content: "Prompt is too long", error: "invalid_request", errorDetails: "..." }`

**Live与Mock的验证差异：**
- Live：真实API错误格式，需与API保持同步
- Mock：VCR磁带可能过期，需定期更新
- 错误匹配脆弱：依赖字符串匹配，API消息变更可能导致匹配失败

**模型Alias/Family匹配：**
- 3P降级建议：`get3PFallbackSuggestion()`
  - Opus 4.6 → Opus 4.1
  - Sonnet 4.6 → Sonnet 4.5
  - Sonnet 4.5 → Sonnet 4.0
- 匹配：大小写不敏感，支持`-`和`_`分隔符

**设计取舍/备选：**
- 选择：集中式`getAssistantMessageFromError()`转换
- 理由：单一错误处理点，用户消息一致
- 代价：函数庞大，分支多
- 备选：分散式错误处理
- 备选缺点：消息不一致，容易遗漏
- 选择理由：用户体验一致性优先级高于代码组织
- 选择：字符串匹配错误分类
- 理由：SDK不总是传递正确的status code（特别是流式529）
- 代价：脆弱，API消息变更可能破坏
- 备选：仅依赖status code
- 备选缺点：流式场景不可靠
- 选择理由：可靠性优先级高于脆弱性（通过测试监控）

**源码测试证据：**
- 无独立测试，集成在API调用流程中
- 证据边界：可恢复错误由query-core withhold，不立即显示

**职责说明：**
- ✅ 错误分类
- ✅ 用户友好消息生成
- ✅ 3P降级建议
- ✅ prompt too long token解析
- ✅ media size错误检测
- ❌ 错误恢复
- ❌ 重试逻辑

---

### 4.3 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 |
|------|-----------|---------|------------|
| `model.ts` | 无（纯函数） | 解析别名、选择默认模型、渲染显示名、后缀处理 | 验证模型可用性 |
| `modelOptions.ts` | 无（纯函数） | 生成模型选项列表、升级提示 | UI 渲染 |
| `providers.ts` | 无（环境变量驱动） | 确定当前提供商、检查第一方端点 | 认证管理 |
| `bedrock.ts` | `getBedrockInferenceProfiles()` 缓存 | Bedrock 客户端创建、推理配置文件查询、区域前缀处理、ARN解析 | Vertex/Foundry 适配 |
| `validateModel.ts` | `validModelCache` | 模型可用性验证、3P降级建议 | 对话恢复 |
| `client.ts` | 无 | 创建 Anthropic 客户端（支持四提供商）、认证配置、代理配置 | 请求构造 |
| `claude.ts` | 无（纯函数 + 闭包） | 构造 API 请求、处理流式响应、非流式降级、Beta管理 | 对话历史管理、对话恢复 |
| `withRetry.ts` | `retryContext`（闭包）、`consecutive529Errors` | 重试逻辑、降级触发、Fast Mode cooldown、Persistent模式心跳 | 降级后的对话适配、模型切换 |
| `errors.ts` | 无 | 错误分类与用户友好消息生成、token解析、media检测 | 错误恢复、重试逻辑 |
| `api.ts` | 无 | 工具 schema 转换、系统提示分块 | 模型调用 |

### 4.3 主控制流

#### 模型选择流
```
用户输入（/model、--model、ANTHROPIC_MODEL、settings）
  ↓
getUserSpecifiedModelSetting()
  ├─ 检查会话覆盖
  ├─ 检查环境变量
  ├─ 检查设置
  └─ 检查 allowlist
  ↓
parseUserSpecifiedModel()
  ├─ 识别别名（opus、sonnet 等）
  ├─ 识别 [1m] 后缀
  ├─ 应用提供商特定的默认模型
  └─ 旧版重定向（Opus 4.0/4.1 → 当前 Opus）
  ↓
最终模型 ID
```

#### API 调用流
```
queryModel()
  ↓
withRetry() 装饰器
  ├─ 检查 mock 限流
  ├─ 获取客户端（首次或认证错误后）
  ├─ 选择流式/非流式
  ├─ 调用 API
  │   ├─ 成功 → 返回结果
  │   ├─ 流式失败 → 降级到非流式重试
  │   ├─ 529 → 前台源重试，连续 3 次 Opus → FallbackTriggeredError
  │   ├─ 429 → 非订阅用户重试，订阅用户仅企业版重试
  │   ├─ 401 → 清除缓存，刷新凭证，重试
  │   └─ 其他可重试错误 → 指数退避重试
  └─ 超过最大重试 → CannotRetryError
  ↓
getAssistantMessageFromError()（如果错误）
  ├─ 分类错误类型
  ├─ 生成用户友好消息
  └─ 3P 提供商提供降级建议
```

### 4.4 数据结构与持久化

**关键类型**：
```typescript
// 模型选项（用于 UI）
type ModelOption = {
  value: ModelSetting // null 表示默认
  label: string
  description: string
  descriptionForModel?: string
}

// 模型配置（各提供商的 ID 映射）
type ModelConfig = Record<APIProvider, ModelName>

// 重试上下文
type RetryContext = {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

// 提供商类型
type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
```

### 4.5 跨子系统依赖

| 上游依赖 | 用途 |
|---------|------|
| `auth.ts` | 认证凭证 |
| `context.ts` | 上下文窗口检查 |
| `effort.ts` | Effort 级别 |
| `thinking.ts` | Thinking 配置 |
| `betas.ts` | Beta 头部 |
| `modelCost.ts` | 成本计算 |

## 5. 失败语义与工程取舍

### 5.1 失败表

| 触发条件 | 检测位置 | 消息/异常传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|--------------|--------------|-------------|-------------|
| 模型不存在 | `validateModel()`、API 404 | `Model 'x' not found` + 3P 降级建议 | 否 | 无 | 错误消息，可选降级建议 |
| 认证失败 | API 401/403 | `Not logged in · Please run /login` | 是（清除缓存+刷新凭证后重试） | 清除 `apiKeyHelperCache`、AWS/GCP 凭证缓存 | 用户友好错误消息 |
| OAuth token 撤销 | API 403 | `OAuth token revoked · Please run /login` | 是（刷新 token 后重试） | 清除 OAuth token 缓存 | 用户友好错误消息 |
| 限流 (429) | API 429 | 配额重置时间 + 升级提示 | 是（非订阅用户/企业版，最多 10 次） | 无（退避等待） | `SystemAPIErrorMessage` 进度提示 |
| 过载 (529) | API 529 / `overloaded_error` | `CUSTOM_OFF_SWITCH_MESSAGE` | 前台源重试最多 10 次，Opus 连续 3 次触发降级 | 无（退避等待） | `SystemAPIErrorMessage` 进度提示；降级时 `FallbackTriggeredError` |
| 提示过长 | API 400 | `Prompt is too long` + 解析 token 计数 | 否（由 query-core withhold 并处理恢复） | 无 | 错误消息 + `actualTokens`/`limitTokens` |
| 媒体过大 | API 400 | PDF/Image 尺寸限制消息 | 否（由 query-core withhold 并处理恢复） | 无 | 用户友好错误消息 |
| 流式中断 | 流式连接中断 | 内部捕获 | 是（降级到非流式重试） | 无（切换请求模式） | 非流式响应 |

### 5.2 降级语义

**触发条件**：
- Opus 连续 3 次 529 错误
- `fallbackModel` 参数已提供
- 非订阅用户 + 非自定义 Opus 模型，或 `FALLBACK_FOR_ALL_PRIMARY_MODELS` 启用

**行为**：
- 抛出 `FallbackTriggeredError(originalModel, fallbackModel)`
- query-core 捕获后：
  - tombstone 已输出的部分 assistant 消息
  - 丢弃已开始执行的工具
  - 重建 StreamingToolExecutor
  - 去除 thinking signature blocks
  - 记录 analytics event
  - yield 系统消息通知用户

### 5.3 工程取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|------|------|
| 模型 ID 多层转换 | 别名 → 完整 ID → API 归一化 → 规范名 | 理解和调试复杂 | 用户友好，跨提供商统一 |
| 529 前台重试/后台丢弃 | 二分决策 | 需要维护来源列表 | 用户体验好，避免级联放大 |
| Opus 3 次 529 降级 | 硬编码阈值 | 可能过于敏感或不够敏感 | 快速恢复可用性 |
| 流式失败降级到非流式 | 自动回退 | 响应可能变慢 | 更高的成功率 |
| Live 验证独立脚本 | 不集成到测试 | CI 无法自动运行 | 避免测试依赖网络 |

## 6. 现状验收标准

### 6.1 模型选择与配置

1. **给定**：用户设置 `ANTHROPIC_MODEL=opus`，**当**调用 `getMainLoopModel()`，**必须**返回默认 Opus 模型 ID（带 `[1m]` 如果启用）
2. **给定**：用户输入 `sonnet[1m]`，**当**调用 `parseUserSpecifiedModel()`，**必须**返回带 `[1m]` 后缀的 Sonnet 模型 ID
3. **给定**：技能指定 `model: 'opus'` 且父模型为 `opus[1m]`，**当**调用 `resolveSkillModelOverride()`，**必须**返回 `opus[1m]`
4. **给定**：旧版 Opus 4.0/4.1 ID，**当** first-party 提供商，**必须**重定向到当前 Opus 版本（除非 `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP` 禁用）
5. **给定**：第三方提供商，**当**获取默认模型，**必须**使用稍旧的默认版本（Sonnet 4.5，而非 4.6）

### 6.2 API 调用与重试

1. **给定**：查询来源为 `repl_main_thread` 且返回 529，**必须**重试最多 10 次
2. **给定**：查询来源为后台分类器且返回 529，**必须**直接失败，不重试
3. **给定**：Opus 连续 3 次 529 且 `fallbackModel` 已提供，**必须**抛出 `FallbackTriggeredError`
4. **给定**：流式请求失败，**必须**降级到非流式重试
5. **给定**：401 错误，**必须**清除认证缓存，刷新凭证，然后重试

## 7. 代码与测试证据

### 7.1 核心模块

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| 模型选择优先级：会话覆盖 > 环境变量 > 设置 > 默认 | `src/utils/model/model.ts` `getUserSpecifiedModelSetting()` | `tests/antModelOverrides.test.ts` 验证设置优先级 | 不包含 SDK 覆盖（由 sdkQuery.ts 处理） |
| 别名解析支持 `[1m]` 后缀 | `src/utils/model/model.ts` `parseUserSpecifiedModel()` | `tests/antModelOverrides.test.ts` 验证 `[1m]` 处理 | 不包含实际上下文窗口验证 |
| 多提供商配置映射 | `src/utils/model/configs.ts` `ALL_MODEL_CONFIGS` | 无（配置表本身是规范） | 仅包含已发布的模型配置 |
| 重试策略区分前台/后台来源 | `src/services/api/withRetry.ts` `FOREGROUND_529_RETRY_SOURCES` | 无 | 不包含实际过载测试 |
| Opus 3 次 529 降级触发 | `src/services/api/withRetry.ts` `FallbackTriggeredError` | 无 | 降级后的对话适配在 query-core |

### 7.2 现有测试场景证明

| 测试文件 | 测试场景 | 证明的不变量 |
|---------|---------|------------|
| `tests/antModelOverrides.test.ts` | 公开模型目录覆盖 | `modelCatalog` 配置正确应用；`getDefaultMainLoopModelSetting()` 返回配置的默认值；`parseUserSpecifiedModel()` 正确解析；`renderModelName()` 不泄露私有代号；effort/context/max_tokens 覆盖正确应用 |
| `tests/sdkControls.test.ts` | SDK 模型控制 | `applySdkFlagSettings()` 正确更新模型；`getSettings()` 返回应用的模型；model metadata change 通知正确触发 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/model-api.yaml)

### 8.1 本 spec 主拥有的文件

| 文件 | 职责 | 模块设计卡 |
|------|------|-----------|
| `src/services/api/claude.ts` | API 请求构造、流式响应处理、非流式降级 | 4.2.7 |
| `src/services/api/client.ts` | 四提供商（first-party/Bedrock/Vertex/Foundry）客户端创建、认证配置、代理配置 | 4.2.6 |
| `src/services/api/errors.ts` | 错误分类、用户友好消息生成、3P降级建议 | 4.2.9 |
| `src/services/api/withRetry.ts` | 重试逻辑、529前台/后台区分、Opus降级触发、Fast Mode cooldown、Persistent模式心跳 | 4.2.8 |
| `src/utils/model/model.ts` | 模型别名解析、[1m]后缀处理、订阅层级默认模型选择、旧版模型重定向 | 4.2.1 |
| `src/utils/model/modelOptions.ts` | 模型选项列表生成、升级提示 | - |
| `src/utils/model/providers.ts` | API提供商确定、第一方端点检查 | 4.2.2 |
| `src/utils/model/bedrock.ts` | Bedrock客户端创建、推理配置文件查询、区域前缀处理、ARN解析、Backing model查找 | 4.2.5 |
| `src/utils/model/validateModel.ts` | 模型可用性验证、3P降级建议 | 4.2.4 |
| `src/utils/model/configs.ts` | 四提供商模型ID映射、规范模型键定义 | 4.2.3 |
| `src/utils/model/modelAllowlist.ts` | 模型白名单匹配（家族/版本/精确ID三层） | - |
| `src/commands/model/` | 模型选择命令UI | - |
| `scripts/live-model-validation.ts` | Live模型验证独立脚本 | 4.2.4（Live与Mock差异） |

### 8.2 附加API文件说明

| 文件 | 职责 | 与本spec关系 |
|------|------|------------|
| `src/services/api/api.ts` | 工具schema转换、系统提示分块 | 被`claude.ts`使用 |
| `src/services/api/logging.ts` | API请求/响应日志记录 | 被`claude.ts`使用 |
| `src/services/api/errorUtils.ts` | 错误提取与格式化工具 | 被`errors.ts`使用 |
| `src/services/api/rateLimitMocking.ts` | 限流Mock工具（测试用） | 被`withRetry.ts`使用 |
| `src/utils/model/aliases.ts` | 模型别名定义常量 | 被`model.ts`使用 |
| `src/utils/model/modelStrings.ts` | 模型字符串常量 | 被`model.ts`使用 |
| `src/utils/model/modelSupportOverrides.ts` | 模型支持覆盖配置 | 被`model.ts`使用 |
| `src/utils/model/agent.ts` | Agent模型配置 | 被`model.ts`使用 |
| `src/utils/model/check1mAccess.ts` | 1M上下文访问检查 | 被`model.ts`使用 |
| `src/utils/model/contextWindowUpgradeCheck.ts` | 上下文窗口升级检查 | 被`model.ts`使用 |
| `src/utils/model/deprecation.ts` | 模型弃用配置 | 被`model.ts`使用 |
| `src/utils/model/antModels.ts` | ANT内部模型配置 | 被`model.ts`使用 |
| `src/utils/model/antModelOverrides.ts` | ANT模型覆盖配置 | 被`model.ts`使用 |

## 9. 改进建议

### 9.1 P1：模型能力矩阵

**触发场景与证据**：当前各模型/提供商的 beta 功能（prompt caching、fast mode、effort、thinking、structured outputs 等）可用性分散在各处检查，没有统一的能力矩阵。

**建议方向**：
1. 定义 `ModelCapabilityMatrix` 类型，明确每个模型在每个提供商的可用功能
2. 集中化检查函数，替换分散的条件检查

**回归风险**：低 - 可以渐进迁移，保持旧函数作为包装器

**验收方式**：所有模型能力检查统一通过矩阵 API

**工作量**：M-L

**置信度**：已证实（基于代码阅读）

---

### 9.2 P2：模型选项生成性能优化

**触发场景与证据**：`getModelOptions()` 在每次调用时都重新计算所有选项，包含多个条件分支和环境变量检查。

**建议方向**：
1. 在配置不变的情况下缓存 `getModelOptions()` 结果
2. 使用细粒度失效

**回归风险**：低

**验收方式**：连续两次调用返回相同引用

**工作量**：S

**置信度**：已证实（基于代码阅读）
