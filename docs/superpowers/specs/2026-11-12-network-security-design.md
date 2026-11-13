---
id: network-security
batch: 7
title: Network Security 网络安全、证书与云凭据适配设计
date: 2026-11-12
status: draft
---

# Network Security 网络安全、证书与云凭据适配设计

## 1. 问题与约束

Claude Code 的网络安全架构面临的约束包括：

- 需要支持系统 CA 存储与捆绑 Mozilla CA 双模式
- 正确合并 NODE_EXTRA_CA_CERTS 自定义证书
- 支持双向 TLS (mTLS) 客户端证书认证
- 支持 HTTP/HTTPS 代理与 NO_PROXY 绕过（多种模式：精确主机名、域名后缀、通配符、端口指定、IP 地址）
- 管理 AWS 凭据状态与刷新
- 处理敏感信息哈希与非加密哈希
- 实现网络错误处理与 keep-alive 降级
- 提供 CCR 上游代理 (Upstream Proxy) MITM 模式
- 支持跨平台代理配置（Axios、Fetch、WebSocket、AWS SDK）
- 延迟加载 CA 证书以减少内存占用（Bun 的 `tls` 模块导入时会 eagerly 实例化约 150 个 Mozilla 根证书，占用约 750KB 堆内存）
- 配置填充与读取分离，避免代理/mTLS 间接引入约 5300 模块（config→file→permissions→commands），Agent SDK bundle 从约 10.8MB 降至约 0.4MB
- CCR 令牌堆+prctl 保护（`prctl(PR_SET_DUMPABLE, 0)` 阻止同 UID ptrace 堆刮取令牌）
- 失败开放策略（代理设置错误不应破坏正常工作的会话）
- CA 配置仅读取用户级设置（防止恶意项目在信任对话框前注入 CA 证书）
- Bun 证书存储缓存问题（Bun 在进程启动时通过 BoringSSL 缓存 TLS 证书存储，如果 NODE_EXTRA_CA_CERTS 不是在启动时设置，Bun 可能不会包含自定义 CA）

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| CA 证书延迟加载 | 按需 `require('tls')`，既无 `--use-system-ca`/`--use-openssl-ca` 也无 `NODE_EXTRA_CA_CERTS` 时返回 undefined 使用运行时默认 | 节省约 750KB 堆内存（多数用户不需要自定义 CA） | 顶层导入（内存占用大） | 需要注意初始化顺序 | `caCerts.ts` L47-49 |
| 配置填充与读取分离 | `caCertsConfig.ts` + `caCerts.ts` 分离，`caCertsConfig.ts` 在初始化早期从用户配置读取 NODE_EXTRA_CA_CERTS 并填充到 process.env | 避免 `proxy.ts`/`mtls.ts` 间接引入约 5300 模块（config→file→permissions→commands），Agent SDK bundle 从约 10.8MB 降至约 0.4MB | 单模块（bundle 太大） | 需要注意初始化顺序，在任何 TLS 连接建立前完成 | `caCertsConfig.ts` L2-14 |
| NO_PROXY 多模式支持 | 自定义 `shouldBypassProxy()` 支持精确主机名、域名后缀、通配符、端口指定、IP 地址 | 符合行业标准 NO_PROXY 语义 | 仅精确匹配（不够灵活）、第三方库（增加依赖） | 需要维护自定义匹配逻辑 | `proxy.ts` L88-129 |
| Undici 同时设置 connect 和 requestTls | 同时设置 `connect` 和 `requestTls` 选项 | 确保 TLS 选项应用于两种路径：通过 CONNECT 隧道的 TLS 连接和直连连接 | 仅设置一个（某些路径 TLS 选项不生效） | 代码略冗余 | `proxy.ts` L220-234 |
| CCR 令牌堆+prctl 保护 | 仅堆中存储令牌，文件启动后解除链接；`prctl(PR_SET_DUMPABLE, 0)` 阻止同 UID ptrace 堆 | 防止令牌通过文件系统泄露；防止堆刮取 | 保留文件（泄露风险高）、无保护（堆刮取风险） | 需要 Linux prctl 支持，其他平台可能需要不同机制 | `upstreamproxy.ts` L225-252 |
| djb2 跨运行时确定性哈希 | djb2 非加密哈希用于需要跨运行时确定性的场景（如缓存目录名） | Bun 原生 `hash()` 使用 wyhash，不可跨运行时移植；djb2 确定用于缓存目录名 | Bun wyhash（不可移植）、SHA-256（慢） | 需要维护自定义哈希实现 | `hash.ts` L7-13 |
| keep-alive 进程级粘性禁用 | 在遇到 stale pool ECONNRESET 后禁用 fetch keep-alive，进程生命周期内保持禁用 | 一旦池已知为坏，不再信任它；Bun 原生 fetch 尊重 `keepalive: false`；Node.js/undici keepalive 对池化无操作，但 undici 自然在 ECONNRESET 时驱逐死套接字 | 单次请求禁用（可能再次遇到坏池） | 可能略微增加连接开销 | `proxy.ts` L23-35 |
| CCR NO_PROXY 三格式重复 | `anthropic.com` + `.anthropic.com` + `*.anthropic.com` 三种格式都包含 | 不同运行时 NO_PROXY 解析不同：Bun/curl/Go 用 glob，Python 用后缀（去除前导点），顶级域需要回退 | 仅一种格式（某些运行时不生效） | NO_PROXY 列表略长 | `upstreamproxy.ts` L47-53 |
| 失败开放策略 | 任何错误都记录警告并禁用代理，不破坏正常工作的会话 | 代理设置错误不应破坏正常工作的会话，可用性优先 | 硬失败（用户体验差） | 可能在代理设置错误时默默降级 | `upstreamproxy.ts` L16-19 |
| CA 配置仅读取用户级设置 | 仅从 `~/.claude.json`、`~/.claude/settings.json` 读取，不读取项目级配置 | 防止恶意项目在信任对话框前注入 CA 证书，安全边界清晰 | 也包含项目级（安全风险） | 项目级 CA 配置不生效 | `caCertsConfig.ts` L33-37, L64-66 |

