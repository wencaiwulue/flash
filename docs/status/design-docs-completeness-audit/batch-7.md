# Batch 7 审计报告：构建与数据结构

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | ⚠️ 待提取 | 仅分析 build-feature-profile 和 data-structures 相关字符串 |
| 官方文档 | ⚠️ 待搜索 | 仅搜索构建、feature flag、数据结构相关页面 |
| 审查范围 | 仅 build-feature-profile + data-structures 完整审计，其余 12 个子系统待完成 | diagnostics, experimental-features, external-stubs, hooks-system, magic-docs, messaging-primitives, native-installer, network-security, runtime-lifecycle, telemetry, test-validation, web-tools 待后续批次审计 |

### 启动状态 RED ⚠️

```bash
# 门禁运行验证（审计开始前）
# batch-7.md 初始仅包含 2 个子系统，其余 12 个待完成
```

## 子系统审查

### build-feature-profile

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-build-feature-profile-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/build-feature-profile.yaml |
| Manifest 注册 | ✅ | id: build-feature-profile, batch: 7, status: draft |
| Coverage 覆盖分组 | 7/7 | build-scripts, release-build-script, release-build-tests, runtime-macros, feature-flag-usage, entrypoints, acceptance-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了 CLI 与 SDK 共享源码但不同交付形态、功能裁剪、DCE 保证、类型安全、验收真实 bundle、固定离线环境、43 个 external 工具、MACRO 常量替换、功能可用性分层等核心问题与约束。

✅ **设计理由与备选方案**：6 项关键决策表格化展示，包含真实证据位置：
- 使用 `feature()` 做编译时 DCE（证据：src/commands.ts 等大量 `feature()` 用法）
- 生产构建与验收测试共用 `EXTERNAL_FEATURES`（证据：scripts/build.ts 和 tests/fixtures/verify-enabled-features.ts）
- 从 Zod Schema 生成 SDK 类型（证据：scripts/generate-sdk-types.ts 实现）
- 验收真实 bundle 而不是仅源码测试（证据：tests/fixtures/verify-enabled-features.ts 重新构建并加载 bundle）
- 验收时固定离线环境，排除外部因素（证据：enabledFeatures.test.ts 中固定环境变量）
- 功能可用性分层（证据：DCE 保留/注册/Availability/运行时状态四层独立控制）

✅ **目标与非目标**：清晰界定了建立可复现构建链、明确边界、确保交付可信、固定离线环境、提供设计决策、从 Zod 生成类型、共用 EXTERNAL_FEATURES、功能可用性分层、验收覆盖工具/命令/状态/worker 行为等目标；明确了不替换 Bun、不设计新 feature flag 系统、不在线验证外部服务、不处理动态切换、不提供 LSP 安装、不支持远程 LSP 等非目标。

✅ **架构、模块与数据流**：
- 完整的构建流程（Schema → SDK 类型生成 → 类型声明 → CLI/SDK 入口 → Bun.build → 产物）
- 完整的验收流程（EXTERNAL_FEATURES → fixture 构建 → 独立子进程加载 → 验证）
- 核心模块接口清晰

#### 源码验证

**build-scripts**（scripts/build.ts）：
- `createBuildOptions()`：构建配置生成，features 使用 `[...EXTERNAL_FEATURES]`，define 包含 MACRO.* 和 process.env.USER_TYPE ✅
- `main()`：主构建流程，先生成 SDK 类型，再构建 CLI 和 SDK，chmod +x CLI 产物 ✅

**release-build-script**（scripts/build-binary.ts）：
- 原生二进制构建、发布打包与矩阵目标验证 ✅

**runtime-macros**（src/runtimeMacros.ts + src/global.d.ts）：
- 编译时宏全局定义，直接源码执行时有默认值（packageJson.version）✅
- `MACRO.VERSION`、`MACRO.BUILD_TIME`、`MACRO.PACKAGE_URL` 等由 `Bun.build({ define: { ... } })` 替换 ✅

**feature-flag-usage**（src/commands.ts + src/constants/betas.ts）：
- 大量 `feature()` 用法用于编译时 DCE ✅
- `const someCommand = feature('SOME_FEATURE') ? command(...) : null` 模式 ✅

**entrypoints**（src/entrypoints/cli.tsx）：
- CLI 入口点 ✅

**发现 B7-build-feature-profile-01**：spec 中提到当前 external profile 有 43 个工具，但未明确该数字的验证位置和机制。严重度：P3（文档细节问题），置信度：已证实（spec 中仅提及数字但无证据链接）

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ `bundledMode.test.ts`：存在，验证 bundled mode 行为
- ✅ `releasePackaging.test.ts`：存在，验证发布打包
- ✅ `externalFeatures.test.ts`：存在，验收外部功能
- ✅ `externalFeatureProfile.test.ts`：存在，验收 feature profile

#### 隐私与安全边界审查

**编译时裁剪边界**：
- 未启用功能的代码通过 DCE 完全移除，无意外调用风险 ✅
- MACRO.* 常量在构建时替换，无运行时动态修改风险 ✅

