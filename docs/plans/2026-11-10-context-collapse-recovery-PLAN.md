---
commit: 31697a0f6d4c66dae4c792583e94410b07aa1bff
title: "Implement context collapse and recovery"
date: 2026-11-10T20:47:04+08:00
status: partial
kind: component
---

# 实施计划：Implement context collapse and recovery

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要把接近上下文窗口的历史段转换为可重复投影的摘要，在 90% 时后台生成、95% 时等待结果，并保持 UUID 边界、工具调用与结果配对、恢复后的提交顺序和健康状态可观察。实际实现已经覆盖提交摘要、阈值调度、UUID 投影、日志恢复和 CtxInspect 构建注册，但正常 startSpawn 路径把新摘要直接交给 commitStaged，并未先写入 collapseStore.staged；staged 队列只能由恢复快照填入。因此不能把“恢复快照中的 staged 可排空”扩大成“所有新摘要都会先暂存并可供 413 恢复”，本记录据此标为部分实现。

- 确认父提交的 index/operations/persist 都是禁用、直通或空恢复实现，且没有 store.ts。
- 确认 query、sessionRestore、ResumeConversation 和 autoCompact 已有 CONTEXT_COLLAPSE 门后的调用点，本提交不重写这些控制流。
- 确认 logs.ts/sessionStorage.ts 已定义 commit 与 snapshot entry，CtxInspect 已读取 getStats，构建只需打开同一特性。
- 确认测试可通过 initContextCollapse 注入 token、窗口、摘要和持久化依赖，历史结果与 fake/live 范围必须分别记录。

## 复用与兼容处理

### 复用现有实现

- 复用 runForkedAgent、cache-safe 参数、系统/用户上下文和 extractTextContent 生成单轮文本摘要。
- 复用 tokenCountWithEstimation 与 getEffectiveContextWindowSize，不另建 token 或模型窗口表。
- 复用 createUserMessage 构造带固定 UUID 的 isMeta 摘要，不新增 Message 类型。
- 复用 sessionStorage 的 commit/snapshot writer、日志类型及既有 resume 恢复调用点。
- 复用 query 的 withheld413/collapse_drain_retry 状态机、autoCompact 协调和 CtxInspect 报告格式。
- 复用 bun:bundle feature 门、独立特性构建夹具和组合工具池测试，不添加第二套注册机制。

### 兼容、迁移与生命周期

- 保留 applyCollapsesIfNeeded、recoverFromOverflow、getStats、subscribe 等既有导出签名，原 query/UI 调用点无需迁移。
- 保留 marble-origami commit/snapshot 日志格式、summaryUuid 和首尾 UUID，resume 继续由既有 sessionStorage/sessionRestore 读写。
- 完整 REPL 历史不被物理修改；已投影视图再次进入时通过 summaryUuid 保持稳定，旧 committed 可按顺序重放。
- 服务环境开关未定义时默认启用，未编译 CONTEXT_COLLAPSE 的外部入口仍由 feature 门隔离；autoCompact 的既有协调不变。
- CtxInspect 仍输出同一 ContextData JSON 外形并附 contextCollapse，变化是构建后进入工具池而非新增报告协议。

## 文件级实施步骤

### 1. 建立折叠状态、统计和订阅基座

先新增 store.ts，区分 CommittedCollapse 与 StagedCollapse 的字段，集中 committed、staged、nextId、armed、lastSpawnTokens 和 health。随后实现通知/退订、reset 和统计派生，使后续投影、恢复与 CtxInspect 共享同一状态，不在各入口各存一份计数。

涉及位置：`src/services/contextCollapse/store.ts`

### 2. 实现 UUID 投影与安全归档段选择

在 operations.ts 先以 uuidOf 统一识别消息边界，再实现 projectView 的 summaryUuid 去重、首尾闭区间替换和 archived 刷新，补上 findMessageSpan。最后实现 selectCollapseSpan：至少六条、从 length-5 回退，遇相邻 tool_use/tool_result 继续缩小，end 为零则返回 undefined。

涉及位置：`src/services/contextCollapse/operations.ts`

### 3. 接通摘要依赖、阈值调度和内存提交

在 index.ts 合并生产/测试依赖，实现默认无工具 fork、环境开关、generation/reset 和订阅出口。按投影后 token/window 比率接入 90% 后台、95% 等待及 5000 token 门，再实现空摘要/UUID/异常健康处理。commitStaged 先同步生成 ID、summaryUuid、转义摘要和 committed，再异步持久化；按该 revision 实际代码保留 startSpawn 直接提交、未先入 staged 的事实，并把这一缺口列入未完成项。

涉及位置：`src/services/contextCollapse/index.ts`

### 4. 恢复提交日志和 staged 快照

在 persist.ts 以 reset 开始，按 entries 顺序重建 committed、summaryMessage 和最大 ID 后的 nextId，archived 先置空。随后从 snapshot 恢复 staged 元数据、armed 和 lastSpawnTokens，staged.messages 同样置空并通知监听者，让 operations 的投影在完整历史上延迟补齐归档内容。

涉及位置：`src/services/contextCollapse/persist.ts`

### 5. 完成溢出排空与恢复路径的离线回归

