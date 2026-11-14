---
id: test-validation
batch: 7
title: Test Validation 测试运行、Live 验证与证据边界设计
date: 2026-11-12
status: draft
---

# Test Validation 测试运行、Live 验证与证据边界设计

## 1. 问题与约束

项目使用 Bun test 作为测试框架，需要同时支持：
- 快速离线单元/集成测试
- 需要真实凭据的 live 验证
- 构建产物验收测试
- 跨领域功能验证

当前存在以下需要统一设计的问题：
- 测试运行器逐文件隔离的机制与原因
- Live 验证的分类、凭据边界与失败语义
- 如何避免已归其他 spec 的测试重复覆盖
- Smoke 测试在 CI 中的位置与范围
- 失败汇总与报告方式

本设计描述从测试触发到结果输出的完整流程，以及各类验证的边界与决策。

## 2. 设计理由与备选方案

### 逐文件隔离运行测试

`scripts/test.ts` 为每个测试文件单独 spawn 一个 Bun 子进程，而不是一次性运行所有测试。这种设计：
- 避免测试间状态污染（全局变量、环境变量、文件系统）
- 每个测试可以独立配置 feature flags 或环境
- 失败可以精确到文件，便于并行化和重跑
- 与 Bun test 的默认行为一致，但显式控制注入 feature flags

代价是启动开销稍大，但相对于集成测试的隔离需求是可接受的。

**备选方案**：单进程运行所有测试 → 不采用，测试间状态污染风险高。

### Live 验证按领域分离而非统一套件

当前 live 验证分为四个独立脚本：
- `live-cloud-validation.ts`：需要 Claude AI OAuth token、组织 UUID
- `live-desktop-validation.ts`：需要 `CLAUDE_DESKTOP_LIVE=1`、桌面权限
- `live-model-validation.ts`：需要 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`（互斥）
- `live-skillhub-validation.ts`：需要 `CLAUDE_SKILL_REGISTRY_URL`、可选 token

按领域分离可以：
- 每个脚本明确声明自己需要的凭据和环境
- 跳过不满足条件的验证而不失败整个流程
- 独立超时和重试策略
- 不需要统一的大套件配置

**备选方案**：统一 live 验证套件 → 不采用，凭据和环境配置复杂，部分失败易导致整体跳过。

### Live 验证在 CI 中是可选的

Live 验证依赖外部服务、网络和凭据，CI 环境不一定能满足这些条件。因此：
- 本地开发时可以选择性运行
- CI 中通过环境变量控制是否启用
- 离线测试仍然是主要的质量门禁

**备选方案**：CI 强制要求 live 验证 → 不采用，外部依赖不可控，易导致 flaky。

### Smoke 测试单独存在而非集成到主测试

`buildArtifacts.test.ts` 只验证最基本的交付内容（CLI 可执行、SDK 可导入、类型声明存在），不运行完整功能测试。这是为了：
- 在快速构建流程中尽早发现打包问题
- 不依赖测试数据库或外部服务
- 可以在每次提交时运行而不影响速度

**备选方案**：把所有测试都放在 smoke 阶段 → 不采用，失去分层验证的价值。

### 跨领域测试集中验收

跨领域测试（功能配置、公共命令）不归属单个领域 spec，而是在中央位置验收。这样：
- 避免每个 spec 重复验证同一组工具/命令
- 确保整体一致性（例如工具数量、命令可用性）
- 变更影响可以在一个地方看到

**备选方案**：每个 spec 重复覆盖跨领域测试 → 不采用，维护成本高，容易 drift。

## 3. 目标与非目标

### 目标

- 明确测试运行器的隔离机制与 feature 注入
- 分类 live 验证并划定各自的凭据边界
- 定义 CI smoke 测试的范围与位置
- 建立失败汇总与报告方式
- 记录至少 5 个设计决策及其权衡
- 不重复已归其他 spec 的测试覆盖

### 非目标

- 不替换 Bun test 作为测试框架
- 不设计新的断言库或 mocking 框架
- 不强制要求所有功能都有 live 验证
- 不处理测试并行化调度（当前是串行）

## 4. 架构、模块与数据流

测试与验证分为三层：

```
┌─────────────────────────────────────────────────────────┐
│                         Live 验证层                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │ Cloud 验证   │ │ Desktop 验证 │ │ Model/Workflow   │ │
│  │ (OAuth)      │ │ (屏幕权限)   │ │ (API Key)        │ │
│  └──────────────┘ └──────────────┘ └──────────────────┘ │
│  ┌──────────────────┐                                     │
│  │ SkillHub 验证    │                                     │
│  │ (Registry URL)   │                                     │
│  └──────────────────┘                                     │
└─────────────────────────────────────────────────────────┘
                              ↑ 可选
┌─────────────────────────────────────────────────────────┐
│                        跨领域验收层                             │
│  ┌──────────────────┐ ┌──────────────────┐               │
│  │ Enabled Features │ │ Public Commands  │               │
│  │ (离线 bundle)    │ │ (/summary 等)    │               │
│  └──────────────────┘ └──────────────────┘               │
└─────────────────────────────────────────────────────────┘
                              ↑ 必需
┌─────────────────────────────────────────────────────────┐
│                        Smoke 测试层                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │  CLI 可执行、SDK 可导入、类型声明存在              │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                              ↑ 必需
┌─────────────────────────────────────────────────────────┐
│                        测试运行器                              │
│  ┌───────────────────────────────────────────────────┐  │
│  │ scripts/test.ts: 逐文件 spawn，注入 EXTERNAL_FEATURES │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

测试触发流程：
```
开发触发 / CI 触发
      ↓
scripts/test.ts [特定文件]
      ↓
遍历测试文件
      ↓
每个文件 spawn Bun test 子进程
      ↓
(注入 --feature=EXTERNAL_FEATURES...)
      ↓
收集失败文件列表
      ↓
汇总报告，非零退出
```

### 核心模块

- **测试运行器** (`scripts/test.ts`)：逐文件隔离运行测试，注入 feature flags
- **Live 验证脚本** (`scripts/live-*-validation.ts`)：按领域分离的真实服务验证
- **Smoke 测试** (`tests/buildArtifacts.test.ts`)：构建产物基本完整性验证
- **跨领域验收测试** (`tests/enabledFeatures.test.ts`, `tests/publicPromptCommands.test.ts`)：功能配置与公共命令集中验收

---

### 模块设计卡 1：测试发现与请求文件过滤

**真实入口签名**
```typescript
// scripts/test.ts - 无显式函数入口，脚本级执行
const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const testFilePattern = /^tests\/.*\.test\.tsx?$/
const requestedFiles = args.filter(arg => testFilePattern.test(arg))
const options = args.filter(arg => !testFilePattern.test(arg))

async function discoverTestFiles(): Promise<string[]>
```

