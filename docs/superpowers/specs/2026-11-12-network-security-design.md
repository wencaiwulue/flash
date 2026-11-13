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
applyExtraCACertsFromConfig(): void  // 从用户配置填充 NODE_EXTRA_CA_CERTS

// mTLS
getMTLSConfig(): MTLSConfig | undefined  // 获取 mTLS 配置
getMTLSAgent(): HttpsAgent | undefined  // 获取 mTLS agent
getWebSocketTLSOptions(): tls.ConnectionOptions | undefined  // 获取 WebSocket TLS 选项
getTLSFetchOptions(): { tls?: TLSConfig, dispatcher?: undici.Dispatcher }  // 获取 Fetch TLS 选项
clearMTLSCache(): void  // 清除 mTLS 缓存

// 代理
getProxyUrl(): string | undefined  // 获取代理 URL
shouldBypassProxy(url: string): boolean  // 检查是否应该绕过代理
getProxyAgent(url: string): undici.Dispatcher  // 获取代理 agent
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

// 哈希
djb2Hash(str: string): number  // djb2 非加密哈希
hashContent(content: string): string  // 内容哈希
hashPair(a: string, b: string): string  // 对哈希

// 上游代理
initUpstreamProxy(opts?: {...}): Promise<UpstreamProxyState>  // 初始化上游代理
getUpstreamProxyEnv(): Record<string, string>  // 获取上游代理环境变量
```

### HTTP API 函数清单

网络安全层还提供以下 HTTP API 工具函数：

```typescript
// User-Agent 生成
getUserAgent(): string  // 用于 Anthropic API 请求，包含 claude-cli 版本、用户类型、entrypoint、agent-sdk 版本等
getMCPUserAgent(): string  // 用于 MCP 请求
getWebFetchUserAgent(): string  // 用于 WebFetch 任意网站请求

// 认证头
type AuthHeaders  = {
  headers: Record<string, string>
  error?: string
}
getAuthHeaders(): AuthHeaders  // 根据用户类型返回 OAuth Bearer 或 x-api-key

// OAuth 401 重试
withOAuth401Retry<T>(request: () => Promise<T>, opts?: { also403Revoked?: boolean }): Promise<T>
  // 捕获 401（或可选的 403 + revoked 消息）
  // 调用 handleOAuth401Error 强制刷新 token
  // 重试一次请求
```

**证据**：
- `src/utils/http.ts` User-Agent 生成函数
- `src/utils/aws.ts` AWS STS 辅助函数
- `src/utils/http.ts:115-136` withOAuth401Retry OAuth 401 重试实现
- `src/utils/http.ts:69-99` getAuthHeaders 实现

---

## 模块设计卡

### 4.1 CA 证书模块 (caCerts.ts)

#### 真实入口签名与关键类型
```typescript
export const getCACertificates: () => string[] | undefined
export function clearCACertsCache(): void
```

**关键环境变量**：
- `NODE_EXTRA_CA_CERTS`: 自定义 CA 证书文件路径
- `--use-system-ca` / `--use-openssl-ca`: Node 启动参数，使用系统 CA 存储

#### 输入输出
| 输入 | 输出 |
|------|------|
| 无（仅读取环境变量） | `undefined`（无自定义 CA 时）或 `string[]`（CA 证书数组） |
| `clearCACertsCache()` 调用 | 清除 memoize 缓存，下次调用重新加载 |

#### 证书与代理状态
- **延迟加载策略**：既无 `--use-system-ca` 也无 `NODE_EXTRA_CA_CERTS` 时直接返回 `undefined`，不加载 `tls` 模块
- **内存优化**：Bun 的 `tls` 模块导入时会 eagerly 实例化约 150 个 Mozilla 根证书，占用约 750KB 堆内存
- **四种组合模式**：
  1. 无配置 → `undefined`（使用运行时默认）
  2. 仅 `NODE_EXTRA_CA_CERTS` → 捆绑 Mozilla CA + 自定义 CA
  3. 仅 `--use-system-ca` → 系统 CA（Bun 特有）或回退到捆绑 CA
  4. 两者都有 → 系统 CA + 自定义 CA

#### 加载/构造/禁用/降级流程
```
调用 getCACertificates()
  ↓
