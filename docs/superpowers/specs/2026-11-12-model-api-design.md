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

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 |
|------|-----------|---------|------------|
| `model.ts` | 默认模型配置、模型名称映射 | 解析别名、选择默认模型、渲染显示名 | 验证模型可用性 |
| `modelOptions.ts` | 无（纯函数） | 生成模型选项列表、升级提示 | UI 渲染 |
| `providers.ts` | 无（环境变量驱动） | 确定当前提供商 | 认证管理 |
| `bedrock.ts` | `getBedrockInferenceProfiles()` 缓存 | Bedrock 客户端创建、推理配置文件查询 | Vertex/Foundry 适配 |
| `validateModel.ts` | `validModelCache` | 模型可用性验证 | 对话恢复 |
| `client.ts` | 无 | 创建 Anthropic 客户端（支持各提供商） | 请求构造 |
| `claude.ts` | 无（纯函数 + 闭包） | 构造 API 请求、处理流式响应 | 对话历史管理 |
| `withRetry.ts` | `retryContext`（闭包）、`consecutive529Errors` | 重试逻辑、降级触发 | 降级后的对话适配 |
| `errors.ts` | 无 | 错误分类与用户友好消息生成 | 错误恢复 |
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

- `src/services/api/claude.ts`：API 请求构造与模型调用
- `src/services/api/client.ts`：Anthropic 客户端创建与配置
- `src/services/api/errors.ts`：错误分类与用户友好消息
- `src/services/api/withRetry.ts`：重试逻辑与降级触发
- `src/utils/model/model.ts`：模型选择与解析
- `src/utils/model/modelOptions.ts`：模型选项列表生成
- `src/utils/model/providers.ts`：API 提供商确定
- `src/utils/model/bedrock.ts`：Bedrock 特定逻辑
- `src/utils/model/validateModel.ts`：模型验证
- `src/utils/model/configs.ts`：模型配置常量
- `src/utils/model/modelAllowlist.ts`：模型白名单
- `src/commands/model/`：模型选择命令
- `scripts/live-model-validation.ts`：Live 模型验证脚本

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
