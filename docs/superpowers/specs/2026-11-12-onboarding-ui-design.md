---
id: onboarding-ui
batch: 2
title: "Onboarding UI: 首次引导、信任与设置确认设计"
date: 2026-11-12
status: draft
---

# Onboarding UI 设计文档

## 1. 问题与约束

Onboarding UI 系统解决的核心问题是新用户首次使用 Claude Code 时的配置引导、安全确认与托管设置审批，同时提供项目级引导提示与推荐升级信息。

核心约束：
- 需要支持首次引导（主题选择、API Key 批准、OAuth 流程、安全须知、终端设置）
- 需要提供工作区信任确认，区分非 home 目录与 home 目录的持久化策略
- 需要支持托管设置（Managed Settings）的安全审批，仅展示设置名称不展示值
- 需要支持项目级引导提示，最多显示 4 次后自动隐藏
- 需要支持桌面端与 LSP 插件推荐，分别有不同的展示策略与持久化
- 需要与权限系统、配置系统、认证系统等集成
- 需要支持 Wizard Provider 通用向导框架，提供非线性导航历史

## 2. 设计理由与备选方案

| 决策维度 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---------|---------|----------|-------------------|-----|------|
| 信任状态持久化策略 | 非 home 目录持久化到 projectConfig，home 目录仅 sessionTrustAccepted 内存状态 | 防止 home 目录误操作风险，同时提供非 home 目录的持久化便利 | 统一持久化到磁盘：home 目录风险过高；完全不持久化：体验差，每次需确认 | 需要两种不同的代码路径 | TrustDialog.tsx 相关逻辑 |
| TrustDialog 不自动批准 MCP | MCP 单独在 handleMcpjsonServerApprovals 中处理，TrustDialog 不写入 enableAllProjectMcpServers | 用户失去细粒度控制权，MCP 需要单独审批 | 信任时一并批准：用户失去细粒度控制权 | 用户需要多一步确认 | TrustDialog.tsx 注释说明 |
| ManagedSettingsSecurityDialog 展示策略 | 仅展示设置名称，不展示值 | 敏感信息泄露风险 | 展示完整值：敏感信息可能泄露 | 用户无法看到完整值，仅知道有哪些设置 | utils.ts 相关逻辑 |
| 项目引导显示上限 | projectOnboardingSeenCount >= 4 则不再显示 | 避免永久打扰用户，同时给用户足够次数看到提示 | 永久显示：打扰用户；仅一次：用户可能错过 | 需要维护计数状态 | projectOnboardingState.ts 相关逻辑 |
| Wizard Provider 导航支持 | 维护 navigationHistory，支持 goToStep、goNext、goBack、cancel | 支持非线性导航，更灵活的向导体验 | 仅线性前后：无法支持分支跳转 | 需要维护历史状态 | WizardProvider.tsx 相关逻辑 |

## 3. 目标与非目标

### 目标

- 提供完整的首次引导流程：Preflight（仅 OAuth）、Theme、API Key Approval、OAuth Flow、Security Notes、Terminal Setup
- 提供工作区信任确认，检查项目级 MCP、hooks、bash 权限、apiKeyHelper、aws/gcp 命令、otelHeadersHelper、危险环境变量
- 提供托管设置安全审批，检查 DANGEROUS_SHELL_SETTINGS、非 SAFE_ENV_VARS 环境变量、hooks
- 提供项目级引导提示，检查 CLAUDE.md 和空目录，最多显示 4 次
- 提供桌面端推荐，支持“现在不”“不再询问”或跳转
- 提供 LSP 插件推荐，30 秒自动消失，支持按插件/全局禁用
- 提供 Wizard Provider 通用向导框架，支持非线性导航历史
- 提供 Claude Code Hint 提示协议，检测 claude-code-hint 标签

### 非目标

- 不定义权限裁决（permission rules）的具体算法
- 不包含 settings schema 的完整定义
- 不处理 MCP 服务器的逐个审批逻辑（见 handleMcpjsonServerApprovals）

