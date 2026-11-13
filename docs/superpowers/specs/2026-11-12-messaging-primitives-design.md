---
id: messaging-primitives
batch: 7
title: Messaging Primitives 消息寻址、队列与兼容设计
date: 2026-11-12
status: draft
---

# Messaging Primitives 消息寻址、队列与兼容设计

本文档描述 Claude Code 核心消息原语系统的设计，包括消息寻址、队列管理、排序保证、控制消息兼容性以及消息生命周期与错误处理。该系统负责在用户、助手、团队成员和远程组件之间可靠地路由消息。

## 1. 问题与约束

Claude Code 需要一个可靠的消息路由系统来处理多种通信场景，面临的主要问题与约束包括：

- 多地址格式支持：需要同时支持 Unix Domain Socket、bridge 远程通信、团队成员直接寻址等多种方式
- 向后兼容：旧版本客户端发送的控制消息需要被正确理解和处理
- 有序性保证：同一优先级的消息需要按 FIFO 顺序处理
- 响应式更新：需要提供信号机制通知 UI 和其他消费者队列状态变化
- 错误隔离：单一消息处理失败不应影响整个系统
- 跨版本兼容：iOS 旧版本发送的驼峰命名控制消息需要被标准化处理
- 优先级支持：紧急命令需要优先处理，系统通知不应阻塞用户交互
- 可编辑性：用户输入需要支持拉回编辑，系统消息需要保持不可编辑但可见

## 2. 设计理由与备选方案

### 决策 1：地址解析使用 URI 风格前缀 + 旧式路径兼容

实际机制：地址通过 `parseAddress()` 解析，识别 `uds:`、`bridge:` 前缀，对 `/` 开头的旧式路径自动识别为 `uds` 方案。

为什么采用：既提供了清晰的未来扩展路径，又保证了与旧代码的兼容性，避免回复被静默丢弃。

备选方案：
- 仅支持新格式：破坏向后兼容，旧版本无法使用
- 完全无格式：解析逻辑复杂，易出错

代价：需要维护两套格式的识别逻辑。

证据：`src/utils/peerAddress.ts` 中的 `parseAddress()` 函数

### 决策 2：使用单一命令队列而非多专用队列

实际机制：所有命令（用户输入、任务通知、孤儿权限请求、通道消息）都进入单一模块级队列，通过优先级区分处理顺序。

为什么采用：单一队列简化订阅和状态同步逻辑，避免竞态条件，所有消费者看到一致的顺序。

备选方案：
- 多队列（用户/系统/紧急）：订阅复杂，需要协调多队列同步
- 完全无队列：直接处理，无法支持优先级和排序

代价：大队列扫描可能有性能影响，过滤逻辑分散。

证据：`src/utils/messageQueueManager.ts` 中的单一队列实现

### 决策 3：优先级实现为三级排序 + FIFO 保证

实际机制：优先级分为 `now`（0）、`next`（1）、`later`（2）三级，先按优先级排序，同一优先级内按入队顺序 FIFO 处理。

为什么采用：简单直观，满足绝大多数场景需求，队列长度通常很小（< 10），O(n) 扫描可接受。

备选方案：
- 优先队列堆：O(log n) 但实现复杂，丢失 FIFO 顺序
- 三个独立数组：O(1) 查找但代码更多，需要协调

代价：最坏 O(n) 扫描，但实际影响可忽略。

证据：`src/utils/messageQueueManager.ts` 中的 `PRIORITY_ORDER` 映射表

### 决策 4：Mailbox 先匹配等待者再入队

实际机制：`send()` 先尝试匹配等待者，只有无匹配等待者时才入队，等待者通过 `receive()` 获取消息。

为什么采用：等待者通常表示交互式操作（如等待工具确认），优先处理可提升响应性。

备选方案：
- 总是入队，等待者从队列取：严格顺序但等待者延迟增加

代价：可能绕过队列顺序，导致某些消息被延迟。

证据：`src/utils/mailbox.ts` 中的 `send()` 实现

### 决策 5：控制消息键名标准化在接收端处理

实际机制：`normalizeControlMessageKeys()` 就地修改对象，将 `requestId` 复制为 `request_id`，递归处理嵌套的 `response` 对象，蛇形键优先。

为什么采用：iOS 旧版本已发布无法改变，在接收端标准化是唯一可行方案，一次修复所有路径。

备选方案：
- 发送端修复：旧版本仍有问题，依赖发布周期
- 两处都修复：最健壮但重复逻辑

代价：需要记住在所有接收路径调用标准化函数。

证据：`src/utils/controlMessageCompat.ts`

### 决策 6：队列快照不可变以支持 React useSyncExternalStore

实际机制：每次突变时重新创建快照数组，`subscribeToCommandQueue()` 和 `getCommandQueueSnapshot()` 提供兼容接口。

为什么采用：React 生态系统期望不可变状态，复制成本在队列小时可忽略。

备选方案：
- 可变状态 + 版本号：高效但需要手动比较

代价：额外数组分配，但实际影响可忽略。

证据：`src/utils/messageQueueManager.ts` 中的快照管理

## 3. 目标与非目标

### 目标

- 消息寻址：支持 `uds:`、`bridge:`、团队成员名称等多种寻址方式
- 地址兼容：自动识别旧式 `/` 开头路径为 `uds` 方案
- 队列管理：单一队列统一处理所有命令类型
- 优先级：支持三级优先级，`now` > `next` > `later`
- 排序保证：同一优先级内严格 FIFO
- Mailbox：提供同步轮询和异步等待两种消费模式
- 控制消息兼容：自动标准化驼峰/蛇形键名
- 响应式：提供基于信号的变更通知机制
- React 集成：支持 `useSyncExternalStore` 兼容接口
- 错误处理：清晰的错误分类和处理策略

### 非目标

- 不实现分布式消息队列（仅本地进程内）
- 不支持消息持久化（崩溃后丢失）
- 不实现优先级老化机制（`later` 可能饿死）
- 不支持队列大小限制（无驱逐策略）
- 不实现消息确认和重试（发送即丢弃）
- 不支持分布式事务
- 不自动验证地址有效性（延迟到发送时检查）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 地址解析
function parseAddress(address: string): { scheme: string; target: string }

// 团队成员消息
function parseDirectMemberMessage(input: string): { member: string; message: string } | null
function sendDirectMemberMessage(member: string, message: string): SendResult