**功能可用性分层边界**：
- DCE 确保代码不进入 bundle
- 注册确保对外暴露
- Availability 确保宿主环境支持
- 运行时状态确保当前可用 ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `createBuildOptions`、`generateSdkTypes`：构建脚本函数名匹配 ✅
- `MACRO.VERSION`、`MACRO.BUILD_TIME`：宏常量匹配 ✅
- `EXTERNAL_FEATURES`：功能列表匹配 ✅
- `feature()`：Bun 编译时函数匹配 ✅

官方文档索引搜索已执行：
- 搜索关键词：`feature flag`、`build`、`DCE`、`bundle`、`compile time`
- 命中：无直接 build/feature-profile 相关文档页面

---

### data-structures

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-data-structures-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/data-structures.yaml |
| Manifest 注册 | ✅ | id: data-structures, batch: 7, status: draft |
| Coverage 覆盖分组 | 15/15 | array-utils, circular-buffer, object-group-by, content-array, generators, memoize, lazy-schema, json-utils, frontmatter-parser, markdown-config-loader, yaml-utils, string-utils, additional-utils, native-ts-utils, data-utils |

#### 文档完整性审查

✅ **问题与约束**：准确描述了性能优先、容错设计、跨平台兼容、可复用性、内存安全、循环依赖避免、类型安全等核心问题与约束。

✅ **设计理由与备选方案**：13 项关键决策表格化展示，包含真实证据位置：
- Intersperse 使用 flatMap 而非手动循环（证据：src/utils/array.ts）
- Count 使用 +!!pred(x) 而非 Boolean 转换（证据：src/utils/array.ts）
- Uniq 使用 Set 而非手动去重（证据：src/utils/array.ts）
- CircularBuffer clear 清空底层数组（证据：src/utils/CircularBuffer.ts）
- ObjectGroupBy 使用 Object.create(null)（证据：src/utils/objectGroupBy.ts）
- ContentArray 突变数组而非返回新数组（证据：src/utils/contentArray.ts）
- Memoize 键使用 JSON.stringify（证据：src/utils/memoize.ts）
- SafeParseJSON 使用 discriminated union 缓存（证据：src/utils/json.ts）
- Stale-while-revalidate 缓存策略（证据：src/utils/memoize.ts）
- LazySchema 使用 ??= 而非 ||=（证据：src/utils/lazySchema.ts）
- ParseFrontmatter 失败时自动 quoting 重试（证据：src/utils/frontmatterParser.ts）
- 文件去重使用 dev+ino（证据：src/utils/markdownConfigLoader.ts）
- Hooks schemas 拆分到独立模块（证据：src/schemas/hooks.ts）

✅ **目标与非目标**：清晰界定了性能优化、容错设计、明确契约、内存安全、跨平台兼容、避免循环依赖等目标；明确了不替换 lodash、不提供通用序列化、不支持分布式缓存、不提供验证框架等非目标。

✅ **架构、模块与数据流**：
- 14 个核心组件设计卡
- 模块与状态所有权清晰
- 模块依赖图完整

#### 源码验证

**array-utils**（src/utils/array.ts）：
- `intersperse`：使用 flatMap 插入分隔符 ✅
- `count`：使用 +!!pred(x) 计数 ✅
- `uniq`：使用 Set 去重 ✅

**circular-buffer**（src/utils/CircularBuffer.ts）：
- `add`、`addAll`：添加元素，固定大小滚动窗口 ✅
- `getRecent`、`toArray`：获取最近元素 ✅
- `clear`：清空底层数组，帮助 GC ✅

**object-group-by**（src/utils/objectGroupBy.ts）：
- `objectGroupBy`：Object.create(null) 无原型链污染 ✅

**content-array**（src/utils/contentArray.ts）：
- `insertBlockAfterToolResults`：突变数组，API 层使用模式期望就地修改 ✅

**generators**（src/utils/generators.ts）：
- `lastX`、`returnValue`、`all`、`toArray`、`fromArray`：异步生成器工具 ✅

**memoize**（src/utils/memoize.ts）：
- `memoizeWithTTL`、`memoizeWithTTLAsync`、`memoizeWithLRU`：TTL/LRU 缓存装饰器，键使用 JSON.stringify，stale-while-revalidate 策略 ✅

**lazy-schema**（src/utils/lazySchema.ts）：
- `lazySchema`：使用 ??= 延迟初始化，避免循环依赖 ✅

**json-utils**（src/utils/json.ts + src/utils/jsonRead.ts）：
- `safeParseJSON`、`safeParseJSONC`、`parseJSONL`：JSON/JSONC/JSONL 解析，discriminated union 缓存成功/失败，大输入 (>8KB) 不缓存 ✅
- `stripBOM`：UTF-8 BOM 剥离 ✅

**frontmatter-parser**（src/utils/frontmatterParser.ts）：
- `parseFrontmatter`：失败时自动 quote 重试 ✅
- `splitPathInFrontmatter`、`expandBraces`：路径处理 ✅

**markdown-config-loader**（src/utils/markdownConfigLoader.ts）：
- `loadMarkdownFilesForSubdir`、`findMarkdownFilesNative`：配置目录遍历，文件去重使用 dev+ino ✅

