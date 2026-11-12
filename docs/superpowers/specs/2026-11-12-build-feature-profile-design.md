---
id: build-feature-profile
batch: 7
title: Build & Feature Profile 构建与功能裁剪设计
date: 2026-11-12
status: draft
---

# Build & Feature Profile 构建与功能裁剪设计

## 1. 背景与问题

CLI 与 Agent SDK 共享同一套 TypeScript 源码，但需要以不同形式交付：CLI 作为可执行程序、SDK 作为可导入模块。同时，不同产品形态需要包含不同的功能子集，部分功能仅用于内部开发或特定环境。

现有方案通过 Bun 的 `feature()` 编译时函数和 `EXTERNAL_FEATURES` 列表实现功能裁剪，但需要统一的设计来确保：
- 构建产物包含且仅包含指定功能
- 功能裁剪不破坏类型安全和运行时一致性
- 有可信的验收方式验证最终交付内容

本设计描述从源码到可交付产物的完整构建链，以及功能裁剪在各阶段的作用边界。

## 2. 为什么采用这套设计与实施顺序

### 2.1 为什么使用 Bun 的 `feature()` 做 DCE

Bun 的 `feature()` 是编译时评估的函数，配合 `Bun.build({ features: [...] })` 可以在打包阶段直接移除未启用功能的代码（Dead-Code Elimination，DCE）。相比运行时 `if (process.env.FEATURE_X)`，这种方式：
- 最终产物不包含禁用功能的任何代码
- 减少包体积并避免意外调用
- 不需要复杂的 tree-shaking 配置

代价是 `feature()` 只能在顶层条件或模块加载时使用，不能依赖运行时状态。

### 2.2 为什么生产与验收共用 `EXTERNAL_FEATURES`

`EXTERNAL_FEATURES` 是唯一事实来源，生产构建和验收测试都使用同一列表。这确保验收的正是实际交付的内容，避免两者配置漂移导致的假阳性。如果各自维护，可能出现“测试通过但交付缺少功能”或“测试未覆盖但交付包含功能”的情况。

### 2.3 为什么从 Schema 生成 SDK 类型

公共 API 类型需要与 Zod 校验定义保持一致。手写 `*.d.ts` 容易与实际 schema 漂移，从 `coreSchemas.ts` 和 `controlSchemas.ts` 自动生成类型可以：
- 确保类型与校验规则同源
- 减少维护成本
- 在无匹配 schema 时明确失败而不是生成空声明

### 2.4 为什么验收真实 bundle 而不是源码

源码中存在相关导入或 `isEnabled()` 检查不能证明该功能最终进入 dist。验收测试需要：
1. 用与生产相同的 feature 集重新编译验收 fixture
2. 在独立子进程中加载实际 bundle
3. 验证注册表、工具可用性、状态转换等

这样可以发现构建配置问题、注册遗漏、空实现和打包初始化问题。

### 2.5 为什么固定离线环境

外部服务（如 API 端点、工具搜索开关）会让验收结果不确定。固定 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ENABLE_TOOL_SEARCH` 可以确保失败只来自构建或注册问题，而不是开发机环境差异。真实模型、Cloud OAuth、桌面控制等属于不同故障域，需要单独验收。

### 2.6 不采用哪些替代方案，以及为什么

| 备选做法 | 不采用的原因 |
|---|---|
| 运行时 `process.env` 检查 | 禁用功能的代码仍留在 bundle 中 |
| 多个入口点分支 | 维护成本高，容易 drift |
| 仅靠类型系统区分 | 不影响最终 bundle 内容 |
| 验收只做静态检查 | 无法发现构建和初始化问题 |
| 按工具数量断言验收 | 数量只是快照，正确注册和行为才重要 |

当前 external profile 有 43 个工具，但这个数字本身不是目标。新增功能时需要同时调整实现、注册和 profile 验收。

## 3. 目标与非目标

### 目标

- 建立从源码到 dist 的可复现构建链
- 明确 `feature()`、`USER_TYPE` 和功能可用性的边界
- 通过验收真实 bundle 确保交付内容可信
- 固定离线测试环境，排除外部因素干扰
- 提供至少 5 个明确的设计决策及其权衡

### 非目标

- 不替换 Bun 作为构建工具
- 不设计新的 feature flag 系统
- 不在线验证模型、Cloud、桌面等外部服务
- 不处理运行时动态切换功能

## 4. 总体架构

构建与功能裁剪分为以下阶段：

```
Schema 定义 (coreSchemas.ts / controlSchemas.ts)
         ↓
   SDK 类型生成 (generate-sdk-types.ts)
         ↓
   类型声明 (coreTypes.generated.ts / controlTypes.ts)
         ↓
   ┌────┴────┐
   ↓         ↓
CLI 入口   SDK 入口
(cli.tsx) (agentSdkTypes.ts)
   ↓         ↓
   └────┬────┘
        ↓
   Bun.build
   (features: [...EXTERNAL_FEATURES])
   (define: { USER_TYPE: 'external', ... })
        ↓
   ┌────┴────┐
   ↓         ↓
