---
commit: da942ac7d8b72858fc186837690c9b5b3cdeafe5
title: "Implement reactive compaction recovery"
date: 2026-11-10T20:59:02+08:00
status: implemented
kind: component
---

# Implement reactive compaction recovery

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的 reactiveCompact.ts 虽保留 ReactiveCompactAttempt、ReactiveCompactOutcome 和查询层所需函数外形，但 enabled/withheld/reactive-only 全部固定为 false，tryReactiveCompact 永远返回 null，核心函数直接抛出外部构建不可用错误。query.ts 已有 PTL/media 错误暂扣、单次恢复和失败后重新显露错误的调用链，/compact 也已有 reactive-only 分支；然而 REACTIVE_COMPACT 未进入外部构建，这些入口只能得到 stub。共享 compactConversation 已能生成摘要并执行 PreCompact，stripImagesFromMessages 也能替换媒体，但缺少让外层先运行 PreCompact、合并其结果且不在共享压缩器里重复执行 hook 的协调接口。

需要把既有的查询恢复调用点变成可用实现：识别可恢复的 prompt-too-long 与图片、文档、多图或 PDF 页数超限错误，在不破坏原有消息协议的前提下，以去除媒体的输入调用共享压缩器，再把 CompactionResult 交回 query 重试。方案还要区分消息不足、取消、压缩耗尽、普通失败和无可剥离媒体，保证自动与手动路径的 PreCompact 不重复、用户提示可合并、成功后才清理缓存与警告状态，并通过单次尝试约束避免恢复循环。提交证据只覆盖离线协调逻辑和编译特性档，不能把注入 compactor 的测试解释为真实 API 恢复。

## 目标与非目标

### 目标

- 在外部构建启用 REACTIVE_COMPACT，以环境 kill switch 控制 PTL/media 错误暂扣，并保留独立、默认关闭的 reactive-only GrowthBook 开关。
- 复用现有 API 错误分类器，只对带 API 错误标记的 assistant 消息触发 PTL 或 media-size 恢复。
- 在摘要输入中把用户消息及 tool_result 内的 image/document 替换为文本标记，并让普通参数与 forkContextMessages 使用同一份剥离结果。
- 复用 compactConversation 的摘要、内部 PTL 重试、PostCompact 和结果构造能力，以可选参数跳过已经由外层执行的 PreCompact。
- 提供明确的 ReactiveCompactOutcome，覆盖 too_few_groups、aborted、exhausted、error 和 media_unstrippable，并保持手动调用方能映射到既有错误。
- 在自动入口执行一次 PreCompact、透传 hook 指令、合并显示消息，只在成功后重置 session-memory 标记、执行按 querySource 区分的清理并抑制压缩警告。
- 加入离线回归、真实独立特性构建断言和 at-commit STATUS/RELEASE 证据，同时明确 live API recovery 尚未运行。

### 非目标

- 不重写 query.ts 的流式消息循环、context-collapse drain、buildPostCompactMessages 或重试状态机；本提交实现它们已经调用的 reactive 组件。
- 不实现另一套模型摘要器、API 客户端或压缩结果格式，也不改变自动压缩、传统 /compact 与 session-memory 的既有优先级。
- 不通过缩放、转码或重新上传修复原始媒体；媒体替换仅服务于压缩摘要输入，不是对会话原始内容的媒体编辑功能。
- 不提供无限外层恢复循环或保证保留尾部中的超限媒体一定可恢复；已有 hasAttemptedReactiveCompact 会阻止连续 reactive 重试。
- 不默认开启 reactive-only 手动压缩模式，也不把 CLAUDE_REACTIVE_COMPACT 描述为关闭所有传统或手动压缩路径的总开关。
- 不宣称真实模型摘要、真实 PreCompact 子进程、在线 413/media 响应或压缩后的 API 重试已经由新增 mock 测试验证。

## 方案架构与数据流

启用与检测层保留原有函数签名。isReactiveCompactEnabled 以 isEnvDefinedFalsy 读取 CLAUDE_REACTIVE_COMPACT，未设置时启用，0/false/no/off 时关闭；isReactiveOnlyMode 独立读取 tengu_cobalt_raccoon，默认 false。两个 isWithheld 函数先检查运行时开关和 assistant 类型，再委托既有分类器：PTL 要求 isApiErrorMessage 且文本块以 Prompt is too long 开头，media-size 要求 API 错误标记及 errorDetails 匹配图片尺寸、多图或 PDF 页数模式。因此普通 assistant 文本不会被误认为可恢复错误，query.ts 也无需改变暂扣协议。

