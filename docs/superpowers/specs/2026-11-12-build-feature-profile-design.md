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
function generateSdkTypes(): void  // 生成 coreTypes.generated.ts 和 controlTypes.ts

// 验收 fixture (tests/fixtures/)
// feature-check.ts: 导出注册表访问器，不执行验收
// verify-enabled-features.ts: 用 `EXTERNAL_FEATURES` 构建 fixture，在子进程中加载并验证 profile

// Package.json exports
// bin.claude-code: ./dist/main.js
// exports['.'].import: ./dist/sdk.mjs
// exports['.'].types: ./dist/types/entrypoints/agentSdkTypes.d.ts
```

### 模块设计卡

#### 模块 4.1: CLI/SDK 构建 (scripts/build.ts)

| 维度 | 详情 |
|------|------|
| **真实入口签名** | 无显式函数，作为脚本直接执行 (import.meta.main 隐式入口) |
| **关键类型** | - `BuildConfig`: Bun.build 配置对象<br>- `DefineMap`: { [key: string]: string } 宏替换映射<br>- `BuildOutput`: { path: string, ... } 构建输出 |
| **输入** | - 环境变量: `BUILD_OUTDIR` (默认 'dist')<br>- 源文件: `src/entrypoints/cli.tsx`, `src/entrypoints/agentSdkTypes.ts`<br>- 配置: `package.json`, `scripts/externalFeatureProfile.ts` |
| **输出** | - `dist/main.js`: CLI 可执行文件 (带 shebang `#!/usr/bin/env bun`)<br>- `dist/sdk.mjs`: SDK ESM 模块<br>- 控制台: 输出文件路径日志<br>- 权限: `dist/main.js` 设置为 0o755 |
| **构建配置** | - 两次 `Bun.build` 调用: CLI + SDK<br>- `target: 'bun'`<br>- `format: 'esm'`<br>- `features: [...EXTERNAL_FEATURES]`<br>- `define`: MACRO.* + `process.env.USER_TYPE` 替换<br>- `loader`: { '.md': 'text', '.txt': 'text' } |
| **生成流程** | 1. 调用 `generateSdkTypes()` 生成类型<br>2. 构建 CLI 入口: `src/entrypoints/cli.tsx` → `dist/main.js`<br>3. 构建 SDK 入口: `src/entrypoints/agentSdkTypes.ts` → `dist/sdk.mjs`<br>4. 对 `dist/main.js` 执行 `chmod 0o755` |
| **错误处理** | - 构建失败: 打印所有 logs，`process.exit(1)`<br>- `generateSdkTypes()` 抛出错误直接终止 |
| **兼容性** | - 支持 `BUILD_OUTDIR` 环境变量覆盖输出目录<br>- 硬编码 shebang 仅兼容 Unix-like 系统 |
| **设计取舍** | - 不封装 buildCLI/buildSDK 函数: 直接循环 `builds` 数组，简化代码<br>- 不使用 Promise.all 并行构建: 顺序构建便于日志阅读<br>- shebang 通过 `banner` 字段注入，而非后处理写入 |
| **备选方案** | - 使用单个 `Bun.build` 多入口: 无法为每个入口单独设置 banner<br>- 后处理写入 shebang: 更脆弱，需要处理编码问题 |
| **源码证据** | `scripts/build.ts:1-61` |
| **测试证据** | `tests/buildArtifacts.test.ts:6-32` 验证 CLI/SDK 存在性、shebang、可执行权限、SDK import smoke |

#### 模块 4.2: MACRO 注入与运行时回退 (src/runtimeMacros.ts)

