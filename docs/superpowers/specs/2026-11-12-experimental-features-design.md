---
id: experimental-features
batch: 7
title: Experimental Features 实验功能与内部测试辅助设计
date: 2026-11-12
status: draft
---

# Experimental Features 实验功能与内部测试辅助设计

## 1. 问题与约束

实验功能与内部测试辅助解决以下问题：
- 需要测试工具验证系统边界行为（如大尺寸输出、权限流程）
- 需要内部命令支持开发和调试，不暴露给普通用户
- 需要特性门控机制控制不同环境的功能可用性
- 需要非交互会话的结构化输出支持

### 调用方与职责边界
- **上游**: 工具系统、命令系统、主集成层
- **本层**: 实验工具的实现与门控、内部命令的实现
- **下游**: 遥测系统、权限系统、会话存储

### 约束条件
- 编译时使用 `bun:bundle` 的 `feature()` 宏进行 Dead Code Elimination
- 运行时检查环境变量（如 `NODE_ENV`、`USER_TYPE`、`CLAUDE_*`）
- 实验工具默认不向普通用户暴露
- 特性门控分多层：编译时 → 构建时 → 运行时 → 用户类型

### Feature Gates 与环境变量
- **build-time gates**: `feature('OVERFLOW_TEST_TOOL')`、`feature('CTX_INSPECT_TOOL')`、`feature('SLEEP_TOOL')`、`feature('MONITOR_TOOL')`
- **环境变量**:
  - `NODE_ENV`（测试环境判定）
  - `USER_TYPE`（内部用户判定）
  - 各功能专用 `CLAUDE_*` 开关

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 编译时剔除而非运行时隐藏 | 使用 `bun:bundle` 的 `feature()` 宏条件导入 | 减小生产构建体积；防止内部工具代码意外泄露；利用 DCE 优化 | 纯运行时检查：代码体积大，可能通过逆向发现 | 构建配置复杂；需确保 feature() 宏正确使用 | src/tools.ts 中实验工具使用 `feature()` 条件导入 |
| SyntheticOutputTool 使用 WeakMap 缓存 Ajv 验证器 | 基于 schema 对象引用缓存 | 工作流脚本通常重复使用相同 schema 对象；WeakMap 自动 GC，无内存泄漏；80次调用从~110ms降到~4ms | 每次重新编译：性能差；基于字符串哈希：内存占用高 | 需注意 schema 对象引用变化时缓存失效 | src/tools/SyntheticOutputTool/SyntheticOutputTool.ts 中的 toolCache WeakMap 实现 |
| TestingPermissionTool 仅在 NODE_ENV=test 启用 | 环境变量检查 | 测试环境明确，无意外使用风险；简单直接 | 特性标志控制：过度设计；始终隐藏：有安全风险 | 开发环境无法直接测试该工具本身 | src/tools/testing/TestingPermissionTool.tsx 中的 isEnabled() |
| /good-claude 使用内存锁防止重复提交 | submitting ref 标志防止重复提交 | 实现简单，符合直觉；同一请求不会被重复处理 | 无去重：可能重复提交；全局状态：增加复杂度 | 页面刷新后锁失效（可接受） | src/commands/good-claude/goodClaude.tsx 中的 submitting ref 实现 |
| /bughunter 作为 /review 别名 | 命令别名 + isUltrareviewEnabled 门控 | 保留内部习惯用语；通过特性标志控制可用性 | 独立实现：代码重复 | 用户可能困惑两个命令的关系 | src/commands/bughunter/index.ts 中的命令别名配置 |
| Betas 系统使用白名单过滤 SDK 传递的 beta | ALLOWED_SDK_BETAS 数组限制 | 防止 SDK 传递内部实验 beta；保持公共 API 稳定 | 无限制：可能暴露内部实验；全阻断：SDK 无法使用任何 beta | 需要手动维护白名单 | src/utils/betas.ts 中的 filterAllowedSdkBetas() |

## 3. 目标与非目标

### 目标

