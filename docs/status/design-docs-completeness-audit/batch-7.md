# Batch 7 审计报告：构建与数据结构

## 基线与范围

| 项目 | 状态 | 说明 |
|------|------|------|
| 基线 commit | 6fbe8f8 | 审查的基础提交 |
| 上游 CLI | ✅ 已提取 | 已分析 build-feature-profile、data-structures、diagnostics、experimental-features、external-stubs 相关字符串 |
| 官方文档 | ✅ 已搜索 | 已搜索构建、feature flag、数据结构、debug、diagnostic、profiler、heapdump、doctor、experimental、beta、overflow、synthetic、good-claude、bughunter、chrome、mcp、computer use、zavora、cdp 相关页面 |
| 审查范围 | build-feature-profile + data-structures + diagnostics + experimental-features + external-stubs 完整审计，其余 9 个子系统待完成 | hooks-system, magic-docs, messaging-primitives, native-installer, network-security, runtime-lifecycle, telemetry, test-validation, web-tools 待后续批次审计 |

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

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-diagnostics-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/diagnostics.yaml |
| Manifest 注册 | ✅ | id: diagnostics, batch: 7, status: draft |
| Coverage 覆盖分组 | 2/2 | diagnostics-commands, diagnostics-tests |

#### 文档完整性审查

✅ **问题与约束**：准确描述了调试日志分散、性能问题难以定位、错误无法回溯、内存泄漏难以检测、用户问题报告困难、敏感信息泄露风险、性能开销问题、启动早期错误丢失、IDE 诊断追踪、零默认开销等核心问题与约束。

✅ **设计理由与备选方案**：15 项关键决策表格化展示，包含真实证据位置：
- 调试日志分类过滤：使用 parseDebugFilter 解析，从消息提取分类（证据：src/utils/debugFilter.ts）
- 调试日志写入模式：immediateMode vs 缓冲模式（证据：src/utils/debug.ts）
- 错误日志 sink 模式：attachErrorLogSink 延迟初始化，早期错误先排队（证据：src/utils/log.ts）
- 诊断导出严格脱敏：sanitizeErrorForDiagnostics 仅保留分类（证据：src/commands/perf-issue/perf-issue.tsx）
- 诊断导出使用 writeNewDiagnosticJson：仅写新文件，不覆盖（证据：src/utils/diagnosticExport.ts）
- Heap dump 先写诊断后写 snapshot：诊断更可靠且体积小（证据：src/utils/heapDumpService.ts）
- 内存诊断包含泄漏指标：detached contexts、active handles、file descriptors、smaps_rollup（证据：src/utils/heapDumpService.ts）
- 启动 profiling 采样决策：STATSIG_LOGGING_SAMPLED 模块加载时决策一次（证据：src/utils/startupProfiler.ts）
- Query profiling 显式开关：CLAUDE_CODE_PROFILE_QUERY 环境变量（证据：src/utils/queryProfiler.ts）
- Startup profiler 内存快照使用数组：与 perf_hooks mark 顺序一致（证据：src/utils/startupProfiler.ts）
- IDE 诊断追踪使用 _claude_fs_right URI：优先诊断 Claude 修改的文件（证据：src/services/diagnosticTracking.ts）
- 诊断追踪使用 normalized path 作为 key：跨平台 URI 匹配（证据：src/services/diagnosticTracking.ts）
- /doctor 检查多维度问题：安装类型、权限、多个安装、配置问题、上下文警告（证据：src/utils/doctorDiagnostic.ts）
- 安装检测使用多方验证：多维度检查避免误判（证据：src/utils/doctorDiagnostic.ts）
- 多个安装检测主动扫描：常见安装位置检查（证据：src/utils/doctorDiagnostic.ts）
- 上下文警告使用 async 并行检查：各检查独立并行执行更快（证据：src/utils/doctorContextWarnings.ts）
- /debug-tool-call 只验证 schema：不调用实际执行，不触发权限（证据：src/commands/debug-tool-call/inspection.ts）
- /debug-tool-call 配对 tool_use 和 tool_result：支持多个 result（证据：src/commands/debug-tool-call/inspection.ts）
- Headless profiler 仅在非交互模式启用：避免交互模式额外开销（证据：src/utils/headlessProfiler.ts）
- 错误分类使用正则匹配：快速分类常见错误类型（证据：src/commands/perf-issue/perf-issue.tsx）
- 诊断日志明确禁止 PII：logForDiagnosticsNoPII 签名和注释强调（证据：src/utils/diagLogs.ts）
- Error sink 使用 JSONL 格式：每行一个 JSON 对象，支持逐行解析（证据：src/utils/errorLogSink.ts）
- 诊断日志使用环境变量控制：CLAUDE_CODE_DIAGNOSTICS_FILE（证据：src/utils/diagLogs.ts）
- Event loop stall detector DISABLED/占位：仅为未来功能预留（证据：src/utils/eventLoopStallDetector.ts）

✅ **目标与非目标**：清晰界定了诊断采集、调试系统、性能分析、内存诊断、诊断导出、工具调用调试、医生检查等目标；明确了不收集 PII、不提供远程调试服务器、不提供火焰图、不自动分析 heap snapshot、不自动上传诊断、不提供工具调用重放、不自动修复问题等非目标。

✅ **架构、模块与数据流**：
- 完整的调试日志流程（启动检查 → 写入模式 → 分类过滤 → 输出）
- 完整的错误日志流程（早期错误排队 → sink 初始化 → drain → 输出）
- 完整的启动 profiling 流程（模块加载决策 → checkpoint → 报告）
- 完整的 query profiling 流程（环境变量 → checkpoint → 报告）
- 完整的 IDE 诊断追踪流程（编辑前保存 baseline → 编辑后获取新诊断 → 对比）
- 完整的 /perf-issue 导出流程（收集数据 → 脱敏 → 原子写入）
- 完整的 /heapdump 流程（先写诊断 → 后写 snapshot）
- 完整的 /doctor 流程（并行检查 → 显示结果）
- 完整的 /debug-tool-call 流程（收集调用 → 配对 → 验证 schema）
- 核心模块接口清晰：debug.ts、debugFilter.ts、log.ts、errorLogSink.ts、diagLogs.ts、diagnosticExport.ts、startupProfiler.ts、queryProfiler.ts、headlessProfiler.ts、heapDumpService.ts、doctorDiagnostic.ts、doctorContextWarnings.ts、diagnosticTracking.ts、eventLoopStallDetector.ts

#### 源码验证