**关键类型**
```typescript
// 测试文件发现返回类型
string[]  // 排序后的测试文件路径列表，形如 "tests/buildArtifacts.test.ts"

// CLI 参数分拆结果
requestedFiles: string[]  // 匹配 testFilePattern 的参数
options: string[]         // 不匹配的参数（传递给 Bun test）

// 失败收集类型
failures: string[]        // 记录 exitCode !== 0 的文件路径
```

**输入输出**
- 输入：命令行参数 `argv[2..]`，混合特定测试文件与 Bun test 选项
- 输出：
  - 无请求文件时：扫描 `tests/**/*.test.{ts,tsx}` 并排序
  - 有请求文件时：过滤验证后直接使用，跳过发现
  - 零测试文件时：抛出 `Error('No test files found')`

**进程与验证状态**
```
启动
  ↓
参数解析与拆分：requestedFiles vs options
  ↓
┌─────────────────────────────────┐
│  requestedFiles.length > 0?     │
└──────────────┬──────────────────┘
       Yes ↓   ↓ No
使用请求文件  discoverTestFiles()
       │      ├─ Bun.Glob("tests/**/*.test.ts")
       │      ├─ Bun.Glob("tests/**/*.test.tsx")
       │      ├─ Set 去重
       │      └─ sort()
       │      ↓
       └──────┴→ testFiles 赋值
              ↓
      testFiles.length === 0?
         Yes ↓   ↓ No
      抛错误     进入逐文件执行
```

**发现/执行/汇总流程**
1. **发现阶段**：
   - 通过 `Bun.Glob` 扫描两种扩展名
   - 使用 `Set<string>` 去重
   - 排序输出确保稳定顺序
2. **请求文件过滤阶段**：
   - 正则 `/^tests\/.*\.test\.tsx?$/` 强制前缀与后缀
   - 只接受 `tests/` 目录下的 `.test.ts` 或 `.test.tsx` 文件
   - 不匹配的参数作为 `options` 透传
3. **执行阶段**：逐文件 spawn（见模块设计卡 2）
4. **汇总阶段**：失败文件列表打印 + `process.exit(1)`

**错误与凭据**
- 无测试文件：同步 throw，退出码由 Bun 处理
- 发现阶段不涉及凭据
- 选项透传不验证，由 Bun test 子进程处理

**设计取舍/备选**
- **取舍 1：严格前缀过滤 vs 接受任意路径**
  - 选择：严格 `/^tests\//` 前缀
  - 理由：避免意外执行源码或 fixtures 目录下的非测试文件
  - 备选：接受相对/绝对路径后 canonicalize 验证在 tests 下
- **取舍 2：Set 去重 vs 直接扫描结果**
  - 选择：Set 去重
  - 理由：ts/tsx 两个 glob 可能重叠（理论上不会，实际防御性）
- **取舍 3：排序 vs 原生扫描顺序**
  - 选择：排序输出
  - 理由：稳定的执行顺序便于调试与比较
  - 备选：使用 inode 或 mtime 排序（不采用，不可重复）

**源码测试证据**
- `scripts/test.ts:4-26`：参数解析、发现、无测试文件错误
- `scripts/test.ts:6-8`：`testFilePattern` 正则与参数拆分
- `scripts/test.ts:10-19`：`discoverTestFiles` 双 glob + Set + sort

---

### 模块设计卡 2：Bun test 逐文件 spawn 与 EXTERNAL_FEATURES 注入

**真实入口签名**
```typescript
// scripts/test.ts
const featureArgs = EXTERNAL_FEATURES.flatMap(feature => [
  `--feature=${feature}`,
])
const failures: string[] = []
for (const file of testFiles) {
  const child = Bun.spawn({
    cmd: [process.execPath, ...featureArgs, 'test', ...options, file],
    cwd: root,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  })
  const exitCode = await child.exited
  if (exitCode !== 0) failures.push(file)
}
```

**关键类型**
```typescript
// EXTERNAL_FEATURES 来自 externalFeatureProfile.ts
const EXTERNAL_FEATURES = [
  'AGENT_MEMORY_SNAPSHOT', 'AGENT_TRIGGERS', 'AGENT_TRIGGERS_REMOTE',
  'VOICE_MODE', 'BRIDGE_MODE', 'ULTRAPLAN', 'FILE_PERSISTENCE',
  'KAIROS_BRIEF', 'MONITOR_TOOL', 'TEMPLATES', 'OPEN_RUNNER',
  'OVERFLOW_TEST_TOOL', 'TERMINAL_PANEL', 'PROACTIVE',
  'COORDINATOR_MODE', 'EXPERIMENTAL_SKILL_SEARCH', 'UDS_INBOX',
  'DAEMON', 'WORKFLOW_SCRIPTS', 'CONTEXT_COLLAPSE', 'DIRECT_CONNECT',
  'BG_SESSIONS', 'REACTIVE_COMPACT', 'SSH_REMOTE', 'BUDDY',
  'FORK_SUBAGENT', 'HISTORY_SNIP', 'REVIEW_ARTIFACT', 'KAIROS',
  'KAIROS_GITHUB_WEBHOOKS', 'CHICAGO_MCP', 'COMMIT_ATTRIBUTION',
  'BASH_CLASSIFIER', 'WEB_BROWSER_TOOL',
] as const

// spawn 配置
interface BunSpawnOptions {
  cmd: string[]
  cwd: string
  stdin: 'inherit'
  stdout: 'inherit'
  stderr: 'inherit'
  env: NodeJS.ProcessEnv
}

// child.exited 返回
Promise<number>  // 子进程退出码
```

**输入输出**
- 输入：`testFiles[]` + `options[]` + `EXTERNAL_FEATURES[]`
- 输出：
  - stdio 全部 inherit：终端直接看到每个文件的测试输出
  - `failures[]` 收集退出码非零的文件
  - 最终：失败文件列表打印到 stderr，`process.exit(1)` 或无输出退出 0

**进程与验证状态**
```
进入循环：for (const file of testFiles)
  ↓
构造 cmd：
  [0] process.execPath (bun)
  [1..N] --feature=FEATURE1, --feature=FEATURE2, ...
  [N+1] 'test'
  [N+2..] ...options
  [last] file
  ↓
Bun.spawn({
  cwd: root,
  stdio: 'inherit' (无缓冲/无捕获),
  env: process.env (完整透传),
})
  ↓
await child.exited
  ↓
exitCode !== 0?
  Yes → failures.push(file)
  No → 继续下一个
  ↓
循环结束
  ↓
failures.length > 0?
  Yes → console.error 列表 → process.exit(1)
  No → 隐式 process.exit(0)
```

