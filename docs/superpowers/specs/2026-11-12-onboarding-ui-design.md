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
| DesktopUpsellStartup | 桌面端升级推荐，支持“现在不”“不再询问”或跳转 | `src/components/DesktopUpsell/` |
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
| 桌面端推荐状态 | `globalConfig.desktopUpsellSeenCount` / `desktopUpsellDismissed` | 用户全局 | 最多显示 3 次，支持“不再询问” |

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
| 首次引导流程多步骤 | `src/components/Onboarding.tsx` | `issueOnboarding.test.ts` | 仅验证幂等性，未验证所有步骤 |
| TrustDialog 信任区分 home 目录 | `src/components/TrustDialog/` | 需要查找相关测试 | 未覆盖所有检测项组合 |
| ManagedSettingsSecurityDialog 仅展示名称 | `src/components/ManagedSettingsSecurityDialog/`、`src/utils/config.ts` 相关逻辑 | 需要查找相关测试 | 未覆盖所有危险设置组合 |
| Wizard Provider 支持非线性导航 | `src/components/wizard/` | 需要查找相关测试 | 未覆盖复杂分支跳转场景 |
| DesktopUpsellStartup 推荐逻辑 | `src/components/DesktopUpsell/` | 需要查找相关测试 | 未覆盖推荐展示次数上限 |
| LspRecommendationMenu 自动消失 | `src/components/LspRecommendation/` | 需要查找相关测试 | 未覆盖 30 秒计时准确性 |
| ClaudeCodeHint 标签检测 | `src/utils/claudeCodeHints.ts` | 需要查找相关测试 | 未覆盖所有标签格式 |
| Project Onboarding 最多显示 4 次 | `src/projectOnboardingState.ts` | 需要查找相关测试 | 未覆盖计数重置场景 |

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
|-------|---------------|---------|---------|--------|-------|-------|
| P1 | 当前 Onboarding 流程测试仅验证幂等性，未验证所有步骤 | 添加完整的 Onboarding 流程测试，覆盖所有步骤组合 | 低（仅新增测试） | 测试覆盖 Preflight、Theme、API Key Approval、OAuth Flow、Security Notes、Terminal Setup | L | 已证实 |
| P1 | 当前 TrustDialog 测试不足 | 添加 TrustDialog 测试，覆盖非 home/home 目录、所有检测项组合 | 低（仅新增测试） | 测试覆盖信任状态持久化策略 | M | 已证实 |
| P2 | 当前项目引导提示无测试 | 添加项目引导提示测试，覆盖最多显示 4 次后隐藏 | 低（仅新增测试） | 测试计数逻辑 | S | 设计推断 |
| P2 | 当前 Wizard Provider 导航无测试 | 添加 Wizard Provider 非线性导航测试 | 低（仅新增测试） | 测试 goToStep、goNext、goBack、cancel、navigationHistory | M | 设计推断 |
| P3 | 当前桌面端推荐与 LSP 插件推荐无测试 | 添加推荐展示次数上限测试、禁用逻辑测试 | 低（仅新增测试） | 测试推荐展示与禁用 | M | 设计推断 |
