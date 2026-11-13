---
id: external-feature-profile
batch: 0
title: External Feature Profile 构建与验收设计
date: 2026-11-12
status: draft
---

# External Feature Profile 构建与验收设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

CLI 与 Agent SDK 共享 TypeScript 源码、查询、工具、权限和 session 实现，但交付形式不同：CLI 需要可直接执行的入口，SDK 需要可导入模块和类型声明。仅恢复源码或让 `Bun.build()` 返回成功，不能证明依赖、公共类型、功能注册和最终 bundle 能组成可用产品。

External feature profile 的目标是建立可复现的双产品交付链，并用真实 bundle 验证 external 功能边界。该功能只处理构建、类型、注册和离线行为，不验证真实模型、Cloud OAuth、桌面控制或远端 registry。

### 主要问题域

- **统一源码，双入口**：CLI 和 SDK 共享核心实现，但需要不同的入口点和打包配置
- **类型安全**：从 Zod schema 生成公共类型，保持类型与运行时验证一致
- **功能边界验证**：确保 external 构建包含正确的功能集，不包含 internal-only 功能
- **离线测试**：在不依赖外部服务的情况下验证 bundle 行为
- **交付链可复现**：依赖锁定、构建顺序、测试步骤完全可复现

### 约束条件

- 使用 Bun 作为构建工具和运行时
- 使用 Zod 进行 schema 验证
- 支持 USER_TYPE=external 和 internal 两种构建模式
- 测试必须在独立 Bun 子进程中运行，避免测试 runner 干扰
- 固定离线环境变量，确保测试确定性
- 不依赖外部网络服务进行基础验证

## 2. 设计理由与备选方案

### 共享源码与双入口构建

实际机制：CLI 入口 `src/entrypoints/cli.tsx`，SDK 入口 `src/entrypoints/agentSdkTypes.ts`，共享所有核心实现，仅在入口层处理差异。

为什么采用：CLI 与 SDK 的查询、工具、权限和 session 行为必须一致，分别实现会产生永久维护成本和语义漂移。共享源码并在入口层处理可执行 CLI 与可导入 SDK 的差异，可以把“行为一致”变成结构性约束。

代价：两个入口必须一起评审生命周期和导出边界，不能只改其中一端。

备选方案及不采用原因：
- CLI 与 SDK 各自实现：查询、工具与权限语义会重复并漂移
- 单一入口导出多个包：复杂度高，打包工具支持差

证据位置：`src/entrypoints/` 目录结构，`package.json` exports 配置。

### 从 schema 生成公共类型

实际机制：`scripts/generate-sdk-types.ts` 从 `coreSchemas.ts` 和 `controlSchemas.ts` 生成类型声明，使用行首正则匹配 `export const ...Schema` 并生成对应的 `z.infer<ReturnType<typeof schemas....Schema>>`。

为什么采用：手写 declarations 会让公共 API 与真实校验规则逐渐不一致。以 schema 为唯一事实来源，让调用方看到的类型与运行时接受的输入保持同源。当前生成器采用行首正则换取最小实现复杂度，因此必须显式接受命名约束；没有匹配项时失败，而不是生成看似完整的空文件。

代价：新增 schema 必须遵循命名约定 `export const ...Schema`。

备选方案及不采用原因：
- 完全手写类型：容易与实现 drift
- 使用完整的 TypeScript 编译器 API：复杂度高，维护成本大

证据位置：`scripts/generate-sdk-types.ts`。

### 生产与验收共享 feature 列表

实际机制：`externalFeatureProfile.ts` 是生产构建和验收测试的唯一功能清单，定义 EXTERNAL_FEATURES 集合，Bun feature flag 参与 dead-code elimination。

为什么采用：生产与验收各维护一份列表时，可能出现“测试验证了生产并不包含的代码”或“生产新增功能却没有验收”的假阳性。单一 feature 列表不是减少几行重复，而是让验收对象可信。

代价：新增功能必须同时更新实现、注册和测试。

备选方案及不采用原因：
- 生产与测试各维护 feature 列表：可能出现测试与生产不一致
- 无明确 feature 列表：无法验证功能边界