**发现/执行/汇总流程**
1. **Feature 注入阶段**：
   - `flatMap` 将每个 feature 展开为 `--feature=NAME`
   - 注入位置：bun 之后、'test' 子命令之前
   - 顺序：feature flags → 用户选项 → 测试文件
2. **逐文件 spawn 阶段**：
   - 串行执行，一个文件一个子进程
   - stdio 全 inherit，无捕获、无缓冲、无重排
   - 环境变量完整透传，无隔离
3. **失败收集阶段**：仅记录退出码，不拦截输出
4. **汇总阶段**：
   - 仅在全部执行完后打印一次失败列表
   - 不重试失败文件
   - 非零退出当且仅当 `failures.length > 0`

**错误与凭据**
- 子进程崩溃/信号终止：`exitCode` 非零，计入失败
- 环境变量透传：包含所有凭据（ANTHROPIC_API_KEY、OAUTH tokens 等）
- 无凭据过滤：由测试文件自行决定是否需要/使用
- 无超时：由 Bun test 或测试内部处理

**设计取舍/备选**
- **取舍 1：逐文件隔离 vs 单进程批量**
  - 选择：逐文件 spawn
  - 理由：避免测试间状态污染（全局变量、环境变量、文件系统、模块级 mock）；精确失败定位；独立配置
  - 代价：启动开销稍大
  - 备选：`bun test tests/**` 单进程（不采用）
- **取舍 2：串行 vs 并行**
  - 选择：串行
  - 理由：避免资源竞争（临时目录、端口、进程间信号）；输出不乱序；当前测试量可接受
  - 备选：`p-map` + concurrency（见第9章改进建议）
- **取舍 3：stdio inherit vs 捕获汇总**
  - 选择：inherit
  - 理由：实时输出，无延迟；彩色保持；无内存压力
  - 备选：捕获 stdout/stderr 并在失败时重打（不采用）
- **取舍 4：feature 注入位置**
  - 选择：bun 后、test 前
  - 理由：Bun 的 `--feature` 是 runtime flag，不是 `test` 子命令 flag
  - 备选：不可行，位置错误会被忽略

**源码测试证据**
- `scripts/test.ts:28-49`：featureArgs 构造、spawn 循环、失败汇总
- `scripts/externalFeatureProfile.ts:5-40`：EXTERNAL_FEATURES 常量列表
- `package.json:24`：`"test": "bun scripts/test.ts"` 入口

---

### 模块设计卡 3：Live Cloud 验证（OAuth Token + Org UUID）

**真实入口签名**
```typescript
// scripts/live-cloud-validation.ts
const cwd = await mkdtemp(join('/tmp', 'flash-cloud-live-'))
const token = getClaudeAIOAuthTokens()?.accessToken
if (!token) {
  console.log('CLOUD_LIVE_SKIPPED')
} else {
  const orgUUID = process.env.CLAUDE_CODE_ORG_UUID ?? (await getOrganizationUUID())
  if (!orgUUID) throw new Error('Organization UUID is required')
  const baseUrl = process.env.CLAUDE_CODE_BASE_URL ?? getOauthConfig().BASE_API_URL
  // ... 验证逻辑
}
```

**关键类型**
```typescript
// 核心验证函数
function params(sessionCwd: string): {
  baseUrl: string
  orgUUID: string
  title: string
  getAccessToken: () => string
  toSDKMessages: typeof toSDKMessages
  initialHistoryCap: number
  perpetual: boolean
  cwd: string
}
async function initEnvLessBridgeCore(params): Promise<BridgeSession | null>
interface BridgeSession {
  bridgeSessionId: string
  writeSdkMessages(messages): void
  teardown(): Promise<void>
  archive(): Promise<void>
}

// 凭据类型
interface ClaudeAIOAuthTokens {
  accessToken: string
  refreshToken?: string
  // ...
}
```

**输入输出**
- 输入：
  - 环境：`getClaudeAIOAuthTokens()` 读取的 OAuth token
  - 覆盖：`CLAUDE_CODE_ORG_UUID`、`CLAUDE_CODE_BASE_URL`
- 输出：
  - 无 token：`console.log('CLOUD_LIVE_SKIPPED')`，退出 0
  - 有 token + 验证成功：`console.log('CLOUD_LIVE_OK')`，退出 0
  - 有 token + 验证失败：throw Error，非零退出

**进程与验证状态**
```
启动
  ↓
mkdtemp(/tmp/flash-cloud-live-*)
  ↓
token = getClaudeAIOAuthTokens()?.accessToken
  ↓
token 存在?
  No → CLOUD_LIVE_SKIPPED → cleanup → exit 0
  Yes → 继续
  ↓
orgUUID = CLAUDE_CODE_ORG_UUID ?? await getOrganizationUUID()
  ↓
orgUUID 存在?
  No → throw → cleanup → exit 非零
  Yes → 继续
  ↓
baseUrl = CLAUDE_CODE_BASE_URL ?? getOauthConfig().BASE_API_URL
  ↓
enableConfigs()
  ↓
first = await initEnvLessBridgeCore(params(cwd))
  ↓
first 非空?
  No → throw
  Yes → writeSdkMessage + teardown
  ↓
second = await initEnvLessBridgeCore(params(cwd))
  ↓
second.bridgeSessionId === first.bridgeSessionId?
  No → throw
  Yes → 设置环境变量 + write file + runFilePersistence
  ↓
persisted.files.length > 0?
  No → throw
  Yes → archive + CLOUD_LIVE_OK
  ↓
finally: runCleanupFunctions() + rm(cwd, recursive)
```

**发现/执行/汇总/live 流程**
1. **凭据检查阶段**：
   - 跳过与失败分离：无 token → SKIPPED（exit 0），有 token 但验证失败 → ERROR（exit 非零）
   - Org UUID 优先级：环境变量 > 从 token 获取
2. **创建阶段**：`initEnvLessBridgeCore` 创建 perpetual session
3. **恢复阶段**：再次 init 验证 resume 相同 sessionId
4. **持久化阶段**：写文件、触发 Cloud Files 验证
5. **清理阶段**：always cleanup，即使验证失败
6. **汇总阶段**：仅打印单一状态行，无结构化报告

**错误与凭据**
- **凭据边界**：
  - 需要：Claude AI OAuth access token
  - 可选：`CLAUDE_CODE_ORG_UUID`、`CLAUDE_CODE_BASE_URL`
  - 不需要：`ANTHROPIC_API_KEY`、desktop 权限
- **凭据互斥**：无（仅需要 OAuth token，不与其他 live 验证互斥）
- **错误语义**：
  - 无 token → SKIPPED（不是失败）
  - 有 token 但任意步骤失败 → ERROR（是失败）
  - 网络错误 → ERROR
  - 清理失败 → 不影响 exit code（仅 rm 静默失败）

