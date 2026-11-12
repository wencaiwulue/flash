---
id: test-validation
batch: 7
title: Test Validation 测试运行、Live 验证与证据边界设计
date: 2026-11-12
status: draft
---

# Test Validation 测试运行、Live 验证与证据边界设计

## 1. 背景与问题

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

## 2. 为什么采用这套设计与实施顺序

### 2.1 为什么逐文件隔离运行测试

`scripts/test.ts` 为每个测试文件单独 spawn 一个 Bun 子进程，而不是一次性运行所有测试。这种设计：
- 避免测试间状态污染（全局变量、环境变量、文件系统）
- 每个测试可以独立配置 feature flags 或环境
- 失败可以精确到文件，便于并行化和重跑
- 与 Bun test 的默认行为一致，但显式控制注入 feature flags

代价是启动开销稍大，但相对于集成测试的隔离需求是可接受的。

### 2.2 为什么 Live 验证按领域分离而非统一套件

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

### 2.3 为什么 Live 验证在 CI 中是可选的

Live 验证依赖外部服务、网络和凭据，CI 环境不一定能满足这些条件。因此：
- 本地开发时可以选择性运行
- CI 中通过环境变量控制是否启用
- 离线测试仍然是主要的质量门禁

### 2.4 为什么 Smoke 测试单独存在而非集成到主测试

`buildArtifacts.test.ts` 只验证最基本的交付内容（CLI 可执行、SDK 可导入、类型声明存在），不运行完整功能测试。这是为了：
- 在快速构建流程中尽早发现打包问题
- 不依赖测试数据库或外部服务
- 可以在每次提交时运行而不影响速度

### 2.5 为什么跨领域测试（enabledFeatures、publicPromptCommands）集中验收

跨领域测试（功能配置、公共命令）不归属单个领域 spec，而是在中央位置验收。这样：
- 避免每个 spec 重复验证同一组工具/命令
- 确保整体一致性（例如工具数量、命令可用性）
- 变更影响可以在一个地方看到

### 2.6 不采用哪些替代方案，以及为什么

| 备选做法 | 不采用的原因 |
|---|---|
| 单进程运行所有测试 | 测试间状态污染风险高 |
| 统一 live 验证套件 | 凭据和环境配置复杂，部分失败易导致整体跳过 |
| CI 强制要求 live 验证 | 外部依赖不可控，易导致 flaky |
| 把所有测试都放在 smoke 阶段 | 失去分层验证的价值 |
| 每个 spec 重复覆盖跨领域测试 | 维护成本高，容易 drift |

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

## 4. 总体架构

测试与验证分为三层：

```
┌─────────────────────────────────────────────────────────┐
│                     Live 验证层                          │
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
│                  跨领域验收层                             │
│  ┌──────────────────┐ ┌──────────────────┐               │
│  │ Enabled Features │ │ Public Commands  │               │
│  │ (离线 bundle)    │ │ (/summary 等)    │               │
│  └──────────────────┘ └──────────────────┘               │
└─────────────────────────────────────────────────────────┘
                          ↑ 必需
┌─────────────────────────────────────────────────────────┐
│                  Smoke 测试层                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │  CLI 可执行、SDK 可导入、类型声明存在              │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          ↑ 必需
┌─────────────────────────────────────────────────────────┐
│                  测试运行器                              │
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

## 5. 组件契约

### 5.1 测试运行器 (scripts/test.ts)

测试运行器负责：

1. 发现所有 `tests/**/*.test.{ts,tsx}` 文件
2. 接受可选的特定文件列表（用于重跑失败）
3. 为每个文件单独 spawn 子进程，注入所有 `EXTERNAL_FEATURES`
4. 收集失败文件，在结束时汇总打印
5. 有失败时非零退出

关键实现：
```typescript
const featureArgs = EXTERNAL_FEATURES.flatMap(feature => [
  `--feature=${feature}`,
])
for (const file of testFiles) {
  const child = Bun.spawn({
    cmd: [process.execPath, ...featureArgs, 'test', ...options, file],
    // ...
  })
  // ...
}
```

### 5.2 外部功能列表 (scripts/externalFeatureProfile.ts)

`EXTERNAL_FEATURES` 是测试运行器注入的唯一 feature 来源，确保：
- 测试环境与生产构建使用相同的 feature 集
- 测试中可以验证 conditional registration 的行为
- 避免测试通过但生产构建缺失功能

列表内容参见 Build & Feature Profile 设计。

### 5.3 Live 验证分类与凭据边界

#### 5.3.1 Cloud 验证 (live-cloud-validation.ts)

**需要的凭据/环境：**
- `getClaudeAIOAuthTokens()` 返回有效 access token
- `CLAUDE_CODE_ORG_UUID` 或能通过 token 获取组织 UUID
- `CLAUDE_CODE_BASE_URL` 或使用默认 OAuth 配置的 API URL

**验证内容：**
- 无环境 Bridge 会话创建与持久化
- 会话恢复（同一 session ID）
- 文件持久化（`runFilePersistence`）
- 会话归档

**跳过条件：** 无 OAuth token → 打印 `CLOUD_LIVE_SKIPPED`

**失败语义：** 有 token 但验证失败 → 抛出错误，非零退出

#### 5.3.2 Desktop 验证 (live-desktop-validation.ts)

**需要的凭据/环境：**
- `CLAUDE_DESKTOP_LIVE=1`
- 桌面截图权限（macOS 系统权限）

**验证内容：**
- `getOpenComputerUseClient()` 初始化
- `screenshot` 工具调用成功

**跳过条件：** 无 `CLAUDE_DESKTOP_LIVE=1` → 打印 `DESKTOP_LIVE_SKIPPED`

**失败语义：** 有标志但验证失败 → 抛出错误

**清理：** `closeOpenComputerUseClient()` 在 finally 中调用

#### 5.3.3 Model 验证 (live-model-validation.ts)

**需要的凭据/环境：**
- `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`（不能同时设置）

**验证内容：**
- Workflow 执行（返回 `WORKFLOW_LIVE_OK`）
- Proactive 模式激活与 Sleep 工具（返回 `PROACTIVE_LIVE_OK`）
- Context Collapse（返回 `CONTEXT_COLLAPSE_LIVE_OK`）
- Reactive Compact（返回 `REACTIVE_COMPACT_LIVE_OK`）

**跳过条件：** 两者都未设置 → 打印 `MODEL_LIVE_SKIPPED`

**失败语义：** 有任一凭据但验证失败 → 抛出错误

**凭据互斥检查：** 同时设置时立即失败

#### 5.3.4 SkillHub 验证 (live-skillhub-validation.ts)

**需要的凭据/环境：**
- `CLAUDE_SKILL_REGISTRY_URL`（默认 `https://skill.xfyun.cn`）
- `CLAUDE_SKILL_REGISTRY_TOKEN`（可选）

