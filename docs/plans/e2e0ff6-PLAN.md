---
commit: e2e0ff6e0897141823d361204e81aef79922f33b
title: "Make feature profile test CI-independent"
date: 2026-11-10T19:33:02+08:00
status: implemented
kind: component
---

# 实施计划：Make feature profile test CI-independent

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

同一个外部构建测试需要在本机与 CI 的不同环境 overlay 下得到一致的工具注册结果。提交通过固定第一方端点和显式 tool-search 配置，使既有条件工具稳定进入画像，并把总数及必要成员更新为 32 与 ToolSearch。它解决的是这项测试的两个环境敏感输入，不证明所有继承变量都已隔离，也不把注册断言扩展成真实搜索或网络请求验证。

- 确认父提交画像在独立子进程中构建真实外部 bundle，并已固定占位 key 与 production 模式。
- 确认 ToolSearchTool 已存在且由 isToolSearchEnabledOptimistic 条件注册，31/32 差异可由环境门控解释。
- 把离线注册验证与 API、搜索行为验证分开，测试常量不能被描述为真实凭据或网络结果。

## 复用与兼容处理

### 复用现有实现

- 复用 Bun.spawn 的 stdout/stderr 收集、超时终止和临时目录清理，不新增测试进程框架。
- 复用 verify-enabled-features.ts 与 feature-check.ts 的构建、导出和 FEATURE_PROFILE 协议。
- 复用 toolSearch.ts、providers.ts、tools.ts 和 ToolSearchTool 的生产门控及注册实现。
- 复用 STATUS/RELEASE 已记录的离线验证结果，仅同步工具数量。

### 兼容、迁移与生命周期

- 生产源码和构建脚本未改，用户端点、tool-search 默认模式及代理策略保持原行为。
- fixture 仍以 external USER_TYPE 构建，既有 proactive、Coordinator、Monitor 等画像字段和断言继续有效。
- 硬编码总数需要随后续真实 registry 演进同步更新，这是既有画像契约的延续。

## 文件级实施步骤

### 1. 固定画像子进程的搜索环境

在 enabledFeatures.test.ts 的 Bun.spawn env overlay 中加入 ANTHROPIC_BASE_URL=https://api.anthropic.com 和 ENABLE_TOOL_SEARCH=true，保留 ...process.env、占位 key 与 NODE_ENV=production。这样只控制该测试进程的端点识别和乐观搜索门控，不改 fixture 或生产默认值。

涉及位置：`tests/enabledFeatures.test.ts`

### 2. 收紧真实 bundle 注册预期

在同一画像断言中把 toolCount 改为 32、维持 nullCount 为 0，并向 arrayContaining 加入 ToolSearch。继续复用独立构建 fixture 输出的 JSON，不调用 ToolSearchTool，也不增加测试或 expect 数量。

涉及位置：`tests/enabledFeatures.test.ts`、`tests/fixtures/verify-enabled-features.ts`

### 3. 同步历史能力数量

把 STATUS 的 Built-in tool pool 记录与 RELEASE 的编译画像验证数量同步为 32，保留 77/329 和真实 proactive/multi-worker 未运行等原有边界，不新增无来源的 CI 或 live 结论。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 继承的实验 beta kill switch 可覆盖 ENABLE_TOOL_SEARCH=true，其他环境变量也可改变工具池，CI-independent 不是完全 hermetic。
- 官方 URL 常量不具网络隔离语义；若 fixture 未来加入请求，需要另设 mock 或禁网保护。
- 总数与九项名称子集可能遗漏未列举工具的组成回归，不能替代完整工具池测试。

## 验证顺序

1. 检查子进程 env 同时含固定端点、显式搜索开关、占位 key 和 production。
2. 运行 enabledFeatures 定向测试，读取真实 bundle 的 toolCount=32、nullCount=0 与 ToolSearch 成员。
3. 分别在继承自定义 base URL、不同 ENABLE_TOOL_SEARCH 值的环境中比较画像稳定性，并单独记录残余 kill switch 条件。
4. 依据 at-commit STATUS/RELEASE 引用 77/329、typecheck、build 和 32-tool profile，不把静态记录校验当成历史命令重跑。
5. 如需验证搜索或网络行为，另写 ToolSearch 调用与授权 provider 测试，不从本画像结果推断。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 两个环境敏感输入已在测试子进程中固定。
- 32 个非空工具及 ToolSearch 必要成员已成为画像契约。
- STATUS 与 RELEASE 的工具数量已经同步。
- at-commit 文档保留了 77/329 离线结果及 live 验证边界。

### 未完成或后续工作

- 完整环境隔离和其他工具池变量的确定性尚未完成。
- ToolSearch 行为、真实 API 连通性及 provider/proxy 兼容性未在该提交验证。
- 画像没有覆盖全部 32 个名称或该文件内的名称唯一性。
