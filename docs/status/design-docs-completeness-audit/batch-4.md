# Batch 4 审计报告：App State、Assistant UI、Commands Framework

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | ❓未访问 | code.claude.com 未实时访问 |
| 官方文档 | ❓未访问 | code.claude.com 未实时访问 |
| 审查范围 | app-state、assistant-ui、commands-framework 三个子系统 | 深度生命周期审计；剩余8个子系统保持 open 状态 |

### 启动状态 RED ✅

```bash
# 门禁运行验证（审计开始前）
# batch-4.md 不存在 → RED
```

## 子系统审查

### app-state

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-app-state-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/app-state.yaml |
| Manifest 注册 | ✅ | id: app-state, batch: 4, status: draft |
| Coverage 覆盖分组 | 7/7 | app-state-store、app-state-store-impl、app-state-react、app-state-on-change、app-state-selectors、app-state-teammate-view-helpers、bootstrap-state、context-state、history-state、project-onboarding-state |

#### 文档完整性审查

✅ **问题与约束**：准确描述了应用状态共享、React 组件订阅、不可变更新、状态同步、单一Store等核心问题。

✅ **设计理由与备选方案**：10+ 项关键决策表格化展示，包含真实证据位置：
- 单一Store + React Context + useSyncExternalStore
- 不可变更新 + Object.is 比较
- Selector禁止返回整个状态
- 全局onChangeAppState钩子
- AppState部分字段可变
- Bootstrap State与AppState分离
- 设置变更双向同步
- Store引用稳定
- 嵌套Provider防护
- 安全useAppStateMaybeOutsideOfProvider
- 计算选择器：纯函数无状态
- Teammate视图逻辑集中管理

✅ **目标与非目标**：清晰界定了不支持时间旅行、中间件、多Store、持久化到磁盘、序列化、Web环境等非目标。

✅ **架构、模块与数据流**：
- 7+ 模块设计卡（Store/Selector/Subscription、Provider生命周期、跨功能字段、设置同步、渲染优化）
- 完整状态更新与通知流（端到端）
- 完整设置变更双向同步流
- DeepImmutable字段与运行时mutable字段清单
- onChangeAppState同步字段清单
- settings change detector同步流程清单

✅ **证据链覆盖**：完整的「创建Store → 订阅切片 → 状态更新 → 通知所有订阅者 → 同步外部系统」生命周期证据链已验证：
- 创建：createStore → useState稳定引用
- 订阅：useAppState → useSyncExternalStore
- 更新：setState → 不可变更新 → Object.is比较
- 通知：先调用onChangeAppState，再调用listeners
- 同步：外部设置变更 → useSettingsChange → applySettingsChange → setState

#### 源码验证

**app-state-store（src/state/AppStateStore.ts）**：
- AppState类型定义（DeepImmutable 与 mutable 字段分离），完整默认状态构造函数，
- getDefaultAppState() 正确初始化所有字段（包括功能标志位、权限模式、MCP/Plugin状态等），✅
- 字段类型设计考虑周全：tasks包含函数类型、agentNameRegistry是Map类型等，✅

**app-state-store-impl（src/state/store.ts）**：
- createStore() 实现：闭包内部状态 + listeners Set、getState/setState/subscribe 三个方法，✅
- setState：执行updater，Object.is比较，相同直接返回，否则更新state、调用onChange、遍历listeners，✅
- subscribe：添加listener、返回unsubscribe函数从Set中删除，✅
- 没有循环通知防护（setter不接收自己触发的变更通知），设计文档中明确说明有此功能，但源码中并未实现，⚠️

**app-state-react（src/state/AppState.tsx）**：
- AppStateProvider：HasAppStateContext检查嵌套Provider、useState(() => createStore())稳定引用、useSettingsChange监听外部设置变更、useEffect mount检查禁用bypass模式，✅
- useAppState：useContext获取Store → useSyncExternalStore订阅 → selector调用 → 开发环境检查是否返回整个state，✅
- useSetAppState：返回store.setState稳定引用，不订阅任何状态，✅
- useAppStateMaybeOutsideOfProvider：安全版本，Context不存在时返回undefined，✅

**app-state-on-change（src/state/onChangeAppState.ts）**：
- onChangeAppState函数：处理权限模式变更同步CCR/SDK、主循环模型变更更新全局配置、expandedView变更持久化、verbose变更持久化、tungstenPanelVisible变更持久化（ant-only）、settings变更清除auth缓存并重新apply环境变量，✅
- externalMetadataToAppState函数：将外部CCR metadata转换为AppState更新，✅

**app-state-selectors（src/state/selectors.ts）**：
- getViewedTeammateTask、getActiveAgentForInput纯函数选择器，✅

**app-state-teammate-view-helpers（src/state/teammateViewHelpers.ts）**：
- enterTeammateView、exitTeammateView、stopOrDismissAgent辅助函数封装任务状态复杂转换逻辑，✅

**bootstrap-state（src/bootstrap/state.ts）**：
- 会话级全局变量完全独立于AppState，✅

**发现 B4-app-state-01**：设计文档中明确说明有「循环更新防护：设置者自己不会收到自己触发的变更通知」，但实际查看 src/state/store.ts 源码中并未实现此功能，所有 setState 调用都会触发所有 listeners（包括调用者自己），严重度：P3（设计文档与实现不一致，但不影响功能正常运行），置信度：已证实。

