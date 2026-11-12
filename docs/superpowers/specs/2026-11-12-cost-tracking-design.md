---
id: cost-tracking
batch: 4
title: Cost Tracking 用量、成本与限额展示设计
date: 2026-11-12
status: draft
---

# Cost Tracking 用量、成本与限额展示设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 需要跟踪会话级别的 API 用量和成本，展示给用户，并支持限额/套餐状态显示。如果没有统一的成本跟踪系统，会导致：

- 用户无法知道当前会话消耗了多少 token、多少费用
- 不同计费模型（不同模型、prompt cache、web search）的成本计算分散
- 限额/套餐状态（如 Claude.ai 订阅的额度限制）无法及时展示给用户
- 会话切换时成本状态丢失，无法恢复
- 团队/企业用户和个人用户的成本展示边界不清晰

因此本子系统必须在以下约束下完成成本跟踪与展示：

- 支持多种模型的不同定价（输入/输出 token、prompt cache 写/读、web search）
- 区分 Claude.ai 订阅用户和 API key 用户，显示不同的成本信息
- 订阅用户支持限额显示（5小时额度、7天额度、Opus 专项额度）
- 支持超额使用（overage）管理与配置
- 会话级别成本持久化，恢复会话时可恢复上次成本状态
- 按模型汇总显示用量，同一模型的不同变体合并展示
- 成本显示精度根据金额动态调整（> $0.5 显示两位小数，否则显示四位）
- 隐私控制：只向有权限的用户显示成本信息

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 成本状态存储在 bootstrap/state 模块级变量 | STATE.totalCostUSD、STATE.modelUsage 等作为全局状态 | 单例全局状态，访问方便，符合现有架构模式 | 使用类实例传递：需要在整个调用链中传递，改动大；使用 React context：仅 UI 可用，非 UI 代码无法访问 | 全局状态带来的测试隔离问题（需要 reset 函数） | src/bootstrap/state.ts:51-67 |
| 模型成本分层配置：按定价 tier 分组 | COST_TIER_3_15、COST_TIER_15_75、COST_TIER_5_25 等常量，MODEL_COSTS map | 新模型加入时只需映射到对应 tier，定价变更时只需改一处 | 每个模型单独配置：重复代码，容易出错；从网络拉取定价：增加依赖，离线不可用 | 新增 Opus 4.6 fast mode 时需要新增 tier | src/utils/modelCost.ts:35-126 |
| 按模型短名汇总显示：getCanonicalName 合并 | formatModelUsage 中按 shortName 聚合 | 用户不需要区分模型变体（如 Claude 3.7 Sonnet 与 claude-3-7-sonnet），简洁展示 | 显示完整模型名：信息冗余，占用终端空间；完全不区分模型：用户不知道用了什么模型 | 需要维护 getCanonicalName 的映射关系 | src/cost-tracker.ts:188-210 |
| 成本显示精度动态调整：> $0.5 用两位小数 | formatCost 函数判断 cost > 0.5 ? toFixed(2) : toFixed(4) | 大额成本清晰易读，小额成本足够精确 | 统一两位小数：小额成本（如 $0.0012）显示为 $0.00，信息丢失；统一四位小数：大额成本可读性差 | 小数位数切换阈值固定为 $0.5 | src/cost-tracker.ts:177-179 |
| 成本持久化到项目 config：按 sessionId 匹配 | saveCurrentSessionCosts 保存到 projectConfig，getStoredSessionCosts 验证 sessionId 才返回 | 会话恢复时可恢复上次成本状态，不同会话不串扰 | 保存到单独文件：增加文件管理复杂度；不持久化：会话重启后成本丢失 | 项目 config 需要是可写的 | src/cost-tracker.ts:87-175 |
| 权限控制：hasConsoleBillingAccess / hasClaudeAiBillingAccess | 检查订阅状态、组织角色、工作区角色，决定是否显示成本 | 保护敏感成本信息，只向有权限的用户展示 | 总是显示成本：非管理员用户可能不应看到组织成本；总是隐藏：用户无法了解自己的消耗 | 需要在多处调用权限检查 | src/utils/billing.ts:10-78 |
| 限额状态从 API 响应头提取：anthropic-ratelimit-unified-* | extractQuotaStatusFromHeaders 解析响应头，更新 currentLimits | 实时反映最新限额状态，不需要额外 API 调用 | 专门调用 /usage 端点：增加网络请求，可能延迟；客户端计算配额：易与服务端不一致 | 依赖服务端发送正确的响应头格式 | src/services/claudeAiLimits.ts:472-515 |
| 超额使用（overage）双路径：浏览器打开 + 管理员请求 | runExtraUsage 判断权限，有权限则打开浏览器，否则请求管理员启用 | 区分个人用户与团队用户，不同场景不同流程 | 总是打开浏览器：团队非管理员用户无法操作；总是请求管理员：个人用户流程繁琐 | 需要处理多种权限组合 | src/commands/extra-usage/extra-usage-core.ts:18-118 |
| 未知模型成本降级：使用默认模型成本 | getModelCosts 中找不到则用 getDefaultMainLoopModelSetting，设置 hasUnknownModelCost | 新模型发布后仍能估算成本，不阻塞使用 | 报错拒绝：新模型无法使用；不计成本：用户无感知 | 估算成本可能不准确（有警告提示） | src/utils/modelCost.ts:156-163 |
| Advisor 用量递归累加：addToTotalSessionCost 递归处理 | getAdvisorUsage 提取子请求，递归计算并累加成本 | 完整跟踪包括 Advisor 在内的总消耗 | 忽略 Advisor 用量：成本低估；单独显示：信息复杂 | 需要正确识别 Advisor 子请求 | src/cost-tracker.ts:303-321 |