检查 --use-system-ca / --use-openssl-ca
  ↓
检查 NODE_EXTRA_CA_CERTS
  ↓
两者都无？ → 返回 undefined（不加载 tls 模块）
  ↓
按需 require('tls')
  ↓
加载基础 CA（系统或捆绑）
  ↓
NODE_EXTRA_CA_CERTS 存在？
  → 尝试读取文件，追加到 certs 数组
  → 读取失败？记录警告，继续
  ↓
返回 certs（非空）或 undefined
```

**降级策略**：
- `tls.getCACertificates('system')` 不可用（Node.js）且无 `NODE_EXTRA_CA_CERTS` → 返回 `undefined`，让 Node.js 原生处理
- 系统 CA API 返回空 → 回退到捆绑 Mozilla CA
- `NODE_EXTRA_CA_CERTS` 文件读取失败 → 记录警告，返回基础 CA

#### 错误与安全
| 错误场景 | 处理方式 | 安全考虑 |
|----------|----------|----------|
| `NODE_EXTRA_CA_CERTS` 文件不存在 | 记录警告，继续 | 不破坏现有 TLS |
| 文件读取权限不足 | 记录警告，继续 | 不暴露权限问题 |
| 证书格式无效 | TLS 握手时自然失败 | 不提前验证，留给运行时 |

#### 设计取舍/备选
| 决策 | 取舍 | 备选方案 |
|------|------|----------|
| 延迟加载 `tls` 模块 | 节省 750KB（常见场景），但首次调用有轻微延迟 | 顶层导入（简单但内存占用大） |
| memoize 缓存结果 | 性能优化，但环境变量变化后需手动清除缓存 | 每次重新读取（简单但性能差） |
| 返回 `string[]` 而不是 `Buffer[]` | 与 Node.js `https.Agent` 兼容性好 | Buffer 数组（可能更高效） |

#### 源码测试证据
- `src/utils/caCerts.ts` L28-105: `getCACertificates` 实现
- `src/utils/caCerts.ts` L112-115: `clearCACertsCache` 实现
- 证据：L39 检查两者都无 → 返回 `undefined`；L48 延迟 `require('tls')`；L55-77 系统 CA 加载与回退；L87-102 `NODE_EXTRA_CA_CERTS` 追加

---

### 4.2 CA 配置模块 (caCertsConfig.ts)

#### 真实入口签名与关键类型
```typescript
export function applyExtraCACertsFromConfig(): void
```

**关键配置源**：
- `~/.claude.json` `env.NODE_EXTRA_CA_CERTS`
- `~/.claude/settings.json` `env.NODE_EXTRA_CA_CERTS`
- Settings 优先级 > 全局配置

#### 输入输出
| 输入 | 输出 |
|------|------|
| 无（读取配置文件） | 无副作用，或设置 `process.env.NODE_EXTRA_CA_CERTS` |
| `process.env.NODE_EXTRA_CA_CERTS` 已存在 | 直接返回，不覆盖 |

#### NODE_EXTRA_CA_CERTS 合并策略
- **配置填充与读取分离**：本模块是唯一允许导入 `config` 的模块；`caCerts.ts` 仅读取 `process.env`
- **依赖隔离**：避免 `proxy.ts` / `mtls.ts` 间接引入约 5300 模块（config → file → permissions → commands）
- **Agent SDK bundle 优化**：从约 10.8MB 降到约 0.4MB
- **初始化时机**：在 CLI 初始化早期调用，在任何 TLS 连接建立前
- **Bun 缓存问题**：Bun 在进程启动时通过 BoringSSL 缓存 TLS 证书存储，尽早设置 env var 增加被拾取的机会

#### 加载/构造/禁用/降级流程
```
调用 applyExtraCACertsFromConfig()
  ↓
process.env.NODE_EXTRA_CA_CERTS 已存在？
  → 是：直接返回（不覆盖）
  ↓
调用 getExtraCertsPathFromConfig()
  ↓
读取 ~/.claude/settings.json（优先）
  ↓
读取 ~/.claude.json（备选）
  ↓
