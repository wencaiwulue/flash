---
id: messaging-primitives
batch: 7
title: Messaging Primitives 消息寻址、队列与兼容设计
date: 2026-11-12
status: draft
---

## 1. 概述

本文档描述 Claude Code 核心消息原语系统的设计，包括消息寻址、队列管理、排序保证、控制消息兼容性以及消息生命周期与错误处理。该系统负责在用户、助手、团队成员和远程组件之间可靠地路由消息。

### 1.1 设计原则

- **分离关注点**：消息路由、队列管理和兼容性处理分别在独立模块中实现
- **向后兼容**：新特性上线时保留对旧版本消息格式的支持
- **有序性**：在同一优先级内保证消息的 FIFO 顺序
- **响应式**：提供基于信号的变更通知机制

## 2. 消息寻址设计

### 2.1 地址格式

Claude Code 支持多种寻址方案，通过 URI 风格的前缀区分：

| 方案 | 格式 | 用途 |
|------|------|------|
| `uds:` | `uds:<socket-path>` | Unix Domain Socket 本地进程间通信 |
| `bridge:` | `bridge:<target>` | 通过 Bridge 服务的远程通信 |
| `other` | 任意字符串 | 团队成员名称或旧式路径 |

### 2.2 地址解析

地址解析由 `peerAddress.ts` 中的 `parseAddress()` 函数处理：

```
输入 → 检查前缀 → 分类方案 → 返回{scheme, target}
         ↓
      旧式路径(/开头) → 视为 uds 方案
```

**设计决策**：对于以 `/` 开头的旧式路径，自动识别为 `uds` 方案。这确保旧代码的发送者发出的消息能被正确路由，避免回复被静默丢弃。

### 2.3 团队成员直接消息

用户可通过 `@agent-name message` 语法直接向团队成员发送消息：

- 解析由 `directMemberMessage.ts` 中的 `parseDirectMemberMessage()` 处理
- 消息绕过模型，直接写入目标成员的邮箱
- 要求存在有效的团队上下文和已知的收件人名称

## 3. 队列与排序设计

### 3.1 统一命令队列

系统使用单一模块级队列（`messageQueueManager.ts`）处理所有命令：

- 用户输入
- 任务通知
- 孤儿权限请求
- 通道消息

**设计决策**：使用单一队列而非多个专用队列，简化订阅和状态同步逻辑，避免竞态条件。

### 3.2 优先级系统

队列支持三级优先级，决定出队顺序：

| 优先级 | 值 | 用途 |
|--------|-----|------|
| `now` | 0 | 紧急命令，立即处理 |
| `next` | 1 | 用户输入，默认优先级 |
| `later` | 2 | 系统通知，不阻塞用户交互 |

**排序规则**：
1. 先按优先级从高到低排序（0 → 1 → 2）
2. 同一优先级内按入队顺序 FIFO 处理

### 3.3 React 集成

队列提供 `useSyncExternalStore` 兼容接口：

- `subscribeToCommandQueue()`: 订阅变更通知
- `getCommandQueueSnapshot()`: 获取不可变快照
- 快照在每次突变时重新创建，确保 React 能检测到变化

### 3.4 队列操作

| 操作 | 描述 | 日志记录 |
|------|------|----------|
| `enqueue()` | 添加命令，默认为 `next` 优先级 | 是 |
| `enqueuePendingNotification()` | 添加通知，默认为 `later` 优先级 | 是 |
| `dequeue()` | 移除并返回最高优先级命令 | 是 |
| `dequeueAll()` | 清空队列并返回所有命令 | 每条都记录 |
| `dequeueAllMatching()` | 移除并返回匹配谓词的命令 | 每条都记录 |
| `peek()` | 查看最高优先级命令不移除 | 否 |
| `remove()` | 按引用移除特定命令 | 是 |
| `removeByFilter()` | 按谓词移除命令 | 是 |
| `clearCommandQueue()` | 清空队列（如 ESC 取消） | 否 |
| `popAllEditable()` | 提取可编辑命令合并到输入缓冲区 | 是 |

### 3.5 可编辑性与可见性

队列命令分两类：

- **可编辑**：可被拉回输入缓冲区（普通用户输入）
- **不可编辑**：系统生成消息（包含原始 XML），不应泄漏给用户编辑

**设计决策**：即使不可编辑的通道消息也在队列预览中显示（让键盘用户知道消息到达），但保持不可编辑状态。

## 4. Mailbox 邮箱设计

### 4.1 Mailbox 类结构

`Mailbox` 类（`mailbox.ts`）提供简单的消息存储与等待机制：

```typescript
class Mailbox {
  private queue: Message[]
  private waiters: Waiter[]
  private changed: Signal
  
  send(msg: Message): void
  poll(fn?: Predicate): Message | undefined
  receive(fn?: Predicate): Promise<Message>
  subscribe: Signal['subscribe']
}
```

### 4.2 消息等待模式

`Mailbox` 支持两种消费模式：

1. **同步轮询**：`poll()` 立即返回或 undefined
2. **异步等待**：`receive()` 返回 Promise，消息到达时解析

**设计决策**：`send()` 先尝试匹配等待者，只有无匹配等待者时才入队。这确保高优先级等待者能立即获得消息，而不是排在队列后面。

### 4.3 变更通知

每次队列突变都会触发 `changed` 信号，支持响应式 UI 更新。同时维护 `revision` 计数器用于快速检测变更。