## 3. 目标与非目标

### 状态与生命周期

- **目标**：跟踪会话级别的总费用（totalCostUSD）、各模型用量（modelUsage）
- **目标**：持久化成本状态到项目 config，支持会话恢复
- **目标**：跟踪 API 耗时（totalAPIDuration）、工具耗时（totalToolDuration）
- **目标**：跟踪代码行数变更（totalLinesAdded/Removed）
- **目标**：标记是否使用了未知模型成本（hasUnknownModelCost）
- **非目标**：不支持跨会话的成本汇总（由服务端/控制台负责）

### 接口与数据

- **目标**：ModelUsage 类型包含 inputTokens、outputTokens、cacheReadInputTokens、cacheCreationInputTokens、webSearchRequests、costUSD
- **目标**：calculateUSDCost 根据模型和用量计算美元成本
- **目标**：formatTotalCost 生成终端友好的成本展示文本
- **目标**：fetchUtilization 获取 Claude.ai 用户的用量/限额数据
- **非目标**：不提供成本导出功能（仅显示）

### 执行与环境

- **目标**：Claude.ai 订阅用户显示限额状态，不显示具体金额（Ant 内部除外）
- **目标**：API key 用户显示具体金额成本
- **目标**：团队/企业用户根据角色决定是否能管理超额使用
- **目标**：process exit 时自动打印成本汇总（useCostSummary hook）
- **非目标**：不支持实时流式成本更新（仅会话结束或 /cost 命令时显示）

### 依赖边界

- **Settings**：成本状态保存到 project config，但不进入 settings 域
- **Auth**：限额状态依赖 OAuth token 和订阅状态
- **Telemetry**：成本数据上报到 analytics，但不由本 spec 负责

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 成本计算与格式化
function calculateUSDCost(model: string, usage: BetaUsage): number
function formatModelPricing(costs: ModelCosts): string

// 成本状态管理
function addToTotalSessionCost(
  cost: number,
  usage: Usage,
  model: string,
): number
function getTotalCostUSD(): number
function getTotalCostUSD(): number
function formatTotalCost(): string
function formatCost(cost: number, maxDecimalPlaces?: number): string