找到路径？
  → 是：设置 process.env.NODE_EXTRA_CA_CERTS
  → 否：无操作
  ↓
任何错误？ → 记录警告，返回 undefined
```

**安全边界**：
- **仅读取用户级配置**：不读取项目级 `.claude/settings.json`，防止恶意项目在信任对话框前注入 CA 证书
- **信任对话框前安全**：用户级文件在信任对话框前即可安全读取

#### 错误与安全
| 错误场景 | 处理方式 | 安全考虑 |
|----------|----------|----------|
| 配置文件不存在 | 记录警告，返回 `undefined` | 不破坏启动 |
| 配置文件 JSON 无效 | 记录警告，返回 `undefined` | 不暴露配置错误 |
| 项目级配置存在 | 故意忽略 | 防止恶意项目注入 CA |

#### 设计取舍/备选
| 决策 | 取舍 | 备选方案 |
|------|------|----------|
| 与 `caCerts.ts` 分离 | 实现依赖隔离，但需要注意初始化顺序 | 单一模块（简单但 bundle 太大） |
| 不覆盖现有 env var | 尊重用户显式设置，但配置文件值被忽略 | 总是覆盖（配置优先） |
| Settings 优先于全局配置 | 符合用户预期，但需要两处检查 | 仅检查一处（简单但不灵活） |

#### 源码测试证据
- `src/utils/caCertsConfig.ts` L34-45: `applyExtraCACertsFromConfig` 实现
- `src/utils/caCertsConfig.ts` L59-87: `getExtraCertsPathFromConfig` 实现
- 证据：L35-37 检查现有 env var；L66 仅读取用户级 settings；L74-75 Settings 优先

---

### 4.3 mTLS 模块 (mtls.ts)

#### 真实入口签名与关键类型
```typescript
export type MTLSConfig = {
  cert?: string
  key?: string
  passphrase?: string
}
export type TLSConfig = MTLSConfig & {
  ca?: string | string[] | Buffer
}

export const getMTLSConfig: () => MTLSConfig | undefined
export const getMTLSAgent: () => HttpsAgent | undefined
export function getWebSocketTLSOptions(): tls.ConnectionOptions | undefined
export function getTLSFetchOptions(): { tls?: TLSConfig, dispatcher?: undici.Dispatcher }
export function clearMTLSCache(): void
export function configureGlobalMTLS(): void
```

**关键环境变量**：
- `CLAUDE_CODE_CLIENT_CERT`: 客户端证书路径（PEM）
- `CLAUDE_CODE_CLIENT_KEY`: 客户端私钥路径（PEM）
- `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`: 私钥密码（明文）

#### 输入输出
| 函数 | 输入 | 输出 |
|------|------|------|
| `getMTLSConfig()` | 无（读取环境变量） | `MTLSConfig` 或 `undefined` |
| `getMTLSAgent()` | 无 | `HttpsAgent`（含 mTLS + CA）或 `undefined` |
| `getWebSocketTLSOptions()` | 无 | `tls.ConnectionOptions` 或 `undefined` |
| `getTLSFetchOptions()` | 无 | `{tls?, dispatcher?}`（Bun vs Node 分支） |

#### 证书与代理状态
- **NODE_EXTRA_CA_CERTS 自动处理**：Node.js 运行时自动追加到内置 CA，无需手动加载
- **与 CA 证书模块组合**：`getMTLSAgent` / `getTLSFetchOptions` 同时调用 `getCACertificates()`
- **Bun vs Node.js 分支**：
  - Bun：使用 `{tls: TLSConfig}` 直接传递给 `fetch()`
  - Node.js：使用 `undici.Agent` 延迟加载 undici（~1.5MB）

#### 加载/构造/禁用/降级流程
```
调用 getMTLSConfig()
  ↓
检查 CLAUDE_CODE_CLIENT_CERT
  → 存在：尝试读取文件
  → 失败：记录警告，跳过
  ↓
检查 CLAUDE_CODE_CLIENT_KEY
  → 存在：尝试读取文件
  → 失败：记录警告，跳过
  ↓
