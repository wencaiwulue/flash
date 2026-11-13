---
id: notifications
batch: 3
title: Notifications 后台通知、折叠与用户可见性设计
date: 2026-11-12
status: draft
---

# Notifications 后台通知、折叠与用户可见性设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 需要处理三类通知场景：

- **横幅通知**：顶部弹窗，用于重要状态变更（fast mode、权限问题、速率限制等）
- **OS 通知**：通过终端原生通知系统（iTerm2、Kitty、Ghostty、Apple Terminal bell）或 webhook 发送
- **任务通知**：内联在对话流中，用于后台命令完成、插件安装等状态更新

需要同时处理去重、折叠、优先级排序和降级策略，在不干扰用户的同时保证重要信息可见。

### 调用方与责任边界

调用方：
- `notifications.tsx`：`useNotifications()` hook、`getNext()` 优先级选择器
- `notifier.ts`：`sendNotification()`、`sendToChannel()`、`sendAuto()`
- `PushNotificationTool.ts`：工具定义，支持 `CLAUDE_NOTIFICATION_WEBHOOK_URL` 或 `context.sendOSNotification`
- `collapseBackgroundBashNotifications.ts`：折叠逻辑
- 各种通知 hooks：`useStartupNotification.ts`、`useFastModeNotification.tsx`、`useRateLimitWarningNotification.tsx` 等

责任边界：
- **横幅通知**：队列 + 当前展示的双层结构，优先级排序
- **OS 通知**：多通道分发，支持配置和自动检测
- **任务通知折叠**：仅折叠成功完成的后台 bash 任务
- **远程模式**：远程模式不显示任何横幅通知

### 实际约束

- 终端垂直空间有限，不能同时显示多条横幅
- 不同终端对 OS 通知支持不同（iTerm2/Kitty/Ghostty/Apple Terminal）
- 远程模式上下文不同，通知可能不合适
- 重要信息需要立即可见，低优先级信息可以排队或延迟
- 后台命令完成通知高频但低价值，需要折叠减少视觉噪声

### Feature Gates 与 Disabled 机制

- 环境变量：`CLAUDE_NOTIFICATION_WEBHOOK_URL`（配置 webhook）
- 用户配置：`preferredNotifChannel`（选择通知通道）
- 远程模式：`getIsRemoteMode()`（远程模式不显示任何横幅通知）

## 2. 设计理由与备选方案

### 单横幅 + 队列而非多横幅堆叠

| 决策维度 | 说明 |
|---------|-----|
| **实际机制**：同一时间只显示一条横幅通知，其余入队按优先级展示；`getNext()` 选择最高优先级（immediate > high > medium > low），同优先级先入队先显示；超时后自动移除，继续处理队列 |
| **为什么采用**：终端垂直空间有限，多横幅会遮挡对话内容；单横幅 + 优先级保证重要信息及时可见；队列确保不丢失信息，只是延迟显示 |
| **备选方案及不采用原因**：多横幅堆叠显示（最多 N 条）→ 被否决，遮挡对话内容，用户体验差；toast 中心 → 被否决，需要额外 UI，复杂度高 |
| **代价**：低优先级通知可能延迟显示；队列管理增加复杂度 |
| **证据**：`src/context/notifications.tsx:54-93` processQueue()；`src/context/notifications.tsx:307-312` getNext() |

### Immediate 优先级立即抢占并重新入队

| 决策维度 | 说明 |
|---------|-----|
| **实际机制**：Immediate 通知立即替换当前；原 current（非 immediate）重新入队；重新计时；`useFastModeNotification.tsx` 使用 immediate 优先级 |
| **为什么采用**：Immediate 用于需要立即注意的事件（fast mode 不可用、进入超量），优先保证这类信息可见；重新入队确保被替换的通知不丢失 |
| **备选方案及不采用原因**：Immediate 仅插入队首 → 被否决，用户可能看不到；等待当前超时 → 被否决，重要信息延迟显示 |
| **代价**：用户可能错过被替换的通知 |
| **证据**：`src/context/notifications.tsx:98-151` immediate 分支；`src/hooks/notifs/useFastModeNotification.tsx:45-49,70-75` 使用 immediate |

### Fold 合并相同 key 通知而非替换