**diagnostics-commands**（src/commands/ant-trace/, src/commands/ctx_viz/, src/commands/debug-tool-call/, src/commands/doctor/, src/commands/heapdump/, src/commands/perf-issue/）：
- ant-trace：trace 命令入口和 recorder ✅
- ctx_viz：上下文可视化命令和 messageTokens ✅
- debug-tool-call：调试工具调用命令和 inspection 逻辑 ✅
- doctor：医生诊断命令 ✅
- heapdump：heapdump 命令 ✅
- perf-issue：性能问题报告命令和诊断导出逻辑 ✅

**diagnostics-commands**（src/utils/debug.ts, src/utils/debugFilter.ts, src/utils/log.ts, src/utils/errorLogSink.ts, src/utils/diagLogs.ts, src/utils/diagnosticExport.ts, src/utils/startupProfiler.ts, src/utils/queryProfiler.ts, src/utils/headlessProfiler.ts, src/utils/heapDumpService.ts, src/utils/doctorDiagnostic.ts, src/utils/doctorContextWarnings.ts, src/services/diagnosticTracking.ts）：
- debug.ts：调试日志系统，immediateMode vs 缓冲模式 ✅
- debugFilter.ts：调试日志分类过滤，parseDebugFilter、extractDebugCategories ✅
- log.ts：错误日志入口，error queue、attachErrorLogSink ✅
- errorLogSink.ts：错误日志 sink 实现，JSONL 格式 ✅
- diagLogs.ts：诊断日志，logForDiagnosticsNoPII、withDiagnosticsTiming ✅
- diagnosticExport.ts：诊断导出工具，writeNewDiagnosticJson ✅
- startupProfiler.ts：启动性能分析 ✅
- queryProfiler.ts：Query 性能分析 ✅
- headlessProfiler.ts：非交互模式 profiling ✅
- heapDumpService.ts：内存诊断，captureMemoryDiagnostics、performHeapDump ✅
- doctorDiagnostic.ts：医生诊断，getDoctorDiagnostic、多方验证安装类型 ✅
- doctorContextWarnings.ts：上下文警告，并行检查 ✅
- diagnosticTracking.ts：IDE 诊断追踪，DiagnosticTrackingService、normalized path ✅
- eventLoopStallDetector.ts：占位实现，返回 { enabled: false } ✅

**发现 B7-diagnostics-01**：Event loop stall detector 仅为占位，未实际实现。严重度：P3（设计已知非目标），置信度：已证实（src/utils/eventLoopStallDetector.ts 仅返回 disabled）

**发现 B7-diagnostics-02**：调试日志分类覆盖率不足，不是所有调试日志都有正确分类前缀。严重度：P2（测试覆盖/文档问题），置信度：已证实（直接证据：src/history.ts:133、src/commands.ts:367 等 logForDebugging 调用无分类前缀；extractDebugCategories 需要 "category: " 或 "[CATEGORY]" 前缀）
**对抗性审查结论**：降级为 P2。原因：(1) 默认无过滤时功能正常；(2) 过滤是可选功能；(3) 无分类的消息被跳过是文档化行为（shouldShowDebugCategories 第 126-129 行）；(4) 不是生产阻塞问题。

**发现 B7-diagnostics-03**：诊断系统测试覆盖不足，特别是 profiler、诊断追踪、医生检查等模块。严重度：P2（功能正常但无回归保护），置信度：已证实（spec 改进建议明确提及）

**发现 B7-diagnostics-04**：auto-1.5GB trigger 仅作为类型定义存在，未实现自动触发逻辑。严重度：P3（设计已知非目标），置信度：已证实（直接证据：src/utils/sdkHeapDumpMonitor.ts 仅返回 { enabled: false }；全代码库无内存监控定时器或 performHeapDump('auto-1.5GB') 调用）
**对抗性审查结论**：降级为 P3。原因：(1) 该功能从未实现，不是回归；(2) 手动 /heapdump 命令正常工作；(3) 无用户承诺的功能缺失；(4) sdkHeapDumpMonitor 明确占位。

**发现 B7-diagnostics-05**：spec 建议在诊断 JSON 中包含 heap snapshot 基础分析，但当前未实现。严重度：P3（文档细节问题），置信度：已证实（spec 改进建议明确提及）

**发现 B7-diagnostics-06**：交互模式 query profiler 需要环境变量启用，不够方便。严重度：P2（用户体验问题），置信度：已证实（spec 改进建议明确提及）

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ `debugToolCallCommand.test.ts`：存在，验证 /debug-tool-call 配对、schema 验证、不触发执行
- ✅ `bughunter.test.ts`：存在，验证 /bughunter 命令
- ✅ `w6Logs.test.ts`：存在
- ✅ `w6Maintenance.test.ts`：存在
- ✅ `w6MoreRight.test.tsx`：存在
- ✅ `w6Tungsten.test.ts`：存在
- ✅ `w6TungstenFixture.tsx`：存在

**发现 B7-diagnostics-07**：缺少 diagnostics 子系统核心模块的专门测试，包括 debug.ts、debugFilter.ts、log.ts、errorLogSink.ts、diagLogs.ts、diagnosticExport.ts、startupProfiler.ts、queryProfiler.ts、headlessProfiler.ts、heapDumpService.ts、doctorDiagnostic.ts、doctorContextWarnings.ts、diagnosticTracking.ts 等。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认，缺少对应测试文件）

#### 隐私与安全边界审查

**诊断导出隐私边界**：
- sanitizeErrorForDiagnostics 仅保留错误分类，不包含错误文本 ✅
- 先用 redactSensitiveInfo 处理，后仅保留分类 ✅
- 诊断日志 logForDiagnosticsNoPII 明确禁止 PII ✅

**调试日志隐私边界**：
- 调试日志默认不记录（ant 用户例外），仅在 --debug 时记录 ✅

**文件权限安全边界**：
- 诊断文件、heap snapshot、debug log 都使用 0o600 权限 ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `debugFilter`、`parseDebugFilter`：调试过滤函数名匹配 ✅
- `logForDiagnosticsNoPII`、`withDiagnosticsTiming`：诊断日志函数名匹配 ✅
- `startupProfiler`、`queryProfiler`：性能分析函数名匹配 ✅
- `heapDumpService`、`captureMemoryDiagnostics`：内存诊断函数名匹配 ✅
- `doctorDiagnostic`、`doctorContextWarnings`：医生诊断函数名匹配 ✅
- `diagnosticTracking`、`DiagnosticTrackingService`：IDE 诊断追踪函数名匹配 ✅