// 会话持久化
function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void
function getStoredSessionCosts(sessionId: string): StoredCostState | undefined
function restoreCostStateForSession(sessionId: string): boolean

// 用量查询
function getTotalInputTokens(): number
function getTotalOutputTokens(): number
function getTotalCacheReadInputTokens(): number
function getTotalCacheCreationInputTokens(): number
function getTotalWebSearchRequests(): number
function getModelUsage(): { [modelName: string]: ModelUsage }
function getUsageForModel(model: string): ModelUsage | undefined

// 限额与套餐
function fetchUtilization(): Promise<Utilization | null>
function checkQuotaStatus(): Promise<void>
function extractQuotaStatusFromHeaders(headers: Headers): void
function hasClaudeAiBillingAccess(): boolean
function hasConsoleBillingAccess(): boolean

// 超额使用管理
function runExtraUsage(): Promise<ExtraUsageResult>
```

调用方式：

1. **请求完成路径**：API 请求完成后，调用 `addToTotalSessionCost` 累加成本
2. **会话退出路径**：`useCostSummary` hook 在 process exit 时调用 `formatTotalCost` 打印汇总
3. **/cost 命令路径**：用户输入 `/cost` 时调用 `formatTotalCost` 显示
4. **会话恢复路径**：启动时调用 `restoreCostStateForSession` 恢复上次成本状态
5. **限额检查路径**：启动时调用 `checkQuotaStatus`，响应时调用 `extractQuotaStatusFromHeaders`

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| bootstrap/state | STATE.totalCostUSD、STATE.modelUsage、STATE.hasUnknownModelCost、STATE.totalAPIDuration | getTotalCostUSD、addToTotalCostState、getModelUsage、resetCostState | 成本计算逻辑 | 提供状态读写接口给 cost-tracker |
| cost-tracker | (无独立状态，委托给 bootstrap/state) | addToTotalSessionCost、formatTotalCost、saveCurrentSessionCosts、restoreCostStateForSession、formatModelUsage | 模型定价配置 | 调用 modelCost.ts 计算单价，调用 config.ts 持久化 |
| costHook | (无状态) | useCostSummary（注册 process exit 监听器） | 成本计算与展示 | 调用 cost-tracker 的 formatTotalCost 和 saveCurrentSessionCosts |
| modelCost | MODEL_COSTS、COST_TIER_* 常量 | calculateUSDCost、getModelCosts、formatModelPricing | 成本累加 | 提供单价计算给 cost-tracker |
| billing | mockBillingAccessOverride（测试用） | hasConsoleBillingAccess、hasClaudeAiBillingAccess、setMockBillingAccessOverride | 实际限额逻辑 | 调用 auth.ts 判断订阅状态和角色 |
| claudeAiLimits | currentLimits、statusListeners、rawUtilization | checkQuotaStatus、extractQuotaStatusFromHeaders、onQuotaStatusChange | 成本计算 | 调用 usage API，解析响应头 |
| services/api/usage | (无状态) | fetchUtilization | 限额状态管理 | 返回 Utilization 类型给调用方 |
| extraUsage | (无状态) | isBilledAsExtraUsage | 超额使用命令实现 | 提供判断逻辑给其他模块 |
| commands/cost | (无状态) | call（/cost 命令实现） | 成本计算与格式化 | 调用 cost-tracker 的 formatTotalCost |
| commands/usage | (无状态) | call（/usage 命令实现） | 限额展示 UI | 打开 Settings dialog 到 Usage 标签 |
| commands/extra-usage | (无状态) | runExtraUsage、call（/extra-usage 命令实现） | 权限判断以外的逻辑 | 调用 billing.ts 判断权限，调用 api/adminRequests.ts 请求管理员 |

状态位置与理由：

- **成本核心状态**放在 bootstrap/state：全局单例，全链路可访问，与现有架构一致
- **限额状态**放在 claudeAiLimits：订阅相关逻辑独立，与成本计算解耦
- **定价配置**放在 modelCost 常量：纯数据，无状态，易维护
- **权限覆盖状态**放在 billing 模块：与订阅/角色逻辑一起，集中管理

### 4.3 主控制流

完整的成本跟踪与展示流程（端到端）：

```text
用户发起 API 请求
  ↓
