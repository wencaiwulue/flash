---
id: experimental-features
batch: 7
title: Experimental Features 实验功能与内部测试辅助设计
date: 2026-11-12
status: draft
---

# Experimental Features 实验功能与内部测试辅助设计

## Overview

实验功能与内部测试辅助（Experimental Features）是 Claude Code 中的一组特殊工具和命令，用于支持开发测试、调试、性能分析和实验性功能验证。这些功能默认不向普通用户暴露，通过特性门控（feature gates）和环境变量控制可用性。

### 核心范围

本设计文档涵盖以下功能：

1. **内部测试工具**：用于测试系统行为的专用工具
   - OverflowTestTool：生成大尺寸输出，测试溢出处理
   - TestingPermissionTool：测试权限请求流程
   - SyntheticOutputTool：非交互会话的结构化输出

2. **实验性命令**：用于特定场景的专用命令
   - /good-claude：收集正面反馈和笔录分享
   - /bughunter：启动远程代码审查
   - w6* 系列：内部测试套件

3. **调试辅助工具**：用于诊断和性能分析
   - CtxInspectTool：检查上下文使用情况
   - SleepTool：控制主动行为时序
   - MonitorTool：监控进程输出

## Domain Model

```typescript
// 特性门控配置
interface FeatureGate {
  name: string;
  enabled: boolean;
  envOverride?: string;
}

// 实验工具的基础接口
interface ExperimentalTool {
  name: string;
  isEnabled(): boolean;
  isReadOnly(): boolean;
  isConcurrencySafe(): boolean;
}

// 测试工具的特殊标记
interface TestingTool extends ExperimentalTool {
  testingOnly: boolean;
  envRequired?: string;
}
```

### 核心实体

1. **Feature Gate**：特性门控，通过 `bun:bundle` 的 `feature()` 宏在编译时控制代码包含
2. **Experimental Tool**：实验工具，通过 `isEnabled()` 方法在运行时判断可用性
3. **Testing Command**：测试命令，仅在特定环境中可用
4. **w6 Test Suite**：内部测试套件，隔离特定模块的测试

## Architecture

实验功能采用多层门控架构：

```
编译时剔除 (Dead Code Elimination)
    ↓
构建时特性门控 (Feature Gates)
    ↓
运行时环境检查 (Runtime Env Checks)
    ↓
用户类型验证 (User Type Verification)
```

### 组件层次

1. **工具注册层** (`src/tools.ts`)
   - 条件导入实验工具
   - 基于特性标志组装工具池
   - 过滤特殊工具（如 SyntheticOutputTool）

2. **命令注册层** (`src/commands.ts`)
   - 条件导入实验命令
   - 根据 `process.env.USER_TYPE` 限制可用性
   - 管理命令懒加载

3. **主集成层** (`src/main.tsx`)
   - 会话启动时检查特性标志
   - 动态添加 SyntheticOutputTool
   - 记录实验性功能使用事件

## API / UX

### OverflowTestTool

**功能**：生成指定大小的确定性输出，用于测试大工具结果的截断、持久化和渲染。

**输入**：
```typescript
{
  size: number;  // 1-2,000,000 字符，默认 100,000
}
```

**输出**：
```typescript
{
  content: string;  // 由 '0123456789abcdef' 重复组成
  size: number;     // 实际返回的大小
}
```

**特性门控**：`OVERFLOW_TEST_TOOL`

### SyntheticOutputTool

**功能**：在非交互会话中返回结构化输出，用于工作流脚本。

**输入**：任意 JSON 对象，通过动态 JSON Schema 验证。

**输出**：
```typescript
{
  data: "Structured output provided successfully";
  structured_output: any;  // 验证后的输入
}
```

**启用条件**：
- `isNonInteractiveSession === true`
- `options.jsonSchema` 已提供

**缓存策略**：使用 WeakMap 缓存编译后的 Ajv 验证器，避免重复 schema 编译。

### TestingPermissionTool

**功能**：测试权限请求流程的专用工具，总是弹出权限对话框。

**启用条件**：`process.env.NODE_ENV === 'test'`

**权限行为**：总是返回 `{ behavior: 'ask', message: 'Run test?' }`

### /good-claude

**功能**：收集用户正面反馈，可选分享会话笔录。

**可用性**：所有环境，无特性门控。

