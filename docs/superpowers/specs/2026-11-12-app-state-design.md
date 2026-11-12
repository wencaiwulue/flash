---
id: app-state
batch: 4
title: App State 应用状态、订阅与生命周期设计
date: 2026-11-12
status: draft
---

# App State 应用状态、订阅与生命周期设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 需要管理应用级别的共享状态（设置、权限模式、任务、MCP 状态、Plugins 状态、UI 状态等），供 React 组件、命令、工具等多个模块读写。如果没有统一的状态管理方案，会导致：

- 状态分散在多个模块级变量或 React 状态中，难以追踪变更来源
- React 组件需要层层传递状态，prop-drilling 严重
- 不同模块对同一份状态的更新容易产生竞态条件
- 状态变更时，依赖该状态的模块（如 CCR 同步、全局配置持久化等）无法得到通知
- 渲染性能问题：整个状态树变更时所有组件都重新渲染
- 循环更新风险：模块自身更新状态后又收到变更通知

因此本系统必须在以下约束下完成：

- 支持 React 消费：通过 `useAppState(selector)` 订阅状态切片，只有切片变化时才重新渲染
- 支持非 React 消费：通过 `getState()` 和 `setState(updater)` 读写，通过 `subscribe()` 监听变化
- 不可变更新：状态变更需返回新对象，避免直接修改原对象
- 单次通知：同一 `setState` 调用只在更新完成后通知所有订阅者一次
- 循环更新防护：设置者自己不会收到自己触发的变更通知
- 全局变更 hook：支持 `onChangeAppState` 钩子，用于同步状态到外部系统（CCR、全局配置文件等）
- 单一 store：整个应用只有一个 AppStateProvider，不能嵌套
- 类型安全：完整的 TypeScript 类型覆盖，支持深度不可变标记

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|------|---------|-----------|---------------------|------|------|
| 单一 Store + React Context + useSyncExternalStore | `AppStateStore` 持有状态，`AppStateProvider` 通过 Context 提供 Store，`useAppState(selector)` 使用 `useSyncExternalStore` 订阅 | `useSyncExternalStore` 是 React 18 官方推荐的外部状态订阅方式，处理并发渲染、时间切片等边界情况；单一 Store 简化状态共享，避免多 Store 协调问题 | Redux/Zustand/Jotai：引入额外依赖，现有实现已满足需求，且避免依赖膨胀；直接 React Context 传递状态：整个状态变化时所有组件都重新渲染，性能差 | 需确保 selector 返回稳定引用（相同值时保持相同对象），否则会有多余渲染 | `src/state/AppState.tsx:149-167` |
| 不可变更新 + Object.is 比较 | `setState(updater)` 要求 updater 返回新对象，通过 `Object.is(prev, next)` 判断是否实际变化 | 简单、无依赖，配合 selector 可精确控制渲染；`Object.is` 比 `===` 更正确（处理 NaN、-0 等） | Immer：引入额外依赖，增加运行时开销；可变更新 + 脏标记：容易遗漏标记，导致渲染不一致 | 需手动 spread 或复制对象，容易写出 bug（忘记复制深层对象） | `src/state/store.ts:20-27` |
| Selector 约束：禁止返回整个状态 | `useAppState` 在开发环境检查，如果 selector 返回的是原状态本身则抛出错误 | 防止性能灾难：如果 selector 返回整个状态，任何微小变更都会导致所有使用该 selector 的组件重新渲染 | 允许但警告：太宽松，容易被忽略；自动 memoize：selector 复杂度高时 memoize 本身有开销 | 开发者需注意 selector 粒度，要么返回单个字段，要么返回稳定的子对象引用 | `src/state/AppState.tsx:157-161` |
| 全局 `onChangeAppState` 钩子 | `createStore` 接受可选 `onChange` 参数，每次状态变更时调用，传递 oldState 和 newState | 单一位置处理状态同步到外部系统（CCR、全局配置文件等），避免散落各处的订阅逻辑；集中处理权限模式、模型、展开视图等的持久化 | 多个独立订阅：代码分散，容易重复处理；直接在 setState 处调用：不灵活，不同入口（React/非 React）都要记得调用 | 需注意 `onChangeAppState` 中不能再调用 `setState`（否则无限循环），需做变更检查（oldValue != newValue 才处理） | `src/state/onChangeAppState.ts:43-171` |
| AppState 部分字段可变 | `tasks`、`agentNameRegistry`、`activeOverlays` 等字段直接持有可变对象（Map、函数等），不标记为 DeepImmutable | 这些字段包含函数或 Map 类型，无法/不需要做不可变处理；DeepImmutable 只用于需要通过 selector 做比较的字段 | 全部不可变：需要引入不可变 Map/Set 库，复杂度高；全部可变：失去 selector 的渲染优化 | 需小心处理这些可变字段的变更，更新时仍需返回新对象（即使内部字段可变） | `src/state/AppStateStore.ts:158-164` |
| Bootstrap State 与 AppState 分离 | `src/bootstrap/state.ts` 存放会话级全局变量（sessionId、总成本、项目根目录等），完全独立于 AppState | Bootstrap State 在 React 初始化前就需要访问（启动流程、命令解析等），且不参与 UI 渲染；AppState 专注于 UI 相关状态；分离避免循环依赖（React 组件 → bootstrap → … → React） | 合并到 AppState：启动时无法在 React 初始化前访问，且容易引入循环依赖；全部用模块变量：失去 React 订阅能力 | 两套系统，开发者需区分什么时候用哪套；Bootstrap State 变更时不会触发 React 渲染 | `src/bootstrap/state.ts:1-1763` |
| 设置变更同步：useSettingsChange + applySettingsChange | `useSettingsChange` 监听外部设置变更，调用 `applySettingsChange` 更新 AppState；AppState 中的 settings 变更时，`onChangeAppState` 清除 auth 缓存、重新应用环境变量 | 双向同步：外部文件变更 → AppState，AppState → 外部系统（auth 缓存、环境变量等）；单向数据流明确 | 直接在设置模块修改 AppState：耦合度高，设置模块依赖 React/State；不做双向同步：用户改文件后 UI 不更新，或 UI 改设置后 auth 不刷新 | 需注意循环：AppState → 外部 → AppState，通过 internalWrite 标记或变更检查避免 | `src/state/AppState.tsx:103-111` |
| Store 引用稳定：useState(() => createStore()) | `AppStateProvider` 使用 `useState(() => createStore())` 确保 Store 引用在整个生命周期中不变 | Store 本身不需要重新创建，稳定的引用避免 Context 和子组件的不必要重新渲染 | useMemo：语义上 useState 更合适（一次性初始化）；useRef：需要额外判断初始化，不如 useState 简洁 | 需确保初始化逻辑是幂等的（多次调用也没问题），但这里只在初始化时调用一次 | `src/state/AppState.tsx:72-78` |
| 嵌套 Provider 防护：HasAppStateContext 检查 | `AppStateProvider` 内部用 `HasAppStateContext` 检查是否已嵌套，已嵌套则抛出错误 | 嵌套 Provider 会导致状态隔离（内层看不到外层状态），容易产生 bug；显式报错帮助快速定位 | 允许嵌套：容易造成状态混乱；静默覆盖外层：行为不可预测 | 需确保 App 根组件只包裹一次 AppStateProvider | `src/state/AppState.tsx:62-69` |
| 安全 useAppState 版本：useAppStateMaybeOutsideOfProvider | 提供不抛错版本，返回 undefined 当在 Provider 外时 | 某些组件可能在 Provider 初始化前渲染（或在非 React 环境中复用），需要降级处理 | 总是抛错：组件无法在 Provider 外使用，复用性差；默认返回空值：类型不安全 | 调用方需处理 undefined 情况 | `src/state/AppState.tsx:193-200` |
| 计算选择器：纯函数无状态 | `selectors.ts` 中的 `getViewedTeammateTask`、`getActiveAgentForInput` 是纯函数，接收 AppState 参数返回计算结果 | 简单、可测试、无缓存一致性问题；由 React 组件调用时配合 useAppState 自动重新计算 | 带缓存的选择器（Reselect）：需要维护缓存 key，当前场景下计算简单，收益不高 | 每次调用都重新计算，计算复杂时可能有性能问题（当前实现下可接受） | `src/state/selectors.ts:1-76` |
| Teammate 视图逻辑集中在 teammateViewHelpers | `enterTeammateView`、`exitTeammateView`、`stopOrDismissAgent` 等辅助函数封装任务状态的复杂转换逻辑 | 避免组件中散落重复的状态转换代码；集中管理任务 retain/release、evictAfter 设置、viewSelectionMode 切换等 | 直接在组件中修改 AppState：代码重复，容易遗漏某个字段的更新 | 辅助函数需传入 setAppState，依赖 AppState 的类型定义 | `src/state/teammateViewHelpers.ts:46-141` |