API 响应返回 BetaUsage（包含 input/output tokens、cache 用量等）
  ↓
calculateUSDCost 根据模型查找定价 tier
  ↓
addToTotalSessionCost 累加：
  ├─ 更新 STATE.modelUsage[model]
  ├─ 累加 STATE.totalCostUSD
  ├─ 上报到 costCounter/tokenCounter（telemetry）
  └─ 递归处理 Advisor 子请求用量
  ↓
（可选）响应头包含限额信息 → extractQuotaStatusFromHeaders 更新 currentLimits
  ↓
用户输入 /cost 命令
  ↓
formatTotalCost 生成展示文本：
  ├─ formatCost 格式化总金额
  ├─ formatModelUsage 按短名聚合各模型用量
  └─ 包含 API 耗时、代码变更行数
  ↓
输出给用户（仅有权限时）
  ↓
（会话退出时）useCostSummary hook：
  ├─ process.on('exit') 触发
  ├─ 再次打印 formatTotalCost
  └─ saveCurrentSessionCosts 持久化到 project config
```

限额与超额使用流程：

```text
Claude.ai 订阅用户启动
  ↓
checkQuotaStatus 发起测试请求（小 token 数）
  ↓
响应头包含 anthropic-ratelimit-unified-*
  ↓
extractQuotaStatusFromHeaders 解析：
  ├─ 检查 status（allowed/allowed_warning/rejected）
  ├─ 检查是否使用 overage
  ├─ 检查 early warning thresholds（header 或 fallback 时间相对）
  ├─ 更新 currentLimits
  ├─ emit status change 事件
  └─ 缓存 extra usage disabled reason
  ↓
用户接近限额 → 显示警告
  ↓
用户输入 /extra-usage
  ↓
runExtraUsage 判断权限：
  ├─ 有 billing access → 打开浏览器到 settings/usage
  ├─ 无权限但团队有 unlimited → 提示无需请求
  ├─ 无权限但有 pending request → 提示已请求
  └─ 无权限 → 创建管理员请求
```

会话恢复流程：

```text
用户启动并恢复之前的会话
  ↓
restoreCostStateForSession(sessionId)
  ↓
getStoredSessionCosts 从 project config 读取：
  ├─ 验证 sessionId 是否匹配（不匹配则返回 undefined）
  ├─ 重建 modelUsage（注入 contextWindow/maxOutputTokens）
  └─ 返回 StoredCostState
  ↓
setCostStateForRestore 更新 STATE 中的成本状态
  ↓
用户可看到之前会话的累计成本
```

### 4.4 数据结构与持久化

关键数据结构：

```typescript
// 模型用量（内存中与持久化共用）
type ModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number  // 仅内存中，不持久化
  maxOutputTokens: number  // 仅内存中，不持久化
}

// 持久化成本状态（存储在 project config）
type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: Omit<ModelUsage, 'contextWindow' | 'maxOutputTokens'> } | undefined
}

// 用量/限额 API 响应
type Utilization = {
  fiveHour?: RateLimit | null
  sevenDay?: RateLimit | null
  sevenDayOauthApps?: RateLimit | null
  sevenDayOpus?: RateLimit | null
  extraUsage?: ExtraUsage | null
}

type RateLimit = {
  utilization: number | null  // 百分比 0-100
  resets_at: string | null  // ISO 8601
}

type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