## 4. 架构、模块与数据流

### 核心入口与流程

总入口启动流程：
```
启动 → showSetupScreens → [Onboarding → TrustDialog → ManagedSettingsSecurityDialog] → REPL
```

关键入口位置：
- `src/interactiveHelpers.tsx` 的 `showSetupScreens` 控制流
- `src/bootstrap/state.ts` 会话级状态
- `src/utils/config.ts` 全局/项目级持久化

### 核心模块与组件

| 模块 | 主要职责 | 核心文件 |
|-----|---------|---------|
| Wizard Provider | 通用向导框架，提供 useWizard hook，支持非线性导航历史 | `src/components/wizard/` |
| Onboarding | 首次引导多步流程：Preflight、Theme、API Key Approval、OAuth Flow、Security Notes、Terminal Setup | `src/components/Onboarding.tsx` |
| TrustDialog | 工作区安全检查与信任确认，区分非 home 与 home 目录 | `src/components/TrustDialog/` |
| ManagedSettingsSecurityDialog | 托管设置审批，仅展示名称不展示值 | `src/components/ManagedSettingsSecurityDialog/` |
| DesktopUpsellStartup | 桌面端升级推荐，支持”现在不””不再询问”或跳转 | `src/components/DesktopUpsell/` |
| LspRecommendationMenu | LSP 插件推荐，30 秒自动消失，支持按插件/全局禁用 | `src/components/LspRecommendation/` |
| ClaudeCodeHint | 提示协议，检测 claude-code-hint 标签 | `src/utils/claudeCodeHints.ts` |
| Project Onboarding | 项目级引导，检查 CLAUDE.md 和空目录，最多显示 4 次 | `src/projectOnboardingState.ts` |

### 数据持久化层次

| 状态 | 存储位置 | 范围 | 说明 |
|-----|---------|------|-----|
| 首次引导完成 | `globalConfig.hasCompletedOnboarding` | 用户全局 | 不重复引导 |
| 工作区信任（非 home） | `projectConfig.hasTrustDialogAccepted` | 当前目录 | 永久信任 |
| 工作区信任（home） | `sessionTrustAccepted` | 内存/会话 | 仅本次会话 |
| 项目引导可见次数 | `projectConfig.projectOnboardingSeenCount` | 当前目录 | 最多显示 4 次 |
| 桌面端推荐状态 | `globalConfig.desktopUpsellSeenCount` / `desktopUpsellDismissed` | 用户全局 | 最多显示 3 次，支持”不再询问” |

### 首次启动完整流程

1. **启动** → 检测 `globalConfig.hasCompletedOnboarding`
   - 未完成 → 显示 `Onboarding`
   - 已完成 → 跳过
2. **Onboarding**
   - 主题选择（默认显示 Intro 文字）
   - 检测环境变量 `ANTHROPIC_API_KEY`（且非 homespace）→ `ApproveApiKey`
   - OAuth 启用 → `ConsoleOAuthFlow`（可通过 API Key 跳过）
   - 安全须知（确认进入下一步）
   - 终端检测 → 终端设置推荐（可选）
   - 完成 → 写入 `globalConfig.hasCompletedOnboarding = true`
3. **TrustDialog**
   - 检测当前目录信任状态
   - 扫描项目/本地设置中的风险项
   - 无风险且已信任 → 自动通过
   - 否则显示确认
4. **ManagedSettingsSecurityDialog**
   - 检测托管设置（managed settings）是否包含危险项且有变更
   - 是 → 显示审批
5. **进入 REPL**

### 关键键绑定

- `confirm:yes`（默认 Enter）→ 确认
- `confirm:no`（默认 Esc）→ 取消/退出
- `Ctrl+C` / `Ctrl+D` → 退出流程

---

### 模块设计卡：Onboarding 首次启动向导