| 维度 | 详情 |
|------|------|
| **真实入口签名** | 无导出函数，作为副作用模块导入 (`import '../runtimeMacros.js'`) |
| **关键类型** | - `MACRO` 全局对象类型: `{ VERSION: string, BUILD_TIME: string, PACKAGE_URL: string, NATIVE_PACKAGE_URL: string, VERSION_CHANGELOG: string, FEEDBACK_CHANNEL: string, ISSUES_EXPLAINER: string }` |
| **输入** | - `package.json` (读取 version 字段)<br>- 构建时 `define` 配置 (来自 `scripts/build.ts`) |
| **输出** | - 全局 `MACRO` 对象 (仅在直接源码执行时)<br>- 构建时 `MACRO.*` 被替换为字面量字符串 |
| **注入配置** | - `MACRO.VERSION`: `JSON.stringify(packageJson.version)`<br>- `MACRO.BUILD_TIME`: `JSON.stringify(new Date().toISOString())`<br>- `MACRO.PACKAGE_URL`: `JSON.stringify('https://www.npmjs.com/package/' + packageJson.name)`<br>- `MACRO.NATIVE_PACKAGE_URL`: 同 PACKAGE_URL<br>- `MACRO.VERSION_CHANGELOG`: `''` (空)<br>- `MACRO.FEEDBACK_CHANNEL`: `''` (空)<br>- `MACRO.ISSUES_EXPLAINER`: `''` (空)<br>- `process.env.USER_TYPE`: `JSON.stringify('external')`<br>- `process.env.CLAUDE_CODE_VERIFY_PLAN`: `JSON.stringify('false')` |
| **回退流程** | 1. 检查 `typeof MACRO === 'undefined'`<br>2. 如果未定义，使用 `Object.assign(globalThis, { MACRO: { ... } })` 设置默认值<br>3. 默认值从 `packageJson.version` 读取，BUILD_TIME 为空字符串 |
| **错误处理** | - 无显式错误处理: `package.json` 导入失败会导致模块加载失败 |
| **兼容性** | - 生产构建: Bun 内联替换，无运行时开销<br>- 直接源码执行 (测试、`bun run dev`): 回退到 runtimeMacros 默认值<br>- SDK 消费者导入: 同样需要 runtimeMacros 回退 |
| **设计取舍** | - 使用全局对象而非导出: 便于构建时替换，无需改动导入路径<br>- 空字符串作为未配置宏的默认值: 避免 `undefined` 导致的运行时错误<br>- `BUILD_TIME` 默认值为空: 避免非构建环境出现过期时间戳 |
| **备选方案** | - 使用导出常量: 构建时替换需要更复杂的配置<br>- 使用环境变量: 构建时内联不如 define 直接<br>- 始终设置 globalThis: 会覆盖构建时注入的值 |
| **源码证据** | `src/runtimeMacros.ts:1-17`, `scripts/build.ts:10-20` |
| **测试证据** | 无直接单测，通过 `enabledFeatures.test.ts` 间接验证 |

#### 模块 4.3: 类型声明生成 (scripts/generate-sdk-types.ts)

| 维度 | 详情 |
|------|------|
| **真实入口签名** | `export function generateSdkTypes(): void` |
| **关键类型** | - `GenerationTarget`: `{ schemaPath: string, outputPath: string, prelude?: string }`<br>- 生成目标: coreSchemas.ts → coreTypes.generated.ts, controlSchemas.ts → controlTypes.ts |
| **输入** | - `src/entrypoints/sdk/coreSchemas.ts`: 核心 Zod Schema 定义<br>- `src/entrypoints/sdk/controlSchemas.ts`: 控制协议 Zod Schema 定义 |
| **输出** | - `src/entrypoints/sdk/coreTypes.generated.ts`: 生成的类型声明<br>- `src/entrypoints/sdk/controlTypes.ts`: 生成的类型声明 (含 prelude)<br>- 控制台: `Generated ${target.outputPath} (${schemaNames.length} types)` |
| **生成规则** | - 正则匹配: `/^export const (\w+Schema)\s*=/gm`<br>- 命名约定: `XxxSchema` → `Xxx` 类型名<br>- 类型推导: `export type Xxx = z.infer<ReturnType<typeof schemas.XxxSchema>>`<br>- controlTypes.ts 额外添加 `export * from './coreTypes.js'` prelude |
| **生成流程** | 1. 遍历 `targets` 数组<br>2. 读取 schema 源文件<br>3. 正则提取所有 `export const XxxSchema` 名称<br>4. 如果无匹配，抛出错误 `No exported schemas found in ${target.schemaPath}`<br>5. 生成类型声明代码<br>6. 写入输出文件<br>7. 打印日志 |
| **错误处理** | - 无匹配 schema: 抛出错误，不继续构建<br>- 文件读写错误: Node.js fs 异常会终止执行 |
| **兼容性** | - 仅支持 `export const XxxSchema =` 格式的命名约定<br>- 仅支持顶层导出的 schema<br>- 不支持动态 schema 或条件导出 |
| **设计取舍** | - 使用正则而非 TypeScript AST: 简单快速，满足当前需求<br>- 无匹配时明确失败而非生成空文件: 避免静默失败导致类型缺失<br>- 生成文件包含 `// Generated by ...` 头: 防止手动编辑 |
| **备选方案** | - 使用 `ts-morph` 解析 AST: 更健壮但更复杂<br>- 使用 `tsc --declaration`: 不够精确，无法直接映射 Zod schema<br>- 允许无匹配时继续: 可能导致类型缺失被忽略 |
| **源码证据** | `scripts/generate-sdk-types.ts:1-48` |
| **测试证据** | 本 spec 不包含，归属于 `sdk-type-generation` spec |

