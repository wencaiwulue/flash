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
