---
id: auth
batch: 3
title: Auth OAuth 与安全凭据存储设计
date: 2026-11-12
status: draft
---

# Auth OAuth 与安全凭据存储设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 需要支持多种认证方式：OAuth 2.0（Claude.ai 用户）、API key（直接 API 用户）、环境变量、FD 传递（CCR/Claude Desktop 远程会话）、第三方服务（Bedrock/Vertex/Foundry）。同时需要安全地存储敏感凭据，避免意外泄露。如果没有统一的认证系统，会导致：

- 多种认证方式优先级不明确，用户不知道哪个生效
- 令牌刷新并发不安全，多个刷新请求同时发起导致令牌失效
- 敏感凭据存储在 plaintext，安全风险高
- 日志中意外泄露 access token 或 refresh token
- 跨平台存储不一致（macOS Keychain vs Linux libsecret vs 其他）
- 托管会话（CCR/Claude Desktop）与独立 CLI 会话的认证边界不清晰

因此本子系统必须在以下约束下完成认证管理：

- 支持多种认证来源：OAuth token（环境变量、FD、安全存储）、API key（环境变量、FD、安全存储、apiKeyHelper）、第三方服务
- 明确的认证方式优先级：托管会话 FD > 环境变量 > 安全存储 > apiKeyHelper
- 并发安全的令牌刷新：同一进程内去重，跨进程用文件锁
- 多平台安全存储：macOS Keychain、Linux libsecret、fallback plaintext（有警告）
- 严格的日志边界：绝不记录完整 access token 或 refresh token，只记录前缀或标记
- 托管会话隔离：CCR/Claude Desktop 环境下不读取用户本地的 settings.json 中的凭据
- 令牌过期预判：提前 5 分钟刷新，避免请求时才发现过期
- fail-open 策略：安全存储写入失败时可以 fallback 到 plaintext，不阻止用户使用

### OAuth 与 ccshare credential 的边界

| 特性 | OAuth (Claude.ai) | ccshare credential |
|---|---|---|
| 用途 | 1P Claude.ai 用户认证 | 托管会话（CCR/Claude Desktop）传递已认证状态 |
| 传递方式 | OAuth 授权码流程、refresh token 刷新 | FD 传递、文件持久化 |
| 存储位置 | Keychain/libsecret/plaintext .credentials.json | CCR 已知路径：~/.claude/remote/.oauth_token / .api_key |
| 刷新机制 | OAuth refresh token 流程 | 无刷新，由托管方更新 |
| 隔离性 | 独立 CLI 会话使用 | 托管会话优先，隔离用户本地配置 |
| 验证边界 | 验证 token 格式、非空、JSON 有效性 | 同左，应用于所有 credential 读取 |

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 多来源认证优先级：托管 FD > 环境变量 > 安全存储 > apiKeyHelper | `getAuthTokenSource()` 和 `getAnthropicApiKeyWithSource()` 按顺序检查各来源 | 托管会话（CCR/Claude Desktop）有自己的认证注入，不应读取用户本地配置；环境变量覆盖持久存储；apiKeyHelper 作为最后备选 | 只有一种认证方式：灵活性不足，无法适配不同场景；优先级倒序：用户本地配置会覆盖托管注入，造成安全边界问题 | 需要按正确顺序检查，调试时需确认当前 token 来源 | `src/utils/auth.ts:152-206` |
| 托管会话隔离：`isManagedOAuthContext()` 阻止读取用户本地凭据 | `CLAUDE_CODE_REMOTE` 或 `CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'` 时禁用用户本地 settings 的 apiKeyHelper 和 auth 配置 | CCR/Claude Desktop 有自己的认证注入机制，用户本地配置不应干扰托管会话，避免组织策略被绕过 | 不隔离：托管会话可能意外使用用户本地 API key，导致组织策略失效 | 需要明确标记托管环境并在多个检查点应用 | `src/utils/auth.ts:91-96` |
| OAuth 令牌刷新并发去重：同一进程内 `pendingRefreshCheck` + 跨进程文件锁 | 同进程内用 `pendingRefreshCheck` 变量去重；跨进程用 lockfile 锁 `~/.claude` 目录 | 多个 CLI 实例或同一实例内多个请求同时触发刷新时，避免重复刷新导致令牌失效 | 无去重：可能触发多个刷新请求，导致某些令牌被服务器立即吊销；只用进程内去重：跨进程场景仍有问题 | 需要实现两层去重，增加复杂度 | `src/utils/auth.ts:1427-1562` |
| 安全存储分层 fallback：Keychain → libsecret → plaintext | `getSecureStorage()` 返回 `createFallbackStorage(primary, plainTextStorage)` | 优先使用平台原生安全存储；如果失败（如 Keychain 锁定、libsecret 不可用），fallback 到 plaintext 并警告用户，可用性优先 | 不 fallback：安全存储失败时无法使用 OAuth，可用性差；只用 plaintext：安全风险太高 | 需要维护多套存储实现，测试各平台 fallback 路径 | `src/utils/secureStorage/index.ts:10-20` |
| 安全存储缓存：30 秒 TTL + stale-while-error | `macOsKeychainStorage` 使用 `KEYCHAIN_CACHE_TTL_MS = 30_000`，读取失败时如果有旧缓存继续使用 | 避免频繁调用 `security` 命令（每次约 500ms）；瞬时错误时不影响可用性 | 无缓存：每次读取都 spawn 子进程，慢且可能阻塞；每次出错都返回 null：瞬时错误导致用户"被登出" | 跨进程变更可能有最多 30 秒延迟 | `src/utils/secureStorage/macOsKeychainHelpers.ts:69-91` |
| 令牌过期提前 5 分钟：`isOAuthTokenExpired()` 加 buffer | `expiresAt` 比较时加 5 分钟 buffer，提前触发刷新 | 避免用户发起请求时才发现令牌过期，导致请求失败；提前刷新保证用户体验 | 不加 buffer：用户请求可能因过期而失败；buffer 太长：令牌刷新频率高 | 需平衡安全性和用户体验，5 分钟是合理值 | `src/utils/auth.ts:344-353` |
| 日志边界：绝不记录完整 token，错误消息中 redact | `safeRefreshError()` 在错误消息中替换 token 为 `<redacted>`；所有日志使用 token 前缀或只记录状态 | 防止敏感 token 意外出现在日志、错误消息、终端输出中，避免泄露风险 | 不 redact：日志泄露可能导致账户被盗；完全不记录：调试困难 | 需要在所有输出 token 的地方做 redact，容易遗漏 | `src/commands/oauth-refresh/oauthRefresh.ts:34-41` |
| Keychain 预取：启动时并行读取，避免阻塞主线程 | `startKeychainPrefetch()` 在 main.tsx 顶部启动，`ensureKeychainPrefetchCompleted()` 等待完成；预取结果 prime 缓存 | macOS Keychain 读取慢（约 33ms），并行读取与模块初始化重叠，减少启动总时间 | 同步读取：启动时阻塞主线程，感觉慢；不缓存：每次读取都慢 | 需要在启动流程早期启动预取，同时保持代码简单 | `src/utils/secureStorage/keychainPrefetch.ts:66-89` |
| OAuth 登录双路径：自动浏览器回调 + 手动代码输入 | `OAuthService.startOAuthFlow()` 启动 `AuthCodeListener` 本地服务器 + 提供手动输入 URL | 自动化提供最佳用户体验；手动路径作为 fallback（如浏览器无法自动打开） | 只有自动路径：某些环境下无法使用；只有手动路径：用户体验差 | 需要维护本地服务器 + 手动输入两条路径 | `src/services/oauth/index.ts:32-131` |
| refresh 时 scope 扩展：Claude.ai 用户不指定 scope，获取完整权限 | `refreshOAuthToken()` 中 Claude.ai 用户传 `undefined` 作为 scope，后端允许扩展 | 新增权限时无需用户重新登录，自动获得新 scope | 总是指定原始 scope：新增功能需要用户重新登录，体验差；强制重新登录：打扰用户 | 依赖后端的 scope 扩展策略 | `src/services/oauth/client.ts:146-273` |
| API key 验证：保留用户原始文件，只在内存中验证 | `saveApiKey()` 不修改用户原始文件，只验证后保存到 Keychain/config | 避免破坏用户的自定义配置，只验证格式而不重写 | 修改用户原始文件：可能丢失用户注释或其他配置；不验证：无效 key 直到使用时才发现 | 需要正确的验证逻辑，同时保留用户原始文件 | `src/utils/auth.ts:1094-1160` |
| 401 错误处理：对比 token + 并发去重 | `handleOAuth401Error()` 用 `pending401Handlers` Map 按 token 去重，先从安全存储重新读取看是否已被刷新 | 服务器返回 401 时，可能是本地缓存过期，也可能是真的需要刷新；并发 401 时只处理一次 | 每次 401 都刷新：可能与另一个进程的刷新冲突；不检查安全存储：错过另一个进程已刷新的 token | 需要处理并发和跨进程场景 | `src/utils/auth.ts:1339-1392` |