**验证内容：**
- SkillHub 搜索（`search('code')`）
- 远程技能加载（`loadRemoteSkill`）
- 缓存命中（第二次加载返回 `cacheHit: true`）

**跳过条件：** 无（始终尝试，网络失败则视为验证失败）

**失败语义：** 搜索无结果、加载内容异常、缓存未命中 → 抛出错误

### 5.4 Smoke 测试 (tests/buildArtifacts.test.ts)

Smoke 测试只验证最基本的构建完整性：

**验证内容：**
1. `dist/main.js` 存在、以 shebang 开头、可执行
2. `dist/sdk.mjs` 存在
3. `dist/types/entrypoints/agentSdkTypes.d.ts` 存在
4. SDK 可以被导入，`query` 和 `createSdkMcpServer` 是函数
5. `package.json` 的 exports 配置正确

**不验证内容：**
- 具体功能行为（由各领域测试负责）
- 外部服务集成（由 live 验证负责）

**运行时机：** 每次构建后

### 5.5 跨领域验收测试

#### 5.5.1 Enabled Features (tests/enabledFeatures.test.ts)

**归属：** 本 spec（不归属单个领域）

**验证内容：**
- 工具数量（当前 43）、无 null 项
- 指定工具存在（CronCreate、RemoteTrigger、Monitor、Sleep、ToolSearch 等）
- Sleep 初始 disabled、proactive 激活后 enabled
- Worker 类型与能力（后台、有 Bash、无 Agent）
- Reactive compact、hunter、proactive、peers、remote-control-server、workflows、buddy、fork、force-snip、assistant、ultraplan、voice、brief 注册状态
- 命令名称包含/排除指定项
- 外层环境不影响 profile 结果

**实现方式：**
- 使用 `tests/fixtures/verify-enabled-features.ts` 构建验收 fixture
- 在独立子进程中加载真实 bundle
- 固定离线环境（`ANTHROPIC_API_KEY='offline-test-placeholder'`、`ANTHROPIC_BASE_URL='https://api.anthropic.com'`、`ENABLE_TOOL_SEARCH='true'`、`NODE_ENV='production'`）

#### 5.5.2 Public Prompt Commands (tests/publicPromptCommands.test.ts)

**归属：** 本 spec（不归属单个领域）

**验证内容：**
- `/summary` 命令：可选 focus、无 compaction、空会话处理
- `/autofix-pr` 命令：引用解析（数字、#、URL）、双 API 分页、禁止发布

**特点：** 这是公共命令的集中验收，单个命令的深入测试归属各自领域。

### 5.6 测试 Fixtures (tests/fixtures/)

Fixtures 提供测试所需的隔离环境和假实现：

- `feature-check.ts`：导出注册表访问器，供 enabledFeatures 使用
- `verify-enabled-features.ts`：构建验收 fixture 并运行 profile
- `env-less-perpetual-check.ts`：验证无环境持久化行为
- `fake-lsp-server.ts`：假 LSP 服务器，用于 LSP 相关测试