证据位置：`src/externalFeatureProfile.ts`，`scripts/build.ts`。

### 验收真实 bundle 而非仅测试源码

实际机制：`tests/fixtures/feature-check.ts` 导出真实注册表，`tests/fixtures/verify-enabled-features.ts` 再次编译并在独立 Bun 子进程中加载。

为什么采用：源码中的 `isEnabled()` 或 import 存在，不能证明代码最终进入 dist。验收构建再次编译并在独立子进程中加载，才能发现 feature 未启用、注册遗漏、空实现和打包后的模块初始化问题。独立子进程还避免 Bun test runner 对模块导入的拦截改变生产行为。

代价：测试运行时间稍长，需要维护 fixture。

备选方案及不采用原因：
- 仅测试源码：无法发现 dead-code elimination 问题
- 在同一进程测试：test runner 可能改变模块加载行为

证据位置：`tests/fixtures/feature-check.ts`，`tests/enabledFeatures.test.ts`。

### 固定离线环境

实际机制：测试时固定 `ANTHROPIC_BASE_URL`、`ENABLE_TOOL_SEARCH`、占位凭据，确保失败只能来自构建或注册，而非开发机差异。

为什么采用：外部服务和本机环境会让构建验收变慢且不确定。固定环境排除变量，确保测试结果可复现。真实模型、Cloud OAuth、桌面和远端 registry 属于不同故障域，不能用它们阻塞基础交付，也不能用离线 profile 冒充这些能力已在线可用。

代价：需要维护测试环境配置。

备选方案及不采用原因：
- 使用真实服务：测试慢、不稳定、需要凭据
- mock 所有外部依赖：mock 可能与真实行为不一致

证据位置：`tests/enabledFeatures.test.ts` 环境变量设置。

### 实施顺序

实际机制：固定依赖与 exports → 生成类型 → 构建 CLI/SDK → 验证注册与状态 → 改变外层环境复验。

为什么采用：每一步都有可验证产物和明确故障边界，不是形式上的“先代码后测试”。

代价：需要按顺序执行，不能并行。

备选方案及不采用原因：
- 顺序随意：可能出现后续步骤掩盖前置问题

证据位置：`package.json` scripts 顺序。

## 3. 目标与非目标

### 目标

- **固定依赖安装、SDK 类型生成、双入口打包和 declarations 的顺序**
- **明确 `USER_TYPE=external`、external feature 集和运行时可用性边界**
- **验证实际 bundle 中的工具池、命令、worker、Sleep 和 bundled skills**
- **固定离线测试环境，使 feature profile 不受开发机配置影响**
- **让类型生成、构建、注册和冒烟失败都有明确非零结果**

### 非目标

- **不启用 internal-only 功能，不建立第二套 CLI 或 SDK 实现**
- **不把源码存在、类型存在或构建成功等同于外部服务可用**
- **不在该功能中处理模型、Cloud、桌面或远端 registry 的在线验收**
- **不实现完整的 SDK 集成测试套件（仅验证功能注册和边界）**

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```
coreSchemas.ts / controlSchemas.ts
                │
                ▼
     scripts/generate-sdk-types.ts
                │
                ▼
coreTypes.generated.ts / controlTypes.ts
                │
        ┌───────┴────────┐
        ▼                ▼
src/entrypoints/cli.tsx  src/entrypoints/agentSdkTypes.ts
        │                │
        └──── Bun.build ─┘
                │
                ▼
 dist/main.js     dist/sdk.mjs
                │
                ▼
       tsc declarations → dist/types
```

### 4.2 核心模块职责

| 模块 | 职责 | 关键函数/类型 |
|-----|------|-------------|
| `scripts/generate-sdk-types.ts` | 从 schema 生成公共类型 | generateSdkTypes() |
| `scripts/build.ts` | 双入口打包、CLI shebang、declarations 生成 | build() |
| `src/externalFeatureProfile.ts` | external 功能清单 | EXTERNAL_FEATURES, isFeatureEnabled() |
| `src/entrypoints/cli.tsx` | CLI 入口 | main() |
| `src/entrypoints/agentSdkTypes.ts` | SDK 入口 | query(), createSdkMcpServer() |
| `tests/fixtures/feature-check.ts` | 测试用注册表导出 | getAllBaseTools(), builtInCommandNames(), getCoordinatorAgents() |
| `tests/fixtures/verify-enabled-features.ts` | bundle 验证 fixture | verifyEnabledFeatures() |
| `tests/enabledFeatures.test.ts` | external profile 验收测试 | 完整的验证流程 |

