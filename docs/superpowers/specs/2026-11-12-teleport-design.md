---
id: teleport
batch: 6
title: Teleport 会话迁移与恢复设计
date: 2026-11-12
status: draft
---

# Teleport 会话迁移与恢复设计

## 1. 问题与约束

Teleport 是 Claude Code 的核心功能，允许用户在本地 CLI 和 Claude.ai 网页版之间无缝迁移编程会话。用户可以：
- 将本地会话上传到云端继续执行（`teleportToRemote`）
- 从云端会话恢复到本地继续工作（`teleportResumeCodeSession`）
- 通过 `/teleport` 命令交互式选择和恢复会话

该功能解决了跨设备工作流衔接问题，支持云-本地混合开发模式。

**约束条件：**
- 仅支持 Claude.ai 账号认证（OAuth），不支持 API Key
- GitHub 模式需要 GitHub App 安装
- Git Bundle 模式有大小限制，默认 100MB
- 分支检出失败不阻断会话恢复

## 2. 设计理由与备选方案

### 工作区脏状态阻断而非自动 stash

**决策内容**：`validateGitState()` 检查到未提交更改时直接抛出错误，而不是自动 stash。

**备选方案**：
- 自动 stash，恢复后 stash pop → 不采用，数据丢失风险
- 自动 stash 但不 pop，让用户手动处理 → 不采用，用户体验混乱
- 完全忽略脏状态，直接切换分支 → 不采用，可能覆盖更改

**选择理由**：
- 安全性优先：避免自动化操作导致的数据丢失
- 可控性：用户明确知道工作区状态，显式决策
- 已有预案：提供 `TeleportStash` 组件作为可选辅助

**证据**：`tests/teleport.test.ts` 中的 `dirty worktree cancellation prevents checkout` 测试用例验证该行为。

### GitHub 预检查 + Bundle 自动降级

**决策内容**：创建远程会话时，先检查 GitHub App 安装状态；失败时自动尝试 Git Bundle 模式。

**备选方案**：
- 始终优先 Bundle，无需预检查 → 不采用，GitHub 模式更优
- 仅 GitHub 模式，无降级 → 不采用，50% 用户未完成 GitHub App 安装
- 用户手动选择模式 → 不采用，增加用户负担

**选择理由**：
- 最大化成功率：50% 用户未完成 GitHub App 安装，自动降级让这些用户也能使用
- 透明性：用户无需了解技术细节，系统自动选择最佳路径
- 功能开关：`tengu_ccr_bundle_seed_enabled` 可控制是否启用 Bundle 降级

**代价**：
- 预检查增加一次 API 往返
- Bundle 创建增加延迟（大仓库）

**证据**：代码注释明确说明预检查动机："50% of users who reach the 'install GitHub App' step never finish it"。

### 会话 ID 优先于完整状态序列化

**决策内容**：Teleport 通过 sessionId 引用远程会话，而不是像 session-persistence 那样序列化完整本地状态。

**备选方案**：
- 完整状态序列化到文件，类似 session-persistence → 不采用，与 Claude.ai 共享会话困难
- 混合模式，同时发送日志和引用 → 不采用，重复存储
- 仅传输日志，无 sessionId → 不采用，远程无法继续执行

**选择理由**：
- 一致性：与 Claude.ai 共享同一套会话存储
- 可继续执行：远程会话可继续运行，无需本地等待
- 避免重复：日志已存储在服务端，无需再次传输

**代价**：
- 依赖网络：恢复需要在线
- 服务端依赖：需要 Sessions API 可用

**证据**：`teleportFromSessionsAPI` 通过 sessionId 拉取日志，而不是读取本地文件。

### 分支检出失败不阻断会话恢复

**决策内容**：`checkOutTeleportedSessionBranch()` 返回 `{branchName, branchError}`，调用方继续恢复会话而不是抛出致命错误。

**备选方案**：
- 分支失败则完全阻断恢复 → 不采用，会话恢复是主要目标
- 分支失败时自动创建新分支 → 不采用，可能覆盖用户更改
- 分支失败时提示用户手动解决后重试 → 不采用，用户体验差

**选择理由**：
- 可用性优先：会话恢复是主要目标，分支问题可后续手动解决
- 错误可见：通过 `createTeleportResumeSystemMessage()` 明确告知用户
- 安全边界：不修改用户工作区状态，让用户控制

**代价**：
- 可能产生混淆：会话恢复成功但代码不在预期分支

**证据**：`processMessagesForTeleportResume` 接受 `branchError` 参数并生成警告系统消息。

### Environment 选择策略优先 anthropic_cloud

**决策内容**：选择环境时按优先级：`settings.defaultEnvironmentId` → `anthropic_cloud` → `byoc` → `bridge`。

**备选方案**：
- 纯设置驱动，无默认 → 不采用，用户体验差
- 优先第一个可用环境 → 不采用，可能选择非最优环境
- 用户每次选择 → 不采用，增加用户负担

**选择理由**：
- 安全性：anthropic_cloud 环境是官方托管，具有完整 repo 访问
- 可靠性：byoc 环境是用户自建，可能不兼容当前仓库
- 配置灵活性：用户仍可通过设置覆盖默认

