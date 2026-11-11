---
commit: da942ac7d8b72858fc186837690c9b5b3cdeafe5
title: "Implement reactive compaction recovery"
date: 2026-11-10T20:59:02+08:00
status: implemented
kind: component
---

# 实施计划：Implement reactive compaction recovery

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要把既有的查询恢复调用点变成可用实现：识别可恢复的 prompt-too-long 与图片、文档、多图或 PDF 页数超限错误，在不破坏原有消息协议的前提下，以去除媒体的输入调用共享压缩器，再把 CompactionResult 交回 query 重试。方案还要区分消息不足、取消、压缩耗尽、普通失败和无可剥离媒体，保证自动与手动路径的 PreCompact 不重复、用户提示可合并、成功后才清理缓存与警告状态，并通过单次尝试约束避免恢复循环。提交证据只覆盖离线协调逻辑和编译特性档，不能把注入 compactor 的测试解释为真实 API 恢复。

- 确认父提交 reactiveCompact.ts 是禁用 stub，而 query.ts 与 /compact 已经按现有函数签名调用，实施应保持这些签名和调用顺序。
- 确认 compactConversation 已具备摘要、内部 PTL 重试、PostCompact 与 CompactionResult 逻辑，stripImagesFromMessages 已覆盖直接和 tool_result 嵌套媒体。
- 确认 executePreCompactHooks 同时产生 newCustomInstructions 与 userDisplayMessage，手动路径已经需要先合并用户指令，因此 hook 去重接口必须兼容旧调用方。
- 确认 runPostCompactCleanup 接受 querySource，query 已维护 hasAttemptedReactiveCompact；在线 API 验证应与 mock 协调测试、编译特性档分别记录。

## 复用与兼容处理

### 复用现有实现

- 复用 query.ts 的 withheld、collapse drain、buildPostCompactMessages、reactive_compact_retry 和原错误显露机制，不新增查询状态机。
- 复用 /compact 的 reactive-only 分支、mergeHookInstructions、既有错误常量、显示文本与 finally 进度清理。
- 复用 isPromptTooLongMessage、isMediaSizeErrorMessage、groupMessagesByApiRound 和 stripImagesFromMessages 作为检测与输入变换基础。
- 复用 compactConversation 的模型摘要、内部重试、PostCompact 和结果结构，仅增加可选 skipPreCompactHooks 参数。
- 复用 executePreCompactHooks 及原 AbortSignal，保持 hook 配置、触发器和取消协议。
- 复用 setLastSummarizedMessageId、runPostCompactCleanup(querySource) 和 suppressCompactWarning 组成成功后的既有清理链。
- 复用 Bun features、独立 feature-check 构建夹具、FEATURE_PROFILE 和 STATUS/RELEASE 证据格式，不添加另一套发布或测试框架。

### 兼容、迁移与生命周期

- ReactiveCompactAttempt、ReactiveCompactOutcome 和各导出函数签名保持父提交外形，query.ts 与 /compact 的已有调用无需迁移。
- compactConversation 新参数位于末尾且默认 false，原有手动、自动与 in-process runner 调用继续执行 PreCompact。
- CLAUDE_REACTIVE_COMPACT 未设置时启用，显式 falsy 仅关闭 reactive 错误暂扣；reactive-only GrowthBook 独立且默认 false，传统 /compact 仍保留。
- 自动恢复失败仍返回 null，由 query 输出原 withheld 错误并走 StopFailure；成功结果仍由 buildPostCompactMessages 排列，不改变消息边界协议。
- 成功清理复用 querySource 语义和现有警告/session-memory 状态，手动命令继续执行自己的错误翻译和进度 finally。

## 文件级实施步骤

### 1. 扩展共享压缩器的 PreCompact 协调接口

先在 compact.ts 的 compactConversation 末尾增加 skipPreCompactHooks=false，保留原 executePreCompactHooks、trigger 和 mergeHookInstructions 分支；参数为 true 时改用无指令、无显示消息的 hookResult。让后续 reactive 调用能够在外层合并 PreCompact 结果而不重复执行，同时保持传统手动、自动和 swarm 调用无需修改。

涉及位置：`src/services/compact/compact.ts`

### 2. 实现编译后开关与可恢复错误检测

在 reactiveCompact.ts 接入环境假值、GrowthBook 和既有 API 错误分类器，实现 enabled、reactive-only、PTL withheld 与 media withheld。保持原函数签名，并让检测只在开关启用且消息为 assistant 时触发，为 query.ts 已存在的暂扣逻辑提供真实判断。

涉及位置：`src/services/compact/reactiveCompact.ts`

### 3. 建立媒体预处理与结构化恢复核心

随后在同一模块实现 containsStrippableMedia 和 reactiveCompactOnPromptTooLong，依次处理 abort、API round 不足及最终媒体错误无可剥离内容。调用既有 stripImagesFromMessages 后，把 stripped 同时写入 messages 与 forkContextMessages，透传指令和 trigger，显式跳过内部 PreCompact；最后将成功、取消、再次 PTL 和普通异常映射为既定 ReactiveCompactOutcome。

涉及位置：`src/services/compact/reactiveCompact.ts`

### 4. 接通自动 hook、依赖注入与成功清理

在 reactiveCompact.ts 增加 compact/preCompact/onSuccess 默认依赖及 initReactiveCompact 重置接口。实现 tryReactiveCompact 的 hasAttempted、aborted、compact/session_memory 门禁和外层 auto PreCompact，失败返回 null；成功后重置 session-memory 锚点、按 querySource 清理并抑制警告，再合并 PreCompact 与 compactor 的显示消息。该顺序保证清理只对应成功结果。

