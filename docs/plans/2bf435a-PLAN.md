---
commit: 2bf435a5d3aca3c375da1387f1e33d3ce13db683
title: "Implement history snipping"
date: 2026-11-10T22:42:16+08:00
status: implemented
---

# Implementation plan: Implement history snipping

## Objective

实现 snip marker、边界投影、SnipTool 和 force-snip。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

保护最近消息与 tool pair，不改写磁盘 transcript。

## Verification sequence

marker 幂等、双向 tool-pair、nudge、REPL/SDK 与命令测试。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 真实长会话裁剪效果未在该提交做 live 验收。
