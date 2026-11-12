---
id: sdk-type-generation
batch: 0
title: SDK Type Generation Schema 驱动类型生成设计
date: 2026-11-12
status: draft
---

# SDK Type Generation Schema 驱动类型生成设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

SDK Type Generation 是一个基于 Zod Schema 自动生成 TypeScript 类型定义的轻量级系统。该系统通过解析 `*Schemas.ts` 文件中的导出 Zod schema，自动生成对应的 `z.infer<>` 类型，并保持与手写类型文件的兼容性。

### 约束条件

- 生成范围仅限 `coreTypes.generated.ts` 和 `controlTypes.ts`
- 输入来源仅限 `coreSchemas.ts` 和 `controlSchemas.ts` 中的导出 schema
- settings 类型（`settingsTypes.generated.ts`）是手写兼容层，不参与自动生成
- 无需完整 TypeScript 编译环境，仅通过简单正则匹配工作

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 使用正则匹配而非 AST 解析 | 使用 `/^export const (\\w+Schema)\\s*=/gm` 正则匹配导出的 schema | 当前 schema 定义模式统一且简单（`export const *Schema = lazySchema(() => ...)`）；正则方案性能开销极小（<10ms）；维护成本极低（50 行代码）；YAGNI：当前需求不需要复杂解析 | 使用 `@babel/parser` 或 `typescript` API 解析 AST：启动开销大（~300ms+），依赖复杂；使用 `ts-morph` 进行更高级的源码操作：过度设计 | 如果未来 schema 定义模式变化（如使用 `export let`、多行声明等），需要修改正则；无法处理更复杂的场景（如条件导出、动态命名等） | `scripts/generate-sdk-types.ts:1-999` |
| 提交生成文件到 Git | 生成文件直接提交到 Git，无需 `prebuild` 或 `postinstall` 钩子 | IDE 友好：克隆后立即有完整类型提示，无需任何前置步骤；可追溯性：类型变更随代码一起出现在 Git 历史中；可靠性：不依赖构建环境的一致性；性能：构建时无需额外步骤 | 在 `postinstall` 或 `prebuild` 时生成：IDE 体验差，需要先运行脚本；使用 `gitattributes` 标记为生成文件：可追溯性差 | 需要开发者记得在修改 schema 后重新生成；Git 历史中有生成代码的变更噪音 | `src/entrypoints/sdk/coreTypes.generated.ts` + `src/entrypoints/sdk/controlTypes.ts` |
| 使用 `z.infer<ReturnType<typeof schemas.X>>` 模式 | 由于所有 schema 都包裹在 `lazySchema(() => ...)` 中，需要 `ReturnType<>` 提取函数返回值类型 | `lazySchema` 允许循环引用的类型定义（如 `SDKMessage` 联合类型）；`z.infer<>` 保证类型与 schema 永远同步；无需维护复杂的类型生成逻辑 | 生成具体的类型定义（如 `{ inputTokens: number; ... }`）：循环引用需要特殊处理，无法利用 Zod 类型推导；使用 `z.infer<typeof schemas.X>` 直接推断：不适用，因为 schema 是函数返回值 | 类型定义不够直观（是 `z.infer<>` 而非具体结构）；JSDoc 注释不会继承到生成的类型中 | `src/entrypoints/sdk/coreTypes.generated.ts:1-999` |
| settingsTypes.generated.ts 作为手写兼容层 | `settingsTypes.generated.ts` 是手写兼容层，直接 re-export `SettingsJson` 类型 | 历史遗留：settings 曾有独立的 JSON Schema 生成器，目前待恢复；路径依赖：外部代码可能已经引用 `settingsTypes.generated.ts`；单一事实来源：`SettingsJson` 是 CLI 内部验证的源，SDK 直接 re-export 保证一致性 | 将 settings schema 迁移到 `coreSchemas.ts` 并参与自动生成：历史遗留，迁移成本高；重命名为 `settingsTypes.ts` 移除 `.generated` 误导：路径依赖，可能破坏外部代码 | 文件名 `settingsTypes.generated.ts` 具有误导性（实际是手写的）；settings 类型更新流程与其他 SDK 类型不一致 | `src/entrypoints/sdk/settingsTypes.generated.ts:1-999` |
| 空源文件防护 | 如果源文件中没有找到任何 schema，生成器会抛出错误而非生成空文件 | 快速失败，易于调试；防止生成不完整的类型文件 | 生成空文件：静默失败难以调试；跳过该目标：部分生成可能导致不一致 | 无（快速失败是好的） | `scripts/generate-sdk-types.ts:1-999` |