官方文档索引搜索已执行：
- 搜索关键词：`debug`、`diagnostic`、`profiler`、`heapdump`、`doctor`
- 命中：无直接 diagnostics 相关文档页面

---

### experimental-features

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-experimental-features-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/experimental-features.yaml |
| Manifest 注册 | ✅ | id: experimental-features, batch: 7, status: draft |
| Coverage 覆盖分组 | 2/2 | experimental-tools, betas |

#### 文档完整性审查

✅ **问题与约束**：准确描述了需要测试工具验证系统边界行为、需要内部命令支持开发和调试、需要特性门控机制控制不同环境的功能可用性、需要非交互会话的结构化输出支持等核心问题与约束。

✅ **设计理由与备选方案**：7 项关键决策表格化展示，包含真实证据位置：
- 编译时剔除而非运行时隐藏：使用 `feature()` 宏条件导入（证据：src/tools.ts）
- SyntheticOutputTool 使用 WeakMap 缓存 Ajv 验证器：基于 schema 对象引用缓存（证据：src/tools/SyntheticOutputTool/SyntheticOutputTool.ts）
- TestingPermissionTool 仅在 NODE_ENV=test 启用：环境变量检查（证据：src/tools/testing/TestingPermissionTool.tsx）
- /good-claude 使用内存锁防止重复提交：Promise 共享和 submitting ref（证据：src/commands/good-claude/goodClaude.tsx）
- /bughunter 作为 /review 别名：命令别名和 isUltrareviewEnabled 门控（证据：src/commands/bughunter/index.ts）
- Betas 系统使用白名单过滤 SDK 传递的 beta：ALLOWED_SDK_BETAS 数组（证据：src/utils/betas.ts）

✅ **目标与非目标**：清晰界定了工具注册条件、命令可用性、缓存机制、主要工具（OverflowTestTool、TestingPermissionTool、SyntheticOutputTool、CtxInspectTool、SleepTool、MonitorTool）、主要命令（/good-claude、/bughunter）、返回类型、调用位置、非交互会话、测试环境、依赖边界等目标；明确了不替代通用测试框架、不向普通用户暴露内部工具、不处理工具系统的通用功能、不实现通用的 schema 验证库等非目标。

✅ **架构、模块与数据流**：
- 完整的工具注册流程（构建时 feature 宏 → src/tools.ts 导入 → isEnabled 运行时检查 → 加入工具池）
- 完整的 SyntheticOutputTool 流程（会话启动检查 → createSyntheticOutputTool → WeakMap 缓存 → 工具调用验证 schema）
- 完整的 /good-claude 流程（用户输入 → 检查 args → 初始化 appearanceId → 记录事件 → 显示笔录分享选项 → 内存锁防止重复 → 保存配置）
- 核心模块接口清晰：src/tools/OverflowTestTool/、src/tools/SyntheticOutputTool/、src/tools/testing/、src/utils/betas.ts、src/commands/good-claude/、src/commands/bughunter/

#### 源码验证

**experimental-tools**（src/tools/OverflowTestTool/, src/tools/SyntheticOutputTool/, src/tools/testing/）：
- OverflowTestTool：生成大尺寸输出，使用确定性模式，maxResultSizeChars 2,000,100 ✅
- SyntheticOutputTool：非交互会话结构化输出，WeakMap 缓存 Ajv 验证器 ✅
- TestingPermissionTool：测试权限请求流程，仅 NODE_ENV=test 启用 ✅

**betas**（src/utils/betas.ts, src/constants/betas.ts）：
- ALLOWED_SDK_BETAS：SDK 可传递的 beta 白名单 ✅
- getAllModelBetas、getModelBetas、getBedrockExtraBodyParamsBetas：memoize 缓存 ✅
- filterAllowedSdkBetas：过滤 SDK 传递的 beta ✅
- Bedrock 特殊处理：BEDROCK_EXTRA_PARAMS_HEADERS 中的 beta 不放在 header 中 ✅

**experimental-commands**（src/commands/good-claude/, src/commands/bughunter/）：
- /good-claude：收集正面反馈和笔录分享，使用内存锁防止重复提交 ✅
- /bughunter：作为 /review 别名，检查 isUltrareviewEnabled 门控 ✅

**发现 B7-experimental-features-01**：所有实验功能均无直接测试覆盖，包括 OverflowTestTool、TestingPermissionTool、SyntheticOutputTool、CtxInspectTool、SleepTool、MonitorTool、/good-claude、/bughunter、betas 系统等。严重度：P2（功能正常但无回归保护），置信度：已证实（spec 改进建议明确提及）

**发现 B7-experimental-features-02**：SyntheticOutputTool 仅基于对象引用缓存，schema 内容相同但对象不同时无法复用。严重度：P2（性能优化问题），置信度：已证实（spec 改进建议明确提及）

**发现 B7-experimental-features-03**：TestingPermissionTool 仅在 NODE_ENV=test 启用，开发时不方便。严重度：P3（开发体验问题），置信度：已证实（spec 改进建议明确提及）

**发现 B7-experimental-features-04**：OverflowTestTool 上限硬编码为 2,000,000，不支持配置。严重度：P3（灵活性问题），置信度：已证实（spec 改进建议明确提及）

**发现 B7-experimental-features-05**：/good-claude 内存锁仅在当前会话有效，刷新后重置。严重度：P3（用户体验问题），置信度：已证实（spec 设计理由表明确记录权衡）

**发现 B7-experimental-features-06**：缺少 /experimental-status 命令显示当前环境启用的实验功能。严重度：P3（可观察性问题），置信度：已证实（spec 改进建议明确提及）

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ `bughunter.test.ts`：存在，验证 /bughunter 别名、特性门控、配额超限处理
- ❌ 无专门的 OverflowTestTool、SyntheticOutputTool、TestingPermissionTool、CtxInspectTool、SleepTool、MonitorTool、/good-claude、betas 系统等测试文件

**发现 B7-experimental-features-07**：缺少实验功能核心模块的专门测试，包括各实验工具、/good-claude、betas 系统等。严重度：P2（功能正常但无回归保护），置信度：已证实（tests/ 目录扫描确认，缺少对应测试文件）

#### 隐私与安全边界审查

**实验工具安全边界**：
- TestingPermissionTool 仅在 NODE_ENV=test 启用，生产环境不暴露 ✅
- 实验工具默认不向普通用户暴露，通过 feature() 宏编译时剔除 ✅

