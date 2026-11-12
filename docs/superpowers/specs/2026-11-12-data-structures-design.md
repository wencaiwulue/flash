---
id: data-structures
batch: 7
title: Data Structures 通用数据结构与解析契约设计
date: 2026-11-12
status: draft
---

# Data Structures 通用数据结构与解析契约设计

## 1. 问题与约束

Data Structures 模块需要解决以下核心问题与约束：

1. **性能优先**：高频调用工具需要缓存和优化路径
2. **容错设计**：解析工具优雅处理输入错误而非崩溃
3. **跨平台兼容**：处理不同平台编码和文件格式差异
4. **可复用性**：工具具有明确边界和清晰契约
5. **内存安全**：防止内存泄漏和无限增长
6. **循环依赖避免**：模块拆分防止循环依赖
7. **类型安全**：TypeScript 类型尽可能严格，但必要时降级

## 2. 设计理由与备选方案

### 2.1 Intersperse 使用 flatMap 而非手动循环

- **备选方案**：手动 for 循环 push、使用 reduce
- **选择理由**：flatMap 是标准方法，语义清晰
- **证据**：现有实现采用 `flatMap`

### 2.2 Count 使用 +!!pred(x) 而非 Boolean 转换

- **备选方案**：`pred(x) ? 1 : 0`
- **选择理由**：`+!!` 是惯用写法，简洁高效
- **代价**：略不直观

### 2.3 Uniq 使用 Set 而非手动去重

- **备选方案**：对象属性记录（仅字符串键）、lodash.uniq
- **选择理由**：Set 支持任意类型，包括对象，无外部依赖
- **证据**：现有实现自包含

### 2.4 CircularBuffer clear 清空底层数组

- **备选方案**：仅重置 head 和 size
- **选择理由**：确保旧引用立即释放，帮助 GC
- **代价**：下次写入可能重新分配
- **证据**：`clear()` 调用 `this.buffer.length = 0`

### 2.5 ObjectGroupBy 使用 Object.create(null)

- **备选方案**：普通对象字面量 `{}`
- **选择理由**：安全，避免 `__proto__`、`constructor` 等特殊键问题
- **证据**：实现明确使用 `Object.create(null)`

### 2.6 ContentArray 突变数组而非返回新数组

- **备选方案**：返回新数组
- **选择理由**：API 层使用模式期望就地修改
- **代价**：不符合不可变数据习惯
- **证据**：函数返回 void，直接操作 content 数组

### 2.7 Memoize 键使用 JSON.stringify

- **备选方案**：lodash 风格散列，支持非序列化值
- **选择理由**：简单可预测，与旧实现兼容，主要场景参数可序列化
- **代价**：不支持函数、Symbol、循环引用等
- **证据**：memoizeWithTTL 实现

### 2.8 SafeParseJSON 使用 discriminated union 缓存

- **备选方案**：仅缓存成功、使用 null 哨兵
- **选择理由**：区分 "解析为 null" 与 "解析失败"，缓存失败避免重复错误日志
- **代价**：额外包装层
- **证据**：json.ts 实现

### 2.9 Stale-while-revalidate 缓存策略

- **备选方案**：过期同步阻塞刷新、无刷新仅 TTL
- **选择理由**：低延迟优先，后台刷新保持新鲜度，identity guard 防止覆盖新值
- **代价**：可能短暂返回过期数据
- **证据**：memoize.ts 实现及注释

### 2.10 LazySchema 使用 ??= 而非 ||=

- **备选方案**：`||=`
- **选择理由**：`??` 仅检查 null/undefined，语义正确
- **证据**：`return () => (cached ??= factory())`

### 2.11 ParseFrontmatter 失败时自动 quoting 重试

- **备选方案**：直接失败、要求用户手动 quote
- **选择理由**：覆盖常见场景（glob patterns），改善用户体验
- **代价**：复杂，可能误处理某些情况
- **证据**：frontmatterParser.ts 的 quoteProblematicValues

### 2.12 文件去重使用 dev+ino

