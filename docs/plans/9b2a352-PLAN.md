---
commit: 9b2a35201244ca84adeaa6844bf799e5a18aff6d
title: "Restore CLI and SDK build"
date: 2026-11-10T11:39:20+08:00
status: implemented
---

# Implementation plan: Restore CLI and SDK build

## Objective

恢复可复现的 Bun CLI/SDK 构建、TypeScript 配置和直接依赖。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

仅恢复公开源码与构建元数据，不引入内部私有包。

## Verification sequence

类型检查、CLI/SDK 构建及启动冒烟。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 当时仍存在 SDK 生命周期和协议实现缺口，后续提交继续补齐。
