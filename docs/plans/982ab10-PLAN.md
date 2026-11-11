---
commit: 982ab108e16a0919269629256555d7ef9efea707
title: "Enable Buddy and Fork Subagent"
date: 2026-11-10T22:28:04+08:00
status: implemented
---

# Implementation plan: Enable Buddy and Fork Subagent

## Objective

启用 Buddy 与 Fork，补 companion soul/reaction 和真实 /fork prompt。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

deterministic bones 与模型 soul 分离，禁止递归 fork。

## Verification sequence

companion 持久化、reaction、fork cache placeholder 和 worktree notice。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 模型生成的 companion 个性未在该提交单独做 live 验收。
