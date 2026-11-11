---
commit: 614bf48f749df56f79562e4c64f765875f8fd880
title: "Enable external features and recover SDK parallel branches"
date: 2026-11-10T18:48:33+08:00
status: implemented
---

# Implementation plan: Enable external features and recover SDK parallel branches

## Objective

启用已有外部功能，并在两个 SDK 会话读取路径恢复并行 assistant/tool-result DAG。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

保持 external USER_TYPE，不启用缺失内部工具。

## Verification sequence

组合构建、27 工具、SDK 并行分支与分页测试。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 真实 Cloud/remote 服务验证仍未执行。
