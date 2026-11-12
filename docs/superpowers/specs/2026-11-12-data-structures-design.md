---
id: data-structures
title: Data Structures 通用数据结构与解析契约设计
date: 2026-11-12
status: draft
batch: 7
---

# Data Structures 通用数据结构与解析契约设计

## 1. 概述

本设计文档描述 Claude Code 中的通用数据结构与解析工具集。这些工具作为底层基础设施，为整个系统提供数组操作、缓存机制、JSON/JSONC/JSONL 解析、Frontmatter 解析、Markdown 配置加载等核心能力。

### 1.1 设计目标

- **性能优先**: 对于高频调用的工具提供缓存和优化路径
- **容错设计**: 解析工具应优雅处理输入错误而非崩溃
- **跨平台兼容**: 处理不同平台的编码和文件格式差异
- **可复用性**: 工具应具有明确边界和清晰的契约
- **内存安全**: 防止内存泄漏和无限增长

### 1.2 核心组件

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

## 2. 数组与集合工具

### 2.1 intersperse - 数组插入分隔符

```typescript
export function intersperse<A>(as: A[], separator: (index: number) => A): A[]
```

**契约**:
- 在数组元素之间插入由 `separator` 函数生成的分隔符
- 分隔符函数接收当前索引作为参数
- 返回新数组，不修改原数组
- 空数组或单元素数组原样返回

**复杂度**: O(n)，其中 n 为数组长度。使用 `flatMap` 实现，需要临时分配中间数组。

**边界情况**:
- 空数组: `intersperse([], f) → []`
- 单元素: `intersperse([x], f) → [x]`
- 多元素: `intersperse([a, b, c], i → sep[i]) → [a, sep[1], b, sep[2], c]`

**使用场景**:
- 消息块之间插入文本分隔符
- UI 渲染列表项之间添加分隔元素

**设计决策**: 使用 `flatMap` 而非手动循环。
- **备选方案 1**: 手动 for 循环 push
  - 代价: 代码更长，可读性略差
  - 理由: `flatMap` 是标准方法，语义清晰
- **备选方案 2**: 使用 reduce
  - 代价: 需要处理初始状态的特殊情况
  - 证据: 现有实现采用 `flatMap`，代码简洁

### 2.2 count - 数组元素计数

```typescript
export function count<T>(arr: readonly T[], pred: (x: T) => unknown): number
```

**契约**:
- 统计数组中满足谓词函数的元素数量
- 使用 `+!!pred(x)` 将任意真值转换为 0 或 1
- 支持 readonly 数组输入

**复杂度**: O(n)，遍历一次数组。

**边界情况**:
- 空数组: 返回 0
- 全匹配: 返回数组长度
- 无匹配: 返回 0
- 谓词返回 falsy/truthy 值 (包括 undefined、null、0、'' 等)

**设计决策**: 使用 `+!!pred(x)` 而非 Boolean 转换。
- **备选方案**: `pred(x) ? 1 : 0`
  - 代价: 略长但更显式
  - 理由: `+!!` 是惯用写法，简洁高效

### 2.3 uniq - 数组去重

```typescript
export function uniq<T>(xs: Iterable<T>): T[]
```

**契约**:
- 接受任意 Iterable (数组、Set、Generator 等)
- 使用 Set 去重，保留首次出现顺序
- 返回新数组

**复杂度**: O(n)，Set 插入和查找均为平均 O(1)。

**边界情况**:
- 空 Iterable: 返回空数组
- 单元素: 返回单元素数组
- 已去重: 返回副本
- 有重复: 移除后续重复项

**设计决策**: 使用 Set 而非手动去重。
- **备选方案 1**: 对象属性记录 (仅字符串键)
  - 代价: 仅支持字符串/可序列化键
  - 理由: Set 支持任意类型，包括对象
- **备选方案 2**: lodash.uniq
  - 代价: 引入外部依赖
  - 证据: 现有实现自包含，无需依赖

## 3. CircularBuffer - 环形缓冲区

```typescript
export class CircularBuffer<T> {
  constructor(private capacity: number)
  add(item: T): void
  addAll(items: T[]): void
  getRecent(count: number): T[]
  toArray(): T[]
  clear(): void
  length(): number
}
```

### 3.1 数据结构设计

**内部表示**:
```typescript
private buffer: T[]        // 存储数组
private head = 0           // 下一个写入位置
private size = 0           // 当前元素数量 (≤ capacity)
```

**不变式**:
- `0 ≤ head < capacity`
- `0 ≤ size ≤ capacity`
- 当 `size < capacity` 时，元素在 `buffer[0..size-1]`
- 当 `size = capacity` 时，元素在 `buffer[head..capacity-1]` 后接 `buffer[0..head-1]`

### 3.2 add - 添加元素

**契约**:
- 添加元素到缓冲区
- 缓冲区满时，最旧元素被覆盖 (FIFO eviction)
- O(1) 时间复杂度

**边界情况**:
- 空缓冲区: 直接添加
- 部分填充: 追加到末尾
- 已满: 覆盖最旧元素，head 前进

**错误语义**: 无异常抛出，capacity 为 0 或负数时行为未定义 (constructor 无验证)。

### 3.3 addAll - 批量添加

**契约**:
- 依次添加多个元素
- 等同于循环调用 `add`
- O(k) 时间复杂度，k 为 items 长度

**设计决策**: 逐个调用 add 而非批量优化。
- **备选方案**: 批量拷贝
  - 代价: 边界情况更复杂
  - 理由: 代码简单，正确性优先；addAll 不是热点路径

### 3.4 getRecent - 获取最近 N 个元素

