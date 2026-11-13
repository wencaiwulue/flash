---
id: mcp
batch: 2
title: MCP 连接、能力聚合与生命周期设计
date: 2026-11-12
status: draft
---

# MCP 连接、能力聚合与生命周期设计

本文是对当前MCP实现的回溯性设计说明，描述Model Context Protocol的连接管理、能力聚合、错误隔离和清理生命周期。

## 1. 问题与约束

MCP模块需要解决的核心问题包括:

- **多传输类型支持**: 需要同时支持stdio、SSE、HTTP、WebSocket、SDK in-process、claude.ai proxy等多种传输方式
- **配置发现与聚合**: 需要从多个来源(项目.mcp.json、用户配置、插件、claude.ai、企业配置)发现并去重服务器配置
- **连接生命周期管理**: 建立、重试、重连、清理完整生命周期
- **能力聚合**: 将不同服务器的tools/resources/prompts统一暴露给上层
- **认证与重连**: 支持OAuth、需要认证状态的缓存与重试
- **错误隔离**: 单个服务器失败不应影响其他服务器
- **SDK in-process vs外部服务器**: 区分SDK内部服务器和外部服务器的处理逻辑

关键约束:

- 连接超时: 默认30秒，可通过MCP_TIMEOUT环境变量配置
- 批处理并发: 本地服务器(stdio/sdk)3并发，远程服务器20并发
- 工具描述截断: 超过2048字符的描述会被截断
- 认证缓存TTL: needs-auth状态缓存15分钟
- 内存限制: fetch缓存大小限制为20个服务器
- 企业配置独占: 如果存在企业配置，只使用企业配置的服务器
- OAuth令牌刷新: 剩余5分钟(300秒)时自动刷新，使用跨进程锁防止并发
- 最大重连错误: 3次连续终端错误(ECONNRESET/ETIMEDOUT/EPIPE等)后关闭传输
- 工具超时: 默认约27.8小时(100,000,000ms)，可通过MCP_TOOL_TIMEOUT配置
- MCP请求超时: 60秒，非GET请求使用fresh timeout避免stale signal bug
- Streamable HTTP Accept: 必须同时接受application/json和text/event-stream

## 2. 设计理由与备选方案

### 2.1 多源配置聚合与去重策略

**当前设计**: 配置从多个来源按优先级聚合，通过内容签名进行去重。

**证据位置**: `src/services/mcp/config.ts` 的 `dedupPluginMcpServers`、`dedupClaudeAiMcpServers`、`getMcpServerSignature`

**为什么这样设计**:

- 优先级: enterprise > local > project > user > plugin > claude.ai
- 去重基于内容而非名称: 插件和claude.ai可能配置相同的服务器，通过command或URL签名识别重复
- CCR proxy URL特殊处理: 提取原始vendor URL用于签名匹配
- SDK type服务器无签名: SDK服务器不需要去重

**代价**: 需要维护签名计算逻辑，且签名变化会导致去重失效

**备选方案**:
- 仅按名称去重: 会导致不同服务器同名冲突
- 完全不去重: 导致重复连接和工具冲突

**为什么不采用备选**: 仅按名称去重不够精确，完全不去重会导致混乱。

### 2.2 连接状态机

**当前设计**: 服务器连接有5种状态: connected/failed/needs-auth/pending/disabled

**证据位置**: `src/services/mcp/types.ts` 的 `MCPServerConnection` union type

**为什么这样设计**:

- `connected`: 正常连接，有client和capabilities
- `failed`: 连接失败，保留错误信息
- `needs-auth`: 需要认证，提供McpAuthTool
- `pending`: 等待重连，保留重连次数
- `disabled`: 用户禁用，不尝试连接

状态转换:
- connect → connected/failed/needs-auth
- 连接断开 → 缓存清除 → 下次操作重连
- 认证失败 → needs-auth → 缓存15分钟避免重复探测

### 2.3 批处理连接调度策略

**当前设计**: 2026-03重构后使用pMap而非固定批次顺序处理，按服务器类型分两个并发池。

**证据位置**: `src/services/mcp/client.ts` 的 `processBatched` 和 `getMcpToolsCommandsAndResources`

**为什么这样设计**:

之前实现是固定批次顺序处理(await batch 1全完成再start batch 2)，导致一个慢服务器阻塞整个批次。现在:
- 本地服务器(stdio/sdk): 3并发，避免进程创建资源竞争
- 远程服务器: 20并发，主要是网络等待
- pMap动态调度，完成一个释放一个槽位

**代价**: 实现稍复杂，需要区分服务器类型。

**设计推断**: 这种调度在真实场景中表现更好，特别是有慢服务器时。

### 2.4 memoization缓存策略

**当前设计**: 连接和fetch操作有多层memoization，但注意避免内存泄漏。

**证据位置**:
- `connectToServer`: memoize，key为`serverCacheKey(name, config)`
- `fetchToolsForClient/fetchResourcesForClient/fetchCommandsForClient`: memoizeWithLRU，大小20
- `onclose`回调中清除缓存

**为什么这样设计**:

- 避免重复连接: 同一配置的服务器复用连接
- LRU限制fetch缓存: 防止服务器很多时内存无限增长
- 连接断开时清除缓存: 确保重连时获取新数据

**代价**: memoization增加复杂度，需要正确处理缓存失效。

**边界疑虑**: memoize的key使用jsonStringify(config)，如果配置中有不可序列化内容会有问题，但当前配置都是可JSON化的。

### 2.5 SDK in-process服务器特殊处理

**当前设计**: SDK类型服务器不通过`connectToServer`，而是在`setupSdkMcpClients`中处理。

**证据位置**: `src/services/mcp/client.ts` 的 `ensureConnectedClient`、`connectToServer` 中对type==='sdk'的判断

**为什么这样设计**:

SDK服务器是in-process的，通过`SdkControlTransport`直接通信，不需要:
- 进程spawn
- 网络连接
- 超时处理
- 重连逻辑

但仍需要:
- 工具规范化
- 权限检查
- 错误处理

### 2.6 needs-auth缓存与跳过策略

**当前设计**: 认证失败的服务器缓存15分钟，期间跳过连接尝试。

**证据位置**:
- `src/services/mcp/client.ts` 的 `isMcpAuthCached`、`setMcpAuthCacheEntry`、`getMcpAuthCache`
- `src/services/mcp/auth.ts` 的 `hasMcpDiscoveryButNoToken`

**为什么这样设计**:

- 避免重复失败的网络请求: 每个需要认证的服务器每次启动探测一次，之后15分钟跳过
- print模式等待全批次完成: 不缓存会导致启动延迟
- 双重检查: 除了TTL缓存，还有`hasMcpDiscoveryButNoToken`检查(有discovery配置但无token)

**代价**: 用户刚配置好认证后需要等待15分钟或手动重连。

**备选方案**:
- 不缓存: 每次都尝试，导致启动慢
- 更短TTL: 增加重试频率但仍有延迟

**为什么不采用备选**: 权衡用户体验和启动速度。

### 2.6.5 OAuth认证与令牌刷新设计