#### 状态与生命周期
- **工具注册**: 条件导入与注册，基于特性标志和环境
- **命令可用性**: 基于 `USER_TYPE` 和特性标志动态判断
- **缓存**: SyntheticOutputTool 的 Ajv 验证器 WeakMap 缓存

#### 接口与数据
- **主要工具**:
  - `OverflowTestTool`: 生成大尺寸输出测试溢出
  - `TestingPermissionTool`: 测试权限请求流程
  - `SyntheticOutputTool`: 非交互会话结构化输出
  - `CtxInspectTool`: 检查上下文使用情况
  - `SleepTool`: 控制主动行为时序
  - `MonitorTool`: 监控进程输出
- **主要命令**:
  - `/good-claude`: 收集正面反馈和笔录分享
  - `/bughunter`: 启动远程代码审查
- **返回类型**: 各工具特定的输出结构，如 OverflowTestTool 返回 `{ content, size }`

#### 执行与环境
- **调用位置**: 工具系统 `src/tools.ts`、命令系统 `src/commands.ts`、主集成层 `src/main.tsx`
- **非交互会话**: SyntheticOutputTool 仅在 `isNonInteractiveSession === true` 且 `options.jsonSchema` 提供时启用
- **测试环境**: TestingPermissionTool 仅在 `NODE_ENV === 'test'` 时注册

#### 依赖边界
- **上游依赖**: 工具系统、命令系统、权限系统
- **下游依赖**: 遥测系统、会话存储、Ajv 验证库
- **不拥有**: 工具系统的通用注册机制、命令系统的通用解析

### 非目标
- 不替代通用测试框架
- 不向普通用户暴露内部工具
- 不处理工具系统的通用功能
- 不实现通用的 schema 验证库

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 实验工具基础接口
interface ExperimentalTool {
  name: string;
  isEnabled(): boolean;
  isReadOnly(): boolean;
  isConcurrencySafe(): boolean;
}

// 测试工具特殊标记
interface TestingTool extends ExperimentalTool {
  testingOnly: boolean;
  envRequired?: string;
}

// OverflowTestTool 输入输出
interface OverflowTestInput {
  size: number; // 1-2,000,000 字符，默认 100,000
}
interface OverflowTestOutput {
  content: string; // 由 '0123456789abcdef' 重复组成
  size: number; // 实际返回的大小
}

