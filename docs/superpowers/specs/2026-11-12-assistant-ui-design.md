---
id: assistant-ui
batch: 4
title: Assistant UI 助手会话与历史交互设计
date: 2026-11-12
status: draft
---

# Assistant UI 助手会话与历史交互设计

## 1. 问题与约束

Assistant UI 模块需要提供远程助手会话选择与历史交互功能，面临的约束包括：
- 与 agent-swarms 执行逻辑完全分离，仅负责 UI 交互与远程会话连接展示
- 需要支持发现并选择远程运行的助手会话
- 以只读模式查看会话历史消息
- 支持远程环境设置与 GitHub token 同步
- 实现会话连接状态管理与错误处理
- 需要处理网络错误、认证错误、权限请求错误等场景

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 会话选择列表格式 | 使用 `{title || sessionId} — {machineName || cwd || 'unknown host'}` | 信息密度适中，用户友好 | 仅显示 sessionId（不够用户友好）、更详细元数据（占用过多终端空间） | 长标题或路径可能被截断 | `src/components/AssistantSessionChooser.tsx` |
| 历史消息分页策略 | 每页 100 条，滚动预加载阈值 40 行，初始加载后未填满视口自动继续（最多 10 页） | 平衡用户体验和网络开销 | 更大页面（减少请求但增加初始延迟）、更小页面（更快响应但更多请求） | 快速滚动时可能短暂显示加载哨兵 | `src/hooks/useAssistantHistory.ts:37-43,214-239` |
| 只读 Viewer 模式 | 独立 viewerOnly 配置控制会话行为 | `claude assistant` 命令明确需要只读查看能力 | 始终允许交互（可能意外干扰远程运行会话）、权限分离到多个类（增加代码复杂度） | 配置参数增多 | `src/utils/remote.ts` |
| GitHub Token 红acted 封装 | 使用 RedactedGithubToken 类包装原始 token | 防止意外日志泄露 | 直接传递字符串（泄露风险高）、自定义类型但不重写 toString（仍可能泄露） | 需要显式调用 `.reveal()` 才能获取原始值 | Token 导入实现 |
| 滚动锚定实现 | anchorRef 存储 {beforeHeight: number; count: number}，useLayoutEffect 在新消息提交后调用 scrollBy 调整 scrollTop | 加载旧消息时保持当前视口位置不变 | 估算消息高度（不准确）、React 状态管理（增加渲染开销） | 使用 ScrollBox.getFreshScrollHeight() 和 scrollBy() | `src/hooks/useAssistantHistory.ts:88-95,198-208` |

## 3. 目标与非目标

### 目标
- 提供远程助手会话发现与选择功能
- 实现历史消息懒加载与滚动锚定
- 支持 GitHub token 安全同步
- 管理会话连接状态与错误处理
- 提供只读 viewer 模式
- 支持远程环境设置

### 非目标
- 不实现 agent 执行逻辑（由 agent-swarms 负责）
- 不提供本地会话持久化（由 session-persistence 负责）
- 不处理权限批准逻辑（由权限系统负责）

## 4. 架构、模块与数据流

Assistant UI 采用分层设计：

```
┌─────────────────────────────────────────────────────────┐
│                    Commands Layer                       │
│  /assistant  |  /remote-setup  |  /remote-env  |  /session │
└─────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────┐
│                   UI Components Layer                    │
│  AssistantSessionChooser  |  NewInstallWizard  | ...     │
└─────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────┐
│                    Hooks Layer                           │
│              useAssistantHistory                        │
└─────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────┐
│                   API Layer                              │
│  sessionDiscovery  |  sessionHistory  |  daemonBridge    │
└─────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────┐
│              Remote Session Layer                        │
│  RemoteSessionManager  |  SessionsWebSocket               │
└─────────────────────────────────────────────────────────┘
```

### 主控制流
1. 用户调用 /assistant → 发现远程会话 → 显示选择列表
2. 选择会话 → 建立 WebSocket 连接 → 加载历史消息
3. 滚动触发预加载 → 保持滚动锚定
4. 权限请求转发 → 用户批准或拒绝