**设计取舍/备选**
- **取舍 1：SKIPPED vs ERROR 语义**
  - 选择：无 token → SKIPPED（exit 0）
  - 理由：CI 环境不一定配置 OAuth，不应因此失败
  - 备选：一律 ERROR（不采用）
- **取舍 2：perpetual session 验证**
  - 选择：验证创建 + resume + sessionId 不变
  - 理由：覆盖核心 cloud 场景
  - 备选：仅 ping（不采用）
- **取舍 3：mkdtemp + 强制清理**
  - 选择：`rm -rf` 在 finally 中
  - 理由：避免 /tmp 垃圾累积
  - 备选：不清理（不采用）

**源码测试证据**
- `scripts/live-cloud-validation.ts:13-63`：完整流程
- `scripts/live-cloud-validation.ts:15-17`：SKIPPED 分支
- `scripts/live-cloud-validation.ts:18-58`：验证分支

---

### 模块设计卡 4：Live Desktop 验证（屏幕权限）

**真实入口签名**
```typescript
// scripts/live-desktop-validation.ts
if (process.env.CLAUDE_DESKTOP_LIVE !== '1') {
  console.log('DESKTOP_LIVE_SKIPPED')
} else {
  try {
    const client = await getOpenComputerUseClient()
    const result = await client.callTool({ name: 'screenshot', arguments: {} })
    if (result.isError) throw new Error('Desktop screenshot failed')
    console.log('DESKTOP_LIVE_OK')
  } finally {
    await closeOpenComputerUseClient()
  }
}
```

**关键类型**
```typescript
// 来自 external-stubs/computer-use-mcp
async function getOpenComputerUseClient(): Promise<McpClient>
async function closeOpenComputerUseClient(): Promise<void>
interface McpClient {
  callTool(params: { name: string; arguments: object }): Promise<CallToolResult>
}
interface CallToolResult {
  isError: boolean
  content?: Array<{ type: string; text?: string; data?: string }>
}

// 环境开关
CLAUDE_DESKTOP_LIVE=1  // 启用标记，非值也接受
```

**输入输出**
- 输入：仅 `CLAUDE_DESKTOP_LIVE` 环境变量
- 输出：
  - `CLAUDE_DESKTOP_LIVE !== '1'` → `DESKTOP_LIVE_SKIPPED`，exit 0
  - 启用且成功 → `DESKTOP_LIVE_OK`，exit 0
  - 启用但失败 → throw，exit 非零

**进程与验证状态**
```
启动
  ↓
CLAUDE_DESKTOP_LIVE === '1'?
  No → DESKTOP_LIVE_SKIPPED → exit 0
  Yes → try 块
  ↓
client = await getOpenComputerUseClient()
  ↓
result = await client.callTool('screenshot', {})
  ↓
result.isError?
  Yes → throw
  No → DESKTOP_LIVE_OK
  ↓
finally: await closeOpenComputerUseClient()
```

**发现/执行/汇总/live 流程**
1. **开关检查阶段**：仅精确匹配 `'1'`（不是 truthy）
2. **客户端初始化阶段**：`getOpenComputerUseClient` 建立 MCP 连接
3. **屏幕截图阶段**：调用 screenshot tool，无参数
4. **客户端关闭阶段**：always close，即使失败
5. **汇总阶段**：单一状态行

**错误与凭据**
- **凭据边界**：
  - 需要：`CLAUDE_DESKTOP_LIVE=1` + 桌面屏幕权限 + 本地 MCP 服务可用
  - 不需要：API key、OAuth token
- **凭据互斥**：无
- **错误语义**：无权限/连接失败/截图失败 → ERROR

**设计取舍/备选**
- **取舍 1：精确 '1' vs truthy**
  - 选择：`=== '1'`
  - 理由：避免意外启用
  - 备选：`if (process.env.CLAUDE_DESKTOP_LIVE)`（不采用）
- **取舍 2：仅 screenshot vs 更多工具**
  - 选择：仅 screenshot
  - 理由：最基本桌面能力验证
  - 备选：鼠标移动、键盘输入（不采用，副作用大）

**源码测试证据**
- `scripts/live-desktop-validation.ts:6-17`：完整流程

---

### 模块设计卡 5：Live Model/Workflow/Proactive/Context Collapse 验证（API Key 与 Auth Token 互斥）

**真实入口签名**
```typescript
// scripts/live-model-validation.ts
async function main() {
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error('ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are mutually exclusive')
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log('MODEL_LIVE_SKIPPED')
    return
  }
  enableConfigs()
  const model = getMainLoopModel()
  // ... workflow / proactive / context collapse / reactive compaction 验证
}
```

**关键类型**
```typescript
// 凭据互斥检查
if (ANTHROPIC_API_KEY && ANTHROPIC_AUTH_TOKEN) → throw

// 验证上下文
function context(model: string): {
  options: {
    mainLoopModel: string
    tools: []
    agentDefinitions: { activeAgents: []; allAgents: [] }
    mcpClients: []
    commands: []
    debug: boolean
    verbose: boolean
    isNonInteractiveSession: boolean
  }
  readFileState: FileStateCache
  getAppState(): AppState
  setAppState(update): AppState
  abortController: AbortController
}

// 工作流
const workflow = parseWorkflowDefinition({
  name: 'live-flow',
  description: 'live model validation',
  steps: [{ id: 'respond', prompt: 'Return only WORKFLOW_LIVE_OK' }],
})
const { done } = startWorkflowTask({ workflow, input: '', context, canUseTool })
```

**输入输出**
- 输入：
  - 互斥凭据二选一：`ANTHROPIC_API_KEY` **或** `ANTHROPIC_AUTH_TOKEN`
  - 两者都有 → throw
  - 两者都无 → `MODEL_LIVE_SKIPPED`
- 输出：
  - 跳过：`MODEL_LIVE_SKIPPED`
  - 成功：`WORKFLOW_LIVE_OK`、`PROACTIVE_LIVE_OK`、`CONTEXT_COLLAPSE_LIVE_OK`、`REACTIVE_COMPACTION_LIVE_OK`
  - 失败：throw

