---
id: teleport
batch: 6
title: Teleport 会话迁移与恢复设计
date: 2026-11-12
status: draft
---

# Teleport 会话迁移与恢复设计

## 1. 概述

Teleport 是 Claude Code 的核心功能，允许用户在本地 CLI 和 Claude.ai 网页版之间无缝迁移编程会话。用户可以：

- 将本地会话上传到云端继续执行（`teleportToRemote`）
- 从云端会话恢复到本地继续工作（`teleportResumeCodeSession`）
- 通过 `/teleport` 命令交互式选择和恢复会话

该功能解决了跨设备工作流衔接问题，支持云-本地混合开发模式。

## 2. 核心架构

### 2.1 组件分层

```
┌─────────────────────────────────────────────────────────────────┐
│                         命令层 (Command)                         │
│  /teleport (teleport.tsx) | --teleport (teleportWithProgress)  │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────────┐
│                        UI 组件层 (Components)                    │
│  TeleportResumeWrapper | TeleportError | TeleportProgress      │
│  TeleportStash | TeleportRepoMismatchDialog                     │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────────┐
│                        Hook 层 (Hooks)                          │
│  useTeleportResume | ResumeTask                                 │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────────┐
│                      核心逻辑层 (Utils)                         │
│  teleport.tsx | teleport/api.ts | teleport/gitBundle.ts        │
│  teleport/environments.ts | teleport/environmentSelection.ts   │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────────┐
│                       API 层 (Services)                          │
│  Sessions API | Files API | OAuth | sessionIngress             │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流向

#### 上云流程（Local → Remote）

```
本地会话
  │
  ├─ 生成标题和分支名（generateTitleAndBranch）
  │
  ├─ 仓库源选择（GitHub 或 Git Bundle）
  │   ├─ GitHub：检测仓库并验证 GitHub App 安装
  │   └─ Bundle：createAndUploadGitBundle → 上传到 Files API
  │
  ├─ 环境选择（fetchEnvironments）
  │
  ├─ 创建远程会话（teleportToRemote → POST /v1/sessions）
  │
  └─ 返回 sessionId 和标题
```

#### 恢复流程（Remote → Local）

```
远程会话 ID
  │
  ├─ 验证仓库匹配（validateSessionRepository）
  │
  ├─ 拉取会话日志（getTeleportEvents / getSessionLogsViaOAuth）
  │
  ├─ 获取分支信息（getBranchFromSession）
  │
  ├─ 检查 Git 状态（validateGitState）
  │
  ├─ 检出分支（checkOutTeleportedSessionBranch）
  │
  ├─ 处理消息（processMessagesForTeleportResume）
  │
  └─ 恢复到本地会话