检查 CLAUDE_CODE_CLIENT_KEY_PASSPHRASE
  ↓
至少一个配置项？ → 返回 MTLSConfig
  → 否：返回 undefined
```

```
调用 getTLSFetchOptions()
  ↓
获取 mtlsConfig + caCerts
  ↓
都无？ → 返回 {}
  ↓
Bun 环境？
  → 是：返回 {tls: TLSConfig}
  → 否：require('undici')，创建 undici.Agent
              设置 connect（直连）+ requestTls（隧道）
              pipelining: 1
```

**降级策略**：
- 证书/密钥文件读取失败 → 记录警告，跳过该配置项
- 无任何 mTLS 配置但有 CA 配置 → 仍返回 agent（仅 CA）

#### 错误与安全
| 错误场景 | 处理方式 | 安全考虑 |
|----------|----------|----------|
| 证书文件不存在 | 记录警告，跳过 | 不破坏启动 |
| 私钥文件不存在 | 记录警告，跳过 | 不破坏启动 |
| 私钥密码错误 | TLS 握手时自然失败 | 不提前验证 |
| 密码在环境变量中明文传递 | 接受现状 | 无法安全传递密码给底层 TLS |

#### 设计取舍/备选
| 决策 | 取舍 | 备选方案 |
|------|------|----------|
| memoize `getMTLSConfig` / `getMTLSAgent` | 性能优化，但需手动清除缓存 | 每次重新创建（简单但性能差） |
| `undici.Agent` 延迟加载 | 节省 1.5MB（常见场景） | 顶层导入（简单但内存占用大） |
| 同时设置 `connect` + `requestTls` | 确保两种路径都生效（见 proxy.ts） | 仅设置一个（部分场景不生效） |

#### 源码测试证据
- `src/utils/mtls.ts` L23-73: `getMTLSConfig` 实现
- `src/utils/mtls.ts` L78-95: `getMTLSAgent` 实现
- `src/utils/mtls.ts` L117-152: `getTLSFetchOptions` 实现
- 证据：L26-28 注释 NODE_EXTRA_CA_CERTS 自动处理；L133-135 Bun 分支；L139-151 undici 延迟加载

---

### 4.4 代理模块 (proxy.ts)

#### 真实入口签名与关键类型
```typescript
export function getProxyUrl(env?: EnvLike): string | undefined
export function getNoProxy(env?: EnvLike): string | undefined
export function shouldBypassProxy(urlString: string, noProxy?: string): boolean
export const getProxyAgent: (uri: string) => undici.Dispatcher
export function configureGlobalAgents(): void
export async function getAWSClientProxyConfig(): Promise<object>
export function disableKeepAlive(): void
export function createAxiosInstance(extra?: HttpsProxyAgentOptions): AxiosInstance
export function getWebSocketProxyAgent(url: string): Agent | undefined
export function getWebSocketProxyUrl(url: string): string | undefined
export function getProxyFetchOptions(opts?: { forAnthropicAPI?: boolean }): {...}
```

**关键环境变量**：
- `https_proxy` / `HTTPS_PROXY` / `http_proxy` / `HTTP_PROXY`：代理 URL（小写优先）
- `no_proxy` / `NO_PROXY`：绕过列表（小写优先）
- `CLAUDE_CODE_PROXY_RESOLVES_HOSTS`：让代理解析 DNS
- `ANTHROPIC_UNIX_SOCKET`：`claude ssh` 隧道（仅 Anthropic API）

#### 输入输出
| 函数 | 输入 | 输出 |
|------|------|------|
| `shouldBypassProxy()` | URL 字符串，可选 noProxy 值 | boolean |
| `getProxyAgent()` | proxy URI | `undici.EnvHttpProxyAgent` |
| `getProxyFetchOptions()` | `forAnthropicAPI?` flag | fetch options |

#### NO_PROXY 三格式与 CIDR 边界
**shouldBypassProxy 支持的模式**（L88-129）：
| 模式 | 示例 | 匹配 |
|------|------|------|
| 精确主机名 | `localhost` | `localhost` 仅 |
| 域名后缀（前导点） | `.example.com` | `example.com` + `sub.example.com`，不匹配 `notexample.com` |
| 通配符 | `*` | 所有请求 |
| 端口指定 | `example.com:8080` | 仅 8080 端口 |
| IP 地址 | `127.0.0.1` | 精确 IP 匹配 |

**不支持 CIDR**（非目标，见 L188）：`192.168.0.0/16` 等 CIDR 表示法不被 `shouldBypassProxy` 解析；仅子进程自己的 NO_PROXY 解析可能支持

**分隔符**：逗号或空格（`split(/[,\s]+/)`）

**CCR 三格式重复**（upstreamproxy.ts L47-53）：
- `*.anthropic.com`：Bun、curl、Go（glob 匹配）
- `.anthropic.com`：Python urllib/httpx（后缀匹配，去除前导点）
- `anthropic.com`：顶级域名回退

#### undici connect/requestTls 同时设置
```typescript
// L220-234：同时设置确保两种路径都生效
proxyOptions.connect = tlsOpts      // 直连（绕过代理）时的 TLS
proxyOptions.requestTls = tlsOpts   // 通过 CONNECT 隧道时的 TLS
```

#### keep-alive 禁用机制
```typescript
// L24-35：进程级粘性禁用
let keepAliveDisabled = false
export function disableKeepAlive(): void {
  keepAliveDisabled = true
}
// getProxyFetchOptions 返回 {keepalive: false}
```
- **触发时机**：遇到 stale pool ECONNRESET 后
- **范围**：进程生命周期内永久禁用
- **Bun 行为**：原生 `fetch` 尊重 `keepalive: false`
- **Node.js/undici 行为**：`keepalive` 选项对池化无操作，但 undici 自然在 ECONNRESET 时驱逐死套接字

#### 加载/构造/禁用/降级流程
```
configureGlobalAgents()
  ↓