涉及位置：`src/services/compact/reactiveCompact.ts`

### 5. 启用外部构建并补齐特性档观测

在 scripts/build.ts 与 verify-enabled-features.ts 的 features 中加入 REACTIVE_COMPACT，在 feature-check.ts 导出 isReactiveCompactEnabled，并由独立构建脚本把 reactiveCompactEnabled 写入 JSON。最后在 enabledFeatures.test.ts 断言编译结果默认为 true，沿用干净 Bun 子进程和 36 个非空工具检查，验证实际打包而非仅导入源 stub。

涉及位置：`scripts/build.ts`、`tests/fixtures/feature-check.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`

### 6. 加入离线回归并记录真实证据边界

在 reactiveCompact.test.ts 以真实消息构造器和注入依赖覆盖检测/kill switch、直接 image 替换、customInstructions/isAutoCompact/skipPreCompactHooks 实参、失败 reason、hook 指令与显示消息、成功清理和重复尝试门禁，并在 afterEach 恢复依赖及环境。forkContextMessages=stripped 可由源码确认，但新增测试没有读取第三个 compactor 实参作直接断言，应将其列为后续回归缺口。随后将 STATUS 的全量结果更新为实际记录的 112/479，能力标为 offline compactor/hooks；RELEASE 记录同一范围、typecheck/build/declarations 和 36 工具特性档，明确 live API recovery 未运行。

涉及位置：`tests/reactiveCompact.test.ts`、`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 外层与共享压缩器若都执行 PreCompact 会重复 hook 副作用；通过外层取得结果、reactive 第八实参为 true、共享默认 false 和参数断言降低重复风险。
- 只替换 messages 而不更新 forkContextMessages 会让 forked-agent 摘要仍读取媒体；实现显式让两个输入指向同一 stripped 数组。
- 过早清理会在失败时丢失锚点或掩盖警告；实现仅在 outcome.ok 后执行 onSuccess，自动失败仍显露原错误。
- 媒体仍在保留尾部或摘要再次 PTL 时可能恢复失败；结构化 exhausted/error、单次 hasAttempted 和手动错误翻译限制重试，但不承诺所有输入都能恢复。
- 注入 mock 无法发现生产 compactor、真实 hook 或 API 的集成问题；因此文档只声明离线协调和编译特性档，保留 live recovery 验证项。

## 验收顺序

1. 运行 reactiveCompact.test.ts，构造带 isApiErrorMessage 的 PTL/media assistant 消息，检查默认检测及 CLAUDE_REACTIVE_COMPACT=0 后均不再 withheld。
2. 现有媒体用例读取注入 compactor 实参，直接断言 [image]、customInstructions、isAutoCompact 和 skipPreCompactHooks=true；另补读取第三个实参的回归，检查 cacheSafeParams.forkContextMessages 与 messages 使用同一 stripped 数组，不能把后者写成该提交已有断言。
3. 分别构造单组、预取消、最终 media-size 但纯文本以及 compactor 再抛 Prompt is too long，核对 too_few_groups、aborted、media_unstrippable、exhausted。
4. 注入 PreCompact 和 onSuccess，检查 hook 指令进入 compactor、pre/post 显示消息合并、querySource 传给清理，以及 hasAttempted 后不再调用 compactor。
5. 在干净 Bun 子进程构建 feature-check.ts，解析 FEATURE_PROFILE，核对 reactiveCompactEnabled=true、toolCount=36、nullCount=0；该步骤只验证编译启用。
6. 依据 at-commit STATUS/RELEASE 引用 bun test 的 112 tests/479 assertions、typecheck 零错误、build/declarations 和 36-tool profile 记录，不把本次记录校验写成历史命令执行。
7. 在授权环境另行制造真实 PTL 和 media-size 响应，观察 PreCompact/PostCompact、摘要、清理及 reactive_compact_retry；该提交没有这项 live 结果，不能预先标记通过。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 外部构建 stub 已替换为真实 reactive 检测、恢复协调和结果映射实现。
- PTL/media 错误分类、环境 kill switch 与独立 reactive-only 开关已经接入。
- 直接及嵌套媒体剥离、双 CacheSafeParams 输入同步和共享 compactConversation 调用已经实现。
- PreCompact 外层执行与共享压缩器可选跳过已经接通，自动/手动指令和显示消息协议得以保留。
- 取消、消息不足、耗尽、普通错误及无可剥离媒体已有明确 outcome，成功清理与单次入口门禁已经实现。
- REACTIVE_COMPACT 已进入生产及独立测试构建，编译特性档新增启用断言。
- 五项离线 reactive 回归已加入，at-commit 文档记录 112/479、类型检查、构建和 36 工具特性档结果及在线限制。

### 未完成或后续工作

- 真实 API 的 PTL/media-size 恢复、生产模型摘要及压缩后重试未在该提交验证。
- 新增协调测试没有执行真实 PreCompact 子进程或生产 compactor/PostCompact 全链，若需端到端保证仍须补充有来源的运行证据。
- 双上下文一致性和 tool_result 嵌套媒体替换缺少新增测试的直接断言，应补 compactor 第三实参与嵌套块回归。
- 保留尾部媒体仍可能触发后续错误；现有一次尝试限制只会让错误显露，并不保证修复该场景。