## 3. 目标与非目标

### 状态与生命周期

- **目标**：`getClaudeAIOAuthTokens()` 返回当前有效的 OAuth tokens（来自安全存储或环境变量）
- **目标**：`checkAndRefreshOAuthTokenIfNeeded()` 检查并刷新过期 token，并发安全
- **目标**：`saveOAuthTokensIfNeeded()` 将 tokens 保存到安全存储
- **目标**：`handleOAuth401Error()` 处理 API 返回的 401 错误，强制刷新
- **非目标**：不保证 token 在网络请求过程中始终有效（服务器端可能随时吊销）

### 接口与数据

- **目标**：`OAuthTokens` 类型包含 access token、refresh token、expiresAt、scopes、subscriptionType、rateLimitTier
- **目标**：`SecureStorage` 接口统一各平台存储操作（read/readAsync/update/delete）
- **目标**：`getAnthropicApiKey()` 返回当前 API key（按优先级来源）
- **目标**：`isAnthropicAuthEnabled()` 判断当前是否使用 Anthropic 原生认证（非第三方）
- **非目标**：不提供 OAuth 授权流程的 UI（由 `/login` 命令负责）

### 执行与环境

- **目标**：支持 macOS、Linux、Windows 各平台的安全存储或 fallback
- **目标**：支持 CCR 远程环境的 FD 传递 token，支持 subprocess 访问
- **目标**：支持 Claude Desktop 托管环境的隔离
- **目标**：失败开放：安全存储失败时不阻止使用，fallback 到 plaintext 并警告
- **非目标**：不支持 Web 环境的认证

### 依赖边界

- **Settings**：auth 相关配置（apiKeyHelper 等）从 settings 读取，但 auth 凭据本身不进入 settings 域
- **OAuth Service**：OAuth 授权流程由 `OAuthService` 负责，本文只描述 token 管理和存储
- **Third-party Services**：Bedrock/Vertex/Foundry 认证由各自模块负责，本文只描述边界

## 4. 架构、模块与数据流

### 4.0 模块设计卡

#### 模块设计卡：OAuth 浏览器/手动流程 (OAuthService)

| 项目 | 内容 |
|-----|-----|
| **真实入口签名** | `OAuthService.startOAuthFlow(authURLHandler: (url: string, automaticUrl?: string) => Promise<void>, options?: { loginWithClaudeAi?: boolean; inferenceOnly?: boolean; expiresIn?: number; orgUUID?: string; loginHint?: string; loginMethod?: string; skipBrowserOpen?: boolean }): Promise<OAuthTokens>` |
| **关键类型** | `OAuthTokens { accessToken: string; refreshToken: string | null; expiresAt: number | null; scopes: string[]; subscriptionType: SubscriptionType | null; rateLimitTier: RateLimitTier | null; profile?: OAuthProfileResponse; tokenAccount?: { uuid: string; emailAddress: string; organizationUuid?: string } }` |
| **输入** | 回调函数 `authURLHandler` 处理授权 URL；可选参数控制登录方式、scope、组织等 |
| **输出** | 返回完整的 `OAuthTokens` 对象；失败抛出异常 |
| **状态与文件布局** | - 内存状态：`codeVerifier`（PKCE 验证串）、`authCodeListener`（本地回调服务器）、`port`（监听端口）、`manualAuthCodeResolver`（手动流程 Promise）<br>- 无持久化文件，token 委托给 `auth.ts` 保存 |
| **认证流程** | 1. 启动本地服务器 `AuthCodeListener` 监听随机端口<br>2. 生成 PKCE `codeVerifier` + `codeChallenge`、随机 `state`<br>3. 构建两条授权 URL：`manualFlowUrl`（用户手动复制粘贴 code）、`automaticFlowUrl`（localhost 回调）<br>4. 调用 `authURLHandler(manualFlowUrl, automaticFlowUrl)` 展示给用户；非 `skipBrowserOpen` 时自动打开浏览器到 `automaticFlowUrl`<br>5. 等待授权码：自动流程通过 `localhost:port/callback` 接收，手动流程通过 `handleManualAuthCodeInput()` 接收<br>6. 用 `exchangeCodeForTokens()` 交换 tokens<br>7. 用 `fetchProfileInfo()` 获取用户订阅信息<br>8. 自动流程成功时调用 `AuthCodeListener.handleSuccessRedirect()` 展示成功页面<br>9. 返回格式化后的 `OAuthTokens` |
| **错误与安全** | - PKCE 保护：`codeVerifier` 仅在客户端内存中，不落地<br>- `state` 参数防止 CSRF 攻击<br>- 失败时若有 pending 自动流程，调用 `handleErrorRedirect()` 展示错误页<br>- 最终调用 `cleanup()` 关闭本地服务器释放端口 |
| **设计取舍/备选** | - **双路径设计**：自动路径最佳体验，手动路径作为 fallback（无浏览器环境）<br>- 备选：仅手动路径 → 体验差；仅自动路径 → 某些环境不可用<br>- **本地服务器随机端口**：避免端口冲突，更安全<br>- 备选：固定端口 → 冲突风险高 |
| **源码测试证据** | `src/services/oauth/index.ts:21-196` |

---

#### 模块设计卡：Token 刷新并发与跨进程锁 (checkAndRefreshOAuthTokenIfNeeded)

| 项目 | 内容 |
|-----|-----|
| **真实入口签名** | `function checkAndRefreshOAuthTokenIfNeeded(retryCount = 0, force = false): Promise<boolean>` |
| **关键类型** | `pendingRefreshCheck: Promise<boolean> | null`（同进程去重）、`lockfile.lock(path)`（跨进程锁） |
| **输入** | `retryCount`（锁获取重试次数，默认 0）；`force`（强制刷新，忽略过期检查，默认 false） |
| **输出** | `true` 表示已刷新；`false` 表示未过期/已被其他进程刷新/失败 |
| **状态与文件布局** | - 内存状态：`pendingRefreshCheck`（模块级变量，同进程去重）<br>- 文件系统：锁文件位于 `~/.claude/` 目录（由 `lockfile` 模块管理）<br>- 验证点：`regular file`（锁文件是常规文件）、`0o600`（权限控制）、`JSON`（token 格式）、`token` 非空（有效性验证） |
| **刷新流程** | 1. **同进程去重**：`retryCount === 0 && !force` 时检查 `pendingRefreshCheck`，有则复用其结果<br>2. 调用 `invalidateOAuthCacheIfDiskChanged()` 检查 `.credentials.json` mtime，变更则清缓存<br>3. **过期检查**：`force = false` 时调用 `isOAuthTokenExpired(tokens.expiresAt)`（提前 5 分钟）<br>4. **二次读取**：异步调用 `getClaudeAIOAuthTokensAsync()` 重新读取，检查是否已被其他进程刷新<br>5. **跨进程锁获取**：调用 `lockfile.lock(getClaudeConfigHomeDir())`；失败时等待重试（最多 5 次，指数退避）<br>6. **持有锁后三次检查**：再次异步读取 tokens，确认仍需刷新（等待锁期间可能被其他进程刷新）<br>7. 调用 `refreshOAuthToken()` 请求新 tokens<br>8. `saveOAuthTokensIfNeeded()` 保存新 tokens<br>9. `clearOAuthTokenCache()` 清空缓存<br>10. 释放锁，返回结果<br>11. **Stale token 处理**：若刷新失败但有缓存的未过期 tokens，返回 `true` |
| **错误与安全** | - **刷新去重**：同进程 `pendingRefreshCheck` + 跨进程 `lockfile` 双重去重<br>- **密钥不进入日志/argv**：刷新失败时 `safeRefreshError()` 将 token 替换为 `<redacted>`<br>- **锁释放保证**：Promise `finally` 块中调用 `release()`<br>- 锁获取失败达到 `MAX_RETRIES=5` 时记录事件并返回 `false` |
| **设计取舍/备选** | - **双重去重**：同进程变量（快速无 IO）+ 跨进程文件锁（正确但慢）<br>- 备选：仅进程内 → 跨进程场景不安全；仅文件锁 → 同进程内不必要的 IO<br>- **提前 5 分钟刷新**：避免请求时才发现过期<br>- 备选：无提前量 → 用户体验差；过长 → 刷新频繁<br>- **锁获取后重新检查**：避免等待期间被其他进程刷新导致的重复刷新<br>- 备选：不检查 → 可能用无效 refresh token 请求导致被吊销 |
| **源码测试证据** | `src/utils/auth.ts:1428-1562`、`tests/oauthRefresh.test.ts` |