dist/main.js  dist/sdk.mjs
(可执行)     (可导入)
   ↓
dist/types/...
(类型声明)
```

验收流程：

```
EXTERNAL_FEATURES (同一列表)
         ↓
   验收 fixture 构建 (feature-check.ts)
         ↓
   独立子进程加载 bundle
         ↓
   验证工具注册表、命令、状态、worker 行为
```

## 5. 组件契约

### 5.1 构建脚本 (scripts/build.ts)

构建脚本负责：

1. 调用 `generateSdkTypes()` 生成公共类型
2. 执行两次 `Bun.build`：
   - CLI：`src/entrypoints/cli.tsx` → `dist/main.js`，添加 shebang，`chmod +x`
   - SDK：`src/entrypoints/agentSdkTypes.ts` → `dist/sdk.mjs`
3. 注入 `MACRO.*` 常量和 `process.env.USER_TYPE='external'`
4. 显式传入 `features: [...EXTERNAL_FEATURES]`

任一构建失败时打印日志并非零退出。

### 5.2 外部功能列表 (scripts/externalFeatureProfile.ts)

`EXTERNAL_FEATURES` 是只读常量数组，列出 external 构建包含的所有功能：

```typescript
export const EXTERNAL_FEATURES = [
  'AGENT_MEMORY_SNAPSHOT',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'VOICE_MODE',
  'BRIDGE_MODE',
  'ULTRAPLAN',
  'FILE_PERSISTENCE',
  'KAIROS_BRIEF',
  'MONITOR_TOOL',
  'TEMPLATES',
  'OPEN_RUNNER',
  'OVERFLOW_TEST_TOOL',
  'TERMINAL_PANEL',
  'PROACTIVE',
  'COORDINATOR_MODE',
  'EXPERIMENTAL_SKILL_SEARCH',
  'UDS_INBOX',
  'DAEMON',
  'WORKFLOW_SCRIPTS',
  'CONTEXT_COLLAPSE',
  'DIRECT_CONNECT',
  'BG_SESSIONS',
  'REACTIVE_COMPACT',
  'SSH_REMOTE',
  'BUDDY',
  'FORK_SUBAGENT',
  'HISTORY_SNIP',
  'REVIEW_ARTIFACT',
  'KAIROS',
  'KAIROS_GITHUB_WEBHOOKS',
  'CHICAGO_MCP',
  'COMMIT_ATTRIBUTION',
  'BASH_CLASSIFIER',
  'WEB_BROWSER_TOOL',
] as const
```

该列表是生产构建和验收测试的唯一事实来源。

### 5.3 编译时宏 (src/runtimeMacros.ts)

`MACRO` 对象提供版本、构建时间等常量：
- 生产构建时由 `Bun.build({ define: { ... } })` 替换
- 直接源码执行（测试、`bun run dev`）时由 runtimeMacros 设置默认值

`MACRO` 全局声明在 `src/global.d.ts` 中。

### 5.4 Feature 函数 (bun:bundle)

`feature(name: string): boolean` 来自 `bun:bundle` 模块：
- 构建时由 Bun 根据传入的 `features` 数组替换为 `true`/`false`
- DCE 移除 `if (feature('DISABLED')) { ... }` 块
- 类型检查时声明在 `src/global.d.ts` 中

典型用法：
```typescript
import { feature } from 'bun:bundle'

// 工具级裁剪
const someTool = feature('SOME_FEATURE') ? { ... } : null

// 命令级裁剪
const someCommand = feature('SOME_FEATURE') ? command(...) : null