#### 真实入口签名/关键类型
```typescript
// src/components/Onboarding.tsx
type StepId = 'preflight' | 'theme' | 'oauth' | 'api-key' | 'security' | 'terminal-setup'
interface OnboardingStep { id: StepId; component: React.ReactNode }
type Props = { onDone(): void }
export function Onboarding({ onDone }: Props): React.ReactNode

// src/interactiveHelpers.tsx
export function completeOnboarding(): void
export async function showSetupScreens(
  root: Root,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  commands?: Command[],
  claudeInChrome?: boolean,
  devChannels?: ChannelEntry[],
): Promise<boolean>
```

#### 输入输出
- **输入触发条件**：`!globalConfig.hasCompletedOnboarding || !globalConfig.theme`
- **输出副作用**：设置 `globalConfig.theme`、`globalConfig.hasCompletedOnboarding = true`、`globalConfig.lastOnboardingVersion`
- **退出路径**：正常完成调用 `onDone()`；用户按 `Ctrl+C`/`Ctrl+D` 调用 `gracefulShutdownSync(1)`

#### 引导状态与用户选择
- **步骤状态机**：线性流程，通过 `currentStepIndex` 追踪，无分支跳转（仅条件性包含/跳过某些步骤）
- **用户选择点**：
  - 主题选择：亮色/暗色/系统
  - API Key 审批：批准/拒绝（拒绝不阻止流程）
  - OAuth 流程：可通过 API Key 审批跳过
  - 终端设置：接受/跳过

#### 启动/确认/跳过/持久化流程
- **启动检测**：`showSetupScreens` 中检查 `globalConfig.hasCompletedOnboarding` 和 `globalConfig.theme`
- **步骤跳过条件**：
  - Preflight：OAuth 未启用
  - API Key：`!process.env.ANTHROPIC_API_KEY || isRunningOnHomespace()` 或不是新 key
  - OAuth：已通过 API Key 审批
  - Terminal Setup：`shouldOfferTerminalSetup()` 返回 false
- **持久化时机**：最后一步完成后立即调用 `completeOnboarding()`

#### 错误与降级
- **Terminal Setup 失败**：内部吞掉错误，继续流程
- **重复调用 onDone**：幂等处理，`completeOnboarding()` 调用多次仅设置一次状态
- **StrictMode 计数**：无影响，纯状态更新

#### 设计取舍/备选
| 取舍维度 | 当前选择 | 代价 | 收益 | 备选方案 |
|---------|---------|-----|------|---------|
| 流程控制 | 内部线性步骤数组 | 灵活性较低 | 简单可预测 | 使用 WizardProvider |
| 步骤条件 | 启动时一次性计算 | 动态响应差 | 避免渲染时抖动 | 动态条件检查 |
| 退出处理 | 统一使用 `useExitOnCtrlCDWithKeybindings` | 组件耦合 | 一致的用户体验 | 各步骤独立处理 |

#### 源码测试证据
- **源码位置**：`src/components/Onboarding.tsx`、`src/interactiveHelpers.tsx`
- **测试覆盖**：`tests/issueOnboarding.test.ts` 仅验证幂等性和 /onboarding 命令行为
- **未覆盖**：各步骤的条件包含逻辑、主题选择持久化、终端设置执行

---

### 模块设计卡：TrustDialog 工作区信任确认

#### 真实入口签名/关键类型
```typescript
// src/components/TrustDialog/TrustDialog.tsx
type Props = { onDone(): void; commands?: Command[] }
export function TrustDialog({ onDone, commands }: Props): React.ReactNode

// src/utils/config.ts
export function checkHasTrustDialogAccepted(): boolean

// src/bootstrap/state.ts
export function setSessionTrustAccepted(value: boolean): void
```

#### 输入输出
- **检测项输入**：项目级 MCP servers、hooks、bash 权限、apiKeyHelper、aws/gcp commands、otelHeadersHelper、dangerous env vars
- **输出副作用**：
  - 非 home 目录：`projectConfig.hasTrustDialogAccepted = true`
  - home 目录：仅设置 `sessionTrustAccepted = true`（内存）
  - **不写入** MCP 服务器批准状态（由后续 `handleMcpjsonServerApprovals` 单独处理）

