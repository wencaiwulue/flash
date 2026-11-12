---
id: network-security
batch: 7
title: Network Security 网络安全、证书与云凭据适配设计
date: 2026-11-12
status: draft
---

# Network Security 网络安全、证书与云凭据适配设计

## 1. 概述

本设计文档描述 Claude Code 的网络安全架构，涵盖 TLS 证书配置、双向 TLS (mTLS) 认证、HTTP/HTTPS 代理支持、AWS 凭据管理、敏感信息哈希处理以及网络错误降级策略。

### 范围

- CA 证书加载与合并策略
- mTLS 客户端证书认证
- HTTP/HTTPS 代理与 NO_PROXY 绕过
- AWS 凭据状态管理
- 敏感信息哈希与非加密哈希
- 网络错误处理与 keep-alive 降级
- CCR 上游代理 (Upstream Proxy) MITM 模式

### 非范围

- OAuth 认证流程（见独立的认证与安全存储设计文档）
- API 密钥加密存储
- Model API 认证

## 2. 系统架构

网络安全层位于 HTTP 客户端底层，为所有出站请求提供统一的证书、代理和认证支持。

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

### 核心模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| CA 证书 | `src/utils/caCerts.ts` | 加载系统/捆绑 CA，合并 NODE_EXTRA_CA_CERTS |
| CA 配置 | `src/utils/caCertsConfig.ts` | 从配置填充 NODE_EXTRA_CA_CERTS |
| mTLS | `src/utils/mtls.ts` | 客户端证书加载、HTTPS agent 创建 |
| 代理 | `src/utils/proxy.ts` | 代理 URL 解析、NO_PROXY 匹配、agent 创建 |
| AWS | `src/utils/aws.ts` | AWS STS 输出验证、凭据缓存刷新 |
| AWS 状态 | `src/utils/awsAuthStatusManager.ts` | 云提供商认证状态单例管理 |
| 哈希 | `src/utils/hash.ts` | 内容哈希、djb2 非加密哈希 |
| HTTP | `src/utils/http.ts` | User-Agent、认证头、OAuth 401 重试 |
| 上游代理 | `src/upstreamproxy/upstreamproxy.ts` | CCR 容器内 MITM 代理中继 |

## 3. CA 证书管理

### 设计目标

- 支持系统 CA 存储与捆绑 Mozilla CA 双模式
- 正确合并 NODE_EXTRA_CA_CERTS 自定义证书
- 延迟加载以减少内存占用
- 缓存失效机制

### CA 加载策略

```typescript
// caCerts.ts
getCACertificates(): string[] | undefined
```

**决策树：**

1. 既无 `--use-system-ca`/`--use-openssl-ca` 也无 `NODE_EXTRA_CA_CERTS`：
   - 返回 `undefined`，使用运行时默认 CA 存储
2. 仅 `NODE_EXTRA_CA_CERTS`：
   - 加载捆绑 Mozilla CA + 额外证书文件
3. 仅 `--use-system-ca`：
   - 尝试 Bun `getCACertificates('system')` API
   - 失败则回退到捆绑 CA
4. 两者都有：
   - 系统 CA + 额外证书

**延迟加载理由：**
Bun 的 `tls` 模块导入时会 eagerly 实例化 ~150 个 Mozilla 根证书，占用 ~750KB 堆内存。多数用户不需要自定义 CA，因此仅在需要时动态 `require('tls')`。

### 配置填充

`caCertsConfig.ts` 在初始化早期从用户配置（`~/.claude.json`、`~/.claude/settings.json`）读取 `NODE_EXTRA_CA_CERTS` 并填充到 `process.env`，在任何 TLS 连接建立之前完成。

**安全边界：**
仅读取用户级配置，不读取项目级配置，防止恶意项目在信任对话框前注入 CA 证书。

### 缓存失效

```typescript
clearCACertsCache(): void
```

在环境变量可能变化时调用（例如信任对话框应用 `settings.json` 后）。

## 4. 双向 TLS (mTLS)

### 配置来源

mTLS 通过环境变量配置：

| 环境变量 | 用途 |
|----------|------|
| `CLAUDE_CODE_CLIENT_CERT` | 客户端证书文件路径 (PEM) |
| `CLAUDE_CODE_CLIENT_KEY` | 客户端私钥文件路径 (PEM) |
| `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` | 私钥密码（可选） |
| `NODE_EXTRA_CA_CERTS` | 额外 CA 证书（自动处理） |

### Agent 集成

mTLS 配置与 CA 证书合并，创建统一的 HTTPS agent：

