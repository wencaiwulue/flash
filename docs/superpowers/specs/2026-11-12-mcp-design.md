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