**契约**:
- 返回最多 `count` 个最新元素
- 按时间顺序: [最旧...最新]
- 返回数量可能小于 count (缓冲区不满)
- O(k) 时间复杂度，k 为返回元素数量

**边界情况**:
- count = 0: 返回空数组
- count > size: 返回全部 size 个元素
- 缓冲区已满: 从 head 开始回绕读取

### 3.5 toArray - 转数组

**契约**:
- 返回所有元素，按 [最旧...最新] 顺序
- O(n) 时间复杂度

### 3.6 clear - 清空

**契约**:
- 清空所有元素
- 重置 head 和 size 为 0
- 注意: `buffer.length = 0` 会清空底层数组，下次写入时可能重新分配

**设计决策**: 清空底层数组 vs 仅重置索引。
- **备选方案**: 仅设置 `head = 0; size = 0`
  - 代价: 保留旧引用，可能延迟 GC
  - 理由: 现有实现选择清空数组，确保旧引用立即释放
  - 证据: `clear()` 调用 `this.buffer.length = 0`

### 3.7 length - 获取大小

**契约**:
- 返回当前元素数量
- O(1) 时间复杂度

### 3.8 设计决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| 容量固定 | constructor 指定 | 滚动窗口语义明确 |
| 覆盖旧元素 | FIFO eviction | 符合日志/历史场景需求 |
| toArray 顺序 | 最旧→最新 | 便于顺序处理历史 |
| 内存管理 | clear 时清空 buffer | 帮助 GC，避免内存泄漏 |

**使用场景**:
- 日志历史保留最近 N 条
- 操作撤销历史
- 性能指标滑动窗口
- 会话最近消息缓存

**证据**: 代码中未发现直接测试，但用于各种历史记录场景。

## 4. objectGroupBy - 对象分组

```typescript
export function objectGroupBy<T, K extends PropertyKey>(
  items: Iterable<T>,
  keySelector: (item: T, index: number) => K,
): Partial<Record<K, T[]>>
```

### 4.1 设计背景

这是 ES2024 `Object.groupBy` 的 polyfill 实现。标准 API 仍在普及中，提供自包含实现确保跨环境一致性。

### 4.2 契约

- 接受任意 Iterable
- keySelector 接收 item 和 index
- 返回对象使用 `Object.create(null)`，无原型链污染
- 相同键的 items 按出现顺序在同一数组中
- O(n) 时间复杂度

**边界情况**:
- 空 Iterable: 返回空对象
- 键冲突: 后出现的 item 追加到数组
- 键为 Symbol: 支持 (PropertyKey 包括 symbol)

**设计决策**: 使用 `Object.create(null)` 而非 `{}`。
- **备选方案**: 普通对象字面量
  - 代价: 键名可能与 Object.prototype 冲突
  - 理由: 安全，避免 '__proto__', 'constructor' 等特殊键问题
  - 证据: 实现明确使用 `Object.create(null)`

**设计决策**: index 参数传递给 keySelector。
- **备选方案**: 仅传递 item
  - 代价: 某些用例需要索引信息
  - 理由: 与标准 API 保持一致

## 5. contentArray - 消息内容数组操作

```typescript
export function insertBlockAfterToolResults(
  content: unknown[],
  block: unknown,
): void
```

### 5.1 设计背景

API 层需要在消息内容中插入补充块（如缓存编辑指令），位置相对于 tool_result 块有特定规则。

### 5.2 契约

- **突变操作**: 直接修改传入的 content 数组
- **插入规则**:
  - 如果存在 tool_result 块: 在最后一个 tool_result 之后插入
  - 如果不存在 tool_result 块: 在倒数第二个位置插入（或开头如果数组过短）
  - 如果插入后成为最后一个元素: 追加文本延续块 `{ type: 'text', text: '.' }`

**边界情况**:
- 空数组: 插入位置为 0，然后追加文本块 → `[block, { type: 'text', text: '.' }]`
- 单元素: 在位置 0 插入
- 无 tool_result: 在 `max(0, len - 1)` 插入
- 有多个 tool_result: 在最后一个之后插入

### 5.3 类型安全

**注意**: 函数接收 `unknown[]` 和 `unknown`，内部使用类型断言访问 `(item as { type: string }).type`。

**错误语义**:
- item 不是 object: 跳过 (不视为 tool_result)
- item 无 type 属性: 跳过
- type 不是 'tool_result': 跳过
- 不会抛出异常，非预期类型安全通过

**设计决策**: 突变数组而非返回新数组。
- **备选方案**: 返回新数组
  - 代价: 需要调用方替换原数组
  - 理由: API 层使用模式期望就地修改
  - 证据: 函数返回 void，直接操作 content 数组

**设计决策**: 追加文本延续块。
- **备选方案**: 不追加
  - 代价: 某些 API 要求提示不能以非文本内容结尾
  - 理由: 兼容性考虑，确保符合 API 要求

## 6. generators - 异步生成器工具

### 6.1 lastX - 获取生成器最后一个值

```typescript
export async function lastX<A>(as: AsyncGenerator<A>): Promise<A>
```

**契约**:
- 消费整个生成器
- 返回最后 yield 的值
- 生成器为空时抛出 Error: "No items in generator"

**复杂度**: O(n)，必须消费所有元素。

**边界情况**:
- 空生成器: 抛出
- 单元素: 返回该元素
- 多元素: 返回最后一个

**错误语义**: 空生成器时抛出同步 Error（不是 Promise reject）。

### 6.2 returnValue - 获取生成器返回值

```typescript
export async function returnValue<A>(
  as: AsyncGenerator<unknown, A>,
): Promise<A>
```