## 3. 目标与非目标

### 目标

- **状态与生命周期目标**：`createStore()` 创建支持 getState、setState、subscribe 的 Store；`useAppState(selector)` 订阅状态切片，切片变化时重新渲染；`useSetAppState()` 获取稳定的 setState 引用，不订阅任何状态；`onChangeAppState` 钩子在每次状态变更后被调用；设置变更双向同步（文件 → AppState，AppState → 外部系统）
- **接口与数据目标**：`AppState` 类型完整定义应用状态结构；`DeepImmutable` 标记大部分字段为只读，防止意外修改；`getDefaultAppState()` 返回完整的默认状态
- **执行与环境目标**：支持 CLI 模式、SDK 嵌入模式；支持 feature flag 控制（KAIROS、COORDINATOR_MODE、VOICE_MODE 等）

### 非目标

- 不支持时间旅行（undo/redo）
- 不支持中间件（middleware）
- 不支持多个 Store
- 不支持状态持久化到磁盘（部分字段通过 onChangeAppState 同步到全局配置，属于外部逻辑）
- 不支持状态序列化（部分字段包含函数/Map，无法序列化）
- 不支持 Web 环境

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// Store 接口
interface Store<State> {
  getState(): State
  setState(updater: (prev: State) => State): void
  subscribe(listener: () => void): () => void
}