// SyntheticOutputTool 输入输出
interface SyntheticOutputInput {
  [key: string]: any; // 任意 JSON，通过动态 schema 验证
}
interface SyntheticOutputOutput {
  data: "Structured output provided successfully";
  structured_output: any; // 验证后的输入
}
```

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `tools/OverflowTestTool/OverflowTestTool.ts` | 无（纯函数） | 生成确定性大输出 | 溢出处理本身（仅生成测试数据） | 输入 size，返回 content+size |
| `tools/testing/TestingPermissionTool.tsx` | 无 | 总是弹出权限对话框 | 实际权限逻辑 | 返回 `{ behavior: 'ask', message: 'Run test?' }` |
| `tools/SyntheticOutputTool/SyntheticOutputTool.ts` | `toolCache` (WeakMap) | 验证并返回结构化输出 | 工作流调度 | 输入任意 JSON，返回验证后的 structured_output |
| `tools/CtxInspectTool/CtxInspectTool.ts` | 无 | 检查上下文使用情况 | 上下文管理 | 返回当前上下文状态 JSON 报告 |
| `tools/SleepTool/SleepTool.ts` | 无 | 延迟执行 | 时序控制以外的功能 | 输入 duration，返回计时结果 |
| `tools/MonitorTool/MonitorTool.ts` | 无 | 监控进程输出 | 进程管理 | 返回 task_id 和监控状态 |
| `commands/good-claude/goodClaude.tsx` | `submitting` ref 锁 | 收集反馈、笔录分享 | 反馈分析 | 调用遥测记录、显示 TranscriptSharePrompt |
| `commands/bughunter/index.ts` | 无 | 启动远程代码审查 | 审查逻辑本身 | 别名到 /review，检查 isUltrareviewEnabled |
| `src/constants/betas.ts` | 静态常量 | 定义 beta header 字符串 | 运行时逻辑 | 导出各 beta 常量供 utils/betas.ts 使用 |
| `src/utils/betas.ts` | 无 | 计算模型 beta 列表 | 实际 API 调用 | getAllModelBetas/getModelBetas/getMergedBetas |

### 4.3 模块设计卡

#### OverflowTestTool
**真实入口签名**: `export const OverflowTestTool = buildTool({ name: 'OverflowTest', ... })`
- **路径**: `src/tools/OverflowTestTool/OverflowTestTool.ts`
- **关键类型**:
  - 输入: `{ size?: number }` (1-2,000,000，默认 100,000)
  - 输出: `{ content: string; size: number }`
- **输入输出**:
  - 输入: `size` 参数，通过 zod 验证范围
  - 输出: 确定性生成的字符串，由 `'0123456789abcdef'` 重复组成
- **实验状态与 feature gates**:
  - feature gate: `feature('OVERFLOW_TEST_TOOL')` (在 src/tools.ts 中条件导入)
  - 运行时: `isEnabled: () => true` (只要构建时包含就始终启用)
- **调用/禁用/清理流程**:
  - 构建时: `bun:bundle` feature() 宏控制是否包含
  - 运行时: `getAllBaseTools()` 中有条件展开: `...(OverflowTestTool ? [OverflowTestTool] : [])`
  - 无清理需求（纯函数工具）
- **错误与证据**:
  - 无自定义错误，zod 验证在输入层处理
  - 上限硬编码为 2,000,000 字符
  - `maxResultSizeChars: 2_000_100`
- **设计取舍/备选**:
  - 使用确定性模式而非随机数据: 便于复现测试
  - 硬编码上限: 防止滥用
- **源码测试证据**:
  - 导出辅助函数: `export function makeOverflowOutput(size: number): string`
  - 工具构建: `buildTool` 模式
  - 无专用测试文件

#### SyntheticOutputTool
**真实入口签名**: `export function createSyntheticOutputTool(jsonSchema: Record<string, unknown>): CreateResult`
- **路径**: `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts`
- **关键类型**:
  - `type CreateResult = { tool: Tool } | { error: string }`
  - 输入: `z.object({}).passthrough()` (任意 JSON)
  - 输出: `{ data: string; structured_output: any }`
- **输入输出**:
  - 输入: 任意 JSON 对象，需匹配创建工具时传入的 schema
  - 输出: 验证成功后返回结构化数据
- **实验状态与 feature gates**:
  - 无构建时 feature gate
  - 运行时启用条件: `isSyntheticOutputToolEnabled({ isNonInteractiveSession })`
  - 与工作流关系: 工作流脚本 (`agent({ schema: ... })`) 会频繁调用
- **调用/禁用/清理流程**:
  - 创建阶段: 在 `main.tsx` 中调用 `createSyntheticOutputTool(options.jsonSchema)`
  - 注册阶段: 动态添加到工具池（非标准注册路径）
  - 调用阶段: 验证输入 schema，失败抛出 `TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
  - 无清理需求
- **错误与证据**:
  - Schema 无效: 返回 `{ error: string }` (Ajv 错误信息)
  - 输入验证失败: 抛出 `TelemetrySafeError`，包含路径级错误信息
  - 错误消息不包含代码或文件路径（遥测安全）
- **设计取舍/备选**:
  - 使用 WeakMap 缓存: 基于对象引用，同一 schema 对象重复调用从 ~110ms 降到 ~4ms
  - 备选: 基于内容哈希缓存，但增加内存管理复杂度
  - 仅非交互会话: 保持交互体验简洁
- **源码测试证据**:
  - 注释: "Workflow scripts call agent({schema: BUGS_SCHEMA}) 30-80 times per run"
  - 性能数据: 80 次调用从 ~110ms 降到 ~4ms
  - 无专用测试文件

#### TestingPermissionTool
**真实入口签名**: `export const TestingPermissionTool: Tool = buildTool({ name: 'TestingPermission', ... })`
- **路径**: `src/tools/testing/TestingPermissionTool.tsx`
- **关键类型**:
  - 输入: `{}` (无参数)
  - 输出: `string`
