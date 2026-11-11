---
commit: ab30aec7490292b93198d53c8436081dd8b06cdf
title: "Integrate SkillHub remote skills"
date: 2026-11-10T23:05:51+08:00
status: implemented
---

# Implementation plan: Integrate SkillHub remote skills

## Objective

用 SkillHub REST 实现 canonical skill 搜索、state、resolve、下载和版本缓存。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

限制 zip 大小/文件数，拒绝路径逃逸与 symlink，不伪造 remote telemetry。

## Verification sequence

本地真实 HTTP registry、缓存版本变化及恶意 zip 测试。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 公开/自托管 registry live 验收后续执行。