## 3. 目标与非目标

### 目标

- **单一事实来源**：Zod Schema 是类型定义的唯一来源，避免类型漂移
- **零依赖生成**：无需完整 TypeScript 编译环境，仅通过简单的正则匹配即可工作
- **IDE 友好**：生成的类型文件直接提交到仓库，提供即时的类型提示和自动补全
- **增量兼容**：手写类型文件（如 `settingsTypes.generated.ts`）可以与自动生成并存

### 非目标

- 不处理 settings 类型（手写兼容层）
- 不支持自定义类型映射
- 不继承 JSDoc 注释
- 不在构建时生成（文件直接提交）

## 4. 架构、模块与数据流

### 4.1 系统架构

```text
┌─────────────────────────────────────────────────────────────┐
│                  generate-sdk-types.ts                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 1. Schema Discovery: 正则匹配导出的 *Schema         │  │
│  │    /^export const (\\w+Schema)\\s*=/gm              │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │                                    │
│  ┌──────────────────────▼────────────────────────────────┐  │
│  │ 2. Name Resolution: 移除 Schema 后缀               │  │
│  │    ModelUsageSchema → ModelUsage                     │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │                                    │
│  ┌──────────────────────▼────────────────────────────────┐  │
│  │ 3. Type Generation: z.infer<> 模板                  │  │
│  └──────────────────────┬────────────────────────────────┘  │
│                         │                                    │
│  ┌──────────────────────▼────────────────────────────────┐  │
│  │ 4. File Writing: 带 preamble 和 prelude            │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │                      │                      │
         ▼                      ▼                      ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  coreSchemas.ts  │  │controlSchemas.ts│  │ (手写兼容层)     │
│   (源 Zod)       │  │   (源 Zod)       │  │settingsTypes...  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
         │                      │
         ▼                      ▼
┌──────────────────┐  ┌──────────────────┐
│coreTypes.generated│  │ controlTypes.ts  │
│   (生成的类型)   │  │   (生成的类型)   │
└──────────────────┘  └──────────────────┘
```

### 4.2 目标文件配置

```typescript
const targets: GenerationTarget[] = [
  {
    schemaPath: 'src/entrypoints/sdk/coreSchemas.ts',
    outputPath: 'src/entrypoints/sdk/coreTypes.generated.ts',
  },
  {
    schemaPath: 'src/entrypoints/sdk/controlSchemas.ts',
    outputPath: 'src/entrypoints/sdk/controlTypes.ts',
    prelude: "export * from './coreTypes.js'\n\n",
  },
]
```

### 4.3 生成输出文件结构

Preamble（文件头）：

所有生成文件都包含标准的生成标记：

```typescript
// Generated by scripts/generate-sdk-types.ts. Do not edit directly.
import type { z } from 'zod'
import type * as schemas from './coreSchemas.js'
```

Type Declaration 模板：

```typescript
export type ${typeName} = z.infer<
  ReturnType<typeof schemas.${schemaName}>
>
```

Prelude 支持：

`controlTypes.ts` 需要 re-export `coreTypes`，通过 `prelude` 字段实现：

```typescript
prelude: "export * from './coreTypes.js'\n\n"
```

生成结果：

```typescript
// Generated by scripts/generate-sdk-types.ts. Do not edit directly.
import type { z } from 'zod'
import type * as schemas from './controlSchemas.js'

export * from './coreTypes.js'

export type SDKHookCallbackMatcher = z.infer<
  ReturnType<typeof schemas.SDKHookCallbackMatcherSchema>
>
// ...
```