```

## 3. 会话打包与传输

### 3.1 仓库源策略

Teleport 支持三种仓库源模式，按优先级降序排列：

| 模式 | 触发条件 | 实现方式 | 优势 | 限制 |
|------|---------|---------|------|------|
| GitHub | 有 origin 远程 + GitHub App 已安装 | 后端从 GitHub 克隆 | 完整历史、推送权限 | 需要 GitHub 连接 |
| Git Bundle | 无 GitHub 但有 .git/ + 功能开关启用 | `git bundle` + Files API | 无需 GitHub、包含本地 WIP | 有大小限制 |
| Empty Sandbox | 无仓库 | 空环境 | 通用场景 | 无仓库访问 |

### 3.2 Git Bundle 创建与降级

`createAndUploadGitBundle` 实现了三级降级策略：

```typescript
// 1. 完整打包（--all）
bundle --all → refs/heads/* + refs/tags/* + refs/seed/stash（WIP）
if size > maxBytes → 降级到 HEAD-only

// 2. HEAD-only（仅当前分支）
bundle HEAD → 当前分支完整历史
if size > maxBytes → 降级到 squash-root

// 3. Squash-root（压缩单提交）
git commit-tree HEAD^{tree} -m "seed" → 无历史
bundle refs/seed/root
```

WIP 处理流程：
1. `git stash create` 创建临时 stash（不改变工作区）
2. 更新到 `refs/seed/stash` 使其可被 bundle 包含
3. 上传后清理 `refs/seed/stash`

最大大小控制：
- 默认 100MB
- 可通过 `tengu_ccr_bundle_max_bytes` 功能开关调整
- 超过上限时提示用户设置 GitHub

### 3.3 文件上传与元数据

上传到 Files API 时携带：
- 文件内容：Git bundle 二进制
- 相对路径：固定为 `_source_seed.bundle`
- 元数据：bundle 范围（all/HEAD/squash）、是否包含 WIP、大小

接收端通过 SessionContext 的 `seed_bundle_file_id` 字段获取文件 ID。

## 4. 身份与路径

### 4.1 身份要求

Teleport 功能仅支持 Claude.ai 账号认证（OAuth），不支持 API Key。关键检查点：

- `checkNeedsClaudeAiLogin()`：预检查
- `getClaudeAIOAuthTokens()`：获取 access_token
- `getOrganizationUUID()`：获取组织 ID（用于 API 路由）
- OAuth Header：`Authorization: Bearer {accessToken}` + `anthropic-beta: ccr-byoc-2025-07-29`

### 4.2 仓库验证与路径选择

远程会话关联仓库时，本地恢复需要验证仓库匹配：

```typescript
type RepoValidationResult = {
  status: 'match' | 'mismatch' | 'not_in_repo' | 'no_repo_required' | 'error'
  sessionRepo?: string  // 远程期望的仓库（owner/name）
  currentRepo?: string | null  // 本地当前仓库
  sessionHost?: string  // 远程仓库主机（github.com 或 GHE）
  currentHost?: string  // 本地仓库主机
}
```

验证逻辑：
1. 从 SessionContext 的 GitSource 解析 `sessionRepo` 和 `sessionHost`
2. 从本地 `detectCurrentRepositoryWithHost()` 获取 `currentRepo` 和 `currentHost`
3. 比较 `owner/name`（忽略大小写）和 `host`（去除端口）
4. 不匹配时显示 `TeleportRepoMismatchDialog`

已知路径管理：
- `getKnownPathsForRepo(repo)`：从配置读取该仓库的已知路径
- `filterExistingPaths(paths)`：过滤掉不存在的路径
- 用户选择后更新 `process.chdir(path)`、`setCwd(path)`、`setOriginalCwd(path)`

### 4.3 Git 分支管理

远程会话创建时：
1. Haiku 生成会话标题和分支名（基于任务描述）
2. 分支名格式：`claude/{short-description}`
3. 存储在 SessionContext 的 Outcomes 中

本地恢复时：
1. 从 SessionContext 提取分支名
2. 先尝试本地直接 checkout
3. 失败则 fetch 远程后 checkout -b
4. 确保上游设置：`git branch --set-upstream-to origin/{branch}`
5. 分支 checkout 失败不阻断会话恢复，仅记录警告

## 5. 敏感数据处理

### 5.1 认证令牌保护

- `CLAUDE_CODE_OAUTH_TOKEN` 可通过 SessionContext 的 `environment_variables` 传递到远程
- 仅在 `environmentId` 显式设置时注入（内部场景）
- 服务端日志中会被自动 scrub
- 不在 SessionResource 的响应中返回（服务端写只读）

### 5.2 Git Bundle 内容边界

Bundle 包含：
- Git 对象（提交、树、Blob）
- Refs 引用（`refs/seed/stash` 用于 WIP）
- 本地配置不包含

不包含：
- `.git/config` 中的凭证
- `.git/credentials`
- 未跟踪文件（除非在 stash 中）

### 5.3 会话日志过滤

恢复时过滤：
- `isTranscriptMessage()`：仅保留转录消息
- `!isSidechain`：排除 sidechain 消息（内部调试用）
- 敏感 tool 参数通过服务端 scrub 处理

## 6. 失败与兼容

### 6.1 前置条件检查与恢复

`TeleportError` 组件处理可恢复的前置失败：

| 错误类型 | 处理方式 |
|---------|---------|
| `needsLogin` | 显示 `ConsoleOAuthFlow` 引导登录 |
| `needsGitStash` | 显示 `TeleportStash` 让用户选择 stash 或取消 |

`errorsToIgnore` 允许调用方跳过某些检查（如 `--remote` 跳过 needsGitStash）。

### 6.2 仓库验证失败处理

| Status | 行为 |
|--------|------|
| `match` | 继续 |
| `no_repo_required` | 继续（会话无仓库关联） |
| `not_in_repo` | 错误提示，要求从正确仓库运行 |
| `mismatch` | 显示 `TeleportRepoMismatchDialog` 选择路径 |
| `error` | 通用错误提示 |

### 6.3 网络重试与降级

API 请求重试（`axiosGetWithRetry`）：
- 重试延迟：指数退避 [2s, 4s, 8s, 16s]
- 重试条件：网络错误、5xx 响应
- 不重试：4xx 响应（客户端错误）

会话日志获取降级：
1. 优先尝试 `GetTeleportEvents`（CCR v2，高效）
2. 失败回退到 `getSessionLogsViaOAuth`（旧兼容）
3. 都失败则抛出错误

### 6.4 分支检出降级

分支检出尝试序列：
1. `git checkout {branch}`（本地已存在）
2. `git checkout -b {branch} --track origin/{branch}`（从远程新建）
3. `git checkout --track origin/{branch}`（无 -b 兼容）
4. 都失败 → 返回 branchError，继续会话恢复

### 6.5 向后兼容性

- SessionResource 类型同时支持新旧 API 字段
- `parseGitHubRepository` 兼容 github.com 和 GHE
- Git Bundle 支持旧版接收端（通过标准 git 格式）

## 7. 设计决策

### 7.1 决策 1：工作区脏状态阻断而非自动 stash

**决策内容**：`validateGitState()` 检查到未提交更改时直接抛出错误，而不是自动 stash。

**备选方案**：
- 备选 A：自动 stash，恢复后 stash pop
- 备选 B：自动 stash 但不 pop，让用户手动处理
- 备选 C：完全忽略脏状态，直接切换分支（可能覆盖更改）

**选择理由**：
- 安全性优先：避免自动化操作导致的数据丢失
- 可控性：用户明确知道工作区状态，显式决策
- 已有预案：提供 `TeleportStash` 组件作为可选辅助

**代价**：
- 用户体验稍显繁琐
- 需要额外 UI 步骤

**证据**：`tests/teleport.test.ts` 中的 `dirty worktree cancellation prevents checkout` 测试用例验证该行为。

---

### 7.2 决策 2：GitHub 预检查 + Bundle 自动降级

**决策内容**：创建远程会话时，先检查 GitHub App 安装状态；失败时自动尝试 Git Bundle 模式。

**备选方案**：
- 备选 A：始终优先 Bundle，无需预检查
- 备选 B：仅 GitHub 模式，无降级
- 备选 C：用户手动选择模式

**选择理由**：
- 最大化成功率：50% 用户未完成 GitHub App 安装，自动降级让这些用户也能使用
- 透明性：用户无需了解技术细节，系统自动选择最佳路径
- 功能开关：`tengu_ccr_bundle_seed_enabled` 可控制是否启用 Bundle 降级

**代价**：
- 预检查增加一次 API 往返
- Bundle 创建增加延迟（大仓库）

**证据**：代码注释明确说明预检查动机："50% of users who reach the 'install GitHub App' step never finish it"。

---

### 7.3 决策 3：会话 ID 优先于完整状态序列化

**决策内容**：Teleport 通过 sessionId 引用远程会话，而不是像 session-persistence 那样序列化完整本地状态。

**备选方案**：
- 备选 A：完整状态序列化到文件，类似 session-persistence
- 备选 B：混合模式，同时发送日志和引用
- 备选 C：仅传输日志，无 sessionId

**选择理由**：
- 一致性：与 Claude.ai 共享同一套会话存储
- 可继续执行：远程会话可继续运行，无需本地等待
- 避免重复：日志已存储在服务端，无需再次传输

**代价**：
- 依赖网络：恢复需要在线
- 服务端依赖：需要 Sessions API 可用

**证据**：`teleportFromSessionsAPI` 通过 sessionId 拉取日志，而不是读取本地文件。

---

### 7.4 决策 4：分支检出失败不阻断会话恢复

**决策内容**：`checkOutTeleportedSessionBranch` 返回 `{branchName, branchError}`，调用方继续恢复会话而不是抛出致命错误。

**备选方案**：
- 备选 A：分支失败则完全阻断恢复
- 备选 B：分支失败时自动创建新分支
- 备选 C：分支失败时提示用户手动解决后重试

**选择理由**：
- 可用性优先：会话恢复是主要目标，分支问题可后续手动解决
- 错误可见：通过 `createTeleportResumeSystemMessage` 明确告知用户
- 安全边界：不修改用户工作区状态，让用户控制

**代价**：
- 可能产生混淆：会话恢复成功但代码不在预期分支

**证据**：`processMessagesForTeleportResume` 接受 `branchError` 参数并生成警告系统消息。

---

### 7.5 决策 5：Environment 选择策略优先 anthropic_cloud

**决策内容**：选择环境时按优先级：`settings.defaultEnvironmentId` → `anthropic_cloud` → `byoc` → `bridge`。

**备选方案**：
- 备选 A：纯设置驱动，无默认
- 备选 B：优先第一个可用环境
- 备选 C：让用户每次选择

**选择理由**：
- 安全性：anthropic_cloud 环境是官方托管，具有完整 repo 访问
- 可靠性：byoc 环境是用户自建，可能不兼容当前仓库
- 配置灵活性：用户仍可通过设置覆盖默认

**代价**：
- 某些场景可能需要 BYOC 但默认没选（可通过设置解决）

**证据**：`teleportToRemote` 中的环境选择逻辑和注释："prefer anthropic_cloud environments over byoc"。

---

### 7.6 决策 6：权限模式通过初始事件而非 API 字段传递

**决策内容**：`permissionMode` 通过 `control_request` 初始事件设置，而不是作为 SessionCreate API 的字段。

**备选方案**：
- 备选 A：API 请求体添加 `permission_mode` 字段
- 备选 B：环境变量传递
- 备选 C：不传递，使用远程默认

**选择理由**：
- 服务端兼容性：CreateCCRSessionPayload 无此字段，添加需要服务端配合
- 时序保证：初始事件在容器连接前写入，无竞态
- 复用现有机制：control_request 模式已存在

**代价**：
- 稍显绕路，不如字段直观

**证据**：代码注释明确说明："CreateCCRSessionPayload has no permission_mode field — a top-level body entry is silently dropped"。

---

### 7.7 决策 7：archive 而非 delete 停止远程会话

**决策内容**：`archiveRemoteSession` 使用 `POST /v1/sessions/{id}/archive` 而非 DELETE。

**备选方案**：
- 备选 A：DELETE API
- 备选 B：仅停止事件发送，不修改会话状态
- 备选 C：用户手动从网页删除

**选择理由**：
- 无运行状态检查：archive 无论会话是否 RUNNING 都成功（DELETE 409）
- 可逆：用户可从网页恢复已归档会话
- 有效停止：归档会话拒绝新事件

**代价**：
- 会话仍在用户列表中可见（直到后台清理）

**证据**：`archiveRemoteSession` 函数注释和实现。

## 8. 测试与验证

Teleport 的测试覆盖位于 `tests/teleport.test.ts`，验证场景：

- 无 sessionId 时使用选择器
- 直接 sessionId 拉取和验证
- 网络/无效会话失败不修改工作区
- 仓库不匹配需要已知 checkout，不降级到清理
- 脏工作区取消阻断 checkout 和替换转录
- 成功恢复复用 checkout 和消息处理

## 9. 相关文档

- [Coverage](../../architecture/coverage/teleport.yaml)
- Session Persistence 设计（独立文档，不同机制）
- Remote Control 设计（独立文档，相关但不同场景）
