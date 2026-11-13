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

### 4.7 Schema 扫描模块设计卡

| 维度 | 细节 |
|------|------|
| **真实入口签名/关键类型** | ```typescript<br>// 源文件: scripts/generate-sdk-types.ts<br>export function generateSdkTypes(): void<br><br>type GenerationTarget = {<br>  schemaPath: string<br>  outputPath: string<br>  prelude?: string<br>}<br><br>const targets: GenerationTarget[] = [ ... ]<br>``` |
| **输入输出** | **输入**: UTF-8 编码的源码字符串<br>**输出**: `schemaNames: string[]` (提取的 schema 名称数组) |
| **Schema/声明状态** | 扫描状态仅存在于函数调用栈上；无持久化状态；每次生成重新扫描 |
| **解析/生成/验证流程** | 1. `readFileSync(target.schemaPath, 'utf8')` 读取源文件<br>2. `source.matchAll(/^export const (\w+Schema)\s*=/gm)` 正则匹配<br>3. `Array.from(..., match => match[1])` 收集匹配结果<br>4. `schemaNames.length === 0` 验证非空 |
| **错误与兼容** | **错误**: 空 schema 时抛出 `Error('No exported schemas found in ${target.schemaPath}')`<br>**兼容**: 仅匹配行首 `^export const`，忽略注释或缩进的；忽略 `export let`/`export var` |
| **设计取舍/备选** | **选择**: 正则 `/^export const (\w+Schema)\s*=/gm`<br>**理由**: 50 行总代码，性能 <10ms，无依赖<br>**备选**: TypeScript Compiler API (启动开销 ~300ms+，依赖重) / ts-morph (过度设计)<br>**限制**: 不支持多行声明、条件导出、动态命名 |
| **源码测试证据** | **源码**: `scripts/generate-sdk-types.ts:21-47`<br>**测试**: `tests/sdkTypeGeneration.test.ts:32-55` (验证空 schema 抛出错误) |

### 4.8 Zod 类型提取模块设计卡

| 维度 | 细节 |
|------|------|
| **真实入口签名/关键类型** | 无独立函数，内联在 `generateSdkTypes()` 中 |
| **输入输出** | **输入**: `schemaNames: string[]` (如 `['ModelUsageSchema', 'OutputFormatTypeSchema']`)<br>**输出**: `typeName: string` (如 `'ModelUsage'`) |
| **Schema/声明状态** | 无状态；纯字符串转换 |
| **解析/生成/验证流程** | 1. `schemaName.slice(0, -'Schema'.length)` 移除后缀<br>2. 映射为类型声明模板<br>3. 无单独验证，依赖后续 TypeScript 编译 |
| **错误与兼容** | **空输入**: 在上一模块已拦截<br>**无后缀 schema**: 实际不会发生，因为正则只匹配带 `Schema` 后缀的<br>**大小写**: 保留原样，如 `SDKHookCallbackMatcherSchema` → `SDKHookCallbackMatcher` |
| **设计取舍/备选** | **选择**: 简单字符串切片 `slice(0, -6)`<br>**理由**: 命名规范统一，无需更复杂逻辑<br>**备选**: 正则捕获组 `/^(.*?)Schema$/` (没必要)<br>**限制**: 不支持自定义后缀映射 |
| **源码测试证据** | **源码**: `scripts/generate-sdk-types.ts:33-36`<br>**示例**: `src/entrypoints/sdk/coreSchemas.ts:24-25` (定义) → `src/entrypoints/sdk/coreTypes.generated.ts:5-7` (输出) |

### 4.9 输出生成模块设计卡