**当前设计**: ClaudeAuthProvider实现完整OAuth流程，包含抢先刷新、跨进程锁、重试策略。

**证据位置**: `src/services/mcp/auth.ts` 的 `ClaudeAuthProvider`、`refreshAuthorization`

**为什么这样设计**:

- **抢先刷新**: 令牌剩余5分钟(300秒)时自动刷新，避免使用过期令牌
- **跨进程锁**: 使用lockfile防止多个进程同时刷新，避免竞态条件
- **双重检查**: 获取锁后重新读取存储，检查其他进程是否已刷新
- **重试策略**: 最多3次，指数退避(1s, 2s, 4s)
- **RFC 9728/8414**: 支持授权服务器元数据发现
- **XAA跨应用访问**: 一次IdP登录，多服务器复用，无浏览器jwt-bearer交换

**代价**: 实现复杂，需要管理锁文件和状态。

**边界疑虑**: 锁文件如果卡住可能导致无法刷新，但有超时保护。

### 2.7 stdio服务器进程清理 escalator

**当前设计**: stdio服务器清理时先SIGINT，等待，然后SIGTERM，再SIGKILL。

**证据位置**: `src/services/mcp/client.ts` 的 cleanup函数，约1450-1600行

**为什么这样设计**:

- 给服务器优雅关闭的机会: SIGINT是温和的
- 有超时保护: 不会无限等待
- 最终强制终止: 确保不留下僵尸进程

**代价**: 清理代码较复杂。

### 2.8 错误隔离与单个服务器失败处理

**当前设计**: 单个服务器连接/工具调用失败不影响其他服务器。

**证据位置**:
- `getMcpToolsCommandsAndResources` 中每个服务器的try/catch
- 工具调用时的错误处理，返回空工具列表但继续
- `McpSessionExpiredError` 用于区分可重试错误

**为什么这样设计**: MCP是多服务器系统，一个服务器不稳定不应破坏整个体验。

## 3. 目标与非目标

### 3.1 目标

- **支持多种传输类型**: stdio、SSE、HTTP、WebSocket、SDK、claude.ai proxy
- **统一能力聚合**: 以统一方式暴露tools/resources/prompts
- **可靠的生命周期**: 连接、重试、重连、清理
- **错误隔离**: 单个服务器失败不影响全局
- **认证支持**: OAuth、needs-auth流程
- **SDK集成**: 支持in-process SDK服务器

### 3.2 非目标

- **不实现MCP协议本身**: 使用@modelcontextprotocol/sdk
- **不处理工具执行细节**: 工具执行由上层统一处理
- **不实现服务器**: 只作为客户端
- **不跨会话持久化连接**: 连接是会话级的

## 4. 架构、模块与数据流

### 4.1 核心模块职责

| 模块 | 职责 | 关键类型/函数 |
|------|------|---------------|
| `config.ts` | 配置加载、聚合、去重、持久化 | `getAllMcpConfigs`、`dedupPluginMcpServers`、`addMcpConfig` |
| `client.ts` | 连接管理、能力获取、工具调用 | `connectToServer`、`fetchToolsForClient`、`callMCPTool` |
| `types.ts` | 核心类型定义 | `MCPServerConnection`、`ConnectedMCPServer`、`ScopedMcpServerConfig` |
| `auth.ts` | OAuth认证、token管理 | `ClaudeAuthProvider`、`performMCPOAuthFlow`、`handleOAuth401Error` |
| `xaa.ts`、`xaaIdpLogin.ts` | 跨应用访问(XAA)认证 | XAA流程、IdP令牌获取 |
| `normalization.ts` | 名称规范化 | `normalizeNameForMCP`、`buildMcpToolName` |
| `useManageMCPConnections.ts` | React hook连接管理 | `useManageMCPConnections` |
| `MCPConnectionManager.tsx` | React上下文 | `MCPConnectionManager` |
| `InProcessTransport.ts` | In-process传输 | `createLinkedTransportPair()` |
| `SdkControlTransport.ts` | SDK控制传输桥接 | `SdkControlClientTransport`、`SdkControlServerTransport` |

### 4.2 完整数据流: 启动→连接→能力获取

```
启动
  ↓
getAllMcpConfigs()
  ├─ enterprise配置检查 → 如果存在，只使用enterprise
  ├─ 加载user配置
  ├─ 加载project配置(遍历目录树)
  ├─ 加载local配置
  ├─ 加载plugins → getPluginMcpServers
  ├─ 加载claude.ai → fetchClaudeAIMcpConfigsIfEligible
  ├─ 去重: dedupPluginMcpServers、dedupClaudeAiMcpServers
  └─ 应用企业策略过滤
  ↓
getMcpToolsCommandsAndResources(onConnectionAttempt)
  ├─ 区分disabled服务器 → 直接通知，不连接
  ├─ 区分needs-auth缓存 → 跳过连接，提供McpAuthTool
  ├─ 分本地/远程两个pMap池并发连接
  │   ├─ 本地: stdio/sdk，3并发
  │   └─ 远程: sse/http/ws，20并发
  ├─ 对每个服务器:
  │   ├─ connectToServer(name, config)
  │   │   ├─ 根据type创建transport
  │   │   ├─ Client.connect(transport)
  │   │   ├─ 设置onerror/onclose回调
  │   │   └─ 返回ConnectedMCPServer
  │   ├─ fetchToolsForClient(client)
  │   │   └─ client.request({method: 'tools/list'})
  │   ├─ fetchResourcesForClient(client)
  │   │   └─ client.request({method: 'resources/list'})
  │   ├─ fetchCommandsForClient(client)
  │   │   └─ client.request({method: 'prompts/list'})
  │   └─ onConnectionAttempt({client, tools, commands, resources})
  └─ 完成: tengu_mcp_tools_commands_loaded事件
```

### 4.3 传输类型矩阵

| 传输类型 | 配置type | 创建方式 | 清理方式 |
|---------|---------|---------|---------|
| stdio | undefined/'stdio' | StdioClientTransport | SIGINT→SIGTERM→SIGKILL escalator，时间线: 0ms→100ms检查→500ms最终超时 |
| SSE | 'sse' | SSEClientTransport + ClaudeAuthProvider | close，有SDK内部重连 |
| HTTP | 'http' | StreamableHTTPClientTransport + ClaudeAuthProvider + wrapFetchWithTimeout | close |
| WebSocket | 'ws' | WebSocketTransport + mcpWebSocketTransport.ts | close |
| SSE IDE | 'sse-ide' | SSEClientTransport，无auth | close |
| WebSocket IDE | 'ws-ide' | WebSocketTransport，特定headers(X-Claude-Code-Ide-Authorization) | close |
| SDK | 'sdk' | 特殊处理，不经过connectToServer，通过SdkControlTransport桥接 | 无特殊清理 |
| claude.ai proxy | 'claudeai-proxy' | StreamableHTTPClientTransport + createClaudeAiProxyFetch (含401重试) | close |
| Chrome (builtin) | stdio+name判断 | getOpenChromeClient(ChromeContext)，复用连接 | closeOpenChromeClient |
| Computer Use (builtin) | stdio+name判断+feature flag | InProcessTransport + createComputerUseMcpServerForCli，createLinkedTransportPair双向链接 | close in-process server |