**进程与验证状态**
```
启动
  ↓
ANTHROPIC_API_KEY && ANTHROPIC_AUTH_TOKEN?
  Yes → throw "mutually exclusive"
  No → 继续
  ↓
!ANTHROPIC_API_KEY && !ANTHROPIC_AUTH_TOKEN?
  Yes → MODEL_LIVE_SKIPPED → return
  No → 继续
  ↓
enableConfigs()
model = getMainLoopModel()
toolContext = context(model)
  ↓
workflow = parseWorkflowDefinition(...)
{ done } = startWorkflowTask(...)
workflowResult = await done
  ↓
workflowResult.status === 'completed'?
  No → throw
  Yes → WORKFLOW_LIVE_OK
  ↓
activateProactive('command')
SleepTool.isEnabled()?
  No → throw
  Yes → slept = await SleepTool.call({ duration: 10 })
  ↓
slept.data.interrupted?
  Yes → throw
  No → PROACTIVE_LIVE_OK
  ↓
initContextCollapse({ contextWindow: () => 100 })
collapsed = await applyCollapsesIfNeeded(6 messages)
  ↓
collapsedSpans === 1 && messages.length === 5?
  No → throw
  Yes → CONTEXT_COLLAPSE_LIVE_OK
  ↓
reactive = await reactiveCompactOnPromptTooLong(...)
  ↓
reactive.ok?
  No → throw
  Yes → REACTIVE_COMPACTION_LIVE_OK
  ↓
finally: runCleanupFunctions()
```

**发现/执行/汇总/live 流程**
1. **互斥检查阶段**：同时存在两个凭据 → 立即失败（早）
2. **存在性检查阶段**：都不存在 → SKIPPED
3. **Workflow 验证阶段**：运行简单工作流，检查模型调用正常
4. **Proactive 验证阶段**：激活 proactive，验证 Sleep tool 启用且可调用
5. **Context Collapse 验证阶段**：注入长消息，验证真实发生压缩
6. **Reactive Compaction 验证阶段**：验证响应式压缩路径
7. **汇总阶段**：多行 OK 输出，每行对应一个子系统

**错误与凭据**
- **凭据边界**：
  - 互斥二选一：`ANTHROPIC_API_KEY` **或** `ANTHROPIC_AUTH_TOKEN`
  - 不可同时存在
- **凭据互斥**：显式 throw `"mutually exclusive"`
- **错误语义**：
  - 互斥 → ERROR
  - 都无 → SKIPPED
  - 有任一但验证失败 → ERROR
  - 任意子验证失败 → ERROR（不继续后续）

**设计取舍/备选**
- **取舍 1：显式互斥检查 vs 留给底层**
  - 选择：显式检查并 throw
  - 理由：清晰，早失败
  - 备选：让 getMainLoopModel / SDK 处理（不采用）
- **取舍 2：串行子验证 vs 并行**
  - 选择：串行，前一个失败不继续
  - 理由：依赖关系（proactive 可能依赖 model）；减少不必要的 API 调用
- **取舍 3：多行输出 vs 单一 OK**
  - 选择：每行一个子系统
  - 理由：便于定位哪个子验证失败

**源码测试证据**
- `scripts/live-model-validation.ts:40-47`：互斥与存在性检查
- `scripts/live-model-validation.ts:56-85`：四个子验证

---

### 模块设计卡 6：Live SkillHub 验证（Registry URL + Token）

**真实入口签名**
```typescript
// scripts/live-skillhub-validation.ts
const baseUrl = process.env.CLAUDE_SKILL_REGISTRY_URL || 'https://skill.xfyun.cn'
const cacheDir = await mkdtemp(join('/tmp', 'flash-skillhub-live-'))
const client = new SkillHubClient({
  baseUrl,
  token: process.env.CLAUDE_SKILL_REGISTRY_TOKEN,
})

try {
  const matches = await client.search('code', { limit: 1 })
  // ... 验证
} finally {
  await rm(cacheDir, { recursive: true, force: true })
}
```

**关键类型**
```typescript
// SkillHubClient
class SkillHubClient {
  constructor({ baseUrl, token }: { baseUrl: string; token?: string })
  async search(query: string, options?: { limit: number }): Promise<SkillMatch[]>
}
interface SkillMatch {
  namespace: string
  slug: string
  // ...
}

// 远程加载
async function loadRemoteSkill(
  slug: string,
  url: string,
  options: { cacheDir: string }
): Promise<{ content: string; cacheHit: boolean }>
```

**输入输出**
- 输入：
  - `CLAUDE_SKILL_REGISTRY_URL`（默认 `https://skill.xfyun.cn`）
  - `CLAUDE_SKILL_REGISTRY_TOKEN`（可选）
- 输出：
  - 成功：`SKILLHUB_LIVE_OK`
  - 失败：throw（无 SKIPPED 状态，总是尝试）

**进程与验证状态**
```
启动
  ↓
baseUrl = env || default
cacheDir = mkdtemp(/tmp/flash-skillhub-live-*)
client = new SkillHubClient({ baseUrl, token })
  ↓
matches = await client.search('code', { limit: 1 })
  ↓
matches[0] 存在?
  No → throw "returned no skills"
  Yes → slug = namespace/slug; url = baseUrl + api path
  ↓
loaded = await loadRemoteSkill(slug, url, { cacheDir })
  ↓
loaded.content includes 'name' or '#'?
  No → throw "empty or malformed"
  Yes → cached = await loadRemoteSkill(...) again
  ↓
cached.cacheHit?
  No → throw "cache did not hit"
  Yes → SKILLHUB_LIVE_OK
  ↓
finally: rm cacheDir
```

**发现/执行/汇总/live 流程**
1. **初始化阶段**：mkdtemp、构造 client
2. **搜索阶段**：查询 `'code'`，取第一个结果
3. **下载阶段**：加载 skill 内容，验证非空/合理
4. **缓存阶段**：再次加载，验证 cache hit
5. **清理阶段**：删除缓存目录
6. **汇总阶段**：单一 OK 行

**错误与凭据**
- **凭据边界**：
  - 可选：`CLAUDE_SKILL_REGISTRY_TOKEN`
  - 总是尝试：即使无 token 也尝试公共搜索
  - 无 SKIPPED 分支
- **凭据互斥**：无
- **错误语义**：网络错误、无结果、内容无效、缓存未命中 → ERROR

**设计取舍/备选**
- **取舍 1：无 SKIPPED vs 条件跳过**
  - 选择：总是尝试，无 token 也用默认 URL
  - 理由：SkillHub 可能允许匿名访问
  - 备选：检查 `CLAUDE_SKILL_REGISTRY_URL` 才启用（不采用）
- **取舍 2：缓存验证**
  - 选择：验证 cache hit
  - 理由：覆盖缓存路径
  - 备选：仅搜索（不采用）

**源码测试证据**
- `scripts/live-skillhub-validation.ts:6-28`：完整流程

---

### 模块设计卡 7：CI Smoke 测试（Typecheck + Build + Version + Help + SDK Import）