#### 引导状态与用户选择
- **信任二元状态**：信任/不信任，无中间状态
- **选择后不可撤销**：当前会话内无法撤销信任决定
- **用户选择**：”Yes, I trust this folder” 或 “No, exit”

#### 启动/确认/跳过/持久化流程
- **快速路径**：`checkHasTrustDialogAccepted() === true` → 跳过渲染，直接 `setTimeout(onDone)`
- **检测范围**：仅项目级和项目本地级设置（不信任用户级设置）
- **持久化策略区分**：
  - 非 home 目录：持久化到 `projectConfig`
  - home 目录：仅内存 `sessionTrustAccepted`，防误操作扩大风险

#### Trust 与 MCP Approval 的区别
| 维度 | TrustDialog | MCP Approval |
|-----|-------------|--------------|
| 作用范围 | 整个工作区权限边界 | 单个 MCP 服务器 |
| 持久化 | 项目配置或会话内存 | 项目配置 |
| 时机 | 进入 REPL 前 | TrustDialog 之后，设置无误时 |
| 粒度 | 二元全有/全无 | 逐个服务器 |
| 依赖关系 | MCP Approval 依赖 Trust 已建立 | Trust 不自动批准 MCP |

#### 错误与降级
- **检测失败**：保守处理，显示对话框（不视为已信任）
- **用户按 Esc**：等同于选择 “No, exit”，调用 `gracefulShutdownSync(0)`
- **用户按 Ctrl+C/Ctrl+D**：调用 `gracefulShutdownSync(1)`

#### 设计取舍/备选
| 取舍维度 | 当前选择 | 代价 | 收益 | 备选方案 |
|---------|---------|-----|------|---------|
| home 目录策略 | 仅内存不持久化 | 用户每次需确认 | 安全优先 | 可配置持久化 |
| MCP 分离 | Trust 不自动批准 MCP | 多一步交互 | 保留细粒度控制 | 合并审批 |
| 检测范围 | 仅项目/本地设置 | 可能遗漏用户级风险 | 减少误报 | 包含用户级 |

#### 源码测试证据
- **源码位置**：`src/components/TrustDialog/TrustDialog.tsx`、`src/components/TrustDialog/utils.ts`
- **测试覆盖**：无直接测试
- **分析点**：Line 153-156 明确注释不写入 MCP 设置；Line 141-151 区分 home/非 home 持久化

---

### 模块设计卡：ManagedSettingsSecurityDialog 托管设置安全确认

#### 真实入口签名/关键类型
```typescript
// src/components/ManagedSettingsSecurityDialog/ManagedSettingsSecurityDialog.tsx
type Props = {
  settings: SettingsJson
  onAccept: () => void
  onReject: () => void
}
export function ManagedSettingsSecurityDialog({ settings, onAccept, onReject }: Props): React.ReactNode

// src/components/ManagedSettingsSecurityDialog/utils.ts
export function extractDangerousSettings(settings: SettingsJson): DangerousSetting[]
export function formatDangerousSettingsList(dangerous: DangerousSetting[]): string[]
```

#### 输入输出
- **输入**：完整 `SettingsJson`（托管设置）
- **输出**：
  - 接受：调用 `onAccept()`，继续启动流程
  - 拒绝：调用 `onReject()`，退出程序
- **展示策略**：仅展示设置名称，不展示值（防敏感信息泄露）

#### 组织策略显示
- **提示上下文**：明确告知”Your organization has configured managed settings”
- **风险描述**：”could allow execution of arbitrary code or interception of your prompts and responses”
- **用户指导**：”Only accept if you trust your organization's IT administration”
- **设置列表**：使用 `formatDangerousSettingsList` 格式化为项目符号列表