### 4.4 循环引用支持

通过 `lazySchema` 和 `z.infer<ReturnType<...>>` 天然支持循环引用，例如：

```typescript
// SDKMessage 是多个类型的联合，其中一些可能引用自身
export const SDKMessageSchema = lazySchema(() =>
  z.union([
    SDKAssistantMessageSchema(),
    SDKUserMessageSchema(),
    // ...
  ]),
)
```

### 4.5 外部类型占位符

对于从外部包导入的类型，使用 `z.custom<T>()` 作为占位符：

```typescript
// coreSchemas.ts
export const APIUserMessagePlaceholder = lazySchema(() =>
  z.custom<APIUserMessage>(),
)

// 生成的类型
export type APIUserMessagePlaceholder = z.infer<
  ReturnType<typeof schemas.APIUserMessagePlaceholder>
>
// 实际解析为 APIUserMessage 类型
```

### 4.6 哪些文件生成，哪些手写

| 文件 | 类型 | 说明 |
|---|---|---|
| `coreTypes.generated.ts` | 自动生成 | 每次运行都覆盖，不手动编辑 |
| `controlTypes.ts` | 自动生成 | 每次运行都覆盖，不手动编辑 |
| `settingsTypes.generated.ts` | 手写兼容层 | 虽然文件名含 generated，但是手写的 |

## 5. 失败语义与工程取舍

### 失败语义

| 失败模式 | 检测方式 | 处理 |
|---|---|---|
| 源文件无 schema | `schemaNames.length === 0` | 抛出错误，中止生成 |
| 源文件不存在 | `readFileSync` 异常 | 自然抛出，中止生成 |
| 写入权限不足 | `writeFileSync` 异常 | 自然抛出，中止生成 |

### 漂移检测：类型与 Schema 不一致

由于使用 `z.infer<>`, 类型定义与 Zod Schema 是编译时绑定的，不存在运行时漂移问题：

- 如果 Schema 变更但类型文件未重新生成，TypeScript 编译会报错
- `z.infer<>` 直接从 Schema 推导类型，无同步问题

### 工程取舍

| 取舍 | 当前选择 | 代价 |
|---|---|---|
| 解析方式 | 正则匹配 | 模式变化需修改正则 |
| 生成时机 | 提交生成文件 | 需记得重新生成 |
| 类型推导 | `z.infer<>` | 类型定义不够直观 |
| settings 类型 | 手写兼容层 | 文件名有误导性 |

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| `coreSchemas.ts` 有导出 `*Schema` | 运行生成器 | 生成 `coreTypes.generated.ts`，包含所有对应的 `z.infer<>` 类型 | 不能生成空文件 |
| `controlSchemas.ts` 有导出 `*Schema` | 运行生成器 | 生成 `controlTypes.ts`，包含所有对应的 `z.infer<>` 类型，且包含 prelude `export * from './coreTypes.js'` | 不能生成空文件 |
| 源文件无 schema | 运行生成器 | 抛出错误 | 不能生成空文件 |
| schema 变更但类型文件未重新生成 | 编译 | TypeScript 编译报错 | 不能编译通过 |
| `settingsTypes.generated.ts` | 修改 settings 类型 | 需手动修改，不参与自动生成 | 不能被生成器覆盖 |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 使用正则匹配而非 AST 解析 | `scripts/generate-sdk-types.ts:1-999` | `tests/sdkTypeGeneration.test.ts` | 有测试覆盖 |
| 提交生成文件到 Git | `src/entrypoints/sdk/coreTypes.generated.ts` + `src/entrypoints/sdk/controlTypes.ts` | 未测试（Git 行为） | 未测试 |
| 使用 `z.infer<ReturnType<typeof schemas.X>>` 模式 | `src/entrypoints/sdk/coreTypes.generated.ts:1-999` | `tests/sdkTypeGeneration.test.ts` | 有测试覆盖 |
| settingsTypes.generated.ts 作为手写兼容层 | `src/entrypoints/sdk/settingsTypes.generated.ts:1-999` | 未测试（手写文件） | 未测试 |
| 空源文件防护 | `scripts/generate-sdk-types.ts:1-999` | `tests/sdkTypeGeneration.test.ts` | 有测试覆盖 |

