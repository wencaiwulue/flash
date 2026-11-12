---
id: data-structures
batch: 7
title: Data Structures 通用数据结构与解析契约设计
date: 2026-11-12
status: draft
---

# Data Structures 通用数据结构与解析契约设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Data Structures 模块需要解决以下核心问题与约束：

- **性能优先**：高频调用工具需要缓存和优化路径
- **容错设计**：解析工具优雅处理输入错误而非崩溃
- **跨平台兼容**：处理不同平台编码和文件格式差异
- **可复用性**：工具具有明确边界和清晰契约
- **内存安全**：防止内存泄漏和无限增长
- **循环依赖避免**：模块拆分防止循环依赖
- **类型安全**：TypeScript 类型尽可能严格，但必要时降级

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| Intersperse 使用 flatMap 而非手动循环 | 现有实现采用 `flatMap` | `flatMap` 是标准方法，语义清晰 | 手动 for 循环 push：代码冗长；使用 reduce：语义不清晰 | 无（标准方法） | `src/utils/array.ts:1-999` |
| Count 使用 +!!pred(x) 而非 Boolean 转换 | `+!!pred(x)` 惯用写法 | 简洁高效 | `pred(x) ? 1 : 0`：稍冗长 | 略不直观 | `src/utils/array.ts:1-999` |
| Uniq 使用 Set 而非手动去重 | Set 支持任意类型，包括对象 | 无外部依赖，语义清晰 | 对象属性记录（仅字符串键）：类型限制；lodash.uniq：外部依赖 | 无（标准方法） | `src/utils/array.ts:1-999` |
| CircularBuffer clear 清空底层数组 | `clear()` 调用 `this.buffer.length = 0` | 确保旧引用立即释放，帮助 GC | 仅重置 head 和 size：旧引用可能不被立即 GC | 下次写入可能重新分配 | `src/utils/CircularBuffer.ts:1-999` |
| ObjectGroupBy 使用 Object.create(null) | Object.create(null) 无原型链污染 | 安全，避免 `__proto__`、`constructor` 等特殊键问题 | 普通对象字面量 `{}`：原型链污染风险 | 无（更安全） | `src/utils/objectGroupBy.ts:1-999` |
| ContentArray 突变数组而非返回新数组 | 函数返回 void，直接操作 content 数组 | API 层使用模式期望就地修改 | 返回新数组：不符合现有使用模式 | 不符合不可变数据习惯 | `src/utils/contentArray.ts:1-999` |
| Memoize 键使用 JSON.stringify | memoizeWithTTL 使用 JSON.stringify 作为键 | 简单可预测，与旧实现兼容，主要场景参数可序列化 | lodash 风格散列，支持非序列化值：复杂度高 | 不支持函数、Symbol、循环引用等 | `src/utils/memoize.ts:1-999` |
| SafeParseJSON 使用 discriminated union 缓存 | 区分"解析为 null"与"解析失败"，缓存失败避免重复错误日志 | 避免重复错误日志，区分 null 和失败 | 仅缓存成功：可能重复错误日志；使用 null 哨兵：无法区分 null 和失败 | 额外包装层 | `src/utils/json.ts:1-999` |
| Stale-while-revalidate 缓存策略 | 低延迟优先，后台刷新保持新鲜度，identity guard 防止覆盖新值 | 低延迟，同时保持数据新鲜度 | 过期同步阻塞刷新：延迟高；无刷新仅 TTL：数据可能过期 | 可能短暂返回过期数据 | `src/utils/memoize.ts:1-999` |
| LazySchema 使用 ??= 而非 ||= | `return () => (cached ??= factory())` | `??` 仅检查 null/undefined，语义正确 | `||=`：会把 falsy 值（0、''、false）也当作未初始化 | 无（语义正确） | `src/utils/lazySchema.ts:1-999` |
| ParseFrontmatter 失败时自动 quoting 重试 | quoteProblematicValues 自动 quote 特殊字符重试 | 覆盖常见场景（glob patterns），改善用户体验 | 直接失败：用户体验差；要求用户手动 quote：增加用户负担 | 复杂，可能误处理某些情况 | `src/utils/frontmatterParser.ts:1-999` |
| 文件去重使用 dev+ino | getFileIdentity 使用 dev+ino | 物理文件身份，准确；性能好，不需要读取内容；dev=0/ino=0 时安全回退 | realpath：可能不是同一文件；内容 hash：性能差 | 某些网络文件系统不可靠 | `src/utils/markdownConfigLoader.ts:1-999` |
| Hooks schemas 拆分到独立模块 | hooks.ts 独立，打破循环依赖 | 简化依赖图 | 留在 settings/types.ts：循环依赖 | 额外文件 | `src/schemas/hooks.ts:1-999` |