#### 启动/确认/跳过/持久化流程
- **调用位置**：`showSetupScreens` 中，TrustDialog 之后
- **触发条件**：托管设置包含危险项且有变更（具体检测逻辑在调用方）
- **无持久化**：对话框本身不持久化任何状态（接受后启动流程继续）

#### 错误与降级
- **按 Esc**：等同于拒绝，调用 `onReject()`
- **按 Ctrl+C/Ctrl+D**：通过 `useExitOnCtrlCDWithKeybindings` 处理

#### 设计取舍/备选
| 取舍维度 | 当前选择 | 代价 | 收益 | 备选方案 |
|---------|---------|-----|------|---------|
| 展示内容 | 仅名称不展示值 | 用户不知具体配置 | 防敏感泄露 | 展示非敏感部分 |
| 决策粒度 | 全有/全无 | 无法选择性接受 | 简单安全 | 逐项批准 |

#### 源码测试证据
- **源码位置**：`src/components/ManagedSettingsSecurityDialog/`
- **测试覆盖**：无直接测试
- **未覆盖**：危险设置提取逻辑、列表格式化、各种危险设置组合

---

### 模块设计卡：WizardProvider 通用向导框架

#### 真实入口签名/关键类型
```typescript
// src/components/wizard/WizardProvider.tsx
export interface WizardContextValue<T extends Record<string, unknown>> {
  currentStepIndex: number
  totalSteps: number
  wizardData: T
  setWizardData: React.Dispatch<React.SetStateAction<T>>
  updateWizardData: (updates: Partial<T>) => void
  goNext: () => void
  goBack: () => void
  goToStep: (index: number) => void
  cancel: () => void
  title?: string
  showStepCounter: boolean
}

export interface WizardProviderProps<T extends Record<string, unknown>> {
  steps: React.ComponentType[]
  initialData?: T
  onComplete: (data: T) => void | Promise<void>
  onCancel?: () => void
  children?: ReactNode
  title?: string
  showStepCounter?: boolean
}

export function WizardProvider<T extends Record<string, unknown>>({
  steps,
  initialData = {} as T,
  onComplete,
  onCancel,
  children,
  title,
  showStepCounter = true,
}: WizardProviderProps<T>): ReactNode
```

#### 输入输出
- **输入**：`steps` 组件数组、`initialData`、`onComplete`、`onCancel`
- **输出**：通过 `wizardData` 累积用户输入，最终传递给 `onComplete`
- **导航操作**：`goNext`、`goBack`、`goToStep`、`cancel`

#### 引导状态与用户选择
- **线性与非线性混合**：
  - 默认：线性 `currentStepIndex` 递增/递减
  - 非线性：`goToStep` 跳转到任意步骤，同时维护 `navigationHistory`
- **历史追踪**：`navigationHistory` 数组记录跳转来源，支持返回
- **数据累积**：`wizardData` 在步骤间共享，通过 `updateWizardData` 增量更新

#### 启动/确认/跳过/持久化流程
- **启动**：从 `initialData` 和 `currentStepIndex = 0` 开始
- **完成**：最后一步 `goNext` → `isCompleted = true` → `onComplete(wizardData)`
- **取消**：`cancel()` → 清空历史 → `onCancel()`（如果提供）
- **无内部持久化**：WizardProvider 自身不持久化，由调用方决定何时保存

#### 错误与降级
- **步骤越界**：`goToStep` 忽略无效索引（`index < 0 || index >= steps.length`）
- **完成后渲染**：`isCompleted = true` 时返回 `null`
- **useEffect 完成触发**：避免父组件渲染期间更新

#### 设计取舍/备选
| 取舍维度 | 当前选择 | 代价 | 收益 | 备选方案 |
|---------|---------|-----|------|---------|
| 历史管理 | `navigationHistory` 数组 | 内存占用 | 支持非线性返回 | 无历史仅线性 |
| 数据更新 | `updateWizardData` 增量 | 需手动合并 | 灵活易用 | 仅 `setWizardData` |
| 完成触发 | useEffect 延迟 | 多一次渲染 | 避免渲染循环 | 同步调用 |

