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

---

### 4.4 模块设计卡

#### 模块 1：Store/Selector/Subscription

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T>` |
| **关键类型** | `type Store<T> = { getState: () => T; setState: (updater: (prev: T) => T) => void; subscribe: (listener: Listener) => () => void }` |
| **输入输出** | 输入：initialState 初始状态，onChange 可选回调；输出：Store 实例 |
| **状态所有权与作用域** | Store 实例持有内部 `state` 变量（闭包私有）和 `listeners` Set；作用域：整个应用，由 AppStateProvider 稳定提供 |
| **更新/订阅/重渲染流程** | 1. `setState(updater)` 执行 updater 得到 nextState<br>2. `Object.is(prev, next)` 相同则直接返回<br>3. 不同则：更新内部 state → 调用 onChange → 遍历 listeners 调用<br>4. `useSyncExternalStore(store.subscribe, get)` 接收 listener 通知<br>5. 调用 selector(store.getState()) 得到 selectedValue<br>6. `Object.is(prevSelected, selectedValue)` 相同则不渲染 |
| **错误与内存** | 无内部错误处理；listener 返回 unsubscribe 函数，调用时从 Set 中删除，无内存泄漏；Store 本身由 useState 持有，Provider 卸载后被 GC |
| **设计取舍/备选** | 纯函数闭包 vs class 实例：选择闭包，简单无 this 问题；useSyncExternalStore vs 自定义订阅：选择官方方案，处理并发渲染边界；无自动 selector memo：要求调用者稳定引用，避免 memo 开销 |
| **源码测试证据** | `src/state/store.ts:1-35` |

---

#### 模块 2：不可变更新

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `setState(updater: (prev: T) => T): void` |
| **关键类型** | updater 函数类型：`(prev: T) => T`；比较通过 `Object.is` |
| **输入输出** | 输入：接收 prevState，返回 nextState；输出：无返回值，但触发通知 |
| **状态所有权与作用域** | 不可变约定：调用者不修改 prevState，返回新对象；Store 内部仅持有引用，不复制；DeepImmutable 字段由类型系统标记只读 |
| **更新/订阅/重渲染流程** | 1. updater(prevState) 需返回新对象（`{ ...prev, field: newValue }`）<br>2. `Object.is(prev, next)` 比较引用决定是否通知<br>3. selector 依赖稳定引用：`{ a, b }` 每次返回新对象 → 多余渲染 |
| **错误与内存** | 无运行时强制不可变（仅 TypeScript 类型）；忘记 spread 深层对象 → UI 无响应；selector 返回新对象 → 性能问题 |
| **设计取舍/备选** | Immer vs 手动 spread：选择手动，无依赖，性能可预测；Object.is vs ===：选择 Object.is，正确处理 NaN/-0；完全不可变 vs 部分可变：部分字段（tasks, mcp 等）直接持有可变对象 |
| **源码测试证据** | `src/state/store.ts:20-27` |

---

#### 模块 3：Provider 生命周期

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `AppStateProvider({ children, initialState, onChangeAppState }: Props): React.ReactNode` |
| **关键类型** | `Props = { children: React.ReactNode; initialState?: AppState; onChangeAppState?: ({ newState, oldState }) => void }` |
| **输入输出** | 输入：React children，可选 initialState，可选 onChangeAppState；输出：React 节点树 |
| **状态所有权与作用域** | Store 由 `useState(() => createStore(...))` 持有，引用永远稳定；通过 `AppStoreContext` 向下传递；`HasAppStateContext` 用于检测嵌套 Provider；Provider 卸载时，Store 随组件树一起被 GC |
| **更新/订阅/重渲染流程** | 1. 首次渲染：执行 useState 初始化函数创建 Store<br>2. mount 后 useEffect：检查是否需要禁用 bypass 权限模式<br>3. useSettingsChange 订阅外部设置变更<br>4. Provider 本身不订阅状态，Context 引用稳定，不会触发子组件重渲染<br>5. 子组件通过 useAppState 订阅各自关心的切片 |
| **错误与内存** | 嵌套 Provider 检测：HasAppStateContext 已存在则 throw Error；mount effect 无清理函数（一次性检查）；useSettingsChange 的 useEffect 返回 cleanup 函数取消订阅；无内存泄漏 |
| **设计取舍/备选** | useState 初始化 vs useRef + useMemo：选择 useState，语义更清晰，一次性初始化；单一 Provider vs 多 Provider：选择单一，避免协调问题；Context 直接传递状态 vs 传递 Store：选择传递 Store，避免整个状态变更触发所有子组件重渲染 |
| **源码测试证据** | `src/state/AppState.tsx:57-200` |

---

#### 模块 4：跨功能字段

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `getDefaultAppState(): AppState` |
| **关键类型** | `AppState = DeepImmutable<{ settings, verbose, ... }> & { tasks, agentNameRegistry, mcp, plugins, ... }` |
| **输入输出** | 输入：无；输出：完整初始状态对象 |
| **状态所有权与作用域** | DeepImmutable 字段（89-158 行）：settings, verbose, mainLoopModel, toolPermissionContext, kairosEnabled, replBridge* 等；Mutable 字段（159-569 行）：tasks, agentNameRegistry, mcp, plugins, todos, replContext, teamContext 等；跨功能：权限模式、模型设置、展开视图等被多个模块消费 |
| **更新/订阅/重渲染流程** | 1. 不可变字段更新：返回新对象引用 → selector 检测到变化 → 重渲染<br>2. 可变字段更新：字段内对象直接修改（Map.set, 函数属性等），但仍需返回新的 AppState 根对象（即使字段引用不变）→ 依赖该字段的 selector 检测到变化<br>3. 跨功能同步：onChangeAppState 监听特定字段变更，同步到外部系统 |
| **错误与内存** | mutable 字段被直接修改但根对象不变 → UI 不同步；忘记返回新根对象 → 变更丢失；tasks 持有函数类型 → 无法序列化；agentNameRegistry 是 Map → 无法 DeepImmutable |
| **设计取舍/备选** | 全部不可变 vs 部分可变：选择部分可变，避免引入 Immutable.js/Immer 等库；DeepImmutable 类型标记 vs 运行时冻结：仅类型标记，无运行时开销；单一 AppState vs 拆分：选择单一，单一事实来源 |
| **源码测试证据** | `src/state/AppStateStore.ts:89-569` |

---

#### 模块 5：设置同步

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `useSettingsChange(onChange: (source: SettingSource, settings: SettingsJson) => void): void` 和 `applySettingsChange(source: SettingSource, setAppState: (f: (prev: AppState) => AppState) => void): void` |
| **关键类型** | `SettingSource = 'userSettings' \| 'managedSettings' \| 'remoteSettings'`；`onChangeAppState({ newState, oldState })` |
| **输入输出** | useSettingsChange 输入：回调函数；无输出<br>applySettingsChange 输入：source, setAppState；输出：无，调用 setAppState 更新状态<br>onChangeAppState 输入：{ newState, oldState }；输出：无，副作用 |
| **状态所有权与作用域** | settingsChangeDetector：全局单例，文件系统 watcher；AppState.settings：不可变字段，来自 getInitialSettings()；外部 → AppState：useSettingsChange + applySettingsChange；AppState → 外部：onChangeAppState 中的 clearApiKeyHelperCache、applyConfigEnvironmentVariables、saveGlobalConfig 等 |
| **更新/订阅/重渲染流程** | 外部 → AppState 方向：<br>1. 外部修改 settings.json<br>2. settingsChangeDetector 检测到变更，fanOut 通知所有订阅者<br>3. useSettingsChange 的 handleChange 被调用<br>4. applySettingsChange 调用 getInitialSettings() 读取新设置<br>5. 同步权限规则、hooks 配置<br>6. setAppState 更新 AppState.settings 和 toolPermissionContext<br><br>AppState → 外部方向：<br>1. 某处调用 setAppState 更新 settings 或其他字段<br>2. onChangeAppState 被调用<br>3. 比较 newState.xxx !== oldState.xxx<br>4. 根据字段执行：saveGlobalConfig、clearApiKeyHelperCache、applyConfigEnvironmentVariables、notifySessionMetadataChanged 等 |
| **错误与内存** | onChangeAppState 中调用 setState → 无限循环；settings.env 变更只添加/覆盖，不删除；权限规则加载失败无回滚；useSettingsChange 的 useEffect 返回 cleanup 函数取消订阅，无内存泄漏 |
| **设计取舍/备选** | 双向同步 vs 单向：选择双向，保持 AppState 和外部系统一致；单一 onChangeAppState vs 多个独立订阅：选择单一，集中管理；applySettingsChange 共享 vs 重复：共享，interactive 和 headless/SDK 模式复用 |
| **源码测试证据** | `src/hooks/useSettingsChange.ts:1-25`, `src/utils/settings/applySettingsChange.ts:33-92`, `src/state/onChangeAppState.ts:43-171` |

---

#### 模块 6：渲染优化

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `useAppState<T>(selector: (state: AppState) => T): T` 和 `useSetAppState(): (updater: (prev: AppState) => AppState) => void` |
| **关键类型** | selector 函数类型：`(state: AppState) => T`；useSyncExternalStore 的 getSnapshot：`() => T` |
| **输入输出** | useAppState 输入：selector 函数；输出：选中的状态切片<br>useSetAppState 输入：无；输出：稳定的 setState 函数（不订阅任何状态） |
| **状态所有权与作用域** | useAppState 内部调用 useAppStore 获取 Store（来自 Context）；useSyncExternalStore 订阅 Store；每个 useAppState 调用有自己的订阅，独立重渲染；useSetAppState 返回的 setState 引用永远稳定，与 Store 相同 |
| **更新/订阅/重渲染流程** | 1. useAppState 调用 useSyncExternalStore(store.subscribe, get)<br>2. get 函数调用 selector(store.getState()) 并做开发环境检查<br>3. 开发环境检查：若 selector 返回原状态本身（state === selected）则 throw Error<br>4. 状态变更时 store.subscribe 触发 listener<br>5. useSyncExternalStore 调用 get 得到新 selectedValue<br>6. Object.is(prevSelected, selectedValue) 比较，相同则不渲染<br>7. useSetAppState 不订阅任何状态，只返回 store.setState，组件永不因状态变更重渲染 |
| **错误与内存** | selector 返回新对象（`{ a, b }`）→ 每次渲染都认为变化 → 多余渲染；selector 返回原状态 → 开发环境 Error；useAppState 不在 Provider 内 → ReferenceError；无内存泄漏，Provider 卸载时订阅清理 |
| **设计取舍/备选** | useSyncExternalStore vs useContext + useReducer：选择 useSyncExternalStore，避免 Context 全量重渲染；自动 memo selector vs 手动稳定：选择手动，避免 memo 复杂度和开销；禁止返回原状态 vs 允许：禁止，避免性能灾难；useSetAppState 分离 vs 同 useAppState：分离，让不需要读取的组件不订阅 |
| **源码测试证据** | `src/state/AppState.tsx:134-185` |

---

### 4.5 DeepImmutable 字段与运行时 mutable 字段清单

#### DeepImmutable 字段（89-158 行）
| 字段 | 说明 |
|------|------|
| `settings` | SettingsJson，应用设置 |
| `verbose` | boolean，详细日志开关 |
| `mainLoopModel` | ModelSetting，主循环模型 |
| `mainLoopModelForSession` | ModelSetting，会话级模型覆盖 |
| `statusLineText` | string \| undefined，状态行文本 |
| `expandedView` | 'none' \| 'tasks' \| 'teammates'，展开视图 |
| `isBriefOnly` | boolean，仅简洁模式 |
| `showTeammateMessagePreview` | boolean，队友消息预览（ant-only） |
| `selectedIPAgentIndex` | number，选中的队友索引 |
| `coordinatorTaskIndex` | number，协调任务索引 |
| `viewSelectionMode` | 'none' \| 'selecting-agent' \| 'viewing-agent'，视图选择模式 |
| `footerSelection` | FooterItem \| null，底部选中项 |
| `toolPermissionContext` | ToolPermissionContext，工具权限上下文 |
| `spinnerTip` | string \| undefined，加载提示 |
| `agent` | string \| undefined，agent 名称 |
| `kairosEnabled` | boolean，assistant 模式启用 |
| `remoteSessionUrl` | string \| undefined，远程会话 URL |
| `remoteConnectionStatus` | 'connecting' \| 'connected' \| 'reconnecting' \| 'disconnected'，远程连接状态 |
| `remoteBackgroundTaskCount` | number，远程后台任务数 |
| `replBridgeEnabled` | boolean，always-on bridge 启用 |
| `replBridgeExplicit` | boolean，显式激活 bridge |
| `replBridgeOutboundOnly` | boolean，仅出站模式 |
| `replBridgeConnected` | boolean，bridge 已连接 |
| `replBridgeSessionActive` | boolean，bridge 会话活跃 |
| `replBridgeReconnecting` | boolean，bridge 重连中 |
| `replBridgeConnectUrl` | string \| undefined，bridge 连接 URL |
| `replBridgeSessionUrl` | string \| undefined，bridge 会话 URL |
| `replBridgeEnvironmentId` | string \| undefined，bridge 环境 ID |
| `replBridgeSessionId` | string \| undefined，bridge 会话 ID |
| `replBridgeError` | string \| undefined，bridge 错误 |
| `replBridgeInitialName` | string \| undefined，bridge 初始名称 |
| `showRemoteCallout` | boolean，显示远程提示 |

#### 运行时 mutable 字段（159-569 行）
| 字段 | 说明 | 为何可变 |
|------|------|----------|
| `tasks` | { [taskId: string]: TaskState } | TaskState 包含函数类型，无法 DeepImmutable |
| `agentNameRegistry` | Map<string, AgentId> | Map 是可变集合类型 |
| `foregroundedTaskId` | string \| undefined | 简单值，但与 tasks 一起更新 |
| `viewingAgentTaskId` | string \| undefined | 简单值，但与 tasks 一起更新 |
| `companionReaction` | string \| undefined | 简单值 |
| `companionPetAt` | number \| undefined | 简单值 |
| `mcp` | { clients, tools, commands, resources, pluginReconnectKey } | MCPServerConnection 包含函数/连接 |
| `plugins` | { enabled, disabled, commands, errors, installationStatus, needsRefresh } | LoadedPlugin 包含函数 |
| `agentDefinitions` | AgentDefinitionsResult | 简单对象但更新频繁 |
| `fileHistory` | FileHistoryState | 包含 Set<string> 可变集合 |
| `attribution` | AttributionState | 简单对象 |
| `todos` | { [agentId: string]: TodoList } | TodoList 复杂结构 |
| `remoteAgentTaskSuggestions` | { summary, task }[] | 简单数组 |
| `notifications` | { current, queue } | 简单对象 |
| `elicitation` | { queue } | 简单对象 |
| `thinkingEnabled` | boolean \| undefined | 简单值 |
| `promptSuggestionEnabled` | boolean | 简单值 |
| `sessionHooks` | SessionHooksState | Map 类型 |
| `tungstenActiveSession` | { sessionName, socketName, target } \| undefined | 简单对象 |
| `tungstenLastCapturedTime` | number \| undefined | 简单值 |
| `tungstenLastCommand` | { command, timestamp } \| undefined | 简单对象 |
| `tungstenPanelVisible` | boolean \| undefined | 简单值 |
| `tungstenPanelAutoHidden` | boolean \| undefined | 简单值 |
| `bagelActive` | boolean \| undefined | 简单值 |
| `bagelUrl` | string \| undefined | 简单值 |
| `bagelPanelVisible` | boolean \| undefined | 简单值 |
| `computerUseMcpState` | { allowedApps, grantFlags, ... } \| undefined | 包含 Set 和复杂结构 |
| `replContext` | { vmContext, registeredTools, console } \| undefined | 包含 vm.Context、Map、函数 |
| `teamContext` | { teamName, teamFilePath, leadAgentId, ... } \| undefined | 包含复杂嵌套结构 |
| `standaloneAgentContext` | { name, color } \| undefined | 简单对象 |
| `inbox` | { messages } | 简单对象 |
| `workerSandboxPermissions` | { queue, selectedIndex } | 简单对象 |
| `pendingWorkerRequest` | { toolName, toolUseId, description } \| null | 简单对象 |
| `pendingSandboxRequest` | { requestId, host } \| null | 简单对象 |
| `promptSuggestion` | { text, promptId, shownAt, acceptedAt, generationRequestId } | 简单对象 |
| `speculation` | SpeculationState | 包含可变 ref（messagesRef, writtenPathsRef, contextRef）和函数（abort） |
| `speculationSessionTimeSavedMs` | number | 简单值 |
| `skillImprovement` | { suggestion } | 简单对象 |
| `authVersion` | number | 简单值 |
| `initialMessage` | { message, clearContext, mode, allowedPrompts } \| null | 简单对象 |
| `pendingPlanVerification` | { plan, verificationStarted, verificationCompleted } \| undefined | 简单对象 |
| `denialTracking` | DenialTrackingState \| undefined | 简单对象 |
| `activeOverlays` | ReadonlySet<string> | Set 类型 |
| `fastMode` | boolean \| undefined | 简单值 |
| `advisorModel` | string \| undefined | 简单值 |
| `effortValue` | EffortValue \| undefined | 简单值 |
| `ultraplanLaunching` | boolean \| undefined | 简单值 |
| `ultraplanSessionUrl` | string \| undefined | 简单值 |
| `ultraplanPendingChoice` | { plan, sessionId, taskId } \| undefined | 简单对象 |
| `ultraplanLaunchPending` | { blurb } \| undefined | 简单对象 |
| `isUltraplanMode` | boolean \| undefined | 简单值 |
| `replBridgePermissionCallbacks` | BridgePermissionCallbacks \| undefined | 包含函数 |
| `channelPermissionCallbacks` | ChannelPermissionCallbacks \| undefined | 包含函数 |

---

### 4.6 useSyncExternalStore 选择器稳定性

| 方面 | 说明 |
|------|------|
| **useSyncExternalStore 签名** | `useSyncExternalStore<T>(subscribe: (callback: () => void) => () => void, getSnapshot: () => T, getServerSnapshot?: () => T): T` |
| **选择器稳定性** | 相同输入必须返回相同引用（或值相同的原始类型）；返回新对象 → 每次都认为变化 → 多余渲染 |
| **正确用法** | `const verbose = useAppState(s => s.verbose)`（原始类型）；`const promptSuggestion = useAppState(s => s.promptSuggestion)`（稳定对象引用）；多次调用 useAppState 选择不同字段 |
| **错误用法** | `const { verbose, settings } = useAppState(s => ({ verbose: s.verbose, settings: s.settings }))`（每次返回新对象）；`const state = useAppState(s => s)`（返回原状态，开发环境报错） |
| **开发环境检查** | `if (process.env.USER_TYPE === 'ant' && state === selected) throw Error`；明确禁止返回原状态，避免性能灾难 |
| **Object.is 比较** | useSyncExternalStore 使用 Object.is 比较 prevSnapshot 和 nextSnapshot；Object.is(NaN, NaN) = true，Object.is(-0, +0) = false，比 === 更正确 |

---

### 4.7 onChangeAppState

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `onChangeAppState({ newState, oldState }: { newState: AppState; oldState: AppState }): void` |
| **调用时机** | Store.setState 中，state 更新后、listeners 调用前；仅当 Object.is(prev, next) 不同时调用 |
| **同步字段清单** | 1. `toolPermissionContext.mode` → notifySessionMetadataChanged, notifyPermissionModeChanged<br>2. `mainLoopModel` → updateSettingsForSource, setMainLoopModelOverride<br>3. `expandedView` → saveGlobalConfig(showExpandedTodos, showSpinnerTree)<br>4. `verbose` → saveGlobalConfig(verbose)<br>5. `tungstenPanelVisible` → saveGlobalConfig(tungstenPanelVisible)（ant-only）<br>6. `settings` → clearApiKeyHelperCache, clearAwsCredentialsCache, clearGcpCredentialsCache, applyConfigEnvironmentVariables |
| **权限模式同步细节** | `toExternalPermissionMode` 转换内部模式名（bubble, ungated auto）为外部可见名；仅当 EXTERNAL mode 变化时才通知 CCR；isUltraplanMode 过渡标记：首次 plan 且 isUltraplanMode 从 false→true 时才发送 is_ultraplan_mode: true，之后发送 null 删除该 key |
| **错误处理** | settings 变更时的缓存清理用 try/catch 包裹，logError 但不抛错；其他同步路径无错误处理 |
| **禁止操作** | onChangeAppState 中禁止调用 setState，否则无限循环；无运行时检测 |
| **设计取舍/备选** | 单一 onChange vs 多个订阅：选择单一，集中管理；diff 检测在 onChange 内 vs 外：在内，调用处无需关心；同步到外部系统 vs 状态持久化：仅同步，不持久化整个状态 |
| **源码测试证据** | `src/state/onChangeAppState.ts:43-171` |

---

### 4.8 settings change detector 同步

| 项目 | 内容 |
|------|------|
| **真实入口签名** | `useSettingsChange(onChange: (source: SettingSource, settings: SettingsJson) => void): void` 和 `applySettingsChange(source: SettingSource, setAppState: (f: (prev: AppState) => AppState) => void): void` |
| **changeDetector 角色** | 全局单例，文件系统 watcher；检测到变更时 fanOut 通知所有订阅者；fanOut 前已重置 settings 缓存 |
| **useSettingsChange 实现** | useEffect 调用 `settingsChangeDetector.subscribe(handleChange)`；返回 cleanup 函数取消订阅；handleChange 调用 `getSettings_DEPRECATED()` 获取新设置，传递给 onChange |
| **applySettingsChange 实现** | 调用 `getInitialSettings()` 读取新设置；`loadAllPermissionRulesFromDisk()` 重新加载权限规则；`updateHooksConfigSnapshot()` 更新 hooks 配置；setAppState 更新 AppState：settings, toolPermissionContext, 可能 effortValue；ant-only：重新 strip 过于宽松的 Bash 权限；检查是否禁用 bypass 权限模式；transitionPlanAutoMode |
| **effortValue 同步细节** | 仅当 `prev.settings.effortLevel !== newSettings.effortLevel` 且 `newEffort !== undefined` 时才更新 AppState.effortValue；避免无关设置变更（如 tip 关闭）覆盖 --effort CLI 标志值 |
| **缓存重置顺序** | changeDetector.fanOut 前已重置缓存 → getSettings_DEPRECATED()/getInitialSettings() 读取新状态；过去两处都重置导致 N 次磁盘读取（N 订阅者），现在仅一次 |
| **双向同步完整性** | 外部 → AppState：useSettingsChange + applySettingsChange；AppState → 外部：onChangeAppState 中的 clear*Cache、applyConfigEnvironmentVariables、saveGlobalConfig；形成闭环 |
| **源码测试证据** | `src/hooks/useSettingsChange.ts:1-25`, `src/utils/settings/applySettingsChange.ts:33-92` |

---

### 4.9 Provider 卸载与全局状态边界

| 项目 | 内容 |
|------|------|
| **Provider 卸载流程** | Provider 组件卸载 → React 清理 Context；useSettingsChange 的 useEffect cleanup 函数被调用 → 取消订阅 settingsChangeDetector；Store 实例（由 Provider useState 持有）失去引用 → GC；listeners Set 随 Store 一起被 GC；无显式清理 Store 的 API |
| **全局状态边界** | AppState：UI 相关状态，React 组件树内可用，Provider 外不可用（useAppState 抛错）；Bootstrap State：`src/bootstrap/state.ts` 中的模块级变量，完全独立，在 React 初始化前即可访问，不参与 UI 渲染；两者不重复，职责分明：Bootstrap 用于启动流程、命令解析、SDK 模式；AppState 用于 UI 组件 |
| **useAppStateMaybeOutsideOfProvider** | 安全版本，不在 Provider 内时返回 undefined；使用场景：可能在 Provider 初始化前渲染的组件，或在非 React 环境复用的组件；内部实现：useContext(AppStoreContext)，若 store 存在则 useSyncExternalStore 订阅，否则用 NOOP_SUBSCRIBE，返回 undefined |
| **嵌套 Provider 防护** | HasAppStateContext 初始 false；AppStateProvider 渲染时先读取 HasAppStateContext，若已为 true 则 throw Error；否则渲染 HasAppStateContext.Provider value={true}；确保全局只有一个 Provider |
| **Store 引用稳定性** | `useState(() => createStore(...))` 保证 Store 引用永远不变；Context 传递稳定引用 → Provider 本身不会触发子组件重渲染；子组件重渲染仅由 useSyncExternalStore 的 selector 结果变化触发 |
| **源码测试证据** | `src/state/AppState.tsx:57-200`

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

### 7.1 AppState 字段分类

| 字段类型 | 字段列表 | 源码证据 |
|---------|---------|---------|
| Immutable snapshot（通过 DeepImmutable 标记） | `settings`、`verbose`、`mainLoopModel`、`mainLoopModelForSession`、`statusLineText`、`expandedView`、`isBriefOnly`、`showTeammateMessagePreview`、`selectedIPAgentIndex`、`coordinatorTaskIndex`、`viewSelectionMode`、`footerSelection`、`toolPermissionContext`、`spinnerTip`、`agent`、`kairosEnabled`、`remoteSessionUrl`、`remoteConnectionStatus`、`remoteBackgroundTaskCount`、`replBridgeEnabled`、`replBridgeExplicit`、`replBridgeOutboundOnly`、`replBridgeConnected`、`replBridgeSessionActive`、`replBridgeReconnecting`、`replBridgeConnectUrl`、`replBridgeSessionUrl`、`replBridgeEnvironmentId`、`replBridgeError`、`replBridgeInitialName`、`showRemoteCallout`、`agentDefinitions`、`fileHistory`、`attribution`、`notifications`、`elicitation`、`thinkingEnabled`、`promptSuggestionEnabled`、`sessionHooks`、`tungstenActiveSession`、`tungstenLastCapturedTime`、`tungstenLastCommand`、`tungstenPanelVisible`、`tungstenPanelAutoHidden`、`bagelActive`、`bagelUrl`、`bagelPanelVisible`、`inbox`、`workerSandboxPermissions`、`pendingWorkerRequest`、`pendingSandboxRequest`、`promptSuggestion`、`speculation`、`speculationSessionTimeSavedMs`、`skillImprovement`、`authVersion`、`initialMessage`、`pendingPlanVerification`、`denialTracking`、`activeOverlays`、`fastMode`、`advisorModel`、`effortValue`、`ultraplanLaunching`、`ultraplanSessionUrl`、`ultraplanPendingChoice`、`ultraplanLaunchPending`、`isUltraplanMode`、`replBridgePermissionCallbacks`、`channelPermissionCallbacks` | `src/state/AppStateStore.ts:89-157` |
| Mutable（直接持有可变对象，不标记 DeepImmutable） | `tasks`、`agentNameRegistry`、`mcp`、`plugins`、`todos`、`remoteAgentTaskSuggestions`、`computerUseMcpState`、`replContext`、`teamContext`、`standaloneAgentContext` | `src/state/AppStateStore.ts:158-569` |

### 7.2 核心模块证据

| 设计陈述 | 源码证据 | 证据边界 |
|---------|---------|---------|
| 单一 Store + useSyncExternalStore | `src/state/AppState.tsx:149-167` | 仅验证当前实现 |
| 不可变更新 + Object.is 比较 | `src/state/store.ts:20-27` | 仅验证当前实现 |
| 全局 onChangeAppState 钩子 | `src/state/onChangeAppState.ts:43-171` | 仅验证当前实现 |
| Bootstrap State 与 AppState 分离 | `src/bootstrap/state.ts:1-1763` | 仅验证当前实现 |
| 设置变更双向同步 | `src/state/AppState.tsx:103-111` | 仅验证当前实现 |

### 7.3 测试覆盖

**无直接测试覆盖**，相关测试可能在其他模块测试中间接验证。

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
| P2 | selector 返回新对象导致多余渲染（常见性能问题） | 引入自动 memoized selectors（Reselect 或类似） | 中（改变 selector 行为） | 相同输入返回相同引用 | M | 设计推断 |
| P2 | 手动不可变更新容易出错 | 引入 Immer 或类似库简化不可变更新 | 中（依赖变更） | updater 可直接修改 draft，库处理不可变 | M | 设计推断 |
| P2 | Bootstrap 与 AppState 两套系统心智负担 | 明确文档和 lint 规则，帮助开发者选择何时用哪套 | 低（仅文档/工具） | 开发者能快速判断 | S | 设计推断 |
| P3 | onChangeAppState 中意外调用 setState 导致无限循环 | 运行时检测和防护，在 onChangeAppState 中调用 setState 时抛出错误 | 低（仅防护，不改变正确行为） | 错误路径抛出清晰错误 | S | 设计推断 |
