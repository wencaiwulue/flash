---
commit: edcaa957458d924bc9c1cfe42b7af59eb9c2db11
title: "Implement proactive state and coordinator workers"
date: 2026-11-10T19:29:50+08:00
status: implemented
---

# Implementation plan: Implement proactive state and coordinator workers

## Objective

实现 proactive 状态、idle 调度、Sleep 激活和 Coordinator worker 定义。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

不依赖全局 USER_TYPE=ant，worker 不可递归嵌套 Agent。

## Verification sequence

状态转换、调度、worker 工具集与组合构建。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 真实 proactive/multi-worker 模型编排未在该提交验收。