获取 proxyUrl + mtlsAgent
  ↓
弹出旧的 axios 拦截器（避免堆叠）
  ↓
proxyUrl 存在？
  → 是：axios.defaults.proxy = false
        创建 HttpsProxyAgent
        添加请求拦截器（检查 shouldBypassProxy）
        设置 undici 全局 dispatcher
  → 否：mtlsAgent 存在？
        → 是：设置 axios.httpsAgent + undici dispatcher
```

```
getProxyFetchOptions({forAnthropicAPI?})
  ↓
keepAliveDisabled → {keepalive: false}
  ↓
forAnthropicAPI=true 且 ANTHROPIC_UNIX_SOCKET 存在？
  → Bun：返回 {unix: socketPath}
  ↓
proxyUrl 存在？
  → Bun：{proxy: proxyUrl, ...getTLSFetchOptions()}
  → Node：{dispatcher: getProxyAgent(proxyUrl)}
  ↓
否则：{...getTLSFetchOptions()}
```

**失败开放策略**：任何错误都记录警告并禁用代理，不破坏正常工作的会话

#### 错误与安全
| 错误场景 | 处理方式 | 安全考虑 |
|----------|----------|----------|
| 代理 URL 无效 | 记录警告，禁用代理 | 失败开放 |
| 代理连接失败 | 禁用 keep-alive，重试 | 可用性优先 |
| `ANTHROPIC_UNIX_SOCKET` 泄漏到非 Anthropic API | `forAnthropicAPI` flag 限制范围 | 防止请求错误路由 |

#### 设计取舍/备选
| 决策 | 取舍 | 备选方案 |
|------|------|----------|
| `EnvHttpProxyAgent` 而非手动 NO_PROXY | 利用 undici 内置功能，但需要同时设置 `connect` + `requestTls` | 手动管理 NO_PROXY（更灵活但复杂） |
| keep-alive 粘性禁用 | 避免重复遇到坏池，但可能增加连接开销 | 单次请求禁用（可能再次失败） |
| `CLAUDE_CODE_PROXY_RESOLVES_HOSTS` 可选 | 支持沙箱环境，但需要自定义 lookup | 总是本地解析（简单但不兼容沙箱） |

#### 源码测试证据
- `src/utils/proxy.ts` L88-129: `shouldBypassProxy` 实现
- `src/utils/proxy.ts` L220-234: connect/requestTls 同时设置
- `src/utils/proxy.ts` L24-35: keep-alive 禁用
- `src/utils/proxy.ts` L325-388: `configureGlobalAgents` 实现
- `src/utils/proxy.ts` L288-319: `getProxyFetchOptions` 实现

---

### 4.5 AWS 凭据状态模块 (awsAuthStatusManager.ts)

#### 真实入口签名与关键类型
```typescript
export type AwsAuthStatus = {
  isAuthenticating: boolean
  output: string[]
  error?: string
}

