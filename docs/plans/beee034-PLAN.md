---
commit: beee034523510ac0425461bb4ffce3250514d693
title: "Support settings-based bearer authentication"
date: 2026-11-11T10:06:54+08:00
status: implemented
---

# Implementation plan: Support settings-based bearer authentication

## Objective

支持 settings.json 的 ANTHROPIC_AUTH_TOKEN，保持 Bearer 与 API key 认证互斥。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

不把 token 映射为 Claude OAuth 或 x-api-key，不输出 token。

## Verification sequence

本地 settings-based 四项模型验证及 CI 全部通过。

## Completion status and remaining work

- Status: **implemented**
- Remaining: Claude OAuth 和原生桌面验收仍需独立环境。