- **输入输出**:
  - 输入: 空对象
  - 输出: `"TestingPermission executed successfully"`
- **实验状态与 feature gates**:
  - 无构建时 feature gate
  - 运行时: `isEnabled: () => process.env.NODE_ENV === 'test'`
  - 仅在测试环境可用
- **调用/禁用/清理流程**:
  - 工具注册: 仅在 `getAllBaseTools()` 中条件添加: `...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : [])`
  - 权限检查: `checkPermissions` 总是返回 `{ behavior: 'ask', message: 'Run test?' }`
  - 无清理需求
- **错误与证据**:
  - 无自定义错误
  - 总是弹出权限对话框用于测试权限流程
- **设计取舍/备选**:
  - 仅测试环境: 防止意外在生产中暴露
  - 备选: 使用特性标志，但环境变量更简单直接
- **源码测试证据**:
  - 无专用测试文件

#### CtxInspectTool
**真实入口签名**: `export const CtxInspectTool = buildTool({ name: 'CtxInspect', ... })`
- **路径**: `src/tools/CtxInspectTool/CtxInspectTool.ts`
- **关键类型**:
  - 输入: `{}` (无参数)
  - 输出: `{ report: string }` (JSON 格式)
- **输入输出**:
  - 输入: 无参数
  - 输出: 包含 model、totalTokens、maxTokens、categories、messageBreakdown、apiUsage、contextCollapse stats 的 JSON 报告
- **实验状态与 feature gates**:
  - feature gate: `feature('CONTEXT_COLLAPSE')` (在 src/tools.ts 中条件导入)
  - 运行时: `isEnabled: () => true`
- **调用/禁用/清理流程**:
  - 构建时: `bun:bundle` feature() 宏控制
  - 调用时: 动态导入 `collectContextData` (打破循环依赖)
  - 无清理需求
- **错误与证据**:
  - 无自定义错误
  - 使用 `jsonStringify` 安全序列化
- **设计取舍/备选**:
  - 动态导入: 避免循环依赖
  - isConcurrencySafe: false (可能修改共享状态)
- **源码测试证据**:
  - 导出辅助函数: `export function formatContextInspection(data: ContextData): string`
  - 无专用测试文件

#### SleepTool
**真实入口签名**: `export const SleepTool = buildTool({ name: 'Sleep', ... })`
- **路径**: `src/tools/SleepTool/SleepTool.ts`
- **关键类型**:
  - 输入: `{ duration?: number; duration_ms?: number }` (二选一)
  - 输出: `{ requestedMs: number; effectiveMs: number; elapsedMs: number; interrupted: boolean }`
- **输入输出**:
  - 输入: `duration` 或 `duration_ms` (后者为弃用别名)
  - 输出: 实际休眠时间和中断状态
- **实验状态与 feature gates**:
  - feature gate: `feature('PROACTIVE') || feature('KAIROS')`
  - 运行时: `isEnabled: () => isProactiveActive()`
- **调用/禁用/清理流程**:
  - 构建时: 条件导入: `const SleepTool = feature('PROACTIVE') || feature('KAIROS') ? require(...).SleepTool : null`
  - 运行时: 可通过 settings 的 `minSleepDurationMs`/`maxSleepDurationMs` 限制
  - 可中断: 使用 `context.abortController.signal`
  - 中断状态标记: `context.setHasInterruptibleToolInProgress?.(true/false)`
- **错误与证据**:
  - 输入验证: 同时提供两个参数或都不提供时返回 `validateInput` 错误
  - 不抛出异常，中断状态通过返回值传达
- **设计取舍/备选**:
  - 支持弃用别名: 向后兼容
  - 设置可配置上下限: 防止滥用
  - 可中断: 良好的用户体验
- **源码测试证据**:
  - 导出辅助函数: `export function resolveSleepDuration(requestedMs: number, settings: ...): number`
  - 无专用测试文件

#### MonitorTool
**真实入口签名**: `export const MonitorTool = buildTool({ name: 'Monitor', ... })`
- **路径**: `src/tools/MonitorTool/MonitorTool.ts`
- **关键类型**:
  - 输入: `{ command: string; description?: string; timeout?: number; dangerouslyDisableSandbox?: boolean }`
  - 输出: `{ message: string; task_id: string }`
