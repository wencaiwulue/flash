---
id: magic-docs
batch: 7
title: MagicDocs 文档生成与同步设计
date: 2026-11-12
status: draft
---

# MagicDocs 文档生成与同步设计

## 1. 背景

MagicDocs 是一个轻量级的文档自动更新系统，它在对话过程中持续跟踪带有特殊标记的 Markdown 文档，并在对话空闲时使用子代理自动更新这些文档，以保持它们与对话内容的同步。

与 `documentation-system`（用于生成和管理结构化的 commit 设计文档）不同，MagicDocs 是**对话驱动的文档更新工具**，它：
- 只在文件被读取时通过特殊 header 发现文档
- 不扫描整个仓库或批量生成文档
- 只跟踪单个会话中读取过的文档
- 使用子代理在后台更新单个文档，而非系统级文档

## 2. 范围

### 目标

- 提供一个简单的标记机制，让用户可以声明某个文档需要自动更新
- 在对话空闲时自动更新标记的文档，基于对话中的新信息
- 保持文档 header 和自定义指令不变
- 允许用户自定义更新提示模板
- 在会话清理时清除跟踪状态

### 非目标

- 不扫描整个仓库寻找 Magic Docs
- 不提供文档初始化或批量创建
- 不跨会话保留跟踪状态（每次会话重新发现）
- 不提供文档审查或验证
- 不与 Git 集成或自动提交

## 3. 文档发现与跟踪流程

### 3.1 发现机制

Magic Docs 通过 `FileReadTool` 的监听器在文件被读取时自动发现：

```text
用户或代理执行 Read 工具
        │
        ▼
FileReadTool 读取文件内容
        │
        ▼
触发 registerFileReadListener 回调
        │
        ▼
detectMagicDocHeader 检查 header 格式
        │
        ├─ 匹配 # MAGIC DOC: <title> → registerMagicDoc → 加入 trackedMagicDocs
        │
        └─ 不匹配 → 忽略
```

### 3.2 Header 格式

Magic Doc header 必须出现在文件开头，格式为：

```markdown
# MAGIC DOC: <title>
```

可选地，在 header 后（允许一个空行）添加斜体指令行：

```markdown
# MAGIC DOC: My Document
*Keep it focused on architecture decisions only*
```

该指令会被传递给更新代理，作为文档特定的更新指南。

### 3.3 跟踪状态

跟踪状态保存在内存中的 `Map<string, MagicDocInfo>`：

- Key: 文件绝对路径
- Value: `{ path: string }`（仅保存路径，状态在每次更新时重新读取）

跟踪状态在以下情况下被清除：
- 文件被删除或不可读（更新时检测）
- 文件不再包含 Magic Doc header（更新时检测）
- 调用 `clearSessionCaches()`（/clear 命令）
- 会话结束

## 4. 文档更新流程

### 4.1 触发时机

文档更新通过 `registerPostSamplingHook` 在每次对话采样后触发，但仅在以下条件满足时执行：

1. `querySource === 'repl_main_thread'`（仅在主线程对话时）
2. 最后一轮助手消息**没有工具调用**（对话空闲）
3. `trackedMagicDocs.size > 0`（有待更新的文档）

### 4.2 单文档更新流程

```text
updateMagicDoc() 开始
        │
        ▼
克隆 FileStateCache，删除目标文件缓存
        │
        ▼
重新读取文件内容（避免 dedup 返回缓存）
        │
        ├─ 文件不存在/不可读 → 从 trackedMagicDocs 移除 → 结束
        │
        ▼
重新检测 header 和指令
        │
        ├─ header 消失 → 从 trackedMagicDocs 移除 → 结束
        │
        ▼
buildMagicDocsUpdatePrompt() 构建提示
        │
        ▼
使用 runAgent() 启动 magic-docs 子代理
        │
        ├─ forkContextMessages: 当前对话历史（不含当前更新指令）
        ├─ canUseTool: 仅允许 Edit 工具，且只能编辑该文档
        ├─ tools: 仅 FILE_EDIT_TOOL_NAME
        └─ model: sonnet
        │
        ▼
子代理执行 Edit 工具更新文档
        │
        ▼
结束（不等待或显示结果）
```

