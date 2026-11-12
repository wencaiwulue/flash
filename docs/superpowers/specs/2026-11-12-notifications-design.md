---
id: notifications
batch: 3
title: Notifications 后台通知、折叠与用户可见性设计
date: 2026-11-12
status: draft
---

## 1. 概述

通知系统是 Claude Code 的用户反馈核心，提供三类互补的通知能力：
- **横幅通知**：顶部弹窗，用于重要状态变更（fast mode、权限问题、速率限制等）
- **OS 通知**：通过终端原生通知系统（iTerm2、Kitty、Ghostty、Apple Terminal bell）或 webhook 发送
- **任务通知**：内联在对话流中，用于后台命令完成、插件安装等状态更新

通知系统同时处理去重、折叠、优先级排序和降级策略，在不干扰用户的同时保证重要信息可见。

## 2. 架构与组件

### 2.1 横幅通知架构

横幅通知采用队列 + 当前展示的双层结构：

```
useNotifications() Hook
  ├─ addNotification()
  │   ├─ immediate 优先级：立即替换当前，重新计时
  │   ├─ 非 immediate：检查 fold、invalidates、去重
  │   └─ 加入队列，触发 processQueue()
  ├─ removeNotification()
  │   └─ 从队列或当前移除，触发 processQueue()
  └─ processQueue()
      ├─ 当前为空且队列非空：取出最高优先级，设置 timeout
      └─ timeout 到期：清除当前，继续处理队列

AppState: notifications
  ├─ current: Notification | null
  └─ queue: Notification[]
```

**核心组件：**
- `notifications.tsx`：`useNotifications()` hook、`getNext()` 优先级选择器
- 优先级：`immediate`（最高）> `high` > `medium` > `low`（最低）
- 支持 `invalidates`：添加新通知时移除指定 keys 的通知
- 支持 `fold`：相同 key 的通知可合并（类似 reduce）

### 2.2 OS 通知架构

OS 通知通过多通道分发，支持配置和自动检测：

```
sendNotification()
  ├─ executeNotificationHooks()：先执行用户配置的 hooks
  └─ sendToChannel()
      ├─ auto：自动检测终端类型选择最优方案
      ├─ iterm2：使用 iTerm2 专有通知
      ├─ iterm2_with_bell：iTerm2 通知 + 响铃
      ├─ kitty：使用 Kitty 终端通知
      ├─ ghostty：使用 Ghostty 终端通知
      ├─ terminal_bell：仅响铃（Apple Terminal 降级方案）
      └─ notifications_disabled：完全禁用
```

**核心组件：**
- `notifier.ts`：`sendNotification()`、`sendToChannel()`、`sendAuto()`
- `PushNotificationTool.ts`：工具定义，支持 `CLAUDE_NOTIFICATION_WEBHOOK_URL` 或 `context.sendOSNotification`
- `useTerminalNotification`：终端通知接口（iTerm2/Kitty/Ghostty 的具体实现由 Ink 层提供）

### 2.3 任务通知折叠架构

后台任务通知在消息渲染时折叠，减少视觉噪声：

```
collapseBackgroundBashNotifications()
  ├─ fullscreen 模式检查：非 fullscreen 直接返回
  ├─ verbose 模式检查：verbose 直接返回
  └─ 扫描消息序列
      ├─ 识别连续的完成背景 bash 任务通知
      ├─ 单条任务：原样保留
      └─ N 条任务（N>1）：合成为单条 "N background commands completed" 通知
```

**核心组件：**
- `collapseBackgroundBashNotifications.ts`：折叠逻辑
- `constants/xml.ts`：`TASK_NOTIFICATION_TAG`、`STATUS_TAG`、`SUMMARY_TAG` 标签定义
- `LocalShellTask/...`：`BACKGROUND_BASH_SUMMARY_PREFIX` 常量标识后台 bash 任务

### 2.4 通知来源

通知来自以下几类：