#### 模块 4.4: feature() DCE 功能裁剪 (bun:bundle + EXTERNAL_FEATURES)

| 维度 | 详情 |
|------|------|
| **真实入口签名** | `import { feature } from 'bun:bundle'`<br>`function feature(name: string): boolean` (由 Bun 提供) |
| **关键类型** | - `EXTERNAL_FEATURES`: 只读常量数组 `readonly string[]`<br>- 支持的 feature 名称: `'AGENT_MEMORY_SNAPSHOT'`, `'AGENT_TRIGGERS'`, `'AGENT_TRIGGERS_REMOTE'`, `'VOICE_MODE'`, `'BRIDGE_MODE'`, `'ULTRAPLAN'`, `'FILE_PERSISTENCE'`, `'KAIROS_BRIEF'`, `'MONITOR_TOOL'`, `'TEMPLATES'`, `'OPEN_RUNNER'`, `'OVERFLOW_TEST_TOOL'`, `'TERMINAL_PANEL'`, `'PROACTIVE'`, `'COORDINATOR_MODE'`, `'EXPERIMENTAL_SKILL_SEARCH'`, `'UDS_INBOX'`, `'DAEMON'`, `'WORKFLOW_SCRIPTS'`, `'CONTEXT_COLLAPSE'`, `'DIRECT_CONNECT'`, `'BG_SESSIONS'`, `'REACTIVE_COMPACT'`, `'SSH_REMOTE'`, `'BUDDY'`, `'FORK_SUBAGENT'`, `'HISTORY_SNIP'`, `'REVIEW_ARTIFACT'`, `'KAIROS'`, `'KAIROS_GITHUB_WEBHOOKS'`, `'CHICAGO_MCP'`, `'COMMIT_ATTRIBUTION'`, `'BASH_CLASSIFIER'`, `'WEB_BROWSER_TOOL'` |
| **输入** | - `Bun.build({ features: [...EXTERNAL_FEATURES] })`<br>- 源码中 `feature('Xxx')` 调用 |
| **输出** | - 构建时 `feature('Xxx')` 替换为 `true` 或 `false`<br>- DCE (Dead Code Elimination) 移除 `if (false) { ... }` 块<br>- 不在 EXTERNAL_FEATURES 中的功能代码完全不进入 bundle |
| **DCE 使用模式** | - 条件定义: `const someTool = feature('Xxx') ? { ... } : null`<br>- 条件注册: `if (feature('Xxx')) { commands.push(...) }`<br>- 条件导入: `if (feature('Xxx')) { await import('./xxx.js') }`<br>- 条件环境设置: `if (feature('ABLATION_BASELINE') && ...) { process.env.Xxx = '1' }` |
| **裁剪流程** | 1. `scripts/build.ts` 传入 `features: [...EXTERNAL_FEATURES]`<br>2. `tests/fixtures/verify-enabled-features.ts` 同样传入 `features: [...EXTERNAL_FEATURES]`<br>3. Bun 构建时识别 `feature('Xxx')` 调用<br>4. 替换为布尔字面量<br>5. 执行 DCE 移除不可达代码 |
| **错误处理** | - 无显式错误处理: `feature()` 未在编译时可评估位置使用可能导致 DCE 失败，代码仍留在 bundle 中 |
| **兼容性** | - `feature()` 只能用在编译时可评估位置: 参数必须是字符串字面量<br>- 不能依赖运行时状态判断 feature 可用性<br>- 不能动态构建 feature 名称 |
| **设计取舍** | - 使用 `[...EXTERNAL_FEATURES]` 展开而非直接引用: 确保两个构建使用相同列表 (build.ts + verify-enabled-features.ts)<br>- `as const` 确保数组只读: 防止意外修改<br>- 不在代码中维护 internal 列表: 避免与 EXTERNAL_FEATURES 重复 |
| **备选方案** | - 运行时 `process.env.FEATURE_Xxx` 检查: 禁用功能代码仍留在 bundle 中<br>- 多个入口点分支: 维护成本高，容易 drift<br>- 仅靠类型系统区分: 不影响最终 bundle 内容 |
| **源码证据** | `scripts/externalFeatureProfile.ts:1-41`, `src/entrypoints/cli.tsx:2-342` (大量 feature() 调用) |
| **测试证据** | `tests/enabledFeatures.test.ts` 验证工具数量、指定工具存在/不存在、命令包含/排除 |

