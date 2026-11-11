---
commit: a8c8b90fd2e7b5fa14ebb2bc6beff3f5c2904346
title: "Add lifecycle regressions and race fixes"
date: 2026-11-11T00:06:18+08:00
status: implemented
---

# Implementation plan: Add lifecycle regressions and race fixes

## Objective

补 changed-file、cron、LSP 生命周期测试并修复删除竞态和崩溃重启状态。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

真实文件与 JSON-RPC 子进程，不依赖配置字段假验证。

## Verification sequence

offset/limit、cron lock/aging、LSP restart/timeout 全量测试。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 无该提交范围内的未实现项。