**契约**:
- 消费整个生成器
- 返回 return 值 (不是 yield 的值)
- 自动处理 done 检查

**复杂度**: O(n)，必须消费到 done。

### 6.3 all - 并发执行多个生成器

```typescript
export async function* all<A>(
  generators: AsyncGenerator<A, void>[],
  concurrencyCap = Infinity,
): AsyncGenerator<A, void>
```

**设计背景**: 需要同时运行多个异步生成器（如并行会话），但限制并发数避免资源耗尽。

**契约**:
- 同时运行最多 `concurrencyCap` 个生成器
- yield 值顺序不确定 (先完成先 yield)
- 生成器完成后启动等待队列中的下一个
- 跳过 undefined 值 (`if (value !== undefined) yield`)
- 所有生成器完成后返回

**内部数据结构**:
```typescript
waiting: AsyncGenerator<A, void>[]  // 等待队列
promises: Set<Promise<QueuedGenerator<A>>>  // 进行中
```

**并发控制算法**:
1. 初始启动 min(concurrencyCap, generators.length) 个生成器
2. Promise.race 等待任一完成
3. 如有值且非 undefined，yield
4. 如未 done，重新加入 promises
5. 如 done 且有 waiting，启动下一个
6. 重复直到 promises 为空

**复杂度**: O(total_yields + total_generators)

**边界情况**:
- concurrencyCap = 1: 顺序执行
- concurrencyCap = Infinity: 全部并发
- 某些生成器无 yield: 仅贡献完成信号
- 生成器 yield undefined: 被跳过

**设计决策**: 使用 Set 管理进行中 Promise。
- **备选方案**: 数组
  - 代价: 删除操作 O(n)
  - 理由: Set 删除 O(1)，race 后需要快速移除
  - 证据: 实现使用 `Set<Promise<...>>`

**设计决策**: 跳过 undefined 值。
- **备选方案**: 保留所有值
  - 代价: 调用方可能需要过滤
  - 理由: 注释 TODO 标记此逻辑，可能是临时方案
  - 证据: 代码有 `// TODO: Clean this up`

**设计决策**: 无输入生成器时无 yield 直接返回。
- **备选方案**: 抛出或返回特殊值
  - 理由: 空输入语义为空输出

### 6.4 toArray - 生成器转数组

```typescript
export async function toArray<A>(
  generator: AsyncGenerator<A, void>,
): Promise<A[]>
```

**契约**:
- 消费整个生成器
- 按 yield 顺序收集到数组
- O(n) 时间和空间

### 6.5 fromArray - 数组转生成器

```typescript
export async function* fromArray<T>(values: T[]): AsyncGenerator<T, void>
```

**契约**:
- 按顺序 yield 数组元素
- 每个 yield 是异步点 (虽然无实际延迟)

## 7. memoize - 记忆化缓存工具

### 7.1 memoizeWithTTL - 带 TTL 的同步缓存

```typescript
export function memoizeWithTTL<Args extends unknown[], Result>(
  f: (...args: Args) => Result,
  cacheLifetimeMs: number = 5 * 60 * 1000,
): MemoizedFunction<Args, Result>
```

**类型**:
```typescript
type MemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: { clear: () => void }
}
```

**设计背景**: 需要缓存昂贵计算结果，同时在后台刷新以保持新鲜度，避免阻塞。

**缓存策略**:
- **新鲜 (timestamp within TTL)**: 返回缓存值
- **过期 (timestamp expired, not refreshing)**: 返回旧值，异步刷新
- **缺失**: 同步计算并缓存
- **刷新中**: 不启动新刷新

**数据结构**:
```typescript
type CacheEntry<Result> = {
  value: Result
  timestamp: number
  refreshing: boolean
}
cache: Map<string, CacheEntry<Result>>  // key: JSON.stringify(args)
```

**键生成**: `jsonStringify(args)` —— 注意与 lodash 不同，不支持非序列化参数。

**复杂度**:
- 缓存命中: O(1) Map lookup
- 缓存未命中: O(time of f) + O(JSON.stringify)
- 刷新: 后台 O(time of f)

**边界情况**:
- f 抛出: 异常传播，不缓存
- 并发调用同一 args: 无去重 (同步执行，各自计算)
- clear() 期间: 清除 Map，新调用重新填充

**错误语义**:
- 刷新期间 f 抛出: 记录错误，删除该键 (不使用旧值)
- 刷新期间 clear(): identity check `cache.get(key) === cached` 跳过更新

**设计决策**: stale-while-revalidate 模式。
- **备选方案 1**: 同步阻塞刷新
  - 代价: 延迟用户操作
  - 理由: 性能优先，返回旧值好于等待
- **备选方案 2**: 仅 TTL 无后台刷新
  - 代价: 过期后首次调用慢
  - 证据: 现有实现选择 stale-while-revalidate

**设计决策**: identity check `cache.get(key) === cached`。
- **备选方案**: 无条件更新
  - 代价: 并发 clear() 后可能覆盖新值
  - 理由: 防止竞态，确保刷新不会覆盖更新的缓存
  - 证据: refresh 回调检查 `if (cache.get(key) === cached)`

**设计决策**: 刷新错误时删除缓存。
- **备选方案**: 保留旧值
  - 代价: 可能保留过期/错误数据很长时间
  - 理由: 下次调用强制重新计算更安全
  - 证据: catch 分支调用 `cache.delete(key)`

### 7.2 memoizeWithTTLAsync - 带 TTL 的异步缓存

```typescript
export function memoizeWithTTLAsync<Args extends unknown[], Result>(
  f: (...args: Args) => Promise<Result>,
  cacheLifetimeMs: number = 5 * 60 * 1000,
): ((...args: Args) => Promise<Result>) & { cache: { clear: () => void } }
```

