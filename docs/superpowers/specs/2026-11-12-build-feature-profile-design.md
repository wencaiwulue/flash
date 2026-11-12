---
id: build-feature-profile
batch: 7
title: Build & Feature Profile 构建与功能裁剪设计
date: 2026-11-12
status: draft
---

# Build & Feature Profile 构建与功能裁剪设计

## 1. 问题与约束

CLI 与 Agent SDK 共享同一套 TypeScript 源码，但需要以不同形式交付面临的约束包括：

- CLI 作为可执行程序、SDK 作为可导入模块
- 不同产品形态需要包含不同的功能子集
- 部分功能仅用于内部开发或特定环境
- 使用 Bun 的 `feature()` 编译时函数和 `EXTERNAL_FEATURES` 列表实现功能裁剪
- 保证构建产物包含且仅包含指定功能
- 功能裁剪不破坏类型安全和运行时一致性
- 有可信的验收方式验证最终交付内容
- 从 Schema 生成 SDK 类型（公共 API 类型需要与 Zod 校验定义保持一致）
- 验收真实 bundle 而不是仅源码测试（源码中存在相关导入或 `isEnabled()` 检查不能证明该功能最终进入 dist）
- 固定离线环境验收（外部服务如 API 端点、工具搜索开关会让验收结果不确定，固定 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ENABLE_TOOL_SEARCH` 可以确保失败只来自构建或注册问题）
- 当前 external profile 有 43 个工具
- `MACRO.*` 常量由 `Bun.build({ define: { ... } })` 替换
- 功能可用性分层（DCE 保留、注册、Availability、运行时状态）

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 使用 `feature()` 做编译时 DCE | Bun 的 `feature()` 编译时函数，配合 `Bun.build({ features: [...] })` 在打包阶段直接移除未启用功能的代码，典型用法：`const someTool = feature('SOME_FEATURE') ? { ... } : null`、`const someCommand = feature('SOME_FEATURE') ? command(...) : null`、`const optionalModule = feature('SOME_FEATURE') ? require('./someModule.js') : null` | 禁用功能代码完全移除，包体积最小，无意外调用风险；运行时 `if (process.env.FEATURE_X)` 禁用功能的代码仍留在 bundle 中 | 运行时 `process.env` 检查（禁用功能的代码仍留在 bundle 中）、多个入口点分支（维护成本高，容易 drift）、仅靠类型系统区分（不影响最终 bundle 内容） | `feature()` 只能用在编译时可评估的位置，不能依赖运行时状态 | `src/commands.ts`、`src/main.tsx`、`src/tools.ts` 中大量 `feature()` 用法 |
| 生产构建与验收测试共用 `EXTERNAL_FEATURES` | `EXTERNAL_FEATURES` 是只读常量数组，列出 external 构建包含的所有功能，`scripts/build.ts` 和 `tests/fixtures/verify-enabled-features.ts` 都使用 `[...EXTERNAL_FEATURES]` | 确保验收的正是实际交付的内容，避免配置 drift；如果各自维护，可能出现"测试通过但交付缺少功能"或"测试未覆盖但交付包含功能"的情况 | 各自维护 feature 列表（配置 drift 风险） | 新增功能需要同时考虑实现和验收 | `scripts/build.ts` 和 `tests/fixtures/verify-enabled-features.ts` |
| 从 Zod Schema 生成 SDK 类型 | `scripts/generate-sdk-types.ts` 处理两个目标：`src/entrypoints/sdk/coreSchemas.ts` → `src/entrypoints/sdk/coreTypes.generated.ts`、`src/entrypoints/sdk/controlSchemas.ts` → `src/entrypoints/sdk/controlTypes.ts`；生成规则：通过 `/^export const (\\w+)Schema\\s*=/gm` 正则匹配 schema，生成 `export type ${TypeName} = z.infer<ReturnType<typeof schemas.${TypeName}Schema>>`，无匹配时抛出错误而不是生成空文件 | 类型与校验规则同源，减少维护成本；手写 `*.d.ts` 容易与实际 schema drift；在无匹配 schema 时明确失败而不是生成空声明 | 手写 `*.d.ts`（容易 drift）、用 `tsc --declaration`（不够精确） | 生成器依赖命名约定（`export const *Schema`） | `scripts/generate-sdk-types.ts` 实现和 `src/entrypoints/sdk/` 下的生成文件 |
| 验收真实 bundle 而不是仅源码测试 | 验收 fixture 构建（feature-check.ts），独立子进程加载 bundle，验证工具注册表、命令、状态、worker 行为；验收内容包括：工具数量（当前 43）和无 null 项、指定工具存在（CronCreate、RemoteTrigger、Monitor、Sleep、ToolSearch 等）、Sleep 初始 disabled，proactive 激活后 enabled、worker 是后台 worker，有 Bash 无 Agent、reactive compact、hunter、proactive、peers、remote-control-server、workflows、buddy、fork、force-snip、assistant、ultraplan、voice、brief 按设计注册、命令名称包含/排除指定项、外层环境不影响 profile 结果 | 可以发现构建配置问题、注册遗漏、空实现和打包初始化问题；源码中存在相关导入或 `isEnabled()` 检查不能证明该功能最终进入 dist | 只做单元测试（不验证实际 bundle）、只做类型检查（不验证实际 bundle）、按工具数量断言验收（数量只是快照，正确注册和行为才重要） | 验收流程更复杂，需要独立子进程 | `tests/fixtures/verify-enabled-features.ts` 重新构建并加载 bundle |
| 验收时固定离线环境，排除外部因素 | 验收时固定 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ENABLE_TOOL_SEARCH`、`NODE_ENV` | 失败只来自构建或注册问题，结果稳定可复现；外部服务（如 API 端点、工具搜索开关）会让验收结果不确定；真实模型、Cloud OAuth、桌面控制等属于不同故障域，需要单独验收 | 用真实服务验收（结果不确定）、允许开发机配置影响结果（结果不稳定） | 需要单独的在线验收流程验证真实服务集成 | `enabledFeatures.test.ts` 中固定环境变量 |
| 功能可用性分层 | 四层独立控制：DCE 保留（`feature()` + `EXTERNAL_FEATURES`）、注册（工具/命令注册表）、Availability（`availability` 回调）、运行时状态（`isEnabled()` 回调）；例如 `ultraplan` 命令可以同时有 external 注册和 `claude-ai` availability，不需要用 internal-only 列表重复限制 | 灵活性高，每层独立控制；DCE 确保代码不进入 bundle，注册确保对外暴露，Availability 确保宿主环境支持，运行时状态确保当前可用 | 单层控制（不够灵活）、internal-only 列表（重复限制） | 需要理解各层的区别和用途 | 功能可用性分层设计 |