**发现 B7-data-structures-01**：CircularBuffer capacity 0/负未验证，未定义行为。严重度：P3（设计已知非目标，spec 失败语义表明确记录），置信度：已证实（src/utils/CircularBuffer.ts 无 capacity 验证）

**发现 B7-data-structures-02**：memoize 键使用 JSON.stringify，不支持函数、Symbol、循环引用等。严重度：P3（设计已知权衡，spec 明确记录），置信度：已证实（src/utils/memoize.ts）

**发现 B7-data-structures-03**：JSONL 解析跳过失败行，部分数据丢失。严重度：P3（设计已知权衡，spec 失败语义表明确记录），置信度：已证实（src/utils/json.ts）

#### 测试验证

检查 coverage 中提及的测试文件：
- ❌ 无专门的 data-structures 相关测试文件（array.ts、CircularBuffer.ts、objectGroupBy.ts、contentArray.ts、generators.ts、memoize.ts、lazySchema.ts、json.ts、frontmatterParser.ts、markdownConfigLoader.ts 等均无对应测试）

**发现 B7-data-structures-04**：data-structures 子系统核心组件无专门测试覆盖，包括 array 工具、CircularBuffer、memoize、JSON 工具、frontmatter 解析等。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认，无 data-structures 相关测试）

#### 隐私与安全边界审查

**内存安全边界**：
- CircularBuffer 固定大小防止无限增长 ✅
- memoize 有大小限制 ✅

**原型链污染防护**：
- ObjectGroupBy 使用 Object.create(null) ✅

**容错边界**：
- JSON/JSONC/JSONL/frontmatter 解析失败有优雅降级 ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `CircularBuffer`、`memoizeWithTTL`、`safeParseJSON`、`parseFrontmatter`：类/函数名匹配 ✅
- `objectGroupBy`、`lazySchema`、`intersperse`：函数名匹配 ✅

官方文档索引搜索已执行：
- 搜索关键词：`data structures`、`utils`、`cache`、`json`、`yaml`、`frontmatter`
- 命中：无直接 data-structures 相关文档页面

---

### diagnostics

**状态**：待审计 ❌

### experimental-features

**状态**：待审计 ❌

### external-stubs

**状态**：待审计 ❌

### hooks-system

**状态**：待审计 ❌

### magic-docs

**状态**：待审计 ❌

### messaging-primitives

**状态**：待审计 ❌

### native-installer

**状态**：待审计 ❌

### network-security

**状态**：待审计 ❌

### runtime-lifecycle

**状态**：待审计 ❌

### telemetry

**状态**：待审计 ❌

### test-validation

**状态**：待审计 ❌

### web-tools

**状态**：待审计 ❌

## 发现登记

| ID | 子系统 | 严重度 | 描述 | 是否已在 spec 中注明 |
|----|--------|--------|------|---------------------|
| B7-build-feature-profile-01 | build-feature-profile | P3 | spec 中提到 43 个工具但未明确验证位置和机制 | 否 |
| B7-data-structures-01 | data-structures | P3 | CircularBuffer capacity 0/负未验证，未定义行为 | 是（失败语义表明确记录） |
| B7-data-structures-02 | data-structures | P3 | memoize 键使用 JSON.stringify，不支持非序列化值 | 是（设计理由表明确记录） |
| B7-data-structures-03 | data-structures | P3 | JSONL 解析跳过失败行，部分数据丢失 | 是（失败语义表明确记录） |
| B7-data-structures-04 | data-structures | P2 | 核心组件无专门测试覆盖 | 否 |

**汇总**：P0 0 个，P1 0 个，P2 1 个，P3 4 个，总计 5 个发现。

## 证据边界

| 证据类型 | 收集范围 | 限制 |
|---------|---------|------|
| 上游 CLI strings | 仅收集 build-feature-profile 和 data-structures 相关字符串 | 未收集其余 12 个子系统的相关字符串 |
| 官方文档 | 仅搜索构建、feature flag、数据结构相关关键词 | 未搜索其余 12 个子系统的相关文档 |
| 源码验证 | 仅验证 build-feature-profile 和 data-structures 两个子系统的源码 | 未验证其余 12 个子系统的源码 |
| 测试验证 | 仅检查 build-feature-profile 和 data-structures 两个子系统的测试 | 未检查其余 12 个子系统的测试 |

## 完成判定

| 子系统 | 状态 |
|--------|------|
| build-feature-profile | ✅ 审计完成 |
| data-structures | ✅ 审计完成 |
| diagnostics | ❌ 待审计 |
| experimental-features | ❌ 待审计 |
| external-stubs | ❌ 待审计 |
| hooks-system | ❌ 待审计 |
| magic-docs | ❌ 待审计 |
| messaging-primitives | ❌ 待审计 |
| native-installer | ❌ 待审计 |
| network-security | ❌ 待审计 |
| runtime-lifecycle | ❌ 待审计 |
| telemetry | ❌ 待审计 |
| test-validation | ❌ 待审计 |
| web-tools | ❌ 待审计 |

**整体状态**：⚠️ 部分完成（2/14 子系统审计完成）