---

### 模块设计卡：AssistantSessionChooser

**真实入口签名与关键类型**
```typescript
// src/assistant/AssistantSessionChooser.tsx
type AssistantSession = {
  id: string
  title?: string
  machineName?: string
  cwd?: string
  branch?: string
  lastActiveAt?: number
}

type Props = {
  sessions: AssistantSession[]
  onSelect: (id: string) => void
  onCancel: () => void
}

export function AssistantSessionChooser({
  sessions,
  onSelect,
  onCancel,
}: Props): React.ReactNode
```

**输入输出**
- 输入：AssistantSession 数组（按 lastActiveAt 降序排列）
- 输出：用户选择的 sessionId，或取消操作
- 显示格式：`{title ?? sessionId} — {machineName ?? cwd ?? 'unknown host'}`

**状态与分页**
- 无内部状态，纯展示组件
- 会话列表由父组件通过 `discoverAssistantSessions()` 获取
- limit: 50 条记录（服务端限制）

**会话发现与选择流程**
1. 父组件调用 `discoverAssistantSessions()` 获取会话列表
2. 列表按 `(b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)` 降序排序
3. 展示选项标签：优先显示 title，回退到 sessionId；host 信息优先 machineName，其次 cwd，最后 'unknown host'
4. 用户选择某项 → 触发 `onSelect(session.id)`
5. 用户取消 → 触发 `onCancel()`

**错误处理**
- 会话列表为空时显示 "No assistant sessions found."
- 无重试机制，父组件负责错误处理

**设计取舍与备选**
- 取舍：会话选择仅展示 id/title/machineName/cwd，不展示完整元数据（节省终端空间）
- 备选：更详细的列表项（包含分支、最后活跃时间）→ 否决，避免占用过多行
- 备选：搜索/过滤功能 → 未实现，当前版本仅提供基础选择

**源码测试证据**
- 源码位置：`src/assistant/AssistantSessionChooser.tsx`
- 调用方：主 REPL 会话选择流程
- 依赖：`Dialog`、`Select` 组件
- 测试覆盖：无直接测试，通过端到端流程验证

---

### 模块设计卡：useAssistantHistory

**真实入口签名与关键类型**
```typescript
// src/hooks/useAssistantHistory.ts
type Props = {
  config: RemoteSessionConfig | undefined
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  scrollRef: RefObject<ScrollBoxHandle | null>
  onPrepend?: (indexDelta: number, heightDelta: number) => void
}

type Result = {
  maybeLoadOlder: (handle: ScrollBoxHandle) => void
}

export function useAssistantHistory({
  config,
  setMessages,
  scrollRef,
  onPrepend,
}: Props): Result
```

**输入输出**
- 输入：`RemoteSessionConfig`（必须 `viewerOnly=true`）、消息状态 setter、滚动句柄 ref
- 输出：`maybeLoadOlder()` 回调，供滚动事件调用
- 启用条件：仅当 `config?.viewerOnly === true` 时激活

**状态与分页**
- 分页大小：100 条事件（`HISTORY_PAGE_SIZE = 100`）
- 预加载阈值：距离顶部 40 行（`PREFETCH_THRESHOLD_ROWS = 40`）
- 视口填充限制：初始加载后若未填满，自动继续加载最多 10 页（`MAX_FILL_PAGES = 10`）
- 状态管理：使用 ref 存储 cursor/ctx/inflight，避免重渲染
- 哨兵消息：
  - "loading older messages…"：加载中
  - "failed to load older messages — scroll up to retry"：失败
  - "start of session"：到达历史起点

**加载与滚动锚定流程**
1. **初始加载（useEffect）**
   - 调用 `createHistoryAuthCtx(sessionId)` 准备认证上下文
   - 调用 `fetchLatestEvents(ctx, limit=100)` 获取最新一页
   - 设置 `fillBudgetRef.current = MAX_FILL_PAGES`
   - 调用 `prepend(page, isInitial=true)` 插入消息