// 队列操作
function enqueue(command: Command, priority?: Priority): void
function enqueuePendingNotification(notification: Notification): void
function dequeue(): Command | undefined
function dequeueAll(): Command[]
function dequeueAllMatching(predicate: (command: Command) => boolean): Command[]
function peek(): Command | undefined
function remove(command: Command): void
function removeByFilter(predicate: (command: Command) => boolean): void
function clearCommandQueue(): void
function popAllEditable(): { commands: Command[]; input: string }

// React 集成
function subscribeToCommandQueue(callback: () => void): () => void
function getCommandQueueSnapshot(): Command[]

// Mailbox
class Mailbox {
  send(msg: Message): void
  poll(predicate?: (msg: Message) => boolean): Message | undefined
  receive(predicate?: (msg: Message) => boolean): Promise<Message>
  subscribe(callback: () => void): () => void
}

// 控制消息兼容
function normalizeControlMessageKeys(msg: Record<string, unknown>): void

// SDK 消息映射
function toInternalMessages(sdkMessages: SDKMessage[]): InternalMessage[]
function toSDKMessages(internalMessages: InternalMessage[]): SDKMessage[]

// 系统初始化消息
function buildSystemInitMessage(options: InitOptions): SystemMessage
```

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要职责 | 不承担的职责 |
|------|-----------|---------|------------|
| `peerAddress.ts` | 无（纯函数） | 地址解析、方案分类 | 实际消息发送 |
| `directMemberMessage.ts` | 无（纯函数） | 解析 `@agent message` 语法 | 消息投递 |
| `messageQueueManager.ts` | 队列数组、订阅者列表 | 队列操作、快照管理、优先级排序 | 消息执行 |
| `mailbox.ts` | 消息队列、等待者列表、变更信号 | Mailbox 存储、同步/异步消费 | 消息路由 |
| `controlMessageCompat.ts` | 无（纯函数） | 键名标准化、兼容性处理 | 消息业务逻辑 |
| `messages/mappers.ts` | 无（纯函数） | SDK/内部格式转换 | 消息处理 |
| `messages/systemInit.ts` | 无（纯函数） | 构建系统初始化消息 | 会话管理 |

### 4.3 主控制流

#### 地址解析流程

```
输入地址字符串
    ↓
检查前缀 (uds:/bridge:)
    ├─ 匹配 → 返回 { scheme, target }
    └─ 不匹配 → 检查是否 / 开头
                 ├─ 是 → 视为 uds 方案
                 └─ 否 → 视为团队成员名称或旧式路径
```

#### 命令队列流程

```
命令入队（用户输入/通知/通道消息）
    ↓
分配优先级（默认 next）
    ↓
插入队列正确位置（按优先级 + FIFO）
    ↓
触发变更通知
    ↓
消费者 dequeue()（按优先级顺序）
    ↓
处理命令
    ↓
可编辑命令可通过 popAllEditable() 拉回
```

#### Mailbox 消息流程

```
send(msg)
    ↓
尝试匹配等待者（predicate 匹配）
    ├─ 匹配 → 唤醒等待者，直接传递
    └─ 不匹配 → 入队
                 ↓
              触发变更信号
                 ↓
              后续 receive()/poll() 可获取
```

#### 控制消息兼容流程

```
接收控制消息
    ↓
normalizeControlMessageKeys()
    ↓
检查 requestId 存在且 request_id 不存在
    ├─ 是 → 复制值并重命名
    └─ 否 → 跳过
    ↓
递归处理嵌套 response 对象
    ↓
蛇形键优先（两者都存在时不覆盖）
```

---

## 4.4 模块设计卡

### 4.4.1 mailbox.ts

#### 真实入口签名与关键类型

```typescript
export type MessageSource = 'user' | 'teammate' | 'system' | 'tick' | 'task'

export type Message = {
  id: string
  source: MessageSource
  content: string
  from?: string
  color?: string
  timestamp: string
}

type Waiter = {
  fn: (msg: Message) => boolean
  resolve: (msg: Message) => void
}

export class Mailbox {
  // 状态属性
  private queue: Message[] = []
  private waiters: Waiter[] = []
  private changed = createSignal()
  private _revision = 0

  // 公共 API
  get length(): number
  get revision(): number
  send(msg: Message): void
  poll(fn?: (msg: Message) => boolean): Message | undefined
  receive(fn?: (msg: Message) => boolean): Promise<Message>
  subscribe: (callback: () => void) => () => void
}
```

#### 输入输出

| 方法 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `send(msg)` | `Message` | `void` | 入队或唤醒等待者，`_revision++`，触发变更信号 |
| `poll(fn?)` | 可选 predicate 函数 | `Message \| undefined` | 从队列移除匹配消息 |
| `receive(fn?)` | 可选 predicate 函数 | `Promise<Message>` | 立即返回（有匹配）或挂起等待（无匹配） |
| `subscribe(callback)` | 回调函数 | 取消订阅函数 | 注册变更监听器 |

#### 队列/地址/消息状态

- **消息队列**：`private queue: Message[]` — 存储未被消费的消息，FIFO 顺序
- **等待者列表**：`private waiters: Waiter[]` — 挂起的 `receive()` 调用，按注册顺序
- **修订号**：`private _revision: number` — 每次 `send()` 递增，用于检测变更
- **变更信号**：`private changed = createSignal()` — 用于通知订阅者

#### 寻址/排队/发送/接收流程

**发送流程**：
1. `_revision++` 递增修订号
2. 遍历 `waiters` 查找第一个 `fn(msg) === true` 的等待者
3. 找到匹配：
   - 从 `waiters` 移除该等待者
   - 调用 `resolve(msg)` 传递消息
   - 触发变更信号
   - 返回（不入队）
4. 未找到匹配：
   - `queue.push(msg)` 入队
   - 触发变更信号

**接收流程（poll）**：
1. 遍历 `queue` 查找第一个 `fn(msg) === true` 的消息
2. 找到匹配：`splice` 移除并返回
3. 未找到匹配：返回 `undefined`

**接收流程（receive）**：
1. 先尝试 `poll`，有匹配立即返回 `Promise.resolve(msg)`
2. 无匹配：创建新 Promise，将 `{ fn, resolve }` 推入 `waiters`
3. 等待未来 `send()` 唤醒

#### 错误与兼容

- **无超时机制**：`receive()` 返回的 Promise 永不 reject，调用方需自行处理超时
- **无持久化**：进程崩溃丢失队列和等待者，当前无恢复机制
- **无大小限制**：队列可无限增长，无驱逐策略

#### 设计取舍/备选

| 取舍 | 选择 | 理由 | 代价 | 备选 |
|------|------|------|------|------|
| 等待者优先匹配 | `send()` 先匹配等待者再入队 | 低延迟响应交互式等待 | 可能绕过队列顺序 | 总是入队，等待者从队列取 |
| predicate 可选 | 默认 `() => true` | 简化常用场景（接收任意消息） | 无 | 强制要求 predicate |
| 同步 poll + 异步 receive | 双模式 API | 适应不同消费场景 | API 表面较大 | 仅提供一种模式 |

#### 源码测试证据

- **源码位置**：`src/utils/mailbox.ts`
- **关键实现**：`send()` 的等待者匹配逻辑（L34-L46）、`receive()` 的队列检查与等待者注册（L54-L66）
- **当前测试**：无专门测试文件
- **验证点**：等待者优先匹配语义、revision 递增、subscribe 通知

---

### 4.4.2 messageQueueManager.ts

#### 真实入口签名与关键类型

```typescript
// 核心状态
const commandQueue: QueuedCommand[] = []
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const queueChanged = createSignal()