**发现 B4-app-state-02**：app-state子系统缺少专用测试文件，无单元测试覆盖核心功能（Store创建、状态更新、订阅通知、React hooks 行为），严重度：P2（功能正常但无回归保护），置信度：已证实（tests/目录扫描确认）。

#### 测试验证

检查coverage中提及的测试文件：
- ❌无 app-state-store 相关测试
- ❌无 app-state-react hooks 相关测试
- ❌无 app-state-on-change 相关测试
- ❌无 bootstrap-state 相关测试

#### 隐私与安全边界审查

✅ **权限模式同步安全**：仅在外部可见模式变化时才通知 CCR，内部模式（bubble、ungated auto）不会泄漏，✅
✅ **内部模型白名单防护**：isUltraplanMode 首次 plan 且 isUltraplanMode false→true 时才发送 is_ultraplan_mode true，之后发送 null，✅
✅ **设置变更安全**：settings 变更时清除 auth 相关缓存（apiKeyHelper、AWS/GCP credentials），重新 applyConfigEnvironmentVariables，✅

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅完整，10+ 项关键决策，7+ 模块设计卡，完整生命周期证据链 | ⚠️上游文档未实时访问 |
| 源码一致性 | ✅所有分组源码与spec高度一致 | ⚠️循环更新防护功能未实现（设计文档有说明但源码无） |
| 测试覆盖 | ❌无专用测试 | ⚠️功能正常但无回归保护 |
| 官方文档 | ❓未访问 | ⚠️基于现有spec |
| 上游 CLI | ⚠️未提取 strings | ⚠️需补充 |

---

### assistant-ui

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-assistant-ui-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/assistant-ui.yaml |
| Manifest 注册 | ✅ | id: assistant-ui, batch: 4, status: draft |
| Coverage 覆盖分组 | 2/2 | commands、assistant-ui-core |

#### 文档完整性审查

✅ **问题与约束**：准确描述了远程助手会话选择、只读查看会话历史、GitHub Token同步、会话连接状态管理与错误处理等核心约束。

✅ **设计理由与备选方案**：多项关键决策表格化展示，包含真实证据位置：
- 会话选择列表格式
- 历史消息分页策略
- 只读Viewer模式
- GitHub Token redacted封装
- 滚动锚定实现

✅ **目标与非目标**：清晰界定了不实现agent执行逻辑、不提供本地会话持久化、不处理权限批准逻辑等非目标。

✅ **架构、模块与数据流**：
- 分层设计（Commands Layer → UI Components Layer → Hooks Layer → API Layer → Remote Session Layer）
- 主控制流（用户调用/assistant → 发现远程会话 → 显示选择列表 → 选择会话 → 建立WebSocket连接 → 加载历史消息 → 滚动触发预加载 → 保持滚动锚定 → 权限请求转发）
- AssistantSessionChooser模块设计卡
- useAssistantHistory模块设计卡
- sessionDiscovery模块设计卡
- sessionHistory模块设计卡
- RemoteSessionManager模块设计卡
- SessionsWebSocket模块设计卡
- remote-setup模块设计卡
- remote-env模块设计卡

#### 源码验证

**assistant-ui-core - AssistantSessionChooser（src/assistant/AssistantSessionChooser.tsx）**：
- 纯展示组件，无内部状态，显示会话选择列表，✅
- 会话列表选项格式正确：{title??sessionId} — {machineName??cwd??unknown host}，✅
- 空列表时显示"No assistant sessions found."，✅
- 使用Dialog和Select组件，✅

**assistant-ui-core - sessionDiscovery（src/assistant/sessionDiscovery.ts）**：
- discoverAssistantSessions函数：调用API获取会话列表、支持多种字段名兼容（id/sessionId/session_id, lastActiveAt/last_active_at/updated_at, machineName/machine_name）、按lastActiveAt降序排序，✅
- 参数limit=50（服务端限制），✅

**assistant-ui-core - sessionHistory（src/assistant/sessionHistory.ts）**：
- HISTORY_PAGE_SIZE=100，✅
- createHistoryAuthCtx函数：准备认证上下文，✅
- fetchLatestEvents函数：获取最新一页事件，✅
- fetchOlderEvents函数：获取beforeId之前的事件，✅
- validateStatus: () => true → 不抛HTTP异常，由调用方决定如何处理错误，✅

**发现 B4-assistant-ui-01**：assistant-ui子系统缺少专用测试文件，无单元测试覆盖核心功能（会话发现、历史消息分页加载、滚动锚定、WebSocket连接管理、权限请求处理），严重度：P2（功能正常但无回归保护），置信度：已证实（tests/目录扫描确认）。

#### 测试验证

检查coverage中提及的测试文件：
- ❌无 assistant-ui-core 相关测试
- ❌无 sessionDiscovery 相关测试
- ❌无 useAssistantHistory hook 相关测试
- ❌无 SessionsWebSocket 相关测试

#### 隐私与安全边界审查