2. **视口自动填充（后续 useEffect）**
   - 检查 `contentH <= viewH`：内容高度 ≤ 视口高度
   - 若满足且 `fillBudgetRef.current > 0`，继续调用 `loadOlder()`
   - 预算耗尽或内容溢出时停止

3. **向上滚动加载（maybeLoadOlder）**
   - 滚动事件触发时检查 `scrollTop < PREFETCH_THRESHOLD_ROWS`
   - 调用 `loadOlder()`：
     - 检查 `inflightRef`：避免并发请求
     - 检查 `cursorRef.current`：`null` 表示已到顶
     - 交换哨兵消息为 "loading older messages…"
     - 调用 `fetchOlderEvents(ctx, cursor=beforeId)`
     - 调用 `prepend(page, isInitial=false)`

4. **滚动锚定机制**
   - `prepend()` 阶段：
     - 记录 `anchorRef.current = { beforeHeight, count }`
     - `beforeHeight` = 加载前 scrollHeight
     - `count` = 新增消息数
   - `useLayoutEffect` 阶段（提交后）：
     - 计算 `delta = scrollHeight - beforeHeight`
     - 调用 `scrollBy(delta)` 保持视口位置不变
     - 调用 `onPrepend(count, delta)` 通知未读分隔线偏移
     - 例外：若 `isSticky()`（滚动锁定在底部），不调整

5. **哨兵管理**
   - 使用稳定 UUID：`sentinelUuidRef.current = randomUUID()`
   - 替换策略：通过 uuid 精确匹配，O(1) 替换，避免闪烁

**错误处理**
- `fetchOlderEvents()` 返回 `null`（HTTP 非 200 或网络错误）：
  - 显示 "failed to load older messages — scroll up to retry"
  - 不修改 `cursorRef`，允许用户再次滚动重试
- 无自动重试，避免请求风暴

**设计取舍与备选**
- 取舍：使用 ref 而非 state 管理 cursor/inflight → 减少重渲染
- 取舍：预加载阈值 40 行 → 平衡响应速度与请求频率
- 取舍：最大 10 页自动填充 → 避免初始加载过多消息
- 备选：基于消息高度估算而非精确 scrollHeight → 否决，因不同消息高度差异大
- 备选：React state 管理加载状态 → 否决，增加重渲染开销

**源码测试证据**
- 源码位置：`src/hooks/useAssistantHistory.ts`
- 常量定义：37-43 行
- 滚动锚定：88-95 行（prepend）、198-208 行（useLayoutEffect）
- 视口填充：214-239 行
- 依赖：`fetchLatestEvents`、`fetchOlderEvents`、`convertSDKMessage`
- 测试覆盖：无直接测试，通过手动验证分页加载和滚动锚定

---

### 模块设计卡：sessionDiscovery（discoverAssistantSessions）

**真实入口签名与关键类型**
```typescript
// src/assistant/sessionDiscovery.ts
export type AssistantSession = {
  id: string
  title?: string
  machineName?: string
  cwd?: string
  branch?: string
  lastActiveAt?: number
}

export async function discoverAssistantSessions(): Promise<AssistantSession[]>
```

**输入输出**
- 输入：无参数
- 输出：AssistantSession 数组，按 lastActiveAt 降序排列
- 限制：limit=50（服务端）

**会话发现流程**
1. 调用 `prepareApiRequest()` 获取 accessToken 和 orgUUID
2. GET `${BASE_API_URL}/v1/sessions`
   - Header: `anthropic-beta: ccr-byoc-2025-07-29`
   - Header: `x-organization-uuid: orgUUID`
   - Param: `limit=50`
   - Timeout: 15s
3. 响应归一化：
   - 支持 `response.data.data` 或 `response.data`
   - id 字段：支持 `id`、`sessionId`、`session_id`
   - timestamp 字段：支持 `lastActiveAt`、`last_active_at`、`updated_at`
   - machineName：支持 `machineName`、`machine_name`
