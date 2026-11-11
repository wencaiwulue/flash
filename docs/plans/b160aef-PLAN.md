---
commit: b160aef6c60e6ef3ef0d4bfdf7f97dae7532e02b
title: "Use explicit expressions for live gating"
date: 2026-11-11T09:31:11+08:00
status: implemented
---

# Implementation plan: Use explicit expressions for live gating

## Objective

Use explicit expressions for live gating。保持现有 CLI/SDK 接口、feature gating 与权限边界，完成该提交对应的实现、修复或文档工作。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

不引入新的凭据、私有协议或绕过现有权限的行为。

## Verification sequence

bun test、bun run typecheck、bun run build 及对应 CI 检查。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 无该提交范围内的未实现项。