// 优先级映射
const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

// 公共 API — React useSyncExternalStore 兼容
export const subscribeToCommandQueue = queueChanged.subscribe
export function getCommandQueueSnapshot(): readonly QueuedCommand[]

// 公共 API — 读取操作
export function getCommandQueue(): QueuedCommand[]
export function getCommandQueueLength(): number
export function hasCommandsInQueue(): boolean
export function recheckCommandQueue(): void

// 公共 API — 写入操作
export function enqueue(command: QueuedCommand): void
export function enqueuePendingNotification(command: QueuedCommand): void
export function dequeue(filter?: (cmd: QueuedCommand) => boolean): QueuedCommand | undefined
export function dequeueAll(): QueuedCommand[]
export function peek(filter?: (cmd: QueuedCommand) => boolean): QueuedCommand | undefined
export function dequeueAllMatching(predicate: (cmd: QueuedCommand) => boolean): QueuedCommand[]
export function remove(commandsToRemove: QueuedCommand[]): void
export function removeByFilter(predicate: (cmd: QueuedCommand) => boolean): QueuedCommand[]
export function clearCommandQueue(): void
export function resetCommandQueue(): void

// 公共 API — 可编辑命令支持
export function isPromptInputModeEditable(mode: PromptInputMode): mode is EditablePromptInputMode
export function isQueuedCommandEditable(cmd: QueuedCommand): boolean
export function isQueuedCommandVisible(cmd: QueuedCommand): boolean
export function popAllEditable(
  currentInput: string,
  currentCursorOffset: number
): PopAllEditableResult | undefined

export type PopAllEditableResult = {
  text: string
  cursorOffset: number
  images: PastedContent[]
}

// 公共 API — 辅助函数
export function getCommandsByMaxPriority(maxPriority: QueuePriority): QueuedCommand[]
export function isSlashCommand(cmd: QueuedCommand): boolean

