---
id: assistant-ui
batch: 4
title: Assistant UI 助手会话与历史交互设计
date: 2026-11-12
status: draft
---

## 1. 概述

Assistant UI 是 Claude Code 的远程助手会话选择与历史交互模块，支持：
- 发现并选择远程运行的助手会话
- 以只读模式查看会话历史消息
- 远程环境设置与 GitHub token 同步
- 会话连接状态管理与错误处理

该模块与 agent-swarms 执行逻辑完全分离，仅负责 UI 交互与远程会话的连接展示。

## 2. 架构

Assistant UI 采用分层设计：

```
┌─────────────────────────────────────────────────────────┐
│                    Commands Layer                       │
│  /assistant  |  /remote-setup  |  /remote-env  |  /session │
└─────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────┐
│                   UI Components Layer                    │
│  AssistantSessionChooser  |  NewInstallWizard  |  ...     │
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

## 3. 核心功能

### 3.1 助手会话选择

AssistantSessionChooser 组件提供会话列表选择 UI：

- **数据源**：通过 `discoverAssistantSessions()` 从 API 获取最近活跃的会话（limit: 50）
- **排序**：按 `lastActiveAt` 降序排列，最新活跃会话在前
- **展示格式**：`{title || sessionId} — {machineName || cwd || 'unknown host'}`
- **会话字段**：
  - `id`：会话唯一标识
  - `title`：可选标题
  - `machineName`：运行机器名称
  - `cwd`：工作目录
  - `branch`：Git 分支
  - `lastActiveAt`：最后活跃时间戳

### 3.2 历史消息浏览

useAssistantHistory Hook 实现远程历史消息的懒加载：

- **初始加载**：挂载时获取最新一页（100 条消息）
- **滚动加载**：向上滚动接近顶部时自动加载更旧的消息
- **视口填充**：初始加载后如果内容未填满视口，自动继续加载（最多 10 页）
- **滚动锚定**：加载旧消息时保持当前视口位置不变
- **哨兵消息**：显示加载状态和会话起点标记
- **消息转换**：使用 `convertSDKMessage` 将 SDK 消息转换为 REPL 显示格式

### 3.3 远程设置界面

/remote-setup 命令提供 GitHub token 同步功能：

- **登录状态检查**：验证 Claude OAuth 和 GitHub CLI 认证状态
- **Token 导入**：从本地 `gh auth token` 获取并上传到服务器（Fernet 加密存储）
- **默认环境创建**：首次设置时自动创建默认云环境
- **浏览器跳转**：设置完成后打开 claude.ai/code

### 3.4 会话状态管理

RemoteSessionManager 管理远程会话连接：

- **WebSocket 连接**：实时接收会话消息
- **权限请求处理**：转发来自 CCR 的工具使用权限请求
- **重连机制**：连接断开时自动重试
- **消息发送**：通过 HTTP POST 发送用户消息
- **中断信号**：支持发送取消请求
- **Viewer 模式**：只读模式下不发送中断，禁用 60s 超时

## 4. 关键设计决策

### 4.1 会话选择列表格式

**决策**：使用 `{title || sessionId} — {machineName || cwd}` 格式

**替代方案**：
- 仅显示 sessionId：不够用户友好
- 更详细的元数据展示：占用过多终端空间

**代价**：长标题或路径可能被截断

**证据**：当前实现已在生产环境使用，用户反馈良好

### 4.2 历史消息分页策略

**决策**：每页 100 条，滚动预加载阈值 40 行

**替代方案**：
- 更大的页面大小：减少请求次数但增加初始加载延迟
- 更小的页面大小：更快的响应但更多请求

**代价**：快速滚动时可能短暂显示加载哨兵

**证据**：基于终端典型视口大小（约 40 行）设计，平衡用户体验和网络开销

### 4.3 只读 Viewer 模式

**决策**：独立的 viewerOnly 配置控制会话行为

**替代方案**：
- 始终允许交互：可能意外干扰远程运行的会话
- 权限分离到多个类：增加代码复杂度

**代价**：配置参数增多

**证据**：`claude assistant` 命令明确需要只读查看能力

### 4.4 GitHub Token 红acted 封装

**决策**：使用 RedactedGithubToken 类包装原始 token

**替代方案**：
- 直接传递字符串：意外日志泄露风险
- 自定义类型但不重写 toString：仍可能泄露

**代价**：需要显式调用 `.reveal()` 才能获取原始值

**证据**：防止了多起潜在的 token 泄露事件

### 4.5 滚动锚定实现

**决策**：使用 useLayoutEffect + Yoga 直接读取高度

**替代方案**：
- 估算消息高度：不准确
- React 状态管理：增加渲染开销

**代价**：依赖内部 Yoga API

**证据**：当前实现在快速滚动加载时表现稳定

## 5. 状态同步

### 5.1 会话连接状态

状态通过 `RemoteSessionManager` 的回调传播：
- `onConnected`：连接建立
- `onReconnecting`：重连中
- `onDisconnected`：连接断开且无法恢复
- `onError`：错误发生

### 5.2 历史加载状态

内部状态通过 ref 管理（避免不必要的重渲染）：
- `cursorRef`：下一页的游标
- `ctxRef`：认证上下文
- `inflightRef`：是否正在加载中
- `anchorRef`：滚动锚定数据

## 6. 错误处理

### 6.1 网络错误

- **会话发现**：API 请求失败时显示空列表
- **历史加载**：显示 "failed to load older messages — scroll up to retry"
- **Token 导入**：区分网络错误、无效 token、服务器错误等

### 6.2 认证错误

- 401 响应触发 OAuth token 刷新
- 刷新失败时断开连接

### 6.3 权限请求错误

- 无法识别的控制请求子类型返回错误响应
- 防止服务器挂起等待永远不会到来的回复

## 7. 与其他模块的关系

- **remote**：复用 RemoteSessionManager 和 SessionsWebSocket
- **bridge**：daemonBridge 使用 remoteBridgeCore 建立连接
- **history.ts**：独立的本地命令历史，与远程会话历史无关
- **agent-swarms**：完全分离，Assistant UI 不涉及 agent 执行逻辑
- **session-persistence**：不使用，远程会话状态在服务器存储

## 8. 覆盖率

[Coverage](../../architecture/coverage/assistant-ui.yaml)

## 9. 未来工作

- 支持会话搜索和过滤
- 显示会话持续时间和消息计数
- 支持会话书签和标记
- 多标签页式会话切换
- 离线历史缓存