自动协调入口 tryReactiveCompact 在任何 hook 之前拒绝已尝试、已中止以及 querySource 为 compact 或 session_memory 的调用，避免递归压缩和重复恢复。通过门禁后，它用 auto、customInstructions=null 和原 AbortSignal 执行 PreCompact，把 newCustomInstructions 交给核心函数；核心失败时返回 null，成功时才调用 onSuccess。最终显示文本按 PreCompact 消息、压缩结果消息的顺序过滤空值并以换行连接，没有内容则恢复 undefined。

核心 reactiveCompactOnPromptTooLong 按确定顺序做前置判断：AbortSignal 已取消先返回 aborted；groupMessagesByApiRound 少于两组返回 too_few_groups；仅当最后一条消息是 media-size assistant 错误且整段输入没有可剥离媒体时返回 media_unstrippable。可剥离性检查与共享 strip 函数覆盖相同位置，即 user content 中的直接 image/document 以及 tool_result 数组内的嵌套媒体，而不是只按错误字符串猜测是否存在修复材料。

媒体适配直接复用 stripImagesFromMessages。该工具为受影响消息生成替换副本，把图片和文档分别写为 [image] 与 [document]，包括 tool_result 内的块，同时保留其他消息与块。核心随后以 stripped 同时作为 compactConversation 的第一个参数和 cacheSafeParams.forkContextMessages，防止普通摘要路径与 forked-agent 路径读取不同上下文；suppressFollowUpQuestions=true，customInstructions 和 auto/manual 由调用方传入，recompactionInfo 为 undefined，skipPreCompactHooks=true。

共享压缩器新增末尾可选参数 skipPreCompactHooks=false。默认分支仍按 isAutoCompact 选择 auto/manual 并执行 executePreCompactHooks，再与原 customInstructions 合并；reactive 分支使用空 hookResult，因为外层已经取得指令和显示消息。其余 compactConversation 流程不变，继续负责摘要请求、其内部 PTL 截断重试、PostCompact 和 CompactionResult，从而避免复制模型调用及消息边界逻辑。手动 reactive-only 调用方同样在外层执行 PreCompact，先 mergeHookInstructions，再以 trigger=manual 进入这个核心。

结果映射把控制语义从异常文本中显式化。共享压缩器成功则包装为 {ok:true,result}；APIUserAbortError 或调用后 AbortSignal 已取消统一映射 aborted。其他异常先写 debug，Error.message 包含精确大小写的 Prompt is too long 时映射 exhausted，其余映射 error。自动 tryReactiveCompact 把所有 !ok 折叠为 null，使 query 重新显露被暂扣的原错误；未改动的 /compact 分支则把 too_few_groups、aborted 和其余失败分别翻译成既有 NOT_ENOUGH、USER_ABORT、INCOMPLETE_RESPONSE 错误。结构化 catch 只包围 compactor 调用，外层 PreCompact 自身的拒绝不被伪装成这些 compactor outcome。

成功清理由 defaultDependencies.onSuccess 集中执行：setLastSummarizedMessageId(undefined) 去除已失效锚点，runPostCompactCleanup(querySource) 复用统一缓存与跟踪状态清理，suppressCompactWarning() 避免在尚无新 token 统计时继续显示旧警告。querySource 会继续传入清理器，使主线程与 agent:* 子代理保持既有模块级状态隔离；失败路径不执行这些成功动作。initReactiveCompact 只替换显式给出的 compact、preCompact 或 onSuccess 依赖，并在无参数时恢复生产默认值，为离线测试提供窄接口而不改变生产调用协议。