// 已弃用的向后兼容别名
export const subscribeToPendingNotifications = subscribeToCommandQueue
export function getPendingNotificationsSnapshot(): readonly QueuedCommand[]
export const hasPendingNotifications = hasCommandsInQueue
export const getPendingNotificationsCount = getCommandQueueLength
export const recheckPendingNotifications = recheckCommandQueue
export function dequeuePendingNotification(): QueuedCommand | undefined
export const resetPendingNotifications = resetCommandQueue
export const clearPendingNotifications = clearCommandQueue
```

#### 输入输出

| 方法 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `enqueue(command)` | `QueuedCommand` | `void` | 推入队列，默认 `priority: 'next'`，记录日志，通知订阅者 |
| `enqueuePendingNotification(command)` | `QueuedCommand` | `void` | 推入队列，默认 `priority: 'later'`，记录日志，通知订阅者 |
| `dequeue(filter?)` | 可选 filter 函数 | `QueuedCommand \| undefined` | 移除并返回最高优先级命令，记录日志，通知订阅者 |
| `dequeueAll()` | 无 | `QueuedCommand[]` | 清空队列，为每个命令记录日志，通知订阅者 |
| `peek(filter?)` | 可选 filter 函数 | `QueuedCommand \| undefined` | 无副作用 |
| `dequeueAllMatching(predicate)` | predicate 函数 | `QueuedCommand[]` | 移除所有匹配命令，记录日志，通知订阅者 |
| `remove(commandsToRemove)` | `QueuedCommand[]` | `void` | 按对象引用移除，记录日志，通知订阅者 |
| `removeByFilter(predicate)` | predicate 函数 | `QueuedCommand[]` | 移除匹配命令，记录日志，通知订阅者 |
| `clearCommandQueue()` | 无 | `void` | 清空队列，通知订阅者 |
| `popAllEditable(currentInput, cursorOffset)` | 当前输入和光标位置 | `PopAllEditableResult \| undefined` | 移走可编辑命令，保留不可编辑命令，合并文本，提取图片，通知订阅者 |
| `getCommandQueueSnapshot()` | 无 | `readonly QueuedCommand[]` | 无副作用（返回不可变快照） |

#### 队列/地址/消息状态

- **命令队列**：`commandQueue: QueuedCommand[]` — 单一模块级队列，包含所有优先级命令
- **不可变快照**：`snapshot: readonly QueuedCommand[]` — `Object.freeze()` 封装，每次突变重新创建
- **变更信号**：`queueChanged = createSignal()` — 用于 React `useSyncExternalStore`
- **优先级排序**：`PRIORITY_ORDER` 映射 `now`(0) > `next`(1) > `later`(2)
- **操作日志**：所有写入操作调用 `logOperation()` 记录到会话存储，含时间戳和 sessionId

#### 寻址/排队/发送/接收流程

**入队流程**：
1. 克隆命令对象，设置默认优先级（`enqueue` → `'next'`，`enqueuePendingNotification` → `'later'`）
2. `commandQueue.push()` 追加到队列（不排序，保持 FIFO）
3. 调用 `notifySubscribers()`：
   - `snapshot = Object.freeze([...commandQueue])` 创建新快照
   - `queueChanged.emit()` 通知订阅者
4. 调用 `logOperation('enqueue', content)` 记录操作

**出队流程（dequeue）**：
1. 遍历队列查找最高优先级命令（尊重 filter）
2. 同一优先级内选最早入队的（FIFO 保证）
3. `splice` 移除该命令
4. 通知订阅者，记录日志
5. 返回命令

**优先级排序规则**：
- 先按优先级数字排序：`now`(0) → `next`(1) → `later`(2)
- 同优先级内按入队顺序（数组索引）FIFO
- `dequeue`/`peek` 每次扫描全队列查找最佳匹配（O(n)，但队列通常很小）

**popAllEditable 流程**：
1. 将队列分为 `editable` 和 `nonEditable` 两组
2. `editable`：`isQueuedCommandEditable(cmd) === true`（非通知模式且非 meta）
3. 提取文本、图片，计算新光标位置
4. 队列替换为仅 `nonEditable`
5. 通知订阅者，记录日志

**next/later 优先级与饥饿**：
- `now`：立即中断，中止当前工具调用
- `next`：当前工具调用结束后，下一 API 往返前发送
- `later`：当前 turn 结束后，作为新 query 处理
- **饥饿风险**：持续 `next` 消息可无限延迟 `later` 消息，当前无老化机制
- **设计意图**：用户交互（`next`）优先于系统通知（`later`）

#### 错误与兼容

- **无队列大小限制**：无内存上限，无驱逐策略
- **无持久化**：崩溃后队列丢失
- **向后兼容别名**：保留 `subscribeToPendingNotifications` 等旧名称，标记 `@deprecated`
- **isHumanTurn 与 SDK mapper 边界**：队列不直接参与 turn 状态管理，`dequeue(filter)` 由调用方在正确时机调用

#### 设计取舍/备选

| 取舍 | 选择 | 理由 | 代价 | 备选 |
|------|------|------|------|------|
| 队列架构 | 单一模块级队列 | 统一订阅，无竞态，简单 | 过滤逻辑分散，需 O(n) 扫描 | 多专用队列（用户/系统/紧急） |
| 优先级实现 | 单数组 + 每次扫描 | 简单，无额外数据结构，FIFO 易保证 | 最坏 O(n) 扫描 | 优先队列堆（丢失 FIFO）或三个独立数组 |
| 快照策略 | 不可变快照 + 每次重新创建 | React useSyncExternalStore 兼容，安全 | 额外数组分配 | 可变状态 + 版本号 |
| 通知模式默认优先级 | `enqueuePendingNotification` → `later` | 避免系统通知阻塞用户交互 | 可能饿死 | 可配置优先级 |
| 可编辑命令分离 | `popAllEditable` 拉回编辑 | 用户体验优化 | 逻辑较复杂 | 无拉回功能 |

#### 源码测试证据

- **源码位置**：`src/utils/messageQueueManager.ts`
- **关键实现**：
  - `dequeue()` 的优先级选择（L167-L193）
  - `notifySubscribers()` 的快照创建（L58-L61）
  - `popAllEditable()` 的可编辑命令分离（L428-L484）
  - `isQueuedCommandEditable()` 的判断逻辑（L359-L361）
- **当前测试**：无专门测试文件
- **验证点**：优先级排序正确性、同优先级 FIFO 保证、快照不可变性、popAllEditable 文本/图片合并

---

### 4.4.3 peerAddress.ts

#### 真实入口签名与关键类型

```typescript
/** Parse a URI-style address into scheme + target. */
export function parseAddress(to: string): {
  scheme: 'uds' | 'bridge' | 'other'
  target: string
}
```

#### 输入输出

| 方法 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `parseAddress(to)` | `string` | `{ scheme: 'uds'\|'bridge'\|'other'; target: string }` | 无 |

#### 队列/地址/消息状态

- **无状态**：纯函数，无内部状态
- **URI 地址方案**：
  - `uds:` → `scheme: 'uds'`，`target` = 前缀后部分
  - `bridge:` → `scheme: 'bridge'`，`target` = 前缀后部分
  - `/` 开头 → `scheme: 'uds'`，`target` = 完整字符串（旧式路径兼容）
  - 其他 → `scheme: 'other'`，`target` = 完整字符串（团队成员名称）

#### 寻址/排队/发送/接收流程

**解析流程**：
1. 检查 `to.startsWith('uds:')` → 匹配返回 `{ scheme: 'uds', target: to.slice(4) }`
2. 检查 `to.startsWith('bridge:')` → 匹配返回 `{ scheme: 'bridge', target: to.slice(7) }`
3. 检查 `to.startsWith('/')` → 匹配返回 `{ scheme: 'uds', target: to }`（旧式路径）
4. 否则返回 `{ scheme: 'other', target: to }`

**设计意图**：
- `parseAddress()` 独立于 `peerRegistry.ts`，避免 `SendMessageTool` 导入时拉取整个 bridge/uds 模块
- 旧式 `/` 开头路径自动识别为 uds，避免旧版本发送者的回复被静默丢弃

#### 错误与兼容

- **不验证目标有效性**：`parseAddress()` 不检查 UDS 路径是否存在、bridge target 是否合法，延迟到实际发送时验证
- **无裸 session-id 回退**：bridge 消息是新功能，无旧发送者，前缀不会劫持类似 `session_manager` 的团队成员名称

#### 设计取舍/备选

| 取舍 | 选择 | 理由 | 代价 | 备选 |
|------|------|------|------|------|
| 模块分离 | `peerAddress.ts` 独立 | SendMessageTool 可只导入解析，不拉取 bridge/uds | 多一个文件 | 合并入 peerRegistry.ts |
| 旧式路径处理 | `/` 开头视为 uds | 向后兼容旧版本发送者 | 需维护两套识别逻辑 | 强制要求 `uds:` 前缀 |
| 解析不验证 | 延迟到发送时检查 | 解析逻辑简单，职责分离 | 错误发现晚 | 解析时验证目标 |

#### 源码测试证据

- **源码位置**：`src/utils/peerAddress.ts`
- **关键实现**：`parseAddress()` 的前缀匹配与旧式路径处理（L8-L21）
- **当前测试**：无专门测试文件
- **验证点**：`uds:`/`bridge:` 前缀识别、`/` 开头旧式路径兼容、其他字符串返回 `other`

---

### 4.4.4 directMemberMessage.ts

#### 真实入口签名与关键类型

```typescript
export function parseDirectMemberMessage(input: string): {
  recipientName: string
  message: string
} | null

export type DirectMessageResult =
  | { success: true; recipientName: string }
  | {
      success: false
      error: 'no_team_context' | 'unknown_recipient'
      recipientName?: string
    }

type WriteToMailboxFn = (
  recipientName: string,
  message: { from: string; text: string; timestamp: string },
  teamName: string
) => Promise<void>