#### 源码测试证据
- **源码位置**：`src/components/wizard/WizardProvider.tsx`、`src/components/wizard/types.ts`
- **测试覆盖**：无直接测试
- **未覆盖**：非线性导航、历史回溯、数据累积、边界情况

---

### 模块设计卡：Project Onboarding 项目级引导

#### 真实入口签名/关键类型
```typescript
// src/projectOnboardingState.ts
export type Step = {
  key: string
  text: string
  isComplete: boolean
  isCompletable: boolean
  isEnabled: boolean
}

export function getSteps(): Step[]
export function isProjectOnboardingComplete(): boolean
export function maybeMarkProjectOnboardingComplete(): void
export function shouldShowProjectOnboarding(): boolean  // memoized
export function incrementProjectOnboardingSeenCount(): void
```

#### 输入输出
- **输入检测**：当前目录是否为空、是否存在 `CLAUDE.md`
- **输出状态**：
  - `projectConfig.projectOnboardingSeenCount`：显示次数计数
  - `projectConfig.hasCompletedProjectOnboarding`：完成标记
- **步骤内容**：
  - 空目录：建议创建应用或克隆仓库
  - 非空目录：建议运行 `/init` 创建 `CLAUDE.md`

#### 项目 onboarding 状态与 fail-open 边界
- **显示条件（AND）**：
  - `!hasCompletedProjectOnboarding`
  - `projectOnboardingSeenCount < 4`
  - `!IS_DEMO`
  - `!isProjectOnboardingComplete()`（即有启用且未完成的步骤）
- **Fail-open 边界**：
  - 显示计数达到 4 → 永久隐藏（不再打扰）
  - 步骤完成 → 标记 `hasCompletedProjectOnboarding = true`
  - **无重置机制**：计数和完成标记一旦设置无法清除（除手动编辑配置）
- **memoize 优化**：`shouldShowProjectOnboarding` 使用 lodash memoize，避免每次渲染 hit 文件系统

#### 启动/确认/跳过/持久化流程
- **显示时机**：REPL 首次渲染时
- **计数递增**：每次显示调用 `incrementProjectOnboardingSeenCount()`
- **完成检测**：每次 prompt submit 调用 `maybeMarkProjectOnboardingComplete()`
- **文件系统缓存**：先检查配置中的缓存状态，再 hit 文件系统

#### 错误与降级
- **文件系统读取失败**：通过 `getFsImplementation()` 抽象，失败时保守处理
- **StrictMode 双重调用**：`maybeMarkProjectOnboardingComplete()` 有缓存保护，重复调用无影响

#### 设计取舍/备选
| 取舍维度 | 当前选择 | 代价 | 收益 | 备选方案 |
|---------|---------|-----|------|---------|
| 显示上限 | 最多 4 次 | 用户可能错过 | 平衡体验与打扰 | 可配置次数 |
| 完成判断 | 纯文件系统状态 | 可能误判 | 无需用户确认 | 用户手动关闭 |
| memoize | 缓存显示决策 | 状态变更延迟 | 性能优化 | 每次重新计算 |

#### 源码测试证据
- **源码位置**：`src/projectOnboardingState.ts`
- **测试覆盖**：无直接测试
- **未覆盖**：计数逻辑、文件系统检测、完成标记、memoize 行为

---

### 模块设计卡：issueOnboarding 路径

#### 真实入口签名/关键类型
```typescript
// src/commands/onboarding/onboarding.tsx
export async function call(
  onDone: (result: string) => void,
  context: LocalJSXCommandContext,
  arg: string,
): Promise<React.ReactNode>

// src/commands/onboarding/index.ts
export default {
  name: 'onboarding',
  isHidden: false,
  description: 'Show the onboarding wizard again',
  load: async () => import('./onboarding.js'),
}

// src/commands/issue/index.ts
export default {
  name: 'issue',
  isHidden: undefined,
  load: async () => import('../feedback/feedback.js'),
}
```