### 4.3 顺序执行

多个文档通过 `sequential()` 包装器**串行更新**，避免并发文件编辑冲突。

## 5. 输入与输出

### 5.1 输入

- **对话历史**：通过 `forkContextMessages` 传递给子代理
- **当前文档内容**：每次更新前重新读取
- **文档标题**：从 header 提取
- **自定义指令**：可选，从 header 后的斜体行提取
- **可选自定义提示模板**：`~/.claude/magic-docs/prompt.md`

### 5.2 输出

- **文件编辑**：子代理直接使用 Edit 工具修改目标文档
- **无可见输出**：更新在后台完成，不向用户显示结果

## 6. 状态与缓存

### 6.1 缓存隔离

每次更新时克隆 `FileStateCache` 并删除目标文件条目：

```typescript
const clonedReadFileState = cloneFileStateCache(toolUseContext.readFileState)
clonedReadFileState.delete(docInfo.path)
```

这样确保：
- 重新读取文件内容，不会因为 dedup 而返回 `file_unchanged`
- Magic Docs 读取不影响主线程的缓存状态
- 每次都能重新检测 header（可能已被手动修改）

### 6.2 会话清理

`clearTrackedMagicDocs()` 被集成到 `clearSessionCaches()`，在 `/clear` 命令时调用，清除当前会话的所有跟踪状态。

## 7. 失败边界

| 失败场景 | 处理方式 |
|---------|---------|
| 文件不存在或不可读 | 从 `trackedMagicDocs` 移除该文档，静默跳过 |
| 文件不再包含 Magic Doc header | 从 `trackedMagicDocs` 移除该文档，静默跳过 |
| 子代理更新失败 | 抛出异常（由 `runAgent` 处理） |
| 文档更新过程中文件被手动修改 | 下次更新会重新读取，使用最新内容 |
| 多个文档同时更新 | 通过 `sequential()` 串行执行，避免冲突 |

## 8. 覆盖率

见 [Coverage](../../architecture/coverage/magic-docs.yaml)。

## 9. 设计决策

### 9.1 通过 FileReadTool 监听发现文档，而非扫描仓库

**决策**：仅在文件被读取时通过 `registerFileReadListener` 发现 Magic Docs。

**备选方案**：
- 启动时扫描整个仓库寻找 `.md` 文件并检测 header
- 提供显式命令让用户注册 Magic Docs

**代价**：
- 文档不会自动被发现，必须先被读取一次
- 重启会话后需要重新读取才能跟踪

**证据**：
- 避免无必要的文件系统扫描（仓库可能很大）
- 保持 Magic Docs 轻量级，只跟踪用户实际使用的文档
- 符合"按需"原则，不假设用户需要跟踪所有文档

### 9.2 仅在对话空闲时更新（无工具调用）

**决策**：仅当最后一轮助手消息没有工具调用时才触发更新。

**备选方案**：
- 每次采样后都更新
- 使用固定时间间隔后台更新
- 用户显式触发更新

**代价**：
- 用户可能需要等待一轮无工具调用的对话才能看到文档更新
- 更新可能有一定延迟

**证据**：
- 避免在用户正在执行操作时干扰（工具调用表示任务进行中）
- 减少不必要的更新（用户可能正在调试或探索，信息还不完整）
- 利用对话空闲时间，不影响用户体验

### 9.3 子代理仅允许 Edit 工具，且只能编辑目标文档

**决策**：通过自定义 `canUseTool` 限制子代理：
- 只允许 `FILE_EDIT_TOOL_NAME`
- 只允许编辑目标文档路径

**备选方案**：
- 允许更多工具（Read、Bash 等）
- 不限制编辑路径

**代价**：
- 子代理无法读取其他文件来补充文档内容
- 无法执行更复杂的更新操作

**证据**：
- 安全性：防止 Magic Docs 子代理修改其他文件或执行任意命令
- 简单性：限制工具集使行为更可预测
- 完整性：对话历史已通过 `forkContextMessages` 传递，通常不需要再次读取

