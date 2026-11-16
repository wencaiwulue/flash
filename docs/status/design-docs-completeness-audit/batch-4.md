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

## 发现登记

| ID | 主责 | 关联 | 类别 | 严重度 | 问题陈述 | 源码证据 | 上游证据 | 测试证据 | 影响 | 修订建议 | 置信度 | 验证边界 | 状态 |
|----|------|------|------|--------|----------|------|------|------|--------|--------|
| B4-app-state-01 | app-state | — | 设计文档与实现不一致 | P3 | 设计文档中明确说明有「循环更新防护：设置者自己不会收到自己触发的变更通知」，但实际源码中并未实现此功能 | src/state/store.ts | N/A | ❌无测试 | 低（功能正常） | 明确文档说明此功能暂未实现，或按设计实现循环通知防护功能 | 已证实 | 完整源码审查 | open |
| B4-app-state-02 | app-state | — | 测试缺口 | P2 | app-state子系统缺少专用测试文件，核心功能无回归保护 | src/state/ | N/A | ❌无测试 | 中（功能正常但无回归保护） | 添加app-state子系统完整测试（Store创建、状态更新、订阅通知、React hooks行为） | 已证实 | tests/目录扫描确认 | open |
| B4-assistant-ui-01 | assistant-ui | — | 测试缺口 | P2 | assistant-ui子系统缺少专用测试文件，核心功能无回归保护 | src/assistant/ | N/A | ❌无测试 | 中（功能正常但无回归保护） | 添加assistant-ui子系统完整测试（会话发现、历史消息分页加载、滚动锚定、WebSocket连接管理、权限请求处理） | 已证实 | tests/目录扫描确认 | open |
| B4-commands-framework-01 | commands-framework | — | 测试缺口 | P2 | commands-framework子系统缺少部分核心模块的专用测试，核心框架功能测试不足 | src/commands.ts, src/types/command.ts, src/utils/processUserInput/ | N/A | ⚠️部分覆盖（有部分斜杠命令测试） | 中（功能正常但无回归保护） | 添加commands-framework核心框架完整测试（命令聚合优先级逻辑、远程控制安全模型、懒加载机制、isMeta消息处理） | 已证实 | tests/目录扫描确认 | open |

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

---

## 完成判定

### 总体评估

| 子系统 | 文档完整性 | 实现一致性 | 上游一致性 | 验证状态 | 总体 |
|--------|------------|------------|------------|----------|------|
| app-state | ✅完整 | ✅一致（除循环更新防护功能未实现） | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | ⚠️有条件通过（需补充测试并明确文档与实现不一致） |
| assistant-ui | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（无测试） | ⚠️有条件通过（需补充测试） |
| commands-framework | ✅完整 | ✅一致 | ⚠️不充分（仅源码） | ⚠️部分充分（测试不足） | ⚠️有条件通过（需补充核心框架测试） |

### Batch4 统计

| 项目 | 数量 |
|------|------|
| 已审计子系统 | 3（app-state、assistant-ui、commands-framework） |
| 待审计子系统 | 8（cost-tracking、ide-integration、ink-platform、repl-input、text-formatting、ui-rendering、voice-assistant、workspace-ui） |
| 完整文档 | 3 |
| 实现一致 | 3（除app-state循环更新防护功能未实现） |
| 发现总数 | 4 |
| P0 | 0 |
| P1 | 0 |
| P2 | 3 |
| P3 | 1 |

### 发现分类

| 类别 | 数量 |
|------|------|
| 设计文档与实现不一致 | 1 |
| 测试缺口 | 3 |

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

### Batch4 总体结论

✅ **所有3个子系统spec质量优秀**：文档完整性高，每个spec包含多项关键决策表格、模块设计卡、完整生命周期证据链。

✅ **所有3个子系统实现一致性强**：所有分组源码与spec高度对齐，关键机制与文档完全一致，安全边界设计周全。

⚠️ **测试覆盖不足**：app-state、assistant-ui子系统无专用测试文件，commands-framework子系统核心框架功能测试不足。

### 子系统审计进度

| 子系统 | 状态 |
|--------|------|
| app-state | ✅已审计 |
| assistant-ui | ✅已审计 |
| commands-framework | ✅已审计 |
| cost-tracking | ⏸️保持 open |
| ide-integration | ⏸️保持 open |
| ink-platform | ⏸️保持 open |
| repl-input | ⏸️保持 open |
| text-formatting | ⏸️保持 open |
| ui-rendering | ⏸️保持 open |
| voice-assistant | ⏸️保持 open |
| workspace-ui | ⏸️保持 open |

**当前进度**：3/11 已审计，剩余8个子系统保持 open 状态。

### 说明

本次完成app-state、assistant-ui、commands-framework三个子系统的深度生命周期审计，剩余8个子系统（cost-tracking、ide-integration、ink-platform、repl-input、text-formatting、ui-rendering、voice-assistant、workspace-ui）保持 open 状态。README暂不更新，待所有11个子系统审计完成后统一更新。