// 模块级裁剪
const optionalModule = feature('SOME_FEATURE') ? require('./someModule.js') : null
```

### 5.5 SDK 类型生成 (scripts/generate-sdk-types.ts)

类型生成器处理两个目标：

| Schema 文件 | 输出文件 | 说明 |
|---|---|---|
| `src/entrypoints/sdk/coreSchemas.ts` | `src/entrypoints/sdk/coreTypes.generated.ts` | 核心类型 |
| `src/entrypoints/sdk/controlSchemas.ts` | `src/entrypoints/sdk/controlTypes.ts` | 控制类型（同时导出 coreTypes） |

生成规则：
- 通过 `/^export const (\w+Schema)\s*=/gm` 正则匹配 schema
- 生成 `export type ${TypeName} = z.infer<ReturnType<typeof schemas.${TypeName}Schema>>`
- 无匹配时抛出错误而不是生成空文件

### 5.6 功能可用性分层

功能是否可用分为多层，每层独立控制：

| 层次 | 控制方式 | 说明 |
|---|---|---|
| DCE 保留 | `feature()` + `EXTERNAL_FEATURES` | 代码是否进入 bundle |
| 注册 | 工具/命令注册表 | 是否对外暴露 |
| Availability | `availability` 回调 | 宿主环境是否支持 |
| 运行时状态 | `isEnabled()` 回调 | 当前是否可调用 |

例如 `ultraplan` 命令可以同时有 external 注册和 `claude-ai` availability，不需要用 internal-only 列表重复限制。

### 5.7 验收 Fixture (tests/fixtures/)

- `feature-check.ts`：导出注册表访问器，不执行验收
- `verify-enabled-features.ts`：用 `EXTERNAL_FEATURES` 构建 fixture，在子进程中加载并验证 profile

验收内容包括：
- 工具数量（当前 43）和无 null 项
- 指定工具存在（CronCreate、RemoteTrigger、Monitor、Sleep、ToolSearch 等）
- Sleep 初始 disabled，proactive 激活后 enabled
- worker 是后台 worker，有 Bash 无 Agent
- reactive compact、hunter、proactive、peers、remote-control-server、workflows、buddy、fork、force-snip、assistant、ultraplan、voice、brief 按设计注册
- 命令名称包含/排除指定项
- 外层环境不影响 profile 结果

### 5.8 Package Exports

`package.json` 配置：
- `bin.claude-code`：`./dist/main.js`
- `exports['.'].import`：`./dist/sdk.mjs`
- `exports['.'].types`：`./dist/types/entrypoints/agentSdkTypes.d.ts`

## 6. 失败语义

| 失败场景 | 处理方式 |
|---|---|
| Schema 无匹配导出 | `generateSdkTypes()` 抛出错误，不继续构建 |
| CLI/SDK 构建失败 | 打印日志，非零退出 |
| 声明路径与 exports 不一致 | `buildArtifacts.test.ts` 失败 |
| 工具 null 或数量不符 | `enabledFeatures.test.ts` 失败 |
| Sleep/proactive 状态错误 | `enabledFeatures.test.ts` 失败 |
| 外层环境改变 profile | `enabledFeatures.test.ts` 失败（子进程显式覆盖 env） |
| 外部服务未授权 | 不属于本设计范围，不能用 offline profile 冒充在线可用 |

## 7. 设计决策总结

### 决策 1：使用 `feature()` 做编译时 DCE，而不是运行时检查

- **备选**：运行时 `process.env`、多个入口点
- **选择理由**：禁用功能代码完全移除，包体积最小，无意外调用风险
- **代价**：`feature()` 只能用在编译时可评估的位置，不能依赖运行时状态
- **证据**：`src/commands.ts`、`src/main.tsx`、`src/tools.ts` 中大量 `feature()` 用法

### 决策 2：生产构建与验收测试共用 `EXTERNAL_FEATURES`

- **备选**：各自维护 feature 列表
- **选择理由**：确保验收的正是实际交付的内容，避免配置 drift
- **代价**：新增功能需要同时考虑实现和验收
- **证据**：`scripts/build.ts` 和 `tests/fixtures/verify-enabled-features.ts` 都使用 `[...EXTERNAL_FEATURES]`

### 决策 3：从 Zod Schema 生成 SDK 类型，而不是手写

- **备选**：手写 `*.d.ts`、用 `tsc --declaration`
- **选择理由**：类型与校验规则同源，减少维护成本
- **代价**：生成器依赖命名约定（`export const *Schema`）
- **证据**：`scripts/generate-sdk-types.ts` 实现和 `src/entrypoints/sdk/` 下的生成文件

### 决策 4：验收真实 bundle 而不是仅源码测试

- **备选**：只做单元测试、只做类型检查
- **选择理由**：可以发现构建配置、注册遗漏、打包初始化等问题
- **代价**：验收流程更复杂，需要独立子进程
- **证据**：`tests/fixtures/verify-enabled-features.ts` 重新构建并加载 bundle

### 决策 5：验收时固定离线环境，排除外部因素

- **备选**：用真实服务验收、允许开发机配置影响结果
- **选择理由**：失败只来自构建或注册，结果稳定可复现
- **代价**：需要单独的在线验收流程验证真实服务集成
- **证据**：`enabledFeatures.test.ts` 中固定 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ENABLE_TOOL_SEARCH`、`NODE_ENV`

## 8. 覆盖率

本设计的覆盖率文件位于 [Coverage](../../architecture/coverage/build-feature-profile.yaml)。

## 9. 开放问题与边界疑虑

1. **Feature Flag 命名与管理**：当前无统一的 flag 清单或生命周期管理，新增 flag 容易冲突或遗忘清理。
2. **Internal-Only 功能的边界**：部分功能通过 `USER_TYPE === 'ant'` 限制，部分通过不在 `EXTERNAL_FEATURES` 中排除，两者关系需要更明确的约定。
3. **类型生成器的可扩展性**：当前正则只匹配 `export const *Schema`，如果 schema 定义方式变化需要调整生成器。
4. **验收性能**：`enabledFeatures.test.ts` 需要重新构建和子进程加载，当前超时设为 180s/240s，未来可能成为瓶颈。
5. **Coverage 验证**：当前没有自动验证 `EXTERNAL_FEATURES` 与代码中 `feature()` 调用的覆盖率，可能存在未使用或缺失的 flag。