## 3. 目标与非目标

### 目标

- **性能优化**：高频操作（safeParseJSON、memoize）有缓存和优化路径
- **容错设计**：解析失败有优雅降级，不崩溃
- **明确契约**：每个函数有明确输入输出契约，边界情况清晰定义
- **内存安全**：CircularBuffer 防止无限增长，memoize 有大小限制
- **跨平台兼容**：处理 UTF-8 BOM、路径分隔符等平台差异
- **避免循环依赖**：模块拆分合理，无循环依赖

### 非目标

- **不替换 lodash**：不追求完整工具集，只实现项目特定需要
- **不提供通用序列化**：JSON.stringify 作为缓存键有局限，但不提供更复杂方案
- **不支持分布式缓存**：memoize 是进程内缓存
- **不提供验证框架**：lazySchema 只延迟初始化，不替代 Zod

## 4. 架构、模块与数据流

### 4.1 核心组件

| 组件 | 文件 | 职责 |
|---|---|---|
| 数组工具 | src/utils/array.ts | 数组插入、计数、去重 |
| 环形缓冲区 | src/utils/CircularBuffer.ts | 固定大小滚动窗口数据结构 |
| 对象分组 | src/utils/objectGroupBy.ts | Object.groupBy polyfill |
| 内容数组 | src/utils/contentArray.ts | API 消息内容块插入 |
| 生成器工具 | src/utils/generators.ts | 异步生成器并发和转换 |
| 记忆化缓存 | src/utils/memoize.ts | TTL/LRU 缓存装饰器 |
| 延迟 Schema | src/utils/lazySchema.ts | Zod schema 延迟初始化 |
| JSON 工具 | src/utils/json.ts | JSON/JSONC/JSONL 解析与修改 |
| JSON Read | src/utils/jsonRead.ts | BOM 剥离工具 |
| Frontmatter | src/utils/frontmatterParser.ts | Markdown frontmatter 解析 |
| Markdown 配置 | src/utils/markdownConfigLoader.ts | 配置目录遍历与加载 |
| Hooks Schema | src/schemas/hooks.ts | Zod schemas for hooks |

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `array.ts` | 无（纯函数） | `intersperse`、`count`、`uniq` | 其他数组操作 | 接收数组，返回数组或数字 |
| `CircularBuffer.ts` | `buffer`、`head`、`size`（实例变量） | `add`、`addAll`、`getRecent`、`toArray`、`clear`、`length` | 通用队列 | 提供固定大小滚动缓冲区 |
| `objectGroupBy.ts` | 无（纯函数） | `objectGroupBy` | 其他分组逻辑 | 接收 Iterable，返回无原型对象 |
| `contentArray.ts` | 无（纯函数） | `insertBlockAfterToolResults` | 其他内容操作 | 突变 content 数组，无返回值 |
| `generators.ts` | 无（纯函数） | `lastX`、`returnValue`、`all`、`toArray`、`fromArray` | 其他生成器操作 | 接收/返回 AsyncGenerator |
| `memoize.ts` | 缓存（闭包变量） | `memoizeWithTTL`、`memoizeWithTTLAsync`、`memoizeWithLRU` | 分布式缓存 | 接收函数，返回缓存函数 |
| `lazySchema.ts` | 无（纯函数） | `lazySchema` | 验证逻辑 | 接收 factory，返回延迟初始化函数 |
| `json.ts` | 缓存（模块变量） | `safeParseJSON`、`safeParseJSONC`、`parseJSONL`、`readJSONLFile`、`addItemToJSONCArray` | 其他 JSON 操作 | 接收 JSON 字符串/文件，返回解析结果 |
| `jsonRead.ts` | 无（纯函数） | `stripBOM` | 其他编码处理 | 接收 Buffer/string，返回 string |
| `frontmatterParser.ts` | 无（纯函数） | `parseFrontmatter`、`splitPathInFrontmatter`、`expandBraces`、`parsePositiveIntFromFrontmatter`、`coerceDescriptionToString`、`parseBooleanFromFrontmatter`、`parseShellFromFrontmatter` | 其他 markdown 解析 | 接收 markdown 字符串，返回解析结果 |
| `markdownConfigLoader.ts` | 缓存（模块变量） | `loadMarkdownFilesForSubdir`、`findMarkdownFilesNative` | 其他配置加载 | 接收目录，返回配置文件列表 |
| `hooks.ts` | 无（纯函数，lazySchema） | `HookCommandSchema`、`HookMatcherSchema`、`HooksSchema` | 其他 schemas | 提供 Zod schemas |