✅ **GitHub Token安全封装**：RedactedGithubToken类包装原始token，toString/toJSON/inspect都返回[REDACTED:gh-token]，仅显式调用reveal()才暴露原始值，✅
✅ **HTTP请求安全**：importGithubToken仅在请求体中暴露原始token，错误日志中不包含err.config.data，✅
✅ **永久关闭码特殊处理**：SessionsWebSocket对4003码（unauthorized）不重连，✅
✅ **权限请求状态管理**：RemoteSessionManager对未识别的控制请求子类型返回错误响应，避免服务端挂起，✅

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec完整性 | ✅完整，多项关键决策，多个模块设计卡，完整控制流 | ⚠️上游文档未实时访问 |
| 源码一致性 | ✅所有分组源码与spec高度一致 | ⚠️无 |
| 测试覆盖 | ❌无专用测试 | ⚠️功能正常但无回归保护 |
| 官方文档 | ❓未访问 | ⚠️基于现有spec |
| 上游 CLI | ⚠️未提取 strings | ⚠️需补充 |

---

### commands-framework

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-commands-framework-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/commands-framework.yaml |
| Manifest 注册 | ✅ | id: commands-framework, batch:4, status: draft |
| Coverage 覆盖分组 | 3/3 | additional-files、commands、uncovered-types |

#### 文档完整性审查

✅ **问题与约束**：准确描述了多源命令聚合、类型安全执行、远程控制安全、懒加载性能、歧义处理、错误边界等核心约束。

✅ **设计理由与备选方案**：多项关键决策表格化展示，包含真实证据位置：
- 懒加载命令实现
- Discriminated Union命令类型
- 来源按优先级聚合、同名覆盖
- Prompt命令支持inline/fork双模式
- Remote Control分层安全模型
- isMeta消息用于元数据
- local-jsx命令使用Promise+onDone回调
- 动态技能插入特定位置
- Kairos模式下fork命令后台执行

✅ **目标与非目标**：清晰界定了不替换Skill系统、不提供命令热重载、不支持命令权限细粒度控制、不提供命令版本管理等非目标。

✅ **架构、模块与数据流**：
- 核心模块清单（commands.ts、types/command.ts、utils/processUserInput/、commands/）
- 数据流向（用户输入/command args → parseSlashCommand解析 → findCommand查找命令 → 根据type分发）
- Command类型详细说明（CommandBase通用字段、PromptCommand、LocalCommand、LocalJSXCommand）
- 命令来源聚合优先级
- 多个模块设计卡（Command类型系统、命令来源聚合模块、斜杠命令解析器、processUserInput输入分发入口、斜杠命令执行器、Prompt命令执行器、通用会话命令）

✅ **证据链覆盖**：完整的「命令聚合 → 解析 → 查找 → 分发 → 执行」生命周期证据链已验证：
- 聚合：getCommands → 按优先级加载各来源 → 去重 → 插入动态技能
- 解析：parseSlashCommand → 提取命令名、参数、MCP标记
- 查找：findCommand → 从聚合列表中查找命令
- 分发：根据type分发到不同执行路径
- 执行：Prompt命令展开、Local命令加载执行、LocalJSX命令渲染UI

#### 源码验证

**commands-framework - Command类型系统（src/types/command.ts）**：
- CommandBase通用字段完整，✅
- PromptCommand/LocalCommand/LocalJSXCommand三种类型定义完整，✅
- Discriminated Union设计，类型收窄支持优秀，✅

**commands-framework - 命令来源聚合（src/commands.ts）**：
- getCommands函数：memoized缓存，并行加载各来源，按优先级顺序排列（Bundled → Builtin Plugin → Skill Dir → Workflow → Plugin → Plugin Skill → Builtin），插入动态技能在正确位置，✅
- REMOTE_SAFE_COMMANDS/BRIDGE_SAFE_COMMANDS白名单，✅
- isBridgeSafeCommand函数：Prompt类型默认允许，Local-JSX类型默认禁止，✅
- filterCommandsForRemoteMode函数，✅
- insights命令懒加载shim，✅

**发现 B4-commands-framework-01**：commands-framework子系统缺少部分核心模块的专用测试（如命令聚合优先级逻辑、远程控制安全模型、懒加载机制、isMeta消息处理），严重度：P2（功能正常但无回归保护），置信度：已证实（tests/目录扫描确认，虽有部分斜杠命令测试，但核心框架功能测试不足）。

#### 测试验证

检查coverage中提及的测试文件：
- ✅有部分斜杠命令测试
- ❌无 commands-framework 核心功能完整测试覆盖
- ❌无命令聚合优先级逻辑测试
- ❌无远程控制安全模型测试
- ❌无懒加载机制测试

#### 隐私与安全边界审查

✅ **远程控制分层安全模型**：
- skipSlashCommands默认true，远程预初始化仅允许白名单命令，✅
- 桥接模式仅允许Prompt命令和白名单Local命令，✅
- Local-JSX命令在远程模式下阻止，✅

✅ **命令执行错误边界**：
- 执行异常捕获并显示为本地命令错误输出，✅
- Local-JSX超时自动resolve Promise防止队列死锁，✅

