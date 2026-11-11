---
commit: 2bf435a5d3aca3c375da1387f1e33d3ce13db683
title: 历史 snip 的实施顺序
date: 2026-11-10
retrospective: true
---

# 历史 snip 的实施顺序

## 1. 建立 marker、boundary 与投影

**文件：** `src/types/message.ts`、`src/services/compact/snipProjection.ts`。

定义 snip_marker 和 snip_boundary system message。marker 保存 messageIds；`projectSnippedView()` 从最后一个 boundary 开始，并过滤全部 snip_marker，保证内部控制消息不进入模型视图。

## 2. 实现目标解析与双向工具对扩展

**文件：** `src/services/compact/snipCompact.ts`。

先建立最后四条 protected UUID。短 ID 只匹配非保护的 user/assistant，重复请求去重，未命中进入 invalidIds。

实现 expandToolPairs 的循环扩展，同时处理 API message.id sibling 和 sourceToolAssistantUUID。扩展后若命中保护集合，再从保护集合向外扩展并删除这些 targets。自动目标与手动目标共用该逻辑。

**测试：** `tests/snip.test.ts` 分别构造旧 tool_use 配新 tool_result、旧 tool_result 配新 assistant、sibling、重复 ID 和受保护 ID。

## 3. 实现 marker 驱动的压缩

`snipCompactIfNeeded()` 按顺序处理：runtime kill switch → 非 force 必须有 marker → 解析手动或自动 targets → 没有 targets 则不执行。

removed 包含 targets 和 marker；tokensFreed 使用粗略估算。boundary 插入首个 removed 的位置，保留其余消息相对顺序，并在 content 中记录数量、tokens 和 invalidIds。

实现 shouldNudgeForSnips，只统计最近 snip/compact/marker/context_efficiency 之后的内容，阈值为 10,000。

## 4. 接入 SnipTool 与 force-snip

SnipTool 接受 1–50 个 message_ids，validateInput 在 targets 为空或 invalidIds 非空时拒绝；call 只返回 queued 文本并追加 marker，不直接改历史。

`/force-snip` 使用 `force:true`，未执行时提示没有可 snip 内容，成功时 setMessages 并显示 boundary 内容。构建只添加 `HISTORY_SNIP`。

```bash
bun test tests/snip.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

回滚时先移除命令和工具，再回滚压缩与投影；不得直接删除磁盘 JSONL、切断保留区工具对，或把内部 marker 暴露给模型。