```typescript
getMTLSAgent(): HttpsAgent | undefined
getWebSocketTLSOptions(): tls.ConnectionOptions | undefined
getTLSFetchOptions(): { tls?: TLSConfig, dispatcher?: undici.Dispatcher }
```

**运行时适配：**
- Bun 原生支持 `tls` 选项
- Node.js 需要创建 `undici.Agent` 并配置 `connect` 选项

### 缓存策略

- `getMTLSConfig()`: memoized
- `getMTLSAgent()`: memoized
- `clearMTLSCache()`: 清除缓存

## 5. HTTP/HTTPS 代理

### 代理 URL 解析

优先顺序：`https_proxy` > `HTTPS_PROXY` > `http_proxy` > `HTTP_PROXY`

### NO_PROXY 匹配

支持多种模式：

- 精确主机名匹配：`localhost`
- 域名后缀匹配：`.example.com` 匹配 `example.com` 和 `sub.example.com`
- 通配符：`*` 绕过所有代理
- 端口指定：`example.com:8080`
- IP 地址：`127.0.0.1`

### Agent 创建

**Axios:**
- 通过请求拦截器动态选择代理或直连
- 支持 `CLAUDE_CODE_PROXY_RESOLVES_HOSTS` 跳过本地 DNS

**Undici/Fetch:**
- `EnvHttpProxyAgent` 自动处理 NO_PROXY
- 同时设置 `connect` 和 `requestTls` 选项以覆盖隧道和直连两种路径

**WebSocket:**
- Node.js: 使用 `HttpsProxyAgent`
- Bun: 原生 `proxy` 字符串选项

### 全局配置

```typescript
configureGlobalAgents(): void
```

配置 axios 默认 agent 和 undici 全局 dispatcher。支持重复调用（先 eject 先前拦截器）。

### AWS SDK 代理

```typescript
getAWSClientProxyConfig(): Promise<object>
```

创建 `NodeHttpHandler` 并注入代理 agent，同时配置凭据 provider 使用相同 handler。

## 6. AWS 凭据状态管理

### 状态单例

`AwsAuthStatusManager` 是跨云提供商（AWS Bedrock、GCP Vertex）的认证状态单例：

```typescript
{
  isAuthenticating: boolean
  output: string[]
  error?: string
}
```

### 状态转换流程

1. `startAuthentication()`: 设置 `isAuthenticating = true`，清空输出
2. `addOutput(line)`: 追加输出行
3. `setError(message)`: 设置错误信息
4. `endAuthentication(success)`:
   - 成功：完全清除状态
   - 失败：保留输出可见

### 订阅机制

使用信号模式通知 React 组件和 SDK 输出更新：

```typescript
subscribe(callback: (status: AwsAuthStatus) => void): () => void
```

### AWS STS 工具

- `isAwsCredentialsProviderError()`: 检测凭据 provider 错误
- `isValidAwsStsOutput()`: 验证 STS assume-role 输出格式
- `checkStsCallerIdentity()`: 验证凭据有效性
- `clearAwsIniCache()`: 强制刷新 `~/.aws/credentials` 缓存

## 7. 哈希与敏感信息

### 非加密哈希

**djb2 哈希：**
```typescript
djb2Hash(str: string): number  // 签名 32 位整数
```

用于需要跨运行时确定性的场景（如缓存目录名），替代 Bun 原生 `hash()`（使用 wyhash，不可移植）。

### 内容哈希

```typescript
hashContent(content: string): string
hashPair(a: string, b: string): string
```

- Bun: 使用 `Bun.hash()`（~100x 快于 SHA-256，抗碰撞性足以用于变更检测）
- Node.js: 回退到 `crypto.createHash('sha256')`

**对哈希：**
- Bun: 使用种子链式 wyhash（`hash(b, hash(a))`）
- Node.js: 增量 SHA-256 更新 + 空字节分隔以避免歧义

### 加密原语

`crypto.ts` 是 Node.js/Bun 与浏览器构建的切换点：
- 服务端：导出 `randomUUID` 从 `crypto`
- 浏览器：通过 `package.json` `browser` 字段替换为 `crypto.browser.ts`，避免 `crypto-browserify`  polyfill (~500KB)

## 8. 网络错误与降级

### Keep-Alive 降级

```typescript
disableKeepAlive(): void
```

在遇到 stale pool ECONNRESET 后禁用 fetch keep-alive，使重试打开新 TCP 连接而不是复用死池套接字。

**粘性行为：**
- 进程生命周期内保持禁用
- Bun: 原生 fetch 尊重 `keepalive: false`
- Node.js/undici: keepalive 对池化无操作，但 undici 自然在 ECONNRESET 时驱逐死套接字