- **备选方案**：realpath、内容 hash
- **选择理由**：物理文件身份，准确；性能好，不需要读取内容；dev=0/ino=0 时安全回退
- **代价**：某些网络文件系统不可靠
- **证据**：markdownConfigLoader.ts 的 getFileIdentity

### 2.13 Hooks schemas 拆分到独立模块

- **备选方案**：留在 settings/types.ts，接受循环依赖
- **选择理由**：打破循环，简化依赖图
- **证据**：hooks.ts 头部注释说明

## 3. 目标与非目标

### 3.1 目标

1. **性能优化**：高频操作（safeParseJSON、memoize）有缓存和优化路径
2. **容错设计**：解析失败有优雅降级，不崩溃
3. **明确契约**：每个函数有明确输入输出契约，边界情况清晰定义
4. **内存安全**：CircularBuffer 防止无限增长，memoize 有大小限制
5. **跨平台兼容**：处理 UTF-8 BOM、路径分隔符等平台差异
6. **避免循环依赖**：模块拆分合理，无循环依赖

### 3.2 非目标

1. **不替换 lodash**：不追求完整工具集，只实现项目特定需要
2. **不提供通用序列化**：JSON.stringify 作为缓存键有局限，但不提供更复杂方案
3. **不支持分布式缓存**：memoize 是进程内缓存
4. **不提供验证框架**：lazySchema 仅延迟初始化，不替代 Zod

## 4. 架构、模块与数据流

### 4.1 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
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

### 4.2 模块依赖