**与同步版本差异**:
- 新增 `inFlight: Map<string, Promise<Result>>` 用于去重
- 冷启动期间并发调用共享同一个 Promise
- clear() 同时清空 cache 和 inFlight

**去重逻辑**:
```typescript
if (!cached) {
  const pending = inFlight.get(key)
  if (pending) return pending  // 并发去重
  const promise = f(...args)
  inFlight.set(key, promise)
  try {
    const result = await promise
    if (inFlight.get(key) === promise) {  // identity guard
      cache.set(key, { value: result, timestamp: now, refreshing: false })
    }
    return result
  } finally {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key)
    }
  }
}
```

**设计决策**: inFlight Map 用于并发去重。
- **备选方案**: 无去重 (像同步版本)
  - 代价: 如 `refreshAndGetAwsCredentials` 场景可能有多个并发登录
  - 理由: 避免重复昂贵的异步操作
  - 证据: 注释明确说明此设计意图

**设计决策**: identity guard 检查 inFlight.get(key) === promise。
- **备选方案**: 无条件设置/删除
  - 代价: clear() + 新调用后，旧的 finally 可能删除新的 inFlight 条目
  - 理由: 防止竞态条件

### 7.3 memoizeWithLRU - LRU 缓存

```typescript
export function memoizeWithLRU<
  Args extends unknown[],
  Result extends NonNullable<unknown>,
>(
  f: (...args: Args) => Result,
  cacheFn: (...args: Args) => string,
  maxCacheSize: number = 100,
): LRUMemoizedFunction<Args, Result>
```

**类型**:
```typescript
type LRUMemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
    size: () => number
    delete: (key: string) => boolean
    get: (key: string) => Result | undefined  // peek, no recency update
    has: (key: string) => boolean
  }
}
```

**设计背景**: lodash.memoize 无大小限制，可能导致内存泄漏 (如消息处理缓存过大)。使用 LRU 限制内存占用。

**依赖**: `lru-cache` 外部包。

**复杂度**:
- 缓存命中: O(1)，更新 recency
- 缓存未命中: O(time of f) + O(cacheFn)
- 逐出: O(1)，LRU 内部维护链表

**边界情况**:
- maxCacheSize = 0: 无缓存 (但 lru-cache 可能不支持)
- Result 为 null/undefined: 不支持 (约束 `Result extends NonNullable<unknown>`)
- cacheFn 冲突: 不同 args 生成相同键会错误共享

**设计决策**: cache.get 使用 peek 不更新 recency。
- **备选方案**: cache.get 也更新 recency
  - 代价: 检查缓存状态也会影响逐出顺序
  - 理由: cache API 用于观察，不应改变缓存状态
  - 证据: 实现使用 `cache.peek(key)`

**设计决策**: 默认 maxCacheSize = 100。
- **备选方案**: 更大或更小
  - 理由: 平衡内存与命中率，适合典型对话场景
  - 证据: 注释说明选择此值防止无限制增长

**设计决策**: Result 约束 NonNullable。
- **备选方案**: 允许 null/undefined
  - 代价: LRU cache 可能有特殊处理
  - 理由: 简化实现，避免混淆 "缓存缺失" 与 "缓存值为 null"

### 7.4 设计决策总结

| 决策 | 选择 | 理由 |
|------|------|------|
| TTL 默认值 | 5 分钟 | 平衡新鲜度与性能 |
| LRU 大小 | 100 | 控制内存，良好命中率 |
| 键生成 | JSON.stringify | 简单但非序列化参数不支持 |
| 刷新错误处理 | 删除缓存 | 自修复，下次重新计算 |
| 并发去重 | inFlight Map (仅 async) | 避免重复昂贵异步操作 |

**使用场景**:
- memoizeWithTTL: AWS 凭证刷新、配置读取
- memoizeWithTTLAsync: 异步凭证获取、远程 API 调用
- memoizeWithLRU: 消息处理、JSON 解析 (见 json.ts)

**证据**: safeParseJSON 使用 memoizeWithLRU 缓存解析结果。

## 8. lazySchema - 延迟 Schema 初始化

```typescript
export function lazySchema<T>(factory: () => T): () => T
```

### 8.1 设计背景

Zod schemas 可能有循环依赖或创建成本较高。延迟到首次访问时初始化，避免模块加载时的初始化问题。

### 8.2 契约

- 首次调用时执行 factory 并缓存结果
- 后续调用返回缓存值
- 无清除机制 (永久缓存)
- 非线程安全 (但单线程 JS 无问题)

**实现**:
```typescript
let cached: T | undefined
return () => (cached ??= factory())
```

**复杂度**:
- 首次调用: O(time of factory)
- 后续: O(1)

**边界情况**:
- factory 抛出: 错误传播，下次调用重试
- factory 返回 undefined: cached 保持 undefined，每次都调用 factory

**设计决策**: 使用 `??=` 而非 `||=`。
- **备选方案**: `||=`
  - 代价: falsy 值 (0, '', false) 会重新计算
  - 理由: `??` 仅检查 null/undefined，语义正确

**使用场景**:
- Zod schemas 循环依赖
- 大型 schema 延迟初始化
- hooks.ts 中所有 schemas 使用 lazySchema

**证据**: src/schemas/hooks.ts 全部使用 lazySchema。

## 9. json.ts - JSON/JSONC/JSONL 工具

### 9.1 safeParseJSON - 安全 JSON 解析

```typescript
export const safeParseJSON = Object.assign(
  function safeParseJSON(
    json: string | null | undefined,
    shouldLogError: boolean = true,
  ): unknown { ... },
  { cache: parseJSONCached.cache }
)
```