### 4.4 工具调用流程

```
MCPTool.call(args, context)
  ↓
ensureConnectedClient(client)
  ├─ SDK type: 直接返回
  └─ 其他: 从memoize缓存获取或重连
  ↓
callMCPToolWithUrlElicitationRetry({client, tool, args, ...})
  ├─ 设置toolUseId元数据
  ├─ 处理elicitation (OAuth/UI)
  ├─ 重试McpSessionExpiredError
  └─ 返回transformed结果
  ↓
transformMCPResult(result, tool, name)
  ├─ toolResult → string
  ├─ structuredContent → JSON string + schema
  └─ contentArray → transformed ContentBlockParam[]
```

### 4.5 工具命名规范化

**当前设计**: MCP工具名称前缀为`mcp__${serverName}__${toolName}`，serverName经过规范化。

**证据位置**: `src/services/mcp/normalization.ts`、`buildMcpToolName`

规范化规则:
- 替换非字母数字为下划线
- 转小写
- 去重(相同名称添加数字后缀)

SDK模式可选跳过前缀: 当`CLAUDE_AGENT_SDK_MCP_NO_PREFIX=true`，SDK服务器工具使用原始名称，可覆盖内置工具。

### 4.6 配置来源与scope

| Scope | 来源 | 说明 |
|-------|------|------|
| 'enterprise' | getEnterpriseMcpFilePath() | 企业配置，独占模式 |
| 'local' | getCurrentProjectConfig().mcpServers | 项目本地配置 |
| 'project' | 目录树的.mcp.json | 项目配置，从cwd向上遍历 |
| 'user' | getGlobalConfig().mcpServers | 用户全局配置 |
| 'dynamic' | 运行时传入 | SDK动态配置 |
| 'claudeai' | fetchClaudeAIMcpConfigsIfEligible | claude.ai connectors |

---

### 4.7 模块设计卡片

### 4.7.1 配置发现模块 (config.ts)

**真实入口签名**
```typescript
export async function getAllMcpConfigs(): Promise<{
  servers: Record<string, ScopedMcpServerConfig>;
  errors: PluginError[];
}>

export async function getClaudeCodeMcpConfigs(
  dynamicServers: Record<string, ScopedMcpServerConfig> = {},
  extraDedupTargets: Promise<Record<string, ScopedMcpServerConfig>> = Promise.resolve({}),
): Promise<{ servers: Record<string, ScopedMcpServerConfig>; errors: PluginError[]; }>

export function getMcpConfigsByScope(scope: 'project' | 'user' | 'local' | 'enterprise'): {
  servers: Record<string, ScopedMcpServerConfig>;
  errors: ValidationError[];
}

export function getMcpConfigByName(name: string): ScopedMcpServerConfig | null

export function dedupPluginMcpServers(
  pluginServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): { servers: Record<string, ScopedMcpServerConfig>; suppressed: Array<{ name: string; duplicateOf: string }>; }

export function dedupClaudeAiMcpServers(
  claudeAiServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): { servers: Record<string, ScopedMcpServerConfig>; suppressed: Array<{ name: string; duplicateOf: string }>; }

export function getMcpServerSignature(config: McpServerConfig): string | null
```

**关键类型**
```typescript
export type ConfigScope = 'enterprise' | 'local' | 'project' | 'user' | 'dynamic' | 'claudeai' | 'managed'

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope;
  pluginSource?: string;
}

export type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | 
  McpSSEIDEServerConfig | McpWebSocketIDEServerConfig | McpHTTPServerConfig | 
  McpWebSocketServerConfig | McpSdkServerConfig | McpClaudeAIProxyServerConfig
```

**输入输出**
- **输入**: 无（getAllMcpConfigs）或配置范围、服务器名称
- **输出**: 带scope的服务器配置映射、错误列表、去重结果
- **副作用**: 读取文件系统（项目.mcp.json、用户配置、企业配置），调用getPluginMcpServers，调用fetchClaudeAiMcpConfigsIfEligible

**设计取舍**
- **优先级排序**: enterprise > local > project > user > plugin > claudeai — 企业配置独占，确保企业策略优先
- **内容签名去重**: 基于command/URL而非名称去重，避免不同来源配置相同服务器导致重复连接
- **CCR Proxy URL特殊处理**: extract原始vendor URL用于签名匹配，支持远程会话场景
- **SDK类型无签名**: SDK in-process服务器不参与去重，其配置由SDK动态管理

**备选方案**
- 仅按名称去重: 导致不同服务器同名冲突，已废弃
- 完全不去重: 导致重复连接和工具冲突，已废弃

**源码测试证据**
- `dedupPluginMcpServers` 测试: 验证插件服务器与手动配置去重逻辑
- `dedupClaudeAiMcpServers` 测试: 验证claude.ai连接器与手动配置去重逻辑
- `getMcpServerSignature` 测试: 验证不同配置类型的签名生成
- `unwrapCcrProxyUrl` 测试: 验证CCR代理URL解包逻辑

---

### 4.7.2 Client/Connection Manager 模块 (client.ts)

**真实入口签名**
```typescript
export async function getMcpToolsCommandsAndResources(
  onConnectionAttempt?: (connection: MCPServerConnection) => void,
): Promise<{
  tools: Tool[];
  resources: Record<string, ServerResource[]>;
  commands: Tool[];
  connections: MCPServerConnection[];
}>

export const connectToServer = memoize(async (
  name: string,
  serverRef: ScopedMcpServerConfig,
  serverStats?: { totalServers: number; stdioCount: number; sseCount: number; httpCount: number; sseIdeCount: number; wsIdeCount: number; },
): Promise<MCPServerConnection>)

export async function ensureConnectedClient(
  connection: ConnectedMCPServer,
): Promise<Client>

export async function callMCPTool(
  client: Client,
  serverName: string,
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<MCPToolResult>

export async function reconnectMcpServerImpl(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<{ client: MCPServerConnection; tools: Tool[]; commands: Tool[]; resources?: ServerResource[]; }>

export async function closeAllMcpServers(): Promise<void>
```

**关键类型**
```typescript
export type MCPServerConnection = ConnectedMCPServer | FailedMCPServer | NeedsAuthMCPServer | PendingMCPServer | DisabledMCPServer

export type ConnectedMCPServer = {
  client: Client;
  name: string;
  type: 'connected';
  capabilities: ServerCapabilities;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  config: ScopedMcpServerConfig;
  cleanup: () => Promise<void>;
}

export type FailedMCPServer = { name: string; type: 'failed'; config: ScopedMcpServerConfig; error?: string; }
export type NeedsAuthMCPServer = { name: string; type: 'needs-auth'; config: ScopedMcpServerConfig; }
export type PendingMCPServer = { name: string; type: 'pending'; config: ScopedMcpServerConfig; reconnectAttempt?: number; maxReconnectAttempts?: number; }
export type DisabledMCPServer = { name: string; type: 'disabled'; config: ScopedMcpServerConfig; }
```