| 维度 | 细节 |
|------|------|
| **真实入口签名/关键类型** | 无独立函数，内联在 `generateSdkTypes()` 中 |
| **输入输出** | **输入**: `schemaNames: string[]`, `target: GenerationTarget`<br>**输出**: 完整文件内容字符串 |
| **Schema/声明状态** | 无状态；纯模板生成 |
| **解析/生成/验证流程** | 1. **preamble**: 固定生成标记 + zod 导入 + schemas 命名空间导入<br>   ```typescript<br>   // Generated by scripts/generate-sdk-types.ts. Do not edit directly.<br>   import type { z } from 'zod'<br>   import type * as schemas from './${target.schemaPath.split('/').pop()?.replace(/\.ts$/, '.js')}'<br>   ```<br>2. **prelude**: 可选 (仅 controlTypes.ts 有: `export * from './coreTypes.js'\n\n`)<br>3. **类型声明**: `schemaNames.map(schemaName => ...)` 生成每个类型<br>   ```typescript<br>   export type ${typeName} = z.infer<<br>     ReturnType<typeof schemas.${schemaName}><br>   ><br>   ```<br>4. **拼接**: preamble + prelude + declarations 用 `\n\n` 连接 |
| **错误与兼容** | **幂等**: 多次生成相同输出 (内容无漂移)<br>**JSDoc**: 不继承 schema 的 JSDoc 注释 (非目标)<br>**import 路径**: `.ts` 替换为 `.js` (ES module 兼容) |
| **设计取舍/备选** | **选择**: `z.infer<ReturnType<typeof schemas.X>>`<br>**理由**: 天然支持 `lazySchema(() => ...)` 循环引用<br>**备选**: 生成具体类型结构 (复杂，循环引用难处理) / 直接 `z.infer<typeof schemas.X>` (不适用于函数返回的 schema)<br>**限制**: 类型定义不够直观 (IDE hover 才显示结构) |
| **源码测试证据** | **源码**: `scripts/generate-sdk-types.ts:33-40`<br>**示例**: `src/entrypoints/sdk/coreTypes.generated.ts:1-503` (完整输出)<br>**测试**: `tests/sdkTypeGeneration.test.ts:33-44` (验证包含预期声明) |

### 4.10 Settings 手写 re-export 模块设计卡

| 维度 | 细节 |
|------|------|
| **真实入口签名/关键类型** | 无代码生成，手写文件: `src/entrypoints/sdk/settingsTypes.generated.ts` |
| **输入输出** | **输入**: 无 (不参与自动生成)<br>**输出**: 手写 re-export |
| **Schema/声明状态** | 无状态；静态手写 |
| **解析/生成/验证流程** | **不参与流程**: settingsTypes.generated.ts 在 `targets` 数组中不存在<br>**手写内容**: `export type { SettingsJson as Settings } from '../../utils/settings/types.js'` |
| **错误与兼容** | **历史遗留**: 曾有独立 JSON schema 生成器，待恢复<br>**路径依赖**: 外部代码可能已引用 `settingsTypes.generated.ts`<br>**单一事实来源**: re-export 保证与 CLI 内部验证一致 |
| **设计取舍/备选** | **选择**: 手写 re-export + 保留 `.generated` 文件名<br>**理由**: 避免破坏性变更<br>**备选**: 迁移到 coreSchemas.ts 并自动生成 (迁移成本高) / 重命名移除 `.generated` (破坏外部)<br>**限制**: 类型更新需手动修改 |
| **源码测试证据** | **源码**: `src/entrypoints/sdk/settingsTypes.generated.ts:1-3`<br>**源类型**: `src/utils/settings/types.ts` (SettingsJson 定义位置)<br>**测试**: 无 (手写文件) |

### 4.11 构建与漂移检测模块设计卡

| 维度 | 细节 |
|------|------|
| **真实入口签名/关键类型** | 无独立模块；依赖 TypeScript 编译时检查 |
| **输入输出** | **输入**: 生成的类型文件 + schema 源文件<br>**输出**: TypeScript 编译错误 (漂移时) |
| **Schema/声明状态** | 无状态；依赖 TypeScript 类型系统 |
| **解析/生成/验证流程** | **无运行时检测**: 因为 `z.infer<ReturnType<typeof schemas.X>>` 直接绑定 schema<br>**漂移检测**: schema 变更但未重新生成 → TypeScript 编译时类型不匹配报错<br>**提交流程**: 开发者需手动运行 `bun scripts/generate-sdk-types.ts` 并提交生成文件 |
| **错误与兼容** | **空源文件防护**: `schemaNames.length === 0` → 抛出错误<br>**源文件不存在**: `readFileSync` 自然抛出异常<br>**写入权限**: `writeFileSync` 自然抛出异常 |
| **设计取舍/备选** | **选择**: 提交生成文件到 Git<br>**理由**: IDE 友好 (克隆后立即有类型提示)，可追溯，无构建依赖<br>**备选**: postinstall 生成 (IDE 体验差) / gitattributes 标记生成 (可追溯差)<br>**限制**: 需开发者记得重新生成 |
| **源码测试证据** | **源码**: `scripts/generate-sdk-types.ts:29-31` (空源文件防护)<br>**测试**: `tests/sdkTypeGeneration.test.ts:46-55` (验证空 schema 抛出错误)<br>**Git 证据**: `src/entrypoints/sdk/coreTypes.generated.ts` 已提交 |

