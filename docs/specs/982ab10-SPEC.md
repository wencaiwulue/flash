---
commit: 982ab108e16a0919269629256555d7ef9efea707
title: "Enable Buddy and Fork Subagent"
date: 2026-11-10T22:28:04+08:00
status: implemented
kind: component
---

# Enable Buddy and Fork Subagent

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交已有确定性的 companion roll/getCompanion、配置中的 StoredCompanion/companionMuted 字段，以及完整 forkSubagent 工具，但外部构建未启用 BUDDY/FORK_SUBAGENT。fireCompanionObserver 是空实现，REPL 调用时不传 ToolUseContext；/buddy 与 /fork 都是 isEnabled=false 的 unavailable 文本命令。STATUS 仍把 Buddy/Fork 列为 disabled，因此缺少的是观察、持久化、用户入口和构建 wiring，而不是确定性骨骼或 fork 上下文核心。

需要让 Buddy 在回合后通过既有 side-query 生成并保存模型灵魂、发出短反应并支持状态/静音，同时让 Fork 通过现有 cache-preserving 子 agent 路径和真实 /fork prompt 入口可用。实现必须保持用户 ID 决定的 bones 与模型生成 soul 的边界，不能把注入 runner 的离线测试当成真实模型孵化或 fork worker 的在线证据。

## 目标与非目标

### 目标

- 实现 companion observer 的消息提取、JSON 解析、单飞/静音门控、模型调用、灵魂保存和反应回调。
- 保留 roll 产生的 rarity/species/eye/hat/shiny/stats 确定性，只持久化 name/personality/hatchedAt。
- 启用 /buddy status、mute、unmute，并在 REPL 回合结束后传入真实 ToolUseContext 触发 observer。
- 复用 Fork 的缓存前缀、递归 guard 和 worktree notice，以省略 subagent_type 的 Agent 指令实现 /fork <directive>。
- 在外部构建开启 BUDDY/FORK_SUBAGENT，并添加离线行为与编译特性档回归。
- 更新 STATUS/RELEASE 的执行记录和剩余边界，不把其他私有后端标为完成。

### 非目标

- 不重写 companion.ts 的 seeded PRNG、bones 类型或 getCompanion 合并规则，也不把模型输出当作 bones 来源。
- 不修改 forkSubagent.ts、runForkedAgent 或锁/权限协议；本提交启用既有核心而非另建后台 agent 框架。
- 不让 /fork 命令自己直接执行 worker；它生成要求主 agent 调用 Agent 工具的 prompt。
- 不宣称真实模型 side question、真实全局配置跨进程读取或真实 fork worker 已完成端到端验证。
- 不启用完整 KAIROS 或私有 computer-use/browser 后端，也不把 STATUS 的既有 live 项扩展为新的在线结果。

## 方案架构与数据流

Buddy 的身份分为两层：roll 以 oauthAccount.accountUuid ?? userID ?? anon 加固定 salt 得到确定性 bones 和 inspirationSeed，getCompanion 读取配置后把 bones 放在展开顺序末尾覆盖旧字段；observer 只在首次孵化时保存 name、personality、hatchedAt。模型 prompt 接收 bones 作为不可变特征和仅供参考的 seed，后续已有 stored soul 时只请求 reaction，不再写 soul。

fireCompanionObserver 在缺少 context、进程级 inFlight 或 companionMuted 时直接返回；已有 companion 且最新用户文本为空时也不请求。latestUserText 只取最后一条 user 消息的字符串或 text blocks，并截到 4000 字符。cacheSafeParams 组合 renderedSystemPrompt、user/system context、ToolUseContext 和当前消息，默认 runObserverModel 动态调用 runSideQuestion，测试可注入 run/config/now。

parseCompanionObserverResponse 从首个 { 到最后一个 } 解析 JSON，只接受字符串 name/personality/reaction，分别限制 40/300/500 字符。首次只有 name 与 personality 同时存在才通过 saveGlobalConfig 写入 companion 和注入时间；非空 reaction trim 后交给回调。异常统一写 debug，finally 释放 inFlight，因此无效输出不会伪造孵化。

REPL 在主 query 流结束后以 void 调用 observer，并新增 toolUseContext 参数；onReaction 通过 setAppState 更新 companionReaction，相同文本不重复写状态。/buddy 改为可非交互 local command，默认 status 通过 getCompanion 组合持久灵魂和即时 bones，mute/unmute 只更新 companionMuted，非法参数返回 usage。