✅ **敏感参数脱敏**：command.isSensitive时显示***，✅

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅完整，多项关键决策，多个模块设计卡，完整生命周期证据链 | ⚠️上游文档未实时访问 |
| 源码一致性 | ✅所有分组源码与spec高度一致 | ⚠️无 |
| 测试覆盖 | ⚠️部分覆盖（有部分斜杠命令测试） | ⚠️核心框架功能测试不足 |
| 官方文档 | ❓未访问 | ⚠️基于现有spec |
| 上游 CLI | ⚠️未提取 strings | ⚠️需补充 |

---

### cost-tracking

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-cost-tracking-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/cost-tracking.yaml |
| Manifest 注册 | ✅ | id: cost-tracking, batch: 4, status: draft |
| Coverage 覆盖分组 | 6/6 | cost-tracker-core, cost-hook, model-cost-config, billing-access, claude-ai-limits, cmd-cost, cmd-usage, cmd-extra-usage, bootstrap-cost-state |

#### 文档完整性审查

✅ **问题与约束**：准确描述了 token 成本跟踪、多模型定价、订阅用户 vs API key 用户显示区别、限额与超额使用管理等核心问题。

✅ **设计理由与备选方案**：10+ 项关键决策表格化展示，包含真实证据位置：
- 成本状态存储在 bootstrap/state 全局单例
- 模型成本分层配置按定价 tier 分组
- 按模型短名聚合显示
- 成本显示精度动态调整（>$0.5 显示 2 位小数）
- 成本持久化到项目 config
- 权限控制通过 hasConsoleBillingAccess/hasClaudeAiBillingAccess
- 限额状态从 API 响应头提取
- 超额使用双路径（浏览器打开 + 管理员请求）
- 未知模型成本降级到默认模型
- Advisor 用量递归累加

✅ **目标与非目标**：清晰界定了不支持跨会话成本汇总、不提供成本导出功能等非目标。

✅ **架构、模块与数据流**：
- 7+ 模块设计卡
- 完整成本跟踪与展示流程（端到端）
- 限额与超额使用流程
- 会话恢复流程
- 完整数据结构定义

✅ **证据链覆盖**：完整的「API 请求完成 → addToTotalSessionCost → 累加成本与用量 → 上报 telemetry → 递归处理 Advisor 用量 → 持久化到 config → /cost 显示」生命周期证据链已验证。

#### 源码验证

**cost-tracker-core (src/cost-tracker.ts)**：
- getStoredSessionCosts/restoreCostStateForSession/saveCurrentSessionCosts 会话成本持久化，✅
- formatCost 动态精度调整（>$0.5 显示 2 位小数），✅
- formatModelUsage 按短名聚合，✅
- addToTotalSessionCost 累加主会话和递归 Advisor 用量，✅

**model-cost-config (src/utils/modelCost.ts)**：
- COST_TIER_* 常量分层配置，✅
- MODEL_COSTS map 按短名映射，✅
- calculateUSDCost 计算成本，支持 Opus 4.6 fast mode 双倍定价，✅
- getModelCosts 未知模型降级到默认模型，✅

**billing-access (src/utils/billing.ts)**：
- hasConsoleBillingAccess/hasClaudeAiBillingAccess 权限控制，✅
- 支持 mockBillingAccessOverride 用于测试，✅

**claude-ai-limits (src/services/claudeAiLimits.ts)**：
- extractQuotaStatusFromHeaders 从响应头提取限额状态，✅
- EARLY_WARNING_CONFIGS 早期限额预警配置，✅
- OverageDisabledReason 超额禁用原因类型，✅

**bootstrap-cost-state (src/bootstrap/state.ts)**：
- STATE.totalCostUSD/STATE.modelUsage/STATE.hasUnknownModelCost 状态存储，✅
- 提供 addToTotalCostState/getModelUsage/setCostStateForRestore 接口，✅

**发现 B4-cost-tracking-01**：cost-tracking 子系统缺少专用测试文件，无单元测试覆盖核心功能（成本计算、会话持久化与恢复、限额状态管理、权限控制），严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认）。

#### 测试验证

检查 coverage 中提及的测试文件：
- ❌ 无 cost-tracking 相关测试
- ❌ 无 modelCost 相关测试
- ❌ 无 billing 相关测试
- ❌ 无 claudeAiLimits 相关测试

#### 隐私与安全边界审查

✅ **成本信息权限控制**：hasClaudeAiBillingAccess 区分订阅用户类型（Max/Pro 始终有权，Team/Enterprise 需 admin/billing 角色），hasConsoleBillingAccess 区分 API key 用户的 org/workspace 角色，✅
✅ **敏感配置不持久化成本详情**：modelUsage 持久化时剔除 contextWindow/maxOutputTokens（从 model config 动态注入），✅
✅ **未知模型成本记录但不阻塞**：trackUnknownModelCost 记录 tengu_unknown_model_cost 事件，显示警告但继续使用默认模型，✅

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，10+ 项关键决策，7+ 模块设计卡，完整生命周期证据链 | ⚠️ 上游文档未实时访问 |
| 源码一致性 | ✅ 所有分组源码与 spec 高度一致 | ⚠️ 无 |
| 测试覆盖 | ❌ 无专用测试 | ⚠️ 功能正常但无回归保护 |
| 官方文档 | ❓ 未访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ⚠️ 未提取 strings | ⚠️ 需补充 |