### 7.1 现有测试

- `tests/sdkTypeGeneration.test.ts`：验证正常生成路径、空源文件错误处理、生成内容包含预期的 re-export

### 7.2 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `scripts/generate-sdk-types.ts` | 生成器主逻辑 | 生成器主文件（约 50 行代码） |
| `src/entrypoints/sdk/coreSchemas.ts` | 核心类型 schema | 核心类型 schema 定义 |
| `src/entrypoints/sdk/controlSchemas.ts` | 控制面类型 schema | 控制面类型 schema 定义 |
| `src/entrypoints/sdk/coreTypes.generated.ts` | 生成的核心类型 | 生成的核心类型 |
| `src/entrypoints/sdk/controlTypes.ts` | 生成的控制面类型 | 生成的控制面类型 |
| `src/entrypoints/sdk/settingsTypes.generated.ts` | 手写 settings 兼容层 | 手写 settings 兼容层 |
| `src/utils/settings/types.ts` | SettingsJson 源定义 | settings 类型源定义 |

### 7.3 未覆盖场景（基于代码阅读）

- schema 定义模式变化（如使用 `export let`、多行声明等）
- 条件导出、动态命名等复杂场景
- JSDoc 注释继承

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/sdk-type-generation.yaml)

### 8.1 相关文件

- `scripts/generate-sdk-types.ts`：生成器主文件
- `src/entrypoints/sdk/coreSchemas.ts`：核心类型 schema 定义
- `src/entrypoints/sdk/controlSchemas.ts`：控制面类型 schema 定义
- `src/entrypoints/sdk/coreTypes.generated.ts`：生成的核心类型
- `src/entrypoints/sdk/controlTypes.ts`：生成的控制面类型
- `src/entrypoints/sdk/settingsTypes.generated.ts`：手写 settings 兼容层
- `src/utils/settings/types.ts`：settings 类型源定义

### 8.2 相关子系统

- SDK Query Sessions：使用生成的 SDK 类型
- Agent SDK：公开 API 使用生成的类型

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | 添加 Git hook 自动重新生成：当前需要开发者手动记得在修改 schema 后重新生成 | 添加 Git pre-commit hook 自动检测并重新生成 | 低（新增 hook，现有工作流不变） | 修改 schema 后 commit 时自动重新生成 | S | 已证实 |
| P2 | 改进 settings 类型生成：当前 `settingsTypes.generated.ts` 是手写兼容层，建议在 JSON Schema 生成器恢复后，将 settings schema 迁移到 `coreSchemas.ts` 并参与自动生成，同时重命名文件移除 `.generated` 误导 | 将 settings schema 迁移到 `coreSchemas.ts` 并参与自动生成，同时重命名文件移除 `.generated` 误导 | 中（需要迁移，可能破坏外部依赖） | settings 类型自动生成，文件名无误导 | M | 设计推断 |
| P2 | 支持 JSDoc 注释继承：当前生成的类型不继承 schema 中的 JSDoc 注释 | 添加注释解析和继承功能 | 低（新增功能，现有类型不变） | 生成的类型继承 JSDoc 注释 | M | 设计推断 |
| P3 | 添加模式变化的降级方案：当前正则匹配对 schema 定义模式变化敏感，建议添加更宽松的匹配或 AST 解析作为降级方案 | 添加更宽松的匹配或 AST 解析作为降级方案 | 低（新增降级，现有正则作为首选） | schema 定义模式变化时仍能工作 | M | 设计推断 |
| P3 | 添加更严格的漂移检测：虽然 `z.infer<>` 提供编译时同步保证，建议添加测试验证生成文件与 schema 同步 | 添加测试验证生成文件与 schema 同步 | 低（新增测试） | 测试验证生成文件与 schema 同步 | S | 设计推断 |