4. 排序：`(b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)`

**错误处理**
- 网络超时、认证错误：抛异常由调用方处理
- 响应格式异常：返回空数组

**设计取舍与备选**
- 取舍：limit=50 → 平衡响应大小与实用性
- 取舍：多字段名兼容 → 适配后端 API 演进
- 备选：本地缓存会话列表 → 未实现

**源码测试证据**
- 源码位置：`src/assistant/sessionDiscovery.ts`
- 调用方：`/assistant sessions` 命令、会话选择流程
- 测试覆盖：无直接测试

---

### 模块设计卡：sessionHistory（fetchLatestEvents / fetchOlderEvents）

**真实入口签名与关键类型**
```typescript
// src/assistant/sessionHistory.ts
export const HISTORY_PAGE_SIZE = 100

export type HistoryPage = {
  events: SDKMessage[]          // 页内事件按时间顺序排列
  firstId: string | null        // 本页最旧事件 ID → 下一页 before_id
  hasMore: boolean              // 是否存在更旧的事件
}

export type HistoryAuthCtx = {
  baseUrl: string
  headers: Record<string, string>
}

export async function createHistoryAuthCtx(
  sessionId: string,
): Promise<HistoryAuthCtx>

export async function fetchLatestEvents(
  ctx: HistoryAuthCtx,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null>

export async function fetchOlderEvents(
  ctx: HistoryAuthCtx,
  beforeId: string,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null>
```

**输入输出**
- `createHistoryAuthCtx(sessionId)`：返回带认证的请求上下文
- `fetchLatestEvents(ctx, limit)`：获取最新的 limit 条事件
- `fetchOlderEvents(ctx, beforeId, limit)`：获取 beforeId 之前的 limit 条事件
- 返回 `null` 表示请求失败（HTTP 非 200 或网络错误）

**API 调用细节**
- Endpoint：`/v1/sessions/${sessionId}/events`
- Header：`anthropic-beta: ccr-byoc-2025-07-29`
- `fetchLatestEvents`：`anchor_to_latest=true`
- `fetchOlderEvents`：`before_id=beforeId`
- Timeout：15s
- `validateStatus: () => true`：不抛 HTTP 异常，由调用方判断

**设计取舍与备选**
- 取舍：统一 HistoryAuthCtx 复用认证信息 → 避免重复 prepareApiRequest
- 取舍：validateStatus 总是 true → 由调用方决定如何处理错误
- 备选：更精细的错误分类 → 未实现

**源码测试证据**
- 源码位置：`src/assistant/sessionHistory.ts`
- 调用方：`useAssistantHistory` Hook
- 测试覆盖：无直接测试

---

### 模块设计卡：RemoteSessionManager

**真实入口签名与关键类型**
```typescript
// src/remote/RemoteSessionManager.ts
export type RemoteSessionConfig = {
  sessionId: string
  getAccessToken: () => string
  orgUuid: string
  hasInitialPrompt?: boolean
  viewerOnly?: boolean  // 只读模式：不发送中断，禁用 60s 超时
}

export type RemoteSessionCallbacks = {
  onMessage: (message: SDKMessage) => void
  onPermissionRequest: (
    request: SDKControlPermissionRequest,
    requestId: string,
  ) => void
  onPermissionCancelled?: (
    requestId: string,
    toolUseId: string | undefined,
  ) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onReconnecting?: () => void
  onError?: (error: Error) => void
}

export class RemoteSessionManager {
  constructor(
    config: RemoteSessionConfig,
    callbacks: RemoteSessionCallbacks,
  )
  connect(): void
  async sendMessage(content: RemoteMessageContent, opts?: { uuid?: string }): Promise<boolean>
  respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): void
  cancelSession(): void
  isConnected(): boolean
  getSessionId(): string
  disconnect(): void
  reconnect(): void
}

export function createRemoteSessionConfig(
  sessionId: string,
  getAccessToken: () => string,
  orgUuid: string,
  hasInitialPrompt = false,
  viewerOnly = false,
): RemoteSessionConfig
```