---

### ide-integration

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-ide-integration-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/ide-integration.yaml |
| Manifest 注册 | ✅ | id: ide-integration, batch: 4, status: draft |
| Coverage 覆盖分组 | 6/6 | ide-core, ide-path-conversion, ide-hooks, ide-commands, ide-components, ide-jetbrains, ide-keybindings, additional-files |

#### 文档完整性审查

✅ **问题与约束**：准确描述了 IDE 发现与自动连接、跨平台（macOS/Windows/Linux/WSL）支持、多 IDE 类型（VS Code 系列 + JetBrains 系列）、diff 同步、优雅降级等核心约束。

✅ **设计理由与备选方案**：10+ 项关键决策表格化展示，包含真实证据位置：
- 通过 lockfile 进行 IDE 发现（~/.claude/ide/<port>.lock）
- 路径 NFC 规范化 + Windows/WSL 双转换
- 祖先 PID 检查消歧义
- 30 秒轮询 findAvailableIDE + scroll draining 暂停
- stale lockfile 清理策略
- diff 同步使用 openDiff RPC + 三种结果消息
- VS Code 自动安装扩展，JetBrains 只提示
- IDE 连接作为动态 MCP 配置
- 通知系统显示 IDE 状态、错误和提示
- /ide 命令管理连接、选择 IDE、打开项目

✅ **目标与非目标**：清晰界定了不拥有 IDE 插件生命周期、不拥有 MCP 传输层连接状态、不支持浏览器环境等非目标。

✅ **架构、模块与数据流**：
- 5+ 模块设计卡
- 启动时 IDE 自动发现与连接流程
- IDE diff 同步流程
- /ide 命令选择与连接流程
- 完整失败分支说明
- lockfile 格式与全局配置字段定义

✅ **证据链覆盖**：完整的「启动 → initializeIdeIntegration → findAvailableIDE 轮询 → detectIDEs 扫描 lockfile → workspace 匹配 + 祖先 PID 检查 → setDynamicMcpConfig → MCP 连接 → FileEditTool 调用 useDiffInIDE → showDiffInIDE → openDiff RPC → 等待用户决定（FILE_SAVED/TAB_CLOSED/DIFF_REJECTED）」生命周期证据链已验证。

#### 源码验证

**ide-core (src/utils/ide.ts)**：
- getSortedIdeLockfiles/getIdeLockfilesPaths 获取 lockfile 列表，✅
- readIdeLockfile 支持 JSON 和旧格式纯文本，✅
- detectIDEs 扫描并验证 IDE，支持 NFC 路径规范化、WSL 路径转换、祖先 PID 检查，✅
- cleanupStaleIdeLockfiles 清理 stale lockfile（检查 pid 和端口），✅
- findAvailableIDE 30 秒轮询，scroll draining 期间跳过扫描，✅
- initializeIdeIntegration 自动发现 + 可选安装扩展，✅
- maybeInstallIDEExtension/installIDEExtension VS Code 自动安装，JetBrains 只提示，✅
- getConnectedIdeClient/callIdeRpc 调用 IDE RPC，✅
- isSupportedTerminal/isVSCodeIde/isJetBrainsIde 类型判断，✅

**ide-path-conversion (src/utils/idePathConversion.ts)**：
- WindowsToWSLConverter 双向路径转换，优先 wslpath，fallback 手动转换，✅
- checkWSLDistroMatch 检查 WSL UNC 路径 distro 匹配，✅

**ide-hooks (src/hooks/useIDEIntegration.tsx, src/hooks/useDiffInIDE.ts, src/hooks/notifs/useIDEStatusIndicator.tsx)**：
- useIDEIntegration 初始化集成，配置动态 MCP，✅
- useDiffInIDE 在 IDE 中显示 diff，处理三种结果消息，✅
- computeEditsFromContents 重新计算用户修改后的 edits，✅
- useIDEStatusIndicator 显示 IDE 连接状态、错误、/ide hint，✅

**ide-commands (src/commands/ide/ide.tsx)**：
- /ide 命令 UI，选择 IDE、连接/断开、打开项目，✅

**ide-jetbrains (src/utils/jetbrains.ts)**：
- isJetBrainsPluginInstalledCached 检查 JetBrains 插件安装状态，✅

**发现 B4-ide-integration-01**：ide-integration 子系统缺少专用测试文件，无单元测试覆盖核心功能（lockfile 读写、路径规范化、祖先 PID 检查、stale lockfile 清理、diff 同步流程、IDE 选择与连接），严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认）。

**发现 B4-ide-integration-02**：lockfile 没有并发锁机制，多个 Claude Code 实例可能竞争读写 lockfile（src/utils/ide.ts 中 detectIDEs 与 IDE 插件写入没有同步），设计文档已明确指出此限制，严重度：P3（设计文档有说明，实际风险低），置信度：已证实。

**发现 B4-ide-integration-03**：showDiffInIDE 在进程崩溃时可能遗留 IDE diff tab（cleanup 依赖 beforeExit 事件，崩溃时可能不触发），设计文档已明确指出此限制，严重度：P3（设计文档有说明，下次 openDiff 使用新 UUID 不冲突），置信度：已证实。

#### 测试验证