---

#### 模块设计卡：Keychain / libsecret / Plaintext Fallback 多层存储 (SecureStorage)

| 项目 | 内容 |
|-----|-----|
| **真实入口签名** | `function getSecureStorage(): SecureStorage`；`interface SecureStorage { name: string; read(): SecureStorageData | null; readAsync(): Promise<SecureStorageData | null>; update(data: SecureStorageData): { success: boolean; warning?: string }; delete(): boolean }` |
| **关键类型** | `SecureStorageData { claudeAiOauth?: OAuthTokens; trustedDeviceToken?: string; pluginSecrets?: Record<string, Record<string, string>>; mcpOAuth?: Record<string, McpOAuthTokenData>; mcpOAuthClientConfig?: Record<string, McpOAuthClientConfig>; mcpXaaIdp?: Record<string, McpXaaIdpData>; mcpXaaIdpConfig?: Record<string, McpXaaIdpConfig> }` |
| **输入** | `update()` 接收完整 `SecureStorageData`；`read()` / `delete()` 无参数 |
| **输出** | `read()` 返回 `SecureStorageData | null`；`update()` 返回 `{ success: boolean; warning?: string }`；`delete()` 返回 `boolean` |
| **状态与文件布局** | - macOS：Keychain 条目 `service="Claude Code-credentials" account="$USER"`，30 秒 TTL 缓存<br>- Linux：libsecret (secret-tool) 条目 `service="Claude Code-credentials" account="$USER"`<br>- Fallback：`~/.claude/.credentials.json`，权限 `0o600`，plaintext JSON<br>- **验证层级**：`regular file`（所有文件读取）、`0o600`（plaintext/CCR 文件）、`≤4096`（Keychain stdin 限制）、`JSON`（格式验证）、`token`（有效性） |
| **存储读取/回退流程** | 1. **平台选择**：`getSecureStorage()` 按平台返回组合后的 `createFallbackStorage(primary, secondary)`<br>   - macOS：`primary=macOsKeychainStorage`, `secondary=plainTextStorage`<br>   - Linux：`primary=linuxSecretStorage`, `secondary=plainTextStorage`<br>   - 其他：`plainTextStorage`<br>2. **read() 流程**：`createFallbackStorage.read()` 优先调用 `primary.read()`，返回非 null 则直接返回，否则调用 `secondary.read()` 并兜底返回 `{}`<br>3. **update() 流程**：<br>   - 先读取 `primaryDataBefore = primary.read()`<br>   - 尝试 `primary.update(data)`，成功则：<br>     - 若 `primaryDataBefore === null`（首次从 secondary 迁移），调用 `secondary.delete()` 清理旧数据<br>     - 返回结果<br>   - primary 失败则调用 `secondary.update(data)`，成功则：<br>     - 若 `primaryDataBefore !== null`（primary 有 stale 数据），调用 `primary.delete()` 防止 stale 数据 shadow 新数据<br>     - 返回结果（含 `warning`）<br>   - 都失败返回 `{ success: false }`<br>4. **delete() 流程**：同时删除 primary 和 secondary，任一成功则返回 true |
| **macOS Keychain 特殊流程** | - **缓存策略**：30 秒 TTL，`keychainCacheState` 含 `{ data, cachedAt, generation, readInFlight }`<br>- **Stale-while-error**：读取失败时若有旧缓存继续使用，不返回 null<br>- **Stdin 优先**：`security -i` 通过 stdin 输入命令避免 credentials 出现在 ps/top，限制 `SECURITY_STDIN_LINE_LIMIT=4096-64` 字节<br>- **Hex 编码**：payload 转 hex 避免 escaping 问题<br>- **Fallback to argv**：超过限制时用 argv 模式（有泄露风险但比 plaintext 好）<br>- **Generation 防止 stale 写**：`readAsync()` 捕获 generation，若中途被 invalidate 则不覆盖缓存<br>- **预取优化**：启动时 `startKeychainPrefetch()` 并行读取，结果 prime 缓存 |
| **Linux Secret Service 特殊流程** | - 调用 `secret-tool lookup/store/clear` 命令<br>- 默认超时 `DEFAULT_TIMEOUT_MS=5000`ms<br>- 失败时 fallback 到 plaintext |
| **错误与安全** | - **密钥不进入日志/argv**：macOS Keychain 优先 stdin 模式，仅超出 4096 字节时 fallback 到 argv（hex 编码）<br>- **权限控制**：plaintext 文件强制 `0o600`；CCR 目录 `0o700`<br>- **Stale token 防护**：primary update 失败时删除 primary 数据，防止 stale 数据 shadow secondary 新数据<br>- **Stale-while-error**：Keychain 读取失败时返回旧缓存，不直接失败 |
| **设计取舍/备选** | - **多层 fallback**：可用性优先，安全存储失败时不阻止使用<br>- 备选：不 fallback → 可用性差；仅 plaintext → 不安全<br>- **30 秒缓存**：避免频繁 spawn `security` 命令（每次 ~500ms）<br>- 备选：无缓存 → 慢；更长 → 跨进程变更延迟更久<br>- **Stdin 优先 + argv fallback**：大多数情况下 credentials 不出现在进程列表<br>- 备选：仅 argv → 易泄露；仅 stdin → 大 payload 失败<br>- **迁移时清理 secondary**：首次写入 primary 成功时删除 secondary 避免混淆<br>- 备选：不删除 → 用户可能困惑为何有两份 |
| **源码测试证据** | `src/utils/secureStorage/index.ts:7-20`、`src/utils/secureStorage/macOsKeychainStorage.ts:26-231`、`src/utils/secureStorage/linuxSecretStorage.ts:72-128`、`src/utils/secureStorage/plainTextStorage.ts:19-84`、`src/utils/secureStorage/fallbackStorage.ts:7-70`、`tests/linuxSecretStorage.test.ts` |

---

#### 模块设计卡：CCShare Credential (authFileDescriptor)