### 4.3 完整构建与验收流程

```
bun install --frozen-lockfile
  ↓
bun run generate:sdk-types
  ↓
验证 coreTypes.generated.ts 和 controlTypes.ts 存在且类型正确
  ↓
bun run typecheck
  ↓
bun test tests/enabledFeatures.test.ts
  ↓
bun test
  ↓
bun run build
  ↓
验证 dist/main.js 有 shebang 和可执行权限
  ↓
验证 dist/sdk.mjs 可导入
  ↓
验证 dist/types 与 package.json exports 对应
  ↓
bun dist/main.js --version
  ↓
bun dist/main.js --help
  ↓
bun -e "const sdk=await import('./dist/sdk.mjs'); if(typeof sdk.query!=='function'||typeof sdk.createSdkMcpServer!=='function') throw new Error('Invalid SDK exports')"
```

### 4.4 关键数据结构

**EXTERNAL_FEATURES**：
```typescript
Set<FeatureId> containing:
  - tools: Set of tool names enabled externally
  - commands: Set of command names enabled externally
  - skills: Set of bundled skills enabled externally
  - workers: Worker capabilities enabled externally
  - proactive: Proactive feature enabled
  - reactiveCompact: Reactive compaction enabled
  - etc.
```

**Bundle 验证清单**（来自 verify-enabled-features.ts）：
```typescript
{
  toolCount: number（当前 43，无 null entry）
  toolsPresent: string[]
  commandsPresent: string[]
  skillsPresent: string[]
  sleepInitiallyDisabled: boolean
  proactiveDisabledByDefault: boolean
  workerAgentDisabled: boolean
  reactiveCompactEnabled: boolean
  etc.
}
```

### 4.5 跨子系统边界

- **model-api**：模型选择、降级逻辑，但 external profile 不验证真实模型调用
- **tool-framework**：工具注册，但 external profile 仅验证工具池构成，不验证工具执行
- **command-framework**：命令注册，但 external profile 仅验证命令清单
- **agent-swarms**：agent 定义，但 external profile 仅验证 agent 注册表

## 5. 失败语义与工程取舍

### 5.1 失败语义表

| 触发条件 | 检测位置 | 消息/异常传播方式 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|-----------------|-------------|------------|------------|
| Schema 无匹配导出 | generate-sdk-types.ts | 终止类型生成，非零退出 | 不重试（需要修复 schema 命名） | 不生成类型文件 | 构建失败，显示未匹配的 schema |
| CLI 或 SDK bundle 失败 | build.ts | 打印构建日志，非零退出 | 不重试（需要修复代码） | 不保留部分构建 | 构建失败，显示错误日志 |
| declarations 与 exports 不一致 | 类型检查 | 构建失败，非零退出 | 不重试 | 不保留部分类型 | 构建失败，显示类型错误 |
| null tool、缺失工具或错误命令注册 | enabledFeatures.test.ts | 测试失败，显示具体差异 | 不重试（需要修复注册） | 不影响其他测试 | 测试失败，显示清单差异 |
| Sleep/proactive 状态错误或 worker 可递归 Agent | enabledFeatures.test.ts | 测试失败 | 不重试 | 不影响其他测试 | 测试失败，显示状态错误 |
| 外层环境覆盖测试输入 | enabledFeatures.test.ts | 在子进程 env 中显式覆盖测试值，禁止 profile 漂移 | 不重试（确保测试确定性） | 环境变量在子进程中被固定 | 测试结果不受开发机配置影响 |
| 外部服务未授权 | 不属于本功能 | 不处理（本功能仅离线验证） | 不重试 | 不适用 | 不适用（本功能不验证在线服务） |