Fork 核心保持在复用模块：FORK_AGENT 使用 tools [*]、model inherit、permissionMode bubble；buildForkedMessages 克隆 parent assistant 并替换 UUID，为每个 tool_use 生成内容完全相同的 placeholder tool_result，再把带 fork tag 的 per-child directive 放在最后，使除末尾指令外的 API 前缀可共享缓存。isInForkChild 检查历史中的 boilerplate tag 防递归，buildWorktreeNotice 要求子 worker 翻译父路径、重读文件并认识到工作区隔离。

/fork 改为 prompt command，由 isForkSubagentEnabled 继续受 FORK_SUBAGENT、coordinator mode 和 interactive session 条件约束。空指令返回 usage；非空指令生成文本，要求使用不带 subagent_type 的 Agent 工具以后台 worker 继承当前会话。build.ts 与独立特性夹具同时加入 BUDDY/FORK_SUBAGENT，组合测试检查 buddy/fork 命令确实进入外部构建。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/RELEASE.md`，符号 `## Buddy and Fork Subagent` | 记录 bones/soul、reaction/mute、Fork 核心和 118/516 及构建验证范围。 |
| 变更 | `docs/STATUS.md`，符号 `\| Buddy and Fork Subagent \|` | 把 Buddy/Fork 标为 offline/build 验证并更新全量结果和剩余后端边界。 |
| 变更 | `scripts/build.ts`，符号 `'FORK_SUBAGENT'` | 在外部构建 features 中同时启用 BUDDY 与 FORK_SUBAGENT。 |
| 变更 | `src/buddy/companionObserver.ts`，符号 `parseCompanionObserverResponse` | 实现 side-query 观察、受限响应、首次 soul 持久化、reaction 和单飞/静音控制。 |
| 变更 | `src/commands/buddy/index.ts`，符号 `action === 'mute'` | 启用 status/mute/unmute 非交互 local command。 |
| 变更 | `src/commands/fork/index.ts`，符号 `getPromptForCommand` | 把禁用 stub 改为引导无 subagent_type 后台 Agent 的 prompt command。 |
| 变更 | `src/screens/REPL.tsx`，符号 `fireCompanionObserver(` | 回合结束后传入 toolUseContext，并把 reaction 写入 AppState。 |
| 变更 | `tests/buddyFork.test.ts`，符号 `describe('Fork subagent'` | 新增 Buddy 注入模型测试和 Fork prefix/guard/worktree/prompt 离线回归。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `expect(profile.hasForkCommand).toBe(true)` | 要求外部编译特性档包含 buddy 和 fork 命令。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `hasBuddyCommand` | fixture 开启两个 flag 并输出命令注册结果供组合测试断言。 |
| 复用 | `src/buddy/companion.ts`，符号 `export function getCompanion` | 复用 seeded roll 和 bones-last 合并，持久化灵魂不覆盖确定性身份。 |
| 复用 | `src/buddy/types.ts`，符号 `export type StoredCompanion` | 复用 CompanionBones/CompanionSoul/StoredCompanion 分层和 RARITY_STARS。 |
| 复用 | `src/tools/AgentTool/forkSubagent.ts`，符号 `export function buildForkedMessages` | 复用 cache-identical placeholder prefix、FORK_AGENT、tag guard 与 worktree notice。 |
| 复用 | `src/utils/sideQuestion.ts`，符号 `export async function runSideQuestion` | 复用单轮无工具 side-query、cacheSafeParams 和 skipCacheWrite。 |
| 复用 | `src/utils/config.ts`，符号 `companionMuted?: boolean` | 复用全局配置中的 StoredCompanion/companionMuted 字段及读写接口。 |

## 关键决策与工程取舍

- 把模型生成的信息限制为 soul，bones 每次由用户身份重算；这样配置中的 name/personality 可持久化，而 rarity/species/stats 不由模型或旧配置字段决定。
- 复用 runSideQuestion 的单轮、无工具 forked agent，而不是在 observer 新建模型循环；cacheSafeParams 继续传父上下文，side-query 自身 skipCacheWrite。
- 以进程级 inFlight 和静音读取避免并发/禁用观察，回调只携带短 reaction；本提交没有引入跨进程 observer 锁。
- /fork 使用 prompt 引导既有 Agent 隐式 fork，而非 local command 另开执行通道；递归限制、权限 bubble、模型继承和 worktree 提示都留在同一核心。
- 构建、独立 fixture 和组合特性测试使用同一对 flag，避免源码命令可用但外部 bundle 仍裁掉实现。

### 备选方案与回溯分析

- 回溯性比较：可以把完整 Companion 包括 bones 一起持久化，但旧物种或稀有度字段会固化且可被配置伪造；实际只存 soul，读取时重算并覆盖 bones。
- 回溯性比较：可以为 Buddy 使用任意文本响应或独立工具调用循环，但解析和副作用更难约束；实际要求 JSON、限制字段长度，并复用无工具单轮 side question。
- 回溯性比较：可以为 /fork 直接实现一套 worker API，但会绕过已有 cache prefix、recursive guard 与权限路径；prompt command 复用隐式 fork，代价是命令本身不直接证明 worker 已启动。