| 项目 | 内容 |
|-----|-----|
| **真实入口签名** | `function getOAuthTokenFromFileDescriptor(): string | null`、`function getApiKeyFromFileDescriptor(): string | null`、`function maybePersistTokenForSubprocesses(path: string, token: string, tokenName: string): void` |
| **关键类型** | `CCR_OAUTH_TOKEN_PATH = "/home/claude/.claude/remote/.oauth_token"`、`CCR_API_KEY_PATH = "/home/claude/.claude/remote/.api_key"` |
| **输入** | 环境变量：`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` / `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`（指向 FD 编号）；文件系统：CCR 已知路径 |
| **输出** | token 字符串或 null |
| **状态与文件布局** | - 内存：`bootstrap/state` 中的 `getOauthTokenFromFd()` / `setOauthTokenFromFd()` 缓存<br>- 文件系统：`/home/claude/.claude/remote/.oauth_token`、`.api_key`、`.session_ingress_token`，权限 `0o600`；目录 `0o700`<br>- **凭证所有权与权限边界**：仅在 `CLAUDE_CODE_REMOTE` 环境中写入，隔离用户本地配置；FD 传递避免 token 出现在 env/argv/ps |
| **读取流程** | 1. 检查 `bootstrap/state` 缓存，有则直接返回<br>2. 检查环境变量 `[envVar]`（如 `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`）：<br>   - 无 env var：直接尝试从 `wellKnownPath` 读取文件<br>   - 有 env var：解析 FD 编号，从 `/dev/fd/${fd}`（macOS/BSD）或 `/proc/self/fd/${fd}`（Linux）读取<br>3. FD 读取成功则调用 `maybePersistTokenForSubprocesses()` 写入 `wellKnownPath`<br>4. FD 读取失败（ENXIO 等，常见于 subprocess）则 fallback 到 `wellKnownPath` 文件<br>5. 结果存入缓存并返回 |
| **持久化流程 (maybePersistTokenForSubprocesses)** | 1. 检查 `CLAUDE_CODE_REMOTE` 环境变量，非 CCR 环境直接返回<br>2. 创建目录 `/home/claude/.claude/remote/`，mode `0o700`<br>3. 写入 token 到指定路径，mode `0o600`<br>4. 记录 debug 日志 |
| **错误与安全** | - **权限边界**：仅在 CCR 环境写入磁盘，非托管环境不污染用户文件系统<br>- **FD 传递安全**：token 不在 env/argv/ps 中出现<br>- **权限控制**：文件强制 `0o600`，目录 `0o700`<br>- **静默 ENOENT**：CCR 以外路径不存在是预期，不记录错误；其他错误（EACCES 等）记录 debug 日志 |
| **设计取舍/备选** | - **FD + 已知文件双路径**：FD 更安全但无法跨越 exec/tmux 边界，已知文件作为 fallback 供 subprocess 使用<br>- 备选：仅 FD → subprocess 不可用；仅文件 → 安全边界弱<br>- **仅 CCR 持久化**：防止污染用户本地文件系统<br>- 备选：总是持久化 → 托管与本地边界模糊 |
| **源码测试证据** | `src/utils/authFileDescriptor.ts:13-196` |

---

#### 模块设计卡：错误脱敏 (safeRefreshError)

| 项目 | 内容 |
|-----|-----|
| **真实入口签名** | `function safeRefreshError(error: unknown, tokens: OAuthTokens): string` |
| **关键类型** | `OAuthTokens { accessToken: string; refreshToken: string | null; ... }` |
| **输入** | 原始 `error`（可能包含 token）；当前 `tokens` 对象 |
| **输出** | 脱敏后的错误消息字符串，token 被替换为 `<redacted>` |
| **状态与文件布局** | 无状态，纯函数；不读写文件 |
| **脱敏流程** | 1. 调用 `errorMessage(error)` 获取原始错误字符串<br>2. 遍历 `[tokens.accessToken, tokens.refreshToken]`<br>3. 对每个非空 secret，调用 `message.replaceAll(secret, '<redacted>')`<br>4. 返回替换后的消息 |
| **错误与安全** | - **密钥不进入日志/argv**：所有输出 token 的地方调用 `safeRefreshError()` 或等效 redact<br>- 不抛出异常，总是返回字符串 |
| **设计取舍/备选** | - **手动替换**：简单直接，需要在所有输出 token 的地方调用<br>- 备选：结构化错误类型自动 redact → 需修改所有错误处理路径（当前未采用）；模板字符串 tag → 侵入性大 |
| **源码测试证据** | `src/commands/oauth-refresh/oauthRefresh.ts:34-40`、`tests/oauthRefresh.test.ts` |

---

### 4.1 入口与公共契约

```typescript
// 主要读取入口
function isAnthropicAuthEnabled(): boolean  // 是否使用 Anthropic 原生认证
function getAuthTokenSource(): { source: AuthTokenSource, hasToken: boolean }
function getClaudeAIOAuthTokens(): OAuthTokens | null  // 同步读取，有缓存
function getClaudeAIOAuthTokensAsync(): Promise<OAuthTokens | null>  // 异步读取，避免阻塞
function getAnthropicApiKey(): string | null
function getAnthropicApiKeyWithSource(): { key: string | null, source: ApiKeySource }

// 主要写入入口
function saveOAuthTokensIfNeeded(tokens: OAuthTokens): { success: boolean, warning?: string }
function saveApiKey(apiKey: string): Promise<void>
function removeApiKey(): Promise<void>

// Token 刷新与错误处理
function isOAuthTokenExpired(expiresAt: number | null): boolean
function checkAndRefreshOAuthTokenIfNeeded(retryCount?: number, force?: boolean): Promise<boolean>
function handleOAuth401Error(failedAccessToken: string): Promise<boolean>
function clearOAuthTokenCache(): void

// 账户信息
function isClaudeAISubscriber(): boolean
function hasProfileScope(): boolean
function getSubscriptionType(): SubscriptionType | null
function getOauthAccountInfo(): AccountInfo | undefined

// 安全存储
function getSecureStorage(): SecureStorage
```

调用方式：

1. **启动路径**：`main.tsx` 先 `startKeychainPrefetch()` 并行读取 Keychain，然后各模块按需调用 `getClaudeAIOAuthTokens()` 或 `getAnthropicApiKey()`
2. **请求路径**：API 请求前调用 `checkAndRefreshOAuthTokenIfNeeded()` 确保 token 有效；收到 401 时调用 `handleOAuth401Error()`
3. **登录路径**：`/login` 命令通过 `OAuthService` 完成 OAuth 流程，得到 tokens 后调用 `saveOAuthTokensIfNeeded()`
4. **登出路径**：`/logout` 命令清理 tokens 和缓存

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `auth.ts` | `_apiKeyHelperCache`、`_apiKeyHelperInflight`、`_apiKeyHelperEpoch`、`pendingRefreshCheck`、`pending401Handlers`、`lastCredentialsMtimeMs` | `getClaudeAIOAuthTokens`、`checkAndRefreshOAuthTokenIfNeeded`、`handleOAuth401Error`、`saveOAuthTokensIfNeeded`、`getAnthropicApiKeyWithSource` | OAuth 授权流程（由 OAuthService 负责） | 接收 OAuthTokens，调用 secureStorage |
| `secureStorage/index.ts` | 无（工厂函数） | `getSecureStorage`（返回平台适配的存储实现） | 实际存储操作（委托给各平台实现） | 返回 SecureStorage 接口 |
| `secureStorage/macOsKeychainStorage.ts` | `keychainCacheState`（cache、generation、readInFlight） | `read`、`readAsync`、`update`、`delete` | Linux/Windows 存储 | 调用 security 命令，使用 keychainCacheState |
| `secureStorage/linuxSecretStorage.ts` | 无（无状态） | `read`、`readAsync`、`update`、`delete` | macOS/Windows 存储 | 调用 secret-tool 命令 |
| `secureStorage/plainTextStorage.ts` | 无（直接读写文件） | `read`、`readAsync`、`update`、`delete`（返回警告） | 安全存储 | 读写 ~/.claude/.credentials.json，权限 0o600 |
| `secureStorage/fallbackStorage.ts` | 无（组合模式） | `read`（优先 primary）、`update`（primary 成功则 delete secondary）、`delete`（两者都删） | 实际存储（委托给 primary/secondary） | 组合两个 SecureStorage |
| `secureStorage/keychainPrefetch.ts` | `legacyApiKeyPrefetch`、`prefetchPromise` | `startKeychainPrefetch`、`ensureKeychainPrefetchCompleted`、`getLegacyApiKeyPrefetchResult` | 实际 Keychain 读写 | 调用 spawn 并行读取，prime keychainCacheState |
| `services/oauth/index.ts` | `codeVerifier`、`authCodeListener`、`port`、`manualAuthCodeResolver` | `startOAuthFlow`、`handleManualAuthCodeInput`、`cleanup` | Token 存储（委托给 auth.ts） | 返回 OAuthTokens 给调用方 |
| `services/oauth/client.ts` | 无（纯函数） | `buildAuthUrl`、`exchangeCodeForTokens`、`refreshOAuthToken`、`fetchProfileInfo`、`createAndStoreApiKey`、`storeOAuthAccountInfo` | HTTP 客户端细节（由 axios 负责） | 调用 OAuth endpoints，返回 tokens/profile |
| `authFileDescriptor.ts` | 无（纯函数 + bootstrap/state 缓存） | `getOAuthTokenFromFileDescriptor`、`getApiKeyFromFileDescriptor`、`maybePersistTokenForSubprocesses` | FD 本身的传递（由启动环境负责） | 从环境变量指定的 FD 读取 token，持久化到 CCR 已知路径 |
| `cli/handlers/auth.ts` | 无（命令处理） | `authLogin`、`authLogout`、`authStatus` | 实际认证逻辑（委托给 auth.ts 和 OAuthService） | CLI 入口，调用底层模块 |
| `commands/oauth-refresh/oauthRefresh.ts` | 无（命令实现） | `runOauthRefresh`、`safeRefreshError` | Token 存储（委托给 auth.ts） | `/oauth-refresh` 命令实现 |