### 5.2 主要工程取舍

| 取舍项 | 当前选择 | 代价 | 收益 |
|-------|---------|------|------|
| 从 schema 生成类型 vs 手写 | 从 schema 生成，行首正则匹配 | 新增 schema 必须遵循命名约定 | 类型与验证规则同源，不会 drift |
| 单一 feature 清单 vs 生产测试各一份 | 单一清单 | 新增功能必须同时更新实现、注册和测试 | 验收对象可信，不会出现测试验证生产不含功能的情况 |
| 验收真实 bundle vs 仅测试源码 | 验收真实 bundle，独立子进程 | 测试运行时间稍长 | 能发现 dead-code elimination、打包初始化、模块解析问题 |
| 固定离线环境 vs 依赖真实服务 | 固定离线环境，占位凭据 | 无法验证在线功能 | 测试快速、稳定、可复现，不阻塞基础交付 |
| 当前 profile 包含 43 个工具 vs 其他数字 | 43 是当前快照，数量随功能变化 | 新增/移除功能时需要更新测试 | 数量是具体验收标准，不是目标本身 |

## 6. 现状验收标准

### 6.1 构建与类型验收

- **给定** 正确配置的开发环境，执行 `bun run generate:sdk-types`，**应该** 成功生成 coreTypes.generated.ts 和 controlTypes.ts
- **给定** schema 没有匹配的 `export const ...Schema`，执行类型生成，**应该** 失败而不是生成空文件
- **给定** 生成类型后，执行 `bun run typecheck`，**应该** 通过
- **给定** 类型检查通过后，执行 `bun run build`，**应该** 成功生成 dist/main.js 和 dist/sdk.mjs
- **给定** build 成功，**应该** 验证：
  - dist/main.js 有 shebang 和可执行权限
  - dist/sdk.mjs 可导入，有 query 和 createSdkMcpServer 导出
  - dist/types 存在且与 package.json exports 对应

### 6.2 Feature Profile 验收

- **给定** 构建产物，**应该** 验证当前 profile 包含 43 个工具且 `nullCount===0`
- **给定** 构建产物，**应该** 验证指定工具和命令均存在
- **给定** 构建产物，**应该** 验证 Sleep 初始 disabled，proactive 激活后 enabled
- **给定** 构建产物，**应该** 验证 worker 是后台 worker 且不包含 Agent
- **给定** 构建产物，**应该** 验证 reactive compaction、hunter、proactive、peers、remote-control-server、workflows、Buddy、Fork、force-snip、assistant、ultraplan、voice、brief 等均按设计注册
- **给定** 外层 `ANTHROPIC_BASE_URL` 和 `ENABLE_TOOL_SEARCH` 不同值，**应该** 验证 profile 结果不发生变化

### 6.3 建议验收命令

```bash
bun install --frozen-lockfile
bun run generate:sdk-types
bun run typecheck
bun test tests/enabledFeatures.test.ts
bun test
bun run build
bun dist/main.js --version
bun dist/main.js --help
bun -e "const sdk=await import('./dist/sdk.mjs'); if(typeof sdk.query!=='function'||typeof sdk.createSdkMcpServer!=='function') throw new Error('Invalid SDK exports')"
```

这些命令定义交付验收，不表示历史提交当时保存或执行过相同计划。

## 7. 代码与测试证据

### 7.1 核心模块证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| 共享源码双入口 | `src/entrypoints/cli.tsx`、`src/entrypoints/agentSdkTypes.ts`、`package.json` exports | 需补充测试 | 仅验证入口存在，不验证完整功能 |
| 从 schema 生成类型 | `scripts/generate-sdk-types.ts`、`src/entrypoints/sdk/coreSchemas.ts`、`src/entrypoints/sdk/controlSchemas.ts` | 需补充测试 | 仅验证生成机制，不验证类型完整性 |
| 单一 feature 清单 | `src/externalFeatureProfile.ts`、`scripts/build.ts` feature 配置 | `tests/enabledFeatures.test.ts` | 仅验证清单存在，不验证 feature 完整性 |
| 验收真实 bundle | `tests/fixtures/feature-check.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts` | `tests/enabledFeatures.test.ts` | 仅验证离线行为，不验证在线功能 |
| 固定离线环境 | `tests/enabledFeatures.test.ts` 环境变量设置 | `tests/enabledFeatures.test.ts` | 仅验证离线配置，不验证真实服务 |
| 实施顺序 | `package.json` scripts 定义的顺序 | 需补充测试 | 仅验证脚本顺序，不验证完整 CI 流程 |