- **输入输出**:
  - 输入: shell 命令、描述、超时设置
  - 输出: 任务 ID 和状态消息；每行输出作为 task-notification 事件推送
- **实验状态与 feature gates**:
  - feature gate: `feature('MONITOR_TOOL')` (在 src/tools.ts 中条件导入)
  - 运行时: `isEnabled: () => true`
- **调用/禁用/清理流程**:
  - 权限检查: 复用 `bashToolHasPermission`，设置 `run_in_background: true`
  - 启动 shell: 使用 `exec()` 启动后台命令，设置 `onStdout` 回调
  - 事件推送: 每行输出通过 `enqueuePendingNotification()` 作为 `TASK_NOTIFICATION_TAG` 事件
  - 注册任务: 调用 `spawnShellTask()` 注册到任务系统
  - 无显式清理（任务系统管理）
- **错误与证据**:
  - 复用 BashTool 的沙箱和权限机制
  - timeout 上限: `getMaxTimeoutMs()`
- **设计取舍/备选**:
  - 复用 BashTool 权限: 避免重复代码
  - 行缓冲器: `createMonitorOutputReporter()` 处理不完整的输出块
  - 早期行缓存: 任务 ID 生成前的输出暂存
  - isConcurrencySafe: false (修改共享任务状态)
- **源码测试证据**:
  - 导出辅助函数: `export function createMonitorOutputReporter(report: (line: string) => void)`
  - 无专用测试文件

#### good-claude 命令
**真实入口签名**: `const goodClaude = { type: 'local-jsx', name: 'good-claude', ... } satisfies Command`
- **路径**: `src/commands/good-claude/index.ts`, `src/commands/good-claude/goodClaude.tsx`
- **关键类型**:
  - 无参数 (`call` 中检查 `args.trim()`)
  - React 组件: `GoodClaudeFeedback`
- **输入输出**:
  - 输入: 无参数
  - 输出: 反馈调查 UI (TranscriptSharePrompt)
- **实验状态与 feature gates**:
  - 无构建时 feature gate
  - 运行时: `isEnabled: () => isProductFeedbackAvailable()`
- **调用/禁用/清理流程**:
  - 命令注册: 在 commands.ts 中注册
  - 初始化: 记录 `tengu_feedback_survey_event` (appeared)
  - 去重: `submitting` ref 防止重复提交
  - 笔录分享: 调用 `shouldOfferTranscriptShare()` 决定是否显示选项
  - 完成: 保存 `transcriptShareDismissed`/`transcriptShareConsented` 全局配置
- **错误与证据**:
  - 无自定义错误
  - 笔录分享失败被捕获，显示友好消息
- **设计取舍/备选**:
  - 内存锁: 防止快速重复点击
  - 备选: 持久锁，但页面刷新后重置是可接受的
- **源码测试证据**:
  - 无专用测试文件

#### bughunter 命令
**真实入口签名**: `const bughunter = { type: 'local-jsx', name: 'bughunter', ... } satisfies Command`
- **路径**: `src/commands/bughunter/index.ts`
- **关键类型**:
  - 输入: `[focus]` (可选参数)
  - 实现: 加载 `../review/ultrareviewCommand.js`
- **输入输出**:
  - 输入: 可选的 focus 参数
  - 输出: 远程代码审查 UI
- **实验状态与 feature gates**:
  - 无构建时 feature gate
  - 运行时: `isEnabled: () => isUltrareviewEnabled()`
  - 可用性限制: `availability: ['claude-ai']` (仅 claude-ai 平台可用)
- **调用/禁用/清理流程**:
  - 命令注册: 在 commands.ts 中注册
  - 别名模式: 直接加载 /review 的实现
- **错误与证据**:
  - 无自定义错误
- **设计取舍/备选**:
  - 别名而非独立实现: 避免代码重复
  - 平台限制: 仅在 claude-ai 可用
- **源码测试证据**:
  - 无专用测试文件