export class AwsAuthStatusManager {
  static getInstance(): AwsAuthStatusManager
  startAuthentication(): void
  addOutput(line: string): void
  setError(message: string): void
  endAuthentication(success: boolean): void
  subscribe(callback: (status: AwsAuthStatus) => void): () => void
  static reset(): void  // 测试用
}
```

**设计说明**：原名为 AWS-only，现已用于所有云提供商（AWS Bedrock、GCP Vertex），SDK 'auth_status' 消息形状是 provider-agnostic 的

#### 输入输出
| 方法 | 输入 | 状态变化 |
|------|------|----------|
| `startAuthentication()` | 无 | `isAuthenticating=true`, `output=[]`, `error=undefined` |
| `addOutput(line)` | string | `output.push(line)` |
| `setError(message)` | string | `error=message` |
| `endAuthentication(success)` | boolean | success=true: 清空所有；success=false: `isAuthenticating=false`，保留 output |
| `subscribe(callback)` | function | 返回 unsubscribe 函数 |

#### AWS 状态缓存与订阅
- **Singleton 模式**：`getInstance()` 确保全局唯一
- **Signal 机制**：`createSignal<[status: AwsAuthStatus]>()` 用于状态变化通知
- **React 组件集成**：订阅用于 UI 显示认证进度
- **SDK 输出通信**：在认证工具与 React 组件/SDK 输出之间传递状态

#### 加载/构造/禁用/降级流程
```
开始认证流程
  ↓
AwsAuthStatusManager.getInstance().startAuthentication()
  ↓
运行认证命令
  ↓
每行输出 → addOutput(line)
  ↓
出错？ → setError(message)
  ↓
完成 → endAuthentication(success)
  ↓
success=true：清空状态（不保留输出）
success=false：保留 output 可见，isAuthenticating=false
```

#### 错误与安全
| 场景 | 处理方式 | 安全考虑 |
|------|----------|----------|
| 认证失败 | 保留输出可见，便于诊断 | 不隐藏错误信息 |
| 认证成功 | 清空状态，避免残留敏感输出 | 防止输出泄漏 |
| 多个订阅者 | Signal 广播到所有订阅者 | 确保 UI 一致更新 |

#### 设计取舍/备选
| 决策 | 取舍 | 备选方案 |
|------|------|----------|
| Singleton | 全局一致状态，但测试间需要 `reset()` | 每个流程独立实例（复杂但隔离好） |
| success=true 清空状态 | 安全，但历史输出不可见 | 保留历史（可能泄漏） |
| 泛型命名（AwsAuthStatusManager） | 兼容性，但名称有误导性 | 重命名为 CloudAuthStatusManager（破坏向后兼容） |

#### 源码测试证据
- `src/utils/awsAuthStatusManager.ts` L18-81: 完整实现
- 证据：L10-16 `AwsAuthStatus` 类型；L26-31 `getInstance()` singleton；L40-46 `startAuthentication()`；L58-70 `endAuthentication()` 分支；L72 subscribe 委托

---

### 4.6 crypto/hash 模块 (hash.ts)

#### 真实入口签名与关键类型
```typescript
export function djb2Hash(str: string): number  // 签名 32-bit int
export function hashContent(content: string): string
export function hashPair(a: string, b: string): string
```

#### 输入输出
| 函数 | 输入 | 输出 | 跨运行时确定？ |
|------|------|------|----------------|
| `djb2Hash` | string | number（signed 32-bit int） | 是 |
| `hashContent` | string | string | 否（Bun wyhash vs Node SHA-256） |
| `hashPair` | string, string | string | 否 |

#### djb2 非加密哈希设计
```typescript
// L7-13
export function djb2Hash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}
```
- **算法**：djb2（Dan Bernstein）
- **输出**：signed 32-bit int（`| 0` 确保）
- **用途**：需要跨运行时确定性的场景，如缓存目录名
- **替代**：Bun 原生 `Bun.hash()` 使用 wyhash，不可跨运行时移植；SHA-256 太慢

#### hashContent / hashPair 策略
| 运行时 | hashContent | hashPair |
|--------|-------------|----------|
| Bun | `Bun.hash(content).toString()`（wyhash，~100x 快于 SHA-256） | `Bun.hash(b, Bun.hash(a)).toString()`（seed-chain，无需分隔符） |
| Node.js | `crypto.createHash('sha256').update(content).digest('hex')` | `crypto.createHash('sha256').update(a).update('\0').update(b).digest('hex')`（用 `\0` 分隔） |

**hashPair 防碰撞**：
- Bun：seed-chaining 自然消除歧义 `("ts","code")` vs `("tsc","ode")`
- Node：插入 `\0` 分隔符消除歧义

#### 加载/构造/禁用/降级流程
```
调用 djb2Hash(str)
  ↓