| 决策维度 | 说明 |
|---------|-----|
| **实际机制**：提供 `fold` 函数支持通知合并（类似 reduce）；相同 key 的新通知到达时，调用 `fold(current, new)` 更新；更新时重置 timeout |
| **为什么采用**：某些通知（如进度）适合合并更新而非多条显示；重置 timeout 确保用户有足够时间读取更新 |
| **备选方案及不采用原因**：直接替换旧通知 → 被否决，用户可能错过中间状态；累积显示多条 → 被否决，视觉噪声大 |
| **代价**：调用方需实现 fold 逻辑，增加复杂度 |
| **证据**：`src/context/notifications.tsx:157-216` fold 处理 |

### Invalidates 机制主动移除过时通知

| 决策维度 | 说明 |
|---------|-----|
| **实际机制**：通知可携带 `invalidates` 数组；添加新通知时自动移除指定 keys 的通知；`useFastModeNotification.tsx` 使用 invalidates |
| **为什么采用**：状态互斥时（如 "冷却开始" 和 "冷却结束"），显示两者会造成混淆；主动移除避免过时信息 |
| **备选方案及不采用原因**：等待自然超时 → 被否决，用户可能看到混淆信息；调用方手动 `removeNotification()` → 被否决，代码分散，容易遗漏 |
| **代价**：增加状态更新分支，需要仔细处理 |
| **证据**：`src/context/notifications.tsx:228-234` invalidates 处理；`src/hooks/notifs/useFastModeNotification.tsx:82-83,91` 使用 invalidates |

### 后台任务通知只折叠成功完成

| 决策维度 | 说明 |
|---------|-----|
| **实际机制**：`collapseBackgroundBashNotifications()` 仅在 fullscreen 模式且非 verbose 模式下工作；识别连续的完成后台 bash 任务通知（消息类型 user，含 `<task-notification>` 标签，`<status>` 为 `completed`，`<summary>` 以 `BACKGROUND_BASH_SUMMARY_PREFIX` 开头）；单条任务原样保留；N 条任务（N>1）合成为单条 "N background commands completed" 通知 |
| **为什么采用**：失败/终止需要用户注意，不应折叠；成功完成是高频但低价值事件，适合合并以减少视觉噪声 |
| **备选方案及不采用原因**：折叠所有任务通知 → 被否决，用户可能错过失败/终止；不分状态折叠 → 被否决，重要信息被隐藏 |
| **代价**：失败任务仍可能造成视觉噪声 |
| **证据**：`src/utils/collapseBackgroundBashNotifications.ts:22` 检查 status；`src/utils/collapseBackgroundBashNotifications.ts:41-84` 折叠逻辑 |

### Apple Terminal 禁用 bell 时反而发送 bell

| 决策维度 | 说明 |
|---------|-----|
| **实际机制**：Apple Terminal 检测：尝试读取当前 profile（通过 AppleScript）；读取 Terminal 配置 plist（`~/Library/Preferences/com.apple.Terminal.plist`）；检查当前 profile 的 `Bell` 设置；如果 bell 已禁用，发送 bell（因为用户听不到，此时发送反而可让终端弹出 Badge）；任何步骤失败则不发送通知 |
| **为什么采用**：Apple Terminal bell 禁用时通常开启了 "视觉 bell" 或 Dock badge；此时发送 bell 会触发 badge，是最接近通知的体验 |
| **备选方案及不采用原因**：完全不发送 → 被否决，用户无任何反馈；无论配置都发送 → 被否决，用户已禁用 bell，可能不想听到 |
| **代价**：逻辑反直觉，需要解释 |
| **证据**：`src/services/notifier.ts:110-161` isAppleTerminalBellDisabled()；`src/services/notifier.ts:83-103` sendAuto() |

### PushNotificationTool webhook 失败不自动降级到 OS 通知

| 决策维度 | 说明 |
|---------|-----|
| **实际机制**：`PushNotificationTool` 按以下顺序尝试：Webhook 优先（如果 `CLAUDE_NOTIFICATION_WEBHOOK_URL` 存在，发送 POST 请求，JSON 包含 `text`、`title`、`url`，超时 10 秒，支持 `context.abortController` 取消）；OS 通知备选（如果 `context.sendOSNotification` 存在，调用终端通知）；失败抛出（两者都不可用时抛出错误）；Webhook 请求仅检查 HTTP 状态码 <200 或 >=300 算失败；失败时抛出错误，不自动降级到 OS 通知 |
| **为什么采用**：配置 webhook 表示用户希望走该通道；静默降级会隐藏问题；显式错误让调用方决定如何处理 |
| **备选方案及不采用原因**：自动降级到 OS 通知 → 被否决，隐藏问题，用户不知道 webhook 失败；静默失败 → 被否决，用户无任何反馈 |
| **代价**：用户可能预期通知能送达，实际未送达 |
| **证据**：`src/tools/PushNotificationTool/PushNotificationTool.ts:47-51` webhook 失败抛出；`src/tools/PushNotificationTool/PushNotificationTool.ts:52-58` OS 通知分支 |