| 来源 | 示例 Hook/代码 | 用途 |
|------|----------------|------|
| **启动通知** | `useStartupNotification.ts` | 一次性通知基础设施，被其他 hooks 复用 |
| **Fast Mode** | `useFastModeNotification.tsx` | fast mode 可用性、冷却、超量使用 |
| **速率限制** | `useRateLimitWarningNotification.tsx` | 额度接近、进入超量模式 |
| **设置错误** | `useSettingsErrors.tsx` | 配置验证失败 |
| **MCP** | `useMcpConnectivityStatus.tsx` | MCP 连接失败、需要认证 |
| **LSP** | `useLspInitializationNotification.tsx` | LSP 服务器错误 |
| **插件** | `usePluginInstallationStatus.tsx`、`usePluginAutoupdateNotification.tsx` | 安装失败、更新可用 |
| **IDE** | `useIDEStatusIndicator.tsx` | IDE 连接状态 |
| **模型迁移** | `useModelMigrationNotifications.tsx` | 模型版本迁移提示 |
| **npm 弃用** | `useNpmDeprecationNotification.tsx` | 过时 npm 包警告 |
| **Ant Org** | `useAntOrgWarningNotification.ts` | Anthropic 组织配置警告 |
| **Auto Mode** | `useAutoModeUnavailableNotification.ts` | auto mode 不可用提示 |
| **队友关闭** | `useTeammateShutdownNotification.ts` | agent swarm 队友关闭 |
| **订阅切换** | `useCanSwitchToExistingSubscription.tsx` | 订阅变更提示 |

### 2.5 通知 Hook 模式

大多数通知 hooks 遵循统一模式：

```typescript
// 1. 获取 addNotification
const { addNotification } = useNotifications()

// 2. 检查远程模式：远程模式不显示通知
if (getIsRemoteMode()) return

// 3. 监听相关状态变化
useEffect(() => {
  if (condition) {
    addNotification({
      key: 'unique-key',           // 唯一标识，用于去重/移除
      priority: 'medium',          // 优先级
      text: 'message',             // 或 jsx: <Text>...</Text>
      color: 'warning',            // 可选颜色
      timeoutMs: 8000,             // 可选超时，默认 8000ms
      invalidates: ['other-key'],  // 可选，使其他通知失效
      fold: (acc, inc) => merged,  // 可选，合并相同 key 的通知
    })
  }
}, [addNotification, dependencies])
```

## 3. 横幅通知生命周期

### 3.1 添加通知

添加流程：
1. **Immediate 优先级判断**：
   - 清除当前 timeout（如果存在）
   - 设置新 notification 为 current
   - 重新设置 timeout
   - 将原 current（非 immediate）和队列一起过滤（排除 immediate 和被 invalidates 的）后重新入队
2. **非 Immediate 处理**：
   - **Fold 检查**：如果新通知有 `fold` 函数，检查当前和队列中是否有相同 key 的通知
     - 当前匹配：调用 `fold(current, new)` 更新当前，重置 timeout
     - 队列匹配：调用 `fold(queued, new)` 更新队列项
   - **去重检查**：检查当前和队列中是否已有相同 key 的通知，有则跳过
   - **Invalidates 处理**：从队列移除被 invalidates 的通知，如果 invalidates 当前且当前存在，则清除当前（及其 timeout）
   - **加入队列**：将新通知加入队尾
3. **触发 processQueue()**

### 3.2 超时与队列处理

`processQueue()` 流程：
1. 如果 `current` 不为空或队列为空，直接返回
2. 使用 `getNext()` 从队列取出最高优先级通知
3. 设置 timeout（`timeoutMs` 或默认 8000ms）
4. 将通知移至 `current`
5. Timeout 到期时：
   - 再次检查 key 匹配（防止被替换）
   - 清空 `current`
   - 递归调用 `processQueue()`

### 3.3 移除通知

