---
commit: da942ac7d8b72858fc186837690c9b5b3cdeafe5
title: Reactive compaction 的实施顺序
date: 2026-11-10
retrospective: true
---

# Reactive compaction 的实施顺序

## 1. 先给共享 compact 增加 hook 跳过参数

**文件：** `src/services/compact/compact.ts`。

在 `compactConversation()` 末尾增加 `skipPreCompactHooks=false`。为 true 时使用空 hookResult，不执行 executePreCompactHooks；false 保持原 manual/auto 行为。mergeHookInstructions 继续复用，不能在 reactive 路径完全绕过指令合并。

## 2. 实现媒体判断与核心恢复

**文件：** `src/services/compact/reactiveCompact.ts`。

先实现 containsStrippableMedia，覆盖 user 内容块和 tool_result 内嵌 image/document。核心函数依次检查：

```text
aborted → too_few_groups → media_unstrippable → strip → compact
```

compact 调用必须传 stripped、更新后的 forkContextMessages、auto/manual 布尔值和最后一个 `skipPreCompactHooks=true`。catch 按 APIUserAbortError/signal、Prompt is too long、其他异常映射为 aborted/exhausted/error。

## 3. 实现一次性入口与清理

`tryReactiveCompact()` 先检查 hasAttempted、aborted、querySource，再调用一次 preCompact。只有 reactive 返回 ok 才执行 onSuccess，并合并 hook/userDisplayMessage。依赖通过 initReactiveCompact 注入，便于分别断言 preCompact、compact 和 onSuccess 次数。

`isWithheldPromptTooLong`、`isWithheldMediaSizeError` 和 `isReactiveCompactEnabled` 共用运行时 kill switch；`isReactiveOnlyMode` 继续读取既有 feature value。

## 4. 验收与 feature 接入

`tests/reactiveCompact.test.ts` 至少覆盖：

- hasAttempted/aborted/特殊 querySource；
- 两组以下消息；
- 直接与内嵌媒体、media_unstrippable；
- stripped 与 forkContextMessages 是同一版本；
- skipPreCompactHooks=true、PreCompact 只一次；
- aborted/exhausted/error 和 display message 合并。

构建只添加 `REACTIVE_COMPACT`，feature fixture 同步检查注册。

```bash
bun test tests/reactiveCompact.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

回滚时先移除 feature 与入口，再回滚 reactive 和 skip 参数；不得通过重复执行 PreCompact、保留媒体副本或把失败统一返回 success 来通过检查。