**输入输出**
- 输入：`RemoteSessionConfig`（会话标识、认证、viewerOnly 标记）、`RemoteSessionCallbacks`（事件回调）
- 输出：无返回值，通过回调通知事件
- viewerOnly 行为：不发送 interrupt，禁用 60s 超时，不更新会话标题

**会话连接与消息流程**
1. **连接建立**
   - 创建 `SessionsWebSocket` 实例
   - 调用 `websocket.connect()`
   - 连接成功 → `onConnected()` 回调
   - 连接断开 → `onDisconnected()` 回调
   - 临时断开并尝试重连 → `onReconnecting()` 回调

2. **消息接收（handleMessage）**
   - `type === 'control_request'` → 处理权限请求
     - `subtype === 'can_use_tool'` → 调用 `onPermissionRequest()`，存储 pending request
     - 其他 subtype → 返回 error control response，避免服务端挂起
   - `type === 'control_cancel_request'` → 调用 `onPermissionCancelled()`
   - `type === 'control_response'` → 忽略
   - SDKMessage → 调用 `onMessage()`

3. **消息发送**
   - `sendMessage()` → HTTP POST 到 `/v1/sessions/${sessionId}/events`
   - `respondToPermissionRequest()` → WebSocket 发送 control_response
   - `cancelSession()` → WebSocket 发送 control_request { subtype: 'interrupt' }

4. **权限请求生命周期**
   - 收到 control_request → 存储 `pendingPermissionRequests.set(requestId, request)`
   - 用户响应 → `respondToPermissionRequest(requestId, result)` → 发送 control_response
   - 服务端取消 → 收到 control_cancel_request → 调用 `onPermissionCancelled()`

**viewerOnly 模式行为**
- 不调用 `cancelSession()`（不发送中断）
- 禁用 60s 超时（由 SessionsWebSocket 处理）
- 不更新会话标题（由上层逻辑控制）
- 启用 `useAssistantHistory` 历史加载

**错误与同步**
- WebSocket 错误 → `onError(error)` 回调
- `sendMessage()` 失败 → 返回 `false`，记录日志
- 未找到的 permission request → 记录错误，忽略
- 无法识别的 control_request subtype → 返回 error response，避免服务端挂起

**设计取舍与备选**
- 取舍：permission request 状态本地存储 → 支持取消通知
- 取舍：未识别 subtype 返回 error → 避免服务端等待超时
- 备选：更复杂的权限请求队列 → 未实现，当前仅存储单个 pending request

**源码测试证据**
- 源码位置：`src/remote/RemoteSessionManager.ts`
- 权限请求处理：189-213 行
- 控制响应发送：218-242 行
- 调用方：主 REPL 远程会话连接
- 测试覆盖：无直接测试

---

### 模块设计卡：SessionsWebSocket

**真实入口签名与关键类型**
```typescript
// src/remote/SessionsWebSocket.ts
const RECONNECT_DELAY_MS = 2000
const MAX_RECONNECT_ATTEMPTS = 5
const PING_INTERVAL_MS = 30000
const MAX_SESSION_NOT_FOUND_RETRIES = 3  // 4001 临时错误重试
const PERMANENT_CLOSE_CODES = new Set([4003])  // unauthorized

type SessionsMessage =
  | SDKMessage
  | SDKControlRequest
  | SDKControlResponse
  | SDKControlCancelRequest

export type SessionsWebSocketCallbacks = {
  onMessage: (message: SessionsMessage) => void
  onClose?: () => void
  onError?: (error: Error) => void
  onConnected?: () => void
  onReconnecting?: () => void
}

export class SessionsWebSocket {
  constructor(
    sessionId: string,
    orgUuid: string,
    getAccessToken: () => string,
    callbacks: SessionsWebSocketCallbacks,
  )
  async connect(): Promise<void>
  sendControlResponse(response: SDKControlResponse): void
  sendControlRequest(request: SDKControlRequestInner): void
  isConnected(): boolean
  close(): void
  reconnect(): void
}
```

