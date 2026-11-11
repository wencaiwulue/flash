---
commit: 614bf48f749df56f79562e4c64f765875f8fd880
title: "Enable external features and recover SDK parallel branches"
date: 2026-11-10T18:48:33+08:00
status: implemented
kind: component
---

# 实施计划：Enable external features and recover SDK parallel branches

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要在外部 CLI 与 SDK 包中启用一组已经存在的 feature-gated 能力，并让 ultraplan 的构建注册与 Claude-AI 可用性分层工作。同时要把 CLI 的读侧 DAG 修复提取为可移植共享模块，在 SDK 转公开消息、过滤/分页以及 V2 transcript 装载之前恢复遗漏分支，且不能把没有 on-chain anchor 的无关分支接入会话。

- 确认父构建 features 为空、工具池为 23，且 voice 的 ws import 已存在但 manifest 缺 runtime dependency。
- 以父 sessionStorage 的私有恢复为算法基准，确认 SDK 两条读取路径都经过 buildMainChain。
- 区分 builtInCommandNames 的注册可见性与 getCommands 的 availability 过滤，不预设 external 等于 unrestricted。

## 复用与兼容处理

### 复用现有实现

- 复用 feature(...) 分支、getAllBaseTools、builtInCommandNames 和现有 trigger/voice/bridge/file-persistence/brief 实现。
- 复用 CLI 已有同 message.id、tool_result、timestamp 恢复规则及 tengu_chain_parallel_tr_recovered 事件。
- 复用 getSdkSessionMessages、toSessionMessage、loadSdkSessionTranscript 和现有 JSONL 测试工具。

### 兼容、迁移与生命周期

- feature flags 只改变外部 bundle 的既有分支裁剪，原函数和命令名称保持，声明生成流程不变。
- 读侧恢复维持原消息对象和持久化格式；没有 orphan 的链只经过同一 helper，不改变写入协议。
- offset/limit 继续由公开 API 提供，但页边界现在基于恢复后的完整消息序列。
- CLI analytics 与 SDK 纯恢复解耦，SDK 不需要引入 CLI 日志依赖。

## 文件级实施步骤

### 1. 补齐 voice 运行时依赖

先在 package.json 声明 ws ^7.5.11，再更新 bun.lock 的 root 引用并复用已有解析条目，使后续 VOICE_MODE bundle 能解析既有 voiceStreamSTT import。

涉及位置：`package.json`、`bun.lock`

### 2. 配置外部构建与命令门槛

在 scripts/build.ts 为 CLI/SDK 同步加入七 flags 并保持 external；随后把 ultraplan 从 internal-only 注册移入普通命令数组，在命令定义中设置 claude-ai availability 和非 internal-user 的 enabled 判断。

涉及位置：`scripts/build.ts`、`src/commands.ts`、`src/commands/ultraplan.tsx`

### 3. 提取共享 DAG 恢复

依据父 CLI 私有实现新建 sessionChainRecovery.ts，泛化可移植消息类型，固定同 ID 分组、最后 on-chain anchor、分别排序与插入以及无 anchor 排除。让 sessionStorage.ts 改用 helper 并保留 analytics，再让 sdkSessions.ts 在 reverse 后调用，以同时覆盖公开读取和 transcript loader。

涉及位置：`src/utils/sessionChainRecovery.ts`、`src/utils/sessionStorage.ts`、`src/utils/sdkSessions.ts`

### 4. 建立外部 profile 与 DAG 回归

用 feature-check.ts 导出注册入口，verify-enabled-features.ts 构建并加载真实外部 bundle，enabledFeatures.test.ts 固定 27 工具和命令结果。再在 sdkSessions.test.ts 构造 parallel siblings/tool results，核对公开顺序、分页、transcript 与 disconnected-parent 反例。

涉及位置：`tests/fixtures/feature-check.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`、`tests/sdkSessions.test.ts`

### 5. 同步状态与发布证据

将 STATUS 的 61/247 更新为实际记录的 64/261、工具数更新为 27，并说明 external feature 与 SDK DAG 范围；RELEASE 追加组件段及命令汇总，不复制父提交 CI run，也不把 mock/offline 测试写成在线服务证据。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 同 ID sibling 与 tool_result 若混合排序会破坏局部因果；实现分组后分别排序，并固定 assistants 在前、results 在后。
- 跨 missing parent 搜索可能纳入无关会话内容；只有触及主链的 message.id 组才允许恢复。
- 构建注册与运行时 availability 含义不同，单看 builtInCommandNames 会高估 ultraplan 的可用用户范围。
- 新增 feature 可能暴露未声明依赖；ws 入库和独立 bundle/load 测试用于提前发现这一问题。
- 后续提交增加 flags/工具数时不能直接沿用本提交的 27，应以 at-commit profile 为准。

## 验证顺序

1. 构建干净外部夹具，检查 USER_TYPE=external、27 个非空工具、四个 trigger 工具和 ultraplan/voice/brief 注册。
2. 用临时 JSONL 验证同 ID assistant siblings 与 results 的精确顺序、UUID 唯一性和 offset/limit 页面。
3. 直接调用 loadSdkSessionTranscript，确认它与公开读取获得相同恢复顺序，并单独测试 missing-parent 排除。
4. 检查 CLI 调用仍产生 recovered_count 日志而共享 helper 不修改 seen 或持久化文件。
5. 引用 at-commit STATUS/RELEASE 的 64/261、typecheck、build 和 smoke 记录，不虚构 614bf48 的 CI 或在线服务结果。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 外部依赖、七标志构建和 ultraplan 双层门槛已经形成可加载 profile。
- 共享纯恢复已替换 CLI 私有实现，并嵌入 SDK 主链构建的统一前置位置。
- 三个新增离线回归覆盖 profile、消息/分页/transcript 以及 disconnected branch 反例。
- 文档已记录本提交的 64/261 与构建验证范围。

### 未完成或后续工作

- 真实外部服务和完整 V2 resumed-query 没有新增在线证据。
- 被继续禁用的内部系统及其 stub/proactive/Coordinator 工作仍待独立实现。
