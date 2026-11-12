---
id: onboarding-ui
batch: 4
title: "Onboarding UI: 首次引导、信任与设置确认设计"
date: 2026-11-12
status: draft
---

# Onboarding UI 设计文档

## 1. Overview

### 1.1 Goals
Onboarding UI 系统负责：
- 新用户首次启动时的配置引导（主题选择、认证方式、安全须知）
- 进入工作区前的信任确认与权限风险检查
- 托管设置（Managed Settings）的安全审批
- 项目级引导提示与状态持久化
- 相关推荐/升级提示（桌面端、LSP 插件等）

### 1.2 Non-goals
- 不定义权限裁决（permission rules）的具体算法
- 不包含 settings schema 的完整定义
- 不处理 MCP 服务器的逐个审批逻辑（见 `handleMcpjsonServerApprovals`）

---

## 2. Architecture & Data Flow

### 2.1 启动流程总览
```
启动 → showSetupScreens → [Onboarding → TrustDialog → ManagedSettingsSecurityDialog] → REPL
```

关键入口：
- `src/interactiveHelpers.tsx` 的 `showSetupScreens` 控制流
- `src/bootstrap/state.ts` 会话级状态
- `src/utils/config.ts` 全局/项目级持久化

### 2.2 数据持久化层次
| 状态 | 存储位置 | 范围 | 说明 |
|------|---------|------|------|
| 首次引导完成 | `globalConfig.hasCompletedOnboarding` | 用户全局 | 不重复引导 |
| 工作区信任（非 home） | `projectConfig.hasTrustDialogAccepted` | 当前目录 | 永久信任 |
| 工作区信任（home） | `sessionTrustAccepted` | 内存/会话 | 仅本次会话 |
| 项目引导可见次数 | `projectConfig.projectOnboardingSeenCount` | 当前目录 | 最多显示 4 次 |
| 桌面端推荐状态 | `globalConfig.desktopUpsellSeenCount` / `desktopUpsellDismissed` | 用户全局 | 最多显示 3 次，支持“不再询问” |

---

## 3. Components & State

### 3.1 核心组件

#### WizardProvider (`src/components/wizard/`)
通用向导框架，基于 React Context。
- 提供 `useWizard` hook：`currentStepIndex`、`wizardData`、`goNext`/`goBack`/`goToStep`、`cancel`
- 支持非线性导航历史与 `onComplete`/`onCancel` 回调
- 内置 `useExitOnCtrlCDWithKeybindings`

#### Onboarding (`src/components/Onboarding.tsx`)
首次启动引导多步流程：
- Preflight（仅 OAuth 启用时）
- Theme（主题选择）
- API Key Approval（环境变量检测时）
- OAuth Flow（仅 OAuth 启用且未跳过）
- Security Notes（安全须知）
- Terminal Setup（可选，仅在支持的终端）
- 状态仅内存中流转，完成后调用 `completeOnboarding()`

#### TrustDialog (`src/components/TrustDialog/`)
工作区安全检查与信任确认：
- 检查项包括：project-level MCP 服务器、hooks、bash 权限、apiKeyHelper、aws/gcp 命令、otelHeadersHelper、危险环境变量
- home 目录仅会话级信任（不持久化）
- 信任后不自动批准 MCP 服务器（保留后续单独审批）

#### ManagedSettingsSecurityDialog (`src/components/ManagedSettingsSecurityDialog/`)
托管设置审批（来自组织配置）：
- 检查 `DANGEROUS_SHELL_SETTINGS`、非 `SAFE_ENV_VARS` 环境变量、hooks
- 仅展示设置名称，不展示值
- `hasDangerousSettingsChanged` 检测变更以决定是否重新提示

### 3.2 辅助组件

#### DesktopUpsellStartup (`src/components/DesktopUpsell/`)
桌面端升级推荐，支持“现在不”、“不再询问”或跳转 DesktopHandoff。

#### LspRecommendationMenu (`src/components/LspRecommendation/`)
LSP 插件推荐，30 秒自动消失，支持按插件/全局禁用。