**真实入口签名**
```typescript
// tests/buildArtifacts.test.ts
test('packages an executable CLI, importable SDK, and matching declarations', async () => {
  const main = Bun.file(join(root, 'dist/main.js'))
  const sdkFile = Bun.file(join(root, 'dist/sdk.mjs'))
  const declarations = Bun.file(join(root, 'dist/types/entrypoints/agentSdkTypes.d.ts'))
  // ...
  const smoke = Bun.spawnSync({
    cmd: [
      process.execPath,
      '-e',
      "const sdk=await import('./dist/sdk.mjs'); if(typeof sdk.query!=='function'||typeof sdk.createSdkMcpServer!=='function') throw new Error('Invalid SDK exports')",
    ],
    // ...
  })
  // ...
})
```

**关键类型**
```typescript
// 测试覆盖的产物
dist/main.js           // CLI 可执行文件
dist/sdk.mjs           // SDK ESM 入口
dist/types/entrypoints/agentSdkTypes.d.ts  // 类型声明

// 验证项
- main.js exists
- main.js starts with #!/usr/bin/env bun (shebang)
- main.js executable (mode & 0o111)
- sdk.mjs exists
- declarations exists
- SDK dynamic import succeeds
- SDK exports: query, createSdkMcpServer
- package.json exports mapping correct
```

**输入输出**
- 输入：已构建的 `dist/` 目录（测试不负责构建）
- 输出：Bun test pass/fail

**进程与验证状态**
```
test 开始
  ↓
Bun.file(dist/main.js).exists()? → expect true
  ↓
main.text() startsWith('#!/usr/bin/env bun')? → expect true
  ↓
(main.stat().mode & 0o111) !== 0? → expect true
  ↓
Bun.file(dist/sdk.mjs).exists()? → expect true
  ↓
Bun.file(declarations).exists()? → expect true
  ↓
smoke = Bun.spawnSync({
  cmd: [bun, '-e', "import('./dist/sdk.mjs') verify exports"],
})
  ↓
smoke.stderr === ''? → expect true
smoke.exitCode === 0? → expect true
  ↓
packageJson.exports['.'].import === './dist/sdk.mjs'? → expect true
packageJson.exports['.'].types === declarations path? → expect true
  ↓
test 通过
```

**发现/执行/汇总/live 流程**
1. **文件存在性阶段**：三个关键文件必须存在
2. **可执行性阶段**：shebang + mode 位验证
3. **SDK 可导入阶段**：动态 import + 导出项验证
4. **package.json 配置阶段**：exports 字段指向正确路径
5. **汇总阶段**：Bun test 单个 test 通过/失败

**错误与凭据**
- **离线/mock/live 边界**：
  - 完全离线：无网络请求
  - 无 mock：真实文件系统读取
  - 无凭据：不需要任何 key/token
- **错误语义**：任一 expect 失败 → test 失败

**设计取舍/备选**
- **取舍 1：测试不负责构建 vs 自动构建**
  - 选择：测试假设 dist/ 已存在
  - 理由：分离构建与测试；CI 中先 build 再 test
  - 备选：test 前调用 `bun build`（不采用）
- **取舍 2：动态 import SDK vs 静态 import**
  - 选择：`Bun.spawnSync` + `import()` 在子进程
  - 理由：测试与被测产物隔离；验证真正的 dist 输出，不是源码
  - 备选：`import '../dist/sdk.mjs'`（不采用）

**源码测试证据**
- `tests/buildArtifacts.test.ts:6-32`：完整 smoke 测试
- `package.json:23-24`：`"typecheck": "tsc --noEmit"`, `"test": "bun scripts/test.ts"`

---

### 模块设计卡 8：跨领域验收（Enabled Features + Public Commands）

**真实入口签名**
```typescript
// tests/enabledFeatures.test.ts
async function runFeatureProfile(overrides: NodeJS.ProcessEnv = {}): Promise<{
  toolCount: number
  nullCount: number
  toolNames: string[]
  sleepInitiallyEnabled: boolean
  proactiveActive: boolean
  sleepWhenActive: boolean
  workerType: string
  workerBackground: boolean
  workerHasBash: boolean
  workerHasAgent: boolean
  reactiveCompactEnabled: boolean
  hasHunterSkill: boolean
  hasProactiveCommand: boolean
  hasPeersCommand: boolean
  hasRemoteControlServerCommand: boolean
  hasWorkflowsCommand: boolean
  hasBuddyCommand: boolean
  hasForkCommand: boolean
  hasForceSnipCommand: boolean
  hasAssistantCommand: boolean
  hasUltraplan: boolean
  hasVoice: boolean
  hasBrief: boolean
  commandNames: string[]
}>

// tests/publicPromptCommands.test.ts
describe('/summary', () => { /* ... */ })
describe('/autofix-pr', () => { /* ... */ })
```

**关键类型**
```typescript
// feature profile fixture 输出格式
interface FeatureProfile {
  toolCount: number                    // 期望 43
  nullCount: number                    // 期望 0
  toolNames: string[]
  sleepInitiallyEnabled: boolean
  proactiveActive: boolean
  sleepWhenActive: boolean
  workerType: 'worker' | 'inline'
  workerBackground: boolean
  workerHasBash: boolean
  workerHasAgent: boolean
  reactiveCompactEnabled: boolean
  hasHunterSkill: boolean
  hasProactiveCommand: boolean
  hasPeersCommand: boolean
  hasRemoteControlServerCommand: boolean
  hasWorkflowsCommand: boolean
  hasBuddyCommand: boolean
  hasForkCommand: boolean
  hasForceSnipCommand: boolean
  hasAssistantCommand: boolean
  hasUltraplan: boolean
  hasVoice: boolean
  hasBrief: boolean
  commandNames: string[]
}

// 命令测试覆盖
/summary: getPromptForCommand, buildSummaryPrompt
/autofix-pr: parseAutofixPRReference, buildAutofixPRPrompt, allowedTools
```

**输入输出**
- 输入（enabledFeatures）：
  - `tests/fixtures/verify-enabled-features.ts`（实际构建 profile）
  - 可选 `overrides` 环境变量
- 输出（enabledFeatures）：
  - `FEATURE_PROFILE=...` JSON 行
  - 期望：43 tools、无 null、特定工具/命令存在/不存在
- 输入（publicPromptCommands）：无，仅代码导入
- 输出（publicPromptCommands）：Bun test pass/fail