### 4.3 模块依赖

```text
settings/types.ts → schemas/hooks.ts (避免循环)
                  → utils/lazySchema.ts
                  → utils/memoize.ts
                  → utils/json.ts
                  → utils/jsonRead.ts
                  → utils/frontmatterParser.ts
                  → utils/markdownConfigLoader.ts

utils/json.ts → utils/memoize.ts
              → utils/jsonRead.ts

utils/frontmatterParser.ts → utils/json.ts

utils/markdownConfigLoader.ts → utils/frontmatterParser.ts
                             → utils/json.ts
                             → utils/memoize.ts
```

## 5. 失败语义与工程取舍

### 失败语义

| 组件 | 情况 | 处理 |
|---|---|---|
| array.ts | 空数组 | 原样返回 |
| CircularBuffer | capacity 0/负 | 未定义行为（无验证） |
| contentArray | 非 object item | 跳过，不视为 tool_result |
| generators.ts | 空生成器 | lastX 抛出 |
| memoize.ts | f 抛出 | 同步版本不缓存，异步版本传播 |
| memoize.ts | 刷新失败 | 删除缓存键 |
| lazySchema.ts | factory 返回 undefined | 每次重新调用 |
| json.ts | 大输入 (>8KB) | 不缓存 |
| json.ts | JSONL 部分行失败 | 跳过失败行 |
| frontmatter.ts | YAML 解析失败 | 尝试 quote 重试，仍失败则空对象 |
| markdownConfig | dev=0/ino=0 | 跳过去重 |
| markdownConfig | 工作树无配置 | 回退到主 repo |