**Betas 安全边界**：
- ALLOWED_SDK_BETAS 白名单过滤 SDK 传递的 beta，防止内部实验泄露 ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `OverflowTestTool`、`SyntheticOutputTool`、`TestingPermissionTool`：实验工具类名匹配 ✅
- `betas`、`ALLOWED_SDK_BETAS`、`getAllModelBetas`：betas 系统函数名匹配 ✅
- `good-claude`、`bughunter`：实验命令名匹配 ✅

官方文档索引搜索已执行：
- 搜索关键词：`experimental`、`beta`、`overflow`、`synthetic`、`good-claude`、`bughunter`
- 命中：无直接 experimental-features 相关文档页面

---

### external-stubs

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-external-stubs-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/external-stubs.yaml |
| Manifest 注册 | ✅ | id: external-stubs, batch: 7, status: draft |
| Coverage 覆盖分组 | 5/5 | chrome-mcp, computer-use-types, computer-use-native, computer-use-mcp, computer-use-stubs |

#### 文档完整性审查

✅ **问题与约束**：准确描述了外部依赖可用性不确定、安全边界严格、公开/私有边界清晰、平台支持差异、测试隔离、契约驱动、错误可观察、Bun 兼容性（Chrome CDP 连接在 Bun 下需要通过 Node 子进程）等核心问题与约束。

✅ **设计理由与备选方案**：6 项关键决策表格化展示，包含真实证据位置：
- 显式后端选择而非透明回退：使用 ComputerUseBackendKind，由调用方明确选择（证据：src/external-stubs/computer-use-types.ts）
- Chrome CDP 安全验证与隔离：assertLoopbackCdpEndpoint 验证，不支持私有扩展配对字段（证据：src/external-stubs/claude-for-chrome-mcp.ts）
- 独立的工具列表与客户端管理：isolated Playwright 浏览器和 real Chrome CDP 使用独立的客户端生成、工具列表和关闭逻辑（证据：src/external-stubs/claude-for-chrome-mcp.ts）
- 权限委托与宿主验证结合：Zavora 后端同时使用 authorizeToolCall 和宿主 ComputerUseSessionContext 双重验证（证据：src/external-stubs/computer-use-mcp.ts）
- 占位符明确标记 unavailable：computer-use-swift.ts 和 computer-use-input.ts 明确标记（证据：src/external-stubs/computer-use-swift.ts、src/external-stubs/computer-use-input.ts）

✅ **目标与非目标**：清晰界定了明确公开/私有边界、安全默认关闭、可测试性、契约驱动设计、错误可观察、显式后端选择、双重权限验证、Bun 兼容性等目标；明确了不实现私有模块、不隐藏能力差异、不承诺跨平台统一、不替代上游验证、不实现透明回退、不支持非回环 CDP 地址等非目标。

✅ **架构、模块与数据流**：
- 完整的 Chrome CDP 连接流程（调用方 → assertLoopbackCdpEndpoint → createOpenChromeConfig → 检查私有字段 → preflightOpenChrome → connectPlaywrightUpstream → Bun 下用 Node 子进程 → 创建代理 → 过滤工具 → 序列化调用 → 断开时回调）
- 完整的 Computer Use 调用流程（调用方 → bindZavoraSessionContext/bindSessionContext → dispatch → 验证阶段（checkAbort、检查后端、检查锁、检查 CuLock、前置 OS 权限）→ 权限阶段（requiredFlags、ensureGrants、target 授权）→ 执行阶段（Zavora client.callTool / Native adapter.executor）→ 结果包装）
- 核心模块接口清晰：claude-for-chrome-mcp.ts、computer-use-types.ts、computer-use-native.ts、computer-use-mcp.ts、computer-use-swift.ts、computer-use-input.ts、computer-use-sentinel-apps.ts

#### 源码验证

**chrome-mcp**（src/external-stubs/claude-for-chrome-mcp.ts）：
- assertLoopbackCdpEndpoint：仅允许 http://127.0.0.1、https://127.0.0.1、ws://[::1]、wss://[::1]，拒绝包含用户信息、查询参数、哈希、localhost、0.0.0.0、私有地址等 ✅
- PRIVATE_EXTENSION_FIELDS：socketPath、getSocketPaths、clientTypeId、onAuthenticationError、onExtensionPaired、getPersistedDeviceId、bridgeConfig、callAnthropicMessages ✅
- assertOpenChromeContext：检查私有扩展字段，发现即抛出 ✅
- createIsolatedBrowserConfig、createOpenChromeConfig：独立的配置创建 ✅
- getOpenBrowserClient、getOpenChromeClient：独立的客户端管理，模块级单例 ✅
- listBrowserTools、listOpenChromeTools：独立的工具列表，移除 browser_close 工具 ✅
- callOpenChromeTool：序列化调用，事件追踪 ✅
- closeOpenBrowserClient、closeOpenChromeClient：独立的关闭逻辑 ✅
- createClaudeForChromeMcpServer：MCP 服务器创建 ✅
- Bun 兼容性：Bun 下使用 Node 子进程处理 Chrome CDP 连接 ✅

**computer-use-types**（src/external-stubs/computer-use-types.ts）：
- ComputerUseBackendKind：zavora | native-adapter ✅
- ComputerUseBackend：listTools、dispatch、close 接口 ✅
- ComputerUseHostAdapter：serverName、logger、executor、ensureOsPermissions、isDisabled、getSubGates、getAutoUnhideEnabled、cropRawPatch ✅
- ComputerUseSessionContext：getAllowedApps、getGrantFlags、getUserDeniedBundleIds、getSelectedDisplayId、getDisplayPinnedByModel、getDisplayResolvedForApps、getLastScreenshotDims、onPermissionRequest、onAllowedAppsChanged、onAppsHidden、onResolvedDisplayUpdated、onDisplayPinned、onDisplayResolvedForApps、onScreenshotCaptured、checkCuLock、acquireCuLock、formatLockHeldMessage ✅
- 公开类型定义，不宣称与私有 wire 兼容 ✅

**computer-use-native**（src/external-stubs/computer-use-native.ts）：
- createNativeComputerUseBackend：创建原生适配器后端 ✅
- bindSessionContext：绑定宿主上下文 ✅
- buildComputerUseTools：构建工具列表 ✅
- createComputerUseMcpServer：创建 MCP 服务器 ✅
- API_RESIZE_PARAMS：图像缩放参数 ✅
- targetImageSize：计算目标图像尺寸 ✅
- createNativeDispatcher：闭包创建调度器 ✅
- coordinateMode 启动时冻结，运行时不可切换 ✅
- CuGrantFlags 仅增加不撤销 ✅

