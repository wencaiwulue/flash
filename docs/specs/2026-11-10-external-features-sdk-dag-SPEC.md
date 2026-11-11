---
commit: 614bf48f749df56f79562e4c64f765875f8fd880
title: "Enable external features and recover SDK parallel branches"
date: 2026-11-10T18:48:33+08:00
status: implemented
kind: component
---

# Enable external features and recover SDK parallel branches

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交 02bc3c2 的 CLI/SDK 外部构建均为 features: []，基础工具池记录为 23；ultraplan 位于 INTERNAL_ONLY_COMMANDS 且由 internal-user 检查禁用。CLI 的 buildConversationChain 已有私有 parallel-branch 恢复逻辑，而 SDK buildMainChain 只反转 single-parent walk，无法保留同 API message.id 的 assistant siblings 及其 tool_result 分支。

需要在外部 CLI 与 SDK 包中启用一组已经存在的 feature-gated 能力，并让 ultraplan 的构建注册与 Claude-AI 可用性分层工作。同时要把 CLI 的读侧 DAG 修复提取为可移植共享模块，在 SDK 转公开消息、过滤/分页以及 V2 transcript 装载之前恢复遗漏分支，且不能把没有 on-chain anchor 的无关分支接入会话。

## 目标与非目标

### 目标

- 为 CLI 和 SDK 外部 bundle 配置同一组七个 feature flags，并满足 voice 实现所需的 ws runtime dependency。
- 让 ultraplan 脱离 internal-only 注册块，以 claude-ai availability 保留运行时订阅门槛。
- 将 parallel assistant/tool-result recovery 变成 CLI 与 SDK 共用的纯读侧变换，并固定插入顺序和 recoveredCount。
- 用独立 bundle 与临时 JSONL 回归覆盖外部 profile、两条 SDK 读取出口及 disconnected-branch 拒绝。

### 非目标

- 不构建或宣称 USER_TYPE=ant；at-commit build 和验证夹具都显式使用 external。
- 不启用完整 KAIROS、proactive、workflow 或 computer-use，也不实现仍处于 stub 的工具和 Coordinator worker。
- 不改变 JSONL 写入拓扑、parentUuid 或 API message.id，恢复只发生在读取已持久化消息时。
- 不把注册测试解释为 voice、bridge、remote trigger 或 ultraplan 的在线服务验证。
- 不宣称新增测试覆盖了完整 V2 resumed-query；直接覆盖的是 loadSdkSessionTranscript。

## 方案架构与数据流

构建层在 scripts/build.ts 为 CLI 与 SDK 同时声明 AGENT_TRIGGERS、AGENT_TRIGGERS_REMOTE、VOICE_MODE、BRIDGE_MODE、ULTRAPLAN、FILE_PERSISTENCE、KAIROS_BRIEF。它们打开现有 feature(...) 分支：前两项向工具池加入 CronCreate/CronDelete/CronList/RemoteTrigger，使命中数量由 23 变为 27；VOICE_MODE、BRIDGE_MODE、ULTRAPLAN、KAIROS_BRIEF 控制命令装载，FILE_PERSISTENCE 复用已有持久化路径。process.env.USER_TYPE 继续定义为 external，声明生成仍是独立 TypeScript 阶段。

voice 的启用暴露已有 voiceStreamSTT 对 ws 的运行时导入，因此 package.json 增加 ws ^7.5.11，bun.lock 只增加 root dependency 引用，解析到的 ws 7.5.11 package entry 已由其他依赖提供。这项依赖是外部 profile 能实际 bundle/load 的组成条件，而不是新的传输协议实现。

命令注册分为构建与运行时两道门：commands.ts 把 feature(ULTRAPLAN) 条件下的 ultraplan 从 INTERNAL_ONLY_COMMANDS 移入普通 COMMANDS；ultraplan.tsx 用 availability: [claude-ai] 和 isEnabled: () => true 替代 internal-user 判断。getCommands 先应用 availability 再检查 enabled，所以 builtInCommandNames 的注册断言只证明 bundle 含入口，并不表示所有 external 用户都可调用。