**输入输出**
- 输入：sessionId、orgUuid、accessToken getter、callbacks
- 输出：通过 callbacks 通知事件
- 协议：wss:// 连接，Header 认证（Authorization: Bearer）

**连接与重连流程**
1. **初始连接**
   - URL：`wss://{BASE_API_URL}/v1/sessions/ws/{sessionId}/subscribe?organization_uuid={orgUuid}`
   - Header：Authorization、anthropic-version
   - 支持 Bun（原生 WebSocket）和 Node.js（ws 包）两种环境
   - 支持 mTLS、HTTP proxy

2. **心跳保活**
   - 每 30s 发送 ping
   - 无 pong 超时：由底层 WebSocket 实现处理

3. **重连策略**
   - 临时断开（connected → closed）：
     - 最多 5 次重连，间隔 2s
     - 触发 `onReconnecting()` 回调
   - 4001（session not found）：
     - 最多 3 次重试（因 compaction 可能导致临时不可用）
     - 退避延迟：2s, 4s, 6s
   - 永久关闭（4003 unauthorized）：
     - 不重连，立即触发 `onClose()`
   - 重连预算耗尽：
     - 触发 `onClose()`

4. **强制重连（reconnect()）**
   - 关闭现有连接
   - 重置重试计数
   - 延迟 500ms 后重新连接

**消息处理**
- 接收：JSON parse → 验证 `type` 字段存在且为 string → 调用 `onMessage()`
- 发送：JSON stringify → WebSocket send
- 类型放宽：不硬编码允许的 type 值 → 兼容后端新增类型

**远程错误边界**
- 解析错误：记录日志，忽略消息
- 发送时未连接：记录错误，忽略
- 网络错误：触发 `onError()` → 重连流程接管

**设计取舍与备选**
- 取舍：4001 有限重试 → 兼容 compaction 期间的临时不可用
- 取舍：ping 间隔 30s → 平衡连接保活与网络开销
- 取舍：不严格验证消息 type → 兼容后端演进
- 备选：指数退避重连 → 未实现，当前固定延迟 2s
- 备选：队列化未发送消息 → 未实现，当前直接丢弃

**源码测试证据**
- 源码位置：`src/remote/SessionsWebSocket.ts`
- 重连逻辑：234-288 行
- 4001 特殊处理：258-272 行
- 测试覆盖：无直接测试

---

### 模块设计卡：remote-setup（/remote-setup 命令）

**真实入口签名与关键类型**
```typescript
// src/commands/remote-setup/remote-setup.tsx
export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode>

// src/commands/remote-setup/api.ts
export class RedactedGithubToken {
  constructor(raw: string)
  reveal(): string
  toString(): string  // returns [REDACTED:gh-token]
  toJSON(): string
  [Symbol.for('nodejs.util.inspect.custom')](): string
}

export type ImportTokenError =
  | { kind: 'not_signed_in' }
  | { kind: 'invalid_token' }
  | { kind: 'server'; status: number }
  | { kind: 'network' }

export async function importGithubToken(
  token: RedactedGithubToken,
): Promise<{ ok: true; result: ImportTokenResult } | { ok: false; error: ImportTokenError }>

export async function createDefaultEnvironment(): Promise<boolean>
export async function isSignedIn(): Promise<boolean>
export function getCodeWebUrl(): string
```

**输入输出**
- 输入：无参数（命令行无额外参数）
- 输出：Dialog UI 组件
- onDone 参数：完成时回调，显示结果消息

**远程设置流程**
1. **状态检查（checkLoginState）**
   - 检查 Claude 登录状态：`isSigned()`
     - 未登录 → onDone("Not signed in to Claude. Run /login first.")
   - 检查 GitHub CLI 状态：`getGhAuthStatus()`
     - 未安装 → 打开浏览器 `${getCodeWebUrl()}/onboarding?step=alt-auth`
     - 未认证 → 同上
   - 获取 GitHub token：`gh auth token`
     - 成功 → 显示确认对话框
     - 失败 → 回退到浏览器路径