// React hooks
function useAppState<Selected>(selector: (state: AppState) => Selected): Selected
function useSetAppState(): (updater: (prev: AppState) => AppState) => void
function useAppStateStore(): AppStateStore
function useAppStateMaybeOutsideOfProvider<Selected>(
  selector: (state: AppState) => Selected
): Selected | undefined

// Provider
function AppStateProvider({
  children,
  initialState,
  onChangeAppState
}: {
  children: React.ReactNode
  initialState?: AppState
  onChangeAppState?: (args: { newState: AppState; oldState: AppState }) => void
}): React.ReactNode

// 辅助函数
function getDefaultAppState(): AppState
function getViewedTeammateTask(appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>): any
function getActiveAgentForInput(appState: AppState): any
function enterTeammateView(taskId: string, setAppState: any): void
function exitTeammateView(setAppState: any): void
function stopOrDismissAgent(taskId: string, setAppState: any): void
```

调用方式：

1. **启动路径**：`main.tsx` 渲染 `<AppStateProvider onChangeAppState={onChangeAppState}>` 包裹整个 App
2. **React 读取路径**：组件调用 `const verbose = useAppState(s => s.verbose)` 订阅状态
3. **React 写入路径**：组件调用 `const setAppState = useSetAppState(); setAppState(s => ({ ...s, verbose: !s.verbose }))`
4. **非 React 读取/写入**：通过 `useAppStateStore().getState()` / `.setState()`
5. **变更通知**：`subscribe()` 的 listener 在每次 setState 后被调用；`onChangeAppState` 在每次 setState 后被调用（如果有）

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|----------|----------|---------|------------|----------------|
| `store.ts` | Store 实例内部的 `state` 变量、`listeners` Set | `getState`、`setState`、`subscribe` | 状态业务逻辑、React 集成 | 接收 updater 函数，返回新 state；调用 listener 通知变更 |
| `AppStateStore.ts` | 无（类型定义 + 默认值构造） | `getDefaultAppState` | 状态变更逻辑 | 定义 AppState 类型、CompletionBoundary、SpeculationState 等 |
| `AppState.tsx` | AppStoreContext、HasAppStateContext | `AppStateProvider`、`useAppState`、`useSetAppState`、`useAppStateStore` | 状态业务逻辑、持久化 | 提供 React hooks 和 Provider，内部使用 useSyncExternalStore |
| `onChangeAppState.ts` | 无（纯函数） | `onChangeAppState`、`externalMetadataToAppState` | UI 渲染、任务执行 | 接收 newState/oldState，同步到 CCR、全局配置文件、auth 缓存等 |
| `selectors.ts` | 无（纯函数） | `getViewedTeammateTask`、`getActiveAgentForInput` | 状态变更 | 接收 AppState，返回计算结果 |
| `teammateViewHelpers.ts` | 无（纯函数） | `enterTeammateView`、`exitTeammateView`、`stopOrDismissAgent` | 直接渲染 | 接收 taskId 和 setAppState，封装状态转换逻辑 |
| `bootstrap/state.ts` | 模块级变量 `STATE` | 大量 getter/setter（`getSessionId`、`setTotalCostUSD` 等） | UI 渲染、React 订阅 | 提供全局会话状态访问，与 AppState 完全独立 |

### 4.3 主控制流

完整状态更新与通知流（端到端）：

```
用户操作或系统事件
  ↓
