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

### 核心模块接口
- `discoverAssistantSessions()`: 获取最近活跃会话（limit: 50）
- `useAssistantHistory`: 历史消息懒加载 Hook
- `RemoteSessionManager`: 管理远程会话连接
- `AssistantSessionChooser`: 会话选择 UI 组件

### 主控制流
1. 用户调用 /assistant → 发现远程会话 → 显示选择列表
2. 选择会话 → 建立 WebSocket 连接 → 加载历史消息
3. 滚动触发预加载 → 保持滚动锚定
4. 权限请求转发 → 用户批准或拒绝

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

1. 增加会话搜索和过滤功能，支持按标题、机器名、分支等条件筛选
2. 显示会话持续时间和消息计数，提供更多上下文信息
3. 支持会话书签和标记功能，便于快速找到重要会话
4. 实现多标签页式会话切换，提升并行工作效率
5. 增加离线历史缓存，改善网络不稳定时的体验
6. 添加会话删除功能，允许用户清理不需要的远程会话
7. 实现会话导出功能，支持保存历史记录到本地
