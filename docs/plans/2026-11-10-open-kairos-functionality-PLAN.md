---
commit: d5a675a4df66ff620d7577aaf167bb5749cc08a2
title: "Implement open KAIROS functionality"
date: 2026-11-10T23:23:22+08:00
status: implemented
kind: component
---

# 实施计划：Implement open KAIROS functionality

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要在不伪造私有后端的前提下，把开放运行时的 assistant 模式接到既有 in-process team、OAuth session API、daemon supervisor、Brief 上传、OS 回调和消息通知队列。PR 功能还要避免第一次轮询把历史评论、review 和 check-run 全部当成新事件，并在后续轮询中按事件身份去重。实现必须区分本机状态初始化与真实远端可用性：隔离目录中的团队文件、mock 通知和 fake GitHub 响应可以离线验证，Cloud 文件上传、通知投递及 GitHub 往返则不能由这些测试推定成功。

- 确认父提交的 assistant gate、团队初始化和 session discovery 是禁用 stub，既有 main/dialog/command 条件注册点可以复用。
- 确认 team、daemon、Brief 上传、OAuth teleport 和通知队列已经提供可组合接口，不需要发明新协议。
- 将本机初始化、fake adapter 回归与 OAuth/Cloud/GitHub 在线验收分开，测试环境不使用真实凭据。
- 确认 PR 的产品语义是轮询新增事件而非完整历史同步，首轮必须只建立基线。

## 复用与兼容处理

### 复用现有实现

- 复用 teamHelpers、tasks 和 teammateModeSnapshot 建立 leader team 与 in-process Agent 上下文。
- 复用 prepareApiRequest/getOAuthHeaders 和既有 trust/OAuth 调用点，不在 gate 中另做 entitlement 判断。
- 复用 startDaemon、uploadBriefAttachment、FileReadTool.checkPermissions 和 sendOSNotification。
- 复用 gh api、parseGitHubRepository、enqueuePendingNotification 与 registerBundledSkill。
- 复用 Bun feature profile 和独立子进程构建测试验证外部注册，而非只检查源文件。

### 兼容、迁移与生命周期

- 保留既有 assistant 命令、session viewer、team 文件和 Agent 调用约定，新实现填入原禁用位置。
- KAIROS 默认开放但可用 CLAUDE_KAIROS 显式关闭；既有 trust/OAuth 检查不被新的 runtime gate 替代。
- SendUserFile 沿用 FileRead 权限与 Brief 的 30 MiB/file_id 协议，调用方无需学习另一套上传配置。
- SubscribePR 工具与 slash command 共享单例，list/unsubscribe 对两个入口看到相同进程内状态。
- env-based bridge 和其他外部特性保持原路径，本提交只增加 KAIROS flags 与适配器。

## 文件级实施步骤

### 1. 实现 assistant 运行时与团队上下文

先在 assistant/index.ts 实现 forced/env/settings 激活、KAIROS runtime 开关和系统提示，再以现有 team helper 写 leader 配置、任务目录和 in-process layout。gate.ts 只委托运行时开关，保留原有信任与 OAuth 边界。随后让 /assistant start/status/sessions 使用这些状态与初始化函数。

涉及位置：`src/assistant/index.ts`、`src/assistant/gate.ts`、`src/commands/assistant/index.ts`

### 2. 接通远程会话发现、选择和安装向导

在 sessionDiscovery.ts 实现 OAuth 请求和响应规范化，在 AssistantSessionChooser.tsx 用统一数据生成可选择列表。随后实现 NewInstallWizard 的默认目录、0700/0600 配置及 startDaemon 调用，让无远程会话时的安装路径与已有会话选择路径共享明确错误反馈。

涉及位置：`src/assistant/sessionDiscovery.ts`、`src/assistant/AssistantSessionChooser.tsx`、`src/commands/assistant/assistant.tsx`

### 3. 实现文件上传与通知适配器

新增 SendUserFileTool，将 FileRead 权限、bridge 活动检查、lstat 普通文件约束和 Brief 上传组合，只有 fileId 才返回成功。新增 PushNotificationTool，按 webhook、OS、无适配器失败的顺序分发，并传递超时、取消及非 2xx 错误。

