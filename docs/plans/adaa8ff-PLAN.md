---
commit: adaa8fffa7c7c536d782616f8f7e187de637a582
title: "Implement env-less perpetual continuity"
date: 2026-11-11T00:40:35+08:00
status: implemented
---

# Implementation plan: Implement env-less perpetual continuity

## Objective

实现 env-less perpetual 的 cse/SSE 复用、401 重建和 pointer 保留/归档。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

临时 teardown 保留 session，仅显式 archive 清理 pointer；不重放重复事件。

## Verification sequence

独立进程验证同 ID、seq 恢复、401 重建与归档清理。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 真实 OAuth 服务端 perpetual round trip 未在该提交执行。