**连接状态转换**
```
disconnected → [connectToServer] → connecting
  ↓
  ├─→ connected (正常连接，获取tools/resources)
  │   ↓
  │   [onclose] → disconnected (清除memoize缓存)
  │
  ├─→ failed (连接/初始化失败，保留error)
  │   ↓
  │   [reconnectMcpServerImpl] → connecting
  │
  ├─→ needs-auth (401 Unauthorized，缓存15分钟)
  │   ↓
  │   [McpAuthTool] → performMCPOAuthFlow → [reconnect] → connecting
  │
  └─→ disabled (用户禁用，不尝试连接)
```

**完整握手/调用/关闭生命周期**

1. **握手阶段 (connectToServer)**
   - 根据配置类型创建对应Transport
   - Client.connect(transport)建立连接
   - 设置onerror/onclose回调
   - 调用initializeSession获取capabilities
   - 成功: 返回ConnectedMCPServer
   - 401: 返回NeedsAuthMCPServer并设置缓存
   - 其他错误: 返回FailedMCPServer

2. **调用阶段 (callMCPTool)**
   - ensureConnectedClient检查连接状态
   - 若SDK类型直接返回，否则从缓存获取或重连
   - callMCPToolWithUrlElicitationRetry处理elicitation
   - 捕获McpSessionExpiredError，清除缓存后可重试1次
   - transformMCPResult转换结果格式

3. **关闭阶段 (cleanup/closeAllMcpServers)**
   - stdio: SIGINT → 100ms检查 → SIGTERM → 最终超时强制结束
   - sse/http/ws: transport.close()
   - sdk: 无特殊清理
   - onclose回调清除memoize缓存

**并发连接与cleanup顺序**
- **本地服务器** (stdio/sdk): pMap并发3个，避免进程创建资源竞争
- **远程服务器** (sse/http/ws/sse-ide/ws-ide/claudeai-proxy): pMap并发20个
- **Cleanup顺序**: 无严格顺序，但每个服务器独立清理，避免连锁失败
- **错误隔离**: 单个服务器连接/调用失败不影响其他服务器

**源码测试证据**
- `getMcpToolsCommandsAndResources` 测试: 验证批处理并发逻辑
- `connectToServer` 测试: 验证不同传输类型连接
- `callMCPTool` 测试: 验证工具调用与错误处理
- `isMcpSessionExpiredError` 测试: 验证会话过期检测
- `closeAllMcpServers` 测试: 验证清理逻辑

---

### 4.7.3 Stdio/In-Memory/WebSocket Transports 模块

#### 4.7.3.1 Stdio Transport (StdioClientTransport from @modelcontextprotocol/sdk)

**真实入口创建**
```typescript
// client.ts: stdio类型处理
if (!serverRef.type || serverRef.type === 'stdio') {
  const stdioConfig = serverRef as McpStdioServerConfig;
  const command = expandEnvVarsInString(stdioConfig.command);
  const args = stdioConfig.args.map(expandEnvVarsInString);
  
  transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...stdioConfig.env },
    cwd: getOriginalCwd(),
    stderr: 'pipe',
  });
}
```

**关键类型**
```typescript
export type McpStdioServerConfig = {
  type?: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}
```

**Cleanup escalator**
```typescript
// SIGINT 温和关闭 → 等待100ms检查 → SIGTERM → 最终超时强制结束
const cleanupStdio = async (child: ChildProcess) => {
  child.kill('SIGINT');
  await sleep(100);
  if (!child.killed) {
    child.kill('SIGTERM');
    await sleep(500);
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  }
};
```

**设计取舍**
- 先SIGINT给优雅关闭机会: 符合POSIX信号语义
- 超时保护: 避免挂起的子进程
- 最终SIGKILL: 确保不留下僵尸进程

#### 4.7.3.2 In-Memory Transport (SdkControlTransport)

**真实入口签名**
```typescript
export class SdkControlClientTransport implements Transport {
  constructor(
    private serverName: string,
    private sendMcpMessage: SendMcpMessageCallback,
  )
  async start(): Promise<void>
  async send(message: JSONRPCMessage): Promise<void>
  async close(): Promise<void>
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
}

export class SdkControlServerTransport implements Transport {
  constructor(private sendMcpMessage: (message: JSONRPCMessage) => void)
  async start(): Promise<void>
  async send(message: JSONRPCMessage): Promise<void>
  async close(): Promise<void>
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
}

export type SendMcpMessageCallback = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>
```

**InMemoryTransport与外部Server差异**

| 特性 | SdkControlTransport (in-memory) | 外部Server (stdio/sse/http/ws) |
|------|---------------------------------|--------------------------------|
| 进程位置 | 同一进程内 | 独立进程/远程服务 |
| 通信方式 | 控制消息桥接 + 回调 | 标准I/O/网络协议 |
| 连接建立 | 无需，直接通过StructuredIO | 需要connect/握手 |
| 超时处理 | 无 | 有(30s可配置) |
| 重连逻辑 | 无，in-process可靠性高 | 有，onclose触发缓存清除 |
| Cleanup | 无特殊操作 | transport.close + stdio escalator |
| 认证 | 无，SDK控制消息隐含信任 | OAuth/headers按需 |
| 工具名称前缀 | 可选跳过(CLAUDE_AGENT_SDK_MCP_NO_PREFIX) | 强制mcp__<server>__<tool> |

**消息流**
```
CLI → SDK (SdkControlClientTransport)
  1. MCP Client.send(JSONRPCRequest)
  2. 包装为控制请求 { type: 'mcp_message', server_name, message }
  3. 通过stdout发送到SDK进程
  4. SDK的StructuredIO接收并路由
  5. SdkControlServerTransport.onmessage(JSONRPCRequest)
  6. MCP Server处理
  7. SdkControlServerTransport.send(JSONRPCResponse)
  8. 通过sendMcpMessage回调返回
  9. SdkControlClientTransport.onmessage(JSONRPCResponse)
  10. MCP Client接收响应
```

**源码测试证据**
- tests/sdkMcp.test.ts: 验证SDK in-process服务器注册、调用、元数据传递

#### 4.7.3.3 WebSocket Transport (mcpWebSocketTransport.ts)

**真实入口创建**
```typescript
// client.ts: ws类型处理
if (serverRef.type === 'ws') {
  const wsConfig = serverRef as McpWebSocketServerConfig;
  const combinedHeaders = await getMcpServerHeaders(name, wsConfig);
  const proxyAgent = getWebSocketProxyAgent();
  const wsOptions: Record<string, unknown> = {
    headers: { 'User-Agent': getMCPUserAgent(), ...combinedHeaders },
    ...(proxyAgent ? { agent: proxyAgent } : {}),
    ...getWebSocketTLSOptions(),
  };
  
  transport = new WebSocketTransport({
    url: new URL(wsConfig.url),
    createWsClient: (url: string, options: Record<string, unknown>) => createNodeWsClient(url, options),
  });
}

// ws-ide类型处理
if (serverRef.type === 'ws-ide') {
  const wsIdeConfig = serverRef as McpWebSocketIDEServerConfig;
  const headers: Record<string, string> = { 'User-Agent': getMCPUserAgent() };
  if (wsIdeConfig.authToken) {
    headers['X-Claude-Code-Ide-Authorization'] = wsIdeConfig.authToken;
  }
  
  transport = new WebSocketTransport({
    url: new URL(wsIdeConfig.url),
    createWsClient: (url: string, options: Record<string, unknown>) => createNodeWsClient(url, options),
  });
}
```