在 contextCollapse.test.ts 用固定 token/window 和 deferred/fake summarizer 分别固定 96% 同步提交、90% 后台投影、幂等、空摘要和 summarizer 来源 withhold 边界。再用 restoreFromEntries 同时预置一个 committed 和一个 staged，验证 recoverFromOverflow 的计数、同步投影及再次投影稳定性；最后覆盖工具配对、通知和 reset，不把该注入路径写成真实 413。

涉及位置：`tests/contextCollapse.test.ts`

### 6. 启用构建特性并核对 CtxInspect 注册

在 scripts/build.ts 与 verify-enabled-features.ts 同时加入 CONTEXT_COLLAPSE，使既有 query/resume 接线和 CtxInspect 条件注册进入外部构建。随后把 enabledFeatures.test.ts 的工具总数从 35 调整为 36，保留 nullCount=0 并增加 CtxInspect 名称断言，以真实编译特性档核对注册结果。

涉及位置：`scripts/build.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`

### 7. 记录历史结果、实际范围与后续验证

在 STATUS.md 更新 107 个测试、459 个断言、36 工具、context-collapse 离线能力矩阵和后续 live 顺序；在 RELEASE.md 新增 Context collapse 段，记录 90/95、UUID、工具边界、空摘要、持久化、恢复和 CtxInspect，并把相关旧段的特性档数量同步为 36。文档明确 fake summarizer/persistence 与 live model/API 413 未验证，本记录另按源码补充正常路径未 staged 的限制。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 正常生成路径不进入 staged，导致快照通常没有新摘要可恢复，且真实 413 drain 对本次运行生成的摘要无效；恢复快照测试不能掩盖这一缺口。
- UUID 边界在输入中缺失或乱序时 projectView 跳过替换，但 committed 与统计仍保留，可能出现计数与有效视图不一致。
- 内存提交先于异步 recordCommit/recordSnapshot，写失败会造成内存与磁盘短暂或持续分歧；health 可观察但不提供事务回滚。
- 后台 Promise、reset 和迟到摘要可能污染新状态；generation 检查覆盖摘要返回和 finally，activeSpawn 清理降低竞态，但持久化 await 后仍缺少会话归属检查，真实并发模型执行也未在线验证。
- 工具边界只检查相邻消息形态而不核对 tool_use_id，属于保守防拆分而非完整协议修复。

## 验收顺序

1. 用固定 96/100 token 比验证达到 95% 后摘要已提交、消息数由六变五、重复投影不再次 summarize，并检查 commit/snapshot fake 调用。
2. 用 deferred summarizer 在 90/100 时先确认六条原消息和一次后台调用，再完成摘要并确认后续投影为五条。
3. 用空字符串摘要确认不提交占位符、totalEmptySpawns 增一且 lastError 可见，用 assistant API error 检查 sdk withhold 与 marble_origami 排除。
4. 先恢复 committed 与 staged entry，再调用 recoverFromOverflow，核对 committed=1、staged 清零、消息从六到四、recordCommit 一次及重复投影稳定。
5. 构造相邻 assistant tool_use/user tool_result，确认选择段回退且二者均不被切分；订阅 reset 并退订，核对统计清零。
6. 运行独立特性构建，核对 CONTEXT_COLLAPSE、36 个非空工具和 CtxInspect；CtxInspect 的 JSON 格式仍由既有 internalTools 测试覆盖。
7. 引用提交内 STATUS/RELEASE 的 bun test 107/459、typecheck 零错误、build CLI/SDK/declarations 和 36 工具结果，不把本记录静态校验写成历史执行。
8. 后续在授权环境分别运行真实模型摘要、真实 transcript resume 和真实 API 413 drain/retry；另补正常 spawn 先 staged 的回归后再宣称完整 staged 生命周期。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- committed/staged 数据结构、健康统计、订阅和 reset 已集中实现。
- 无工具单轮 fork、90% 后台与 95% 等待、5000 token 门，以及摘要返回与 finally 的 generation 检查已经接通；默认 fork 的重复归档输入和持久化期间的隔离缺口仍未消除。
- summaryUuid 幂等投影、UUID 闭区间、archived 延迟填充和工具配对边界已经实现。
- 空摘要拒绝、错误健康记录、同步内存 committed 和异步 commit/snapshot 持久化已经实现。
- commit/snapshot 恢复、nextId 重设和恢复快照 staged 的同步 overflow drain 已有离线回归。
- CONTEXT_COLLAPSE 已进入生产及夹具构建，CtxInspect 已进入 36 工具特性档。
- 提交文档记录了 107/459、类型检查、构建/declarations 和 fake/live 验证边界。

### 未完成或后续工作

- 新摘要正常路径直接 committed，未建立先写 staged、再由 overflow 提交的完整生命周期；因此整体状态不是完整实现。
- 真实模型摘要、真实持久化、真实 API 413 和 collapse_drain_retry 尚未执行验证。
- 持久化失败后的内存/日志一致性补偿，以及缺失 UUID 边界时 committed 计数与投影效果的协调仍无机制。
- 默认摘要 fork 的归档消息经 promptMessages 与 forkContextMessages 重复拼接，需修正生产输入并用非 fake summarizer 的入口回归固定。
- 持久化 pending 与 reset 交错时，旧任务仍可能写 health、通知或继续 snapshot；该竞态需要定向回归及会话归属防护。