纯 JS 实现，无依赖
  ↓
直接计算返回
```

```
调用 hashContent(content)
  ↓
typeof Bun !== 'undefined'？
  → 是：Bun.hash(content).toString()
  → 否：require('crypto').createHash('sha256')...
```

**降级策略**：
- `djb2Hash`：无降级（纯 JS，总是可用）
- `hashContent` / `hashPair`：Bun 不可用时回退到 Node.js `crypto`

#### 错误与安全
| 场景 | 处理方式 | 安全考虑 |
|------|----------|----------|
| `djb2Hash` 碰撞 | 接受，非加密用途 | 仅用于变更检测，不用于安全 |
| `hashContent` 碰撞 | Bun wyhash 足够抗碰撞用于 diff 检测 | 明确标注非 crypto-safe |
| `crypto` 模块不可用 | （仅 Node.js，理论上不会发生） | 无备用（hashContent 不用于关键路径） |

#### 设计取舍/备选
| 决策 | 取舍 | 备选方案 |
|------|------|----------|
| djb2 纯 JS 实现 | 跨运行时确定，但性能不如原生 | 使用 Bun.hash（简单但不可移植） |
| Bun 优先 wyhash | ~100x 快于 SHA-256，但输出不稳定 | 总是 SHA-256（稳定但慢） |
| hashPair seed-chain / `\0` 分隔 | 无临时字符串分配，但实现复杂 | 简单拼接 `a + ":" + b`（分配临时字符串） |

#### 源码测试证据
- `src/utils/hash.ts` L7-13: `djb2Hash` 实现
- `src/utils/hash.ts` L19-26: `hashContent` 实现
- `src/utils/hash.ts` L34-46: `hashPair` 实现
- 证据：L2-3 注释说明 djb2 用途；L20-22 Bun 分支；L35-37 Bun seed-chain；L39-45 Node `\0` 分隔

---

### 4.7 Protected Namespace / 上游代理模块 (upstreamproxy.ts)

#### 真实入口签名与关键类型
```typescript
export const SESSION_TOKEN_PATH = '/run/ccr/session_token'

export async function initUpstreamProxy(opts?: {
  tokenPath?: string
  systemCaPath?: string
  caBundlePath?: string
  ccrBaseUrl?: string
}): Promise<UpstreamProxyState>

export function getUpstreamProxyEnv(): Record<string, string>