**代价**：
- 某些场景可能需要 BYOC 但默认没选（可通过设置解决）

**证据**：`teleportToRemote` 中的环境选择逻辑和注释："prefer anthropic_cloud environments over byoc"。

### 权限模式通过初始事件而非 API 字段传递

**决策内容**：`permissionMode` 通过 `control_request` 初始事件设置，而不是作为 SessionCreate API 的字段。

**备选方案**：
- API 请求体添加 `permission_mode` 字段 → 不采用，CreateCCRSessionPayload 无此字段，添加需要服务端配合
- 环境变量传递 → 不采用，服务端不读取
- 不传递，使用远程默认 → 不采用，可能不符合用户预期

**选择理由**：
- 服务端兼容性：CreateCCRSessionPayload 无此字段，添加需要服务端配合
- 时序保证：初始事件在容器连接前写入，无竞态
- 复用现有机制：control_request 模式已存在

**代价**：
- 稍显绕路，不如字段直观

**证据**：代码注释明确说明："CreateCCRSessionPayload has no permission_mode field — a top-level body entry is silently dropped"。

### archive 而非 delete 停止远程会话

**决策内容**：`archiveRemoteSession` 使用 `POST /v1/sessions/{id}/archive` 而非 DELETE。

**备选方案**：
- DELETE API → 不采用，会话运行时 DELETE 会 409
- 仅停止事件发送，不修改会话状态 → 不采用，会话仍在列表中
- 用户手动从网页删除 → 不采用，增加用户负担

**选择理由**：
- 无运行状态检查：archive 无论会话是否 RUNNING 都成功
- 可逆：用户可从网页恢复已归档会话
- 有效停止：归档会话拒绝新事件

**代价**：
- 会话仍在用户列表中可见（直到后台清理）

**证据**：`archiveRemoteSession` 函数注释和实现。

## 3. 目标与非目标

### 目标

- 支持将本地会话上传到云端继续执行
- 支持从云端会话恢复到本地继续工作
- 提供交互式 `/teleport` 命令选择和恢复会话
- 支持 GitHub 模式和 Git Bundle 模式（自动降级）
- 安全处理敏感数据（OAuth token、Git 凭证等）
- 向后兼容旧版 SessionResource 类型

### 非目标

- 不支持 API Key 认证（仅 OAuth）
- 不自动 stash 工作区脏状态（阻断而非自动）
- 不跨设备实时同步（仅上传/恢复）
- 不删除远程会话（仅 archive）
- 不保证分支检出成功（失败继续恢复）

## 4. 架构、模块与数据流

### 组件分层

```
┌─────────────────────────────────────────────────────────────────┐
│                     命令层 (Command)                           │
│  /teleport (teleport.tsx) | --teleport (teleportWithProgress)  │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    UI 组件层 (Components)                       │
│  TeleportResumeWrapper | TeleportError | TeleportProgress      │
│  TeleportStash | TeleportRepoMismatchDialog                     │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────────┐
│                      Hook 层 (Hooks)                            │
│  useTeleportResume | ResumeTask                                 │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    核心逻辑层 (Utils)                           │
│  teleport.tsx | teleport/api.ts | teleport/gitBundle.ts        │
│  teleport/environments.ts | teleport/environmentSelection.ts   │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────────┐
│                    API 层 (Services)                            │
│  Sessions API | Files API | OAuth | sessionIngress             │
└─────────────────────────────────────────────────────────────────┘
```

---

### 模块设计卡：gitBundle（Git 打包与上传）

#### 真实入口签名与关键类型

```typescript
// src/utils/teleport/gitBundle.ts

// 默认最大包大小：100MB
const DEFAULT_BUNDLE_MAX_BYTES = 100 * 1024 * 1024;

type BundleScope = 'all' | 'head' | 'squashed';

type BundleUploadResult =
  | {
      success: true
      fileId: string
      bundleSizeBytes: number
      scope: BundleScope
      hasWip: boolean
    }
  | { success: false; error: string; failReason?: BundleFailReason }

type BundleFailReason = 'git_error' | 'too_large' | 'empty_repo'

// 主入口：打包并上传 Git 仓库
export async function createAndUploadGitBundle(
  config: FilesApiConfig,
  opts?: { cwd?: string; signal?: AbortSignal },
): Promise<BundleUploadResult>
```

#### 输入输出

| 输入 | 类型 | 描述 |
|------|------|------|
| config | FilesApiConfig | OAuth token、sessionId、baseUrl 配置 |
| opts.cwd | string? | 工作目录，默认使用 getCwd() |
| opts.signal | AbortSignal? | 用于取消操作的信号 |

| 输出 | 类型 | 描述 |
|------|------|------|
| result | BundleUploadResult | success 时返回 fileId、大小、范围、是否含 WIP；失败时返回错误信息与原因 |

#### 状态与文件布局

- 临时文件路径：通过 generateTempFilePath('ccr-seed', '.bundle') 生成
- Git 引用：临时使用 refs/seed/stash（存储 WIP）和 refs/seed/root（squashed 模式），操作后立即清理
- 最终上传相对路径：固定为 _source_seed.bundle