### 5.7 失败汇总与报告

测试运行器在所有文件执行完毕后：
1. 收集所有退出码非零的文件
2. 打印 `Failed test files (N):` 加文件名列表
3. 以非零码退出

Live 验证脚本各自输出状态码：
- `*_LIVE_SKIPPED`：条件不满足，跳过
- `*_LIVE_OK`：验证通过
- 抛出错误：验证失败

## 6. 失败语义

| 失败场景 | 处理方式 |
|---|---|
| 单个测试文件失败 | 记录失败，继续运行其他文件，最终汇总报告 |
| 测试发现失败但进程零退出 | 不视为失败（由 Bun test 确保） |
| Live 验证条件不满足 | 打印 `*_LIVE_SKIPPED`，不失败 |
| Live 验证条件满足但验证失败 | 抛出错误，非零退出 |
| Smoke 测试失败 | 立即失败，尽早反馈构建问题 |
| 跨领域验收失败 | 失败，表明整体一致性问题 |
| Feature 注入缺失 | 由 enabledFeatures 测试捕获（工具数量/注册异常） |
| 凭据互斥（API Key + Auth Token） | live-model-validation 立即失败 |

## 7. 设计决策总结

### 决策 1：逐文件隔离运行测试，而不是单进程运行

- **备选**：`bun test` 一次性运行所有测试
- **选择理由**：避免测试间状态污染，每个测试独立配置，失败精确到文件
- **代价**：进程启动开销稍大
- **证据**：`scripts/test.ts` 中的 `for (const file of testFiles)` 循环，每次 `Bun.spawn`

### 决策 2：Live 验证按领域分离为四个独立脚本，而不是统一套件

- **备选**：单个 `live-validation.ts` 统一配置和运行
- **选择理由**：每个脚本明确声明需要的凭据，独立跳过/失败，不需要复杂的条件配置
- **代价**：需要分别运行四个脚本
- **证据**：`scripts/live-cloud-validation.ts`、`live-desktop-validation.ts`、`live-model-validation.ts`、`live-skillhub-validation.ts` 四个独立文件

### 决策 3：Smoke 测试只验证最基本的构建完整性，而不是运行完整测试

- **备选**：把所有测试都放在 smoke 阶段
- **选择理由**：快速反馈打包问题，不依赖外部服务，可以在每次提交时运行
- **代价**：需要分层验证，smoke 通过不代表功能正确
- **证据**：`tests/buildArtifacts.test.ts` 只检查文件存在、可执行、SDK 可导入

### 决策 4：跨领域测试（enabledFeatures、publicPromptCommands）集中验收，而不是每个 spec 重复覆盖

- **备选**：每个 spec 重复验证工具列表、命令可用性
- **选择理由**：避免重复维护，确保整体一致性，变更影响集中可见
- **代价**：需要明确 spec 边界，避免遗漏
- **证据**：`tests/enabledFeatures.test.ts`、`tests/publicPromptCommands.test.ts` 作为中央验收点

### 决策 5：Live 验证在 CI 中是可选的，而不是强制门禁

- **备选**：CI 强制要求所有 live 验证通过
- **选择理由**：外部依赖不可控，易导致 flaky，本地可以选择性运行
- **代价**：可能遗漏 live-only 问题
- **证据**：各 live 脚本都有 `*_LIVE_SKIPPED` 机制，无凭据时跳过不失败

### 决策 6：Model 验证要求 API Key 与 Auth Token 互斥，而不是允许同时设置

- **备选**：优先级规则（例如 Auth Token 优先）
- **选择理由**：明确意图，避免配置错误导致意外使用错误的凭据
- **代价**：需要用户明确选择一种方式
- **证据**：`live-model-validation.ts` 开头检查 `if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_AUTH_TOKEN)` 并抛出错误

## 8. 覆盖率

本设计的覆盖率文件位于 [Coverage](../../architecture/coverage/test-validation.yaml)。

## 9. 开放问题与边界疑虑

1. **测试并行化**：当前 `scripts/test.ts` 是串行运行每个文件，未来可以考虑并行化以加快速度，但需要注意资源竞争（例如临时目录、端口）。

2. **Live 验证的重试策略**：当前 live 验证没有重试，网络抖动可能导致 flaky。是否需要为网络请求添加重试？

3. **测试结果聚合**：当前只有简单的失败文件列表，没有 JUnit XML 或其他结构化报告，不利于 CI 可视化。

4. **Fixtures 的维护**：`tests/fixtures/` 下的文件与实际源码的同步需要注意，特别是 `verify-enabled-features.ts` 中的构建配置需要与 `scripts/build.ts` 保持一致。

5. **跨领域测试的 spec 边界**：部分测试可能同时涉及多个领域（例如 proactive 与 sleep 工具），需要明确哪个 spec 负责覆盖，避免重复或遗漏。当前设计将跨领域的集中验收归本 spec，领域内的深入测试归各领域 spec。
