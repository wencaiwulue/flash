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
| 编译时剔除而非运行时隐藏 | 使用 `bun:bundle` 的 `feature()` 宏条件导入 | 减小生产构建体积；防止内部工具代码意外泄露；利用 DCE 优化 | 纯运行时检查：代码体积大，可能通过逆向发现 | 构建配置复杂；需确保 feature() 宏正确使用 | src/tools.ts 中所有实验工具都使用 `feature()` 条件导入 |
| SyntheticOutputTool 使用 WeakMap 缓存 Ajv 验证器 | 基于 schema 对象引用缓存 | 工作流脚本通常重复使用相同 schema 对象；WeakMap 自动 GC，无内存泄漏；80次调用从~110ms降到~4ms | 每次重新编译：性能差；基于字符串哈希：内存占用高 | 需注意 schema 对象引用变化时缓存失效 | createSyntheticOutputTool() 中的 toolCache WeakMap 实现 |
| TestingPermissionTool 仅在 NODE_ENV=test 启用 | 环境变量检查 | 测试环境明确，无意外使用风险；简单直接 | 特性标志控制：过度设计；始终隐藏：有安全风险 | 开发环境无法直接测试该工具本身 | src/tools/testing/TestingPermissionTool.tsx 中的 isEnabled() |
| /good-claude 使用内存锁防止重复提交 | Promise 共享去重 | 实现简单，符合直觉；同一请求的 Promise 共享给所有调用者 | 无去重：可能重复提交；全局状态：增加复杂度 | 页面刷新后锁失效（可接受） | handleTranscriptConsent() 中的去重逻辑 |
| /bughunter 作为 /review 别名 | 命令别名 + GrowthBook 门控 | 保留内部习惯用语；通过特性标志控制可用性 | 独立实现：代码重复 | 用户可能困惑两个命令的关系 | 命令注册层的别名配置 |

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
  - w6* 系列内部测试命令
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
| `tools/OverflowTestTool.tsx` | 无（纯函数） | 生成确定性大输出 | 溢出处理本身（仅生成测试数据） | 输入 size，返回 content+size |
| `tools/TestingPermissionTool.tsx` | 无 | 总是弹出权限对话框 | 实际权限逻辑 | 返回 `{ behavior: 'ask', message: 'Run test?' }` |
| `tools/SyntheticOutputTool.tsx` | `toolCache` (WeakMap) | 验证并返回结构化输出 | 工作流调度 | 输入任意 JSON，返回验证后的 structured_output |
| `tools/CtxInspectTool.tsx` | 无 | 检查上下文使用情况 | 上下文管理 | 返回当前上下文状态 |
| `tools/SleepTool.tsx` | 无 | 延迟执行 | 时序控制以外的功能 | 输入 milliseconds，等待后返回 |
| `tools/MonitorTool.tsx` | 无 | 监控进程输出 | 进程管理 | 返回监控结果 |
| `commands/good-claude.tsx` | 内存锁（Promise共享） | 收集反馈、笔录分享 | 反馈分析 | 调用遥测记录、显示 TranscriptSharePrompt |
| `commands/bughunter.tsx` | 无 | 启动远程代码审查 | 审查逻辑本身 | 别名到 /review，检查特性标志 |

### 4.3 主控制流

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
动态添加 SyntheticOutputTool
  ↓
用户调用工具
  ↓
从 WeakMap 缓存获取或编译 Ajv 验证器
  ↓
验证输入
  ├─ 成功 → 返回 { data: "Structured output provided successfully", structured_output: input }
  └─ 失败 → 抛出 TelemetrySafeError
  ↓
记录 structured_output_enabled 遥测事件
```

#### /good-claude 流
```
用户输入 /good-claude
  ↓
记录 tengu_feedback_survey_event (appeared)
  ↓
根据政策和概率决定是否提供笔录分享
  ├─ 否 → 仅记录反馈，结束
  └─ 是 → 显示 TranscriptSharePrompt
        ↓
    用户选择（是/否/不再询问）
        ↓
    记录 tengu_feedback_survey_event (responded/dismissed)
        ↓
    处理笔录分享（使用内存锁防止重复）
        ↓
    保存全局配置（transcriptShareDismissed/transcriptShareConsented）
```

### 4.4 数据结构与持久化

#### 配置存储
```typescript
// 全局配置中的反馈相关设置
interface GlobalConfig {
  transcriptShareDismissed?: boolean;
  transcriptShareConsented?: boolean;
}
```

#### 遥测事件
```typescript
// 反馈调查事件
interface FeedbackSurveyEvent {
  event_type: 'appeared' | 'responded' | 'dismissed';
  response?: 'good' | 'bad';
  survey_type: 'session';
  appearanceId: string;
  lastAssistantMessageId: string;
}

// 结构化输出启用事件
interface StructuredOutputEnabled {
  has_schema: boolean;
}
```

#### SyntheticOutputTool 缓存
```typescript
// WeakMap 基于对象引用缓存
const toolCache = new WeakMap<object, Ajv.ValidateFunction>();
// 键：schema 对象引用
// 值：编译后的 Ajv 验证函数
```

### 4.5 跨子系统依赖

- **tool-system spec**: 工具注册与通用接口
- **command-system spec**: 命令注册与解析
- **permissions spec**: TestingPermissionTool 测试权限流程
- **analytics spec**: tengu_feedback_survey_event、structured_output_enabled 等事件

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
| P1 | 所有实验功能均无直接测试 | 添加单元测试覆盖各工具的启用条件、输入输出、失败场景 | 低：仅新增测试 | 各工具至少有一个基本测试 | S | 已证实（当前无测试） |
| P1 | SyntheticOutputTool 仅基于对象引用缓存，schema 内容相同但对象不同时无法复用 | 增加基于 schema 内容哈希的二级缓存（可选，如 LRU） | 中：需管理内存占用 | 测试相同内容不同对象引用时缓存命中 | M | 已证实（WeakMap 限制） |
| P2 | TestingPermissionTool 仅在 NODE_ENV=test 启用，开发时不方便 | 增加开发环境启用方式（如特定环境变量） | 低：仅增加额外检查 | 测试在开发环境通过环境变量启用 | S | 已证实（当前限制） |
| P2 | OverflowTestTool 上限硬编码为 2,000,000 | 支持通过输入参数或环境变量配置上限 | 低：仅参数化 | 测试可配置更大或更小的上限 | S | 已证实（硬编码） |
| P2 | /good-claude 内存锁仅在当前会话有效 | 增加服务端去重机制 | 高：需后端支持 | 测试快速重复提交时服务端只处理一次 | L | 设计推断 |
| P3 | w6* 测试套件分散且不明确 | 整理并文档化 w6* 测试套件的用途和覆盖范围 | 低：仅文档 | 有清晰的文档说明各 w6* 命令 | S | 设计推断 |
| P3 | 实验工具的启用状态对开发者不透明 | 增加 /experimental-status 命令显示当前环境启用的实验功能 | 低：仅新增命令 | 测试该命令返回正确的启用列表 | S | 设计推断 |