### 工程取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| 缓存键 | JSON.stringify | 不支持非序列化值 | 简单可预测 |
| JSON 缓存 | 成功/失败都缓存 | 额外包装 | 避免重复错误日志 |
| 缓存策略 | stale-while-revalidate | 可能返回过期数据 | 低延迟 + 新鲜度 |
| JSONL 解析 | 跳过失败行 | 部分数据丢失 | 容错优先 |
| JSONL 读取 | 100MB 限制 + 跳过第一行 | 大文件不完整 | 防止 OOM |
| Frontmatter | 自动 quote 重试 | 可能误处理 | 改善用户体验 |
| 文件去重 | dev+ino | 某些 FS 不可靠 | 准确 + 高性能 |
| Hooks schemas | 独立模块 | 额外文件 | 打破循环依赖 |
| LazySchema | ??= 检查 | factory 返回 undefined 会重算 | 语义正确 |
| CircularBuffer | 清空 buffer | 可能重新分配 | 帮助 GC |

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| 数组 [1, 2, 3]，分隔符 0 | 调用 intersperse | 结果 [1, 0, 2, 0, 3] | 不能修改原数组 |
| 数组 [1, 2, 3, 4]，pred x => x > 2 | 调用 count | 结果 2 | 不能修改原数组 |
| 数组 [1, 2, 2, 3] | 调用 uniq | 结果 [1, 2, 3]，顺序保留 | 不能改变元素顺序 |
| CircularBuffer capacity 3 | add 1, 2, 3, 4 | toArray 返回 [2, 3, 4] | 不能超过 capacity |
| Iterable [1, 2, 3]，keySelector x => x % 2 | 调用 objectGroupBy | 返回 { 0: [2], 1: [1, 3] }，无原型 | 不能有原型链污染 |
| content 数组有 tool_result | 调用 insertBlockAfterToolResults | 块插入到最后一个 tool_result 之后 | 不能返回新数组，必须突变 |
| 空生成器 | 调用 lastX | 抛出 | 不能返回 undefined |
| 函数 f 调用 | 调用 memoizeWithTTL(f) | 第二次调用返回缓存值 | 不能每次都调用 f |
| factory 返回 schema | 调用 lazySchema(factory) | 第一次调用执行 factory，后续返回缓存 | 不能每次都调用 factory |
| JSON 字符串 | 调用 safeParseJSON | 返回解析结果，≤8KB 缓存 | 不能重复解析相同字符串 |
| JSONL 文件 | 调用 readJSONLFile | 跳过失败行，>100MB 只读最后 100MB | 不能 OOM |
| Markdown 有 frontmatter 且 YAML 失败 | 调用 parseFrontmatter | 尝试 quote 重试，仍失败则空对象 | 不能抛出 |
| 配置目录有多个文件，dev+ino 重复 | 调用 loadMarkdownFilesForSubdir | 按 dev+ino 去重 | 不能返回重复文件 |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| Intersperse 使用 flatMap | `src/utils/array.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| Count 使用 +!!pred(x) | `src/utils/array.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| Uniq 使用 Set | `src/utils/array.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| CircularBuffer clear 清空底层数组 | `src/utils/CircularBuffer.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| ObjectGroupBy 使用 Object.create(null) | `src/utils/objectGroupBy.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| ContentArray 突变数组 | `src/utils/contentArray.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| Memoize 键使用 JSON.stringify | `src/utils/memoize.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| SafeParseJSON 使用 discriminated union 缓存 | `src/utils/json.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| Stale-while-revalidate 缓存策略 | `src/utils/memoize.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| LazySchema 使用 ??= | `src/utils/lazySchema.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| ParseFrontmatter 失败时自动 quoting 重试 | `src/utils/frontmatterParser.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| 文件去重使用 dev+ino | `src/utils/markdownConfigLoader.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |
| Hooks schemas 拆分到独立模块 | `src/schemas/hooks.ts:1-999` | 未发现针对这些工具的直接测试文件 | 未找到直接测试覆盖 |

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `src/utils/array.ts` | `intersperse`、`count`、`uniq` | 数组工具函数 |
| `src/utils/CircularBuffer.ts` | `CircularBuffer`、`add`、`addAll`、`getRecent`、`toArray`、`clear`、`length` | 环形缓冲区 |
| `src/utils/objectGroupBy.ts` | `objectGroupBy` | 对象分组 polyfill |
| `src/utils/contentArray.ts` | `insertBlockAfterToolResults` | 内容数组操作 |
| `src/utils/generators.ts` | `lastX`、`returnValue`、`all`、`toArray`、`fromArray` | 生成器工具 |
| `src/utils/memoize.ts` | `memoizeWithTTL`、`memoizeWithTTLAsync`、`memoizeWithLRU` | 记忆化缓存 |
| `src/utils/lazySchema.ts` | `lazySchema` | 延迟 Schema 初始化 |
| `src/utils/json.ts` | `safeParseJSON`、`safeParseJSONC`、`parseJSONL`、`readJSONLFile`、`addItemToJSONCArray` | JSON 工具 |
| `src/utils/jsonRead.ts` | `stripBOM` | BOM 剥离 |
| `src/utils/frontmatterParser.ts` | `parseFrontmatter`、`splitPathInFrontmatter`、`expandBraces`、`parsePositiveIntFromFrontmatter`、`coerceDescriptionToString`、`parseBooleanFromFrontmatter`、`parseShellFromFrontmatter` | Frontmatter 解析 |
| `src/utils/markdownConfigLoader.ts` | `loadMarkdownFilesForSubdir`、`findMarkdownFilesNative` | Markdown 配置加载 |
| `src/schemas/hooks.ts` | `HookCommandSchema`、`HookMatcherSchema`、`HooksSchema` | Hooks Zod schemas |

### 7.2 未覆盖行为（基于代码阅读）

- 所有工具的单元测试（第 7 节无测试）
- CircularBuffer capacity 0/负的行为（当前未定义）
- Generators.all undefined 值跳过逻辑（需要确认是否需要）
- JSONL parse 失败行的错误报告（当前跳过）
- Brace expansion 复杂嵌套模式和范围表达式（当前支持有限）
- SafeParseJSON 缓存调优（8KB 阈值和 50 条目限制）
- MarkdownConfigLoader 并行读取（当前串行）

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/data-structures.yaml)

### 8.1 本 spec 主拥有的文件组