**关键类型**
```typescript
export type McpWebSocketServerConfig = {
  type: 'ws';
  url: string;
  headers?: Record<string, string>;
  headersHelper?: string;
}

export type McpWebSocketIDEServerConfig = {
  type: 'ws-ide';
  url: string;
  ideName: string;
  authToken?: string;
  ideRunningInWindows?: boolean;
}
```

**设计取舍**
- 使用ws包而非Bun内置WebSocket: 兼容性更好，支持完整MCP协议
- 支持代理: getWebSocketProxyAgent集成代理配置
- TLS支持: getWebSocketTLSOptions提供安全连接选项
- IDE专用headers: X-Claude-Code-Ide-Authorization用于IDE扩展认证

**源码测试证据**
- WebSocketTransport测试: 验证连接、消息发送、关闭逻辑
- ws-ide类型测试: 验证IDE扩展认证流程

---

### 4.7.4 认证与重连模块 (auth.ts)

**真实入口签名**
```typescript
export async function performMCPOAuthFlow(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
  onAuthorizationUrl: (url: string) => void,
  abortSignal?: AbortSignal,
  options?: {
    skipBrowserOpen?: boolean;
    onWaitingForCallback?: (submit: (callbackUrl: string) => void) => void;
  },
): Promise<void>

export class ClaudeAuthProvider implements OAuthClientProvider {
  constructor(
    serverName: string,
    serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
    redirectUri: string = buildRedirectUri(),
    handleRedirection = false,
    onAuthorizationUrl?: (url: string) => void,
    skipBrowserOpen?: boolean,
  )
  async state(): Promise<string>
  async clientInformation(): Promise<OAuthClientInformation | undefined>
  async saveClientInformation(clientInfo: OAuthClientInformationFull): Promise<void>
  async tokens(): Promise<OAuthTokens | undefined>
  async saveTokens(tokens: OAuthTokens): Promise<void>
  async redirectToAuthorization(authUrl: URL): Promise<void>
  async saveCodeVerifier(codeVerifier: string): Promise<void>
  async codeVerifier(): Promise<string>
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void>
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void>
  async discoveryState(): Promise<OAuthDiscoveryState | undefined>
  async refreshAuthorization(refreshToken: string): Promise<OAuthTokens | undefined>
  setMetadata(metadata: AuthorizationServerMetadata): void
  markStepUpPending(scope: string): void
}

export async function refreshAuthorization(
  serverUrl: URL,
  options: {
    metadata: AuthorizationServerMetadata;
    clientInformation: OAuthClientInformation;
    refreshToken: string;
    resource: URL;
    fetchFn?: FetchLike;
  },
): Promise<OAuthTokens>

export async function revokeServerTokens(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
  options?: { preserveStepUpState?: boolean },
): Promise<void>

export function hasMcpDiscoveryButNoToken(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): boolean

export function getServerKey(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): string
```

**关键类型**
```typescript
export type McpOAuthConfig = {
  clientId?: string;
  callbackPort?: number;
  authServerMetadataUrl?: string;
  xaa?: boolean;
}

export type McpSSEServerConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  headersHelper?: string;
  oauth?: McpOAuthConfig;
}

export type McpHTTPServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  headersHelper?: string;
  oauth?: McpOAuthConfig;
}
```

**needs-auth缓存与过期**
```typescript
const MCP_AUTH_CACHE_TTL_MS = 15 * 60 * 1000; // 15分钟

// 缓存结构: ~/.claude-code/mcp-needs-auth-cache.json
type McpAuthCacheData = Record<string, { timestamp: number }>

// 检查缓存
async function isMcpAuthCached(serverId: string): Promise<boolean> {
  const cache = await getMcpAuthCache();
  const entry = cache[serverId];
  if (!entry) return false;
  return Date.now() - entry.timestamp < MCP_AUTH_CACHE_TTL_MS;
}

// 设置缓存
function setMcpAuthCacheEntry(serverId: string): void

// 清除缓存
export function clearMcpAuthCache(): void
```

**缓存策略设计取舍**
- TTL 15分钟: 平衡启动速度与用户体验
- 文件持久化: 跨会话保持缓存状态
- memoize读缓存: 避免并发批量连接时重复读文件
- 链式写序列化: 防止并发读写竞争

**OAuth完整流程**
```
1. Discovery阶段
   ├─ fetchAuthServerMetadata(authServerMetadataUrl)
   ├─ 或 RFC 9728 → RFC 8414发现
   ├─ 或回退直接MCP服务器路径发现
   └─ 保存discoveryState (仅URL，非完整metadata，避免keychain溢出)

2. PKCE准备
   ├─ state(): 生成随机state
   ├─ codeVerifier(): 生成code_verifier
   └─ 保存codeVerifier

3. 授权重定向
   ├─ redirectToAuthorization(authUrl)
   ├─ 调用onAuthorizationUrl回调
   ├─ 若handleRedirection=true，打开浏览器
   └─ 保存stepUpScope (若来自403 insufficient_scope)

4. 回调接收
   ├─ 本地HTTP服务器监听/callback
   ├─ 验证state匹配
   ├─ 接收code或error
   └─ 5分钟超时保护

5. Token交换
   ├─ sdkAuth(provider, { serverUrl, authorizationCode, resourceMetadataUrl })
   ├─ 调用tokens()获取access_token/refresh_token
   └─ saveTokens持久化到keychain

6. 抢先刷新 (tokens()路径)
   ├─ 检查expiresAt ≤ 5分钟
   ├─ 是 → refreshAuthorization()
   ├─ 跨进程锁: lockfile防止并发刷新
   ├─ 双重检查: 锁后再次读取keychain
   └─ 指数退避重试: 1s/2s/4s，最多3次

7. Step-up检测 (403 insufficient_scope)
   ├─ wrapFetchWithStepUpDetection包装fetch
   ├─ 检测403 + WWW-Authenticate: scope=...
   ├─ markStepUpPending(scope)
   └─ 下次tokens()省略refresh_token → SDK触发PKCE重新授权
```

**XAA (Cross-App Access) 特殊流程**
```
条件: serverConfig.oauth.xaa === true && CLAUDE_CODE_ENABLE_XAA === true

流程:
  1. acquireIdpIdToken() 从IdP获取id_token (或从缓存读取)
  2. discoverOidc(idpIssuer) 发现IdP的token endpoint
  3. performCrossAppAccess() 执行RFC 8693 token交换
     ├─ id_token → AS的access_token
     └─ 无需浏览器交互
  4. 保存tokens，同标准OAuth

静默刷新路径 (ClaudeAuthProvider.tokens()):
  ├─ 无refresh_token但有cached id_token
  ├─ 触发xaaRefresh()
  └─ 静默获取新access_token
```