### 4.12 export const 正则详解

正则表达式: `/^export const (\w+Schema)\s*=/gm`

| 组件 | 含义 |
|------|------|
| `^` | 行首锚点 (忽略注释、缩进的 schema) |
| `export const ` | 精确匹配导出常量声明 |
| `(\w+Schema)` | 捕获组: 一个或多个单词字符 + `Schema` 后缀 |
| `\s*=` | 可选空白 + 等号 (赋值开始) |
| `g` | 全局匹配 (多个 schema) |
| `m` | 多行模式 (`^` 匹配每行开头) |

**不匹配的情况**:
- `export let ModelUsageSchema = ...` (let 而非 const)
- `export var ModelUsageSchema = ...` (var 而非 const)
- `  export const ModelUsageSchema = ...` (缩进)
- `// export const ModelUsageSchema = ...` (注释)

### 4.13 Schema 后缀去名逻辑

转换规则: `schemaName.slice(0, -'Schema'.length)` 或等效的 `slice(0, -6)`

| 输入 | 输出 |
|------|------|
| `ModelUsageSchema` | `ModelUsage` |
| `SDKHookCallbackMatcherSchema` | `SDKHookCallbackMatcher` |
| `APIUserMessagePlaceholder` | (不会匹配，无 Schema 后缀) |

### 4.14 z.infer ReturnType 输出模式

所有生成的类型统一使用:

```typescript
export type ${typeName} = z.infer<
  ReturnType<typeof schemas.${schemaName}>
>
```

**为什么需要 ReturnType?**

因为所有 schema 都包裹在 `lazySchema(() => ...)` 中:

```typescript
// coreSchemas.ts
export const ModelUsageSchema = lazySchema(() =>
  z.object({ ... })
)

// typeof ModelUsageSchema 是函数类型
// ReturnType<typeof ModelUsageSchema> 才是 Zod 类型
// z.infer<...> 提取 TypeScript 类型
```

**为什么需要 lazySchema?**

支持循环引用，如 `SDKMessage` 联合类型可以引用自身或相互引用的类型。

### 4.15 coreTypes/controlTypes 与 settingsTypes.generated.ts 的区别

| 特性 | coreTypes.generated.ts | controlTypes.ts | settingsTypes.generated.ts |
|------|------------------------|-----------------|---------------------------|
| **生成方式** | 自动生成 | 自动生成 | 手写 |
| **源文件** | coreSchemas.ts | controlSchemas.ts | src/utils/settings/types.ts |
| **prelude** | 无 | `export * from './coreTypes.js'` | 无 |
| **是否在 targets 数组** | 是 | 是 | 否 |
| **文件名误导性** | 合理 (确实生成) | 合理 (确实生成) | 不合理 (手写但含 .generated) |

### 4.16 空 schema/malformed 输入处理

| 情况 | 处理方式 |
|------|----------|
| 源文件中无匹配的 schema | 抛出 `Error('No exported schemas found in ${target.schemaPath}')` |
| 源文件不存在 | `readFileSync` 自然抛出 `Error: ENOENT: no such file or directory` |
| 写入权限不足 | `writeFileSync` 自然抛出 `Error: EACCES: permission denied` |
| malformed 内容但有匹配 | 仍会生成，依赖 TypeScript 编译时报错 |
| 正则匹配到非 schema (如恰好叫 XSchema 的非 Zod) | 仍会生成，依赖 TypeScript 编译时报错 |

### 4.17 生成幂等与 JSDoc 不继承

**幂等性**:
- 多次运行生成器，输出文件内容相同
- 因为仅依赖 schema 名称和固定模板
- Git 不会显示无意义的变更

**JSDoc 不继承**:
- schema 上的 JSDoc 注释不会出现在生成的类型上
- 设计上不支持 (非目标)
- IDE hover 时仍可通过跳转到 schema 查看注释
- 如需继承，需要更复杂的 AST 解析 (当前正则方案不支持)

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