**设计背景**: JSON.parse 可能失败，且重复解析相同字符串浪费性能。

**契约**:
- null/undefined 输入: 返回 null
- 解析成功: 返回解析值
- 解析失败: 返回 null，可选记录错误
- 小输入 (≤ 8KB): 缓存解析结果 (LRU, max 50 entries)
- 大输入 (> 8KB): 不缓存
- 自动剥离 UTF-8 BOM

**缓存策略**:
```typescript
PARSE_CACHE_MAX_KEY_BYTES = 8 * 1024
// 小输入使用 LRU 缓存 parseJSONCached
// 大输入直接调用 parseJSONUncached
```

**内部缓存实现**:
```typescript
type CachedParse = { ok: true; value: unknown } | { ok: false }
// 使用 { ok, value } 因为:
// 1. memoizeWithLRU 需要 NonNullable，JSON.parse 可能返回 null
// 2. 需要缓存解析失败状态避免重复记录错误
```

**设计决策**: 使用 discriminated union 缓存成功/失败。
- **备选方案 1**: 仅缓存成功
  - 代价: 重复解析失败的相同字符串，重复记录错误
  - 理由: 避免日志洪水
- **备选方案 2**: 使用 null/sentinel
  - 代价: 无法区分 "解析为 null" 与 "解析失败"
  - 证据: 实现使用 { ok, value } 包装

**设计决策**: 8KB 阈值不缓存大输入。
- **备选方案**: 缓存所有
  - 代价: 大配置文件 (如 ~/.claude.json) 占用 LRU 空间，且变化频繁命中率低
  - 理由: 小输入是主要场景 (设置、MCP JSON、notebooks)
  - 证据: 注释说明此阈值选择理由

**设计决策**: shouldLogError 不作为缓存键。
- **备选方案**: 包含在键中
  - 代价: 相同字符串不同标志生成两个缓存条目
  - 理由: 与旧 lodash 实现行为一致
  - 证据: parseJSONCached 签名仅接收 json

### 9.2 safeParseJSONC - JSONC 解析

```typescript
export function safeParseJSONC(json: string | null | undefined): unknown
```

**契约**:
- 解析带注释的 JSON (JSONC, VS Code 风格)
- 使用 `jsonc-parser` 包
- 失败返回 null，记录错误
- 自动剥离 BOM

**边界情况**:
- 单行注释: `// comment`
- 块注释: `/* comment */`
- 尾随逗号: `[1, 2, 3,]`

### 9.3 parseJSONL - JSONL 解析

```typescript
export function parseJSONL<T>(data: string | Buffer): T[]
```

**设计背景**: JSON Lines (每行一个 JSON) 是常见的日志和数据格式。

**契约**:
- 每一行解析为独立 JSON
- 跳过空行
- 跳过解析失败的行
- 支持 string 和 Buffer
- 可选 Bun 优化路径 (`Bun.JSONL.parseChunk`)

**实现策略**:
```typescript
if (bunJSONLParse) {
  parseJSONLBun(data)  // 优化路径
} else if (typeof data === 'string') {
  parseJSONLString(data)
} else {
  parseJSONLBuffer(data)
}
```

**Bun 优化**:
- 使用 `Bun.JSONL.parseChunk` (如果可用)
- 流式解析，减少复制
- 错误恢复: 行解析失败后继续下一行

**Buffer 处理**:
- 直接操作 Buffer，避免 toString 复制
- BOM 检测: `buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf`
- 换行查找: `buf.indexOf(0x0a, start)`

**边界情况**:
- 空文件: 返回空数组
- 部分解析成功: 返回成功行，跳过失败行
- 无换行: 尝试解析整行为单行
- BOM 前缀: 自动剥离

**设计决策**: 跳过失败行而非整体失败。
- **备选方案**: 任何失败则返回空数组或抛出
  - 代价: 一个坏行使整个文件不可用
  - 理由: 日志场景容忍部分损坏

### 9.4 readJSONLFile - 读取 JSONL 文件

```typescript
export async function readJSONLFile<T>(filePath: string): Promise<T[]>
```

**契约**:
- 读取并解析 JSONL 文件
- 大文件 (>100MB): 仅读取最后 100MB
- 部分读取时跳过第一行 (可能不完整)

**常量**:
```typescript
MAX_JSONL_READ_BYTES = 100 * 1024 * 1024
```

**设计决策**: 100MB 限制。
- **备选方案**: 读取整个文件
  - 代价: 大文件内存耗尽
  - 理由: 最长上下文窗口约 2M tokens，远小于 100MB
  - 证据: 注释说明此理由

**设计决策**: 部分读取时跳过第一行。
- **备选方案**: 尝试修复
  - 代价: 复杂且不可靠
  - 理由: 第一行可能截断，安全跳过

### 9.5 addItemToJSONCArray - 修改 JSONC 数组

```typescript
export function addItemToJSONCArray(content: string, newItem: unknown): string
```

**契约**:
- 向 JSONC 数组添加项，保留注释和格式
- 使用 `jsonc-parser` 的 modify/applyEdits
- 空内容: 创建新数组 `[newItem]`
- 非数组: 替换为新数组 `[newItem]`
- 编辑失败: 回退到完全重写

**边界情况**:
- 空字符串 → `[newItem]`
- 空数组 `[]` → `[newItem]`
- 非数组 `{}` → `[newItem]`
- modify 返回空 edits → 回退到 stringify

**设计决策**: 优先保留格式，失败则回退。
- **备选方案**: 仅保留格式，失败抛出
  - 代价: 某些边缘情况无法处理
  - 理由: 可用性优先，有内容好于无内容