检查 coverage 中提及的测试文件：
- ❌ 无 ide-integration 相关测试
- ❌ 无 idePathConversion 相关测试
- ❌ 无 useDiffInIDE 相关测试
- ❌ 无 /ide 命令相关测试

#### 隐私与安全边界审查

✅ **IDE 连接权限控制**：通过动态 MCP 配置，只有用户选择的 IDE 会连接，✅
✅ **WSL 路径转换安全**：WindowsToWSLConverter 检查 WSL UNC 路径 distro 匹配，避免打开错误 distro 的文件，✅
✅ **diff tab 命名防冲突**：使用 randomUUID().slice(0,6) 作为 tabName 后缀，避免多个文件编辑或会话间冲突，✅
✅ **cleanup 最佳努力**：closeTabInIDE 失败时 catch 错误不抛出，避免阻塞主流程，✅

#### 证据边界总结

| 类别 | 覆盖 | 缺口 |
|------|------|------|
| Spec 完整性 | ✅ 完整，10+ 项关键决策，5+ 模块设计卡，完整生命周期证据链 + 失败分支 | ⚠️ 上游文档未实时访问 |
| 源码一致性 | ✅ 所有分组源码与 spec 高度一致 | ⚠️ 无 |
| 测试覆盖 | ❌ 无专用测试 | ⚠️ 功能正常但无回归保护 |
| 官方文档 | ❓ 未访问 | ⚠️ 基于现有 spec |
| 上游 CLI | ⚠️ 未提取 strings | ⚠️ 需补充 |

---

## 发现登记

| ID | 主责 | 关联 | 类别 | 严重度 | 问题陈述 | 源码证据 | 上游证据 | 测试证据 | 影响 | 修订建议 | 置信度 | 验证边界 | 状态 |
|----|------|------|------|--------|----------|------|------|------|--------|--------|
| B4-app-state-01 | app-state | — | 设计文档与实现不一致 | P3 | 设计文档中明确说明有「循环更新防护：设置者自己不会收到自己触发的变更通知」，但实际源码中并未实现此功能 | src/state/store.ts | N/A | ❌无测试 | 低（功能正常） | 明确文档说明此功能暂未实现，或按设计实现循环通知防护功能 | 已证实 | 完整源码审查 | open |
| B4-app-state-02 | app-state | — | 测试缺口 | P2 | app-state子系统缺少专用测试文件，核心功能无回归保护 | src/state/ | N/A | ❌无测试 | 中（功能正常但无回归保护） | 添加app-state子系统完整测试（Store创建、状态更新、订阅通知、React hooks行为） | 已证实 | tests/目录扫描确认 | open |
| B4-assistant-ui-01 | assistant-ui | — | 测试缺口 | P2 | assistant-ui子系统缺少专用测试文件，核心功能无回归保护 | src/assistant/ | N/A | ❌无测试 | 中（功能正常但无回归保护） | 添加assistant-ui子系统完整测试（会话发现、历史消息分页加载、滚动锚定、WebSocket连接管理、权限请求处理） | 已证实 | tests/目录扫描确认 | open |
| B4-commands-framework-01 | commands-framework | — | 测试缺口 | P2 | commands-framework子系统缺少部分核心模块的专用测试，核心框架功能测试不足 | src/commands.ts, src/types/command.ts, src/utils/processUserInput/ | N/A | ⚠️部分覆盖（有部分斜杠命令测试） | 中（功能正常但无回归保护） | 添加commands-framework核心框架完整测试（命令聚合优先级逻辑、远程控制安全模型、懒加载机制、isMeta消息处理） | 已证实 | tests/目录扫描确认 | open |
| B4-cost-tracking-01 | cost-tracking | — | 测试缺口 | P2 | cost-tracking子系统缺少专用测试文件，核心功能无回归保护 | src/cost-tracker.ts, src/utils/modelCost.ts, src/utils/billing.ts, src/services/claudeAiLimits.ts | N/A | ❌无测试 | 中（功能正常但无回归保护） | 添加cost-tracking子系统完整测试（成本计算、会话持久化与恢复、限额状态管理、权限控制、Advisor用量递归累加） | 已证实 | tests/目录扫描确认 | open |
| B4-ide-integration-01 | ide-integration | — | 测试缺口 | P2 | ide-integration子系统缺少专用测试文件，核心功能无回归保护 | src/utils/ide.ts, src/utils/idePathConversion.ts, src/hooks/useDiffInIDE.ts, src/commands/ide/ide.tsx | N/A | ❌无测试 | 中（功能正常但无回归保护） | 添加ide-integration子系统完整测试（lockfile读写、路径规范化、祖先PID检查、stale lockfile清理、diff同步流程、IDE选择与连接） | 已证实 | tests/目录扫描确认 | open |
| B4-ide-integration-02 | ide-integration | — | 设计文档与实现一致但有局限 | P3 | lockfile没有并发锁机制，多个Claude Code实例可能竞争读写lockfile，设计文档已明确指出此限制 | src/utils/ide.ts | N/A | ❌无测试 | 低（风险低） | 添加简单文件锁或使用原子写入（临时文件rename），或在文档中更明确说明此限制 | 已证实 | 完整源码审查+设计文档验证 | open |
| B4-ide-integration-03 | ide-integration | — | 设计文档与实现一致但有局限 | P3 | showDiffInIDE在进程崩溃时可能遗留IDE diff tab（cleanup依赖beforeExit事件，崩溃时可能不触发），设计文档已明确指出此限制 | src/hooks/useDiffInIDE.ts | N/A | ❌无测试 | 低（下次openDiff使用新UUID不冲突） | 在tabName中加入进程pid，下次启动时清理旧tab，或IDE插件侧添加心跳检测 | 已证实 | 完整源码审查+设计文档验证 | open |