**进程与验证状态**
```
enabledFeatures test 开始
  ↓
runFeatureProfile() → spawn verify-enabled-features.ts
  ↓
stdout 中查找 FEATURE_PROFILE= 行
  ↓
JSON.parse → profile
  ↓
toolCount === 43?
nullCount === 0?
toolNames includes [CronCreate, ..., WebBrowser, ...]?
sleepInitiallyEnabled === false?
proactiveActive === true?
... 约 25 个 expects ...
commandNames not includes ['commit', 'commit-push-pr', 'agents-platform']?
  ↓
test 1 通过
  ↓
runFeatureProfile() 与 runFeatureProfile({ANTHROPIC_BASE_URL: ...})
  ↓
overridden profile === normal profile? → test 2 通过
  ↓
publicPromptCommands test 开始
  ↓
/summary:
  - expands optional focus
  - handles no focus + empty conversation
  ↓
/autofix-pr:
  - accepts numbers/#/URLs, rejects others
  - requests both comment APIs, forbids publish
  - uses current branch PR when no reference
  ↓
全部通过
```

**发现/执行/汇总/live 流程**
1. **Fixture 执行阶段**：spawn `verify-enabled-features.ts` 构建真实 profile
2. **Profile 验收阶段**：约 25 个断言验证工具/命令/标志的启用状态
3. **环境不变性阶段**：验证不同外层环境不影响 profile
4. **公共命令单元测试阶段**：直接测试 `/summary` 与 `/autofix-pr` 逻辑
5. **汇总阶段**：Bun test describe/test 层级输出

**错误与凭据**
- **离线/mock/live 边界**：
  - 完全离线：无网络
  - 注入占位凭据：`ANTHROPIC_API_KEY: 'offline-test-placeholder'`（不真实使用）
- **错误语义**：任一 expect 失败 → test 失败
- **超时**：`180_000ms`、`240_000ms` 长超时（fixture 构建慢）

**设计取舍/备选**
- **取舍 1：集中验收 vs 各 spec 重复**
  - 选择：集中在 `enabledFeatures.test.ts`
  - 理由：避免重复；统一验证；变更影响一目了然
  - 备选：每个 spec 自己验证相关工具（不采用）
- **取舍 2：spawn fixture vs 直接导入**
  - 选择：spawn 子进程
  - 理由：隔离环境；更接近真实构建
  - 备选：`import` fixture（不采用）
- **取舍 3：显式排除列表**
  - 选择：`commandNames not includes ['commit', ...]`
  - 理由：验证外部构建不包含内部命令

**源码测试证据**
- `tests/enabledFeatures.test.ts:13-104`：`runFeatureProfile` + 两个 test
- `tests/publicPromptCommands.test.ts:17-76`：`/summary` 与 `/autofix-pr` 测试

---

### 模块设计卡 9：失败汇总与离线/mock/live 边界

**真实入口签名**
```typescript
// scripts/test.ts
if (failures.length > 0) {
  console.error(`\nFailed test files (${failures.length}):\n${failures.join('\n')}`)
  process.exit(1)
}

// Live 验证统一模式
if (!credential) {
  console.log('*_LIVE_SKIPPED')  // exit 0
} else {
  try {
    // verify
    console.log('*_LIVE_OK')
  } catch {
    // throw, exit non-zero
  }
}
```

**关键类型**
```typescript
// 失败汇总数据结构
failures: string[]  // 仅记录文件路径，不包含堆栈/输出

// Live 状态输出
*_LIVE_SKIPPED  // 条件不满足，exit 0
*_LIVE_OK       // 验证成功，exit 0
throw Error     // 验证失败，exit 非零

// 边界分层
┌─────────────────────────────────────────┐
│ 离线层（无网络）                        │
│  - unit tests                          │
│  - buildArtifacts.test.ts              │
│  - enabledFeatures.test.ts             │
│  - publicPromptCommands.test.ts        │
├─────────────────────────────────────────┤
│ Mock 层（可选）                         │
│  - 各 test 内的 mock（非本文范围）     │
├─────────────────────────────────────────┤
│ Live 层（真实网络/凭据）                │
│  - live-cloud-validation.ts            │
│  - live-desktop-validation.ts          │
│  - live-model-validation.ts            │
│  - live-skillhub-validation.ts         │
└─────────────────────────────────────────┘
```

**输入输出**
- 输入（汇总）：`failures[]`
- 输出（汇总）：
  - 空：无输出，exit 0
  - 非空：stderr 打印失败文件列表，exit 1
- 输入（边界）：凭据可用性
- 输出（边界）：SKIPPED / OK / ERROR

**进程与验证状态**
```
测试运行器汇总：
  所有子进程结束后
    ↓
  failures.length > 0?
    Yes → console.error 标题 + 每个文件一行 → exit 1
    No → exit 0

Live 验证边界决策：
  检查凭据
    ↓
  无凭据 → SKIPPED（exit 0）
  有凭据 → try 验证
    ↓
    成功 → OK（exit 0）
    失败 → throw（exit 非零）
```

**发现/执行/汇总/live 流程**
1. **失败收集阶段**：仅记录退出码非零的文件路径，不捕获输出
2. **汇总打印阶段**：标题 + 每行一个文件，简洁
3. **退出码阶段**：非零当且仅当 `failures.length > 0`
4. **Live 边界阶段**：
   - 离线测试：总是运行，失败即失败
   - Live 验证：凭据驱动，无凭据跳过，有凭据失败即失败

**错误与凭据**
- **离线/mock/live 边界**：
  - **离线测试**（`tests/**`）：
    - 总是运行
    - 不需要凭据
    - 失败 → 退出非零
    - 不应发起网络请求（由各测试自行保证）
  - **Mock 层**：测试内部 mock，本文档不涉及
  - **Live 验证**（`scripts/live-*`）：
    - 凭据检查先行
    - 无凭据 → SKIPPED（exit 0）
    - 有凭据 → 真实网络请求
    - 失败 → ERROR（exit 非零）
- **凭据互斥**：仅 live-model-validation 有互斥检查

**设计取舍/备选**
- **取舍 1：仅失败文件列表 vs 汇总统计**
  - 选择：仅列表，无统计
  - 理由：简洁，stdout/stderr 已直接显示详细信息
  - 备选：统计总数/通过数/失败数（不采用）
- **取舍 2：stderr vs stdout**
  - 选择：`console.error`
  - 理由：失败消息到 stderr
- **取舍 3：继续运行 vs 首次失败退出**
  - 选择：继续运行，收集所有失败
  - 理由：一次看到所有失败文件
  - 备选：`--bail` 选项（当前不支持）
- **取舍 4：SKIPPED exit code 0 vs 特殊码**
  - 选择：exit 0
  - 理由：CI 中不把缺少凭据当作失败
  - 备选：exit 77 等特殊码（不采用）

**源码测试证据**
- `scripts/test.ts:45-49`：失败汇总
- `scripts/live-cloud-validation.ts:15-17`：SKIPPED 模式
- `scripts/live-model-validation.ts:40-47`：互斥检查
- `tests/buildArtifacts.test.ts:6-32`：典型离线测试

## 5. 失败语义与工程取舍