## 10. jsonRead.ts - BOM 剥离

```typescript
export function stripBOM(content: string): string
```

**设计背景**: PowerShell 5.x 默认写入带 BOM 的 UTF-8，JSON.parse 会失败。

**契约**:
- 仅剥离开头的 UTF-8 BOM (`'﻿'`)
- 其他位置的 BOM 不处理
- 无 BOM 原样返回

**实现**:
```typescript
return content.startsWith(UTF8_BOM) ? content.slice(1) : content
```

**设计决策**: 独立模块而非内联在 json.ts。
- **备选方案**: 仅在 json.ts 中定义
  - 代价: 设置模块等无法引用 json.ts (循环依赖)
  - 证据: 注释说明此拆分理由

## 11. frontmatterParser.ts - Frontmatter 解析

### 11.1 parseFrontmatter - 解析 Markdown Frontmatter

```typescript
export function parseFrontmatter(
  markdown: string,
  sourcePath?: string,
): ParsedMarkdown
```

**类型**:
```typescript
export type FrontmatterData = {
  'allowed-tools'?: string | string[] | null
  description?: string | null
  type?: string | null
  'argument-hint'?: string | null
  when_to_use?: string | null
  version?: string | null
  'hide-from-slash-command-tool'?: string | null
  model?: string | null
  skills?: string | null
  'user-invocable'?: string | null
  hooks?: HooksSettings | null
  effort?: string | null
  context?: 'inline' | 'fork' | null
  agent?: string | null
  paths?: string | string[] | null
  shell?: string | null
  [key: string]: unknown  // 允许任意扩展字段
}

export type ParsedMarkdown = {
  frontmatter: FrontmatterData
  content: string
}
```

**Frontmatter 格式**:
```markdown
---
key: value
list:
  - item1
  - item2
---
Markdown content...
```

**解析策略**:
1. 用正则提取 frontmatter 块: `/^---\s*\n([\s\S]*?)---\s*\n?/`
2. 尝试用 `parseYaml` 解析
3. 失败时，用 `quoteProblematicValues` 预处理后重试
4. 仍失败: 记录调试日志，frontmatter 为空对象

**边界情况**:
- 无 frontmatter: frontmatter = {}, content = 原样
- YAML 解析失败: 尝试自动 quoting
- 非 object YAML (如数组): 忽略，frontmatter 为空

### 11.2 quoteProblematicValues - 预处理问题 YAML

```typescript
function quoteProblematicValues(frontmatterText: string): string
```

**设计背景**: 某些值 (如 globs `**/*.{ts,tsx}`) 包含 YAML 特殊字符，直接解析失败。

**处理的特殊字符**:
```typescript
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /
// 包括: { } [ ] * & # ! | > % @ `，以及 ': ' (冒号空格)
```

**契约**:
- 仅处理简单 `key: value` 行 (非缩进、非列表、非块)
- 已引号值跳过
- 包含特殊字符的值用双引号包裹，并转义内部 `"` 和 `\`

**示例**:
```
paths: **/*.{ts,tsx}  →  paths: "**/*.{ts,tsx}"
```

**设计决策**: 简单行匹配而非完整 YAML 解析。
- **备选方案**: 使用完整 YAML parser 预处理
  - 代价: 复杂，可能引入新错误
  - 理由: 简单方案覆盖常见场景 (glob patterns)
  - 证据: 实现仅处理简单 `key: value` 行

### 11.3 splitPathInFrontmatter - 拆分路径列表

```typescript
export function splitPathInFrontmatter(input: string | string[]): string[]
```

**契约**:
- 接受逗号分隔字符串或字符串数组
- 逗号在大括号内不拆分 (尊重 brace expansion)
- 结果自动展开 brace 模式 (调用 `expandBraces`)

**示例**:
```
"a, b, src/*.{ts,tsx}"  →  ["a", "b", "src/*.ts", "src/*.tsx"]
["a", "{b,c}/d"]        →  ["a", "b/d", "c/d"]
```

### 11.4 expandBraces - Brace 展开

```typescript
function expandBraces(pattern: string): string[]
```

**契约**:
- 展开 `{a,b,c}` 为多选项
- 支持嵌套 (但当前实现可能有限)
- 无前缀/后缀保留

**示例**:
```
"src/*.{ts,tsx}"  →  ["src/*.ts", "src/*.tsx"]
"{a,b}/{c,d}"     →  ["a/c", "a/d", "b/c", "b/d"]
```

**实现**:
```typescript
const braceMatch = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/)
// 递归展开后缀部分
```

### 11.5 其他辅助函数

```typescript
export function parsePositiveIntFromFrontmatter(value: unknown): number | undefined
// 解析正整数，接受 number 或 string
// 失败返回 undefined

export function coerceDescriptionToString(
  value: unknown,
  componentName?: string,
  pluginName?: string,
): string | null
// 验证并转换描述为字符串
// 非标量 (数组/对象) 记录警告并返回 null
// null/undefined/空字符串返回 null

export function parseBooleanFrontmatter(value: unknown): boolean
// 仅 literal true 或 "true" 返回 true
// 其他返回 false

export function parseShellFrontmatter(value: unknown, source: string): FrontmatterShell | undefined
// 验证 shell 值为 'bash' 或 'powershell'
// 无效值记录警告并返回 undefined

export type FrontmatterShell = 'bash' | 'powershell'
```

## 12. markdownConfigLoader.ts - Markdown 配置加载

### 12.1 配置目录