**流程**：
1. 记录 `tengu_feedback_survey_event` 事件
2. 根据政策和概率决定是否提供笔录分享选项
3. 显示 TranscriptSharePrompt 组件
4. 处理用户选择（是/否/不再询问）

### /bughunter

**功能**：启动远程代码审查，是 `/review` 命令的别名。

**可用性**：`claude-ai` 平台。

**特性门控**：GrowthBook 特性标志控制。

## Data Model

实验功能的数据存储主要在配置和遥测中：

### 配置存储

```typescript
// 全局配置中的反馈相关设置
interface GlobalConfig {
  transcriptShareDismissed?: boolean;
  transcriptShareConsented?: boolean;
}
```

### 遥测事件

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

## Security

### 安全边界

1. **工具隔离**：实验工具默认不向普通用户暴露
2. **权限限制**：TestingPermissionTool 仅在测试环境可用
3. **输出限制**：OverflowTestTool 有 2,000,000 字符上限
4. **Schema 验证**：SyntheticOutputTool 验证所有输入

### 禁用行为

当功能被禁用时：
- OverflowTestTool：不在工具列表中显示
- SyntheticOutputTool：不创建，静默失败返回错误信息
- TestingPermissionTool：完全不注册
- /bughunter：`isEnabled()` 返回 false

## Failure Semantics

### 工具加载失败

- **OverflowTestTool**：特性标志关闭时，工具不包含在工具池中
- **SyntheticOutputTool**：Schema 无效时返回 `{ error: string }`，工具不创建
- **TestingPermissionTool**：环境不匹配时不注册

### 运行时失败

- **OverflowTestTool**：无失败场景，总是成功
- **SyntheticOutputTool**：输入验证失败时抛出 `TelemetrySafeError`
- **TestingPermissionTool**：权限被拒时返回错误信息

### 命令执行失败

- **/good-claude**：笔录分享失败时显示友好消息，不中断会话
- **/bughunter**：配额超限或被拒时显示对话框，不启动审查

## Design Decisions

### 1. 编译时剔除 vs 运行时检查

**决策**：使用 `bun:bundle` 的 `feature()` 宏进行编译时剔除。

**备选方案**：
- 纯运行时检查：代码体积大，可能泄露内部功能
- 构建配置文件：需要额外构建步骤

**选择理由**：
- 减小生产构建体积
- 防止内部工具意外暴露
- 利用 Bun 的 DCE（Dead Code Elimination）优化

**证据**：`src/tools.ts` 中所有实验工具都使用 `feature()` 条件导入。

### 2. SyntheticOutputTool 的 Schema 缓存策略

**决策**：使用 WeakMap 基于对象引用缓存 Ajv 验证器。

**备选方案**：
- 每次创建都重新编译：性能差
- 基于 schema 字符串哈希：内存占用高

**选择理由**：
- 工作流脚本中通常重复使用相同 schema 对象
- WeakMap 自动垃圾回收，无内存泄漏风险
- 80 次调用从 ~110ms 降到 ~4ms Ajv 开销

**证据**：`createSyntheticOutputTool()` 中的 `toolCache` WeakMap 实现。

### 3. TestingPermissionTool 的环境限制

**决策**：仅在 `process.env.NODE_ENV === 'test'` 时启用。

**备选方案**：
- 特性标志控制：过度设计
- 始终可用但隐藏：有安全风险

**选择理由**：
- 测试环境明确，无意外使用风险
- 简单直接，易于理解

**证据**：`src/tools/testing/TestingPermissionTool.tsx` 中的 `isEnabled()` 实现。

### 4. /good-claude 的笔录分享去重

**决策**：使用内存锁防止重复提交。

**备选方案**：
- 无去重：用户可能意外提交多次
- 全局状态：增加复杂度

**选择理由**：
- 实现简单，符合直觉
- 同一请求的 Promise 共享给所有调用者

**证据**：`handleTranscriptConsent()` 中的去重逻辑。

## Open Questions

1. **OverflowTestTool 的默认大小**：100,000 是否合适？是否需要可配置？
2. **w6 测试套件的未来**：是否应该将这些测试整合到主测试套件中？
3. **SyntheticOutputTool 的交互模式支持**：是否应该在交互会话中也支持？

## Related Documents

- [Coverage](../../architecture/coverage/experimental-features.yaml)
- [Tool System Design](./tool-system-design.md)
- [Command System Design](./command-system-design.md)
