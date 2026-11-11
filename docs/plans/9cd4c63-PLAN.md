---
commit: 9cd4c63193ded6eb916bf734f65a427da193faf0
title: "Add live validation workflows and registry compatibility"
date: 2026-11-11T09:15:44+08:00
status: implemented
---

# Implementation plan: Add live validation workflows and registry compatibility

## Objective

加入 live validation workflow 与脚本，兼容 SkillHub global namespace 和响应字段。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

隔离配置目录，不把 settings/token 写入日志或 artifact。

## Verification sequence

真实模型四项与真实 SkillHub registry 返回所有 LIVE_OK。

## Completion status and remaining work

- Status: **implemented**
- Remaining: Cloud/桌面 job 的环境配置仍需单独提供。