**错误隔离**
- 单个服务器认证失败不影响其他服务器
- 认证错误缓存隔离，按serverKey独立过期
- refreshAuthorization失败仅清除该服务器tokens，不影响client info
- invalidateCredentials支持细粒度scope: all/client/tokens/verifier/discovery

**源码测试证据**
- `performMCPOAuthFlow` 测试: 验证完整OAuth流程
- `ClaudeAuthProvider.tokens` 测试: 验证抢先刷新逻辑
- `refreshAuthorization` 测试: 验证令牌刷新与跨进程锁
- `hasMcpDiscoveryButNoToken` 测试: 验证needs-auth检测
- `wrapFetchWithStepUpDetection` 测试: 验证step-up检测

---

### 4.7.5 McpAuthTool 伪工具模块 (McpAuthTool.ts)

**真实入口签名**
```typescript
export function createMcpAuthTool(
  serverName: string,
  config: ScopedMcpServerConfig,
): Tool<InputSchema, McpAuthOutput>

export type McpAuthOutput = {
  status: 'auth_url' | 'unsupported' | 'error';
  message: string;
  authUrl?: string;
}
```

**McpAuthTool伪工具设计**

**目的**: 在needs-auth状态下，替代真实工具暴露给模型，让模型知道服务器存在并可启动OAuth流程

**工具名称**: `mcp__<serverName>__authenticate`

**工作流**
```
1. 模型调用mcp__<serverName>__authenticate
2. createMcpAuthTool.call()执行
3. 检查配置类型
   ├─ claudeai-proxy → unsupported (使用MCPRemoteServerMenu)
   ├─ 非sse/http → unsupported (手动认证)
   └─ sse/http → 继续
4. 启动performMCPOAuthFlow，skipBrowserOpen=true
5. 通过onAuthorizationUrl回调捕获authUrl
6. 立即返回authUrl给模型
7. 后台等待OAuth完成
   ├─ 成功 → clearMcpAuthCache
   ├─ → reconnectMcpServerImpl
   ├─ → 前缀替换: 移除mcp__<serverName>__*
   ├─ → 插入真实工具
   └─ 失败 → 记录日志，保留needs-auth状态
```

**与真实工具差异**
| 特性 | McpAuthTool | 真实MCP工具 |
|------|-------------|-------------|
| 来源 | createMcpAuthTool动态创建 | fetchToolsForClient从服务器获取 |
| 名称格式 | mcp__<server>__authenticate | mcp__<server>__<toolName> |
| 是否持久化 | 否，仅needs-auth期间存在 | 是，connected期间存在 |
| 调用结果 | auth_url/unsupported/error | 工具实际执行结果 |
| 是否需要权限 | 否，自动allow | 是，checkPermissions检查 |
| 并发安全 | 否，isConcurrencySafe=false | 视工具而定 |

**工具名称冲突处理**
- 前缀替换保证唯一性: `mcp__<serverName>__` 前缀
- reconnect时前缀匹配移除: `reject(prev.mcp.tools, t => t.name?.startsWith(prefix))`
- 真实工具插入时覆盖伪工具: 同前缀先删后加，无冲突

**源码测试证据**
- `createMcpAuthTool` 测试: 验证伪工具创建
- McpAuthTool.call测试: 验证OAuth流程启动与authUrl返回
- 前缀替换测试: 验证reconnect后真实工具替换伪工具

---

### 4.7.6 工具/资源/命令聚合模块

**真实入口签名**
```typescript
export async function fetchToolsForClient(
  client: Client,
  serverName: string,
  config: ScopedMcpServerConfig,
): Promise<Tool[]>

export async function fetchResourcesForClient(
  client: Client,
  serverName: string,
): Promise<ServerResource[]>

export async function fetchCommandsForClient(
  client: Client,
  serverName: string,
): Promise<Tool[]>

export function buildMcpToolName(serverName: string, toolName: string): string
export function normalizeNameForMCP(name: string): string
export function getMcpPrefix(serverName: string): string
```

**关键类型**
```typescript
export type ServerResource = Resource & { server: string }

export interface SerializedTool {
  name: string;
  description: string;
  inputJSONSchema?: { [x: string]: unknown; type: 'object'; properties?: { [x: string]: unknown }; };
  isMcp?: boolean;
  originalToolName?: string;
}
```

**聚合流程**
```
getMcpToolsCommandsAndResources
  ├─ getAllMcpConfigs() 获取配置
  ├─ 区分disabled → 直接返回DisabledMCPServer
  ├─ 区分needs-auth缓存 → 跳过连接，创建McpAuthTool
  ├─ 分本地/远程pMap并发连接
  │   ├─ 本地: stdio/sdk，3并发
  │   └─ 远程: sse/http/ws/sse-ide/ws-ide/claudeai-proxy，20并发
  ├─ 对每个connected服务器:
  │   ├─ fetchToolsForClient()
  │   │   ├─ client.request({ method: 'tools/list' })
  │   │   ├─ 名称规范化: mcp__<server>__<tool>
  │   │   ├─ 描述截断: 最大2048字符
  │   │   └─ 包装为MCPTool
  │   ├─ fetchResourcesForClient()
  │   │   ├─ client.request({ method: 'resources/list' })
  │   │   └─ 附加server字段
  │   └─ fetchCommandsForClient()
  │       ├─ client.request({ method: 'prompts/list' })
  │       └─ 包装为PromptTool
  ├─ IDE工具过滤: 仅保留mcp__ide__executeCode/mcp__ide__getDiagnostics
  ├─ ListMcpResourcesTool/ReadMcpResourceTool去重: 仅添加一次
  └─ emit tengu_mcp_tools_commands_loaded事件
```

**memoize缓存策略**
```typescript
// connectToServer: memoize，key为serverCacheKey(name, config)
export const connectToServer = memoize(...)

// fetchToolsForClient/fetchResourcesForClient/fetchCommandsForClient: memoizeWithLRU，大小20
// 防止服务器很多时内存无限增长
const fetchToolsForClient = memoizeWithLRU(async (client: Client, serverName: string, config: ScopedMcpServerConfig) => { ... }, 20)

// onclose回调清除缓存
server.onclose = () => {
  // 清除connectToServer memoize缓存
  connectToServer.cache.clear?.(getServerCacheKey(name, config));
  // fetch缓存LRU自动淘汰
};
```

**工具名称规范化规则**
```typescript
export function normalizeNameForMCP(name: string): string {
  // 替换非字母数字为下划线
  // 转小写
  // 去重: 相同名称添加数字后缀
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`;
}