export async function sendDirectMemberMessage(
  recipientName: string,
  message: string,
  teamContext: AppState['teamContext'],
  writeToMailbox?: WriteToMailboxFn
): Promise<DirectMessageResult>
```

#### 输入输出

| 方法 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `parseDirectMemberMessage(input)` | `string` | `{ recipientName, message } \| null` | 无 |
| `sendDirectMemberMessage(recipientName, message, teamContext, writeToMailbox?)` | 接收者名称、消息、团队上下文、可选写入函数 | `Promise<DirectMessageResult>` | 调用 `writeToMailbox()`（成功时） |

#### 队列/地址/消息状态

- **无状态**：纯函数，无内部状态
- **@agent 语法**：`/^@([\w-]+)\s+(.+)$/s` 正则匹配
  - `@agent-name message` → `{ recipientName: 'agent-name', message: 'message' }`
  - `recipientName`：`[\w-]+`（字母、数字、下划线、连字符）
  - `message`：`.+`（任意字符，含换行，`s` 标志）
  - 不匹配 → `null`

#### 寻址/排队/发送/接收流程

**parse 流程**：
1. `/^@([\w-]+)\s+(.+)$/s` 正则匹配
2. 无匹配 → `null`
3. 有匹配：
   - 提取 `recipientName`（组 1）和 `message`（组 2）
   - `message.trim()` 去除首尾空白
   - 修剪后为空 → `null`
   - 否则返回对象

**send 流程**：
1. 检查 `teamContext && writeToMailbox` → 无 → 返回 `{ success: false, error: 'no_team_context' }`
2. 在 `teamContext.teammates` 中查找名称匹配的成员
3. 未找到 → 返回 `{ success: false, error: 'unknown_recipient', recipientName }`
4. 找到 → 调用 `writeToMailbox(recipientName, { from: 'user', text: message, timestamp: new Date().toISOString() }, teamContext.teamName)`
5. 返回 `{ success: true, recipientName }`

#### 错误与兼容

- **无团队上下文**：返回 `no_team_context` 错误
- **未知接收者**：返回 `unknown_recipient` 错误
- **消息修剪后为空**：`parse` 返回 `null`

#### 设计取舍/备选

| 取舍 | 选择 | 理由 | 代价 | 备选 |
|------|------|------|------|------|
| parse 与 send 分离 | 两个独立函数 | 职责清晰，可单独测试 | 调用方需两步 | 合并为一个函数 |
| writeToMailbox 注入 | 作为参数传入 | 依赖注入，可测试，避免循环依赖 | 调用方需提供 | 直接导入实现 |
| recipientName 字符集 | `[\w-]+` | 简单，避免注入 | 限制名称格式 | 更宽松的字符集 |

#### 源码测试证据

- **源码位置**：`src/utils/directMemberMessage.ts`
- **关键实现**：`parseDirectMemberMessage()` 的正则匹配（L6-L20）、`sendDirectMemberMessage()` 的团队成员查找（L39-L69）
- **当前测试**：无专门测试文件
- **验证点**：`@agent message` 语法解析、团队成员查找、错误返回

---

### 4.4.5 controlMessageCompat.ts

#### 真实入口签名与关键类型

```typescript
/**
 * Normalize camelCase `requestId` -> snake_case `request_id` on incoming
 * control messages (control_request, control_response).
 *
 * Older iOS app builds send `requestId` due to a missing Swift CodingKeys
 * mapping. Without this shim, `isSDKControlRequest` in replBridge.ts rejects
 * the message (it checks `'request_id' in value`), and structuredIO.ts reads
 * `message.response.request_id` as undefined — both silently drop the message.
 *
 * If both `request_id` and `requestId` are present, snake_case wins.
 * Mutates the object in place.
 */
export function normalizeControlMessageKeys(obj: unknown): unknown
```

#### 输入输出

| 方法 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `normalizeControlMessageKeys(obj)` | `unknown` | `unknown`（与输入相同对象） | 就地修改对象，重命名 `requestId` → `request_id` |

#### 队列/地址/消息状态

- **无状态**：纯函数，无内部状态
- **requestId → request_id 标准化**：
  - 检查 `'requestId' in obj && !('request_id' in obj)`
  - 是 → `obj.request_id = obj.requestId; delete obj.requestId`
  - 否 → 跳过
  - 递归处理嵌套 `response` 对象
- **蛇形键优先**：两者都存在时，保留 `request_id`，不覆盖

#### 寻址/排队/发送/接收流程

**标准化流程**：
1. 检查 `obj === null \|\| typeof obj !== 'object'` → 是 → 直接返回
2. 检查 `'requestId' in record && !('request_id' in record)` → 是 → 重命名键
3. 检查 `'response' in record && record.response !== null && typeof record.response === 'object'` → 是 → 递归处理 `response`
4. 返回原始对象（已就地修改）

**历史背景**：
- 旧 iOS 版本缺失 Swift CodingKeys 映射，发送 `requestId`（驼峰）而非 `request_id`（蛇形）
- 无此兼容层：
  - `isSDKControlRequest` 检查 `'request_id' in value` 会拒绝消息
  - `structuredIO.ts` 读取 `message.response.request_id` 为 `undefined`
  - 两者都会静默丢弃消息

#### 错误与兼容

- **仅处理 requestId**：不处理其他键名不匹配（如 `sessionId`/`session_id`）
- **就地修改**：直接突变输入对象，无副本
- **非对象/null 安全**：输入为 `null` 或非对象时直接返回

#### 设计取舍/备选

| 取舍 | 选择 | 理由 | 代价 | 备选 |
|------|------|------|------|------|
| 修复位置 | 接收端标准化 | 一次修复所有路径，不依赖发送端更新 | 需记住在所有接收路径调用 | 发送端修复（旧版本仍有问题）或两处都修复 |
| 键名策略 | 蛇形优先，就地修改 | 简单，兼容现有代码 | 突变输入 | 创建新对象 |
| 范围 | 仅 requestId + 嵌套 response | 最小化修复，降低风险 | 未来可能需扩展 | 标准化所有常见键名 |

#### 源码测试证据

- **源码位置**：`src/utils/controlMessageCompat.ts`
- **关键实现**：`normalizeControlMessageKeys()` 的键名重命名与递归处理（L13-L32）
- **当前测试**：无专门测试文件
- **验证点**：`requestId` → `request_id` 重命名、蛇形键优先、嵌套 `response` 处理

---

### 4.4.6 messages/mappers.ts

#### 真实入口签名与关键类型

```typescript
export function toInternalMessages(
  messages: readonly DeepImmutable<SDKMessage>[]
): Message[]