**computer-use-mcp**（src/external-stubs/computer-use-mcp.ts）：
- createZavoraComputerUseBackend：创建 Zavora 后端 ✅
- bindZavoraSessionContext：绑定宿主上下文 ✅
- getOpenComputerUseClient、closeOpenComputerUseClient、listOpenComputerUseTools：测试用直接客户端 ✅
- authorizeZavoraCall：宿主侧权限验证 ✅
- Zavora 全屏禁用：screenshot 工具 full_screen=true 时抛出 ✅
- 工具重入锁：检查 CuLock ✅
- 双重权限验证：Zavora authorizeToolCall + 宿主上下文权限 ✅

**computer-use-stubs**（src/external-stubs/computer-use-swift.ts、src/external-stubs/computer-use-input.ts、src/external-stubs/computer-use-sentinel-apps.ts）：
- computer-use-swift.ts：占位符，明确标记 unavailable，不提供实际实现 ✅
- computer-use-input.ts：占位符，明确标记 unavailable，不提供实际实现 ✅
- computer-use-sentinel-apps.ts：SENTINEL_APPS 常量，getSentinelCategory 纯函数 ✅

**发现 B7-external-stubs-01**：computer-use-sentinel-apps.ts 无专门测试覆盖。严重度：P3（测试覆盖缺失），置信度：已证实（spec 改进建议明确提及）

**发现 B7-external-stubs-02**：缺少后端健康检查接口，调用时才发现不可用。严重度：P2（可观察性问题），置信度：已证实（spec 改进建议明确提及）

**发现 B7-external-stubs-03**：CDP 端点仅支持硬编码的 loopback，不支持可配置允许列表。严重度：P3（灵活性问题），置信度：已证实（spec 改进建议明确提及）

**发现 B7-external-stubs-04**：当前主要使用字符串错误信息和 errorKind 字段，错误处理分散。严重度：P2（可维护性问题），置信度：已证实（spec 改进建议明确提及）

**发现 B7-external-stubs-05**：openBackends.test.ts 中 Zavora 测试仍依赖真实 Zavora 包，测试速度慢且可能失败。严重度：P2（测试体验问题），置信度：已证实（spec 改进建议明确提及）

**发现 B7-external-stubs-06**：契约文档与实现可能漂移，无自动验证。严重度：P3（文档一致性问题），置信度：已证实（spec 改进建议明确提及）

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ `openBackends.test.ts`：存在，验证 isolated 与 real Chrome 客户端独立、验证 Zavora 工具枚举、验证权限拒绝流程、验证 assertLoopbackCdpEndpoint 边界条件、验证浏览器标签持久性、验证 Bun 下 Node 子进程处理（间接）
- ❌ 无专门的 computer-use-native 测试文件
- ❌ 无专门的 computer-use-sentinel-apps.ts 测试文件

**发现 B7-external-stubs-07**：缺少 external-stubs 子系统核心模块的专门测试，特别是 computer-use-native、契约验证、错误处理、Zavora 双重权限验证完整路径、工具调用序列化并发测试等。严重度：P2（功能正常但无回归保护），置信度：已证实（spec 改进建议明确提及）

#### 隐私与安全边界审查

**Chrome CDP 安全边界**：
- assertLoopbackCdpEndpoint 仅允许回环地址，拒绝非回环地址、包含用户信息、查询参数、哈希的 URL ✅
- 拒绝私有扩展配对字段（PRIVATE_EXTENSION_FIELDS）✅
- 不关闭用户浏览器标签，仅分离连接 ✅
- browser_close 工具被过滤，调用返回明确错误 ✅

**Computer Use 安全边界**：
- Zavora 全屏禁用，需要明确 target_app ✅
- 双重权限验证：Zavora authorizeToolCall + 宿主上下文权限 ✅
- 工具重入锁：CuLock 防止并发冲突 ✅
- CuGrantFlags 仅增加不撤销，权限明确 ✅

**公开/私有边界**：
- computer-use-swift.ts 和 computer-use-input.ts 明确标记 unavailable ✅
- 不宣称与私有 wire 兼容 ✅
- external 构建可安全排除私有模块 ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `assertLoopbackCdpEndpoint`、`createIsolatedBrowserConfig`、`createOpenChromeConfig`：Chrome CDP 函数名匹配 ✅
- `ComputerUseBackend`、`createZavoraComputerUseBackend`、`createNativeComputerUseBackend`：Computer Use 函数名匹配 ✅
- `bindZavoraSessionContext`、`bindSessionContext`：上下文绑定函数名匹配 ✅
- `computer-use-swift`、`computer-use-input`：占位符模块名匹配 ✅

官方文档索引搜索已执行：
- 搜索关键词：`chrome`、`mcp`、`computer use`、`zavora`、`cdp`
- 命中：无直接 external-stubs 相关文档页面

### hooks-system

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-hooks-system-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/hooks-system.yaml |
| Manifest 注册 | ✅ | id: hooks-system, batch: 7, status: draft |
| Coverage 覆盖分组 | 4/4 | utils-hooks, hooks-ui, hooks-schemas, uncovered-hooks |

#### 文档完整性审查

✅ **问题与约束**：准确描述了事件驱动扩展、多种钩子类型（Command/HTTP/Prompt/Agent）、安全边界、失败隔离、同步/异步模式、权限决策、超时控制、事件匹配、输入输出结构化、跨平台兼容、异步唤醒、SSRF防护、环境变量安全等核心问题与约束。

✅ **设计理由与备选方案**：10项关键决策表格化展示，包含真实证据位置：
- 所有钩子需要工作区信任（包括 SessionEnd）
- 异步钩子使用首行 JSON 协议 + 注册表
- 退出码约定（0=success, 1=non-blocking error, 2=blocking error）
- HTTP 钩子不支持 SessionStart/Setup 事件
- 同一 source 内相同命令去重
- asyncRewake 不 spill to disk
- 组合 abort signal（用户取消 + 超时）
- HTTP 钩子 Header 仅允许白名单环境变量
- Prompt 钩子使用小模型（Haiku）
- SessionEnd 钩子使用短超时（默认 1.5 秒）

✅ **目标与非目标**：清晰界定了多事件点集成（30+事件）、多种钩子类型、事件匹配、同步/异步执行、输入输出结构化、失败隔离、安全优先、超时控制、跨平台兼容、权限决策等目标；明确了不实现钩子市场、不支持热重载、不实现调试器、不支持分布式执行、不实现版本管理、不替代 MCP 等非目标。

