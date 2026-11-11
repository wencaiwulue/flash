---
commit: 2bf435a5d3aca3c375da1387f1e33d3ce13db683
title: 历史 snip 的标记、目标扩展与投影设计
date: 2026-11-10
retrospective: true
---

# 历史 snip 的标记、目标扩展与投影设计

## 标记与执行分离

SnipTool 不立即修改磁盘 transcript，而是在参数校验后追加 `snip_marker` system message，包含请求的短 ID。真正压缩由 `snipCompactIfNeeded()` 在后续上下文处理执行；force-snip 绕过 marker 要求，直接选择自动目标。

marker 也是 snip 的执行条件之一。执行时 marker 本身被移除，并在首个删除位置插入 `snip_boundary`，记录删除数量和估算 tokens。`projectSnippedView()` 从最近 boundary 开始返回视图，并始终过滤内部 snip_marker，避免模型看到内部控制记录。

## 目标解析与工具对保护

`resolveSnipTargets()` 只匹配 user/assistant 的 deriveShortMessageId，并保护最后四条消息。重复 ID 去重，找不到或受保护的 ID 放入 invalidIds。

`expandToolPairs()` 迭代扩展目标，直到同时覆盖：

- assistant 的 API message.id 与其 sibling；
- user tool result 的 sourceToolAssistantUUID；
- assistant 与指向它的 tool result。

如果扩展碰到最近四条受保护消息，则再次从保护集合向外扩展，并删除这些关联目标，防止为了 snip 旧消息而切断保留区工具对。

SnipTool 在 targets 为空或存在 invalidIds 时拒绝调用，不生成 marker。force 自动模式选择保护区域之前的 user/assistant，再应用同样的工具对保护。

## Nudge 与估算

`shouldNudgeForSnips()` 找最近的 snip boundary、compact boundary、snip marker 或 context_efficiency 附件，只估算其后的消息；达到 10,000 粗略 tokens 才提示使用 Snip，避免基于已压缩历史重复提醒。

## 验收标准

1. marker 创建、执行移除、boundary 插入和投影过滤保持幂等，磁盘 transcript 不被改写。
2. 短 ID、重复/非法 ID、最近四条保护和双向 tool-pair 扩展正确。
3. SnipTool 校验失败不产生 marker，force 自动模式与手动目标遵守同一保护规则。
4. nudge 只统计最近 reset 后的 tokens，达到阈值才触发。
5. `snip.test.ts` 覆盖 marker 幂等、工具对、nudge、REPL/SDK 和命令；feature-profile 覆盖 HISTORY_SNIP。