#### Betas 系统 (constants/betas.ts + utils/betas.ts)
**真实入口签名**: `export const getAllModelBetas = memoize((model: string): string[] => { ... })`
- **路径**: `src/constants/betas.ts`, `src/utils/betas.ts`
- **关键类型**:
  - Beta header 字符串常量
  - `ALLOWED_SDK_BETAS`: SDK 可传递的 beta 白名单
- **输入输出**:
  - 输入: model 名称、SDK 选项
  - 输出: beta header 字符串数组
- **实验状态与 feature gates**:
  - 构建时: 多个 feature gates 控制 (如 `feature('CONNECTOR_TEXT')`, `feature('TRANSCRIPT_CLASSIFIER')`)
  - 运行时: 环境变量检查 (`process.env.USER_TYPE === 'ant'`, `process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`)
- **调用/禁用/清理流程**:
  - 常量定义: `CLAUDE_CODE_20250219_BETA_HEADER`, `INTERLEAVED_THINKING_BETA_HEADER` 等
  - 白名单过滤: `filterAllowedSdkBetas()` 限制 SDK 可传递的 beta
  - 合并: `getMergedBetas()` 合并自动检测 + SDK 提供的 betas
  - Bedrock 特殊处理: `BEDROCK_EXTRA_PARAMS_HEADERS` 中的 beta 不放在 header 中
- **错误与证据**:
  - 无自定义错误
  - 无效 SDK beta 警告: `console.warn()` 但不阻断
- **设计取舍/备选**:
  - memoization: `getAllModelBetas`/`getModelBetas`/`getBedrockExtraBodyParamsBetas` 都使用 memoize 缓存
  - 白名单机制: 防止 SDK 传递内部 beta
  - provider 分离: Bedrock/Vertex/Foundry 有不同处理
- **源码测试证据**:
  - 无专用测试文件

#### 实验能力不作为稳定承诺说明
- 所有实验工具和命令均可能在未通知的情况下变更或移除
- SyntheticOutputTool 的非标准注册路径不保证向后兼容
- Beta headers 可能随模型版本变更，不保证跨版本稳定
- 内部测试边界: 仅在 `NODE_ENV === 'test'` 可用的工具不保证在其他环境工作

### 4.4 主控制流

#### 工具注册流
```
构建时
  ↓
feature() 宏条件编译（Dead Code Elimination）
  ↓
src/tools.ts 导入
  ↓
isEnabled() 运行时检查（环境变量、用户类型、特性标志）
  ↓
加入工具池 或 跳过
```

#### SyntheticOutputTool 流
```
会话启动
  ↓
src/main.tsx 检查 isNonInteractiveSession && options.jsonSchema
  ↓ (true)
调用 createSyntheticOutputTool(options.jsonSchema)
  ├─ 从 WeakMap 缓存查找 schema 对象
  ├─ 命中 → 返回缓存的 CreateResult
  └─ 未命中 → 验证 schema，编译 Ajv，缓存结果
  ↓ (成功)
动态添加 SyntheticOutputTool 到工具池
  ↓
用户调用工具
  ↓
验证输入与 schema 匹配
  ├─ 成功 → 返回 { data: "Structured output provided successfully", structured_output: input }
  └─ 失败 → 抛出 TelemetrySafeError
```

#### /good-claude 流
```
用户输入 /good-claude
  ↓
检查 args 不为空 → 错误提示用法
  ↓
初始化 appearanceId，记录 tengu_feedback_survey_event (appeared)
  ↓
记录 tengu_feedback_survey_event (responded, response: 'good')
  ↓
根据 policy 和概率调用 shouldOfferTranscriptShare()
  ├─ 否 → 仅记录反馈，显示 "Thanks for the good feedback"
  └─ 是 → 记录 TranscriptPromptShown，显示 TranscriptSharePrompt
        ↓
    用户选择（是/否/不再询问）
        ↓
    检查 submitting 锁 → 已锁则跳过
        ↓
    记录 tengu_feedback_survey_event (responded/dismissed)
        ↓
    调用 handleTranscriptConsent() 处理笔录分享
        ↓
    保存全局配置（transcriptShareDismissed/transcriptShareConsented）
        ↓
    显示完成消息
```