export function resetUpstreamProxyForTests(): void  // 测试用
```

**关键环境变量**：
- `CLAUDE_CODE_REMOTE`：是否在 CCR 容器中
- `CCR_UPSTREAM_PROXY_ENABLED`：功能开关（服务端注入）
- `CLAUDE_CODE_REMOTE_SESSION_ID`：会话 ID

#### 输入输出
| 函数 | 输入 | 输出 |
|------|------|------|
| `initUpstreamProxy()` | 可选路径覆盖 | `{enabled: boolean, port?, caBundlePath?}` |
| `getUpstreamProxyEnv()` | 无 | 环境变量 Record |

#### Protected Namespace 拒绝规则
**NO_PROXY_LIST（L37-63）**：代理必须不拦截的目标
- 环回：`localhost`, `127.0.0.1`, `::1`
- RFC1918 私有网络：`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- IMDS：`169.254.0.0/16`
- Anthropic API：`anthropic.com`, `.anthropic.com`, `*.anthropic.com`（三格式）
- GitHub：`github.com`, `api.github.com`, `*.github.com`, `*.githubusercontent.com`
- 包注册表：`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `index.crates.io`, `proxy.golang.org`

**Anthropic API 例外原因**：无上游路由，且 MITM 破坏非 Bun 运行时（Python httpx/certifi 不信任伪造 CA）

#### 加载/构造/禁用/降级流程
```
initUpstreamProxy()
  ↓
CLAUDE_CODE_REMOTE=false？→ 返回 {enabled: false}
  ↓
CCR_UPSTREAM_PROXY_ENABLED=false？→ 返回 {enabled: false}
  ↓
SESSION_ID 存在？
  ↓
读取 /run/ccr/session_token
  ↓
调用 prctl(PR_SET_DUMPABLE, 0)（Linux + Bun）
  ↓
下载 CA cert，合并系统 bundle → ~/.ccr/ca-bundle.crt
  ↓
启动本地 CONNECT→WebSocket relay（127.0.0.1）
  ↓
unlink(tokenPath)（令牌仅保留在堆中）
  ↓
返回 {enabled: true, port, caBundlePath}
```

**失败开放，每步都可能禁用代理**：
- Token 文件不存在 → 禁用
- CA 下载失败 → 禁用
- Relay 启动失败 → 禁用
- 任何错误 → 记录警告，禁用代理

**继承模式（子进程）**：
- 父进程已初始化，token 文件已 unlink
- 子进程检测到 `HTTPS_PROXY` + `SSL_CERT_FILE` 都设置 → 继承这些 env var

#### 错误与安全
| 场景 | 处理方式 | 安全考虑 |
|------|----------|----------|
| Token 文件读取失败 | 记录警告，禁用代理 | 不破坏会话 |
| prctl 调用失败（非 Linux） | 记录警告，继续 | 仅 Linux 支持 |
| CA 下载失败（5s 超时） | 记录警告，禁用代理 | 不阻塞启动 |
| Token 文件 unlink 失败 | 记录警告，继续 | relay 已在运行 |
| 任何错误 | 失败开放，禁用代理 | 可用性优先于代理 |

**令牌保护**：
- 仅堆中存储令牌
- 文件启动后解除链接（在 relay 确认启动后）
- `prctl(PR_SET_DUMPABLE, 0)` 阻止同 UID ptrace 堆刮取令牌（Linux + Bun）

#### 设计取舍/备选
| 决策 | 取舍 | 备选方案 |
|------|------|----------|
| 失败开放 | 不破坏会话，但代理可能静默禁用 | 硬失败（安全但用户体验差） |
| Token unlink 在 relay 启动后 | 允许 supervisor 重试，但短暂时间窗口内 token 仍存在 | 立即 unlink（失败无法重试） |
| CCR_UPSTREAM_PROXY_ENABLED 服务端注入 | 避免客户端 GB 检查，但需要服务端配合 | 客户端 GB 检查（冷容器总是返回 false） |
| 三格式 NO_PROXY | 兼容各运行时，但列表较长 | 仅一种格式（部分运行时不生效） |

#### 源码测试证据
- `src/upstreamproxy/upstreamproxy.ts` L79-153: `initUpstreamProxy` 实现
- `src/upstreamproxy/upstreamproxy.ts` L160-199: `getUpstreamProxyEnv` 实现
- `src/upstreamproxy/upstreamproxy.ts` L225-252: `setNonDumpable` prctl 调用
- `src/upstreamproxy/upstreamproxy.ts` L37-63: `NO_PROXY_LIST` 三格式
- 证据：L16-18 失败开放注释；L140-144 unlink 在 relay 启动后；L167-182 子进程继承

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
