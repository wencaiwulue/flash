---
commit: da942ac7d8b72858fc186837690c9b5b3cdeafe5
title: Reactive compaction 的错误恢复与 hook 去重设计
date: 2026-11-10
retrospective: true
---

# Reactive compaction 的错误恢复与 hook 去重设计

## 错误识别与入口

`isWithheldPromptTooLong()` 和 `isWithheldMediaSizeError()` 只在 reactive 功能开启且消息为 assistant API 错误时生效。`tryReactiveCompact()` 还要求未尝试、未 abort，且 querySource 不是 compact/session_memory，避免重复压缩。

进入恢复前，先执行一次 PreCompact hook，把 newCustomInstructions 传给 reactive compaction；成功后清理 lastSummarizedMessageId、执行 post-compact cleanup 并 suppress warning，最后拼接 hook 与 compaction 的 userDisplayMessage。

## 核心恢复流程

`reactiveCompactOnPromptTooLong()` 按固定顺序处理：

1. 已取消 → `aborted`。
2. API round 少于两组 → `too_few_groups`。
3. 最后一条是 media-size error，但消息中没有可剥离 image/document（包括 tool_result 内嵌媒体）→ `media_unstrippable`。
4. 调用 `stripImagesFromMessages()`，将 stripped 同时作为 compact 输入和 forkContextMessages。
5. compact 返回 `{ok:true,result}`；APIUserAbortError 或 signal aborted 返回 `aborted`；Prompt is too long 返回 `exhausted`；其他异常返回 `error`。

`compactConversation()` 新增 `skipPreCompactHooks` 参数。reactive 路径已经在入口执行 hook，因此传 true，避免 PreCompact 重复执行；普通 manual/auto compact 仍走原有 hook 流程。

## 验收标准

1. hasAttempted、aborted、特殊 querySource 和功能 kill switch 均阻止重复恢复。
2. PreCompact 只执行一次，instructions 与 display message 合并正确，成功后清理只执行一次。
3. 媒体识别覆盖直接 image/document 与 tool_result 内嵌媒体；不可剥离和可剥离路径分别处理。
4. stripped 同时进入 compact 与 fork context，skipPreCompactHooks=true；五类失败 reason 精确映射。
5. `reactiveCompact.test.ts` 覆盖入口门禁、媒体、hook、fork 参数、失败分类和清理；feature-profile 覆盖 REACTIVE_COMPACT。