#### 模块 4.5: USER_TYPE=external 与 external disabled 限制

| 维度 | 详情 |
|------|------|
| **真实入口签名** | - 构建时注入: `'process.env.USER_TYPE': JSON.stringify('external')`<br>- 运行时读取: `process.env.USER_TYPE` |
| **关键类型** | - USER_TYPE 值: `'external'` (外部用户) 或 `'ant'` (内部员工)<br>- 不在 EXTERNAL_FEATURES 中的功能隐式 disabled |
| **输入** | - `scripts/build.ts` define 配置<br>- `tests/fixtures/verify-enabled-features.ts` define 配置 |
| **输出** | - 构建时 `process.env.USER_TYPE` 替换为 `'external'` 字面量<br>- DCE 移除 `if (process.env.USER_TYPE === 'ant') { ... }` 块 |
| **限制层级** | 1. **DCE 层**: 不在 EXTERNAL_FEATURES → `feature('Xxx')` → `false` → 代码移除<br>2. **USER_TYPE 层**: `process.env.USER_TYPE === 'external'` → 内部代码移除<br>3. **注册层**: 工具/命令注册表条件注册<br>4. **Availability 层**: `availability` 回调宿主环境检查<br>5. **运行时层**: `isEnabled()` 回调当前状态检查 |
| **流程** | 1. 构建时注入 `USER_TYPE: 'external'`<br>2. DCE 移除内部-only 代码路径<br>3. EXTERNAL_FEATURES 控制外部包含的功能<br>4. 运行时 Availability/isEnabled 进一步控制可用性 |
| **错误处理** | - 无显式错误处理: 需要通过验收测试验证配置正确 |
| **兼容性** | - 测试环境同样设置 `USER_TYPE: 'external'`: 确保验收真实 profile<br>- `CLAUDE_CODE_VERIFY_PLAN: 'false'`: 禁用计划验证 |
| **设计取舍** | - 两层限制 (EXTERNAL_FEATURES + USER_TYPE): 提供灵活性，某些功能可以在两个 profile 中但受 USER_TYPE 限制<br>- 验收测试同样使用 `USER_TYPE: 'external'`: 确保验收真实交付内容 |
| **备选方案** | - 仅用 EXTERNAL_FEATURES: 不够灵活，无法区分"在两个 profile 但有条件"的功能<br>- 仅用 USER_TYPE: 无法精细控制功能子集 |
| **源码证据** | `scripts/build.ts:18-19`, `tests/fixtures/verify-enabled-features.ts:14-16` |
| **测试证据** | `tests/enabledFeatures.test.ts` 验证外部 profile 包含正确工具/命令 |

#### 模块 4.6: 构建产物验证 (tests/buildArtifacts.test.ts)