调用 setAppState(updater)
  ↓
Store.setState(updater)
  ├─ 执行 updater(prevState) → nextState
  ├─ Object.is(prevState, nextState) → 相同则直接返回，无通知
  ├─ 不同则：
  │   ├─ 内部 state 变量更新为 nextState
  │   ├─ 调用 onChangeAppState({ oldState, newState })
  │   │   ├─ 检查权限模式变更 → 通知 CCR 和 SDK
  │   │   ├─ 检查模型变更 → 更新全局配置
  │   │   ├─ 检查展开视图变更 → 更新全局配置
  │   │   ├─ 检查 verbose 变更 → 更新全局配置
  │   │   ├─ 检查设置变更 → 清除 auth 缓存、重新应用环境变量
  │   │   └─ … 其他同步逻辑
  │   └─ 遍历 listeners 调用每个 listener()
  └─ 返回
  ↓
React useSyncExternalStore 收到 listener 通知
  ├─ 调用 selector(store.getState()) → selectedValue
  ├─ Object.is(prevSelectedValue, selectedValue) → 相同则不渲染
  └─ 不同则重新渲染组件
```

设置变更双向同步流：

```
外部编辑器修改 settings.json
  ↓
settingsChangeDetector 检测到变更
  ↓
useSettingsChange 回调被调用
  ↓
applySettingsChange(source, store.setState)
  ↓
AppState 更新
  ↓
onChangeAppState 检测到 settings 变更
  ├─ clearApiKeyHelperCache()
  ├─ clearAwsCredentialsCache()
  ├─ clearGcpCredentialsCache()
  └─ 新 settings.env 不同则 applyConfigEnvironmentVariables()