// SDK可选跳过前缀
if (process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX === 'true') {
  // SDK服务器工具使用原始名称，可覆盖内置工具
}
```

**设计取舍**
- LRU 20: 平衡内存使用与常见场景(20个以内服务器)
- 描述截断2048字符: 控制上下文占用，OpenAPI生成服务器常输出长描述
- 名称规范化: 确保工具名称有效且唯一，避免特殊字符问题
- SDK可选无前缀: 支持SDK服务器覆盖内置工具的高级场景

**源码测试证据**
- `fetchToolsForClient` 测试: 验证工具获取与规范化
- `buildMcpToolName` 测试: 验证名称构建
- `normalizeNameForMCP` 测试: 验证名称规范化
- LRU缓存测试: 验证缓存淘汰逻辑

---

### 4.7.7 UI/Elicitation 模块

**关键入口**
```typescript
// useManageMCPConnections.ts
export function useManageMCPConnections(): {
  connections: MCPServerConnection[];
  tools: Tool[];
  resources: Record<string, ServerResource[]>;
  commands: Tool[];
  updateServer: (name: string, connection: MCPServerConnection) => void;
  refreshConnections: () => Promise<void>;
}

// MCPConnectionManager.tsx
export function MCPConnectionManager({ children }: { children: ReactNode }): JSX.Element

// elicitationHandler.ts
export async function runElicitationHooks(
  elicitRequest: ElicitRequest,
  context: ElicitationContext,
): Promise<ElicitResult | undefined>

export async function runElicitationResultHooks(
  elicitResult: ElicitResult,
  context: ElicitationContext,
): Promise<void>
```

**Elicitation流程**
```
callMCPToolWithUrlElicitationRetry
  ├─ 设置toolUseId元数据
  ├─ 调用工具
  ├─ 捕获ElicitRequest
  ├─ runElicitationHooks处理
  │   ├─ OAuth elicitation → 触发认证流程
  │   └─ 其他elicitation → 按hook处理
  ├─ 重试最多MAX_SESSION_RETRIES次
  └─ 返回转换结果
```

**Monitor task事件边界**
```typescript
// MonitorTool 相关
export function createMonitorTool(): Tool

// 监控事件边界
tengu_mcp_server_needs_auth      // 服务器需要认证
tengu_mcp_oauth_flow_start        // OAuth流程开始
tengu_mcp_oauth_flow_success      // OAuth流程成功
tengu_mcp_oauth_flow_error        // OAuth流程失败
tengu_mcp_oauth_refresh_success   // Token刷新成功
tengu_mcp_oauth_refresh_failure   // Token刷新失败
tengu_mcp_claudeai_proxy_401      // Claude.ai代理401
tengu_mcp_tools_commands_loaded   // 工具/资源/命令加载完成
```

**源码测试证据**
- tests/monitorMcpTask.test.ts: 验证监控任务
- tests/monitorMcpToolCall.test.ts: 验证监控工具调用
- useManageMCPConnections测试: 验证连接管理hook

---

### 4.7.8 关闭清理模块

**真实入口签名**
```typescript
export async function closeAllMcpServers(): Promise<void>

// 内部cleanup函数 (stdio escalator)
async function cleanupStdioServer(child: ChildProcess): Promise<void>