| 维度 | 详情 |
|------|------|
| **真实入口签名** | `test('packages an executable CLI, importable SDK, and matching declarations', async () => { ... })` |
| **关键类型** | - `BunFile`: Bun 文件对象<br>- `Bun.spawnSync`: 子进程 spawn 结果 |
| **输入** | - `dist/main.js`: CLI 可执行文件<br>- `dist/sdk.mjs`: SDK 模块<br>- `dist/types/entrypoints/agentSdkTypes.d.ts`: 类型声明<br>- `package.json`: exports 配置 |
| **输出** | - 测试通过/失败<br>- 断言验证 5 个维度: 文件存在性、shebang、可执行权限、SDK import、package.json exports |
| **验证配置** | - SDK import smoke: `Bun.spawnSync` 执行 `import('./dist/sdk.mjs')` 验证有效<br>- package.json exports: 验证 `exports['.'].import` 和 `exports['.'].types` 路径正确 |
| **验证流程** | 1. 验证 `dist/main.js` 存在<br>2. 验证内容以 `#!/usr/bin/env bun` 开头<br>3. 验证权限包含可执行位 (mode & 0o111)<br>4. 验证 `dist/sdk.mjs` 存在<br>5. 验证 `dist/types/entrypoints/agentSdkTypes.d.ts` 存在<br>6. SDK import smoke 测试: spawn 子进程 import，验证 stderr 为空，exitCode 为 0<br>7. 验证 package.json exports 配置正确 |
| **错误处理** | - 任何断言失败导致测试失败<br>- SDK import smoke 失败会显示 stderr 内容 |
| **兼容性** | - 可执行权限检查仅在 Unix-like 系统有意义<br>- SDK import 使用 Bun，验证 ESM 兼容性 |
| **设计取舍** | - SDK import smoke 使用子进程: 隔离测试环境，避免污染当前进程<br>- 仅验证存在性和基本结构: 不验证功能完整性 (由 enabledFeatures.test.ts 负责) |
| **备选方案** | - 在当前进程 import SDK: 可能污染测试环境<br>- 使用 TypeScript 类型检查: 更慢，且不验证运行时可导入性 |
| **源码证据** | `tests/buildArtifacts.test.ts:1-33` |
| **测试证据** | 该模块自身就是测试 |

#### 模块 4.7: Feature Profile 验收 (tests/fixtures/verify-enabled-features.ts)