#### 导出流程

```
1. 前置清理：删除旧的 refs/seed/stash 和 refs/seed/root
2. 空仓库检查：git for-each-ref --count=1 refs/ → 空则返回 empty_repo
3. WIP 捕获：git stash create → 非空则 update-ref refs/seed/stash
4. _bundleWithFallback 三级降级：
   a. git bundle create --all → ≤100MB 则用
   b. 降级 git bundle create HEAD → ≤100MB 则用
   c. 降级 squash：commit-tree HEAD^{tree} + bundle refs/seed/root
5. uploadFile 上传到 Files API
6. finally 清理：删除临时文件 + 清理 refs/seed/*
```

#### 100MB 与 Squash 降级

- 阈值控制：DEFAULT_BUNDLE_MAX_BYTES = 100MB，可通过 feature flag tengu_ccr_bundle_max_bytes 调整
- 降级策略：
  - all → 包含所有分支、标签、refs/seed/stash（WIP）
  - head → 仅当前分支 + refs/seed/stash
  - squashed → 单提交（无历史），直接使用 WIP 树（如有）或 HEAD 树
- 超过阈值且无法 squash：提示用户设置 GitHub

#### 错误与安全

| 错误 | 处理 |
|------|------|
| git_error | 记录日志，返回详细错误信息 |
| too_large | 提示设置 GitHub |
| empty_repo | 提示用户提交初始 commit |
| 上传失败 | 清理临时文件与 refs 后返回 |

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| WIP 方式 | stash create + refs/seed/stash | git diff patch | stash 可包含暂存/未暂存，且与 git bundle 天然兼容 |
| 未跟踪文件 | 不包含 | 包含 | 未跟踪文件可能包含敏感信息（密钥、日志等），且增加包大小 |
| 降级阈值 | 100MB | 可配置 | 平衡上传时间与功能完整性 |
| 临时引用 | refs/seed/* 命名空间 | refs/teleport/* | 与后端 env-runner 读取约定一致 |

#### 源码测试证据

- 源码：src/utils/teleport/gitBundle.ts（293 行）
- 测试：tests/teleport.test.ts（含 bundle 相关用例）

---

### 模块设计卡：environmentSelection（环境选择）

#### 真实入口签名与关键类型

```typescript
// src/utils/teleport/environmentSelection.ts

export type EnvironmentSelectionInfo = {
  availableEnvironments: EnvironmentResource[]
  selectedEnvironment: EnvironmentResource | null
  selectedEnvironmentSource: SettingSource | null
}

export async function getEnvironmentSelectionInfo(): Promise<EnvironmentSelectionInfo>
```

#### 输入输出

| 输入 | 类型 | 描述 |
|------|------|------|
| （无） | — | 内部从 getSettings_DEPRECATED() 读取 defaultEnvironmentId |

| 输出 | 类型 | 描述 |
|------|------|------|
| availableEnvironments | EnvironmentResource[] | fetchEnvironments() 返回的所有可用环境 |
| selectedEnvironment | EnvironmentResource \| null | 选中的环境（见下文优先级） |
| selectedEnvironmentSource | SettingSource \| null | defaultEnvironmentId 来自哪个设置源（local/global/project） |

#### 状态与文件布局

- 配置读取：settings.remote.defaultEnvironmentId，支持多级别（local > global > project）
- 环境类型：anthropic_cloud（官方托管）、byoc（用户自建）、bridge（桥接）

#### 环境选择流程

```
1. fetchEnvironments() 获取可用环境列表
2. settings.remote.defaultEnvironmentId 有值且存在 → 选中，记录 source
3. 否则：优先 anthropic_cloud 类型环境
4. 否则：优先非 bridge 类型环境
5. 否则：第一个可用环境
6. useDefaultEnvironment=true 时：强制使用 anthropic_cloud，无则重试 fetchEnvironments 一次，仍无则失败
```

#### defaultEnvironmentId 与 anthropic_cloud/byoc

- 默认优先级：defaultEnvironmentId > anthropic_cloud > byoc > bridge
- 设计理由：
  - anthropic_cloud：官方托管，具有完整 repo 访问权限，兼容性最好
  - byoc：用户自建，可能不支持当前仓库（如 monorepo 专用环境）
  - bridge：桥接环境，仅用于特定场景
- useDefaultEnvironment=true 场景：不降级到 byoc，失败则明确报错

#### 错误与安全

| 场景 | 处理 |
|------|------|
| environments 为空 | 返回 null，由上层处理（报错） |
| defaultEnvironmentId 不存在 | 回退到优先级选择，不报错 |
| useDefaultEnvironment=true 无 anthropic_cloud | 重试 fetch 一次，仍无则返回 null |

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 默认环境类型 | anthropic_cloud 优先 | byoc 优先、用户每次选择 | anthropic_cloud 是标准环境，兼容性最好 |
| defaultEnvironmentId 回退 | 不存在时静默回退 | 报错 | 提升鲁棒性 |
| useDefaultEnvironment 行为 | 强制 anthropic_cloud，无则失败 | 回退到 byoc | 避免意外进入不兼容的 byoc 环境 |

#### 源码测试证据

- 源码：src/utils/teleport/environmentSelection.ts（77 行）
- 依赖：src/utils/teleport/environments.ts（fetchEnvironments）

---

### 模块设计卡：api（会话 API 封装）

#### 真实入口签名与关键类型

```typescript
// src/utils/teleport/api.ts

// 重试配置
const TELEPORT_RETRY_DELAYS = [2000, 4000, 8000, 16000]; // 指数退避：2s/4s/8s/16s
const MAX_TELEPORT_RETRIES = TELEPORT_RETRY_DELAYS.length;

export const CCR_BYOC_BETA = 'ccr-byoc-2025-07-29';

// 核心类型
export type SessionStatus = 'requires_action' | 'running' | 'idle' | 'archived';

export type GitSource = {
  type: 'git_repository'
  url: string
  revision?: string | null
  allow_unrestricted_git_push?: boolean
}

export type SessionContext = {
  sources: SessionContextSource[]
  cwd: string
  outcomes: Outcome[] | null
  custom_system_prompt: string | null
  append_system_prompt: string | null
  model: string | null
  seed_bundle_file_id?: string
  github_pr?: { owner: string; repo: string; number: number }
  reuse_outcome_branches?: boolean
}

export type SessionResource = {
  type: 'session'
  id: string
  title: string | null
  session_status: SessionStatus
  environment_id: string
  created_at: string
  updated_at: string
  session_context: SessionContext
}

// 主入口
export async function fetchSession(sessionId: string): Promise<SessionResource>
export async function fetchCodeSessionsFromSessionsAPI(): Promise<CodeSession[]>
export async function getBranchFromSession(session: SessionResource): string | undefined
export async function sendEventToRemoteSession(
  sessionId: string,
  messageContent: RemoteMessageContent,
  opts?: { uuid?: string },
): Promise<boolean>
export async function updateSessionTitle(sessionId: string, title: string): Promise<boolean>
export async function axiosGetWithRetry<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>
```

#### 输入输出（fetchSession）

| 输入 | 类型 | 描述 |
|------|------|------|
| sessionId | string | 会话 ID |

| 输出 | 类型 | 描述 |
|------|------|------|
| session | SessionResource | 会话资源 |
| （异常） | Error | 404 → "Session not found"；401 → "Session expired" |

#### 输入输出（axiosGetWithRetry）

| 输入 | 类型 | 描述 |
|------|------|------|
| url | string | 请求 URL |
| config | AxiosRequestConfig? | Axios 配置 |

| 输出 | 类型 | 描述 |
|------|------|------|
| response | AxiosResponse<T> | 成功响应 |
| （异常） | Error | 非 transient 错误或超过重试次数后抛出 |

#### 状态与文件布局

- HTTP Header：Authorization、anthropic-version、anthropic-beta（ccr-byoc-2025-07-29）、x-organization-uuid
- 超时配置：fetchSession 15s，sendEventToRemoteSession 30s（考虑容器冷启动）

#### 重试与降级策略（axiosGetWithRetry）

```
1. 尝试请求
2. 失败判断：
   - 网络错误（无 response）→ 重试
   - 5xx → 重试
   - 4xx → 不重试，直接抛出
3. 重试延迟：2s → 4s → 8s → 16s（共 4 次重试 = 5 次尝试）
4. 超过 MAX_TELEPORT_RETRIES → 抛出最后错误
```

#### GetTeleportEvents 与 sessionIngress 回退

- 见主模块 teleport.tsx 中的 teleportFromSessionsAPI 设计卡

#### GitHub/GHE 预检查

- 见主模块 teleport.tsx 中的 teleportToRemote 设计卡

#### 错误与安全

| 错误 | 处理 |
|------|------|
| 401 Unauthorized | 抛出 "Session expired"，提示重新 /login |
| 404 Not Found | 抛出 "Session not found" |
| 网络错误 / 5xx | 指数退避重试 |
| 4xx 客户端错误 | 不重试，直接抛出 |

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 重试策略 | 4 次，指数退避 2/4/8/16s | 固定间隔、更多重试 | 平衡成功率与用户等待时间 |
| 超时配置 | fetchSession 15s，sendEvent 30s | 更长/更短 | 发送事件需要等待容器就绪 |
| 重试条件 | 5xx+网络，不重试 4xx | 重试 429 Too Many Requests | 4xx 通常是客户端问题，重试无效 |

#### 源码测试证据

- 源码：src/utils/teleport/api.ts（466 行）

---

### 模块设计卡：主模块 teleport.tsx（会话上传与恢复）

#### 真实入口签名与关键类型

```typescript
// src/utils/teleport.tsx

export type TeleportResult = {
  messages: Message[]
  branchName: string
}

export type TeleportProgressStep =
  | 'validating'
  | 'fetching_logs'
  | 'fetching_branch'
  | 'checking_out'
  | 'done'

export type TeleportProgressCallback = (step: TeleportProgressStep) => void

// 上云入口
export async function teleportToRemote(options: {
  initialMessage: string | null
  branchName?: string
  title?: string
  description?: string
  model?: string
  permissionMode?: PermissionMode
  ultraplan?: boolean
  signal: AbortSignal
  useDefaultEnvironment?: boolean
  environmentId?: string
  environmentVariables?: Record<string, string>
  useBundle?: boolean
  onBundleFail?: (message: string) => void
  skipBundle?: boolean
  reuseOutcomeBranch?: string
  githubPr?: { owner: string; repo: string; number: number }
}): Promise<{ id: string; title: string } | null>

// 恢复入口
export async function teleportResumeCodeSession(
  sessionId: string,
  onProgress?: TeleportProgressCallback,
): Promise<TeleportRemoteResponse>

// 辅助入口
export async function validateGitState(): Promise<void>
export async function checkOutTeleportedSessionBranch(
  branch?: string,
): Promise<{ branchName: string; branchError: Error | null }>
export async function validateSessionRepository(
  sessionData: SessionResource,
): Promise<RepoValidationResult>
export function processMessagesForTeleportResume(
  messages: Message[],
  error: Error | null,
): Message[]
export async function archiveRemoteSession(sessionId: string): Promise<void>
```

#### 输入输出（teleportToRemote）

| 输入 | 类型 | 描述 |
|------|------|------|
| initialMessage | string \| null | 初始用户消息 |
| branchName | string? | 分支名 |
| title | string? | 会话标题 |
| description | string? | 会话描述（用于生成标题/分支） |
| model | string? | 模型 |
| permissionMode | PermissionMode? | 权限模式 |
| ultraplan | boolean? | 是否 ultraplan |
| signal | AbortSignal | 取消信号 |
| useDefaultEnvironment | boolean? | 强制使用 anthropic_cloud 环境 |
| environmentId | string? | 显式环境 ID（绕过选择逻辑） |
| environmentVariables | Record<string,string>? | 环境变量 |
| useBundle | boolean? | 显式使用 bundle 模式 |
| onBundleFail | (string)=>void? | bundle 失败回调 |
| skipBundle | boolean? | 跳过 bundle 降级 |
| reuseOutcomeBranch | string? | 复用现有分支作为 outcome 分支 |
| githubPr | {owner,repo,number}? | 关联 GitHub PR |

| 输出 | 类型 | 描述 |
|------|------|------|
| result | {id,title} \| null | 成功返回会话 ID 和标题；失败返回 null |

#### 输入输出（teleportResumeCodeSession）

| 输入 | 类型 | 描述 |
|------|------|------|
| sessionId | string | 会话 ID |
| onProgress | TeleportProgressCallback? | 进度回调 |

| 输出 | 类型 | 描述 |
|------|------|------|
| response | TeleportRemoteResponse | log（Message[]）、branch（string?） |

#### 状态与文件布局

- Git 状态检查：validateGitState() 使用 getIsClean({ ignoreUntracked: true }) → 未跟踪文件不阻塞
- 仓库匹配：validateSessionRepository() 比较 owner/repo（忽略大小写）和 host（去除端口）
- 已知路径：从配置读取仓库的已知本地路径，用于不匹配时选择

#### 上云流程（Local → Remote）

```
1. OAuth 检查与刷新
2. 获取 orgUUID
3. 若显式 environmentId：
   a. useBundle=true → createAndUploadGitBundle
   b. 否则 → detectCurrentRepositoryWithHost 构造 GitSource
   c. POST /v1/sessions，直接返回
4. 否则（正常路径）：
   a. detectCurrentRepositoryWithHost 检测仓库
   b. generateTitleAndBranch（Haiku 生成，除非 title+reuseOutcomeBranch 都提供）
   c. GitHub/GHE 预检查：
      - github.com → checkGithubAppInstalled（50% 用户未完成安装）
      - GHE → 乐观尝试
   d. 预检查通过 → 构造 GitSource + GitRepositoryOutcome
   e. 预检查失败且 bundle 可用 → createAndUploadGitBundle 降级
   f. fetchEnvironments + 环境选择
   g. 构造请求：
      - permissionMode 通过 control_request 事件传递（而非 API 字段）
      - seed_bundle_file_id 按需设置
      - reuse_outcome_branches 按需设置
      - github_pr 按需设置
   h. POST /v1/sessions
5. 返回 {id, title}
```

#### 恢复流程（Remote → Local）

```
1. 策略检查：allow_remote_sessions
2. OAuth 检查
3. 获取 orgUUID
4. fetchSession
5. validateSessionRepository：
   - match / no_repo_required → 继续
   - not_in_repo → 错误提示
   - mismatch → 错误提示
6. teleportFromSessionsAPI：
   a. GetTeleportEvents（CCR v2）尝试
   b. 失败 → 回退 getSessionLogsViaOAuth（旧版兼容）
   c. 过滤：仅 isTranscriptMessage 且 !isSidechain
7. getBranchFromSession（从 outcomes 提取）
8. validateGitState（脏状态阻塞）
9. checkOutTeleportedSessionBranch：
   a. 尝试 checkout branch（本地）
   b. 失败 → fetch origin + checkout -b
   c. 失败 → checkout --track origin/branch
   d. 失败 → 返回 branchError，不阻塞恢复
   e. 成功 → ensureUpstreamIsSet
10. processMessagesForTeleportResume：
    - deserializeMessages（处理不完整 tool_use）
    - 添加 createTeleportResumeUserMessage（可见于模型）
    - 添加 createTeleportResumeSystemMessage（提示分支错误）
11. 返回 {log, branch}
```

#### GitHub/GHE 预检查与自动降级

- 预检查仅对 github.com 执行，GHE 乐观尝试
- checkGithubAppInstalled 失败且 bundleSeedGateOn → 自动降级到 bundle
- 50% 用户未完成 GitHub App 安装：无预检查会导致容器 clone 401
- CCR_FORCE_BUNDLE=1 可跳过预检查，强制 bundle 模式
- skipBundle=true（如 autofix 场景）禁用 bundle 降级

#### ignoreUntracked（未跟踪文件处理）

- validateGitState 使用 getIsClean({ ignoreUntracked: true })
- 理由：未跟踪文件不会在分支切换时丢失，且可能包含构建产物、日志等
- Git Bundle 也不包含未跟踪文件（除非在 stash 中，但 stash create 同样不包含未跟踪）

#### GetTeleportEvents 与 sessionIngress 回退

- 优先 GetTeleportEvents（CCR v2，高效）
- 回退 getSessionLogsViaOAuth（旧版兼容）
- 两者都失败 → 抛出错误

#### 分支检出失败与交付不确定性

- checkOutTeleportedSessionBranch 捕获错误，返回 {branchName, branchError}
- 上层继续恢复会话，不阻塞
- processMessagesForTeleportResume 生成警告系统消息，告知用户
- 理由：会话恢复是主要目标，分支问题可后续手动解决

#### 敏感信息处理

- OAuth token：通过 environment_variables 传递时仅在显式 environmentId 场景注入，服务端日志自动 scrub
- Git Bundle：不包含 .git/config、.git/credentials、未跟踪文件
- 会话日志：敏感 tool 参数通过服务端 scrub 处理

#### archive 而非 delete 停止远程会话

- archiveRemoteSession 使用 POST /v1/sessions/{id}/archive
- 优势：无需检查会话运行状态（archive 对 RUNNING 也成功）、可逆（用户可从网页恢复）
- 副作用：会话仍在列表中可见（直到后台清理）

#### 错误与安全

| 错误 | 处理 |
|------|------|
| 未 OAuth 登录 | 引导 /login |
| Git 脏状态（未跟踪除外） | 阻塞，提示 commit/stash |
| 仓库不匹配 | 错误提示，显示期望/当前仓库 |
| 分支检出失败 | 警告，继续恢复 |
| 会话 404 | 提示会话不存在 |
| 会话 401 | 提示重新登录 |

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 脏状态处理 | 阻塞 | 自动 stash 再恢复 | 避免自动化操作导致的数据丢失 |
| GitHub + Bundle 降级 | 自动降级 | 用户手动选择 | 50% 用户未完成 GitHub App 安装 |
| 分支失败行为 | 继续恢复 | 阻塞恢复 | 会话恢复是主要目标 |
| 权限模式传递 | control_request 事件 | API 字段 | CreateCCRSessionPayload 无此字段 |
| 停止会话 | archive | delete | archive 无运行状态检查且可逆 |
| Environment 选择 | anthropic_cloud 优先 | byoc 优先 | anthropic_cloud 兼容性最好 |

#### 源码测试证据

- 源码：src/utils/teleport.tsx（1519 行）
- 测试：tests/teleport.test.ts（含以下验证场景）
  - 无 sessionId 时使用选择器
  - 直接 sessionId 拉取和验证
  - 网络/无效会话失败不修改工作区
  - 仓库不匹配需要已知 checkout，不降级到清理
  - 脏工作区取消阻塞 checkout 和替换转录
  - 成功恢复复用 checkout 和消息处理

---

### 模块设计卡：environments（环境列表获取）

#### 真实入口签名与关键类型

```typescript
// src/utils/teleport/environments.ts

export type EnvironmentKind = 'anthropic_cloud' | 'byoc' | 'bridge'
export type EnvironmentState = 'active'

export type EnvironmentResource = {
  kind: EnvironmentKind
  environment_id: string
  name: string
  created_at: string
  state: EnvironmentState
}

export type EnvironmentListResponse = {
  environments: EnvironmentResource[]
  has_more: boolean
  first_id: string | null
  last_id: string | null
}

export async function fetchEnvironments(): Promise<EnvironmentResource[]>
export async function createDefaultCloudEnvironment(name: string): Promise<EnvironmentResource>
```

#### 输入输出（fetchEnvironments）

| 输入 | 类型 | 描述 |
|------|------|------|
| （无） | — | 内部从 OAuth 获取 token 和 orgUUID |

| 输出 | 类型 | 描述 |
|------|------|------|
| environments | EnvironmentResource[] | 可用环境列表 |

#### 状态与文件布局

- API Endpoint：GET /v1/environment_providers
- 超时：15s

#### 错误与安全

| 错误 | 处理 |
|------|------|
| 无 accessToken | 抛出错误 |
| 无 orgUUID | 抛出错误 |
| API 失败 | 抛出错误 |

#### 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 环境获取时机 | 每次 teleportToRemote 调用时获取 | 缓存 | 环境列表可能动态变化 |

#### 源码测试证据

- 源码：src/utils/teleport/environments.ts（120 行）

### 上云流程（Local → Remote）

```
本地会话
      │
      ├─ 生成标题和分支名（generateTitleAndBranchName）
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

### 恢复流程（Remote → Local）

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

### 仓库源策略

Teleport 支持三种仓库源模式，按优先级降序排列：

| 模式 | 触发条件 | 实现方式 | 优势 | 限制 |
|---|---|---|---|---|
| GitHub | 有 origin 远程 + GitHub App 已安装 | 后端从 GitHub 克隆 | 完整历史、推送权限 | 需要 GitHub 连接 |
| Git Bundle | 无 GitHub 但有 `.git/` + 功能开关启用 | `git bundle` + Files API | 无需 GitHub、包含本地 WIP | 有大小限制 |
| Empty Sandbox | 无仓库 | 空环境 | 通用场景 | 无仓库访问 |

### Git Bundle 创建与降级

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

### 文件上传与元数据

上传到 Files API 时携带：
- 文件内容：Git bundle 二进制
- 相对路径：固定为 `_source_seed.bundle`
- 元数据：bundle 范围（all/HEAD/squash）、是否包含 WIP、大小

接收端通过 SessionContext 的 `seed_bundle_file_id` 字段获取文件 ID。

### 身份要求

Teleport 功能仅支持 Claude.ai 账号认证（OAuth），不支持 API Key。关键检查点：
- `checkNeedsClaudeAiLogin()`：预检查
- `getClaudeAIOAuthTokens()`：获取 access_token
- `getOrganizationUUID()`：获取组织 ID（用于 API 路由）
- OAuth Header：`Authorization: Bearer {accessToken}` + `anthropic-beta: ccr-byoc-2025-07-29`

### 仓库验证与路径选择

远程会话关联仓库时，本地恢复需要验证仓库匹配：

```typescript
type RepoValidationResult = {
  status: 'match' | 'mismatch' | 'not_in_repo' | 'no_repo_required' | 'error';
  sessionRepo?: string; // 远程期望的仓库（owner/name）
  currentRepo?: string | null; // 本地当前仓库
  sessionHost?: string; // 远程仓库主机（github.com 或 GHE）
  currentHost?: string; // 本地仓库主机
};
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

### Git 分支管理

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

### 敏感数据处理

#### 认证令牌保护

- `CLAUDE_CODE_OAUTH_TOKEN` 可通过 SessionContext 的 `environment_variables` 传递到远程
- 仅在 `environmentId` 显式设置时注入（内部场景）
- 服务端日志中会被自动 scrub
- 不在 SessionResource 的响应中返回（服务端写只读）

#### Git Bundle 内容边界

Bundle 包含：
- Git 对象（提交、树、Blob）
- Refs 引用（`refs/seed/stash` 用于 WIP）
- 本地配置不包含

不包含：
- `.git/config` 中的凭证
- `.git/credentials`
- 未跟踪文件（除非在 stash 中）

#### 会话日志过滤

恢复时过滤：
- `isTranscriptMessage()`：仅保留转录消息
- `!isSidechain`：排除 sidechain 消息（内部调试用）
- 敏感 tool 参数通过服务端 scrub 处理

### 网络重试与降级

API 请求重试（`axiosGetWithRetry`）：
- 重试延迟：指数退避 [2s, 4s, 8s, 16s]
- 重试条件：网络错误、5xx 响应
- 不重试：4xx 响应（客户端错误）

会话日志获取降级：
1. 优先尝试 `GetTeleportEvents`（CCR v2，高效）
2. 失败回退到 `getSessionLogsViaOAuth`（旧兼容）
3. 都失败则抛出错误

### 分支检出降级

分支检出尝试序列：
1. `git checkout {branch}`（本地已存在）
2. `git checkout -b {branch} --track origin/{branch}`（从远程新建）
3. `git checkout --track origin/{branch}`（无 -b 兼容）
4. 都失败 → 返回 branchError，继续会话恢复

### 向后兼容性

- SessionResource 类型同时支持新旧 API 字段
- `parseGitHubRepository` 兼容 github.com 和 GHE
- Git Bundle 支持旧版接收端（通过标准 git 格式）

## 5. 失败语义与工程取舍

### 前置条件检查与恢复

`TeleportError` 组件处理可恢复的前置失败：

| 错误类型 | 处理方式 |
|---|---|
| `needsLogin` | 显示 `ConsoleOAuthFlow` 引导登录 |
| `needsGitStash` | 显示 `TeleportStash` 让用户选择 stash 或取消 |

`errorsToIgnore` 允许调用方跳过某些检查（如 `--remote` 跳过 needsGitStash）。

### 仓库验证失败处理

| Status | 行为 |
|---|---|
| `match` | 继续 |
| `no_repo_required` | 继续（会话无仓库关联） |
| `not_in_repo` | 错误提示，要求从正确仓库运行 |
| `mismatch` | 显示 `TeleportRepoMismatchDialog` 选择路径 |
| `error` | 通用错误提示 |

### 失败场景汇总

| 失败场景 | 处理方式 |
|---|---|
| 工作区脏状态 | 阻断，提示用户 stash 或取消 |
| OAuth 未登录 | 引导登录 |
| GitHub App 未安装 | 自动降级到 Bundle |
| Bundle 超大小限制 | 提示用户设置 GitHub |
| 仓库不匹配 | 显示对话框选择路径 |
| 分支检出失败 | 警告，继续恢复会话 |
| 网络错误 | 指数退避重试 |
| GetTeleportEvents 失败 | 回退到旧版 API |

### 工程取舍

- **阻断脏状态 vs 自动 stash**：选择阻断，安全性优先
- **GitHub + Bundle 降级 vs 单一模式**：选择降级，成功率最大化
- **Session ID vs 完整序列化**：选择 ID，与 Claude.ai 一致
- **分支失败继续 vs 阻断**：选择继续，可用性优先
- **Archive vs Delete**：选择 archive，无状态检查且可逆

## 6. 现状验收标准

### 上云功能

- 必须支持 GitHub 模式（检测 origin + GitHub App 安装）
- 必须支持 Git Bundle 模式（三级降级：all → HEAD → squash）
- 必须包含 WIP（`refs/seed/stash`）
- 必须验证 GitHub 仓库匹配
- 必须生成标题和分支名（`claude/{short-description}`）
- 必须通过初始 control_request 事件传递 permissionMode
- 必须 archive 而非 delete 停止远程会话

### 恢复功能

- 必须支持交互式 `/teleport` 命令选择会话
- 必须验证仓库匹配（owner/name 忽略大小写、host 去除端口）
- 必须支持已知路径选择
- 必须检查 Git 状态，脏状态阻断
- 必须尝试三级分支检出（本地 → 远程新建 → 远程兼容）
- 分支失败必须继续恢复会话，仅警告
- 必须过滤日志（仅 transcript、排除 sidechain）

### 安全要求

- 必须仅支持 OAuth 认证（不支持 API Key）
- OAuth token 必须在服务端日志中 scrub
- Git Bundle 必须不包含凭证
- 敏感 tool 参数必须通过服务端 scrub

### 向后兼容性

- 必须支持新旧 SessionResource 类型
- 必须兼容 github.com 和 GHE
- Git Bundle 必须支持旧版接收端

## 7. 代码与测试证据

### 现有测试

- `tests/teleport.test.ts`：Teleport 核心功能测试
  - 无 sessionId 时使用选择器
  - 直接 sessionId 拉取和验证
  - 网络/无效会话失败不修改工作区
  - 仓库不匹配需要已知 checkout，不降级到清理
  - 脏工作区取消阻断 checkout 和替换转录
  - 成功恢复复用 checkout 和消息处理

### 实现证据

- `src/cli/teleport.tsx`：Teleport 命令与 UI
- `src/cli/teleport/api.ts`：Sessions API 封装
- `src/cli/teleport/gitBundle.ts`：Git Bundle 创建与上传
- `src/cli/teleport/environments.ts`：环境选择
- `src/cli/teleport/environmentSelection.ts`：环境选择策略
- `src/cli/teleport/components.tsx`：UI 组件
- `src/cli/teleport/hooks.ts`：React hooks

### 未覆盖场景

- 大仓库 Bundle 创建性能测试
- 网络中断恢复测试
- GHE 仓库验证测试
- 并发 Teleport 操作测试

## 8. 文件覆盖与相关子系统

本设计的覆盖率文件位于 [Coverage](../../architecture/coverage/teleport.yaml)。

### 相关文件

- `src/cli/teleport.tsx`：Teleport 命令与 UI
- `src/cli/teleport/api.ts`：Sessions API 封装
- `src/cli/teleport/gitBundle.ts`：Git Bundle 创建与上传
- `src/cli/teleport/environments.ts`：环境选择
- `src/cli/teleport/environmentSelection.ts`：环境选择策略
- `src/cli/teleport/components.tsx`：UI 组件
- `src/cli/teleport/hooks.ts`：React hooks
- `tests/teleport.test.ts`：Teleport 测试

### 相关子系统

- Session Persistence：会话持久化（不同机制）
- Remote Control：远程控制（相关但不同场景）
- OAuth：Claude.ai 认证

## 9. 改进建议

1. **添加 Bundle 上传进度**：当前 Git Bundle 上传无进度显示，建议添加进度条提升用户体验。

2. **支持 Bundle 断点续传**：当前大仓库 Bundle 上传失败需要重新开始，建议添加断点续传。

3. **添加会话比较**：恢复前建议提供会话与当前工作区的差异比较，帮助用户确认。

4. **支持多会话同时恢复**：当前仅支持单个会话恢复，建议添加多会话选择和批量恢复。

5. **改进分支失败恢复**：当前分支失败仅警告，建议提供更友好的恢复选项（如创建新分支、stash 当前更改等）。

6. **添加 Teleport 历史记录**：建议保存 Teleport 历史记录，支持快速重新连接最近的会话。