## 3. 目标与非目标

### 目标
- 支持系统 CA 存储与捆绑 Mozilla CA 双模式
- 正确合并 NODE_EXTRA_CA_CERTS 自定义证书
- 支持双向 TLS (mTLS) 客户端证书认证
- 支持 HTTP/HTTPS 代理与 NO_PROXY 绕过（多种模式）
- 管理 AWS 凭据状态与刷新
- 提供敏感信息哈希与非加密哈希
- 实现网络错误处理与 keep-alive 降级
- 提供 CCR 上游代理 (Upstream Proxy) MITM 模式
- 延迟加载 CA 证书以减少内存占用
- 配置填充与读取分离，减小 Agent SDK bundle 大小
- CCR 令牌堆+prctl 保护
- 失败开放策略
- CA 配置仅读取用户级设置

### 非目标
- 不处理 OAuth 认证流程（见独立的认证与安全存储设计文档）
- 不处理 API 密钥加密存储
- 不处理 Model API 认证
- 不支持需要认证的代理（http://user:pass@proxy:port）
- 不支持 NO_PROXY CIDR 表示法（如 192.168.0.0/16）
- 不支持 mTLS 证书热重载

## 4. 架构、模块与数据流

### 网络安全层架构

```
┌─────────────────────────────────────────────────────────┐
│         Application Layer (Anthropic SDK, MCP, etc.)    │
├─────────────────────────────────────────────────────────┤
│              HTTP Client Abstraction                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │    Axios     │  │    Fetch     │  │  WebSocket   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘ │
├─────────────────────────────────────────────────────────┤
│           Network Security Layer                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │  CA Certs│ │  mTLS    │ │  Proxy   │ │AWS Auth  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
├─────────────────────────────────────────────────────────┤
│              Agent Abstraction Layer                    │
│  ┌──────────────────┐  ┌───────────────────────────┐  │
│  │  HttpsAgent      │  │  undici Dispatcher        │  │
│  └──────────────────┘  └───────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 核心模块接口

```typescript
// CA 证书
getCACertificates(): string[] | undefined  // 获取 CA 证书
clearCACertsCache(): void  // 清除 CA 证书缓存

// CA 配置
populateNodeExtraCACertsFromUserConfig(): void  // 从用户配置填充 NODE_EXTRA_CA_CERTS