构建与既有入口共同完成交付：scripts/build.ts 和独立特性夹具加入 REACTIVE_COMPACT，feature-check 导出真实 isReactiveCompactEnabled，组合测试要求编译后的默认值为 true，同时维持 36 个非空工具断言。query.ts 在恢复成功后仍通过 buildPostCompactMessages 输出并进入 reactive_compact_retry，失败则输出原错误并运行 StopFailure；/compact 仅在 reactive-only 标志开启时走新实现。新增测试以受控 compactor/hook/cleanup 检查协调契约，STATUS 与 RELEASE 将能力标为 offline compactor/hooks 已验证，并单独保留 live API recovery 未验证边界。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `src/services/compact/reactiveCompact.ts`，符号 `tryReactiveCompact` | 实现开关、错误检测、媒体预检、共享压缩调用、结构化 outcome、PreCompact 协调和成功清理。 |
| 变更 | `src/services/compact/compact.ts`，符号 `skipPreCompactHooks = false` | 为共享压缩器增加默认关闭的 PreCompact 跳过参数；既有 stripImagesFromMessages 被 reactive 路径复用。 |
| 变更 | `scripts/build.ts`，符号 `'REACTIVE_COMPACT'` | 把 reactive compaction 实现加入 CLI 与 SDK 外部 Bun 构建特性列表。 |
| 变更 | `tests/reactiveCompact.test.ts`，符号 `describe('reactive error detection'` | 新增五项受控离线测试，并逐例恢复依赖注入和环境变量，验证协调参数与结果而非在线 API。 |
| 变更 | `tests/fixtures/feature-check.ts`，符号 `isReactiveCompactEnabled` | 从真实 reactiveCompact 模块导出开关，供独立编译产物读取。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `reactiveCompactEnabled: isReactiveCompactEnabled()` | 在独立 Bun 构建中启用 REACTIVE_COMPACT，导入编译结果并把开关状态写入 FEATURE_PROFILE。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `profile.reactiveCompactEnabled` | 对独立特性构建的 reactive 默认值增加断言，维持原有工具数量和注册检查。 |
| 变更 | `docs/STATUS.md`，符号 `\| Reactive compaction \|` | 把全量记录更新为 112/479，并将能力范围限定为离线 compactor/hooks 已验证、live API 未运行。 |
| 变更 | `docs/RELEASE.md`，符号 `## Reactive compaction` | 记录检测、媒体剥离、PreCompact、结果映射和成功清理，以及测试、构建、36 工具特性档和在线边界。 |
| 复用 | `src/query.ts`，符号 `tryReactiveCompact` | 复用既有错误暂扣、context-collapse 优先 drain、单次 reactive 恢复、结果重建和失败显露控制流。 |
| 复用 | `src/commands/compact/compact.ts`，符号 `compactViaReactive` | 复用手动 reactive-only 的 PreCompact/指令合并、outcome 错误翻译、显示消息和成功清理路径。 |
| 复用 | `src/services/api/errors.ts`，符号 `isMediaSizeErrorMessage` | 复用 PTL 与 media-size 的 API 错误谓词及 errorDetails 模式，不新增平行分类规则。 |
| 复用 | `src/utils/hooks.ts`，符号 `executePreCompactHooks` | 复用现有 hook 输入、auto/manual 匹配、AbortSignal、指令提取和显示消息协议。 |
| 复用 | `src/services/compact/grouping.ts`，符号 `groupMessagesByApiRound` | 以既有 assistant response ID 边界计算 API round，提供最少两组的可压缩性门禁。 |
| 复用 | `src/services/compact/postCompactCleanup.ts`，符号 `runPostCompactCleanup` | 复用统一缓存和跟踪状态清理，并保留 querySource 对主线程和子代理的区分。 |
| 复用 | `src/services/compact/compactWarningState.ts`，符号 `suppressCompactWarning` | 成功后复用既有警告抑制状态，不另建 reactive 警告存储。 |
| 复用 | `src/services/SessionMemory/sessionMemoryUtils.ts`，符号 `setLastSummarizedMessageId` | 复用 session-memory 摘要锚点重置接口，避免压缩后保留失效消息 ID。 |
| 复用 | `src/utils/envUtils.ts`，符号 `isEnvDefinedFalsy` | 复用统一环境假值解释，保持未设置默认启用和 0/false/no/off 关闭语义。 |

## 关键决策与工程取舍

- 选择在现有 reactiveCompact.ts stub 内实现并启用编译标志，而不修改 query 和 /compact 的调用协议；这样恢复顺序、错误显露和结果重建仍只有一份，变更集中在被调组件及其共享 hook 接口。
- 选择让自动和手动 reactive 调用方在外层运行 PreCompact，再给共享压缩器传入 skipPreCompactHooks=true；默认 false 保持其他调用方行为，外层则能把 hook 指令和 userDisplayMessage 与压缩结果准确合并。
- 选择复用 stripImagesFromMessages，而非为 media-size 错误另写删除逻辑；检测可剥离媒体时使用同样的直接块和 tool_result 范围，避免预检认定可修复而实际 strip 不处理。
- 选择同步覆盖 messages 参数与 forkContextMessages，而不是只替换其中一个；这是共享压缩器可能走 forked-agent 路径时保持摘要输入一致的必要适配。
- 选择结构化 outcome 作为内部边界、自动入口 null 作为恢复失败信号；query 无需了解失败分类，手动命令仍能保留原有用户错误分类，debug 日志只用于非中止异常。
- 选择仅成功后清理，并复用 runPostCompactCleanup 的 querySource 语义；失败不会重置 session-memory 锚点或抑制警告，子代理压缩也不会借此清空主线程专属缓存。
- 选择注入三个协调依赖而非 mock 整个模块；测试可观察真实检测、媒体 strip、参数和结果映射，但这种证据只覆盖协调层，不能替代真实 compactor、hook 进程或 API。

