---
commit: 6b7bf48b0b4f0af740073eddbc5584f0c598c539
title: "Complete secure storage, marketplace, and SDK controls"
date: 2026-11-10T12:41:48+08:00
status: implemented
---

# Implementation plan: Complete secure storage, marketplace, and SDK controls

## Objective

实现 Linux libsecret、npm marketplace 和 SDK 控制接口。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

secret JSON 仅经 stdin 传递，npm 禁止生命周期脚本。

## Verification sequence

mock secret-tool、npm runner 和 SDK control 回归测试。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 真实 secret-tool/npm/Cloud 环境未在该提交单独验收。