// mTLS
getMTLSConfig(): MTLSConfig | undefined  // 获取 mTLS 配置
getMTLSAgent(): HttpsAgent | undefined  // 获取 mTLS agent
getWebSocketTLSOptions(): tls.ConnectionOptions | undefined  // 获取 WebSocket TLS 选项
getTLSFetchOptions(): { tls?: TLSConfig, dispatcher?: undici.Dispatcher }  // 获取 Fetch TLS 选项
clearMTLSCache(): void  // 清除 mTLS 缓存

// 代理
getProxyUrl(): string | undefined  // 获取代理 URL
shouldBypassProxy(url: string): boolean  // 检查是否应该绕过代理
getProxyAgent(url: string): Agent | undefined  // 获取代理 agent
configureGlobalAgents(): void  // 配置全局 agents
getAWSClientProxyConfig(): Promise<object>  // 获取 AWS SDK 代理配置
disableKeepAlive(): void  // 禁用 keep-alive

// AWS 认证
class AwsAuthStatusManager {
  static getInstance(): AwsAuthStatusManager
  startAuthentication(): void
  addOutput(line: string): void
  setError(message: string): void
  endAuthentication(success: boolean): void
  subscribe(callback: (status: AwsAuthStatus) => void): () => void
}  // AWS 认证状态管理器
isAwsCredentialsProviderError(error: unknown): boolean  // 检测凭据 provider 错误
isValidAwsStsOutput(output: unknown): boolean  // 验证 STS assume-role 输出格式
checkStsCallerIdentity(): Promise<void>  // 验证凭据有效性
clearAwsIniCache(): void  // 强制刷新 ~/.aws/credentials 缓存

// 哈希
djb2Hash(str: string): number  // djb2 非加密哈希
hashContent(content: string): string  // 内容哈希
hashPair(a: string, b: string): string  // 对哈希

// HTTP
getUserAgent(): string  // 获取 User-Agent
getMCPUserAgent(): string  // 获取 MCP User-Agent
getWebFetchUserAgent(): string  // 获取 WebFetch User-Agent
getAuthHeaders(): AuthHeaders  // 获取认证头
withOAuth401Retry<T>(request: () => Promise<T>, opts?: { also403Revoked?: boolean }): Promise<T>  // OAuth 401 重试

// 上游代理
initializeUpstreamProxyIfNeeded(): Promise<void>  // 初始化上游代理（如果需要）
getUpstreamProxyEnv(): Record<string, string>  // 获取上游代理环境变量
```

### CCR 上游代理初始化流程

```
进程启动（在 CCR 容器中）
  ↓
从 /run/ccr/session_token 读取会话令牌
  ↓
调用 prctl(PR_SET_DUMPABLE, 0) 阻止同 UID ptrace 堆
  ↓
下载上游代理 CA 证书并与系统 bundle 合并
  ↓
启动本地 CONNECT→WebSocket 中继（127.0.0.1）
  ↓
解除令牌文件链接（令牌仅保留在堆中）
  ↓
为所有子进程导出 HTTPS_PROXY、SSL_CERT_FILE、NODE_EXTRA_CA_CERTS、REQUESTS_CA_BUNDLE、CURL_CA_BUNDLE、NO_PROXY/no_proxy
  ↓