### 4.5 数据结构与持久化

#### 配置存储
```typescript
// 全局配置中的反馈相关设置
interface GlobalConfig {
  transcriptShareDismissed?: boolean;
  transcriptShareConsented?: boolean;
}
```

#### SyntheticOutputTool 缓存
```typescript
// WeakMap 基于对象引用缓存
const toolCache = new WeakMap<object, CreateResult>();
// 键：schema 对象引用
// 值：{ tool: Tool } 或 { error: string }
```

### 4.6 跨子系统依赖

- **tool-system spec**: 工具注册与通用接口
- **command-system spec**: 命令注册与解析
- **permissions spec**: TestingPermissionTool 测试权限流程，MonitorTool/BashTool 复用权限逻辑
- **analytics spec**: tengu_feedback_survey_event 等事件

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| OverflowTestTool size 超限 | 工具内部 | 静默 clamp 到 2,000,000 | 否 | 无 | 返回 clamp 后的 size |
| SyntheticOutputTool schema 无效 | 创建工具时 | 返回错误信息，不创建工具 | 否 | 无 | 工具不在列表中 |
| SyntheticOutputTool 输入验证失败 | 工具调用时 | 抛出 TelemetrySafeError | 否 | 无 | 异常向上传播 |
| TestingPermissionTool 权限被拒 | 权限系统 | 权限系统标准错误 | 否 | 无 | 用户看到权限被拒 |
| /good-claude 笔录分享失败 | 命令处理 | 捕获，显示友好消息 | 否 | 无 | 会话不中断 |
| /bughunter 配额超限或被拒 | 命令处理 | 显示对话框 | 否 | 无 | 不启动审查 |

### 工程取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| 编译时剔除 vs 运行时隐藏 | 编译时剔除 | 构建配置复杂；需确保 feature() 宏正确使用 | 生产构建体积小；无内部代码泄露风险 |
| SyntheticOutputTool 缓存键 | 对象引用 (WeakMap) | schema 对象重新创建时缓存失效 | 自动 GC；性能优化明显（80次调用从~110ms降到~4ms） |
| TestingPermissionTool 启用条件 | NODE_ENV=test | 开发环境无法直接测试该工具本身 | 简单明确；无意外使用风险 |
| /good-claude 去重方式 | 内存锁 (Promise共享) | 页面刷新后锁失效 | 实现简单；符合直觉 |
| OverflowTestTool 上限 | 2,000,000 字符 | 无法测试更大尺寸 | 防止滥用；平衡测试需求与资源占用 |

## 6. 现状验收标准

1. **给定** `feature('OVERFLOW_TEST_TOOL')` 为 true，**当**工具注册时，**必须**包含 OverflowTestTool，**并且**输入 size=2,000,001 时输出被 clamp 到 2,000,000
2. **给定** `isNonInteractiveSession === true` 且 `options.jsonSchema` 已提供，**当**会话启动时，**必须**动态添加 SyntheticOutputTool，**并且**相同 schema 对象重复调用时使用缓存验证器
3. **给定** `NODE_ENV === 'test'`，**当**工具注册时，**必须**包含 TestingPermissionTool，**并且**调用时总是返回 `{ behavior: 'ask', message: 'Run test?' }`
4. **给定**用户调用 `/good-claude`，**当**显示笔录分享选项时，**必须**使用内存锁防止重复提交，**并且**用户选择"不再询问"后设置 `transcriptShareDismissed`
5. **给定**特性标志启用，**当**用户输入 `/bughunter`，**必须**作为 `/review` 别名执行，**不得**在 claude-ai 平台外可用
6. **给定**SyntheticOutputTool输入验证失败，**当**调用工具时，**必须**抛出TelemetrySafeError，**不得**泄露敏感schema细节

## 7. 代码与测试证据

### 核心模块