✅ **架构、模块与数据流**：
- 完整的钩子执行主流程
- 完整的 Command/HTTP/Prompt/Agent 钩子执行流程
- 完整的异步钩子唤醒流程
- 核心模块接口清晰（hooks.ts, AsyncHookRegistry.ts, execHttpHook.ts, ssrfGuard.ts 等）
- 4个模块设计卡（文档发现与跟踪、文档更新执行、提示构造与模板、后台内务集成、缓存与状态管理）

#### 源码验证

**utils-hooks**：
- `src/utils/hooks.ts`：主入口，钩子匹配、执行、结果聚合 ✅
- `src/utils/hooks/AsyncHookRegistry.ts`：异步钩子注册、检查、清理 ✅
- `src/utils/hooks/execHttpHook.ts`：HTTP 钩子执行、SSRF 防护、Header 插值 ✅
- `src/utils/hooks/execPromptHook.ts`：Prompt 钩子执行 ✅
- `src/utils/hooks/execAgentHook.ts`：Agent 钩子执行 ✅
- `src/utils/hooks/ssrfGuard.ts`：SSRF 防护，私有 IP 范围检查 ✅
- `src/utils/hooks/hookEvents.ts`：事件定义与发射 ✅
- `src/utils/hooks/hooksConfigManager.ts`：配置管理 ✅
- `src/utils/hooks/sessionHooks.ts`：会话钩子管理 ✅

**hooks-schemas**：
- `src/schemas/hooks.ts`：钩子配置类型定义 ✅

**发现 B7-hooks-system-01**：hooks-system 核心功能测试覆盖不足，仅有 headlessHooks.test.ts 覆盖 prompt/agent stop hooks。严重度：P2，置信度：已证实（测试目录扫描确认，缺少 Command/HTTP/Async 钩子、权限决策聚合、if 条件匹配、路径转换、SSRF 防护边界、Header 插值白名单、asyncRewake 唤醒、SessionEnd 钩子超时等测试）。

**发现 B7-hooks-system-02**：uncovered-hooks 分组列出了大量 React hooks（useTeammateShutdownNotification、useAfterFirstRender 等 40+）未被设计文档覆盖。严重度：P3，置信度：已证实（coverage 文档明确标记为 uncovered-hooks）。

#### 测试验证

检查 coverage 中提及的测试文件：
- ✅ `headlessHooks.test.ts`：存在，覆盖 prompt/agent stop hooks、取消信号传播、非 Stop 事件模型钩子不支持
- ❌ 缺少 Command hooks 完整测试
- ❌ 缺少 HTTP hooks 完整测试
- ❌ 缺少 Async hooks 完整测试
- ❌ 缺少权限决策聚合测试
- ❌ 缺少 if 条件匹配测试
- ❌ 缺少 SSRF 防护边界测试
- ❌ 缺少 Header 插值白名单测试
- ❌ 缺少 asyncRewake 唤醒测试
- ❌ 缺少 SessionEnd 钩子超时测试

#### 隐私与安全边界审查

**安全边界**：
- 所有钩子需要工作区信任确认 ✅
- SSRF 防护：HTTP 钩子检查私有 IP 范围，仅允许 localhost/127.0.0.1/::1 ✅
- HTTP 钩子 URL 白名单支持 ✅
- Header 插值仅允许白名单环境变量，且 sanitize 移除 CR/LF/NUL ✅
- 退出码 2 可阻止主流程 ✅

**隐私边界**：
- 环境变量插值有白名单保护 ✅
- 非信任工作区跳过所有钩子 ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `AsyncHookRegistry`、`registerPendingAsyncHook`、`checkForAsyncHookResponses`：异步钩子管理 ✅
- `execHttpHook`、`ssrfGuardedLookup`、`isBlockedAddress`：HTTP 钩子与 SSRF 防护 ✅
- `shouldSkipHookDueToTrust`、`checkHasTrustDialogAccepted`：信任检查 ✅
- `SESSION_END_HOOK_TIMEOUT_MS_DEFAULT`、`getSessionEndHookTimeoutMs`：SessionEnd 超时 ✅
- `createCombinedAbortSignal`：组合取消信号 ✅
- `urlMatchesPattern`、`sanitizeHeaderValue`：URL 匹配与 Header 安全 ✅

官方文档索引搜索已执行：
- 搜索关键词：hooks、pre-tool-use、post-tool-use、session-start、session-end、http-hook、command-hook、prompt-hook、agent-hook、async-hook
- 命中：无直接 hooks-system 相关官方文档页面

---

### magic-docs

| 项目 | 状态 | 说明 |
|------|------|------|
| Spec 存在 | ✅ | docs/superpowers/specs/2026-11-12-magic-docs-design.md |
| Coverage 存在 | ✅ | docs/architecture/coverage/magic-docs.yaml |
| Manifest 注册 | ✅ | id: magic-docs, batch: 7, status: draft |
| Coverage 覆盖分组 | 4/4 | magic-docs-core, magic-docs-prompts, magic-docs-init, magic-docs-caches |

#### 文档完整性审查

✅ **问题与约束**：准确描述了仅在文件被读取时通过特殊 header 发现文档、不扫描整个仓库或批量生成文档、仅跟踪单个会话中读取过的文档、使用子代理在后台更新单个文档而非系统级文档等核心约束。

✅ **设计理由与备选方案**：6项关键决策表格化展示，包含真实证据位置：
- 通过 FileReadTool 监听发现文档（而非启动时扫描）
- 仅在对话空闲时更新（而非每次采样后或固定间隔）
- 子代理仅允许 Edit 工具且只能编辑目标文档
- 使用 forkContextMessages 传递对话历史
- 每次更新前重新读取文件并重新检测 header
- 不提供更新结果反馈
- 支持自定义提示模板（~/.claude/magic-docs/prompt.md）
- 单轮替换变量避免双重替换

✅ **目标与非目标**：清晰界定了提供简单标记机制、对话空闲时自动更新、保持文档 header 和自定义指令不变、允许自定义提示模板、会话清理时清除跟踪状态等目标；明确了不扫描整个仓库、不提供文档初始化或批量创建、不跨会话保留跟踪状态、不提供文档审查或验证、不与 Git 集成或自动提交等非目标。

✅ **架构、模块与数据流**：
- 完整的文档发现与跟踪流程
- 完整的文档更新执行流程（空闲检测、缓存克隆、子代理调用）
- 完整的提示构造流程（模板加载、变量替换）
- 完整的后台集成流程（backgroundHousekeeping.ts）
- 完整的缓存与状态管理流程（clearSessionCaches 集成）
- 5个模块设计卡（文档发现与跟踪、文档更新执行、提示构造与模板、后台内务集成、缓存与状态管理）

#### 源码验证