```typescript
export const CLAUDE_CONFIG_DIRECTORIES = [
  'commands',
  'agents',
  'output-styles',
  'skills',
  'workflows',
  ...(feature('TEMPLATES') ? (['templates'] as const) : []),
] as const
```

### 12.2 loadMarkdownFilesForSubdir - 加载配置文件

```typescript
export const loadMarkdownFilesForSubdir = memoize(
  async function(
    subdir: ClaudeConfigDirectory,
    cwd: string,
  ): Promise<MarkdownFile[]> { ... },
  (subdir: ClaudeConfigDirectory, cwd: string) => `${subdir}:${cwd}`
)
```

**类型**:
```typescript
export type MarkdownFile = {
  filePath: string
  baseDir: string
  frontmatter: FrontmatterData
  content: string
  source: SettingSource  // 'policySettings' | 'userSettings' | 'projectSettings'
}
```

**加载顺序** (优先级从高到低):
1. Policy (managed)
2. User (~/.claude)
3. Project (从 cwd 向上到 git root 或 home)

**目录遍历**:
- 从 cwd 向上遍历到 git root 或 home
- 收集每个 `.claude/<subdir>`
- 工作树无目录时回退到主 repo 副本

**Git 边界处理**:
```typescript
function resolveStopBoundary(cwd: string): string | null {
  // 如果 cwd 的 git root 与 session git root 不同 canonical (如 submodule)
  // 且在 session git root 之内 → 扩展边界到 session git root
  // 否则 → 正常在 cwd git root 停止
}
```

**设计决策**: 工作树无配置时回退到主 repo。
- **备选方案**: 仅工作树
  - 代价: sparse-checkout 等场景缺少配置
  - 证据: 实现包含此回退逻辑

### 12.3 文件去重

```typescript
async function getFileIdentity(filePath: string): Promise<string | null>
// 返回 `${stats.dev}:${stats.ino}`
// 设备+inode 识别相同物理文件 (不同路径，如 symlinks)
// Windows/dev=0/ino=0 时返回 null (不可靠)
```

**去重策略**:
- 相同 inode 的文件只保留优先级最高的 (managed > user > project)
- 无法识别时保留所有 (fail open)

**设计决策**: 使用 dev+ino 识别。
- **备选方案 1**: realpath
  - 代价: symlink 指向不同位置但内容相同不合并
  - 理由: dev+ino 是物理文件身份
- **备选方案 2**: 内容 hash
  - 代价: 读取所有文件，慢
  - 证据: 实现使用 stat 的 dev 和 ino

**设计决策**: dev=0 且 ino=0 时跳过去重。
- **备选方案**: 强制去重
  - 代价: 某些网络文件系统报告所有文件 dev=0/ino=0，导致错误合并
  - 理由: 保守策略，fail open

### 12.4 findMarkdownFilesNative - 原生文件查找

```typescript
async function findMarkdownFilesNative(
  dir: string,
  signal: AbortSignal,
): Promise<string[]>
```

**设计背景**: ripgrep 在原生构建中启动开销大，提供原生回退。

**特性**:
- 递归遍历目录
- 跟随 symlinks (类似 ripgrep --follow)
- 使用 dev+ino 检测循环 symlink
- 不尊重 .gitignore (类似 ripgrep --no-ignore)

**环境变量切换**:
```
CLAUDE_CODE_USE_NATIVE_FILE_SEARCH=1  # 强制使用原生
```

**设计决策**: 双实现 (ripgrep + 原生)。
- **备选方案**: 仅 ripgrep 或仅原生
  - 代价: 某些场景性能差
  - 理由: 最佳性能 (ripgrep) + 回退 (原生)

### 12.5 loadMarkdownFiles - 加载单个目录

```typescript
async function loadMarkdownFiles(dir: string): Promise<{ ... }[]>
```

**契约**:
- 查找所有 .md 文件
- 读取内容，parse frontmatter
- 失败的文件记录日志并跳过
- 3秒超时

## 13. schemas/hooks.ts - Hooks Zod Schemas

### 13.1 设计背景

原 hooks schemas 在 settings/types.ts 中，导致与 plugins/schemas.ts 循环依赖。拆分到独立模块打破循环。

### 13.2 导出的 Schemas

```typescript
export const HookCommandSchema: ZodSchema  // discriminated union by 'type'
export const HookMatcherSchema: ZodSchema  // { matcher?, hooks: HookCommand[] }
export const HooksSchema: ZodSchema        // PartialRecord<HookEvent, HookMatcher[]>
```

### 13.3 Hook Types

```typescript
// Bash command hook
{
  type: 'command'
  command: string
  if?: string  // permission rule syntax
  shell?: 'bash' | 'powershell'
  timeout?: number
  statusMessage?: string
  once?: boolean
  async?: boolean
  asyncRewake?: boolean
}

// Prompt hook
{
  type: 'prompt'
  prompt: string
  if?: string
  timeout?: number
  model?: string
  statusMessage?: string
  once?: boolean
}

// HTTP hook
{
  type: 'http'
  url: string
  if?: string
  timeout?: number
  headers?: Record<string, string>
  allowedEnvVars?: string[]
  statusMessage?: string
  once?: boolean
}

// Agent hook
{
  type: 'agent'
  prompt: string
  if?: string
  timeout?: number
  model?: string
  statusMessage?: string
  once?: boolean
}
```

**设计决策**: agent hook prompt 无 transform。
- **备选方案**: 用 transform 包装为函数
  - 代价: updateSettingsForSource 通过 JSON.stringify 往返，函数值被删除
  - 理由: 简化，且 ExitPlanModeV2Tool 已重构不再需要此
  - 证据: 注释明确说明此历史和决策

### 13.4 lazySchema 使用