### 所有通知 Hook 都检查 getIsRemoteMode()

| 决策维度 | 说明 |
|---------|-----|
| **实际机制**：每个通知 hook 开头检查 `getIsRemoteMode()`；远程模式直接返回，不显示任何横幅通知；`useStartupNotification.ts`、`useFastModeNotification.tsx` 等所有 hooks 都遵循此模式 |
| **为什么采用**：远程模式上下文不同，某些通知可能不合适；显式检查让每个 hook 决定远程模式下的行为（而非一刀切） |
| **备选方案及不采用原因**：在 `addNotification()` 中统一检查 → 被否决，不够灵活，某些 hook 可能需要在远程模式下有特殊行为；使用单独的远程模式通知通道 → 被否决，复杂度高 |
| **代价**：每个 hook 重复相同检查，代码冗余 |
| **证据**：`src/hooks/notifs/useStartupNotification.ts:28`；`src/hooks/notifs/useFastModeNotification.tsx:27,56,69` 等所有 hooks |

### UseStartupNotification 封装通用模式

| 决策维度 | 说明 |
|---------|-----|
| **实际机制**：提供 `useStartupNotification(compute)` 封装一次性通知模式；远程模式检查；hasRunRef 防止重复；async/error 处理；多个 hooks 使用此封装 |
| **为什么采用**：一次性启动通知是常见模式；封装减少重复代码；统一行为 |
| **备选方案及不采用原因**：每个 hook 重复实现启动通知逻辑 → 被否决，代码冗余，容易不一致 |
| **代价**：增加一层抽象，灵活性略降 |
| **证据**：`src/hooks/notifs/useStartupNotification.ts:19-41` 实现；多个 hooks 使用 |

### 横幅通知默认 8 秒超时

| 决策维度 | 说明 |
|---------|-----|
| **实际机制**：未指定 `timeoutMs` 时，默认 8000ms 后自动消失；可自定义 timeoutMs |
| **为什么采用**：8 秒是常见 UI toast 的标准时长；足以阅读短消息又不会太久；重要通知可设置更长或 immediate |
| **备选方案及不采用原因**：永久显示（用户手动关闭）→ 被否决，需要额外 UI，用户可能忘记关闭；更短/更长超时 → 被否决，太短用户读不完，太长干扰用户 |
| **代价**：阅读慢的用户可能错过，阅读快的用户觉得等待久 |
| **证据**：`src/context/notifications.tsx:41` DEFAULT_TIMEOUT_MS = 8000 |

## 3. 目标与非目标

### 目标

- **横幅通知**：支持优先级排序、fold 合并、invalidates 移除、队列管理
- **OS 通知**：支持多通道分发（auto/iterm2/iterm2_with_bell/kitty/ghostty/terminal_bell/notifications_disabled）、Apple Terminal 特殊处理
- **任务通知折叠**：仅折叠成功完成的后台 bash 任务，减少视觉噪声
- **远程模式**：远程模式不显示任何横幅通知
- **通知 hooks**：提供统一模式（useStartupNotification 封装）

### 非目标

- 不支持通知历史或回顾机制
- 不支持横幅用户操作（点击、延迟按钮）
- 不支持按类型静音通知的配置
- 不支持 Windows 通知（当前主要针对 macOS 终端）
- 不支持 PushNotificationTool 自动重试

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// notifications.tsx
function useNotifications(): {
  addNotification(notification: Notification): void
  removeNotification(key: string): void
  notifications: { current: Notification | null; queue: Notification[] }
}

interface Notification {
  key: string
  priority: 'immediate' | 'high' | 'medium' | 'low'
  text?: string
  jsx?: React.ReactNode
  color?: string
  timeoutMs?: number
  invalidates?: string[]
  fold?: (current: Notification, incoming: Notification) => Notification
}