```

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|--------|--------|-----------------|--------------|--------------|--------------|
| selector 返回新对象导致多余渲染 | 运行时 React 重渲染 | 无异常，性能下降 | 不重试 | 无 | 组件重新渲染 |
| 深层状态字段变更时忘记复制上层对象 | setState() 调用后 | 无异常，但 UI 不更新 | 不重试 | 无 | 状态变化 UI 无响应 |
| onChangeAppState 中调用 setState | onChangeAppState() 内部 | 无限循环 | 不重试 | 无 | 应用卡死 |
| 可变字段被直接修改而不通过 setState | 外部代码 | 无异常，但 UI 不同步 | 不重试 | 无 | 状态与 UI 不一致 |
| Bootstrap State 与 AppState 重复或不一致 | 业务逻辑 | 行为不可预测 | 不重试 | 无 | 应用行为异常 |

| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| selector vs 自动 memoize | 要求 selector 稳定引用，不自动 memoize | 开发者需小心，容易写出性能问题 | 简单、可预测，无额外缓存开销 |
| 不可变更新 vs Immer | 手动 spread，无 Immer | 容易出错，代码冗长 | 无依赖，性能可预测 |
| 单一 Store vs 多 Store | 单一 Store | 状态树可能变大，某些场景不够灵活 | 避免协调问题，单一事实来源 |
| Bootstrap 分离 vs 合并 | Bootstrap 与 AppState 分离 | 两套系统，心智负担 | 避免循环依赖，启动阶段可访问 |

## 6. 现状验收标准

1. **给定**一个状态切片选择器，**当**无关状态变更时，**必须**不触发组件重新渲染
2. **给定**一个状态更新，**当**对象引用不变时，**必须**不触发通知和重新渲染
3. **给定** `onChangeAppState` 钩子，**当**特定字段变更时，**必须**同步到外部系统
4. **给定**嵌套 Provider 尝试，**当** AppStateProvider 包裹在另一个内部时，**必须**抛出错误
5. **给定**外部设置文件变更，**当** useSettingsChange 监听到时，**必须**更新 AppState
6. **给定** AppState 设置变更，**当** onChangeAppState 触发时，**必须**清除 auth 缓存

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| 单一 Store + useSyncExternalStore | `src/state/AppState.tsx:149-167` | 需补充测试 | 仅验证当前实现 |
| 不可变更新 + Object.is 比较 | `src/state/store.ts:20-27` | 需补充测试 | 仅验证当前实现 |
| 全局 onChangeAppState 钩子 | `src/state/onChangeAppState.ts:43-171` | 需补充测试 | 仅验证当前实现 |
| Bootstrap State 与 AppState 分离 | `src/bootstrap/state.ts:1-1763` | 需补充测试 | 仅验证当前实现 |
| 设置变更双向同步 | `src/state/AppState.tsx:103-111` | 需补充测试 | 仅验证当前实现 |

### 未覆盖

测试覆盖需补充：
- Store 单元测试（getState、setState、subscribe）
- React hooks 测试（useAppState、useSetAppState、嵌套 Provider）
- onChangeAppState 测试（各字段变更同步逻辑）
- 选择器与辅助函数测试（纯函数单元测试）

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/app-state.yaml)

### 本 spec 主拥有的文件组

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|-----|----------|------------------|----------------|
| app-state-core | AppState 类型、store 实现、hooks、Provider | 需补充 |  |
| app-state-onchange | onChangeAppState 同步逻辑 | 需补充 |  |
| app-state-selectors | 选择器、teammateViewHelpers | 需补充 |  |

### 相关子系统

- **Settings spec**：Settings 是 AppState 的一部分，但设置系统本身的设计（多来源、合并、验证等）由 settings spec 负责
- **Permissions spec**：权限模式是 AppState 的一部分，但权限裁决逻辑由 permissions spec 负责
- **Task system spec**：任务状态是 AppState 的一部分，但任务执行逻辑由 task system spec 负责

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|--------|-------|-------|
| P1 | selector 返回新对象导致多余渲染（常见性能问题） | 引入自动 memoized selectors（Reselect 或类似） | 中（改变 selector 行为） | 相同输入返回相同引用 | M | 设计推断 |
| P2 | 手动不可变更新容易出错 | 引入 Immer 或类似库简化不可变更新 | 中（依赖变更） | updater 可直接修改 draft，库处理不可变 | M | 设计推断 |
| P2 | Bootstrap 与 AppState 两套系统心智负担 | 明确文档和 lint 规则，帮助开发者选择何时用哪套 | 低（仅文档/工具） | 开发者能快速判断 | S | 设计推断 |
| P3 | onChangeAppState 中意外调用 setState 导致无限循环 | 运行时检测和防护，在 onChangeAppState 中调用 setState 时抛出错误 | 低（仅防护，不改变正确行为） | 错误路径抛出清晰错误 | S | 设计推断 |