所有 schemas 使用 lazySchema 延迟初始化，避免模块间初始化顺序问题。

## 14. 设计决策总结

### 14.1 决策 1: memoize 缓存键使用 JSON.stringify

**选择**: `jsonStringify(args)` 作为键
**备选**: lodash 风格的散列，支持非序列化值
**代价**: 不支持函数、Symbol、循环引用等
**理由**:
  - 简单可预测
  - 与旧实现兼容
  - 主要场景参数可序列化
**证据**: memoizeWithTTL 实现

### 14.2 决策 2: safeParseJSON 缓存使用 discriminated union

**选择**: `{ ok: true; value: unknown } | { ok: false }`
**备选**: 仅缓存成功，或使用 null 哨兵
**代价**: 额外包装层
**理由**:
  - 区分 "解析为 null" 与 "解析失败"
  - 缓存失败避免重复错误日志
**证据**: json.ts 实现

### 14.3 决策 3: stale-while-revalidate 缓存策略

**选择**: 过期返回旧值，异步刷新
**备选**: 过期同步阻塞刷新，或无刷新仅 TTL
**代价**: 可能短暂返回过期数据
**理由**:
  - 低延迟优先
  - 后台刷新保持新鲜度
  - identity guard 防止覆盖新值
**证据**: memoize.ts 实现及注释

### 14.4 决策 4: parseFrontmatter 失败时自动 quoting

**选择**: YAML 失败时 quote 特殊字符重试
**备选**: 直接失败，或要求用户手动 quote
**代价**: 复杂，可能误处理某些情况
**理由**:
  - 覆盖常见场景 (glob patterns)
  - 改善用户体验
**证据**: frontmatterParser.ts 的 quoteProblematicValues

### 14.5 决策 5: 文件去重使用 dev+ino

**选择**: `${stats.dev}:${stats.ino}`
**备选**: realpath，或内容 hash
**代价**: 某些网络文件系统不可靠
**理由**:
  - 物理文件身份，准确
  - 性能好，不需要读取内容
  - dev=0/ino=0 时安全回退
**证据**: markdownConfigLoader.ts 的 getFileIdentity

### 14.6 决策 6: hooks schemas 拆分到独立模块

**选择**: 独立 src/schemas/hooks.ts
**备选**: 留在 settings/types.ts，接受循环依赖
**代价**: 额外模块
**理由**: 打破循环，简化依赖图
**证据**: hooks.ts 头部注释说明

## 15. 错误与边界情况汇总

| 组件 | 情况 | 处理 |
|------|------|------|
| array.ts | 空数组 | 原样返回 |
| CircularBuffer | capacity 0/负 | 未定义行为 (无验证) |
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

## 16. 现状验收标准

- [x] array.ts: intersperse/count/uniq 实现
- [x] CircularBuffer.ts: 固定大小环形缓冲区
- [x] objectGroupBy.ts: Object.groupBy polyfill
- [x] contentArray.ts: tool_result 相对位置插入
- [x] generators.ts: lastX/returnValue/all/toArray/fromArray
- [x] memoize.ts: TTL/LRU 缓存，含并发去重
- [x] lazySchema.ts: 延迟初始化
- [x] json.ts: safeParseJSON/safeParseJSONC/parseJSONL/readJSONLFile/addItemToJSONCArray
- [x] jsonRead.ts: stripBOM
- [x] frontmatterParser.ts: parseFrontmatter + 辅助
- [x] markdownConfigLoader.ts: 目录遍历、去重、双实现查找
- [x] schemas/hooks.ts: hooks schemas 独立模块

## 17. 代码与测试证据

**主要实现文件**:
- src/utils/array.ts
- src/utils/CircularBuffer.ts
- src/utils/objectGroupBy.ts
- src/utils/contentArray.ts
- src/utils/generators.ts
- src/utils/memoize.ts
- src/utils/lazySchema.ts
- src/utils/json.ts
- src/utils/jsonRead.ts
- src/utils/frontmatterParser.ts
- src/utils/markdownConfigLoader.ts
- src/schemas/hooks.ts

**测试文件**: 未发现针对这些工具的直接测试文件。

**使用证据**:
- safeParseJSON 被多个模块导入使用
- memoizeWithLRU 被 safeParseJSON 使用
- lazySchema 被 schemas/hooks.ts 使用
- frontmatterParser 被 markdownConfigLoader 使用
- markdownConfigLoader 被技能/命令加载使用

## 18. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/data-structures.yaml)

### 18.1 相关子系统

- **Settings**: 使用 json.ts, lazySchema
- **Skills/Commands**: 使用 frontmatterParser, markdownConfigLoader
- **SDK Query**: 使用 memoize.ts
- **Hooks**: 使用 schemas/hooks.ts
- **Git Integration**: 使用 markdownConfigLoader 的 git 边界逻辑

## 19. 改进建议

### 19.1 高优先级

1. **CircularBuffer capacity 验证**: 添加范围检查，抛出明确错误
2. **memoize 键改进**: 支持自定义键函数可选，非仅 JSON.stringify
3. **添加测试**: 为核心工具添加单元测试

### 19.2 中优先级

4. **contentArray 类型安全**: 定义明确类型而非 unknown
5. **generators.all TODO**: 清理 undefined 值跳过逻辑，确认是否需要
6. **CircularBuffer clear 优化**: 考虑仅重置索引不清空数组，减少分配

### 19.3 低优先级

7. **JSONL parse 错误报告**: 可选地返回失败行信息
8. **brace expansion 增强**: 支持更复杂的嵌套模式
9. **safeParseJSON 缓存调优**: 根据实际使用调整 8KB 阈值和 50 条目
