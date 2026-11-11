---
commit: ea8085139c013577cad3130c35a21fc53a3d8bee
title: "Implement declarative workflow execution"
date: 2026-11-10T20:30:36+08:00
status: implemented
---

# Implementation plan: Implement declarative workflow execution

## Objective

实现严格 workflow schema、项目发现、DAG 并发、依赖恢复和本地任务状态。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

步骤通过现有 agent runner 与工具权限执行，不绕过权限。

## Verification sequence

DAG、skip/retry/kill、依赖失败、任务输出和组合构建。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 真实模型 agent workflow 当时未执行，后续已单独验证。