#### 输入输出
- **`/onboarding` 命令输入**：无参数或 `--reset`（拒绝）
- **输出**：渲染 `Onboarding` 组件，或显示用法提示
- **`/issue` 命令**：别名指向 `/feedback`，与 onboarding 无关

#### 引导状态与用户选择
- **幂等性保证**：`completeOnboarding()` 可调用多次，仅第一次有效果
- **无重置支持**：`--reset` 参数被拒绝，显示 “Usage: /onboarding”
- **重新触发**：`/onboarding` 命令可重新显示向导，但完成后不会重复设置状态

#### 启动/确认/跳过/持久化流程
- **命令调用流程**：`/onboarding` → 渲染 `Onboarding` → 用户完成 → `completeOnboarding()` → `onDone()`
- **与启动流程区别**：命令调用不经过 `showSetupScreens`，直接显示向导
- **持久化行为**：与首次启动相同，设置 `globalConfig.hasCompletedOnboarding`

#### 错误与降级
- **`--reset` 拒绝**：不修改状态，返回用法提示
- **重复完成**：幂等处理，多次调用 `onDone()` 仅触发一次 `completeOnboarding()`

#### 设计取舍/备选
| 取舍维度 | 当前选择 | 代价 | 收益 | 备选方案 |
|---------|---------|-----|------|---------|
| 重置功能 | 不支持 `--reset` | 无法重置 | 防止误操作 | 支持重置 |
| issue 别名 | 指向 feedback | 与命名不符 | 历史兼容性 | 重命名命令 |

#### 源码测试证据
- **源码位置**：`src/commands/onboarding/`、`src/commands/issue/index.ts`
- **测试覆盖**：`tests/issueOnboarding.test.ts` 验证：
  - `/issue` 正确加载 `/feedback` 流程
  - `/onboarding` 返回 `Onboarding` 组件
  - `/onboarding` 幂等性
  - `/onboarding --reset` 被拒绝
- **证据边界**：仅验证命令路由，未验证向导实际行为

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|-----------------|--------------|--------------|-------------|
| 检测项读取失败 | TrustDialog / ManagedSettingsSecurityDialog | 内部捕获，保守处理（不视为通过） | 否（下次重新检测） | 无 | 用户看到需要确认的项目 |
| 向导步骤渲染异常 | Wizard Provider | 依赖上层 ErrorBoundary（SentryErrorBoundary） | 否 | 无 | 用户看到错误边界 |
| Terminal Setup 失败 | Onboarding | 吞掉错误继续流程 | 否 | 无 | 用户无感知，继续后续步骤 |
| 重复调用 onDone | Onboarding | 幂等处理 | 否 | 无 | 用户无感知 |
| StrictMode useEffect 计数增加 | Project Onboarding | 有 guard 保护 | 否 | 无 | 用户无感知 |
| Auto-dismiss 时间到 | LspRecommendationMenu | 自动选择“不” | 否 | 无 | 推荐自动消失 |

### 工程取舍总结

| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|------|
| home 目录信任仅内存 vs 持久化 | 仅内存，不持久化 | 用户每次在 home 目录启动需重新确认 | 防止误操作扩大风险 |
| TrustDialog 不自动批准 MCP vs 一并批准 | 不自动批准 | 用户需要多一步确认 | 保留细粒度控制权 |
| Managed Settings 仅展示名称 vs 值 | 仅展示名称 | 用户看不到完整值 | 防止敏感信息泄露 |
| 项目引导最多 4 次 vs 永久/仅一次 | 最多 4 次 | 需要维护计数 | 平衡体验与打扰 |
| Wizard 支持非线性导航 vs 仅线性 | 支持非线性 | 需要维护历史状态 | 更灵活的向导体验 |

## 6. 现状验收标准

