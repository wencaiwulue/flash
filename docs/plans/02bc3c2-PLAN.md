---
commit: 02bc3c2efcd3f3d7978da33b2683e9d392f3220c
title: "Unblock remote control and Cloud persistence"
date: 2026-11-10T15:53:19+08:00
status: implemented
---

# Implementation plan: Unblock remote control and Cloud persistence

## Objective

实现 env-less remote-control handle、FIFO 队列、权限响应和 Cloud Files 路径映射。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

不猜 xattr 名称或伪造成功 handle，Cloud 使用 Files API。

## Verification sequence

fake transport、Cloud pagination/ambiguity/abort 测试及 CI。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 真实 OAuth Cloud/remote-control round trip 未在该提交验证。