移除流程：
1. 检查 key 是否在 `current` 或队列中
2. 如果是 `current`，清除 timeout
3. 从 `current`（匹配时）或队列移除该 key
4. 触发 `processQueue()`

### 3.4 优先级选择

`getNext()` 按以下顺序选择：
- `immediate`（0）> `high`（1）> `medium`（2）> `low`（3）
- 同优先级时选择先入队者

## 4. OS 通知分发与降级

### 4.1 通道选择

通道选择优先级（配置 `preferredNotifChannel`）：

| 配置值 | 行为 |
|--------|------|
| `auto` | 根据 `env.terminal` 自动选择：iTerm.app → iterm2，kitty → kitty，ghostty → ghostty，Apple_Terminal → 检查 bell 配置 |
| `iterm2` | iTerm2 通知 |
| `iterm2_with_bell` | iTerm2 通知 + 响铃 |
| `kitty` | Kitty 通知 |
| `ghostty` | Ghostty 通知 |
| `terminal_bell` | 仅响铃 |
| `notifications_disabled` | 无通知 |

### 4.2 Apple Terminal 特殊处理

Apple Terminal 不支持现代通知，因此：
1. 尝试读取当前 profile（通过 AppleScript）
2. 读取 Terminal 配置 plist（`~/Library/Preferences/com.apple.Terminal.plist`）
3. 检查当前 profile 的 `Bell` 设置
4. 如果 bell 已禁用，发送 bell（因为用户听不到，所以此时发送反而可让终端弹出 Badge）
5. 任何步骤失败则不发送通知

### 4.3 PushNotificationTool 双路径

`PushNotificationTool` 按以下顺序尝试：
1. **Webhook 优先**：如果 `CLAUDE_NOTIFICATION_WEBHOOK_URL` 存在，发送 POST 请求（JSON 包含 `text`、`title`、`url`）
2. **OS 通知备选**：如果 `context.sendOSNotification` 存在，调用终端通知
3. **失败抛出**：两者都不可用时抛出错误

Webhook 请求：
- 超时 10 秒
- 支持 `context.abortController` 取消
- 仅检查 HTTP 状态码 <200 或 >=300 算失败
- 失败时抛出错误，不自动降级到 OS 通知

### 4.4 通知钩子

`executeNotificationHooks()` 在任何通知发送前调用，允许用户脚本拦截或修改通知。

## 5. 任务通知折叠

### 5.1 折叠条件

`collapseBackgroundBashNotifications()` 仅在以下条件满足时工作：
- `isFullscreenEnvEnabled()` 为 true（全屏/REPL 模式）
- `verbose` 为 false（非 verbose 模式）

### 5.2 通知识别

后台 bash 任务通知识别：
1. 消息类型为 `user`
2. 内容包含 `<task-notification>` 标签
3. `<status>` 为 `completed`（失败/终止不折叠）
4. `<summary>` 以 `BACKGROUND_BASH_SUMMARY_PREFIX` 开头（区分于 agent/workflow/monitor 通知）

### 5.3 折叠策略

折叠策略：
- **单条任务**：原样保留，不折叠
- **连续 N 条（N>1）**：
  - 合成为一条新任务通知
  - status 仍为 `completed`
  - summary 为 `"N background commands completed"`
  - 复用第一条消息的其他属性

### 5.4 去重与可见性

其他去重机制：
- **横幅通知**：通过 `key` 去重，相同 key 只保留一个
- **LSP 通知**：`notifiedErrorsRef` 记录已通知的错误，避免重复提示
- **速率限制通知**：`shownWarningRef` 记录已显示的警告文本，避免重复
- **Overage 通知**：`hasShownOverageNotification` 状态确保只显示一次

## 6. 权限与隐私

### 6.1 远程模式静默

所有通知 hooks 都检查 `getIsRemoteMode()`，在远程模式下不显示任何横幅通知。

### 6.2 配置权限