### HTTP 工具

**User-Agent：**
```typescript
getUserAgent(): string        // 用于 API 请求
getMCPUserAgent(): string     // 用于 MCP 请求
getWebFetchUserAgent(): string // 用于 WebFetch 任意站点请求
```

**OAuth 401 重试：**
```typescript
withOAuth401Retry<T>(request: () => Promise<T>, opts?: { also403Revoked?: boolean }): Promise<T>
```

- 捕获 401（或可选的 403 + "OAuth token has been revoked"）
- 调用 `handleOAuth401Error()` 强制刷新
- 重试一次

**认证头：**
```typescript
getAuthHeaders(): AuthHeaders  // { headers: Record<string, string>, error?: string }
```

根据用户类型返回 OAuth Bearer 或 x-api-key 头。

## 9. CCR 上游代理 (Upstream Proxy)

### 容器内架构

在 CCR 会话容器中运行时，提供 MITM 代理支持：

```
┌─────────────────────────────────────────────────────┐
│               CCR Container                         │
│  ┌───────────────────────────────────────────────┐ │
│  │  Claude Code         ┌─────────────────────┐ │ │
│  │  Subprocesses        │ Local CONNECT→WS   │ │ │
│  │  (Bash, MCP, etc.)   │ Relay (127.0.0.1) │ │ │
│  │  HTTPS_PROXY────────▶│                    │─┼─┼──▶ WS Upstream
│  │  SSL_CERT_FILE───────┴─────────────────────┘ │ │
│  └───────────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────────┐ │
│  │  Security: prctl(PR_SET_DUMPABLE, 0)          │ │
│  │  Token: heap-only (file unlinked after relay  │ │
│  │         confirmed up)                         │ │
│  └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 初始化流程

1. 从 `/run/ccr/session_token` 读取会话令牌
2. 调用 `prctl(PR_SET_DUMPABLE, 0)` 阻止同 UID ptrace 堆
3. 下载上游代理 CA 证书并与系统 bundle 合并
4. 启动本地 CONNECT→WebSocket 中继
5. 解除令牌文件链接（令牌仅保留在堆中）
6. 为所有子进程导出 `HTTPS_PROXY`、`SSL_CERT_FILE` 等

### NO_PROXY 绕过列表

必须不拦截的主机：
- 环回、RFC1918、IMDS 范围
- Anthropic API（MITM 破坏非 Bun 运行时）
- GitHub、包注册表（CCR 容器已直连）

**多格式原因：**
不同运行时 NO_PROXY 解析不同：
- `*.anthropic.com`：Bun、curl、Go（glob 匹配）
- `.anthropic.com`：Python urllib/httpx（后缀匹配，去除前导点）
- `anthropic.com`：顶级域回退

### 失败开放策略

任何错误都记录警告并禁用代理，不破坏正常工作的会话。

### 子进程环境继承

```typescript
getUpstreamProxyEnv(): Record<string, string>
```

返回需要合并到每个 agent 子进程的环境变量：
- `HTTPS_PROXY` / `https_proxy`
- `NO_PROXY` / `no_proxy`
- `SSL_CERT_FILE`
- `NODE_EXTRA_CA_CERTS`
- `REQUESTS_CA_BUNDLE`
- `CURL_CA_BUNDLE`

**子进程中继继承：**
子 CLI 进程无法重新初始化中继（令牌文件已解除链接），但父中继仍在运行。如果父进程设置了代理变量，则继承传递。

## 10. 设计决策

### 决策 1：CA 证书延迟加载

| 方面 | 选择 | 备选 | 代价/理由 |
|------|------|------|-----------|
| 加载时机 | 按需 `require('tls')` | 顶层导入 | 节省 ~750KB 堆内存（多数用户不需要自定义 CA） |
| 证据 | `caCerts.ts` L47-49 | - | 注释明确说明理由 |

### 决策 2：配置填充与读取分离

| 方面 | 选择 | 备选 | 代价/理由 |
|------|------|------|-----------|
| 架构 | `caCertsConfig.ts` + `caCerts.ts` 分离 | 单模块 | 避免 `proxy.ts`/`mtls.ts` 间接引入 ~5300 模块（config→file→permissions→commands），Agent SDK bundle 从 ~10.8MB 降至 ~0.4MB |
| 证据 | `caCertsConfig.ts` L2-14 | - | 模块头部注释详细说明 |

### 决策 3：NO_PROXY 多模式支持

| 方面 | 选择 | 备选 | 代价/理由 |
|------|------|------|-----------|
| 匹配模式 | 精确/后缀/通配符/端口/IP | 仅精确匹配 | 符合行业标准 `NO_PROXY` 语义 |
| 实现 | 自定义 `shouldBypassProxy()` | 第三方库 | 避免额外依赖，完全控制匹配逻辑 |
| 证据 | `proxy.ts` L88-129 | - | 实现覆盖所有模式 |

### 决策 4：Undici 同时设置 connect 和 requestTls

| 方面 | 选择 | 备选 | 代价/理由 |
|------|------|------|-----------|
| TLS 选项 | 同时设置 `connect` 和 `requestTls` | 仅设置一个 | 确保 TLS 选项应用于两种路径：通过 CONNECT 隧道的 TLS 连接和直连连接 |
| 证据 | `proxy.ts` L220-234 | - | 注释明确说明 |

### 决策 5：CCR 令牌堆+prctl 保护

| 方面 | 选择 | 备选 | 代价/理由 |
|------|------|------|-----------|
| 令牌存储 | 仅堆中，文件启动后解除链接 | 保留文件 | 防止令牌通过文件系统泄露 |
| 内存保护 | `prctl(PR_SET_DUMPABLE, 0)` | 无保护 | 阻止同 UID ptrace 堆刮取令牌 |
| 证据 | `upstreamproxy.ts` L225-252 | - | prctl 实现和注释 |

### 决策 6：djb2 跨运行时确定性哈希

| 方面 | 选择 | 备选 | 代价/理由 |
|------|------|------|-----------|
| 哈希算法 | djb2 | Bun wyhash | wyhash 不可跨运行时移植，djb2 确定用于缓存目录名 |
| 证据 | `hash.ts` L7-13 | - | 函数注释 |

### 决策 7：keep-alive 进程级粘性禁用

| 方面 | 选择 | 备选 | 代价/理由 |
|------|------|------|-----------|
| 降级范围 | 进程生命周期 | 单次请求 | 一旦池已知为坏，不再信任它 |
| 证据 | `proxy.ts` L23-35 | - | 变量注释 |

### 决策 8：CCR NO_PROXY 三格式重复

| 方面 | 选择 | 备选 | 代价/理由 |
|------|------|------|-----------|
| 列表格式 | `anthropic.com` + `.anthropic.com` + `*.anthropic.com` | 仅一种 | 不同运行时解析不同：Bun/curl/Go 用 glob，Python 用后缀 |
| 证据 | `upstreamproxy.ts` L47-53 | - | 详细注释 |

### 决策 9：失败开放策略

| 方面 | 选择 | 备选 | 代价/理由 |
|------|------|------|-----------|
| 错误处理 | 记录警告，禁用代理 | 硬失败 | 代理设置错误不应破坏正常工作的会话 |
| 证据 | `upstreamproxy.ts` L16-19 | - | 模块头部注释 |

### 决策 10：CA 配置仅读取用户级设置

| 方面 | 选择 | 备选 | 代价/理由 |
|------|------|------|-----------|
| 配置来源 | 仅 `~/.claude.json`、`~/.claude/settings.json` | 也包含项目级 | 防止恶意项目在信任对话框前注入 CA 证书 |
| 证据 | `caCertsConfig.ts` L33-37, L64-66 | - | 注释明确说明安全边界 |

## 11. 覆盖范围

见 [Coverage](../../architecture/coverage/network-security.yaml)。

## 12. 边界疑虑与开放问题

### 疑虑 1：Bun 证书存储缓存

Bun 在进程启动时通过 BoringSSL 缓存 TLS 证书存储。如果 `NODE_EXTRA_CA_CERTS` 不是在启动时设置，Bun 可能不会包含自定义 CA。当前策略是尽早在初始化时设置，但时序仍可能存在竞争条件。

### 疑虑 2：NO_PROXY CIDR 支持

当前 `shouldBypassProxy()` 不支持 CIDR 表示法（如 `192.168.0.0/16`），仅支持精确 IP。CCR 的 NO_PROXY_LIST 包含 CIDR，但这依赖子进程自身解析。

### 疑虑 3：mTLS 证书热重载

没有动态重新加载 mTLS 证书的机制，需要重启进程才能拾取新证书。

### 疑虑 4：代理认证

当前实现不支持需要认证的代理（`http://user:pass@proxy:port`）。HttpsProxyAgent 理论上支持，但未测试。

### 疑虑 5：undici 内存占用

代理配置时才 lazy-require undici (~1.5MB)，但一旦加载后无法卸载。长期运行的 REPL 会话在动态配置代理时会永久增加内存占用。
