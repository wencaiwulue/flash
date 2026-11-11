---
commit: 4b9d30f7953273e567a18eb819f4eddd45fcc877
title: 单根源码快照的内容与边界
date: 2026-03-31
status: partial
retrospective: true
---

# 单根源码快照的内容与边界

## 提交性质

该提交是没有父提交的源码基线，不是 1903 个文件从零开发的完整设计记录。根 diff 只有 `README.md` 和 `src/` 两类顶层内容：README 一个文件，src 下 1902 个文件。它保存了当时的模块结构，却无法提供各模块真实的实现先后、作者讨论或逐提交意图。

因此，本 SPEC 分两层描述：可以静态确认的架构，以及该快照本身不具备的构建与历史信息。

## 可确认的架构

### 会话主线

`src/main.tsx` 是 CLI 入口，`src/QueryEngine.ts` 与 `src/query.ts` 组织模型会话。输入进入查询循环后，模型流产生 assistant/system 消息和 tool_use；工具结果被收集并回填后续 turn。`src/entrypoints/agentSdkTypes.ts` 定义 SDK 类型与公共 API 外形，但该 revision 的 query、V2 session 和 remote-control 等入口仍有显式未实现部分，不能把类型外形视为可用链路。

### 工具与权限

`src/Tool.ts` 统一工具输入 schema、权限检查、执行、只读和并发属性。`src/tools.ts` 与 `src/tools/` 提供内建工具，`src/services/mcp/` 引入外部 MCP 工具。权限相关 hooks 和 `src/utils/permissions/` 在工具执行前参与 allow/ask/deny 判定；长生命周期任务由 `src/tasks/` 等模块与一次性工具调用区分。

### 终端与扩展

`src/components/`、`src/screens/` 和 `src/ink/` 负责终端 UI，不是另一套查询引擎。`src/commands/` 组织 slash commands，`src/plugins/` 与 `src/skills/` 提供扩展点。`src/bridge/`、`src/remote/`、`src/server/` 将会话能力适配到 IDE 或远程传输。

### 横切服务

`src/services/` 包含 API、OAuth、MCP、compaction、analytics 和 LSP；`src/utils/` 包含设置、存储、沙箱、模型、任务等共享实现。`bun:bundle` 的 `feature(...)` 和动态 import 表达了构建裁剪与延迟加载意图，但快照没有对应构建配置，不能据此推导可用产物。

## 关键边界

1. **没有构建闭环**：根树缺少 `package.json`、lockfile、`tsconfig.json` 和常规测试目录，不能独立安装、类型检查或构建。
2. **存在静态导入缺口**：例如 `src/tools.ts` 引用了树中不存在的 TungstenTool，部分 message/tools 类型也缺失。文件数量不能证明模块可链接。
3. **SDK 外形不等于实现**：公共类型和部分内部函数存在，但关键 API 仍有 unsupported stub。
4. **历史被压缩**：无法从空树 diff 判断某个模块何时、为何或以何种备选方案实现。
5. **README 不是源码事实的替代品**：研究定位、文件规模和背景描述必须与实际 revision 分开理解。

## 快照的使用方式

该基线适合用作：

- 后续恢复提交的源码输入；
- 查询、工具、权限和 UI 模块关系的静态参考；
- 对缺失构建元数据、导入目标和 SDK 边界进行核对的起点。

它不应被当作可发布版本、完整开发计划或历史验证依据。

## 验收标准

1. `git rev-list --parents -n 1 4b9d30f` 只显示 commit 自身，没有父 SHA。
2. 根 diff 包含 1903 个新增文件且没有 rename；顶层只有 README.md 与 src/。
3. 能从入口静态追踪 QueryEngine/query、工具注册、权限上下文和工具结果回填路径。
4. 文档明确列出构建配置、关键导入和 SDK stub 边界，不把源码规模解释为可运行性。
5. 对快照的复现以 tree hash 完全一致为准，而不是仅比较目录名或文件数量。