NO_PROXY 包含：环回、RFC1918、IMDS 范围、Anthropic API、GitHub、包注册表；三种格式都包含
```

## 5. 失败语义与工程取舍

| 失败场景 | 处理方式 | 工程取舍 |
|---|---|---|
| CA 证书加载失败 | 返回 undefined，使用运行时默认 | 失败开放，不破坏正常 TLS |
| NODE_EXTRA_CA_CERTS 文件不存在 | 记录警告，继续 | 失败开放 |
| mTLS 证书/密钥文件不存在 | 返回 undefined，不使用 mTLS | 失败开放 |
| mTLS 密钥密码错误 | 抛出错误，需要用户修复 | 无法静默降级 |
| 代理 URL 解析失败 | 记录警告，禁用代理 | 失败开放 |
| 代理连接失败 | 记录警告，禁用 keep-alive/禁用代理 | 失败开放，粘性禁用 |
| AWS 凭据刷新失败 | 设置错误状态，保留输出可见 | 用户可见，可手动重试 |
| STS 调用失败 | 设置错误状态，保留输出可见 | 用户可见，可手动重试 |
| OAuth 401 响应 | 调用 `handleOAuth401Error()` 强制刷新，重试一次 | 自动恢复，减少用户手动干预 |
| CCR 上游代理初始化失败 | 记录警告，禁用代理 | 失败开放，不破坏正常工作的会话 |
| CCR 令牌文件不存在 | 记录警告，禁用代理 | 失败开放 |
| prctl 调用失败（非 Linux） | 记录警告，继续 | 仅 Linux 支持，其他平台降级 |
| NO_PROXY CIDR 表示法 | 不支持，依赖子进程自身解析 | 当前 `shouldBypassProxy()` 不支持 CIDR |
| Bun 证书存储缓存问题 | 尽早在初始化时设置 NODE_EXTRA_CA_CERTS | 时序仍可能存在竞争条件 |

## 6. 现状验收标准

- CA 证书正确延迟加载，既无 `--use-system-ca`/`--use-openssl-ca` 也无 `NODE_EXTRA_CA_CERTS` 时返回 undefined
- NODE_EXTRA_CA_CERTS 正确合并到 CA 证书
- `caCertsConfig.ts` 正确在初始化早期从用户配置填充 NODE_EXTRA_CA_CERTS，不引入不必要的依赖
- mTLS 正确加载客户端证书/密钥，正确合并 CA 证书
- NO_PROXY 正确支持精确主机名、域名后缀、通配符、端口指定、IP 地址
- Undici 同时设置 connect 和 requestTls，确保 TLS 选项应用于两种路径
- Axios、Fetch、WebSocket、AWS SDK 都正确使用代理配置
- AWS 认证状态管理器正确工作，状态转换正确，订阅机制正常
- djb2 哈希跨运行时确定性正确
- keep-alive 在遇到 stale pool ECONNRESET 后正确粘性禁用
- CCR NO_PROXY 包含三种格式（`anthropic.com` + `.anthropic.com` + `*.anthropic.com`）
- CCR 令牌正确仅堆中存储，文件启动后解除链接
- `prctl(PR_SET_DUMPABLE, 0)` 正确调用（Linux）
- 失败开放策略正确工作，任何错误都记录警告并禁用代理
- CA 配置仅读取用户级设置，不读取项目级配置

## 7. 代码与测试证据

### 现有实现
- `src/utils/caCerts.ts`: CA 证书加载
- `src/utils/caCertsConfig.ts`: CA 配置填充
- `src/utils/mtls.ts`: mTLS 支持
- `src/utils/proxy.ts`: 代理支持
- `src/utils/aws.ts`: AWS 工具
- `src/utils/awsAuthStatusManager.ts`: AWS 认证状态管理器
- `src/utils/hash.ts`: 哈希函数
- `src/utils/http.ts`: HTTP 工具
- `src/upstreamproxy/upstreamproxy.ts`: 上游代理

### 未覆盖测试
- CA 证书加载各种组合场景（系统 CA、捆绑 CA、NODE_EXTRA_CA_CERTS）
- mTLS 各种证书/密钥/密码组合场景
- NO_PROXY 各种模式匹配场景
- 代理各种客户端（Axios、Fetch、WebSocket、AWS SDK）集成场景
- AWS 认证状态管理器各种状态转换场景
- keep-alive 降级各种网络错误场景
- CCR 上游代理初始化各种失败场景
- 跨平台测试（Windows、macOS、Linux）
- Bun vs Node.js 行为差异测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/network-security.yaml)

相关子系统：
- auth: 提供 OAuth 刷新、handleOAuth401Error
- telemetry: 可能接收网络错误事件
- settings: 提供用户级配置读取
- hooks: 可能与代理配置交互
- mcp: 使用 MCP User-Agent
- anthropic-sdk: 使用认证头、OAuth 401 重试
- aws-sdk: 使用代理配置、AWS 凭据

## 9. 改进建议

1. 增加 NO_PROXY CIDR 表示法支持（如 192.168.0.0/16）
2. 实现 mTLS 证书热重载机制
3. 支持需要认证的代理（http://user:pass@proxy:port）
4. 解决 Bun 证书存储缓存问题（可能需要 Bun 上游修复）
5. 增加更详细的网络安全事件日志和可观测性
6. 实现代理自动发现（WPAD、PAC）
7. 增加 mTLS 证书验证（检查证书有效期、域名匹配等）
8. 实现更细粒度的代理绕过控制（按 URL 路径、按请求类型等）
9. 增加网络安全配置 UI，方便用户管理 CA 证书、mTLS、代理
10. 实现网络安全配置验证工具，帮助用户诊断配置问题