## 5. 控制消息兼容性设计

### 5.1 键名标准化

`controlMessageCompat.ts` 解决旧版 iOS 应用发送的控制消息键名不匹配问题：

- 问题：旧版发送 `requestId`（驼峰），但系统期望 `request_id`（蛇形）
- 影响：`isSDKControlRequest` 拒绝消息，`structuredIO.ts` 读取 undefined
- 解决方案：`normalizeControlMessageKeys()` 就地修改对象

**标准化规则**：
1. 若 `requestId` 存在且 `request_id` 不存在，复制值并重命名
2. 递归处理嵌套的 `response` 对象
3. 若两者都存在，蛇形键优先

### 5.2 SDK 消息映射

`messages/mappers.ts` 处理内部格式与 SDK 格式之间的转换：

- `toInternalMessages()`: SDK → 内部
- `toSDKMessages()`: 内部 → SDK
- 处理 `compact_boundary` 消息的元数据映射
- 处理工具名称兼容性（`Agent` ↔ `Task`）

**设计决策**：本地命令输出转换为 SDK 的 `assistant` 类型而非专用类型。这是因为 `system/local_command_output` 子类型不为下游消费者所知。

### 5.3 系统初始化消息

`messages/systemInit.ts` 构建会话初始元数据消息：

- 工具列表
- MCP 服务器
- 模型信息
- 权限模式
- Slash 命令
- 版本信息
- 输出样式
- Fast Mode 状态

**设计决策**：从两个路径调用（QueryEngine 和 useReplBridge），要求产生完全相同的形状以确保一致性。

## 6. 消息生命周期与错误处理

### 6.1 队列操作日志

所有队列修改操作都记录到会话存储：

- `enqueue`: 记录内容（字符串类型）
- `dequeue`: 记录操作
- `remove`: 记录操作
- `popAll`: 记录操作和内容

日志包含时间戳和会话 ID，用于调试和审计。

### 6.2 错误路径

| 场景 | 处理方式 |
|------|----------|
| 团队成员未找到 | `sendDirectMemberMessage()` 返回 `unknown_recipient` |
| 无团队上下文 | 返回 `no_team_context` |
| UDS 对等方离线 | `sendToUdsSocket()` 抛出错误 |
| 命令队列空 | `dequeue()` 返回 undefined |

### 6.3 消息幂等性

- `dequeue()` 若队列为空返回 undefined，可安全重复调用
- `remove()` 若命令不在队列中无操作
- `clearCommandQueue()` 重复调用无害

## 7. 设计决策详述

### 决策 1：单一队列 vs 多队列

| 选项 | 优点 | 缺点 |
|------|------|------|
| **单一队列**（采用） | 统一订阅点、无竞态、简单 | 过滤逻辑分散、大队列扫描 |
| 多队列（用户/系统/紧急） | 清晰分离、无需过滤 | 订阅复杂、需协调多队列 |

**证据**：现有代码显示大多数消费者需要查看所有类型的命令（REPL、UI、SDK），单一队列降低集成复杂度。

### 决策 2：优先级实现方式

| 选项 | 优点 | 缺点 |
|------|------|------|
| **单数组 + 每次扫描**（采用） | 简单、无额外数据结构 | 最坏 O(n) 扫描 |
| 三个独立数组 | O(1) 查找 | 更多代码、需协调 |
| 优先队列堆 | O(log n) | 实现复杂、丢失 FIFO |

**证据**：实际队列长度很小（通常 < 10），O(n) 扫描可接受。当前实现 `PRIORITY_ORDER` 映射表清晰。

### 决策 3：Mailbox 先匹配等待者

| 选项 | 优点 | 缺点 |
|------|------|------|
| **先匹配等待者**（采用） | 低延迟响应等待者 | 可能绕过队列顺序 |
| 始终入队，等待者从队列取 | 严格顺序 | 等待者延迟增加 |

**证据**：等待者通常表示交互式操作（如等待工具确认），优先处理可提升响应性。

### 决策 4：控制消息键名标准化位置

| 选项 | 优点 | 缺点 |
|------|------|------|
| **接收端标准化**（采用） | 一次修复所有路径 | 需记住调用 |
| 发送端修复 | 旧版本仍有问题 | 依赖发布周期 |
| 两处都修复 | 最健壮 | 重复逻辑 |

**证据**：iOS 旧版本已发布无法改变，在接收端标准化是唯一可行方案。

### 决策 5：队列快照不可变

| 选项 | 优点 | 缺点 |
|------|------|------|
| **不可变快照**（采用） | React useSyncExternalStore 兼容、安全 | 额外数组分配 |
| 可变状态 + 版本号 | 高效 | 需要手动比较 |

**证据**：React 生态系统期望不可变状态，复制成本在队列小时可忽略。

## 8. 覆盖率

见 [Coverage](../../architecture/coverage/messaging-primitives.yaml)。

## 9. 边界疑虑与未解决问题

1. **优先级反转风险**：`later` 优先级消息可能被新的 `next` 消息无限期饿死。当前无老化机制。
2. **队列无限增长**：长时间运行会话可能累积大量未处理命令。当前无队列大小限制或驱逐策略。
3. **Mailbox 无持久化**：进程崩溃会丢失邮箱中的消息。
4. **控制消息标准化仅限 requestId**：未来可能需要处理其他键名不匹配。
5. **地址解析无验证**：`parseAddress()` 不验证目标格式的有效性，错误检测延迟到实际发送时。