| 设计陈述 | 源码证据 | 测试场景与不变量 | 未覆盖的边界 |
|---|---|---|---|
| OverflowTestTool 生成确定性输出 | src/tools/testing/OverflowTestTool.tsx | 无直接测试 | 无 |
| TestingPermissionTool 仅在 test 环境启用 | src/tools/testing/TestingPermissionTool.tsx | 无直接测试 | 无 |
| SyntheticOutputTool WeakMap 缓存 | src/tools/SyntheticOutputTool.tsx | 无直接测试 | schema 对象引用变化场景 |
| SyntheticOutputTool 动态 schema 验证 | src/tools/SyntheticOutputTool.tsx | 无直接测试 | 复杂嵌套 schema 验证 |
| /good-claude 反馈收集与笔录分享 | src/commands/good-claude.tsx | 无直接测试 | 网络失败场景 |
| /good-claude 内存锁去重 | src/commands/good-claude.tsx | 无直接测试 | 并发调用场景 |
| /bughunter 别名与特性门控 | src/commands/bughunter.tsx | 无直接测试 | 无 |
| CtxInspectTool 上下文检查 | src/tools/experimental/CtxInspectTool.tsx | 无直接测试 | 无 |
| SleepTool 时序控制 | src/tools/experimental/SleepTool.tsx | 无直接测试 | 无 |
| MonitorTool 进程监控 | src/tools/experimental/MonitorTool.tsx | 无直接测试 | 无 |
| 工具条件注册 | src/tools.ts | 无直接测试 | 多特性标志组合场景 |
| 命令条件注册 | src/commands.ts | 无直接测试 | USER_TYPE 变化场景 |
| 主集成层动态添加工具 | src/main.tsx | 无直接测试 | 无 |

### 证据边界
- 无专门针对实验功能的端到端测试
- 无并发/压力测试
- 无 schema 验证性能回归测试
- 无笔录分享网络失败降级测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/experimental-features.yaml)

### Coverage分组概览

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|---|---|---|---|
| experimental-tools | 实验工具实现（OverflowTest/TestingPermission/SyntheticOutput/CtxInspect/Sleep/Monitor） | 无直接测试 | src/tools.ts（工具系统通用注册） |
| experimental-commands | 实验命令实现（/good-claude、/bughunter、w6*） | 无直接测试 | src/commands.ts（命令系统通用注册） |
| experimental-integration | 主集成层动态添加 | 无直接测试 | src/main.tsx（主流程） |

### 相关子系统
- **tool-system spec**: 工具注册与通用接口
- **command-system spec**: 命令注册与解析
- **permissions spec**: 权限流程测试
- **analytics spec**: 遥测事件记录

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | 已证实所有实验功能均无直接测试 | 添加单元测试覆盖各工具的启用条件、输入输出、失败场景 | 低：仅新增测试 | 各工具至少有一个基本测试 | S | 已证实（当前无测试） |
| P1 | SyntheticOutputTool 仅基于对象引用缓存，schema 内容相同但对象不同时无法复用 | 增加基于 schema 内容哈希的二级缓存（可选，如 LRU） | 中：需管理内存占用 | 测试相同内容不同对象引用时缓存命中 | M | 已证实（WeakMap 限制） |
| P2 | TestingPermissionTool 仅在 NODE_ENV=test 启用，开发时不方便 | 增加开发环境启用方式（如特定环境变量） | 低：仅增加额外检查 | 测试在开发环境通过环境变量启用 | S | 已证实（当前限制） |
| P2 | OverflowTestTool 上限硬编码为 2,000,000 | 支持通过输入参数或环境变量配置上限 | 低：仅参数化 | 测试可配置更大或更小的上限 | S | 已证实（硬编码） |
| P2 | /good-claude 内存锁仅在当前会话有效 | 增加服务端去重机制 | 高：需后端支持 | 测试快速重复提交时服务端只处理一次 | L | 设计推断 |
| P3 | w6* 测试套件分散且不明确 | 整理并文档化 w6* 测试套件的用途和覆盖范围 | 低：仅文档 | 有清晰的文档说明各 w6* 命令 | S | 设计推断 |
| P3 | 实验工具的启用状态对开发者不透明 | 增加 /experimental-status 命令显示当前环境启用的实验功能 | 低：仅新增命令 | 测试该命令返回正确的启用列表 | S | 设计推断 |