共享恢复模块 recoverOrphanedParallelToolResults 接收 transcript-shaped messages、原 chain 和 seen，只依赖 type-only crypto.UUID。它按非空 API message.id 对 on-chain assistant 分组，以组内最后一个 on-chain assistant 为 anchor；再索引同 ID 的 assistant siblings 与含 tool_result 的 user messages。对每个触及主链的组，分别收集未见 siblings 和该组所有成员的未见 tool results，按 timestamp 稳定排序，并在 anchor 后依次插入 siblings、tool results。返回值是 { chain, recoveredCount }，不改写 seen。

sessionStorage.ts 删除私有算法后由 buildConversationChain 调用共享 helper，CLI 独有的 tengu_chain_parallel_tr_recovered analytics 留在外层。sdkSessions.ts 则在 parent-UUID walk reverse 之后调用同一 helper，因此修复在公共转换之前生效，同时让 CLI 与 SDK 使用同一 anchor、排序和缺失父节点规则。没有匹配 on-chain assistant 的 sibling group 不进入结果。

公开读取路径由 getSessionMessages 经 getSdkSessionMessages 进入 buildMainChain，恢复完成后才执行 toSessionMessage、null/system filtering 和 offset/limit；因此分页基于补齐后的顺序。V2 resume 经 resumeSdkSession 调用 loadSdkSessionTranscript，也复用该 buildMainChain，再把恢复后的 initialMessages 交给 createSdkQuery。新增测试直接验证公开消息/分页和 transcript loader，并未把后者扩展成在线 query 测试。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `package.json`，符号 `"ws": "^7.5.11"` | 为启用 VOICE_MODE 后既有 voiceStreamSTT 的 WebSocket import 增加 runtime dependency。 |
| 变更 | `bun.lock`，符号 `"ws": "^7.5.11"` | 在 root packages 引用 ws ^7.5.11；复用 lockfile 已存在的解析条目。 |
| 变更 | `scripts/build.ts`，符号 `KAIROS_BRIEF` | 对 CLI 与 SDK 开启相同七个 feature flags，并保持 USER_TYPE=external 和独立声明构建。 |
| 变更 | `src/commands.ts`，符号 `INTERNAL_ONLY_COMMANDS` | 将条件 ultraplan 注册移出 internal-only block，加入普通 COMMANDS 组成。 |
| 变更 | `src/commands/ultraplan.tsx`，符号 `availability: ['claude-ai']` | 用 Claude-AI availability 替代 internal-user enablement，保留构建 feature 与运行时订阅两层限制。 |
| 变更 | `src/utils/sessionChainRecovery.ts`，符号 `recoverOrphanedParallelToolResults` | 新增纯共享 DAG 恢复：同 ID 分组、anchor 插入、时间排序、seen 去重和 recoveredCount。 |
| 变更 | `src/utils/sessionStorage.ts`，符号 `buildConversationChain` | 删除 112 行私有恢复实现并复用共享 helper，CLI analytics 留在调用层。 |
| 变更 | `src/utils/sdkSessions.ts`，符号 `buildMainChain` | 在 reverse 后、公开转换/分页及 transcript 消费前执行共享恢复。 |
| 变更 | `tests/fixtures/feature-check.ts`，符号 `getAllBaseTools` | 为独立外部 bundle re-export 工具池与 builtInCommandNames。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `FEATURE_PROFILE=` | 以相同七 flags 和 external 用户类型执行 Bun.build，加载产物并输出工具/命令 profile。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `toolCount` | 新增子进程回归，检查 27/null=0、四个 trigger 工具和三个命令注册。 |
| 变更 | `tests/sdkSessions.test.ts`，符号 `does not recover unrelated branches across a missing parent` | 新增两个 JSONL 测试，覆盖恢复后读/分页/transcript 顺序和 disconnected branch 拒绝。 |
| 变更 | `docs/STATUS.md`，符号 `parallel assistant/tool-result DAG recovery` | 更新 64/261、27 工具、外部特性矩阵、DAG 证据、ultraplan availability 与后续工作。 |
| 变更 | `docs/RELEASE.md`，符号 `## External feature profile and SDK DAG recovery` | 新增本组件的发布说明和 64/261 等验证汇总，未附本提交 CI run。 |
| 复用 | `src/tools.ts`，符号 `AGENT_TRIGGERS_REMOTE` | 复用现有 feature-gated 工具组装，使四个 trigger 工具进入外部基础池。 |
| 复用 | `src/services/voiceStreamSTT.ts`，符号 `from 'ws'` | 既有 voice 实现是新增 ws runtime dependency 的直接消费者。 |
| 复用 | `src/entrypoints/agentSdkTypes.ts`，符号 `getSessionMessages` | 公开 SDK 消息读取经 getSdkSessionMessages 消费恢复后的链，再做转换和分页。 |
| 复用 | `src/utils/sdkSessionConversation.ts`，符号 `loadSdkSessionTranscript` | V2 resume 复用同一 transcript loader 取得恢复后的 initialMessages。 |