#### ClaudeCodeHint (`src/components/ClaudeCodeHint/`)
提示协议：`<claude-code-hint>` 标签检测（见 `src/utils/claudeCodeHints.ts`）。

#### Project Onboarding (`src/projectOnboardingState.ts`)
项目级引导：检查 CLAUDE.md 和空目录，提示创建步骤，最多可见 4 次。

---

## 4. User Interaction Flow

### 4.1 首次启动完整流程
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

### 4.2 关键键绑定
- `confirm:yes`（默认 Enter）→ 确认
- `confirm:no`（默认 Esc）→ 取消/退出
- `Ctrl+C`/`Ctrl+D` → 退出流程

---

## 5. Error Handling & Degradation

### 5.1 降级策略
- 若检测项读取失败 → 保守处理（不视为通过）
- 若向导步骤渲染异常 → 依赖上层 ErrorBoundary（`SentryErrorBoundary`）
- Terminal Setup 失败 → 吞掉错误继续流程

### 5.2 边界情况
- Home 目录信任：仅会话级（不持久化到磁盘）
- 重复调用 onDone：幂等处理（`issueOnboarding.test.ts` 验证）
- StrictMode：useEffect 中更新计数增加 guard
- Auto-dismiss：LspRecommendationMenu 30 秒自动选择“不”

---

## 6. Design Decisions

### 6.1 信任状态按目录与 home 区分持久化
| 备选方案 | 代价 | 证据 |
|---------|------|------|
| 统一持久化到磁盘 | home 目录误操作风险高 | `TrustDialog.tsx` L141-145 |
| 完全不持久化 | 体验差，每次需确认 | 现状为折中 |

**决策**：非 home 目录持久化到 projectConfig；home 目录仅 sessionTrustAccepted 内存状态。

### 6.2 TrustDialog 不自动批准 MCP 服务器
| 备选方案 | 代价 | 证据 |
|---------|------|------|
| 信任时一并批准 | 用户失去细粒度控制权 | `TrustDialog.tsx` L153-156 注释 |

**决策**：MCP 服务器单独在 `handleMcpjsonServerApprovals` 中处理，TrustDialog 不写入 enableAllProjectMcpServers 等。

### 6.3 ManagedSettingsSecurityDialog 仅展示名称不展示值
| 备选方案 | 代价 | 证据 |
|---------|------|------|
| 展示完整值 | 敏感信息泄露风险 | `utils.ts` L123-144 |

**决策**：只列出设置键名（如 `apiKeyHelper`、环境变量名、`hooks`），不打印值。

### 6.4 项目引导最多显示 4 次后自动隐藏
| 备选方案 | 代价 | 证据 |
|---------|------|------|
| 永久显示 | 打扰用户 | `projectOnboardingState.ts` L68-70 |
| 仅一次 | 用户可能错过 | 现状为 4 次 |

**决策**：`projectOnboardingSeenCount >= 4` 则不再显示。

### 6.5 WizardProvider 支持非线性导航与历史
| 备选方案 | 代价 | 证据 |
|---------|------|------|
| 仅线性前后 | 无法支持分支跳转 | `WizardProvider.tsx` L28, L44, L56-61 |

**决策**：维护 `navigationHistory`，支持 `goToStep`。

---

## 7. Security Considerations

- 危险环境变量：仅 `SAFE_ENV_VARS`（见 `managedEnvConstants.ts`）内的变量不经审批
- 托管设置变更检测：`hasDangerousSettingsChanged` 深度对比
- Home 目录特殊处理：避免全局持久化后的扩大风险面
- 所有信任/审批操作记录 `tengu_trust_dialog_shown`/`tengu_trust_dialog_accept` 等事件

---

## 8. Coverage

见 [Coverage](../../architecture/coverage/onboarding-ui.yaml)。

---

## 9. Open Questions

- 是否需要按组织/租户配置不同的托管设置审批策略？（当前无）
- 项目引导步骤是否可扩展为插件化？（当前硬编码 workspace/claudemd）