| 维度 | 详情 |
|------|------|
| **真实入口签名** | 无显式函数，作为脚本直接执行，接收 `outdir` 参数 |
| **关键类型** | - `FeatureProfile`: 验收输出对象 (toolCount, nullCount, toolNames, commandNames, sleepInitiallyEnabled, proactiveActive, sleepWhenActive, workerType, workerBackground, workerHasBash, workerHasAgent, reactiveCompactEnabled, hasHunterSkill, hasProactiveCommand, hasPeersCommand, hasRemoteControlServerCommand, hasWorkflowsCommand, hasBuddyCommand, hasForkCommand, hasForceSnipCommand, hasAssistantCommand, hasUltraplan, hasVoice, hasBrief) |
| **输入** | - 命令行参数: `outdir` (输出目录)<br>- `tests/fixtures/feature-check.ts`: fixture 入口<br>- `EXTERNAL_FEATURES`: 同一功能列表 |
| **输出** | - 控制台: `FEATURE_PROFILE=${JSON.stringify({ ... })}`<br>- 构建产物: `${outdir}/feature-check.js` |
| **验证配置** | - 与 `scripts/build.ts` 相同的 `features`、`define`、`loader` 配置<br>- 独立子进程加载 bundle，避免污染 |
| **验证流程** | 1. 读取 `outdir` 参数<br>2. 使用 `EXTERNAL_FEATURES` 和 `USER_TYPE: 'external'` 构建 `feature-check.ts`<br>3. 动态 import 构建后的 `feature-check.js`<br>4. 调用导出函数访问注册表:<br>   - `getAllBaseTools()` → 工具列表<br>   - `builtInCommandNames()` → 命令名称 Set<br>   - `getCoordinatorAgents()` → worker 列表<br>   - `isReactiveCompactEnabled()` → reactive compact 标志<br>   - `getBundledSkills()` → skill 列表<br>   - `initBundledSkills()` → 初始化 skill<br>   - `activateProactive('command')` / `deactivateProactive()` → 切换 proactive 状态<br>   - `isProactiveActive()` → proactive 状态<br>5. 验证 Sleep 工具初始 disabled、proactive 激活后 enabled<br>6. 输出 FEATURE_PROFILE JSON |
| **错误处理** | - 构建失败: 抛出错误，包含所有 logs<br>- 缺少 outdir 参数: 抛出错误 |
| **兼容性** | - 固定离线环境: 不依赖外部服务<br>- 子进程显式覆盖 env: 外层环境不影响 profile 结果 |
| **设计取舍** | - 动态 import 构建后的 bundle: 验收真实产物，而非源码<br>- 同一 EXTERNAL_FEATURES 列表: 确保验收与生产构建一致<br>- 验证行为而非仅数量: 确保工具正确注册和工作 |
| **备选方案** | - 仅源码测试: 不验证实际 bundle 内容<br>- 仅验证工具数量: 数量正确不代表注册正确<br>- 在当前进程测试: 可能污染测试环境 |
| **源码证据** | `tests/fixtures/verify-enabled-features.ts:1-79` |
| **测试证据** | 该模块是 `enabledFeatures.test.ts` 的基础设施 |

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

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | 当前无统一的 feature flag 清单，新增 flag 可能冲突或遗忘清理 | 实现统一的 feature flag 清单和生命周期管理 | 低：新增工具，不影响现有构建流程 | 测试清单生成和 flag 冲突检测 | M | 已证实（基于代码阅读） |
| P1 | internal-only 功能的边界不清晰，`USER_TYPE === 'ant'` 和 `EXTERNAL_FEATURES` 关系未明确 | 明确 internal-only 功能的边界，理清两者关系 | 低：文档和规范，不改变现有代码 | 编写清晰的边界规范文档 | S | 已证实（基于代码阅读） |
| P2 | 当前类型生成器仅支持 `export const *Schema` 格式，扩展性有限 | 增强类型生成器的可扩展性，支持更多 schema 定义方式 | 低：向后兼容，仅增加新格式支持 | 测试至少一种新 schema 格式能正确生成类型 | M | 已证实（基于代码阅读） |
| P2 | `enabledFeatures.test.ts` 需要重新构建和子进程加载，当前超时 180s/240s，未来可能成瓶颈 | 优化验收性能，减少构建和加载时间 | 低：优化测试流程，保持验收标准不变 | 测试验收时间明显减少 | M | 设计推断 |
| P2 | 当前无自动验证 `EXTERNAL_FEATURES` 覆盖率机制，可能遗漏未使用或缺失的 flag | 实现自动验证 `EXTERNAL_FEATURES` 与代码中 `feature()` 调用的覆盖率 | 低：新增验证工具，不改变现有构建 | 测试覆盖率报告能正确发现未使用或缺失的 flag | S | 设计推断 |
| P2 | 用户难以直观看到哪些功能在哪些 profile 中启用 | 实现 feature flag 可视化工具，显示功能启用矩阵 | 低：新增工具，不影响构建流程 | 测试可视化工具能正确显示各 profile 的功能启用状态 | S | 设计推断 |
| P3 | 无 bundle 大小预算监控，bundle 大小可能意外增长 | 增加 bundle 大小预算监控，防止超出阈值 | 低：可实现为可选的 CI 检查 | 测试预算监控能在超出阈值时发出警告 | S | 设计推断 |
| P3 | 当前每次全量构建，开发时构建时间长 | 实现增量构建，只重新构建变化的部分 | 中：需确保增量构建的正确性 | 测试增量构建能正确输出且时间明显减少 | M | 设计推断 |
| P3 | 当前验收主要验证功能存在，缺少更多维度 | 增加更多验收维度（性能、内存使用、启动时间等） | 低：新增验收项，不改变现有验收 | 测试新验收维度能正确收集数据 | M | 设计推断 |
| P3 | 无 feature flag 废弃流程，旧 flag 清理不安全 | 实现 feature flag 废弃流程，安全移除旧 flag | 低：定义流程规范，不改变现有代码 | 设计并文档化废弃流程 | S | 设计推断 |
| P3 | 当前无自动文档生成，功能清单需要手动维护 | 增加 feature flag 文档生成，自动生成功能清单和说明 | 低：新增工具，不影响构建流程 | 测试文档生成能正确输出功能清单 | S | 设计推断 |
| P3 | 当前无 A/B 测试支持，无法进行实验 | 实现 feature flag A/B 测试支持 | 中：需确保实验设计的安全性 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 当前 feature flag 在构建时确定，开发时无法动态切换 | 增加 feature flag 运行时切换支持（仅限开发环境） | 低：仅开发环境，不影响生产构建 | 测试开发环境能动态切换 flag | S | 设计推断 |
| P3 | 当前功能裁剪粒度较粗（feature 级），可更精细 | 实现更细粒度的功能裁剪（模块级、函数级） | 中：需确保裁剪的正确性 | 设计阶段验证技术方案 | M | 设计推断 |
| P3 | 当前无 feature flag 依赖关系管理，可能启用顺序错误 | 增加 feature flag 依赖关系管理，确保功能按正确顺序启用/禁用 | 中：需确保依赖关系的正确性 | 测试依赖关系检查能正确发现顺序错误 | M | 设计推断 |