| 分组 | 主拥有职责 |
|---|---|
| array-utils | 数组工具函数 - intersperse（插入分隔符）、count（计数）、uniq（去重） |
| circular-buffer | 环形缓冲区 - 固定大小、FIFO 逐出、add/addAll/getRecent/toArray/clear/length |
| object-group-by | Object.groupBy polyfill - Iterable 分组、无原型链污染、index 参数 |
| content-array | 消息内容数组操作 - 在 tool_result 后插入块、自动追加文本延续 |
| generators | 异步生成器工具 - lastX（取最后值）、returnValue（取返回值）、all（并发控制）、toArray/fromArray |
| memoize | 记忆化缓存 - memoizeWithTTL（stale-while-revalidate）、memoizeWithTTLAsync（含 in-flight 去重）、memoizeWithLRU（基于 lru-cache） |
| lazy-schema | 延迟 Schema 初始化 - 模块加载时不创建，首次访问时调用 factory，避免循环依赖 |
| json-utils | JSON/JSONC/JSONL 工具 - safeParseJSON（带 LRU 缓存）、safeParseJSONC、parseJSONL、readJSONLFile、addItemToJSONCArray |
| json-read | BOM 剥离工具 - stripBOM，独立模块避免循环依赖，处理 PowerShell 5.x UTF-8 with BOM |
| frontmatter-parser | Frontmatter 解析 - parseFrontmatter（YAML 失败自动 quote 重试）、splitPathInFrontmatter、expandBraces、类型转换辅助 |
| markdown-config-loader | Markdown 配置加载 - 目录遍历（managed/user/project 优先级）、git 边界处理、dev+ino 去重、ripgrep/原生双实现 |
| hooks-schemas | Hooks Zod Schemas - 独立模块打破循环依赖，包含 HookCommandSchema/HookMatcherSchema/HooksSchema，全部使用 lazySchema |
| additional-files | 其他相关文件（constants、context、components、tools、types 等） |

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/utils/settings/*` → 主归 settings spec，本文只描述依赖边界
- `src/schemas/*`（除 hooks.ts）→ 主归其他 spec，本文只描述 hooks schemas
- `src/services/*` → 主归其他 spec，本文只描述依赖边界

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | CircularBuffer capacity 验证：当前无验证，0/负 capacity 行为未定义 | 添加范围检查，抛出明确错误而非未定义行为 | 低（新增验证，现有合法 usage 不受影响） | capacity 0/负时抛出明确错误 | S | 已证实 |
| P1 | Memoize 键改进：当前只支持 JSON.stringify，不支持非序列化值 | 支持自定义键函数作为选项，而非仅 JSON.stringify | 低（新增选项，默认行为不变） | 可以传入自定义键函数 | S | 已证实 |
| P1 | 测试缺口大（第 7 节无测试） | 添加单元测试：为核心工具添加单元测试，特别是边界情况 | 低（新增测试） | 每个核心工具都有对应测试文件 | M | 已证实 |
| P1 | ContentArray 类型安全：当前使用 unknown，类型不安全 | 定义明确类型而非 unknown，使用类型守卫 | 低（类型改进，运行时行为不变） | ContentArray 有明确类型，类型守卫验证 | S | 已证实 |
| P2 | `generators.all` 的 undefined 值处理：源码注释要求澄清跳过逻辑，当前行为缺少明确契约 | 明确 undefined 是否应跳过、保留或抛错，并补充边界测试 | 可能改变依赖当前跳过行为的调用方 | 新增 undefined 输入测试并固定预期行为 | S | 已证实 |
| P2 | CircularBuffer clear 优化：当前清空 buffer，可能导致重新分配 | 考虑仅重置索引不清空数组作为选项 | 低（新增选项，默认行为不变） | 可以选择仅重置索引 | S | 已证实 |
| P2 | JSONL parse 错误报告：当前跳过失败行，无错误报告 | 可选地返回失败行信息，用于调试 | 低（新增选项，默认行为不变） | 可以获取失败行信息 | M | 已证实 |
| P2 | Brace expansion 增强：当前支持有限，不支持复杂嵌套模式和范围表达式 | 支持更复杂的嵌套模式和范围表达式 | 低（新增功能，现有用法不受影响） | 可以解析更复杂的 brace 模式 | M | 已证实 |
| P3 | SafeParseJSON 缓存调优：当前 8KB 阈值和 50 条目限制，可能不是最优 | 根据实际使用调整 8KB 阈值和 50 条目限制 | 低（调优参数，行为不变） | 缓存命中率提升 | S | 设计推断 |
| P3 | Memoize 指标暴露：当前无指标，难以调优 | 暴露命中率/未命中率指标，用于调优 | 低（新增功能，默认行为不变） | 可以获取缓存命中率指标 | S | 设计推断 |
| P3 | MarkdownConfigLoader 并行读取：当前串行读取，可能慢 | 并行读取多个文件，提升加载速度 | 低（内部实现优化，接口不变） | 配置加载速度提升 | M | 设计推断 |
| P3 | LazySchema 清除支持：当前无清除方法，测试困难 | 添加 `.clear()` 方法清除缓存，用于测试 | 低（新增方法，默认行为不变） | 可以清除缓存 | S | 设计推断 |