2. **用户确认阶段**
   - 对话框提示："Connect Claude on the web to GitHub?"
   - 选项：Continue / Cancel
   - Cancel → logEvent + onDone()

3. **Token 导入阶段**
   - 调用 `importGithubToken(token)`：
     - POST `/v1/code/github/import-token`，body `{ token: token.reveal() }`
     - 成功：返回 github_username
     - 400：invalid_token
     - 401：not_signed_in
     - 其他：server error
   - Token 安全封装：
     - `RedactedGithubToken` 包装原始 token
     - `toString()` / `JSON.stringify()` 返回 `[REDACTED:gh-token]`
     - 仅在 HTTP 请求体调用 `.reveal()`
     - 错误日志中不包含 `err.config.data`

4. **默认环境创建（createDefaultEnvironment）**
   - 最佳尝试：失败不影响 token 导入结果
   - 检查是否已有环境：`fetchEnvironments().length > 0` → 跳过
   - POST `/v1/environment_providers/cloud/create`：
     - name: "Default"
     - kind: "anthropic_cloud"
     - Python 3.11, Node 20
     - allow_default_hosts: true

5. **完成**
   - 打开浏览器 `${getCodeWebUrl()}/code`
   - onDone("Connected as {github_username}. Opened {url}")

**远程错误边界**
- `not_signed_in` → "Login failed. Please visit {codeWebUrl} and login using the GitHub App"
- `invalid_token` → "GitHub rejected that token. Run `gh auth login` and try again."
- `server` → "Server error ({status}). Try again in a moment."
- `network` → "Couldn't reach the server. Check your connection."

**设计取舍与备选**
- 取舍：RedactedGithubToken 封装 → 防止意外日志泄露
- 取舍：默认环境创建最佳尝试 → 失败不阻塞主要流程
- 取舍：gh auth token 直接使用 → 避免存储 token 本地
- 备选：OAuth 流程 → 否决，gh CLI 更便捷

**源码测试证据**
- 源码位置：`src/commands/remote-setup/`
- RedactedGithubToken：`api.ts` 16-33 行
- importGithubToken：`api.ts` 51-100 行
- 测试覆盖：无直接测试

---

### 模块设计卡：remote-env（/remote-env 命令）

**真实入口签名与关键类型**
```typescript
// src/commands/remote-env/remote-env.tsx
export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode>
```

**输入输出**
- 输入：无参数
- 输出：`RemoteEnvironmentDialog` 组件
- 委托：所有 UI 逻辑由 `RemoteEnvironmentDialog` 处理

**远程环境选择流程**
- 由 `RemoteEnvironmentDialog` 组件实现（详见 workspace-ui 设计）
- 功能：列出可用远程环境、选择默认环境、创建新环境

**错误处理**
- 由 `RemoteEnvironmentDialog` 内部处理

**设计取舍与备选**
- 取舍：命令层极简 → UI 逻辑集中在组件

**源码测试证据**
- 源码位置：`src/commands/remote-env/remote-env.tsx`
- 依赖：`RemoteEnvironmentDialog` 组件
- 测试覆盖：无直接测试

## 5. 失败语义与工程取舍

| 失败场景 | 处理方式 | 工程取舍 |
|---|---|---|
| 会话发现 API 请求失败 | 显示空列表 | 不中断用户流程，允许重试 |
| 历史消息加载失败 | 显示 "failed to load older messages — scroll up to retry" | 提供手动重试机制，避免自动重试风暴 |
| Token 导入网络错误 | 区分错误类型，提供友好提示 | 细粒度错误处理，用户可针对不同情况修复 |
| 认证 401 响应 | 触发 OAuth token 刷新，刷新失败时断开连接 | 自动恢复机制，减少用户手动干预 |
| 无法识别的控制请求子类型 | 返回错误响应 | 防止服务器挂起等待永远不会到来的回复 |