状态位置与理由：

- **apiKeyHelper 缓存**放在 `auth.ts` 模块级变量：需要缓存结果 + 跟踪 in-flight 请求 + epoch 避免竞态
- **pendingRefreshCheck** 放在 `auth.ts` 模块级变量：同进程内去重刷新请求
- **pending401Handlers** 放在 `auth.ts` 模块级变量：同进程内去重 401 处理（按 failedAccessToken 分组）
- **keychainCacheState** 放在 `macOsKeychainHelpers.ts` 模块级变量：Keychain 读取缓存 + generation 检测失效 + in-flight 去重
- **keychainPrefetch** 状态放在 `keychainPrefetch.ts` 模块级变量：启动时一次性并行读取，结果供后续使用

### 4.3 Credential 读取与验证

#### 验证规则与模块边界

| 验证项 | 应用场景 | 所属模块 | 验证内容 |
|---|---|---|---|
| regular file | 所有文件读取 | plainTextStorage、authFileDescriptor | 必须是常规文件，非目录/设备 |
| 0o600 权限 | plaintext fallback、CCR 已知路径 | plainTextStorage、authFileDescriptor | 文件权限必须为 0o600，防止其他用户读取 |
| ≤4096 字节 | macOS Keychain stdin 模式 | macOsKeychainStorage | 命令行长度不超过 4096-64 字节，超过则 fallback 到 argv |
| 合法 JSON | 所有 credential 解析 | 所有存储模块 | 必须能解析为 SecureStorageData 结构 |
| 非空 token | OAuth/API key 使用前 | auth.ts | access_token/api_key 不能为空字符串 |

#### 验证流程

```
读取 credential
  ↓
验证是 regular file (非目录/设备)
  ↓
验证文件权限 0o600 (plaintext/CCR 路径)
  ↓
读取内容，验证 ≤4096 字节 (Keychain stdin 限制)
  ↓
JSON 解析，验证合法 SecureStorageData 结构
  ↓
验证 token 非空 (使用时)
  ↓
返回 credential 或 fallback
```

#### Keychain 特殊限制

- macOS Keychain 使用 `security -i` 模式通过 stdin 输入命令，避免凭证出现在 ps/top
- stdin 限制 4096 字节（实际使用 4096-64 字节作为安全边际）
- 超过限制时 fallback 到 argv 模式（hex 编码，仍有泄露风险但比 plaintext 好）
- 跨进程变更有 30 秒缓存窗口

### 4.4 主控制流

完整 OAuth 登录与 token 刷新流（端到端）：

```text
用户运行 /login
  ↓
authLogin() 调用 OAuthService.startOAuthFlow()
  ↓
OAuthService 启动 AuthCodeListener 本地服务器（随机端口）
  ↓
打开浏览器到 buildAuthUrl()（自动）+ 显示手动输入 URL
  ↓
等待授权码：
  ├─ 自动路径：用户在浏览器登录后回调到 localhost:port → AuthCodeListener 接收 code
  └─ 手动路径：用户手动复制 code 粘贴 → handleManualAuthCodeInput()
  ↓
exchangeCodeForTokens() 用 code 换 tokens
  ↓
fetchProfileInfo() 获取用户 profile 和 subscription
  ↓
installOAuthTokens()：
  ├─ performLogout() 清理旧状态
  ├─ storeOAuthAccountInfo() 保存账户信息到 global config
  ├─ saveOAuthTokensIfNeeded() 保存 tokens 到安全存储
  ├─ fetchAndStoreUserRoles() 获取用户角色
  ├─ fetchAndStoreClaudeCodeFirstTokenDate() 记录首次登录时间
  └─ 如果是 Console 用户 → createAndStoreApiKey() 创建并保存 API key
  ↓
validateForceLoginOrg() 验证组织匹配（如有强制组织策略）
  ↓
登录成功
```

Token 刷新流：

```text
API 请求前调用 checkAndRefreshOAuthTokenIfNeeded()
  ↓
检查 pendingRefreshCheck → 有 in-flight 则等待
  ↓
invalidateOAuthCacheIfDiskChanged()：检查 .credentials.json mtime，变更则清缓存
  ↓
检查 token 是否过期（加 5 分钟 buffer）
  ├─ 未过期 → 返回 false（无需刷新）
  └─ 已过期 → 继续
  ↓
再次异步读取 tokens（看是否另一个进程已刷新）
  ├─ 已刷新 → 返回 false
  └─ 仍过期 → 继续
  ↓
尝试获取文件锁（lockfile.lock(~/.claude)）
  ├─ 获取失败 → 重试（最多 5 次，带指数退避）
  └─ 获取成功 → 继续
  ↓
再次检查 tokens（持有锁后，看是否另一个进程在等待期间已刷新）
  ├─ 已刷新 → 释放锁，返回 false
  └─ 仍过期 → 继续
  ↓
refreshOAuthToken() 调用 OAuth endpoint 刷新
  ↓
saveOAuthTokensIfNeeded() 保存新 tokens
  ↓
clearOAuthTokenCache() 清空缓存
  ↓
释放锁
  ↓
返回 true（已刷新）
```

401 错误处理流：

```text
API 返回 401，调用 handleOAuth401Error(failedAccessToken)
  ↓
检查 pending401Handlers 中是否已有该 failedAccessToken 的 in-flight 处理
  ├─ 有 → 等待并复用结果
  └─ 无 → 继续
  ↓
clearOAuthTokenCache() 清空缓存
  ↓
getClaudeAIOAuthTokensAsync() 重新读取 tokens
  ↓
对比 access token：
  ├─ 不同（另一个进程/线程已刷新）→ 直接返回 true
  └─ 相同（需要刷新）→ 继续
  ↓
checkAndRefreshOAuthTokenIfNeeded(0, true) 强制刷新
  ↓
返回结果
```

安全存储读写流（macOS Keychain 为例）：

```text
调用 read()
  ↓
检查 keychainCacheState.cache → 未过期直接返回
  ↓
调用 security find-generic-password 读取
  ↓
解析 JSON → 存入缓存（cachedAt + generation）
  ↓
返回数据
  └─ 如果读取失败但有旧缓存 → stale-while-error，返回旧缓存并记录警告

调用 update(data)
  ↓
clearKeychainCache() 清空缓存（generation++）
  ↓
JSON 序列化 → 转 hex（避免 escaping 问题）
  ↓
检查命令长度是否 ≤ SECURITY_STDIN_LINE_LIMIT（4096-64）
  ├─ 是 → security -i，通过 stdin 输入命令
  └─ 否 → 直接命令行参数（argv）
  ↓
security add-generic-password -U 更新
  ↓
成功 → 更新缓存（新 generation）
  ↓
返回结果
```

### 4.5 数据结构与持久化

关键数据结构：