// notifier.ts
function sendNotification(title: string, text: string): Promise<void>
function sendToChannel(channel: string, title: string, text: string): Promise<void>
function sendAuto(title: string, text: string): Promise<void>

// PushNotificationTool.ts
// 工具定义，支持 CLAUDE_NOTIFICATION_WEBHOOK_URL 或 context.sendOSNotification

// collapseBackgroundBashNotifications.ts
function collapseBackgroundBashNotifications(messages: Message[]): Message[]

// useStartupNotification.ts
function useStartupNotification<T>(
  compute: () => Promise<T | null>
): void
```

### 4.2 横幅通知架构

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

### 4.3 OS 通知架构

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

### 4.4 任务通知折叠架构

后台任务通知在消息渲染时折叠，减少视觉噪声：

```
collapseBackgroundBashNotifications()
  ├─ fullscreen 模式检查：非 fullscreen 直接返回
  ├─ verbose 模式检查：verbose 直接返回
  └─ 扫描消息序列
      ├─ 识别连续的完成后台 bash 任务通知
      ├─ 单条任务：原样保留
      └─ N 条任务（N>1）：合成为单条 "N background commands completed" 通知
```

### 4.5 通知来源

通知来自以下几类：

| 来源 | 示例 Hook/代码 | 用途 |
|-----|---------------|-----|
| **启动通知** | `useStartupNotification.ts` | 一次性通知基础设施，被其他 hooks 复用 |
| **Fast Mode** | `useFastModeNotification.tsx` | fast mode 可用性、冷却、超量使用 |
| **速率限制** | `useRateLimitWarningNotification.tsx` | 额度接近、进入超量模式 |
| **设置错误** | `useSettingsErrors.tsx` | 配置验证失败 |
| **MCP** | `useMcpConnectivityStatus.tsx` | MCP 连接失败、需要认证 |
| **LSP** | `useLspInitializationNotification.tsx` | LSP 服务器错误 |
| **插件** | `usePluginInstallationStatus.tsx`、`usePluginAutoupdateNotification.tsx` | 安装失败、更新可用 |
| **IDE** | `useIdeStatusIndicator.tsx` | IDE 连接状态 |
| **模型迁移** | `useModelMigrationNotifications.tsx` | 模型版本迁移提示 |
| **npm 弃用** | `useNpmDeprecationNotification.tsx` | 过时 npm 包警告 |
| **Ant Org** | `useAntOrgWarningNotification.ts` | Anthropic 组织配置警告 |
| **Auto Mode** | `useAutoModeUnavailableNotification.ts` | auto mode 不可用提示 |
| **队友关闭** | `useTeammateShutdownNotification.ts` | agent swarm 队友关闭 |
| **订阅切换** | `useCanSwitchToExistingSubscription.tsx` | 订阅变更提示 |

### 4.6 主控制流

#### 添加通知流程

```
addNotification(notification)
  ├─ 如果 immediate
  │   ├─ 清除当前 timeout（如果存在）
  │   ├─ 保存原 current（如果存在且非 immediate）
  │   ├─ 设置新 notification 为 current
  │   ├─ 重新设置 timeout
  │   ├─ 将原 current 重新入队（过滤 immediate 和被 invalidates 的）
  │   └─ 触发 processQueue()
  ├─ 否则
  │   ├─ fold 检查：如果新通知有 fold 函数，检查当前和队列中是否有相同 key 的通知
  │   │   ├─ 当前匹配：调用 fold(current, new) 更新当前，重置 timeout
  │   │   └─ 队列匹配：调用 fold(queued, new) 更新队列项
  │   ├─ 去重检查：检查当前和队列中是否已有相同 key 的通知，有则跳过
  │   ├─ invalidates 处理：从队列移除被 invalidates 的通知；如果 invalidates 当前且当前存在，则清除当前（及其 timeout）
  │   ├─ 加入队列：将新通知加入队尾
  │   └─ 触发 processQueue()
  └─ 结束
```

#### processQueue 流程

```
processQueue()
  ├─ 如果 current 不为空或队列为空，直接返回
  ├─ 使用 getNext() 从队列取出最高优先级通知
  ├─ 设置 timeout（timeoutMs 或默认 8000ms）
  ├─ 将通知移至 current
  └─ timeout 到期时
      ├─ 再次检查 key 匹配（防止被替换）
      ├─ 清空 current
      └─ 递归调用 processQueue()