// ConnectedMCPServer.cleanup
export type ConnectedMCPServer = {
  ...;
  cleanup: () => Promise<void>;
}
```

**清理策略按传输类型**

| 传输类型 | Cleanup方式 | 超时 | 附加 |
|---------|------------|------|------|
| stdio | SIGINT → 100ms检查 → SIGTERM → 500ms → SIGKILL | 600ms总超时 | stderr输出捕获，最大64MB |
| sse | transport.close() | 立即 | SDK内部重连停止 |
| http | transport.close() | 立即 | 取消所有pending请求 |
| ws | WebSocket.close() | 立即 | 1000正常关闭码 |
| sse-ide | transport.close() | 立即 | |
| ws-ide | WebSocket.close() | 立即 | |
| sdk | 无操作 | N/A | in-process无需清理 |
| claudeai-proxy | transport.close() | 立即 | |
| Chrome内置 | closeOpenChromeClient() | 立即 | 复用连接管理 |
| Computer Use内置 | close in-process server | 立即 | |

**清理顺序设计**
- 无严格顺序: 每个服务器独立清理，避免连锁失败
- 并行清理: Promise.all同时清理所有服务器
- 错误隔离: 单个服务器清理失败不影响其他
- 最佳努力: 清理函数不throw，仅log错误

**onclose回调职责**
```typescript
server.onclose = () => {
  // 1. 清除connectToServer memoize缓存
  connectToServer.cache.clear?.(getServerCacheKey(name, config));
  // 2. fetch缓存LRU自动淘汰，无需手动清除
  // 3. 记录日志
  logMCPDebug(name, 'Connection closed, cache cleared');
};
```

**设计取舍**
- escalator渐进式关闭: 优先优雅关闭，失败才强制
- stderr捕获上限64MB: 防止服务器大量输出耗尽内存
- memoize缓存onclose清除: 确保下次操作重连获取新状态
- 清理不throw: 避免部分清理后流程中断

**源码测试证据**
- `closeAllMcpServers` 测试: 验证全量清理
- stdio escalator测试: 验证信号序列与超时
- onclose缓存清除测试: 验证重连时新状态获取

## 5. 失败语义与工程取舍

### 5.1 连接失败语义

- **超时**: 30秒(可配置MCP_TIMEOUT)，超时后标记为failed
- **认证失败**: 标记为needs-auth，缓存15分钟，提供McpAuthTool
- **网络错误**: 标记为failed，可重连
- **禁用服务器**: 标记为disabled，不尝试连接

### 5.2 工具调用失败语义

- **Session expired**: 检测HTTP 404 + JSON-RPC -32001，清除缓存，可重试一次
- **其他错误**: 包装为TelemetrySafeError，不影响其他工具
- **Abort**: 支持context.signal

### 5.3 重连语义

- **连接断开**: onclose回调清除memoize缓存，下次操作自动重连
- **手动重连**: `reconnectMcpServerImpl` → clearServerCache → connectToServer
- **SDK服务器**: 不需要重连

### 5.4 错误边界

- 单个服务器连接失败: 不影响其他服务器
- 单个工具调用失败: 不影响对话继续
- 配置解析失败: 该服务器跳过，其他继续
- 企业策略阻止: 该服务器过滤，其他继续

### 5.5 性能取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|------|---------|------|------|
| needs-auth缓存 | 15分钟TTL | 用户需等待或手动重连 | 启动快，避免重复失败请求 |
| 批处理并发 | 本地3/远程20 | 需区分服务器类型 | 启动更快，慢服务器不阻塞全局 |
| memoize缓存 | LRU 20 | 内存占用 | 避免重复请求 |
| 工具描述截断 | 2048字符 | 信息丢失 | 控制上下文大小 |
| stderr输出捕获 | 是，64MB上限 | 内存占用 | 调试信息 |

### 5.6 内存管理注意事项

- fetch缓存LRU 20: 防止服务器很多时内存增长
- stderr输出限制64MB: 防止服务器大量输出
- onclose清除缓存: 防止内存泄漏
- 工具列表去重: ListMcpResourcesTool/ReadMcpResourceTool只添加一次

## 6. 现状验收标准

| 验收项 | 设计行为 | 证据位置 |
|--------|---------|---------|
| 多传输类型支持 | 支持stdio/sse/http/ws/sdk/claudeai-proxy | types.ts TransportSchema、client.ts connectToServer |
| 多源配置聚合 | enterprise/local/project/user/plugin/claudeai按优先级聚合 | config.ts getAllMcpConfigs |
| 配置去重 | 基于command/URL签名去重，支持CCR proxy URL解包 | config.ts getMcpServerSignature、dedupPluginMcpServers |
| 连接状态机 | connected/failed/needs-auth/pending/disabled | types.ts MCPServerConnection |
| 批处理连接 | pMap调度，本地3并发，远程20并发 | client.ts getMcpToolsCommandsAndResources |
| needs-auth缓存 | 15分钟TTL，文件缓存 | client.ts getMcpAuthCache、isMcpAuthCached |
| stdio清理 | SIGINT→SIGTERM→SIGKILL escalator | client.ts cleanup函数 |
| 工具名称规范化 | mcp__${server}__${tool}，SDK可选跳过前缀 | normalization.ts buildMcpToolName |
| 能力聚合 | fetchToolsForClient、fetchResourcesForClient、fetchCommandsForClient | client.ts memoizeWithLRU缓存 |
| SDK in-process特殊处理 | type==='sdk'跳过connectToServer，单独处理 | client.ts ensureConnectedClient、connectToServer |
| 企业策略 | allowManagedMcpServersOnly、allowedMcpServers、deniedMcpServers | config.ts isMcpServerAllowedByPolicy |
| 工具调用重试 | McpSessionExpiredError可重试一次 | client.ts call函数中的MAX_SESSION_RETRIES |
| OAuth抢先刷新 | 剩余5分钟自动刷新，跨进程锁 | auth.ts refreshAuthorization |

## 7. 代码与测试证据

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|------|---------|------|
| `src/services/mcp/config.ts` | `getAllMcpConfigs`、`dedupPluginMcpServers`、`addMcpConfig` | 配置加载、聚合、去重、持久化 |
| `src/services/mcp/client.ts` | `connectToServer`、`fetchToolsForClient`、`callMCPTool`、`getMcpToolsCommandsAndResources` | 连接管理、能力获取、工具调用 |
| `src/services/mcp/types.ts` | `MCPServerConnection`、`ConnectedMCPServer`、`ScopedMcpServerConfig` | 核心类型 |
| `src/services/mcp/auth.ts` | `ClaudeAuthProvider`、`performMCPOAuthFlow`、`handleOAuth401Error` | 认证 |
| `src/services/mcp/normalization.ts` | `normalizeNameForMCP`、`buildMcpToolName` | 名称规范化 |
| `src/services/mcp/useManageMCPConnections.ts` | `useManageMCPConnections` | React hook |
| `src/services/mcp/MCPConnectionManager.tsx` | `MCPConnectionManager` | React上下文 |
| `src/tools/MCPTool/MCPTool.ts` | `MCPTool` | 通用MCP工具定义 |
| `src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts` | `ListMcpResourcesTool` | 资源列表工具 |
| `src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts` | `ReadMcpResourceTool` | 资源读取工具 |
| `src/tools/McpAuthTool/McpAuthTool.ts` | `createMcpAuthTool` | 认证工具 |
| `src/tools/MonitorTool/MonitorTool.ts` | `MonitorTool` | 监控工具 |

### 7.2 现有测试场景证明

| 测试文件 | 测试场景 | 证明的不变量 |
|---------|---------|-------------|
| `tests/sdkMcp.test.ts` | SDK in-process服务器注册元数据和调用工具 | createSdkMcpServer、tool装饰器工作正常，_meta(anthropic/searchHint/alwaysLoad)正确传递 |
| `tests/monitorMcpTask.test.ts` | 监控MCP任务 | MonitorTool相关功能 |
| `tests/monitorMcpToolCall.test.ts` | 监控MCP工具调用 | MonitorTool相关功能 |

### 7.3 未覆盖行为(基于代码阅读)

- 完整的重连场景: onclose→缓存清除→下次connectToServer
- OAuth完整流程: discovery→token获取→刷新→401重试
- 企业策略完整测试: allowManagedMcpServersOnly、allowedMcpServers、deniedMcpServers
- stdio清理escalator: SIGINT→SIGTERM→SIGKILL超时序列
- 并发连接多个服务器时的内存使用
- 需要认证服务器15分钟缓存过期后的行为

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/mcp.yaml)

### 8.1 本spec主拥有的文件

所有MCP专用文件:
- `src/services/mcp/*`
- `src/tools/MCPTool/*`
- `src/tools/ListMcpResourcesTool/*`
- `src/tools/ReadMcpResourceTool/*`
- `src/tools/McpAuthTool/*`
- `src/tools/MonitorTool/*`
- `src/utils/mcp/*`
- `src/components/mcp/*`
- `src/commands/mcp/*`
- `src/cli/handlers/mcp.tsx`
- `tests/sdkMcp.test.ts`
- `tests/monitorMcp*.test.ts`

### 8.2 共享但由其他spec主拥有的文件

- `src/utils/plugins/mcpPluginIntegration.ts` → plugins相关
- `src/utils/claudeInChrome/mcpServer.ts` → claudeInChrome相关
- `src/utils/computerUse/mcpServer.ts` → computerUse相关
- `src/entrypoints/mcp.ts` → 入口相关
- `src/skills/mcpSkills.ts` → skills相关

## 9. 改进建议

### P1

#### 9.1.1 认证缓存无效化机制

**触发场景**: 用户在UI中完成认证后，needs-auth状态仍缓存15分钟，需要手动重连或等待。

**证据位置**: `src/services/mcp/client.ts` 的 `isMcpAuthCached`、`clearMcpAuthCache`

**建议方向**: 当用户完成`/mcp auth`或McpAuthTool执行成功后，自动清除该服务器的needs-auth缓存。

**回归风险**: 低，仅影响缓存行为。

**验收方式**: 测试完成认证后立即重连成功。

**工作量**: S

**置信度**: 已证实(基于代码阅读)

#### 9.1.2 needs-auth缓存可观测性

**触发场景**: 用户不知道为什么某个服务器不连接，看不到缓存状态和TTL剩余时间。

**建议方向**: 在`/mcp` UI中显示needs-auth状态的TTL倒计时，或说明"15分钟内不会自动重试"。

**回归风险**: 无，仅UI。

**工作量**: S

**置信度**: 设计推断

### P2

#### 9.2.1 连接状态的更细粒度监控

**触发场景**: 当前只有connected/failed/needs-auth，没有connecting/pending-reconnect状态，用户不知道进度。

**建议方向**: 增加pending状态，在UI中显示连接进度。

**回归风险**: 低，新增状态向后兼容。

**工作量**: M

**置信度**: 设计推断

#### 9.2.2 连接历史和错误原因展示

**触发场景**: 当前错误信息可能不够详细，用户不知道为什么连接失败(网络?认证?配置?)。

**证据位置**: `src/services/mcp/client.ts` 中的 `logMCPError` 但未展示给用户。

**建议方向**: 保存最近连接失败历史和详细错误，在`/mcp` UI中展示。

**回归风险**: 低，仅新增信息展示。

**工作量**: M

**置信度**: 设计推断