### 9.4 使用 forkContextMessages 传递对话历史，而非重新构建

**决策**：通过 `forkContextMessages` 将整个对话历史传递给子代理，而非手动构建消息序列。

**备选方案**：
- 手动提取对话中的关键信息
- 只传递最近 N 条消息

**代价**：
- 可能传递较多 token（取决于对话长度）
- 子代理看到的是原始对话，而非精选摘要

**证据**：
- 完整性：子代理能基于完整对话上下文更新文档
- 简单性：不需要设计摘要或选择逻辑
- 一致性：与 AgentTool 的 fork 行为保持一致

### 9.5 每次更新前重新读取文件并重新检测 header

**决策**：每次更新时不依赖缓存的 header 信息，而是：
1. 克隆缓存并删除目标文件条目
2. 重新读取文件内容
3. 重新检测 header 和指令

**备选方案**：
- 首次发现时缓存 header 信息，后续直接使用
- 信任缓存的文件内容

**代价**：
- 多一次文件读取
- 多一次 header 检测

**证据**：
- 鲁棒性：用户可能手动修改了 header 或指令
- 正确性：确保基于最新文件状态更新
- 简单性：不需要维护复杂的缓存失效逻辑

### 9.6 不提供更新结果反馈

**决策**：Magic Docs 更新在后台完成，不向用户显示任何结果或错误。

**备选方案**：
- 显示更新摘要
- 显示错误信息
- 提供更新状态指示器

**代价**：
- 用户不知道文档是否已更新
- 调试困难（错误不可见）

**证据**：
- 非侵入性：Magic Docs 是后台辅助功能，不应干扰主对话
- 简洁性：避免 UI 复杂化
- 用户可以自行检查文档内容变化

### 9.7 支持自定义提示模板

**决策**：允许用户在 `~/.claude/magic-docs/prompt.md` 提供自定义提示模板，使用 `{{variable}}` 语法替换变量。

**备选方案**：
- 只使用内置提示，不支持自定义
- 提供配置选项而非文件模板
- 使用不同的模板语法

**代价**：
- 用户需要了解模板语法
- 自定义模板可能导致更新质量下降

**证据**：
- 灵活性：用户可以根据自己的需求调整更新行为
- 可扩展性：可以添加新变量而不破坏兼容性
- 符合项目其他自定义机制的模式

### 9.8 单轮替换变量，避免双重替换

**决策**：在 `substituteVariables` 中使用单次遍历替换，替换函数直接返回值而非使用 `$` 反向引用。

**备选方案**：
- 逐个替换（先替换 `{{docContents}}`，再替换 `{{docPath}}` 等）
- 使用正则表达式的 `$&` 或 `$1` 反向引用

**代价**：
- 需要小心实现，避免 bug

**证据**：
- 防止双重替换：如果用户文档内容恰好包含 `{{docTitle}}` 等模式，不会被再次替换
- 防止 `$` 反向引用破坏：用户文档内容中的 `$1`、`$&` 等不会被正则引擎误解析

## 10. 与 documentation-system 的区别

| 维度 | MagicDocs | documentation-system |
|-----|-----------|---------------------|
| **目的** | 对话驱动的文档持续更新 | 结构化 commit 设计文档生成 |
| **触发方式** | 读取文件时自动发现，对话空闲时自动更新 | 显式命令触发（`docs:generate`） |
| **文档来源** | 用户手动创建，带特殊 header | 从 Git 历史和结构化记录生成 |
| **更新依据** | 当前对话历史 | Git diff 和提交记录 |
| **范围** | 单个文档，当前会话 | 整个仓库的 commit 历史 |
| **状态持久化** | 仅内存，会话结束清除 | 磁盘上的结构化记录 |
| **与 Git 集成** | 无 | 深度集成（读取历史、生成 commit） |
| **角色** | 后台辅助功能 | 核心工程流程工具 |
| **用户可见性** | 后台运行，无反馈 | 显式输出和检查 |