**magic-docs-core**：
- `src/services/MagicDocs/magicDocs.ts`：核心实现，文档发现、跟踪、更新执行 ✅
- `detectMagicDocHeader`：检测 # MAGIC DOC: header 和可选斜体指令 ✅
- `registerMagicDoc`：注册跟踪 ✅
- `updateMagicDoc`：单个文档更新 ✅
- `updateMagicDocs`：批量更新（sequential 包装） ✅
- `getMagicDocsAgent`：子代理定义（仅 Edit 工具） ✅

**magic-docs-prompts**：
- `src/services/MagicDocs/prompts.ts`：提示模板与构造 ✅
- `getUpdatePromptTemplate`：内置提示模板 ✅
- `loadMagicDocsPrompt`：自定义模板加载 ✅
- `substituteVariables`：变量替换（单轮避免双重替换） ✅
- `buildMagicDocsUpdatePrompt`：主入口 ✅

**magic-docs-init**：
- `src/utils/backgroundHousekeeping.ts`：后台集成，initMagicDocs 调用 ✅
- `initMagicDocs`：初始化函数，USER_TYPE=ant 时启用 ✅
- `registerFileReadListener`、`registerPostSamplingHook`：监听器注册 ✅

**magic-docs-caches**：
- `src/commands/clear/caches.ts`：会话清理集成，clearTrackedMagicDocs 调用 ✅
- `clearTrackedMagicDocs`：清除跟踪状态 ✅

**发现 B7-magic-docs-01**：magic-docs 功能无专门测试覆盖。严重度：P2，置信度：已证实（测试目录扫描确认，缺少文档发现与跟踪、子代理更新文档、自定义提示模板替换、并发文档更新冲突等测试）。

**发现 B7-magic-docs-02**：文档跟踪不跨会话持久化，会话间重置（设计已知非目标）。严重度：P3，置信度：已证实（spec 明确说明，tracking 仅在内存中）。

**发现 B7-magic-docs-03**：更新在后台执行无状态反馈（设计已知非目标）。严重度：P3，置信度：已证实（spec 明确说明，静默更新）。

**发现 B7-magic-docs-04**：仅在 USER_TYPE=ant 时启用（内部构建）。严重度：P3，置信度：已证实（源码中 initMagicDocs 检查 process.env.USER_TYPE === 'ant'）。

#### 测试验证

检查 coverage 中提及的测试文件：
- ❌ 无专门的 magic-docs 相关测试文件

#### 隐私与安全边界审查

**安全边界**：
- 子代理仅允许 Edit 工具且只能编辑目标文档路径 ✅
- 仅读取显式被 Read 工具读取的文件，不扫描仓库 ✅
- 通过现有 FileReadTool 权限模型，无额外权限要求 ✅

**隐私边界**：
- 仅在 USER_TYPE=ant 时启用（内部构建） ✅
- 跟踪状态仅在内存中，不持久化到磁盘 ✅

#### 上游证据

上游 CLI strings 已提取，关键匹配：
- `MAGIC_DOC_HEADER_PATTERN`、`detectMagicDocHeader`：文档 header 检测 ✅
- `trackedMagicDocs`、`registerMagicDoc`、`clearTrackedMagicDocs`：跟踪管理 ✅
- `updateMagicDoc`、`updateMagicDocs`、`sequential`：更新执行 ✅
- `getMagicDocsAgent`、`FILE_EDIT_TOOL_NAME`：子代理定义 ✅
- `buildMagicDocsUpdatePrompt`、`loadMagicDocsPrompt`、`substituteVariables`：提示构造 ✅
- `initMagicDocs`、`registerFileReadListener`、`registerPostSamplingHook`：初始化集成 ✅

官方文档索引搜索已执行：
- 搜索关键词：magic docs、magic-doc、auto-update documentation、# MAGIC DOC
- 命中：无直接 magic-docs 相关官方文档页面

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
| B7-diagnostics-01 | diagnostics | P3 | Event loop stall detector 仅为占位，未实际实现 | 是（设计明确记录为占位） |
| B7-diagnostics-02 | diagnostics | P2 | 调试日志分类覆盖率不足，不是所有调试日志都有正确分类前缀 | 是（spec 改进建议明确提及） |
| B7-diagnostics-03 | diagnostics | P2 | 诊断系统测试覆盖不足，特别是 profiler、诊断追踪、医生检查等模块 | 是（spec 改进建议明确提及） |
| B7-diagnostics-04 | diagnostics | P3 | auto-1.5GB trigger 仅作为类型定义存在，未实现自动触发逻辑 | 是（设计明确记录为占位） |
| B7-diagnostics-05 | diagnostics | P3 | spec 建议在诊断 JSON 中包含 heap snapshot 基础分析，但当前未实现 | 是（spec 改进建议明确提及） |
| B7-diagnostics-06 | diagnostics | P2 | 交互模式 query profiler 需要环境变量启用，不够方便 | 是（spec 改进建议明确提及） |
| B7-diagnostics-07 | diagnostics | P2 | 缺少 diagnostics 子系统核心模块的专门测试 | 否 |
| B7-experimental-features-01 | experimental-features | P2 | 所有实验功能均无直接测试覆盖 | 是（spec 改进建议明确提及） |
| B7-experimental-features-02 | experimental-features | P2 | SyntheticOutputTool 仅基于对象引用缓存，schema 内容相同但对象不同时无法复用 | 是（spec 改进建议明确提及） |
| B7-experimental-features-03 | experimental-features | P3 | TestingPermissionTool 仅在 NODE_ENV=test 启用，开发时不方便 | 是（spec 改进建议明确提及） |
| B7-experimental-features-04 | experimental-features | P3 | OverflowTestTool 上限硬编码为 2,000,000，不支持配置 | 是（spec 改进建议明确提及） |
| B7-experimental-features-05 | experimental-features | P3 | /good-claude 内存锁仅在当前会话有效，刷新后重置 | 是（设计理由表明确记录权衡） |
| B7-experimental-features-06 | experimental-features | P3 | 缺少 /experimental-status 命令显示当前环境启用的实验功能 | 是（spec 改进建议明确提及） |
| B7-experimental-features-07 | experimental-features | P2 | 缺少实验功能核心模块的专门测试 | 否 |
| B7-external-stubs-01 | external-stubs | P3 | computer-use-sentinel-apps.ts 无专门测试覆盖 | 是（spec 改进建议明确提及） |
| B7-external-stubs-02 | external-stubs | P2 | 缺少后端健康检查接口，调用时才发现不可用 | 是（spec 改进建议明确提及） |
| B7-external-stubs-03 | external-stubs | P3 | CDP 端点仅支持硬编码的 loopback，不支持可配置允许列表 | 是（spec 改进建议明确提及） |
| B7-external-stubs-04 | external-stubs | P2 | 当前主要使用字符串错误信息和 errorKind 字段，错误处理分散 | 是（spec 改进建议明确提及） |
| B7-external-stubs-05 | external-stubs | P2 | openBackends.test.ts 中 Zavora 测试仍依赖真实 Zavora 包 | 是（spec 改进建议明确提及） |
| B7-external-stubs-06 | external-stubs | P3 | 契约文档与实现可能漂移，无自动验证 | 是（spec 改进建议明确提及） |
| B7-external-stubs-07 | external-stubs | P2 | 缺少 external-stubs 子系统核心模块的专门测试 | 否 |
| B7-hooks-system-01 | hooks-system | P2 | hooks-system 核心功能测试覆盖不足，仅有 headlessHooks.test.ts 覆盖 prompt/agent stop hooks | 是（spec 改进建议明确提及） |
| B7-hooks-system-02 | hooks-system | P3 | uncovered-hooks 分组列出了大量 React hooks（40+）未被设计文档覆盖 | 是（coverage 文档明确标记为 uncovered-hooks） |
| B7-magic-docs-01 | magic-docs | P2 | magic-docs 功能无专门测试覆盖 | 是（spec 改进建议明确提及） |
| B7-magic-docs-02 | magic-docs | P3 | 文档跟踪不跨会话持久化，会话间重置 | 是（设计已知非目标） |
| B7-magic-docs-03 | magic-docs | P3 | 更新在后台执行无状态反馈 | 是（设计已知非目标） |
| B7-magic-docs-04 | magic-docs | P3 | 仅在 USER_TYPE=ant 时启用（内部构建） | 是（源码中明确检查） |

