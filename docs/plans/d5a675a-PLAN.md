---
commit: d5a675a4df66ff620d7577aaf167bb5749cc08a2
title: "Implement open KAIROS functionality"
date: 2026-11-10T23:23:22+08:00
status: implemented
---

# Implementation plan: Implement open KAIROS functionality

## Objective

实现开放 KAIROS assistant/team/session、文件上传、通知、PR 订阅和 dream。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

复用 OAuth 与 GitHub REST，首次轮询只建立基线。

## Verification sequence

隔离 team 初始化、通知适配器、PR 去重和组合构建。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 真实 Cloud/notification/GitHub 往返未在该提交验收。