```typescript
// OAuth tokens
type OAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null  // Unix timestamp ms
  scopes: string[]
  subscriptionType: SubscriptionType | null  // 'max' | 'pro' | 'enterprise' | 'team'
  rateLimitTier: RateLimitTier | null
  profile?: OAuthProfileResponse  // 可选，仅在登录/刷新时获取
  tokenAccount?: {  // 可选，token exchange 返回的账户信息
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}

// 安全存储数据
type SecureStorageData = {
  claudeAiOauth?: OAuthTokens
  trustedDeviceToken?: string
  pluginSecrets?: Record<string, Record<string, string>>
  mcpOAuth?: Record<string, McpOAuthTokenData>
  mcpOAuthClientConfig?: Record<string, McpOAuthClientConfig>
  mcpXaaIdp?: Record<string, McpXaaIdpData>
  mcpXaaIdpConfig?: Record<string, McpXaaIdpConfig>
}

// 安全存储接口
type SecureStorage = {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean, warning?: string }
  delete(): boolean
}

// API key 来源
type ApiKeySource =
  | 'ANTHROPIC_API_KEY'
  | 'apiKeyHelper'
  | '/login managed key'
  | 'none'

// Auth token 来源
type AuthTokenSource =
  | 'CLAUDE_CODE_OAUTH_TOKEN'
  | 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'
  | 'CCR_OAUTH_TOKEN_FILE'
  | 'claude.ai'
  | 'apiKeyHelper'
  | 'none'
```

持久化：

- **安全存储（macOS）**：Keychain 条目 `service="Claude Code-credentials" account="$USER"`，存储 JSON 格式的 `SecureStorageData`
- **安全存储（Linux）**：libsecret 条目 `service="Claude Code-credentials" account="$USER"`，存储 JSON
- **Fallback 存储**：`~/.claude/.credentials.json`，权限 0o600，plaintext JSON（带警告）
- **Legacy API key（macOS）**：Keychain 条目 `service="Claude Code" account="$USER"`（无 suffix）
- **Global config**：`~/.claude.json`，存储账户信息（`oauthAccount`）、subscription 信息等（非敏感）
- **CCR 已知路径**：`/home/claude/.claude/remote/.oauth_token` 和 `.api_key`，权限 0o600，供 subprocess 访问

恢复时：

- 按平台优先级从 Keychain/libsecret 读取，失败则 fallback 到 plaintext
- CCR 环境下优先从 FD 读取，失败则从已知路径文件读取
- 缓存失效时重新读取存储

### 4.5a 验证规则与模块归属补充

| 验证项 | 应用场景 | 所属模块 | 验证内容 |
|-----|-----|-----|-----|
| **regular file** | 所有文件读取 | `plainTextStorage`、`authFileDescriptor` | 必须是常规文件，非目录/设备 |
| **0o600 权限** | plaintext fallback、CCR 已知路径 | `plainTextStorage`、`authFileDescriptor` | 文件权限必须为 0o600，防止其他用户读取；CCR 目录权限 0o700 |
| **≤4096 字节** | macOS Keychain stdin 模式 | `macOsKeychainStorage` | 命令行长度不超过 4096-64 字节，超过则 fallback 到 argv |
| **合法 JSON** | 所有 credential 解析 | 所有存储模块 | 必须能解析为 `SecureStorageData` 结构 |
| **token 非空** | OAuth/API key 使用前 | `auth.ts` | `access_token/api_key` 不能为空字符串 |

#### 刷新去重与 Stale Token 防护

| 层级 | 机制 | 所属模块 | 防护目标 |
|-----|-----|-----|-----|
| **同进程去重** | `pendingRefreshCheck: Promise<boolean> | null` | `auth.ts` | 同进程内并发刷新请求只执行一次 |
| **跨进程锁** | `lockfile.lock(getClaudeConfigHomeDir())` | `auth.ts` | 跨进程并发刷新只执行一次 |
| **持有锁后二次检查** | 获取锁后再次异步读取 tokens | `auth.ts` | 等待锁期间可能被其他进程刷新 |
| **Stale token shadow 防护** | primary update 失败时调用 `primary.delete()` | `fallbackStorage.ts` | 防止 primary 旧数据 shadow secondary 新数据 |
| **Stale-while-error** | Keychain 读取失败时返回旧缓存 | `macOsKeychainStorage.ts` | 瞬时错误不导致用户"被登出" |
| **Generation 防 stale 写** | `keychainCacheState.generation` | `macOsKeychainHelpers.ts` | 防止 `readAsync()` 中途被 invalidate 后用 stale 结果覆盖缓存 |

#### 密钥不进入日志/argv 策略

| 层级 | 机制 | 所属模块 | 场景 |
|-----|-----|-----|-----|
| **Stdin 优先** | `security -i` 通过 stdin 输入命令 | `macOsKeychainStorage.ts` | macOS Keychain 写入，避免 payload 出现在 ps/top |
| **Hex 编码** | payload 转 hex 后传入 | `macOsKeychainStorage.ts` | 必须用 argv 时，hex 编码不直观可见 |
| **Redact 替换** | `safeRefreshError()` 将 token 替换为 `<redacted>` | `oauthRefresh.ts` | 错误消息、日志输出 |
| **环境隔离** | CCR 环境不读取用户本地配置 | `auth.ts` | 托管会话凭证边界 |

#### Linux Secret Service Fallback

| 层级 | 机制 | 所属模块 |
|-----|-----|-----|
| **Primary 存储** | `linuxSecretStorage` 调用 `secret-tool lookup/store/clear` | `linuxSecretStorage.ts` |
| **Fallback 存储** | `createFallbackStorage(linuxSecretStorage, plainTextStorage)` | `getSecureStorage()` |
| **超时控制** | `DEFAULT_TIMEOUT_MS = 5000` ms | `linuxSecretStorage.ts` |
| **权限控制** | plaintext 文件权限 `0o600` | `plainTextStorage.ts` |

#### 凭证所有权与权限边界