| 失败场景 | 处理方式 |
|---|---|
| 单个测试文件失败 | 记录失败，继续运行其他文件，最终汇总报告 |
| 测试发现失败但进程零退出 | 不视为失败（由 Bun test 保证） |
| Live 验证条件不满足 | 打印 `*_LIVE_SKIPPED`，不失败 |
| Live 验证条件满足但验证失败 | 抛出错误，非零退出 |
| Smoke 测试失败 | 立即失败，尽早反馈构建问题 |
| 跨领域验收失败 | 失败，表明整体一致性问题 |
| Feature 注入缺失 | 由 enabledFeatures 测试捕获（工具数量/注册异常） |
| 凭据互斥（API Key + Auth Token） | live-model-validation 立即失败 |

### 工程取舍

- **逐文件隔离 vs 启动开销**：选择隔离，避免状态污染的价值大于启动开销
- **Live 验证可选 vs 完整覆盖**：选择可选，外部依赖不可控，离线测试为主要门禁
- **Smoke 测试最小化 vs 完整验证**：选择最小化，快速反馈打包问题
- **跨领域集中验收 vs 分散重复**：选择集中，避免重复维护

## 6. 现状验收标准

### 测试运行器

- `scripts/test.ts` 必须为每个测试文件单独 spawn 子进程
- 必须注入所有 `EXTERNAL_FEATURES`
- 必须收集失败文件并汇总报告
- 有失败时必须非零退出

### Live 验证

- Cloud 验证：无 OAuth token 时打印 `CLOUD_LIVE_SKIPPED`，有 token 失败时抛出错误
- Desktop 验证：无 `CLAUDE_DESKTOP_LIVE=1` 时打印 `DESKTOP_LIVE_SKIPPED`
- Model 验证：同时设置 API Key 和 Auth Token 时立即失败
- SkillHub 验证：始终尝试，网络失败视为验证失败

### Smoke 测试

- 必须验证 `dist/main.js` 存在且可执行
- 必须验证 `dist/sdk.mjs` 存在
- 必须验证 `dist/types/entrypoints/agentSdkTypes.d.ts` 存在
- 必须验证 SDK 可以被导入
- 必须验证 `package.json` 的 exports 配置正确

### 跨领域验收

- `enabledFeatures.test.ts` 必须验证工具数量、注册状态、外层环境不影响 profile
- `publicPromptCommands.test.ts` 必须验证 `/summary` 和 `/autofix-pr` 命令

## 7. 代码与测试证据

### 现有测试

- `tests/buildArtifacts.test.ts`：Smoke 测试验证
- `tests/enabledFeatures.test.ts`：Enabled Features 验收测试
- `tests/publicPromptCommands.test.ts`：Public Prompt Commands 验收测试
- `tests/daemon.test.ts`：守护进程相关测试
- `tests/backgroundSessions.test.ts`：后台会话相关测试

### 实现证据

- `scripts/test.ts`：逐文件 spawn 实现，feature 注入逻辑
- `scripts/live-cloud-validation.ts`：Cloud 验证实现
- `scripts/live-desktop-validation.ts`：Desktop 验证实现
- `scripts/live-model-validation.ts`：Model 验证实现
- `scripts/live-skillhub-validation.ts`：SkillHub 验证实现
- `tests/fixtures/verify-enabled-features.ts`：验收 fixture 构建

### 未覆盖场景

- 测试并行化调度（当前串行）
- Live 验证网络请求重试机制
- JUnit XML 或其他结构化报告格式

## 8. 文件覆盖与相关子系统

本设计的覆盖率文件位于 [Coverage](../../architecture/coverage/test-validation.yaml)。

### 相关文件

- `scripts/test.ts`：测试运行器实现
- `scripts/live-cloud-validation.ts`：Cloud 验证
- `scripts/live-desktop-validation.ts`：Desktop 验证
- `scripts/live-model-validation.ts`：Model 验证
- `scripts/live-skillhub-validation.ts`：SkillHub 验证
- `scripts/externalFeatureProfile.ts`：外部功能列表
- `tests/buildArtifacts.test.ts`：Smoke 测试
- `tests/enabledFeatures.test.ts`：Enabled Features 验收
- `tests/publicPromptCommands.test.ts`：Public Prompt Commands 验收
- `tests/fixtures/`：测试 fixtures 目录

### 相关子系统

- Build & External Feature Profile：外部功能列表定义
- SDK Query Sessions：SDK 查询会话设计
- Daemon & Background：守护进程与后台会话设计

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| P2 | 当前 `scripts/test.ts` 是串行运行每个文件，测试速度较慢 | 测试并行化：未来可以考虑并行化以加快速度，但需要注意资源竞争（例如临时目录、端口） | 中：并行可能引入资源竞争，需要隔离 | 设计阶段验证架构方案 | M | 已证实（基于代码阅读） |
| P2 | 当前 live 验证没有重试，网络抖动可能导致 flaky | Live 验证的重试策略：为网络请求添加指数退避重试机制 | 低：仅添加重试逻辑，不改变验证语义 | 设计阶段验证方案 | S | 已证实（基于代码阅读） |
| P3 | 当前只有简单的失败文件列表，没有 JUnit XML 或其他结构化报告，不利于 CI 可视化 | 测试结果聚合：添加 JUnit XML 输出格式支持 | 低：新增输出格式，不改变默认行为 | 设计阶段验证方案 | M | 设计推断 |
| P2 | `tests/fixtures/` 下的文件与实际源码的同步需要注意，特别是 `verify-enabled-features.ts` 中的构建配置需要与 `scripts/build.ts` 保持一致 | Fixtures 的维护：添加集成测试验证 fixture 与构建配置一致性 | 低：新增测试，不影响现有测试 | 设计阶段验证方案 | M | 设计推断 |
| P3 | 部分测试可能同时涉及多个领域（例如 proactive 与 sleep 工具），需要明确哪个 spec 负责覆盖，避免重复或遗漏 | 跨领域测试的 spec 边界：在各 spec 中明确标注边界 | 低：仅文档更新，无代码变更 | 设计阶段验证方案 | S | 设计推断 |
| P1 | `scripts/live-model-validation.ts` 在 `enableConfigs()` 前检查 `process.env.ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN`；STATUS 与 RELEASE 对 settings 直读的表述需要以实际运行统一 | 明确 standalone 脚本的 settings 初始化契约，并集中处理凭据互斥检查 | 中：改变初始化顺序可能改变真实认证来源；不得打印凭据 | 覆盖无凭据、仅 API key、仅 Bearer、两者同时存在四种分支，并分别记录 caller-injected 与 settings-only 的实际结果 | M | 待运行验证（需要隔离 HOME 的 live/matrix 运行） |