## 6. 现状验收标准

- 会话列表按 lastActiveAt 降序排列，显示格式正确
- 历史消息初始加载 100 条，视口未填满时自动继续加载最多 10 页
- 加载旧消息时保持当前视口位置不变
- viewerOnly 模式下不发送中断，禁用 60s 超时
- GitHub token 正确加密存储，不会在日志中泄露
- 会话连接断开时自动重试
- 网络错误、认证错误、权限请求错误都有相应处理

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 会话选择列表格式 | `src/components/AssistantSessionChooser.tsx` | 无直接覆盖 | 会话列表选择 UI 实现 |
| 历史消息分页策略 | `src/hooks/useAssistantHistory.ts:37-43,214-239` | 无直接覆盖 | 手动验证分页加载逻辑 |
| 只读 Viewer 模式 | `src/utils/remote.ts` | 无直接覆盖 | 手动验证 viewerOnly 模式行为 |
| 滚动锚定实现 | `src/hooks/useAssistantHistory.ts:88-95,198-208` | 无直接覆盖 | 手动验证滚动锚定逻辑 |

### 未覆盖测试
- 会话列表分页加载的边界情况（刚好填满、不足、超过 10 页）
- 网络错误重试机制
- viewerOnly 模式权限请求处理
- Token 加密存储验证

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/assistant-ui.yaml)

相关子系统：
- remote: 复用 RemoteSessionManager 和 SessionsWebSocket
- bridge: daemonBridge 使用 remoteBridgeCore 建立连接
- history.ts: 独立的本地命令历史，与远程会话历史无关
- agent-swarms: 完全分离，Assistant UI 不涉及 agent 执行逻辑
- session-persistence: 不使用，远程会话状态在服务器存储

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|--------|-------|-------|
| P3 | 用户需要从多个会话中找到特定会话，但当前只有会话列表选择，没有搜索过滤功能 | 在会话选择 UI 中添加搜索框，支持按标题、机器名、分支等条件过滤会话列表 | 低 (仅新增 UI，不影响现有功能) | 搜索框正常显示，输入关键词能正确过滤会话列表 | M | 设计推断 |
| P3 | 用户选择会话时希望了解会话的活跃程度和规模，但当前只显示标题、机器名等基本信息 | 在会话列表项中添加会话持续时间和消息计数显示 | 低 | 会话列表项正确显示持续时间和消息计数 | S | 设计推断 |
| P3 | 用户有一些经常访问的重要会话，希望能快速找到，但当前没有标记功能 | 添加会话书签功能，支持标记重要会话，在会话列表中优先显示或单独分组 | 低 | 能成功标记会话为书签，书签会话优先显示 | M | 设计推断 |
| P3 | 用户需要同时处理多个会话，当前切换会话需要重新选择，效率较低 | 实现多标签页式会话管理，支持同时打开多个会话并快速切换 | 中 (涉及会话状态管理，可能影响现有切换逻辑) | 能打开多个会话标签，切换标签时会话状态正确保持 | L | 设计推断 |
| P2 | 网络不稳定时，远程会话历史加载可能失败或缓慢，影响用户体验 | 实现会话历史本地缓存，已加载的历史消息在离线时仍可查看 | 低 (仅新增缓存层，不影响现有加载逻辑) | 断网后仍能查看已加载的历史消息 | M | 设计推断 |
| P3 | 用户有一些不再需要的远程会话，希望能清理，但当前没有删除功能 | 添加会话删除功能，支持从会话列表中删除不需要的远程会话 | 低 (仅新增删除操作，不影响现有会话功能) | 能成功删除会话，删除后会话不再显示在列表中 | S | 设计推断 |
| P3 | 用户希望保存重要会话的历史记录到本地，便于后续查看或分享，但当前没有导出功能 | 添加会话导出功能，支持将会话历史导出为 Markdown 或其他格式的本地文件 | 低 | 能成功导出会话历史到本地文件 | M | 设计推断 |