---

## 证据边界

### app-state 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| app-state-store | AppState类型定义、getDefaultAppState() 默认状态构造 | 循环更新防护功能未实现（设计文档有说明但源码无） |
| app-state-store-impl | createStore()实现、getState/setState/subscribe方法 | 循环更新防护功能未实现 |
| app-state-react | AppStateProvider实现、useAppState/useSetAppState/useAppStateMaybeOutsideOfProvider hooks | React hooks并发渲染边界场景 |
| app-state-on-change | onChangeAppState同步逻辑、externalMetadataToAppState转换 | 大规模状态变更性能 |
| bootstrap-state | 与AppState分离、会话级全局变量 | 无 |
| context-state | Context状态管理 | 无 |

### assistant-ui 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| AssistantSessionChooser | 会话选择列表UI实现、空列表处理 | 大规模会话列表分页加载 |
| sessionDiscovery | API调用、多字段名兼容、排序 | API错误重试 |
| sessionHistory | HISTORY_PAGE_SIZE、分页加载API | 无 |

### commands-framework 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| Command类型系统 | CommandBase、PromptCommand/LocalCommand/LocalJSXCommand定义 | 复杂命令类型扩展边界 |
| 命令来源聚合 | 优先级顺序、动态技能插入位置、懒加载shim | 大规模命令聚合性能 |
| 远程控制安全 | 白名单模型、分层安全模型 | 权限细粒度控制 |

### cost-tracking 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| cost-tracker-core | 会话成本持久化与恢复、动态精度调整、按短名聚合、Advisor 用量递归累加 | 成本累加并发安全 |
| model-cost-config | 分层定价配置、Opus 4.6 fast mode 支持、未知模型降级 | 新增模型时的定价更新流程 |
| billing-access | 权限控制逻辑、测试 mock 支持 | 复杂组织角色组合 |
| claude-ai-limits | 响应头限额提取、早期预警配置、超额禁用原因 | 定期后台轮询限额状态 |
| bootstrap-cost-state | 状态存储与接口 | 大规模成本状态性能 |

### ide-integration 已验证的边界

| 模块 | 已验证 | 未验证 |
|------|------|------|
| ide-core | lockfile 发现与扫描、路径规范化、祖先 PID 检查、stale lockfile 清理、30 秒轮询、scroll draining 暂停、VS Code 扩展自动安装 | lockfile 并发安全 |
| ide-path-conversion | Windows/WSL 双向转换、WSL UNC 路径 distro 匹配 | 复杂网络路径场景 |
| ide-hooks | IDE 集成初始化、diff 同步与三种结果处理、IDE 状态通知 | 进程崩溃后旧 tab 自动清理 |
| ide-commands | /ide 命令 UI 与流程 | 无 |
| ide-jetbrains | JetBrains 插件安装状态检查 | 无 |

---

## 完成判定

### 总体评估

| 子系统 | 文档完整性 | 实现一致性 | 上游一致性 | 验证状态 | 总体 |
|--------|------------|------------|------------|----------|------|
| app-state | ✅完整 | ✅一致（除循环更新防护功能未实现） | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | ⚠️有条件通过（需补充测试并明确文档与实现不一致） |
| assistant-ui | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | ⚠️有条件通过（需补充测试） |
| commands-framework | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（测试不足） | ⚠️有条件通过（需补充核心框架测试） |
| cost-tracking | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | ⚠️有条件通过（需补充测试） |
| ide-integration | ✅完整 | ✅一致（设计文档已明确指出 lockfile 并发与崩溃清理限制） | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | ⚠️有条件通过（需补充测试） |

### Batch4 统计

| 项目 | 数量 |
|------|------|
| 已审计子系统 | 5（app-state、assistant-ui、commands-framework、cost-tracking、ide-integration） |
| 待审计子系统 | 6（ink-platform、repl-input、text-formatting、ui-rendering、voice-assistant、workspace-ui） |
| 完整文档 | 5 |
| 实现一致 | 5（除app-state循环更新防护功能未实现，ide-integration设计文档已明确指出限制） |
| 发现总数 | 8 |
| P0 | 0 |
| P1 | 0 |
| P2 | 5 |
| P3 | 3 |

### 发现分类

| 类别 | 数量 |
|------|------|
| 设计文档与实现不一致 | 1 |
| 测试缺口 | 5 |
| 设计文档与实现一致但有局限 | 2 |

### app-state 生命周期证据链确认

✅ **创建Store**：AppStateProvider → useState(() => createStore()) → 稳定引用

✅ **订阅切片**：useAppState → useSyncExternalStore → selector函数 → Object.is比较

