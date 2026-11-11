---
commit: 31697a0f6d4c66dae4c792583e94410b07aa1bff
title: Context collapse 的摘要提交、投影与恢复设计
date: 2026-11-10
retrospective: true
---

# Context collapse 的摘要提交、投影与恢复设计

## 状态与触发

collapseStore 保存 committed、staged、nextId、armed、lastSpawnTokens 和 health。`applyCollapsesIfNeeded()` 先投影历史，再计算 token/window：

- 小于 90% 不触发；
- 距上次 spawn 不足 5000 tokens 不重复触发；
- 已有 spawn 时，95% 以上等待它完成，其余情况先返回投影；
- 新 spawn 在 90% 启动、95% 必须等待。

querySource 为 marble_origami 时完全跳过，防止 summarizer 递归触发自身；compact/session_memory 只读取投影，不创建新摘要。

## Span 与摘要提交

`selectCollapseSpan()` 至少保留最近五条消息，并向前避开 assistant tool_use 与紧随 tool_result 的边界，防止切断工具对。

默认 summarizer 复用 forked agent 和 cache-safe prompt，明确禁止工具，要求保留决策、路径、代码变更、工具结果和未完成工作。空摘要只更新 health，不提交；缺首尾 UUID 抛错。generation 用于忽略 reset 前启动的迟到结果。

`commitStaged()` 同步完成内存提交：生成递增 collapseId 和 summaryUuid，XML escape 摘要，创建 isMeta user message，保存 archived span，然后从 staged 移除。recordCommit/recordSnapshot 的异步持久化失败只记录 health，不回滚内存投影。

## 投影与恢复

`projectView()` 按 committed 顺序重放：若 summaryUuid 已存在则幂等跳过；首尾 UUID 都存在时，用 summaryMessage 替换整个 archived span，并更新 commit.archived 为当前视图中的原消息。再次投影不会重复压缩。

`recoverFromOverflow()` 对全部 staged 调用 commitStaged。内存提交是同步的，因此可以立即返回投影和 committed 数，不必等待持久化。

`restoreFromEntries()` 先 reset，再重建 committed summary messages 和 nextId=max+1；snapshot 恢复 staged/armed/lastSpawnTokens，消息正文留待后续投影通过 UUID 找回。

## 验收标准

1. 90/95% 阈值、5000-token 抑制、activeSpawn 等待和 summarizer 递归 guard 正确。
2. span 保留最近五条且不切断 tool_use/tool_result；空摘要、缺 UUID 和 reset 迟到结果都不能提交。
3. 摘要 XML escape、ID 递增、内存提交与持久化错误隔离正确。
4. projectView 幂等，restore 能重建 ID 和 snapshot，overflow recovery 立即可见 committed 投影。
5. `contextCollapse.test.ts` 覆盖阈值、边界、恢复、空摘要、持久化和 feature-profile 注册。