### 7.2 现有测试场景证明

| 测试文件 | 测试场景 | 证明的不变量 |
|---------|---------|-------------|
| `tests/enabledFeatures.test.ts` | external feature profile 完整验收 | toolCount===43，无 null entry，Sleep 初始 disabled，proactive 默认 disabled，worker 不包含 Agent，各功能按设计注册 |

### 7.3 边界与未覆盖

- 真实模型调用（本功能仅验证注册，不验证执行）
- Cloud OAuth 流程（本功能仅离线验证）
- 桌面控制功能（本功能仅验证注册）
- 远端 registry（本功能仅离线验证）
- SDK 完整集成测试（仅验证边界和注册）

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/external-feature-profile.yaml)

### 8.1 本 spec 主拥有的文件组

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|-----|---------|----------------|----------------|
| build-scripts | 类型生成、双入口打包、declarations 生成 | `tests/enabledFeatures.test.ts` | 不拥有各功能实现 |
| feature-profile | external 功能清单、dead-code elimination 配置 | `tests/enabledFeatures.test.ts` | 不拥有 internal 功能配置 |
| sdk-entrypoints | SDK 入口、公共类型导出 | `tests/enabledFeatures.test.ts` | 不拥有 SDK 完整实现 |
| entrypoints | CLI 入口、主函数、CLI 参数解析 | 需补充测试 | 不拥有 CLI 业务逻辑 |

### 8.2 相关子系统边界

- **model-api**：模型选择、降级逻辑；本 spec 仅验证注册，不验证调用
- **tool-framework**：工具注册；本 spec 仅验证工具池构成，不验证工具执行
- **command-framework**：命令注册；本 spec 仅验证命令清单
- **agent-swarms**：agent 定义；本 spec 仅验证 agent 注册表
- 所有其他功能模块：本 spec 仅验证它们在 external profile 中的存在/不存在，不验证功能正确性

## 9. 改进建议

### P1：增强类型生成器的健壮性

触发场景与证据：当前类型生成器使用行首正则，schema 命名约定约束较大。

建议方向：考虑使用 TypeScript Compiler API 更稳健地识别 schema 导出，而不是依赖正则；添加 schema 完整性检查，确保所有公共类型都有对应 schema。

回归风险：中，需要重写生成器，但可以保持生成的类型兼容。

验收方式：新增 schema 自动被识别，无需手动命名约束。

工作量：M。

置信度：设计推断。

### P1：添加更多 bundle 验证点

触发场景与证据：当前主要验证工具池、命令、Sleep/proactive 状态，缺少更多边界验证。

建议方向：验证 SDK 可以正确初始化，验证 CLI 可以正确启动不崩溃，验证所有导出的类型与运行时实际接受的输入一致，验证环境变量正确影响功能开关。

回归风险：低，仅新增测试。

验收方式：新增的验证点都通过。

工作量：M。

置信度：设计推断。

### P2：添加 CI 完整流程测试

触发场景与证据：当前没有完整 CI 流程的测试，无法验证完整交付链。

建议方向：添加测试模拟完整 CI 流程：clean install → generate types → typecheck → test → build → verify bundle。

回归风险：低，仅新增测试。

验收方式：CI 流程测试通过。

工作量：S。

置信度：设计推断。

### P2：添加边界情况测试

触发场景与证据：当前主要验证正常路径，缺少边界情况。

建议方向：测试删除一个 feature 后验证其确实被 dead-code elimination 移除，测试环境变量开关功能，测试 USER_TYPE=internal vs external 的差异。

回归风险：低，仅新增测试。

验收方式：边界情况测试通过。

工作量：S。

置信度：设计推断。