涉及位置：`src/tools/SendUserFileTool/SendUserFileTool.ts`、`src/tools/PushNotificationTool/PushNotificationTool.ts`

### 4. 实现 PR 订阅与 dream 注册

先实现 PRSubscriptionManager 的 head SHA 查询、三类事件拉取、首轮基线、ID 去重和通知，再让 SubscribePRTool 与 subscribe-pr 命令共享 manager 并处理默认仓库和 timer 清理。最后注册 dream prompt，把 auto-memory、项目目录和用户参数交给既有 consolidation builder。

涉及位置：`src/services/prSubscriptions.ts`、`src/tools/SubscribePRTool/SubscribePRTool.ts`、`src/commands/subscribe-pr.ts`、`src/skills/bundled/dream.ts`

### 5. 启用外部构建并验证注册

在正式构建和独立特性夹具中同时加入 KAIROS、KAIROS_GITHUB_WEBHOOKS，使已有条件注册点生效。更新 enabledFeatures 的工具总数、三个新工具和 assistant command 断言，在干净 Bun 进程检查 41 个非空工具，防止裁剪后的产物仍缺实现。

涉及位置：`scripts/build.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`

### 6. 补离线回归并记录真实证据边界

在 kairos.test.ts 用隔离配置目录和子进程验证真实团队文件，用 fake OS/fetchJson 验证通知及 PR 语义，用无 bridge 调用验证上传前置条件，并检查 dream prompt。STATUS/RELEASE 只记录实际 140/604、类型检查、构建和特性档结果，同时保留 Cloud、通知、GitHub 与多模型协作未在线验证的范围。

涉及位置：`tests/kairos.test.ts`、`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 开放 gate 可能被误当作授权；通过保留信任、OAuth、org 检查并在设计中明确职责分离降低风险。
- 团队初始化成功可能被误读为 teammate 已运行；返回结构和文档都限定为 leader 上下文。
- 上传路径越权或虚假成功会暴露本地文件；FileRead 权限、普通文件检查及 fileId 成功条件是必要防线。
- PR 首次重放和重复通知会打扰用户；initialized 与 seen 必须在对 fresh 求值前后按正确顺序更新。
- 基于 ID 的去重会漏掉同 ID 内容变化，内存订阅也无法跨重启；这些限制必须保留在剩余工作中。
- fake adapters 不能发现真实 OAuth、Cloud、GitHub 和 OS 时序问题，发布状态只能标 offline/build。

## 验收顺序

1. 运行 KAIROS 定向测试，检查 forced latch、隔离 team 文件、dream prompt 和 assistant 系统提示。
2. 验证 OS adapter 收到正确标题/消息、无适配器失败，以及无 bridge 时不会尝试上传。
3. 用可控 PR 响应执行首轮、新增、重复和退订四轮，观察通知队列与 manager.list。
4. 在干净 Bun 子进程构建特性档，核对 41 个非空工具、三个新工具和 assistant command。
5. 依据 at-commit STATUS 引用 140/604、typecheck、build/declarations，不把本记录的静态校验写成历史测试。
6. 在授权环境分别验收 OAuth session discovery、daemon/bridge 就绪、30 MiB 内实际上传、webhook/OS 投递及 gh/GitHub 往返，并单独记录结果。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- assistant gate、激活状态、leader team 初始化、session discovery 和 chooser 已从 stub 变为实际组件。
- assistant 命令与私有配置的 daemon 安装向导已接通既有 supervisor。
- SendUserFile、PushNotification、SubscribePR 及共享 PR 轮询管理器已经实现。
- dream、assistant、subscribe-pr 和三个工具已进入外部构建，特性档断言为 41 个非空工具。
- 六项 KAIROS 离线回归和构建回归已经加入，at-commit 文档记录 140/604 与类型检查/构建。

### 未完成或后续工作

- Cloud/OAuth session、文件上传、通知和 GitHub 的真实在线往返未在该提交执行。
- 多 teammate 模型协作、远程 viewer 和 daemon worker 就绪没有由离线团队文件测试证明。
- PR 持久化、分页、同 ID 更新及后台防重入未实现，命令参数提示与显式 subscribe 解析仍有不一致。