## 3. 目标与非目标

### 目标
- 建立从源码到 dist 的可复现构建链
- 明确 `feature()`、`USER_TYPE` 和功能可用性的边界
- 通过验收真实 bundle 确保交付内容可信
- 固定离线测试环境，排除外部因素干扰
- 提供至少 5 个明确的设计决策及其权衡
- 从 Zod Schema 生成 SDK 类型，确保类型与校验规则同源
- 生产构建与验收测试共用 `EXTERNAL_FEATURES`
- 功能可用性分层设计
- 验收内容覆盖工具注册表、命令、状态、worker 行为

### 非目标
- 不替换 Bun 作为构建工具
- 不设计新的 feature flag 系统
- 不在线验证模型、Cloud、桌面等外部服务
- 不处理运行时动态切换功能
- 不提供 LSP 服务器安装功能（由插件负责）
- 不支持远程 LSP 服务器（当前仅本地）

## 4. 架构、模块与数据流

### 构建流程

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
   (define: { USER_TYPE: 'external', ...MACRO.*... })
         ↓
   ┌────┴────┐
   ↓         ↓
dist/main.js  dist/sdk.mjs
(可执行)     (可导入)
   ↓
dist/types/...
(类型声明)
```

### 验收流程

```
EXTERNAL_FEATURES (同一列表)
         ↓
   验收 fixture 构建 (feature-check.ts)
         ↓
   独立子进程加载 bundle
         ↓
   验证工具注册表、命令、状态、worker 行为