```
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

### 5.1 失败语义

| 组件 | 情况 | 处理 |
|------|------|------|
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

### 5.2 工程取舍

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
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

### 6.1 功能验收标准

- **数组工具**：
  - `intersperse()` 在元素间插入分隔符
  - `count()` 统计满足谓词的元素
  - `uniq()` 去重并保留顺序

- **CircularBuffer**：
  - `add()` 添加元素，满时覆盖最旧
  - `addAll()` 批量添加
  - `getRecent()` 返回最近 N 个
  - `toArray()` 返回所有元素，旧→新
  - `clear()` 清空
  - `length()` 返回当前大小

- **ObjectGroupBy**：
  - 接受 Iterable
  - keySelector 接受 item 和 index
  - 返回无原型对象

- **ContentArray**：
  - `insertBlockAfterToolResults()` 突变数组
  - 有 tool_result 时在最后一个之后插入
  - 无 tool_result 时在倒数第二个位置插入
  - 插入后在末尾时追加文本延续块

- **Generators**：
  - `lastX()` 返回最后一个 yield 值，空生成器抛出
  - `returnValue()` 返回 return 值
  - `all()` 并发执行，concurrencyCap 控制，跳过 undefined
  - `toArray()` 收集到数组
  - `fromArray()` 从数组创建生成器

- **Memoize**：
  - `memoizeWithTTL()` 同步缓存，TTL 默认 5 分钟，过期后台刷新
  - `memoizeWithTTLAsync()` 异步缓存，并发去重
  - `memoizeWithLRU()` LRU 缓存，默认 max 100，支持 peek/delete/has
  - 所有缓存支持 `.cache.clear()`

- **LazySchema**：
  - `lazySchema(factory)` 首次调用执行 factory，后续返回缓存
  - factory 抛出时传播，下次重试
  - factory 返回 undefined 时每次重调用

- **JSON 工具**：
  - `safeParseJSON()` 解析 JSON，null/undefined 返回 null，失败返回 null，≤8KB 缓存
  - `safeParseJSONC()` 解析 JSONC
  - `parseJSONL()` 解析 JSONL，跳过失败行，支持 Buffer/string，Bun 优化
  - `readJSONLFile()` 读取 JSONL 文件，>100MB 仅读最后 100MB，部分读取跳过第一行
  - `addItemToJSONCArray()` 修改 JSONC 数组，保留格式，失败回退到完全重写

- **JSON Read**：
  - `stripBOM()` 剥离开头 UTF-8 BOM

- **Frontmatter Parser**：
  - `parseFrontmatter()` 解析 Markdown frontmatter
  - YAML 失败时自动 quote 特殊字符重试
  - `splitPathInFrontmatter()` 拆分路径，尊重 brace expansion
  - `expandBraces()` 展开 brace 模式
  - `parsePositiveIntFromFrontmatter()` 解析正整数
  - `coerceDescriptionToString()` 验证描述
  - `parseBooleanFrontmatter()` 解析 boolean
  - `parseShellFrontmatter()` 验证 shell

- **Markdown Config Loader**：
  - `loadMarkdownFilesForSubdir()` 按优先级加载配置文件
  - 从 cwd 向上遍历到 git root 或 home
  - 工作树无配置时回退到主 repo
  - 按 dev+ino 去重，dev=0/ino=0 时跳过去重
  - `findMarkdownFilesNative()` 原生实现，支持 CLAUDE_CODE_USE_NATIVE_FILE_SEARCH

- **Hooks Schemas**：
  - `HookCommandSchema`  discriminated union by type
  - `HookMatcherSchema` { matcher?, hooks: HookCommand[] }
  - `HooksSchema` PartialRecord<HookEvent, HookMatcher[]>
  - 所有 schema 使用 lazySchema

## 7. 代码与测试证据

### 7.1 核心实现文件

- **数组工具**：`src/utils/array.ts`
- **CircularBuffer**：`src/utils/CircularBuffer.ts`
- **ObjectGroupBy**：`src/utils/objectGroupBy.ts`
- **ContentArray**：`src/utils/contentArray.ts`
- **Generators**：`src/utils/generators.ts`
- **Memoize**：`src/utils/memoize.ts`
- **LazySchema**：`src/utils/lazySchema.ts`
- **JSON 工具**：`src/utils/json.ts`
- **JSON Read**：`src/utils/jsonRead.ts`
- **Frontmatter Parser**：`src/utils/frontmatterParser.ts`
- **Markdown Config Loader**：`src/utils/markdownConfigLoader.ts`
- **Hooks Schemas**：`src/schemas/hooks.ts`

### 7.2 测试覆盖

未发现针对这些工具的直接测试文件，但有大量使用证据：
- `safeParseJSON` 被多个模块导入使用
- `memoizeWithLRU` 被 `safeParseJSON` 使用
- `lazySchema` 被 `schemas/hooks.ts` 使用
- `frontmatterParser` 被 `markdownConfigLoader` 使用
- `markdownConfigLoader` 被技能/命令加载使用

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/data-structures.yaml)

### 8.1 相关子系统

- **Settings System**：使用 json.ts、lazySchema、markdownConfigLoader
- **Skills/Commands System**：使用 frontmatterParser、markdownConfigLoader
- **SDK Query**：使用 memoize.ts、CircularBuffer
- **Hook System**：使用 schemas/hooks.ts
- **Git Integration**：使用 markdownConfigLoader 的 git 边界逻辑
- **Session System**：使用 json.ts 解析 JSONL 会话文件

## 9. 改进建议

### 9.1 高优先级改进

1. **CircularBuffer capacity 验证**：添加范围检查，抛出明确错误而非未定义行为
2. **Memoize 键改进**：支持自定义键函数作为选项，而非仅 JSON.stringify
3. **添加测试**：为核心工具添加单元测试，特别是边界情况
4. **ContentArray 类型安全**：定义明确类型而非 unknown，使用类型守卫

### 9.2 中优先级改进

5. **Generators.all TODO**：清理 undefined 值跳过逻辑，确认是否需要，或明确文档说明
6. **CircularBuffer clear 优化**：考虑仅重置索引不清空数组作为选项，减少分配
7. **JSONL parse 错误报告**：可选地返回失败行信息，用于调试
8. **Brace expansion 增强**：支持更复杂的嵌套模式和范围表达式

### 9.3 低优先级改进

9. **SafeParseJSON 缓存调优**：根据实际使用调整 8KB 阈值和 50 条目限制
10. **Memoize 指标暴露**：暴露命中率/未命中率指标，用于调优
11. **MarkdownConfigLoader 并行读取**：并行读取多个文件，提升加载速度
12. **LazySchema 清除支持**：添加 `.clear()` 方法清除缓存，用于测试