| 场景 | 凭证来源 | 所有权边界 | 所属模块 |
|-----|-----|-----|-----|
| **托管会话 (CCR)** | FD → `/home/claude/.claude/remote/.oauth_token` | 不读取用户本地 `~/.claude/settings.json` | `authFileDescriptor.ts`、`auth.ts` |
| **Claude Desktop** | `CLAUDE_CODE_OAUTH_TOKEN` 或 FD | 不读取用户本地 API key | `auth.ts` |
| **独立 CLI 会话** | Keychain / libsecret / `~/.claude/.credentials.json` | 用户本地凭证，与托管隔离 | `secureStorage/*` |
| **环境变量** | `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | 最高优先级，覆盖持久化存储 | `auth.ts` |

### 4.6 跨子系统依赖

- **Settings**：`apiKeyHelper`、`awsAuthRefresh`、`gcpAuthRefresh` 等配置从 settings 读取；auth 凭据本身绝不进入 settings 域
- **OAuth Service**：`OAuthService` 负责授权流程，本文只描述 token 管理和存储；OAuth spec 主拥有授权流程
- **Third-party Services**：Bedrock/Vertex/Foundry 认证由各自模块负责，本文只描述 `isUsing3PServices()` 边界检查
- **Config**：`oauthAccount` 信息存储在 global config（非敏感），本文描述与安全存储的边界
- **Lockfile**：跨进程锁使用 lockfile 模块，本文只描述调用方式

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| Keychain 读取失败（如锁定） | `macOsKeychainStorage.read()` | 记录 warning，返回旧缓存（stale-while-error） | 否（只尝试一次） | 无，保留旧缓存 | 返回旧缓存，用户可能暂时使用过期 token |
| Keychain 写入失败 | `macOsKeychainStorage.update()` | 返回 `{ success: false }`，fallback 到 plaintext | 否（直接 fallback） | 尝试删除 primary 中的旧数据（避免 stale） | 写入 plaintext，返回警告 |
| Token refresh 网络失败 | `refreshOAuthToken()` | 抛出异常，不保存 | refresh 请求本身无重试，`checkAndRefreshOAuthTokenIfNeeded()` 有文件锁重试（5 次） | 不修改现有 tokens | 调用方收到异常，可稍后重试 |
| Token refresh 服务器拒绝（无效 refresh token） | `refreshOAuthToken()` | 抛出异常 | 否 | 不修改现有 tokens（用户需要重新登录） | 调用方收到异常，提示用户重新登录 |
| 并发刷新请求（同进程） | `checkAndRefreshOAuthTokenIfNeeded()` | 静默等待 in-flight 请求完成 | 否（复用 in-flight 结果） | 无 | 返回与 in-flight 请求相同的结果 |
| 并发刷新请求（跨进程） | `checkAndRefreshOAuthTokenIfNeeded()` lockfile | 获取锁失败时等待并重试（最多 5 次，指数退避） | 5 次 | 锁自动释放（Promise finally） | 最终获取锁后重新检查，如已被其他进程刷新则直接返回 |
| 文件描述符读取失败（如 FD 无效） | `getCredentialFromFd()` | 记录 debug 日志，fallback 到 CCR 已知文件 | 否 | 无 | 尝试从文件读取，失败则返回 null |
| apiKeyHelper 执行失败 | `_executeApiKeyHelper()` | 记录 error 到终端 + debug 日志，缓存 ' ' sentinel | 否（SWR 路径中，失败时保留旧值） | 无 | 返回旧缓存值（如有）或 sentinel |
| 安全存储中的 tokens 损坏（JSON 无效） | `secureStorage.read()` | 捕获 JSON parse 错误，返回 null | 否 | 无 | 返回 null，相当于未登录 |
| 强制组织验证失败 | `validateForceLoginOrg()` | 返回 `{ valid: false, message: string }`，不抛出 | 否 | 不修改 tokens | 调用方显示错误消息，用户需要登录正确组织 |

工程取舍：

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| stale-while-error：安全存储读取失败时返回旧缓存 | Keychain 读取失败时，如果有缓存则继续使用 | 用户可能使用过期数据，但 token 本身有过期检查 | 高可用性，瞬时错误不导致用户"被登出" |
| 30 秒 Keychain 缓存：避免频繁 spawn security 命令 | 缓存 30 秒，期间跨进程变更不立即可见 | 跨进程刷新后，另一个进程最多 30 秒才看到新 token | 性能提升显著：从每次 500ms 到缓存命中 < 1ms |
| 双重去重：同进程变量 + 跨进程文件锁 | 先检查进程内 in-flight，获取锁后再次检查 | 实现复杂，需要小心处理竞态 | 完美处理同进程和跨进程的并发刷新 |
| fallback to plaintext：安全存储失败时不阻止使用 | primary 失败时用 plainTextStorage，返回警告 | 安全风险降低，但仍有警告 | 极高可用性，安全存储不可用时仍能使用 |
| 提前 5 分钟刷新：避免请求时过期 | 过期检查加 5 分钟 buffer | 稍微增加刷新频率（提前 5 分钟而不是正好过期时） | 用户体验好，请求不会因过期而失败 |
| security -i stdin 模式：避免 credentials 出现在 ps/top 中 | 优先用 stdin 输入命令，超过 4032 字节才用 argv | 仍有大 payload 时的 argv 泄露风险（但 hex 编码不直观） | 大多数情况下 credentials 不出现在进程列表 |
| 托管会话隔离：不读取用户本地凭据 | isManagedOAuthContext() 多处检查 | 需要在多个检查点应用，容易遗漏 | 安全边界清晰，托管会话不被用户本地配置干扰 |
| token redaction：错误消息中替换 token | safeRefreshError() 替换 token 为 <redacted> | 需要在所有输出 token 的地方应用，容易遗漏 | 防止敏感 token 意外出现在日志/终端 |

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| 有效 OAuth tokens 在安全存储中 | 启动后读取 getClaudeAIOAuthTokens() | 返回 tokens，来源为 'claude.ai' | 不应该重新登录或刷新 |
| tokens 即将过期（< 5 分钟） | 调用 checkAndRefreshOAuthTokenIfNeeded() | 触发刷新，得到新 tokens | 不应该等待实际过期才刷新 |
| 两个并发请求都触发刷新 | checkAndRefreshOAuthTokenIfNeeded() 并发调用 | 只执行一次刷新，两个调用都返回相同结果 | 不应该发起两个刷新请求 |
| 进程 A 刷新 tokens，进程 B 仍在运行 | 进程 B 发起 API 请求收到 401 | handleOAuth401Error() 重新读取，发现进程 A 已刷新，不重复刷新 | 不应该再次刷新（可能导致 token 失效） |
| 用户在 CCR 环境中 | 启动读取 tokens | 优先从 FD 读取，持久化到 /home/claude/.claude/remote/ 供 subprocess 访问 | 不应该读取用户本地的 ~/.claude/settings.json |
| 用户在 Claude Desktop 环境中 | 启动读取 tokens | 使用 CLAUDE_CODE_OAUTH_TOKEN 或 FD，不读取用户本地 API key | 不应该读取用户本地的 ~/.claude.json 或 settings.json 中的 apiKeyHelper |
| Keychain 被锁定（如 SSH 会话） | 读取 tokens | fallback 到 plaintext（如有）或返回 null，记录警告 | 不应该崩溃或阻止启动 |
| 错误消息中包含 token | refresh 失败，token 在错误中 | safeRefreshError() 将 token 替换为 <redacted> | 不应该在日志/终端中显示完整 token |
| apiKeyHelper 配置在 settings 中 | 调用 getApiKeyFromApiKeyHelper() | 执行 helper 命令，缓存结果（TTL 5 分钟） | 不应该每次调用都执行 helper |
| policySettings 强制组织 UUID | 用户登录不同组织 | validateForceLoginOrg() 失败，显示错误，不保存 tokens | 不应该保存错误组织的 tokens |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 多来源认证优先级：托管 FD > 环境变量 > 安全存储 > apiKeyHelper | `src/utils/auth.ts:152-206` | 需查找相关测试 | 未找到直接测试覆盖 |
| 托管会话隔离：isManagedOAuthContext() 阻止读取用户本地凭据 | `src/utils/auth.ts:91-96` | 需查找相关测试 | 未找到直接测试覆盖 |
| OAuth 令牌刷新并发去重：同一进程内 pendingRefreshCheck + 跨进程文件锁 | `src/utils/auth.ts:1427-1562` | `tests/oauthRefresh.test.ts` | 有基本测试覆盖并发去重逻辑 |
| 安全存储分层 fallback：Keychain → libsecret → plaintext | `src/utils/secureStorage/index.ts:10-20` | `tests/linuxSecretStorage.test.ts` | 有 Linux fallback 测试覆盖 |
| 安全存储缓存：30 秒 TTL + stale-while-error | `src/utils/secureStorage/macOsKeychainHelpers.ts:69-91` | 需查找相关测试 | 未找到直接测试覆盖 |
| 令牌过期提前 5 分钟：isOAuthTokenExpired() 加 buffer | `src/utils/auth.ts:344-353` | 需查找相关测试 | 未找到直接测试覆盖 |
| 日志边界：绝不记录完整 token，错误消息中 redact | `src/commands/oauth-refresh/oauthRefresh.ts:34-41` | `tests/oauthRefresh.test.ts` | 有测试验证 redaction 行为 |
| Keychain 预取：启动时并行读取，避免阻塞主线程 | `src/utils/secureStorage/keychainPrefetch.ts:66-89` | 需查找相关测试 | 未找到直接测试覆盖 |
| OAuth 登录双路径：自动浏览器回调 + 手动代码输入 | `src/services/oauth/index.ts:32-131` | 需查找相关测试 | 未找到直接测试覆盖 |
| refresh 时 scope 扩展：Claude.ai 用户不指定 scope | `src/services/oauth/client.ts:146-273` | 需查找相关测试 | 未找到直接测试覆盖 |
| 401 错误处理：对比 token + 并发去重 | `src/utils/auth.ts:1339-1392` | 需查找相关测试 | 未找到直接测试覆盖 |

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `src/utils/auth.ts` | `isAnthropicAuthEnabled`、`getAuthTokenSource`、`getClaudeAIOAuthTokens`、`checkAndRefreshOAuthTokenIfNeeded`、`handleOAuth401Error`、`saveOAuthTokensIfNeeded`、`saveApiKey`、`clearOAuthTokenCache` | 核心认证逻辑、token 管理、缓存、并发控制 |
| `src/utils/authPortable.ts` | `maybeRemoveApiKeyFromMacOSKeychainThrows`、`normalizeApiKeyForConfig` | API key 便携操作（如 Keychain 删除） |
| `src/utils/authFileDescriptor.ts` | `getOAuthTokenFromFileDescriptor`、`getApiKeyFromFileDescriptor`、`maybePersistTokenForSubprocesses`、`readTokenFromWellKnownFile` | FD 传递 token 读取、CCR subprocess 持久化 |
| `src/utils/secureStorage/types.ts` | `SecureStorageData`、`SecureStorage`、`SecureStorageUpdateResult` | 安全存储类型定义 |
| `src/utils/secureStorage/index.ts` | `getSecureStorage` | 安全存储工厂函数，返回平台适配实现 |
| `src/utils/secureStorage/macOsKeychainStorage.ts` | `macOsKeychainStorage`、`isMacOsKeychainLocked` | macOS Keychain 存储实现 |
| `src/utils/secureStorage/macOsKeychainHelpers.ts` | `getMacOsKeychainStorageServiceName`、`getUsername`、`keychainCacheState`、`clearKeychainCache`、`primeKeychainCacheFromPrefetch` | Keychain 辅助函数、缓存管理 |
| `src/utils/secureStorage/keychainPrefetch.ts` | `startKeychainPrefetch`、`ensureKeychainPrefetchCompleted`、`getLegacyApiKeyPrefetchResult`、`clearLegacyApiKeyPrefetch` | Keychain 启动时并行预取 |
| `src/utils/secureStorage/linuxSecretStorage.ts` | `linuxSecretStorage`、`createLinuxSecretStorage` | Linux libsecret (secret-tool) 存储实现 |
| `src/utils/secureStorage/plainTextStorage.ts` | `plainTextStorage` | Plaintext fallback 存储实现（~/.claude/.credentials.json） |
| `src/utils/secureStorage/fallbackStorage.ts` | `createFallbackStorage` | Fallback 组合模式：优先 primary，失败用 secondary |
| `src/services/oauth/index.ts` | `OAuthService`、`startOAuthFlow`、`handleManualAuthCodeInput`、`cleanup` | OAuth 授权流程服务 |
| `src/services/oauth/client.ts` | `buildAuthUrl`、`exchangeCodeForTokens`、`refreshOAuthToken`、`fetchProfileInfo`、`createAndStoreApiKey`、`storeOAuthAccountInfo`、`isOAuthTokenExpired`、`getOrganizationUUID`、`populateOAuthAccountInfoIfNeeded` | OAuth 客户端逻辑、token 交换与刷新、profile 获取 |
| `src/services/oauth/getOauthProfile.ts` | `getOauthProfileFromOauthToken`、`getOauthProfileFromApiKey` | Profile 端点调用 |
| `src/services/oauth/auth-code-listener.ts` | `AuthCodeListener` | OAuth 回调本地服务器（自动路径） |
| `src/services/oauth/crypto.ts` | `generateCodeVerifier`、`generateCodeChallenge`、`generateState` | PKCE 与 state 生成 |
| `src/constants/oauth.ts` | `getOauthConfig`、`CLAUDE_AI_OAUTH_SCOPES`、`CONSOLE_OAUTH_SCOPES`、`ALL_OAUTH_SCOPES`、`OAUTH_BETA_HEADER` | OAuth 配置、endpoints、scopes |
| `src/cli/handlers/auth.ts` | `authLogin`、`authLogout`、`authStatus`、`installOAuthTokens` | `/login`/`/logout`/`/auth` 命令处理 |
| `src/commands/oauth-refresh/oauthRefresh.ts` | `runOauthRefresh`、`call`、`safeRefreshError` | `/oauth-refresh` 命令实现、token redaction |
| `tests/oauthRefresh.test.ts` | (tests) | OAuth refresh 测试：并发去重、redaction、status 等 |
| `tests/linuxSecretStorage.test.ts` | (tests) | Linux libsecret 存储测试：读写、fallback 等 |

### 7.2 未覆盖行为（基于代码阅读）

- macOS Keychain stale-while-error 行为测试
- 跨进程文件锁刷新并发测试
- 托管会话（CCR/Claude Desktop）隔离测试
- 强制组织验证（validateForceLoginOrg）完整流程测试
- security -i stdin 模式与 argv fallback 测试
- CCR FD token 读取与 subprocess 持久化测试
- apiKeyHelper SWR（stale-while-revalidate）缓存行为测试
- Keychain 预取与缓存 priming 测试
- auth.ts 中 _apiKeyHelperEpoch 竞态避免测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/auth.yaml)

### 8.1 本 spec 主拥有的文件

| 分组 | 主拥有职责 |
|---|---|
| auth-core | 核心认证逻辑、token 管理、缓存、并发控制、apiKeyHelper |
| auth-portable | API key 便携操作（如 Keychain 删除）、normalize |
| auth-file-descriptor | FD 传递 token 读取、CCR subprocess 持久化 |
| secure-storage-types | 安全存储类型定义（SecureStorageData、SecureStorage 接口） |
| secure-storage-factory | 安全存储工厂函数，平台选择与 fallback 组合 |
| secure-storage-macos | macOS Keychain 存储实现、缓存管理、预取 |
| secure-storage-linux | Linux libsecret (secret-tool) 存储实现 |
| secure-storage-plaintext | Plaintext fallback 存储实现 |
| secure-storage-fallback | Fallback 组合模式实现 |
| oauth-service | OAuth 授权流程服务（浏览器回调 + 手动输入） |
| oauth-client | OAuth 客户端逻辑（token 交换、刷新、profile 获取） |
| oauth-constants | OAuth 配置、endpoints、scopes、beta header |
| oauth-crypto | PKCE code verifier/challenge、state 生成 |
| oauth-auth-code-listener | OAuth 回调本地服务器（自动路径） |
| cli-auth-handlers | /login、/logout、/auth 命令处理 |
| cmd-oauth-refresh | /oauth-refresh 命令实现、token redaction |
| test-auth | 认证相关测试（oauthRefresh.test.ts、linuxSecretStorage.test.ts） |

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/utils/config.ts` → 主归 global config，本文只描述 oauthAccount 存储边界
- `src/utils/settings/*` → 主归 settings spec，本文只描述 apiKeyHelper 等配置读取
- `src/utils/lockfile.ts` → 主归其他 spec，本文只描述调用方式
- `src/services/mcp/*` → 主归 mcp spec，本文只描述 mcpOAuth 等存储字段（属于 SecureStorageData）
- `src/services/plugins/*` → 主归 plugins spec，本文只描述 pluginSecrets 存储字段

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | 当前仍有大 payload 时用 argv 的 fallback 路径（credentials 可能出现在 ps）；`SECURITY_STDIN_LINE_LIMIT = 4096 - 64` | 使用 macOS  Security framework 直接调用（通过 Node.js native addon 或 bun:ffi），不 spawn security 命令 | 中（需要正确处理 Keychain 访问权限、代码签名等） | 无论 payload 多大，都不通过进程列表泄露 credentials | L | 已证实 |
| P1 | Keychain 缓存 30 秒，跨进程刷新后另一个进程可能最多 30 秒才看到新 token；已有磁盘 mtime 检查机制但只在 refresh 时触发 | 每次读取 tokens 时都检查磁盘 mtime（或 Keychain 自身的修改时间），变更则立即清缓存 | 低（mtime 检查很便宜） | 进程 A 刷新后，进程 B 立即看到新 token（无 30 秒延迟） | S | 已证实 |
| P2 | token redaction 需要在所有输出 token 的地方手动应用，容易遗漏 | 使用结构化错误类型，自动 redact 敏感字段；或用模板字符串 tag 自动 redact | 中（需要修改所有错误处理路径） | 任何错误消息中都不会出现完整 token | M | 设计推断 |
| P2 | 当前没有 Windows 原生安全存储实现（只用 plaintext） | 实现 Windows Credential Locker / DPAPI 存储 | 低（只影响 Windows，现有 fallback 仍可用） | Windows 上 credentials 安全存储，无 plaintext 警告 | M | 设计推断 |
| P3 | apiKeyHelper SWR 逻辑较复杂（epoch、in-flight、cache），但测试覆盖少 | 增加单元测试覆盖各种竞态场景（如请求进行中时 epoch 变更、缓存过期时的并发请求等） | 低（只加测试） | 测试覆盖所有 SWR 分支 | M | 设计推断 |
| P3 | Keychain 预取仅在 macOS 上实现，Linux 无预取 | 为 Linux 也实现类似的启动时并行预取（secret-tool 可能也慢） | 低（只优化 Linux 启动时间） | Linux 上启动时也并行读取安全存储 | S | 设计推断 |