```

### 核心模块接口

```typescript
// 构建脚本 (scripts/build.ts)
generateSdkTypes(): Promise<void>  // 调用 generateSdkTypes 生成公共类型
buildCLI(): Promise<void>  // 构建 CLI：src/entrypoints/cli.tsx → dist/main.js，添加 shebang，chmod +x
buildSDK(): Promise<void>  // 构建 SDK：src/entrypoints/agentSdkTypes.ts → dist/sdk.mjs
build(): Promise<void>  // 执行两次 Bun.build

// 外部功能列表 (scripts/externalFeatureProfile.ts)
const EXTERNAL_FEATURES = [
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
  // ... 更多功能
] as const  // 只读常量数组，列出 external 构建包含的所有功能

// 编译时宏 (src/runtimeMacros.ts)
const MACRO = {
  VERSION: string,
  BUILD_TIME: string,
  // ... 更多常量
}  // 生产构建时由 `Bun.build({ define: { ... } })` 替换，直接源码执行（测试、`bun run dev`）时由 runtimeMacros 设置默认值

// Feature 函数 (bun:bundle)
import { feature } from 'bun:bundle'
function feature(name: string): boolean  // 构建时由 Bun 根据传入的 `features` 数组替换为 `true`/`false`，DCE 移除 `if (feature('DISABLED')) { ... }` 块

// SDK 类型生成 (scripts/generate-sdk-types.ts)
function generateSdkTypes(): Promise<void>  // 生成 coreTypes.generated.ts 和 controlTypes.ts

// 验收 fixture (tests/fixtures/)
// feature-check.ts: 导出注册表访问器，不执行验收
// verify-enabled-features.ts: 用 `EXTERNAL_FEATURES` 构建 fixture，在子进程中加载并验证 profile