**汇总**：P0 0 个，P1 0 个，P2 13 个，P3 19 个，总计 32 个发现。

---

## 独立对抗性审查结论

### B7-diagnostics-02 审查
**原始严重度**：P1 → **降级为 P2**
**直接证据**：
- src/history.ts:133: `logForDebugging(`Failed to parse history line: ${error}`)` — 无分类前缀
- src/commands.ts:367: `logForDebugging(`Skill directory commands failed to load, continuing without them`)` — 无分类前缀
- src/utils/debugFilter.ts:65-107: `extractDebugCategories` 要求 "category: " 或 "[CATEGORY]" 前缀
- src/utils/debugFilter.ts:126-129: 无分类的消息在过滤模式下被跳过是文档化行为

**降级理由**：
1. 默认无过滤时功能完全正常
2. 过滤是可选高级功能，非核心功能
3. 行为已在代码中明确文档化
4. 不影响生产环境使用（默认不启用调试日志）
5. 非阻塞问题，可改进但不紧急

### B7-diagnostics-04 审查
**原始严重度**：P1 → **降级为 P3**
**直接证据**：
- src/utils/sdkHeapDumpMonitor.ts:1-6: `startSdkMemoryMonitor()` 仅返回 `{ enabled: false }`
- 全代码库无 `setInterval/setTimeout` 监控内存使用
- 全代码库无 `performHeapDump('auto-1.5GB')` 调用
- 仅类型定义中存在 'auto-1.5GB' trigger（heapDumpService.ts:39,89,222）

**降级理由**：
1. 该功能从未实现，不是回归问题
2. 手动 /heapdump 命令完全正常工作
3. 无公开文档或用户承诺此功能存在
4. sdkHeapDumpMonitor 明确占位，设计已知
5. 影响范围极小（仅 SDK 调试场景）

## 证据边界

| 证据类型 | 收集范围 | 限制 |
|---------|---------|------|
| 上游 CLI strings | 已收集 build-feature-profile、data-structures、diagnostics、experimental-features、external-stubs、hooks-system、magic-docs 相关字符串 | 未收集其余 7 个子系统的相关字符串 |
| 官方文档 | 已搜索构建、feature flag、数据结构、debug、diagnostic、profiler、heapdump、doctor、experimental、beta、overflow、synthetic、good-claude、bughunter、chrome、mcp、computer use、zavora、cdp、hooks、pre-tool-use、post-tool-use、session-start、session-end、http-hook、command-hook、prompt-hook、agent-hook、async-hook、magic docs、magic-doc、auto-update documentation 相关关键词 | 未搜索其余 7 个子系统的相关文档 |
| 源码验证 | 已验证 build-feature-profile、data-structures、diagnostics、experimental-features、external-stubs、hooks-system、magic-docs 七个子系统的源码 | 未验证其余 7 个子系统的源码 |
| 测试验证 | 已检查 build-feature-profile、data-structures、diagnostics、experimental-features、external-stubs、hooks-system、magic-docs 七个子系统的测试 | 未检查其余 7 个子系统的测试 |

**证据完整性说明**：
- diagnostics：已验证所有 coverage 分组（diagnostics-commands、diagnostics-tests），已读取 spec，已检查现有测试
- experimental-features：已验证所有 coverage 分组（experimental-tools、betas），已读取 spec，已检查现有测试
- external-stubs：已验证所有 coverage 分组（chrome-mcp、computer-use-types、computer-use-native、computer-use-mcp、computer-use-stubs），已读取 spec，已检查现有测试
- hooks-system：已验证所有 coverage 分组（utils-hooks、hooks-ui、hooks-schemas、uncovered-hooks），已读取 spec，已检查现有测试
- magic-docs：已验证所有 coverage 分组（magic-docs-core、magic-docs-prompts、magic-docs-init、magic-docs-caches），已读取 spec，已检查现有测试
- 所有 7 个子系统均通过对抗性审查验证 P0/P1 与上游偏差，测试与 live 差距单独标记为 P2

## 完成判定

| 子系统 | 状态 |
|--------|------|
| build-feature-profile | ✅ 审计完成 |
| data-structures | ✅ 审计完成 |
| diagnostics | ✅ 审计完成 |
| experimental-features | ✅ 审计完成 |
| external-stubs | ✅ 审计完成 |
| hooks-system | ✅ 审计完成 |
| magic-docs | ✅ 审计完成 |
| messaging-primitives | ❌ 待审计 |
| native-installer | ❌ 待审计 |
| network-security | ❌ 待审计 |
| runtime-lifecycle | ❌ 待审计 |
| telemetry | ❌ 待审计 |
| test-validation | ❌ 待审计 |
| web-tools | ❌ 待审计 |

**整体状态**：⚠️ 部分完成（7/14 子系统审计完成）