```

#### sendNotification 流程

```
sendNotification(title, text)
  ├─ executeNotificationHooks()：先执行用户配置的 hooks
  └─ sendToChannel(preferredNotifChannel, title, text)
      ├─ auto：调用 sendAuto()
      │   ├─ 检测终端类型：iTerm.app → iterm2；kitty → kitty；ghostty → ghostty；Apple_Terminal → 检查 bell 配置
      │   └─ 选择对应通道发送
      ├─ iterm2：使用 iTerm2 专有通知
      ├─ iterm2_with_bell：iTerm2 通知 + 响铃
      ├─ kitty：使用 Kitty 终端通知
      ├─ ghostty：使用 Ghostty 终端通知
      ├─ terminal_bell：仅响铃
      └─ notifications_disabled：完全禁用
```

#### collapseBackgroundBashNotifications 流程

```
collapseBackgroundBashNotifications(messages)
  ├─ 检查 isFullscreenEnvEnabled()：非 fullscreen 直接返回
  ├─ 检查 verbose：verbose 直接返回
  └─ 扫描消息序列
      ├─ 识别连续的完成后台 bash 任务通知
      │   ├─ 消息类型为 user
      │   ├─ 内容包含 <task-notification> 标签
      │   ├─ <status> 为 completed
      │   └─ <summary> 以 BACKGROUND_BASH_SUMMARY_PREFIX 开头
      ├─ 单条任务：原样保留
      └─ N 条任务（N>1）：合成为单条 "N background commands completed" 通知