export function toSDKMessages(messages: Message[]): SDKMessage[]

export function toSDKCompactMetadata(meta: CompactMetadata): SDKCompactBoundaryMessage['compact_metadata']
export function fromSDKCompactMetadata(
  meta: SDKCompactBoundaryMessage['compact_metadata']
): CompactMetadata

export function localCommandOutputToSDKAssistantMessage(
  rawContent: string,
  uuid: UUID
): SDKAssistantMessage

export function toSDKRateLimitInfo(
  limits: ClaudeAILimits | undefined
): SDKRateLimitInfo | undefined

// 内部辅助
function normalizeAssistantMessageForSDK(
  message: AssistantMessage
): AssistantMessage['message']
```

#### 输入输出

| 方法 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `toInternalMessages(messages)` | `readonly SDKMessage[]` | `Message[]` | 无 |
| `toSDKMessages(messages)` | `Message[]` | `SDKMessage[]` | 无 |
| `localCommandOutputToSDKAssistantMessage(rawContent, uuid)` | 原始内容、UUID | `SDKAssistantMessage` | 无 |
| `toSDKRateLimitInfo(limits)` | `ClaudeAILimits \| undefined` | `SDKRatesLimitInfo \| undefined` | 无 |

#### 队列/地址/消息状态

- **无状态**：纯函数，无内部状态
- **SDK ↔ 内部消息转换**：
  - `SDKMessage.type: 'assistant'` → `Message.type: 'assistant'`
  - `SDKMessage.type: 'user'` → `Message.type: 'user'`
  - `SDKMessage.type: 'system'` + `subtype: 'compact_boundary'` → `Message.type: 'system'` + `subtype: 'compact_boundary'`
  - 其他 → 过滤
- **本地命令输出特殊处理**：
  - `Message.type: 'system'` + `subtype: 'local_command'` 且含 stdout/stderr → 转换为 `SDKAssistantMessage`
  - 原因：旧版本移动客户端不识别 `system/local_command_output` 子类型，会静默丢弃
  - 见：Android SdkMessageTypes.kt 无 local_command_output handler；api-go session-ingress convertSystemEvent 仅处理 init/compact_boundary
- **ExitPlanModeV2 工具名注入**：
  - `normalizeAssistantMessageForSDK()` 检测工具名为 `ExitPlanModeV2` 时，注入 `plan` 到 `tool_input`
  - 原因：V2 工具从文件读取 plan，但 SDK 用户期望 `tool_input.plan` 存在

#### 寻址/排队/发送/接收流程

**toInternalMessages 流程**：
1. `flatMap` 遍历输入消息
2. `type: 'assistant'` → 转换为内部 `AssistantMessage`
3. `type: 'user'` → 转换为内部 `UserMessage`，`isMeta` 从 `isSynthetic` 映射
4. `type: 'system'` + `subtype: 'compact_boundary'` → 转换为内部 `SystemMessage`，调用 `fromSDKCompactMetadata()`
5. 其他 → 返回空数组（过滤）

**toSDKMessages 流程**：
1. `flatMap` 遍历输入消息
2. `type: 'assistant'` → 调用 `normalizeAssistantMessageForSDK()`，添加 `session_id`/`parent_tool_use_id`/`uuid`/`error`
3. `type: 'user'` → 添加 `session_id`/`parent_tool_use_id`/`uuid`/`timestamp`/`isSynthetic`/`tool_use_result`
4. `type: 'system'` + `subtype: 'compact_boundary'` → 转换为 SDK 格式，调用 `toSDKCompactMetadata()`
5. `type: 'system'` + `subtype: 'local_command'` 且含 stdout/stderr → 调用 `localCommandOutputToSDKAssistantMessage()` 转换为 assistant 消息
6. 其他 → 返回空数组（过滤）

**SDK mapper 边界**：
- 不处理消息执行，仅格式转换
- 不验证消息有效性，仅复制/重命名字段
- 不参与队列管理，独立使用

#### 错误与兼容

- **local_command_output 作为 assistant**：移动客户端兼容性考虑
- **ExitPlanModeV2 plan 注入**：SDK 向后兼容
- **stripAnsi**：去除 `/cost` 等命令输出中的 ANSI 颜色码
- **unwrap XML tags**：去除 `<local-command-stdout>`/`<local-command-stderr>` 包装

#### 设计取舍/备选

| 取舍 | 选择 | 理由 | 代价 | 备选 |
|------|------|------|------|------|
| local_command 子类型处理 | 转换为 assistant 消息 | 兼容旧版本移动客户端/API-Go | 消息类型不匹配 | 引入新 SDK 类型（需等待客户端更新） |
| ExitPlanModeV2 plan 注入 | 发送时注入 tool_input.plan | SDK 用户期望 | 重复逻辑 | V2 工具直接包含 plan 在 tool_input |
| ANSI 去除 + XML unwrap | 发送时清理 | 下游消费者不需处理 | 信息丢失 | 原样发送，下游处理 |

#### 源码测试证据

- **源码位置**：`src/utils/messages/mappers.ts`
- **关键实现**：
  - `toInternalMessages()` 的类型映射（L26-L74）
  - `toSDKMessages()` 的转换逻辑（L115-L181）
  - `localCommandOutputToSDKAssistantMessage()` 的 ANSI 去除与 XML unwrap（L196-L215）
  - `normalizeAssistantMessageForSDK()` 的 ExitPlanModeV2 plan 注入（L260-L290）
- **当前测试**：无专门测试文件
- **验证点**：类型映射正确性、local_command 兼容处理、ExitPlanModeV2 plan 注入

---

### 4.4.7 messages/systemInit.ts

#### 真实入口签名与关键类型

```typescript
// 向后兼容：Task → Agent 工具名重命名
export function sdkCompatToolName(name: string): string

type CommandLike = { name: string; userInvocable?: boolean }

export type SystemInitInputs = {
  tools: ReadonlyArray<{ name: string }>
  mcpClients: ReadonlyArray<{ name: string; type: string }>
  model: string
  permissionMode: PermissionMode
  commands: ReadonlyArray<CommandLike>
  agents: ReadonlyArray<{ agentType: string }>
  skills: ReadonlyArray<CommandLike>
  plugins: ReadonlyArray<{ name: string; path: string; source: string }>
  fastMode: boolean | undefined
}