- 给定新用户首次启动，Onboarding 流程必须依次展示：Theme（主题选择）、API Key Approval（环境变量检测时）、OAuth Flow（OAuth 启用时）、Security Notes（安全须知）、Terminal Setup（可选）
- 给定首次引导完成，globalConfig.hasCompletedOnboarding 必须设置为 true
- 给定非 home 目录，信任确认后 projectConfig.hasTrustDialogAccepted 必须持久化
- 给定 home 目录，信任确认后必须仅内存保存，不持久化到磁盘
- 给定托管设置包含危险项，ManagedSettingsSecurityDialog 必须展示，且仅展示设置名称不展示值
- 给定项目引导已显示 4 次，项目引导必须不再显示
- 给定 Wizard 步骤，必须支持 goNext、goBack、goToStep、cancel，且维护 navigationHistory
- 给定 LspRecommendationMenu 显示 30 秒后，必须自动消失

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| 首次引导流程多步骤 | `src/components/Onboarding.tsx` | `tests/issueOnboarding.test.ts` 仅验证幂等性，未验证所有步骤 | 仅验证幂等性，未验证所有步骤 |
| TrustDialog 信任区分 home 目录 | `src/components/TrustDialog/` | 无直接测试 | 未覆盖所有检测项组合 |
| ManagedSettingsSecurityDialog 仅展示名称 | `src/components/ManagedSettingsSecurityDialog/`、`src/utils/config.ts` 相关逻辑 | 无直接测试 | 未覆盖所有危险设置组合 |
| Wizard Provider 支持非线性导航 | `src/components/wizard/` | 无直接测试 | 未覆盖复杂分支跳转场景 |
| DesktopUpsellStartup 推荐逻辑 | `src/components/DesktopUpsell/` | 无直接测试 | 未覆盖推荐展示次数上限 |
| LspRecommendationMenu 自动消失 | `src/components/LspRecommendation/` | 无直接测试 | 未覆盖 30 秒计时准确性 |
| ClaudeCodeHint 标签检测 | `src/utils/claudeCodeHints.ts` | 无直接测试 | 未覆盖所有标签格式 |
| Project Onboarding 最多显示 4 次 | `src/projectOnboardingState.ts` | 无直接测试 | 未覆盖计数重置场景 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/onboarding-ui.yaml)

### 主要覆盖组

| 分组 | 主拥有职责 | 相关文件 |
|-----|-----------|---------|
| commands | Onboarding 命令实现 | `src/commands/onboarding/index.ts`、`src/commands/onboarding/onboarding.tsx` |

### 相关子系统

- config：全局/项目级配置持久化
- auth：OAuth 流程与 API Key 处理
- permissions：权限裁决与检查
- mcp：MCP 服务器审批（handleMcpjsonServerApprovals）

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | 当前 Onboarding 流程测试仅验证幂等性，未验证所有步骤 | 添加完整的 Onboarding 流程测试，覆盖所有步骤组合 | 低（仅新增测试） | 测试覆盖 Preflight、Theme、API Key Approval、OAuth Flow、Security Notes、Terminal Setup | L | 设计推断 |
| P2 | 当前 TrustDialog 测试不足 | 添加 TrustDialog 测试，覆盖非 home/home 目录、所有检测项组合 | 低（仅新增测试） | 测试覆盖信任状态持久化策略 | M | 设计推断 |
| P2 | 当前项目引导提示无测试 | 添加项目引导提示测试，覆盖最多显示 4 次后隐藏 | 低（仅新增测试） | 测试计数逻辑 | S | 设计推断 |
| P2 | 当前 Wizard Provider 导航无测试 | 添加 Wizard Provider 非线性导航测试 | 低（仅新增测试） | 测试 goToStep、goNext、goBack、cancel、navigationHistory | M | 设计推断 |
| P3 | 当前桌面端推荐与 LSP 插件推荐无测试 | 添加推荐展示次数上限测试、禁用逻辑测试 | 低（仅新增测试） | 测试推荐展示与禁用 | M | 设计推断 |