通知配置存储在全局配置中：
- `preferredNotifChannel`：用户选择的通知通道
- 修改配置需要标准设置权限

### 6.3 Webhook 安全

`CLAUDE_NOTIFICATION_WEBHOOK_URL` 来自环境变量：
- 不记录或持久化 webhook URL
- 仅发送用户通过工具明确请求的通知内容
- 不自动发送系统内部通知到 webhook

### 6.4 终端通知安全

终端通知（iTerm2/Kitty/Ghostty）：
- 通过终端的标准通知机制发送
- 不包含敏感上下文（仅用户通过工具明确提供的 message/title）
- 不持久化通知历史

## 7. 设计决策

### 决策 1：单横幅 + 队列而非多横幅堆叠

| 维度 | 说明 |
|------|------|
| **决策** | 同一时间只显示一条横幅通知，其余入队按优先级展示 |
| **备选** | 多横幅堆叠显示（最多 N 条），或使用 toast 中心 |
| **代价** | 低优先级通知可能延迟显示，队列管理增加复杂性 |
| **证据** | `src/context/notifications.tsx:54-93` `processQueue()`、`src/context/notifications.tsx:307-312` `getNext()` |
| **理由** | 终端垂直空间有限，多横幅会遮挡对话内容；单横幅 + 优先级保证重要信息及时可见 |

### 决策 2：Immediate 优先级立即抢占并重新入队

| 维度 | 说明 |
|------|------|
| **决策** | Immediate 通知立即替换当前，原 current（非 immediate）重新入队 |
| **备选** | Immediate 仅插入队首，或等待当前超时 |
| **代价** | 用户可能错过被替换的通知 |
| **证据** | `src/context/notifications.tsx:98-151` immediate 分支、`src/hooks/notifs/useFastModeNotification.tsx:45-49,70-75` 使用 immediate |
| **理由** | Immediate 用于需要立即注意的事件（fast mode 不可用、进入超量），优先保证这类信息可见 |

### 决策 3：Fold 合并相同 key 通知而非替换

| 维度 | 说明 |
|------|------|
| **决策** | 提供 `fold` 函数支持通知合并（类似 reduce），更新时重置 timeout |
| **备选** | 直接替换旧通知，或累积显示多条 |
| **代价** | 调用方需实现 fold 逻辑，增加复杂度 |
| **证据** | `src/context/notifications.tsx:157-216` fold 处理 |
| **理由** | 某些通知（如进度）适合合并更新而非多条显示；重置 timeout 确保用户有足够时间读取更新 |

### 决策 4：Invalidates 机制主动移除过时通知

| 维度 | 说明 |
|------|------|
| **决策** | 通知可携带 `invalidates` 数组，添加时自动移除指定 keys 的通知 |
| **备选** | 等待自然超时，或调用方手动 `removeNotification` |
| **代价** | 增加状态更新分支，需要仔细处理 |
| **证据** | `src/context/notifications.tsx:228-234` invalidates 处理、`src/hooks/notifs/useFastModeNotification.tsx:82-83,91` 使用 invalidates |
| **理由** | 状态互斥时（如"冷却开始"和"冷却结束"），显示两者会造成混淆；主动移除避免过时信息 |

### 决策 5：后台任务通知只折叠成功完成

| 维度 | 说明 |
|------|------|
| **决策** | `collapseBackgroundBashNotifications()` 只折叠 status=completed 的后台 bash 任务通知 |
| **备选** | 折叠所有任务通知，或不分状态折叠 |
| **代价** | 失败任务仍可能造成视觉噪声 |
| **证据** | `src/utils/collapseBackgroundBashNotifications.ts:22` 检查 status、`src/utils/collapseBackgroundBashNotifications.ts:41-84` 折叠逻辑 |
| **理由** | 失败/终止需要用户注意，不应折叠；成功完成是高频低价值事件，适合合并以减少噪声 |