// 模型成本配置
type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}
```

持久化：

- **内存状态**：bootstrap/state 的 STATE 对象中
- **项目级别持久化**：保存到 project config（`getCurrentProjectConfig()`），字段包括 lastCost、lastAPIDuration、lastModelUsage、lastSessionId 等
- **缓存 extra usage 状态**：global config 中缓存 cachedExtraUsageDisabledReason，跨会话持久化
- **限额状态**：仅内存中 currentLimits，不持久化（每次启动重新检查）

恢复时：

- 从 project config 读取，验证 sessionId 是否匹配
- 重建 modelUsage 时注入 contextWindow 和 maxOutputTokens（从 model config 动态获取）

### 4.5 跨子系统依赖

- **bootstrap/state**：成本状态存储主归本 spec，但 state 模块本身由其他 spec 主拥有
- **config.ts**：project config 和 global config 的读写，主归 config spec
- **auth.ts**：订阅状态、角色判断、OAuth token，主归 auth spec
- **telemetry/analytics**：成本数据上报，主归 telemetry spec
- **model/config.ts**：模型上下文窗口、最大输出 token，主归 model spec

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| 未知模型定价 | getModelCosts 中 MODEL_COSTS[shortName] 不存在 | 记录 tengu_unknown_model_cost 事件，设置 hasUnknownModelCost，fallback 到默认模型成本 | 否（继续执行） | 无 | 成本估算继续，但显示警告（"costs may be inaccurate"） |
| fetchUtilization 网络失败 | fetchUtilization | 抛出异常，调用方 catch | 否（单次尝试） | 无 | 返回 null，限额显示不可用 |
| 项目 config 不可写 | saveCurrentSessionCosts | 异常向上传播（config 模块处理） | 否 | 无 | 成本状态不持久化，但内存中仍可用 |
| sessionId 不匹配（恢复时） | getStoredSessionCosts | 返回 undefined，不抛异常 | 否 | 无 | 不恢复成本状态，从零开始 |
| 限额响应头格式错误 | computeNewLimitsFromHeaders | 静默忽略错误字段，使用默认值 | 否 | 无 | 限额状态可能不完整，但不阻塞使用 |
| extra usage 请求失败 | createAdminRequest | 记录日志，返回 generic message | 否 | 无 | 用户看到失败提示，可稍后重试 |

工程取舍：

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| 全局状态 vs 依赖注入 | 使用 bootstrap/state 全局单例 | 测试需要 reset，并发隔离困难 | 访问简单，与现有架构一致，无需传递成本对象 |
| 静态定价 vs 动态拉取 | 硬编码 MODEL_COSTS 常量 | 定价变更需要发版 | 离线可用，无网络依赖，响应快 |
| 会话级别持久化 vs 跨会话汇总 | 仅保存当前会话，不汇总历史 | 用户无法看到历史总成本 | 实现简单，不依赖外部存储 |
| 权限检查多处调用 vs 上下文传递 | 每次显示成本都调用 has*BillingAccess | 重复检查 | 逻辑清晰，不依赖上下文传递 |
| 限额检查仅启动/响应头 vs 定期轮询 | 启动时检查一次，响应时更新 | 中间时段限额状态可能过期 | 减少网络请求，避免打扰用户 |
| 未知模型降级 vs 阻塞 | 使用默认模型成本继续 | 成本可能不准确 | 新模型立即可用，不阻塞使用 |
| 按短名聚合 vs 单独显示 | getCanonicalName 合并变体 | 无法区分同一模型的不同版本（如 fast mode） | 展示简洁，用户不需要知道细节 |

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| 新会话开始 | 发起几个 API 请求 | totalCostUSD 正确累加，modelUsage 有各模型数据 | 不应重复计算或遗漏 |
| 使用未知模型 | 调用新发布的模型 | hasUnknownModelCost 变为 true，成本估算继续，显示警告 | 不应报错退出 |
| 会话正常退出 | process exit 事件 | 终端打印 cost summary，project config 保存成本状态 | 不应遗漏保存或打印失败 |
| 恢复之前会话 | 启动时 sessionId 匹配 | 成本状态恢复为上次的值 | 不应与其他会话串扰 |
| Claude.ai 订阅用户 | 查看成本 | 显示限额状态，不显示具体金额（Ant 除外） | 不应泄露敏感定价信息 |
| API key 用户 | 查看成本 | 显示具体金额成本，不显示订阅限额 | 不应显示不相关的限额信息 |
| 接近限额 | 额度使用达到阈值 | 显示 early warning 提示 | 不应无提示突然阻断 |
| 使用 prompt cache | 调用有 cache 命中的请求 | cacheReadInputTokens 增加，成本按 cache 定价计算 | 不应按常规输入 token 计费 |
| 使用 web search | 调用有 web search 的请求 | webSearchRequests 增加，成本增加 | 不应忽略 web search 成本 |
| 团队非管理员用户 | 运行 /extra-usage | 提示联系管理员或自动创建请求 | 不应打开需要权限的管理页面 |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 成本状态存储在 bootstrap/state | src/bootstrap/state.ts:51-67, 561-879 | 需查找相关测试 | 未找到直接测试覆盖 |
| 模型成本分层配置 | src/utils/modelCost.ts:35-126 | 需查找相关测试 | 未找到直接测试覆盖 |
| 按模型短名汇总显示 | src/cost-tracker.ts:188-210 | 需查找相关测试 | 未找到直接测试覆盖 |
| 成本显示精度动态调整 | src/cost-tracker.ts:177-179 | 需查找相关测试 | 未找到直接测试覆盖 |
| 成本持久化到项目 config | src/cost-tracker.ts:87-175 | 需查找相关测试 | 未找到直接测试覆盖 |
| 权限控制检查 | src/utils/billing.ts:10-78 | 需查找相关测试 | 未找到直接测试覆盖 |
| 限额状态从响应头提取 | src/services/claudeAiLimits.ts:472-515 | 需查找相关测试 | 未找到直接测试覆盖 |
| 超额使用双路径流程 | src/commands/extra-usage/extra-usage-core.ts:18-118 | 需查找相关测试 | 未找到直接测试覆盖 |
| 未知模型成本降级 | src/utils/modelCost.ts:156-163 | 需查找相关测试 | 未找到直接测试覆盖 |
| Advisor 用量递归累加 | src/cost-tracker.ts:303-321 | 需查找相关测试 | 未找到直接测试覆盖 |

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| src/cost-tracker.ts | addToTotalSessionCost、formatTotalCost、saveCurrentSessionCosts、restoreCostStateForSession、getStoredSessionCosts、formatModelUsage、formatCost | 成本累加、格式化、会话持久化与恢复、主入口 |
| src/costHook.ts | useCostSummary | React hook，注册 process exit 监听器打印成本并保存 |
| src/utils/modelCost.ts | calculateUSDCost、getModelCosts、MODEL_COSTS、COST_TIER_3_15、COST_TIER_15_75、COST_TIER_5_25、COST_TIER_30_150、COST_HAIKU_35、COST_HAIKU_45 | 模型定价配置、成本计算函数、格式化定价字符串 |
| src/utils/billing.ts | hasConsoleBillingAccess、hasClaudeAiBillingAccess、setMockBillingAccessOverride | 成本显示权限判断、测试用 mock |
| src/utils/extraUsage.ts | isBilledAsExtraUsage | 判断是否按超额使用计费 |
| src/services/claudeAiLimits.ts | currentLimits、checkQuotaStatus、extractQuotaStatusFromHeaders、extractQuotaStatusFromError、onQuotaStatusChange、getRateLimitDisplayName、OverageDisabledReason | 限额状态管理、响应头解析、early warning、状态变更事件 |
| src/services/api/usage.ts | fetchUtilization、Utilization、RateLimit、ExtraUsage | 用量/限额 API 调用、类型定义 |
| src/commands/cost/cost.ts | call | /cost 命令实现 |
| src/commands/cost/index.ts | (command metadata) | /cost 命令元数据、懒加载 |
| src/commands/usage/usage.tsx | call | /usage 命令实现（打开 Settings 到 Usage 标签） |
| src/commands/usage/index.ts | (command metadata) | /usage 命令元数据 |
| src/commands/extra-usage/extra-usage-core.ts | runExtraUsage | /extra-usage 核心逻辑、权限判断、流程分支 |
| src/commands/extra-usage/extra-usage.tsx | call | /extra-usage 交互式实现（React） |
| src/commands/extra-usage/extra-usage-noninteractive.ts | call | /extra-usage 非交互式实现 |
| src/commands/extra-usage/index.ts | extraUsage、extraUsageNonInteractive | /extra-usage 命令元数据、分交互/非交互版本 |
| src/bootstrap/state.ts | STATE.totalCostUSD、STATE.modelUsage、STATE.hasUnknownModelCost、addToTotalCostState、getTotalCostUSD、getModelUsage、resetCostState、setCostStateForRestore | 成本状态存储、读写接口 |

### 7.2 未覆盖行为（基于代码阅读）

- 成本累加的并发安全（多个 API 请求同时完成）
- 会话恢复的完整端到端测试
- 限额 early warning 的时间相对 fallback 逻辑
- 不同定价 tier 的计算准确性测试
- 按短名聚合的边界情况（如模型名大小写、变体识别）
- 权限检查的各种角色组合测试
- /extra-usage 流程的各分支测试
- Advisor 用量递归处理的测试
- prompt cache 成本计算测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/cost-tracking.yaml)

### 8.1 本 spec 主拥有的文件

| 分组 | 主拥有职责 |
|---|---|
| cost-tracker-core | 成本累加、格式化、会话持久化与恢复、用量汇总 |
| cost-hook | 会话退出时自动打印成本并保存 |
| model-cost-config | 模型定价配置、成本计算函数、定价 tier 定义 |
| billing-access | 成本显示权限判断、订阅/角色检查 |
| extra-usage-util | 超额使用计费判断 |
| claude-ai-limits | 限额状态管理、响应头解析、early warning |
| usage-api | 用量/限额 API 调用、类型定义 |
| cmd-cost | /cost 命令实现 |
| cmd-usage | /usage 命令实现 |
| cmd-extra-usage | /extra-usage 命令实现（交互/非交互双版本） |
| bootstrap-cost-state | bootstrap/state 中的成本相关状态与接口 |

### 8.2 共享证据但由其他 spec 主拥有的文件

- src/utils/config.ts：主归 config spec，本 spec 仅描述 project config 的成本字段读写
- src/utils/auth.ts：主归 auth spec，本 spec 仅描述订阅状态和角色判断
- src/services/analytics/index.ts：主归 telemetry spec，本 spec 仅描述成本数据上报
- src/utils/model/model.ts：主归 model spec，本 spec 仅描述 getCanonicalName 和模型配置读取
- src/components/Settings/Settings.tsx：主归 settings spec，本 spec 仅描述 Usage 标签的打开

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | 当前未知模型仅降级到默认成本，用户体验一般 | 支持从服务端拉取最新定价缓存到本地，有新模型时异步更新 | 中（需要处理网络失败、缓存过期） | 新模型发布后能正确计算成本，无需发版 | M | 设计推断 |
| P2 | 限额状态仅启动时和响应时更新，中间可能过期 | 定期后台轮询用量状态（如每小时），或在用户空闲时检查 | 低（轮询频率低，可配置） | 用户总能看到最新限额状态 | S | 设计推断 |
| P2 | 无法区分同一模型的 fast mode 与常规用量 | formatModelUsage 支持按 mode 分开显示，或在 shortName 中体现 | 低（仅展示变化，计算逻辑不变） | 用户能看到 fast mode 消耗了多少 | S | 已证实 |
| P3 | 没有成本历史汇总，用户无法看到长期使用情况 | 支持将历史会话成本保存到本地，提供 /history 命令查看 | 低（仅新增功能，不改变现有） | 用户能看到过去会话的成本趋势 | M | 设计推断 |
| P3 | 成本显示只有终端文本，无可视化 | 支持简单的 ASCII 图表或颜色高亮显示用量占比 | 低（仅展示增强） | 用户能直观看到各模型用量比例 | S | 设计推断 |