### 备选方案与回溯分析

- 回溯性比较：可以在 reactiveCompact 中另写摘要请求和 PostCompact 流程，但会形成第二套压缩协议；实际复用 compactConversation，只增加末尾可选 hook 开关，承接共享实现及其内部 PTL 重试，也保留对 CacheSafeParams 的耦合。
- 回溯性比较：可以让 compactConversation 内部独自执行 PreCompact 并返回所有消息，省去外层协调；实际外层先执行 hook 才能满足手动指令合并和自动显示消息拼接，再以 skip 参数避免同一恢复执行两次 hook。
- 回溯性比较：可以对所有失败直接抛出异常或无限重试；实际以五种 reason 区分可预期结果，自动路径失败回到原错误，且 query 的 hasAttemptedReactiveCompact 只允许一次成功后的 reactive 重试，牺牲自动重试次数来限制循环与持续副作用。
- 回溯性比较：可以只在 media-size 错误时剥离媒体，PTL 保留完整摘要输入；实际所有 reactive 核心调用都复用媒体替换副本，既减少摘要请求体积也保留 [image]/[document] 线索，但摘要无法利用被替换媒体的原始内容。

## 安全与协议边界

- PTL 检测要求 isApiErrorMessage 和指定文本前缀，media 检测还要求 errorDetails 的受限模式，避免把模型普通输出或任意 system/stream 消息当成恢复触发器。
- PreCompact 继续通过既有 executePreCompactHooks 执行并接收原 AbortSignal；本提交没有新增 hook 配置来源、命令执行通道或权限绕过。
- 媒体替换发生在送往压缩器的消息副本中，[image]/[document] 仅保留类型线索；它不表示原始会话或磁盘媒体被删除，也不新增媒体上传能力。
- 运行中止优先映射为 aborted，成功清理不会在压缩失败后运行；querySource 被传入统一清理器，保留子代理与主线程共享模块状态的既有隔离约束。
- CLAUDE_REACTIVE_COMPACT 可关闭错误暂扣入口，避免恢复不可用时吞掉原 API 错误；非中止失败仅写既有 debug 日志，本记录不推断日志内容经过额外脱敏。

## 验收标准

- 外部特性构建包含 REACTIVE_COMPACT，默认环境下编译后的 isReactiveCompactEnabled 为 true，显式 falsy 环境值使 PTL/media withheld 判断均为 false。
- 只有符合既有分类器的 assistant API 错误进入恢复；reactive-only 仍由独立 GrowthBook 值控制且默认关闭。
- 已尝试、已取消及 compact/session_memory 来源不会再次进入自动恢复，其他来源的自动 PreCompact 只由外层执行，其指令被传给共享压缩器。
- 少于两个 API round、无可剥离媒体的最终 media-size 错误及调用前取消分别得到 too_few_groups、media_unstrippable、aborted，不发起 compactor 调用。
- 直接及 tool_result 嵌套的 image/document 在摘要输入中变为对应文本标记，messages 与 forkContextMessages 一致，auto/manual、customInstructions 和 skipPreCompactHooks 参数正确。
- compactor 成功返回原 CompactionResult 内容；取消、再次 PTL 和其他异常映射为 aborted、exhausted、error，自动失败不清理且由 query 显露原错误。
- 自动成功后只执行一次成功清理，合并 PreCompact/PostCompact 用户消息；手动 reactive-only 保持既有指令合并、错误翻译和清理协议。
- 新增回归和编译特性档覆盖离线契约；任何在线 PTL/media 恢复、真实模型摘要与真实 hook 子进程结论都必须另有执行证据。

## 实现状态与剩余范围

- 状态：**implemented**
- 真实 PTL、图片/文档/PDF 超限响应及压缩后的 API 重试仍需授权环境验证；STATUS 的 Verified 限定为 offline compactor/hooks，不是在线恢复保证。
- 新增套件注入 compactor、PreCompact 和 onSuccess，未在这条测试中贯通生产 compactConversation、PostCompact hook、模型摘要及真实清理副作用；编译特性档只检查启用状态。
- 普通 error、压缩过程中抛出的 APIUserAbortError、compact/session_memory 来源排除等分支虽已实现，但新增五项测试没有逐一作直接断言，不能从全量数字推定每项都有专门覆盖。
- 新增测试未直接断言 cacheSafeParams.forkContextMessages 与 messages 使用同一 stripped 数组，也未覆盖 tool_result 嵌套媒体替换；这些行为目前只有实现证据。
- 既有 query 注释指出，若超限媒体进入压缩后保留尾部，下一次请求仍可能失败；hasAttemptedReactiveCompact 会阻止再次 reactive 恢复并让错误显露，本提交未消除这一限制。