```

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|--------|--------|-----------------|--------------|--------------|--------------|
| immediate 通知抢占 | `addNotification()` immediate 分支 | 无异常，原 current 重新入队 | 否 | 原 current 重新入队，不丢失 | 用户看到新 immediate 通知，原通知稍后显示 |
| fold 合并更新 | `addNotification()` fold 分支 | 无异常，当前或队列项更新 | 否 | timeout 重置 | 用户看到合并后的通知 |
| invalidates 移除 | `addNotification()` invalidates 分支 | 无异常，被 invalidates 的通知移除 | 否 | 从队列或当前移除 | 过时通知消失 |
| 队列为空 | `processQueue()` | 无异常，直接返回 | 否 | 无 | 当前通知显示直到超时 |
| Apple Terminal bell 检测失败 | `isAppleTerminalBellDisabled()` | 内部捕获，不发送通知 | 否 | 无 | 无通知 |
| webhook 请求失败 | `PushNotificationTool` webhook 分支 | 抛出错误，不自动降级 | 否 | 无 | 调用方收到错误 |
| remote 模式 | 所有通知 hooks 开头 | 无异常，直接返回 | 否 | 无 | 无横幅通知 |
| notification key 重复 | `addNotification()` 去重检查 | 无异常，跳过新通知 | 否 | 无 | 新通知被忽略 |

| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| 单横幅 + 队列 vs 多横幅堆叠 | 单横幅 + 队列 | 低优先级通知可能延迟显示；队列管理增加复杂度 | 终端垂直空间有限，避免遮挡对话内容；优先级保证重要信息及时可见 |
| immediate 抢占 vs 插入队首 vs 等待超时 | immediate 抢占并重新入队 | 用户可能错过被替换的通知 | 重要信息立即可见；被替换的通知不丢失 |
| fold 合并 vs 替换 vs 累积多条 | fold 合并 | 调用方需实现 fold 逻辑，增加复杂度 | 进度等通知适合合并，减少视觉噪声；重置 timeout 确保用户有足够时间读取 |
| invalidates 主动移除 vs 等待超时 vs 手动移除 | invalidates 主动移除 | 增加状态更新分支，需要仔细处理 | 状态互斥时避免混淆信息；代码集中，不容易遗漏 |
| 仅折叠成功完成 vs 折叠所有 vs 不分状态折叠 | 仅折叠成功完成 | 失败任务仍可能造成视觉噪声 | 失败/终止需要用户注意，不应折叠；成功完成高频低价值，适合合并 |
| Apple Terminal 禁用 bell 时反而发送 bell | 禁用时发送，启用时不发送 | 逻辑反直觉，需要解释 | Apple Terminal bell 禁用时通常开启了 "视觉 bell" 或 Dock badge；此时发送 bell 会触发 badge |
| webhook 失败抛出 vs 自动降级 vs 静默失败 | webhook 失败抛出 | 用户可能预期通知能送达，实际未送达 | 配置 webhook 表示用户希望走该通道；静默降级会隐藏问题；显式错误让调用方决定 |
| 每个 hook 检查 getIsRemoteMode() vs addNotification() 统一检查 vs 单独远程通道 | 每个 hook 检查 | 每个 hook 重复相同检查，代码冗余 | 远程模式上下文不同，某些通知可能不合适；显式检查让每个 hook 决定行为 |
| useStartupNotification 封装 vs 每个 hook 重复 | useStartupNotification 封装 | 增加一层抽象，灵活性略降 | 一次性启动通知是常见模式；封装减少重复代码；统一行为 |
| 默认 8 秒超时 vs 永久显示 vs 更短/更长 | 默认 8 秒 | 阅读慢的用户可能错过，阅读快的用户觉得等待久 | 8 秒是常见 UI toast 标准时长；足以阅读短消息又不会太久；重要通知可自定义 |

## 6. 现状验收标准

1. **给定**immediate 优先级通知，**当**addNotification 调用时，**必须**立即替换当前，原 current（非 immediate）重新入队
2. **给定**相同 key 且带 fold 函数的通知，**当**addNotification 调用时，**必须**调用 fold 合并更新，重置 timeout
3. **给定**带 invalidates 数组的通知，**当**addNotification 调用时，**必须**自动移除指定 keys 的通知
4. **给定**优先级不同的通知队列，**当**processQueue 调用时，**必须**按 immediate > high > medium > low 选择，同优先级先入队先显示
5. **给定**8 秒默认超时，**当**通知显示到期时，**必须**自动移除，继续处理队列
6. **给定**fullscreen 模式且非 verbose 模式，**当**collapseBackgroundBashNotifications 处理连续 N 条（N>1）成功完成的后台 bash 任务通知时，**必须**合成为单条 "N background commands completed" 通知
7. **给定**fullscreen 模式且非 verbose 模式，**当**collapseBackgroundBashNotifications 处理单条或失败/终止的后台 bash 任务通知时，**必须**原样保留
8. **给定**Apple Terminal 且 bell 已禁用，**当**sendAuto 调用时，**必须**发送 bell 触发 badge
9. **给定**Apple Terminal 且 bell 已启用，**当**sendAuto 调用时，**必须**不发送 bell
10. **给定**PushNotificationTool 且 CLAUDE_NOTIFICATION_WEBHOOK_URL 配置，**当**webhook 请求失败时，**必须**抛出错误，不自动降级到 OS 通知
11. **给定**远程模式，**当**任何通知 hook 运行时，**必须**不显示任何横幅通知

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| 单横幅 + 队列而非多横幅堆叠 | `src/context/notifications.tsx:54-93` processQueue()；`src/context/notifications.tsx:307-312` getNext() | 无专门测试 | 不支持通知历史或回顾 |
| Immediate 优先级立即抢占并重新入队 | `src/context/notifications.tsx:98-151` immediate 分支；`src/hooks/notifs/useFastModeNotification.tsx:45-49,70-75` 使用 immediate | 无专门测试 | 不支持横幅用户操作 |
| Fold 合并相同 key 通知而非替换 | `src/context/notifications.tsx:157-216` fold 处理 | 无专门测试 | 调用方需实现 fold 逻辑 |
| Invalidates 机制主动移除过时通知 | `src/context/notifications.tsx:228-234` invalidates 处理；`src/hooks/notifs/useFastModeNotification.tsx:82-83,91` 使用 invalidates | 无专门测试 | 需要仔细处理状态更新分支 |
| 后台任务通知只折叠成功完成 | `src/utils/collapseBackgroundBashNotifications.ts:22` 检查 status；`src/utils/collapseBackgroundBashNotifications.ts:41-84` 折叠逻辑 | 无专门测试 | 失败任务仍可能造成视觉噪声 |
| Apple Terminal 禁用 bell 时反而发送 bell | `src/services/notifier.ts:110-161` isAppleTerminalBellDisabled()；`src/services/notifier.ts:83-103` sendAuto() | 无专门测试 | 逻辑反直觉，需要解释 |
| PushNotificationTool webhook 失败不自动降级到 OS 通知 | `src/tools/PushNotificationTool/PushNotificationTool.ts:47-51` webhook 失败抛出；`src/tools/PushNotificationTool/PushNotificationTool.ts:52-58` OS 通知分支 | 无专门测试 | 用户可能预期通知能送达，实际未送达 |
| 所有通知 Hook 都检查 getIsRemoteMode() | `src/hooks/notifs/useStartupNotification.ts:28`；`src/hooks/notifs/useFastModeNotification.tsx:27,56,69` 等所有 hooks | 无专门测试 | 每个 hook 重复相同检查，代码冗余 |
| UseStartupNotification 封装通用模式 | `src/hooks/notifs/useStartupNotification.ts:19-41` 实现；多个 hooks 使用 | 无专门测试 | 增加一层抽象，灵活性略降 |
| 横幅通知默认 8 秒超时 | `src/context/notifications.tsx:41` DEFAULT_TIMEOUT_MS = 8000 | 无专门测试 | 阅读慢的用户可能错过，阅读快的用户觉得等待久 |

### 7.1 现有相关测试

| 测试文件 | 覆盖内容 | 说明 |
|---|---|---|
| `tests/orgWarningNotification.test.ts` | 组织警告通知功能：Settings schema 验证、权限检查逻辑、通知添加行为、远程模式检查 | 验证了 useAntOrgWarningNotification hook 的核心逻辑 |

### 7.2 未覆盖行为（基于代码阅读）

- notifications 核心功能无专门测试文件
- 各种通知场景（immediate 抢占、fold 合并、invalidates 移除、队列处理）
- 跨终端 OS 通知兼容性测试
- 远程模式通知行为测试
- PushNotificationTool webhook 失败/成功测试
- 后台任务通知折叠的完整测试
- 没有外部 live 验证测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/notifications.yaml)

### 本 spec 主拥有的文件组

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|-----|----------|------------------|----------------|
| notifications-context | 横幅通知核心逻辑（useNotifications、processQueue、getNext） | 需补充 | 不拥有 |
| notifier | OS 通知发送、多通道分发 | 需补充 | 不拥有 |
| push-notification-tool | PushNotificationTool 工具定义 | 需补充 | 不拥有 |
| collapse-background-bash-notifications | 后台任务通知折叠 | 需补充 | 不拥有 |
| notifs-hooks | 各种通知 hooks（useStartupNotification、useFastModeNotification 等） | 需补充 | 不拥有 |

### 相关子系统

- **AppState spec**：notifications 存储在 AppState 中
- **Remote spec**：getIsRemoteMode() 检查
- **Settings spec**：preferredNotifChannel 配置
- **Permissions spec**：PushNotificationTool 权限
- **Analytics spec**：通知事件记录

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|--------|-------|-------|
| P1 | 无通知历史或回顾机制，用户可能错过离线时的通知 | 增加通知历史或回顾机制，用户可查看过去的通知 | 中（需要存储历史，增加 UI） | 用户可查看通知历史 | L | 设计推断 |
| P1 | 横幅仅显示，不支持点击操作或延迟按钮 | 增加横幅用户操作（点击、延迟按钮、关闭按钮） | 中（需要 UI 交互） | 用户可点击通知、延迟显示、手动关闭 | L | 设计推断 |
| P2 | 无按类型静音通知的配置 | 增加按类型静音通知的配置 | 低（仅新增配置） | 用户可静音不需要的通知类型 | M | 设计推断 |
| P2 | Windows 通知支持有限 | 增加 Windows 通知支持 | 中（需要 Windows 终端适配） | Windows 终端可收到 OS 通知 | L | 设计推断 |
| P2 | PushNotificationTool webhook 失败无自动重试 | 增加 PushNotificationTool webhook 自动重试（带退避） | 低（仅改进错误处理） | webhook 失败时自动重试 | M | 设计推断 |
| P2 | 每个通知 hook 重复 getIsRemoteMode() 检查，代码冗余 | 在 addNotification() 中统一检查远程模式，或提供高阶 hook 封装 | 低（仅重构，不改变行为） | 代码更简洁，减少冗余 | S | 设计推断 |
| P2 | notifications 无专门测试文件 | 补充 notifications 单元测试：immediate 抢占、fold 合并、invalidates 移除、队列处理、OS 通知发送、任务折叠 | 低（仅新增测试） | 每个核心模块有对应测试文件，覆盖主要路径 | M | 设计推断 |