## 安全与协议边界

- observer 输入仅取最新用户文本并截到 4000 字符，模型返回按 JSON 数据解析，name/personality/reaction 均有长度上限；无效响应不会写入部分 soul。
- runSideQuestion 沿用 canUseTool deny 和 maxTurns=1，Buddy 观察不能借 side query 执行工具；ToolUseContext 用于既有上下文而非新增授权。
- Fork 子 agent 继承父模型和工具池，permissionMode=bubble 保留向父终端浮现权限提示；递归 guard 防止 fork child 再 fork，worktree notice 明确父路径不能当作子工作区路径。
- mute 只阻止后续 observer，不删除已存 companion；/fork 把用户 directive 嵌入模型 prompt，自身不执行 shell 或直接修改 worktree。

## 验收标准

- 同一 seed 的 bones/stats 确定且 stats 在 1 至 100；stored soul 不含 bones，读取时 bones 覆盖旧同名字段。
- 首次有效模型响应保存 name/personality/hatchedAt 并发出 reaction；已有 soul 的后续响应只发 reaction，不再次保存。
- 缺 context、inFlight、mute 或已有 soul 且无用户文本时按各自条件不调用模型，非法 JSON 不保存也不回调，finally 恢复单飞状态。
- /buddy 空参数显示组合后的 companion，未孵化有提示，mute/unmute 写 companionMuted，其他参数显示 usage。
- Fork prefix 保留完整 assistant tool_use，所有 placeholder 相同且 parent UUID 不变；child tag 可被递归 guard 检测，worktree notice 包含新根路径。
- /fork 空参数给 usage，非空 prompt 同时包含完整 directive、后台 Agent 和省略 subagent_type 的指令。
- 外部构建与 fixture 开启两个 flag，特性档断言 buddy/fork 命令存在；STATUS/RELEASE 不再把 Buddy/Fork 列为 disabled。
- 离线测试和 at-commit 命令记录不被解释为真实模型或真实 worker 在线验证。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | observer 实现单飞/静音门控、4000 字符用户文本、受限 JSON、首次 soul 保存和后续 reaction；REPL 传入 ToolUseContext。 | `src/buddy/companionObserver.ts`，符号 `export async function fireCompanionObserver`，revision `commit` |
| diff-observed | /buddy status 通过 getCompanion 组合即时 bones 与存下的 soul，mute/unmute 只写 companionMuted。 | `src/commands/buddy/index.ts`，符号 `companionMuted: action === 'mute'`，revision `commit` |
| test-added | 新 buddyFork 测试覆盖确定性 roll、JSON 拒绝/解析、注入 run 的 soul 保存与两次 reaction、第二次不保存，以及 Fork guard、相同 placeholders、parent UUID 不变、worktree notice 和 /fork prompt。 | `tests/buddyFork.test.ts`，符号 `describe('Buddy companion'`，revision `commit` |
| test-added | 外部特性档新增 hasBuddyCommand/hasForkCommand 断言，fixture 同时开启 BUDDY 和 FORK_SUBAGENT。 | `tests/enabledFeatures.test.ts`，符号 `expect(profile.hasBuddyCommand).toBe(true)`，revision `commit` |
| recorded-command-pass | at-commit STATUS 记录 bun test 118 tests、516 assertions 通过；这是提交内历史执行记录，不是本次文档编写重新运行。 | `docs/STATUS.md`，符号 `\| `bun test` \| 118 tests, 516 assertions passed \|`，revision `commit` |
| recorded-command-pass | at-commit STATUS/RELEASE 记录 typecheck 零错误、CLI/SDK/声明构建和 36-tool 编译特性档通过。 | `docs/RELEASE.md`，符号 `## Buddy and Fork Subagent`，revision `commit` |
| not-recorded | 没有真实模型孵化/reaction、真实配置跨进程持久化或实际后台 fork worker 的端到端记录；新增 Buddy 测试注入 run，/fork 测试只检查生成的 prompt。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**implemented**
- 真实模型是否遵循 bones 不变、返回可解析 soul/reaction，以及 side-query 的实际缓存效果，仍需授权模型环境验证。
- 测试中的 saveGlobalConfig 是内存替身，真实配置写入和跨进程读取未由该用例证明；observer inFlight 也只是进程级单飞。
- /fork prompt 与核心 helper 已有离线覆盖，但命令经主模型调用 Agent、后台 worker 执行和 worktree 实际修改没有端到端证据。