## 关键决策与工程取舍

- 七个标志在 CLI 与 SDK build definitions 中保持一致，避免两个外部产物对同一 feature 源码作不同裁剪；完整内部系统仍不随 KAIROS_BRIEF 自动开启。
- 将恢复算法放在无 I/O、无 CLI analytics 的纯模块中，以可移植消息结构服务 SDK；日志副作用由 CLI 调用方根据 recoveredCount 自行保留。
- 以同 ID 组内最后一条已在主链的 assistant 为插入锚点，而不是把所有孤儿附加到末尾，可保持 sibling/tool-result 与对应模型回复的局部关系。
- 恢复只处理与主链有明确 message.id 关联的组；放宽到全文件搜索会把 disconnected branch 错接进当前会话。
- ultraplan 使用 claude-ai availability 而非把 isEnabled 直接当作订阅判断，使命名注册检查与实际命令过滤各自表达不同层次。

### 备选方案与回溯分析

- 回溯性比较：复制 CLI 私有恢复到 SDK 会少一次抽取，但两套 anchor、去重和排序规则容易漂移；共享纯函数增加泛型边界，换取两条读取链的一致行为。
- 回溯性比较：在分页后补回遗漏消息无法修正 page 边界，也会让 transcript resume 看到不同顺序；实际把恢复放在 buildMainChain 末端，保证所有下游消费同一完整链。
- 回溯性比较：把 ultraplan 留在 INTERNAL_ONLY_COMMANDS 可维持旧注册方式，却无法与本次外部 ULTRAPLAN 入口一致；移入普通条件注册后仍需 availability 防止无条件开放。

## 安全与协议边界

- USER_TYPE 明确为 external，七个 flag 是逐项 allowlist；KAIROS_BRIEF 不等于开放完整 KAIROS 或其他内部实验系统。
- ultraplan 的 bundle 注册不绕过 Claude-AI availability，测试中的 builtInCommandNames 也不替代实际 getCommands 过滤。
- 恢复 helper 只重组内存中的已读消息，不写 transcript、不修改 seen，也不把无 on-chain 关联的内容并入会话。
- 外部 profile 回归在干净子进程中构建/加载 bundle；真实 voice、bridge、remote 与 OAuth 服务仍需各自授权环境验证。

## 验收标准

- CLI/SDK 构建同时含指定七个 flags 和 USER_TYPE=external，独立 profile 为 27 个非空工具并含四个 trigger 工具及 ultraplan、voice、brief 注册。
- ws 作为 runtime dependency 被 package manifest 与 lockfile 一致引用，能够支撑启用后的 voice bundle。
- 同一 API message.id 的遗漏 assistant siblings 与 tool results 按确定顺序插回 anchor 后，公开转换、分页和 transcript loader 得到一致链。
- 没有匹配主链 assistant 的 disconnected branches 保持排除，CLI recovery analytics 仍能取得 recoveredCount。
- at-commit STATUS/RELEASE 把全量记录更新为 64 tests、261 assertions，且不把父提交的 CI run 归到本提交。

## 实现状态与剩余范围

- 状态：**implemented**
- 真实 Cloud API、remote bridge、voice、trigger 与 ultraplan 服务路径仍需授权环境验证，oauth refresh 证据仍为 mocked。
- 完整内部系统和剩余 stub/proactive/Coordinator 能力没有被七个外部 flags 自动实现。
- V2 测试止于 transcript loader；恢复后的消息进入完整 resumed query 的端到端行为未由新增回归覆盖。