### 决策 6：Apple Terminal 禁用 bell 时反而发送 bell

| 维度 | 说明 |
|------|------|
| **决策** | Apple Terminal 检测到当前 profile bell 已禁用时，发送 bell |
| **备选** | 完全不发送，或无论配置都发送 |
| **代价** | 逻辑反直觉，需要解释 |
| **证据** | `src/services/notifier.ts:110-161` `isAppleTerminalBellDisabled()`、`src/services/notifier.ts:83-103` `sendAuto()` |
| **理由** | Apple Terminal bell 禁用时通常开启了"视觉 bell"或 Dock badge；此时发送 bell 会触发 badge，是最接近通知的体验 |

### 决策 7：PushNotificationTool webhook 失败不自动降级到 OS 通知

| 维度 | 说明 |
|------|------|
| **决策** | webhook 配置但请求失败时，直接抛出错误，不回退到 OS 通知 |
| **备选** | 自动降级到 OS 通知，或静默失败 |
| **代价** | 用户可能预期通知能送达，实际未送达 |
| **证据** | `src/tools/PushNotificationTool/PushNotificationTool.ts:47-51` webhook 失败抛出、`src/tools/PushNotificationTool/PushNotificationTool.ts:52-58` OS 通知分支 |
| **理由** | 配置 webhook 表示用户希望走该通道；静默降级会隐藏问题；显式错误让调用方决定如何处理 |

### 决策 8：所有通知 Hook 都检查 getIsRemoteMode()

| 维度 | 说明 |
|------|------|
| **决策** | 每个通知 hook 开头检查 `getIsRemoteMode()`，远程模式直接返回 |
| **备选** | 在 `addNotification()` 中统一检查，或使用单独的远程模式通知通道 |
| **代价** | 每个 hook 重复相同检查，代码冗余 |
| **证据** | `src/hooks/notifs/useStartupNotification.ts:28`、`src/hooks/notifs/useFastModeNotification.tsx:27,56,69` 等所有 hooks |
| **理由** | 远程模式上下文不同，某些通知可能不合适；显式检查让每个 hook 决定远程模式下的行为（而非一刀切） |

### 决策 9：useStartupNotification 封装通用模式

| 维度 | 说明 |
|------|------|
| **决策** | 提供 `useStartupNotification(compute)` 封装一次性通知模式：远程模式检查、hasRunRef 防止重复、async/error 处理 |
| **备选** | 每个 hook 重复实现启动通知逻辑 |
| **代价** | 增加一层抽象，灵活性略降 |
| **证据** | `src/hooks/notifs/useStartupNotification.ts:19-41` 实现、多个 hooks 使用 |
| **理由** | 一次性启动通知是常见模式，封装减少重复代码，统一行为 |

### 决策 10：横幅通知默认 8 秒超时

| 维度 | 说明 |
|------|------|
| **决策** | 未指定 `timeoutMs` 时，默认 8000ms 后自动消失 |
| **备选** | 永久显示（用户手动关闭），或更短/更长超时 |
| **代价** | 阅读慢的用户可能错过，阅读快的用户觉得等待久 |
| **证据** | `src/context/notifications.tsx:41` `DEFAULT_TIMEOUT_MS = 8000` |
| **理由** | 8 秒是常见 UI toast 的标准时长，足以阅读短消息又不会太久；重要通知可设置更长或 immediate |

## 8. 覆盖范围

完整实现覆盖清单见 [Coverage](../../architecture/coverage/notifications.yaml)。

## 9. 开放问题与未来工作

1. **通知历史**：当前无通知历史或回顾机制，用户可能错过离线时的通知
2. **横幅用户操作**：当前横幅仅显示，不支持点击操作或延迟按钮
3. **通知静音**：无按类型静音通知的配置
4. **Windows 通知**：当前 OS 通知主要针对 macOS 终端，Windows 支持有限
5. **PushNotificationTool 重试**：webhook 失败无自动重试机制