/**
 * Build the `system/init` SDKMessage — the first message on the SDK stream
 * carrying session metadata (cwd, tools, model, commands, etc.) that remote
 * clients use to render pickers and gate UI.
 *
 * Called from two paths that must produce identical shapes:
 *   - QueryEngine (spawn-bridge / print-mode / SDK) — yielded as the first
 *     stream message per query turn
 *   - useReplBridge (REPL Remote Control) — sent via writeSdkMessages() on
 *     bridge connect, since REPL uses query() directly and never hits the
 *     QueryEngine SDKMessage layer
 */
export function buildSystemInitMessage(inputs: SystemInitInputs): SDKMessage
```

#### 输入输出

| 方法 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `buildSystemInitMessage(inputs)` | `SystemInitInputs` | `SDKMessage` (type: 'system', subtype: 'init') | 无（纯函数） |
| `sdkCompatToolName(name)` | `string` | `string` | 无 |

#### 队列/地址/消息状态

- **无状态**：纯函数，无内部状态
- **system/init 消息字段**：
  - `type: 'system'`
  - `subtype: 'init'`
  - `cwd`：当前工作目录
  - `session_id`：当前会话 ID
  - `tools`：可用工具列表（经 `sdkCompatToolName()` 处理）
  - `mcp_servers`：MCP 服务器列表
  - `model`：当前模型
  - `permissionMode`：权限模式
  - `slash_commands`：用户可调用的斜杠命令
  - `apiKeySource`：API 密钥来源
  - `betas`：启用的 beta 特性
  - `claude_code_version`：版本号
  - `output_style`：输出样式
  - `agents`：可用 agent 类型
  - `skills`：可用 skill 列表
  - `plugins`：可用插件列表
  - `uuid`：随机 UUID
  - `messaging_socket_path`：（feature: UDS_INBOX 时）UDS 通信套接字路径
  - `fast_mode_state`：快速模式状态

#### 寻址/排队/发送/接收流程

**构建流程**：
1. 获取 `settings.outputStyle`、`cwd`、`sessionId`、`apiKeySource`、`betas`、`version` 等全局状态
2. 工具列表经 `sdkCompatToolName()` 处理：`'Agent'` → `'Task'`（向后兼容）
3. 命令/skill 过滤：仅包含 `userInvocable !== false` 的项
4. 构建完整 `SDKMessage` 对象
5. feature: UDS_INBOX 时，动态导入 `udsMessaging` 并添加 `messaging_socket_path`
6. 添加 `fast_mode_state`
7. 返回消息

**双调用路径一致性**：
- QueryEngine（spawn-bridge/print-mode/SDK）：每 query turn 的第一条流消息
- useReplBridge（REPL Remote Control）：bridge 连接时通过 `writeSdkMessages()` 发送
- 两条路径必须产生完全相同的形状

#### 错误与兼容

- **Task → Agent 向后兼容**：PR #19647 将 wire 名从 `Task` 重命名为 `Agent`，但 SDK 消费者在补丁版本上会中断，因此 `sdkCompatToolName()` 继续发送 `'Task'`，直到下一 minor 版本
- **UDS_INBOX 动态导入**：条件性 require，避免不启用该 feature 时拉取依赖

#### 设计取舍/备选

| 取舍 | 选择 | 理由 | 代价 | 备选 |
|------|------|------|------|------|
| 工具名兼容 | sdkCompatToolName 继续发送 'Task' | 避免 SDK 消费者在补丁版本中断 | 需在未来移除 | 直接发送 'Agent' |
| 双路径调用 | 同一函数从两处调用 | 确保形状一致 | 需维护 | 两个独立实现 |
| UDS_INBOX 条件导入 | feature 启用时才 require | 避免不必要的依赖 | 动态导入复杂性 | 始终导入 |

#### 源码测试证据

- **源码位置**：`src/utils/messages/systemInit.ts`
- **关键实现**：
  - `sdkCompatToolName()` 的名称映射（L20-L24）
  - `buildSystemInitMessage()` 的消息构建与双路径兼容（L53-L96）
- **当前测试**：无专门测试文件
- **验证点**：system/init 消息完整性、sdkCompatToolName 映射、双路径一致性

## 5. 失败语义与工程取舍

### 5.1 失败语义

| 场景 | 处理方式 | 影响范围 |
|-----|---------|---------|
| 团队成员未找到 | `sendDirectMemberMessage()` 返回 `unknown_recipient` | 仅该消息失败 |
| 无团队上下文 | 返回 `no_team_context` | 仅该消息失败 |
| UDS 对等方离线 | `sendToUdsSocket()` 抛出错误 | 仅该消息失败 |
| 命令队列为空 | `dequeue()` 返回 undefined | 调用方处理 |
| 队列操作并发 | 模块级状态，操作原子化 | 安全，无竞态 |
| Mailbox 等待超时 | Promise 永不 resolve（需 AbortSignal） | 调用方需处理超时 |
| 控制消息格式错误 | 标准化后仍无法理解时静默忽略 | 仅该消息失败 |
| SDK 映射转换失败 | 记录错误，返回部分转换结果 | 尽量继续 |

### 5.2 工程取舍

| 取舍 | 选择 | 理由 | 代价 |
|-----|------|------|------|
| 队列架构 | 单一队列 | 统一订阅、无竞态、简单 | 过滤分散、大队列扫描 |
| 优先级实现 | 单数组 + 每次扫描 | 简单、无额外数据结构 | 最坏 O(n) 扫描 |
| Mailbox 匹配顺序 | 先匹配等待者再入队 | 低延迟响应等待者 | 可能绕过队列顺序 |
| 兼容性修复位置 | 接收端标准化 | 一次修复所有路径 | 需记住调用 |
| 快照策略 | 不可变快照 | React 兼容、安全 | 额外数组分配 |
| 地址验证时机 | 发送时验证 | 解析逻辑简单 | 错误发现延迟 |
| 优先级数量 | 三级 | 满足需求、简单 | 灵活性有限 |

### 5.3 已知限制

- 优先级反转风险：`later` 优先级消息可能被新的 `next` 消息无限期饿死，当前无老化机制
- 队列无限增长：长时间运行会话可能累积大量未处理命令，当前无队列大小限制或驱逐策略
- Mailbox 无持久化：进程崩溃会丢失邮箱中的消息
- 控制消息标准化仅限 `requestId`：未来可能需要处理其他键名不匹配
- 地址解析不验证目标有效性：`parseAddress()` 不验证目标格式的有效性，错误检测延迟到实际发送时

## 6. 现状验收标准

### 6.1 功能验收标准

- 地址解析正确识别 `uds:`、`bridge:` 前缀
- 旧式 `/` 开头路径被自动识别为 `uds` 方案
- 团队成员名称正确解析，不被误判为方案前缀
- `@agent message` 语法正确解析为成员和消息两部分
- 命令队列支持三级优先级：`now` 最优先，`next` 其次，`later` 最后
- 同一优先级内消息按 FIFO 顺序处理
- `enqueue()`、`dequeue()`、`peek()`、`remove()`、`clearCommandQueue()` 操作行为正确
- `subscribeToCommandQueue()` 和 `getCommandQueueSnapshot()` 提供 React 兼容接口
- `popAllEditable()` 正确提取可编辑命令合并到输入缓冲区
- Mailbox `send()` 正确匹配等待者，无等待者时入队
- Mailbox `poll()` 同步返回或 undefined，`receive()` 返回 Promise
- `normalizeControlMessageKeys()` 正确将 `requestId` 复制为 `request_id`
- `normalizeControlMessageKeys()` 递归处理嵌套 `response` 对象
- 蛇形键优先，两者都存在时不覆盖
- `toInternalMessages()` 和 `toSDKMessages()` 正确转换格式
- `buildSystemInitMessage()` 构造包含工具、MCP 服务器、模型信息等的完整初始化消息

### 6.2 行为验收标准

- 队列订阅者在每次突变时收到通知
- `getCommandQueueSnapshot()` 返回的快照在突变后是新数组
- Mailbox 每次突变触发 `changed` 信号
- 不可编辑的通道消息在队列预览中显示但保持不可编辑状态
- 所有队列修改操作都记录到会话存储（含时间戳和会话 ID）
- 系统初始化消息从 QueryEngine 和 useReplBridge 两个路径调用时产生完全相同的形状
- 本地命令输出转换为 SDK 的 `assistant` 类型而非专用类型

## 7. 代码与测试证据

### 7.1 关键代码证据

地址解析：
- `src/utils/peerAddress.ts`：`parseAddress()` 实现

团队成员消息：
- `src/utils/directMemberMessage.ts`：`parseDirectMemberMessage()` 和 `sendDirectMemberMessage()`

命令队列管理：
- `src/utils/messageQueueManager.ts`：队列操作、优先级排序、订阅管理、快照生成

Mailbox：
- `src/utils/mailbox.ts`：Mailbox 类实现、消息存储、等待者匹配、信号通知

控制消息兼容：
- `src/utils/controlMessageCompat.ts`：`normalizeControlMessageKeys()` 实现

SDK 消息映射：
- `src/utils/messages/mappers.ts`：`toInternalMessages()`、`toSDKMessages()`

系统初始化消息：
- `src/utils/messages/systemInit.ts`：`buildSystemInitMessage()`

### 7.2 测试覆盖现状

现有测试：当前无专门的 messaging-primitives 测试文件，相关测试可能包含在其他模块中

未覆盖场景：
- 地址解析的各种边界情况（空字符串、无效前缀、混合格式）
- 命令队列优先级排序正确性（尤其是同优先级 FIFO 保证）
- Mailbox 等待者匹配逻辑（predicate 匹配、超时处理）
- 控制消息键名标准化的完整路径（包括嵌套 response）
- SDK/内部消息转换的边界情况
- React 集成的并发订阅场景
- 队列操作的日志记录完整性
- 错误路径的完整覆盖（团队成员未找到、无团队上下文、UDS 离线等）

## 8. 文件覆盖与相关子系统

### 8.1 源文件覆盖

| 文件 | 主要职责 | 公开接口 |
|------|---------|---------|
| `src/utils/peerAddress.ts` | 地址解析 | `parseAddress()` |
| `src/utils/directMemberMessage.ts` | 团队成员消息解析 | `parseDirectMemberMessage()`, `sendDirectMemberMessage()` |
| `src/utils/messageQueueManager.ts` | 命令队列管理 | `enqueue()`, `dequeue()`, `peek()`, `remove()`, `clearCommandQueue()`, `popAllEditable()`, `subscribeToCommandQueue()`, `getCommandQueueSnapshot()` |
| `src/utils/mailbox.ts` | Mailbox 实现 | `Mailbox` 类 |
| `src/utils/controlMessageCompat.ts` | 控制消息兼容性 | `normalizeControlMessageKeys()` |
| `src/utils/messages/mappers.ts` | SDK 消息映射 | `toInternalMessages()`, `toSDKMessages()` |
| `src/utils/messages/systemInit.ts` | 系统初始化消息 | `buildSystemInitMessage()` |

### 8.2 相关子系统

- 会话存储：用于队列操作日志记录
- 团队协作：使用直接成员消息功能
- Bridge 通信：使用 `bridge:` 地址方案
- UDS 通信：使用 `uds:` 地址方案
- QueryEngine：使用系统初始化消息和 SDK 映射
- React UI：使用队列订阅和快照接口

[Coverage](../../architecture/coverage/messaging-primitives.yaml)

## 9. 改进建议

### 9.1 短期改进

- 为消息原语系统增加完整的单元测试覆盖，重点测试优先级排序、FIFO 保证、地址解析边界情况
- 增加优先级老化机制，防止 `later` 消息被无限期饿死（如等待超过 N 分钟自动提升优先级）
- 实现队列大小限制和驱逐策略，防止长时间运行会话累积过多未处理命令
- 为 Mailbox `receive()` 增加超时参数支持，避免 Promise 永久挂起
- 扩展控制消息标准化，支持更多常见键名不匹配（如 `sessionId`/`session_id` 等）
- 在地址解析时增加基本格式验证，提前发现明显错误而非延迟到发送时

### 9.2 中期改进

- 考虑实现 Mailbox 持久化机制，允许进程崩溃后恢复未处理消息
- 增加队列指标收集（队列长度、等待时间、优先级分布等）
- 实现消息追踪机制，便于调试消息路由问题
- 考虑支持更灵活的优先级系统（如动态优先级、自定义优先级级别）
- 增加地址验证函数，允许在解析时验证目标有效性
- 实现队列操作的事务支持，确保多个操作的原子性

### 9.3 长期考虑

- 评估是否需要分布式消息队列支持（多进程/多机器场景）
- 考虑实现消息确认和重试机制，提高可靠性
- 探索端到端加密的消息传递方案
- 考虑支持消息过滤器和拦截器，允许中间件扩展
- 评估是否需要支持消息优先级动态调整
- 探索响应式流（Reactive Streams）标准兼容的接口设计