// Package.json exports
// bin.claude-code: ./dist/main.js
// exports['.'].import: ./dist/sdk.mjs
// exports['.'].types: ./dist/types/entrypoints/agentSdkTypes.d.ts
```

## 5. 失败语义与工程取舍

| 失败场景 | 处理方式 | 工程取舍 |
|---|---|---|
| Schema 无匹配导出 | `generateSdkTypes()` 抛出错误，不继续构建 | 明确失败比生成空声明好 |
| CLI/SDK 构建失败 | 打印日志，非零退出 | 构建失败应该明确 |
| 声明路径与 exports 不一致 | `buildArtifacts.test.ts` 失败 | 验证 package.json 配置正确 |
| 工具 null 或数量不符 | `enabledFeatures.test.ts` 失败 | 验证工具注册表正确 |
| Sleep/proactive 状态错误 | `enabledFeatures.test.ts` 失败 | 验证功能状态正确 |
| 外层环境改变 profile | `enabledFeatures.test.ts` 失败（子进程显式覆盖 env） | 验证环境隔离正确 |
| 外部服务未授权 | 不属于本设计范围，不能用 offline profile 冒充在线可用 | 分层验证，离线验收验证构建，在线验收验证服务集成 |
| `feature()` 用在运行时可评估位置 | 编译时可能无法 DCE，代码可能留在 bundle 中 | 需要代码审查确保 `feature()` 只用在编译时可评估位置 |
| `EXTERNAL_FEATURES` 列表遗漏功能 | 验收测试失败，需要同时调整实现、注册和 profile 验收 | 确保交付内容正确 |

## 6. 现状验收标准

- `generateSdkTypes()` 正确从 Zod Schema 生成 SDK 类型
- `scripts/build.ts` 正确构建 CLI 和 SDK，使用 `[...EXTERNAL_FEATURES]`
- CLI 构建产物 `dist/main.js` 正确添加 shebang，chmod +x
- SDK 构建产物 `dist/sdk.mjs` 正确可导入
- 类型声明 `dist/types/...` 正确生成
- package.json exports 配置正确
- `enabledFeatures.test.ts` 正确验收真实 bundle，固定离线环境
- 工具数量正确（当前 43），无 null 项
- 指定工具存在（CronCreate、RemoteTrigger、Monitor、Sleep、ToolSearch 等）
- Sleep 初始 disabled，proactive 激活后 enabled
- worker 是后台 worker，有 Bash 无 Agent
- reactive compact、hunter、proactive、peers、remote-control-server、workflows、buddy、fork、force-snip、assistant、ultraplan、voice、brief 按设计注册
- 命令名称包含/排除指定项
- 外层环境不影响 profile 结果

## 7. 代码与测试证据

### 现有实现
- `scripts/build.ts`: 构建脚本
- `scripts/externalFeatureProfile.ts`: 外部功能列表
- `src/runtimeMacros.ts`: 编译时宏
- `src/entrypoints/cli.tsx`: CLI 入口
- `src/entrypoints/agentSdkTypes.ts`: SDK 入口
- `src/entrypoints/sdk/coreSchemas.ts`: 核心 Schema
- `src/entrypoints/sdk/controlSchemas.ts`: 控制 Schema
- `package.json`: Package exports
- `tests/fixtures/feature-check.ts`: 验收 fixture
- `tests/fixtures/verify-enabled-features.ts`: 验收验证
- `tests/enabledFeatures.test.ts`: 功能验收测试
- `tests/buildArtifacts.test.ts`: 构建产物验收测试

### 共享证据但由其他 spec 主拥有的文件
- `scripts/generate-sdk-types.ts`: 归属于 `sdk-type-generation` spec，本 spec 仅描述其在构建流程中的调用

### 未覆盖测试
- 边界情况测试（新增功能、移除功能、功能重命名）
- 性能测试（构建时间、bundle 大小、启动时间）
- 跨平台测试（Windows、macOS、Linux）
- 不同 feature 组合测试
- SDK 导入和使用测试
- CLI 启动和基本功能测试
- 类型声明兼容性测试（不同 TypeScript 版本）

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/build-feature-profile.yaml)

相关子系统：
- commands: 命令注册，使用 `feature()`
- tools: 工具注册，使用 `feature()`
- main: 主入口，使用 `feature()`
- plugins: 插件系统，可能与功能裁剪交互
- settings: 可能提供全局配置（当前不支持用户/项目级 LSP 配置）
- telemetry: 可能使用 MACRO.VERSION 等常量
- lsp: LSP 集成，当前不支持用户/项目级 LSP 配置

## 9. 改进建议

1. 实现统一的 feature flag 清单和生命周期管理，避免新增 flag 冲突或遗忘清理
2. 明确 internal-only 功能的边界，理清 `USER_TYPE === 'ant'` 限制和不在 `EXTERNAL_FEATURES` 中排除两者的关系
3. 增强类型生成器的可扩展性，支持更多 schema 定义方式（不只是 `export const *Schema`）
4. 优化验收性能，`enabledFeatures.test.ts` 需要重新构建和子进程加载，当前超时设为 180s/240s，未来可能成为瓶颈
5. 实现自动验证 `EXTERNAL_FEATURES` 与代码中 `feature()` 调用的覆盖率，发现未使用或缺失的 flag
6. 实现 feature flag 可视化工具，显示哪些功能在哪些 profile 中启用
7. 增加 bundle 大小预算监控，防止 bundle 大小意外增长
8. 实现增量构建，减少开发时的构建时间
9. 增加更多验收维度（性能、内存使用、启动时间等）
10. 实现 feature flag 废弃流程，安全移除旧 flag
11. 增加 feature flag 文档生成，自动生成功能清单和说明
12. 实现 feature flag A/B 测试支持
13. 增加 feature flag 运行时切换支持（开发环境）
14. 实现更细粒度的功能裁剪（模块级、函数级）
15. 增加 feature flag 依赖关系管理，确保功能按正确顺序启用/禁用
