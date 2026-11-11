---
commit: 31697a0f6d4c66dae4c792583e94410b07aa1bff
title: Context collapse 的实施顺序
date: 2026-11-10
retrospective: true
---

# Context collapse 的实施顺序

## 1. 建立状态与幂等投影

**文件：** `store.ts`、`operations.ts`。

定义 committed/staged/health 和订阅通知。`projectView()` 按 committed 顺序处理，先检查 summaryUuid，再定位 first/lastArchivedUuid，替换 span 并更新 archived。实现 findMessageSpan 与 selectCollapseSpan：至少六条才可 collapse，保留最后五条，向前跳过 tool pair 边界。

**测试：** `tests/contextCollapse.test.ts` 先覆盖重复投影、缺首尾 UUID、短历史和 tool pair。

## 2. 实现受控摘要与提交

**文件：** `index.ts`。

提供 tokenCount/contextWindow/summarize/recordCommit/recordSnapshot 依赖注入。默认 summarizer 使用 forked agent、cache-safe 参数、deny-all canUseTool、maxTurns 1 和 marble_origami querySource。

startSpawn 先递增 generation 并设置 armed；摘要返回后检查 generation、空文本和首尾 UUID。commitStaged 同步更新 committed/staged，再异步持久化；record 失败只增加 health 错误。resetContextCollapse 增加 generation，使旧 Promise 不再写状态。

**测试：** 空摘要、reset 迟到结果、缺 UUID、XML 特殊字符、recordCommit 抛错和 ID 递增。

## 3. 接入阈值与恢复

`applyCollapsesIfNeeded()` 先 projectView，再按 90%/95% 和 lastSpawnTokens+5000 决策。activeSpawn 时只在 95% 以上 await；新 spawn 同理。compact/session_memory 只读投影，marble_origami 完全跳过。

实现 recoverFromOverflow：复制 staged，逐个同步内存提交，立即返回 projectView 和提交数。isWithheldPromptTooLong 只处理 assistant API prompt-too-long，并遵守功能开关与递归 guard。

## 4. 实现 snapshot 恢复并接入 feature

**文件：** `persist.ts`、`scripts/build.ts`。

restoreFromEntries 先 reset，重建 committed 的 summaryMessage 和最大 ID+1，再恢复 snapshot 的 staged/armed/lastSpawnTokens。构建只添加 `CONTEXT_COLLAPSE`，CtxInspect 等读取入口复用 getStats。

```bash
bun test tests/contextCollapse.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

回滚时先移除 feature 与调用入口，再回滚恢复和 spawn；不得允许 summarizer 使用工具、提交空摘要，或让异步持久化失败阻塞已完成的内存投影。
