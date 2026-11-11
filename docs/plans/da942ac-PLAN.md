---
commit: da942ac7d8b72858fc186837690c9b5b3cdeafe5
title: "Implement reactive compaction recovery"
date: 2026-11-10T20:59:02+08:00
status: implemented
---

# Implementation plan: Implement reactive compaction recovery

## Objective

实现 reactive PTL/媒体错误识别、媒体剥离、共享 compact 与清理。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

不重复 PreCompact hook，失败按类型返回，不伪造恢复成功。

## Verification sequence

错误识别、媒体剥离、PreCompact、失败映射与组合构建。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 真实 API 413 恢复当时未执行。
