---
commit: 982ab108e16a0919269629256555d7ef9efea707
title: "Enable Buddy and Fork Subagent"
date: 2026-11-10T22:28:04+08:00
status: implemented
kind: component
---

# 实施计划：Enable Buddy and Fork Subagent

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要让 Buddy 在回合后通过既有 side-query 生成并保存模型灵魂、发出短反应并支持状态/静音，同时让 Fork 通过现有 cache-preserving 子 agent 路径和真实 /fork prompt 入口可用。实现必须保持用户 ID 决定的 bones 与模型生成 soul 的边界，不能把注入 runner 的离线测试当成真实模型孵化或 fork worker 的在线证据。

- 确认父提交 roll/getCompanion、StoredCompanion/companionMuted 和 forkSubagent 核心已经存在且本提交不应重写。
- 确认 runSideQuestion 接受 cacheSafeParams、禁止工具且只运行一轮，observer 所需 ToolUseContext 可由 REPL 提供。
- 确认 /fork 应通过省略 subagent_type 的 Agent 调用进入既有隐式 fork，而不是新增 local worker API。
- 将注入 run/config 的离线行为与真实模型、真实配置及后台 worker 验证分开。

## 复用与兼容处理

### 复用现有实现

- 复用 companion.ts 的 hash/PRNG、bones 生成、getCompanion 和 types.ts 的 soul/storage 类型。
- 复用 getGlobalConfig/saveGlobalConfig、runSideQuestion、上下文收集和 systemPrompt 类型。
- 复用 FORK_AGENT、buildForkedMessages、buildChildMessage、isInForkChild 和 buildWorktreeNotice。
- 复用 local/prompt command 类型、REPL AppState、Bun feature flags 和 enabled-feature 构建夹具。

### 兼容、迁移与生命周期

- StoredCompanion 仍只含 name/personality/hatchedAt，旧配置中的 bones 字段在读取时被重算值覆盖。
- /buddy 保持命令名称，新增可选 status/mute/unmute；mute 不清除已有 soul，unmute 后继续复用它。
- /fork 保持名称并改为 prompt 类型，Fork 的 coordinator 与 non-interactive 禁用条件不变。
- 其他工具和 36-tool 特性档规模不因两个命令入口而改写，完整 KAIROS/私有后端仍保持原边界。

## 文件级实施步骤

### 1. 实现 Buddy 观察与灵魂持久化

在 companionObserver.ts 增加依赖注入、最新用户文本和受限 JSON 解析，按 context/inFlight/mute/stored-user-text 条件门控。以 roll 的 bones 构造首次或后续 prompt，通过 cacheSafeParams 调 runSideQuestion；首次同时得到 name/personality 才保存 hatchedAt soul，任何有效 reaction 走回调，异常记 debug 并在 finally 释放单飞。

涉及位置：`src/buddy/companionObserver.ts`

### 2. 接通 Buddy 命令和 REPL 回合入口

在 buddy/index.ts 实现默认 status、mute/unmute 和 usage，用 getCompanion 显示确定性 bones 加持久 soul。随后在 REPL.tsx 的 query 完成后把 toolUseContext 传给 fireCompanionObserver，保持 fire-and-forget 和 reaction 状态去重。

涉及位置：`src/commands/buddy/index.ts`、`src/screens/REPL.tsx`

### 3. 把 /fork 接入既有隐式 Fork

在 fork/index.ts 改为受 isForkSubagentEnabled 控制的 prompt command，空参数给 usage，非空参数生成包含完整 directive 的 Agent 指令并明确省略 subagent_type、后台运行。不要复制 forkSubagent.ts 的 prefix/guard/worktree 逻辑。

涉及位置：`src/commands/fork/index.ts`

### 4. 启用外部构建特性

在 build.ts 的 features 列表加入 BUDDY 和 FORK_SUBAGENT，使新 observer、命令和既有 fork 核心进入外部 bundle；保留 coordinator/non-interactive 的 Fork 运行时条件。

涉及位置：`scripts/build.ts`

### 5. 添加离线行为与编译特性回归

在 buddyFork.test.ts 用相同 seed、注入 run/config/now 和消息 helper 验证 bones、JSON、soul/reaction、Fork guard/placeholder/worktree 与 /fork prompt，不把它写成 live 测试。fixture 开启两个 flag 并输出命令存在性，enabledFeatures.test.ts 读取真实构建结果添加对应断言。

涉及位置：`tests/buddyFork.test.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`

### 6. 同步状态与发布证据

在 STATUS.md 更新 118/516、Buddy/Fork offline/build 行及剩余私有后端说明，在 RELEASE.md 概括 bones/soul、mute/reaction 和 Fork cache/guard/worktree/prompt，并记录 typecheck/build/declarations/36-tool profile。明确这些记录不包含真实模型或 worker 在线证据。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 模型可能返回非法 JSON 或缺失 soul 字段；解析失败不保存，首次必须 name/personality 同时存在，异常通过 debug 收口。
- 全局 inFlight 会丢弃并发观察而非排队，mute 只影响未来调用；这些是当前明确行为，不是跨进程协调。
- 相同 placeholder 有助于缓存前缀，但 fork child 保留 Agent 工具，必须依靠历史 tag guard 防递归。
- 继承父上下文的 worktree 路径可能过期，notice 要求路径翻译和编辑前重读，不能假设父工作区文件同步。
- prompt 测试无法证明主模型会正确调用 Agent，注入 observer run 也无法证明真实模型遵循特征约束。

## 验证顺序

1. 先运行 Buddy 确定性 roll/JSON 测试，再观察首次注入响应保存 soul、第二次只 reaction 且不保存。
2. 分别核对无 context、mute、inFlight、空用户文本与非法响应分支；这些分支如需执行结论应有独立测试来源。
3. 运行 Fork helper 测试，比较所有 placeholder、parent UUID、recursive tag、worktree 路径和 /fork 完整 directive。
4. 构建独立特性夹具并检查 buddy/fork 命令存在，同时确认 FORK_SUBAGENT 的 coordinator/non-interactive 条件未被移除。
5. 依据 at-commit STATUS/RELEASE 引用 118/516、typecheck、build/declarations 和 36-tool profile，不把静态记录校验写成历史执行。
6. 真实模型 side-query、配置跨进程持久化和实际后台 fork worker 只在授权环境另验并记录来源。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- Buddy observer、受限 JSON、首次 soul 保存、后续 reaction、静音和 REPL wiring 已实现。
- /buddy 与 /fork 已从禁用 stub 变为实际命令，外部构建和特性档包含两个 flag。
- Fork cache prefix、递归 guard、worktree notice 和权限/模型继承继续复用既有核心。
- 离线行为测试、构建注册断言及 STATUS/RELEASE 记录已经加入。

### 未完成或后续工作

- 真实模型孵化/reaction、缓存命中和配置跨进程持久化未验证。
- /fork 经主模型到真实后台 worker 的端到端执行未验证。
- 完整 KAIROS 与私有 computer-use/browser 后端仍为剩余边界。