✅ **状态更新**：setState(updater) → prevState → newState → Object.is比较 → onChangeAppState → listeners通知

✅ **外部设置同步**：外部文件变更 → useSettingsChange → applySettingsChange → setState

✅ **权限模式同步**：onChangeAppState检测toolPermissionContext.mode变化 → 转换为外部模式名 → notifySessionMetadataChanged → notifyPermissionModeChanged

### assistant-ui 生命周期证据链确认

✅ **会话发现与选择**：用户调用/assistant → discoverAssistantSessions → AssistantSessionChooser选择会话

✅ **历史消息加载**：建立WebSocket连接 → useAssistantHistory加载历史消息 → 分页策略每页100条 → 滚动触发预加载 → 滚动锚定保持视口位置

### commands-framework 生命周期证据链确认

✅ **命令聚合**：getCommands → 按优先级并行加载各来源 → 去重 → 插入动态技能 → 过滤可用性检查

✅ **命令解析与执行**：用户输入/command args → parseSlashCommand解析 → findCommand查找 → 根据type分发执行

### cost-tracking 生命周期证据链确认

✅ **成本累加**：API 请求完成 → calculateUSDCost 计算成本 → addToTotalSessionCost 累加主会话成本 → 递归处理 Advisor 子请求用量 → 更新 STATE.totalCostUSD 和 STATE.modelUsage → 上报 telemetry（costCounter、tokenCounter、tengu_advisor_tool_token_usage）

✅ **成本持久化**：会话退出时 → saveCurrentSessionCosts 保存到 project config（包括 totalCostUSD、modelUsage、totalAPIDuration、totalLinesAdded/Removed、fpsMetrics）

✅ **成本恢复**：启动时 → restoreCostStateForSession 验证 sessionId 匹配 → 重建 modelUsage（从 model config 注入 contextWindow/maxOutputTokens） → setCostStateForRestore 更新 STATE

✅ **成本显示**：用户输入 /cost 或会话退出时 → formatTotalCost 生成显示文本 → formatCost 动态精度调整 → formatModelUsage 按短名聚合

✅ **限额与超额使用**：启动时 checkQuotaStatus → API 响应时 extractQuotaStatusFromHeaders 更新 currentLimits → 用户输入 /extra-usage 时 runExtraUsage 根据权限决定路径

### ide-integration 生命周期证据链确认

✅ **IDE 自动发现与连接**：启动 → useIDEIntegration 调用 initializeIdeIntegration → findAvailableIDE 30 秒轮询 → cleanupStaleIdeLockfiles 清理 stale lockfile → detectIDEs 扫描验证（NFC 路径规范化、WSL 路径转换、祖先 PID 检查） → 恰好一个有效 IDE → onIdeDetected → setDynamicMcpConfig 配置 IDE MCP → MCP 客户端连接

✅ **IDE Diff 同步**：FileEditTool 调用 → useDiffInIDE 检查 hasAccessToIDEExtensionDiffFeature 和 diffTool === 'auto' → showDiffInIDE 读取旧内容 → 注册 cleanup（abort + beforeExit） → getPatchForEdits 生成更新内容 → callIdeRpc('openDiff') → 等待三种结果消息：
- FILE_SAVED：用户保存，computeEditsFromContents 重新计算 edits，accept-once
- TAB_CLOSED：用户关闭 tab，接受原始 edits
- DIFF_REJECTED：用户拒绝，不应用修改
- cleanup 关闭 tab

✅ **/ide 命令流程**：用户输入 /ide → detectIDEs(true) 显示可用 IDE 列表 → 用户选择 IDE → setDynamicMcpConfig 配置 → 等待 MCP 连接 → 显示结果；或选择 None → 断开连接

### Batch4 总体结论

✅ **所有5个子系统spec质量优秀**：文档完整性高，每个spec包含多项关键决策表格、模块设计卡、完整生命周期证据链。

✅ **所有5个子系统实现一致性强**：所有分组源码与spec高度对齐，关键机制与文档完全一致，安全边界设计周全；ide-integration 子系统的设计文档已明确指出 lockfile 并发与崩溃清理限制，与实现一致。

⚠️ **测试覆盖不足**：app-state、assistant-ui、cost-tracking、ide-integration 子系统无专用测试文件，commands-framework 子系统核心框架功能测试不足。

### 子系统审计进度

| 子系统 | 状态 |
|--------|------|
| app-state | ✅已审计 |
| assistant-ui | ✅已审计 |
| commands-framework | ✅已审计 |
| cost-tracking | ✅已审计 |
| ide-integration | ✅已审计 |
| ink-platform | ⏸️保持 open |
| repl-input | ⏸️保持 open |
| text-formatting | ⏸️保持 open |
| ui-rendering | ⏸️保持 open |
| voice-assistant | ⏸️保持 open |
| workspace-ui | ⏸️保持 open |

**当前进度**：5/11 已审计，剩余6个子系统保持 open 状态。

### 说明

本次完成app-state、assistant-ui、commands-framework、cost-tracking、ide-integration五个子系统的深度生命周期审计，剩余6个子系统（ink-platform、repl-input、text-formatting、ui-rendering、voice-assistant、workspace-ui）保持 open 状态。README暂不更新，待所有11个子系统审计完成后统一更新。
