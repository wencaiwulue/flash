---
commit: dab8405a36c2cb18c22b58235c8124265666b162
title: "Document remaining implementation boundaries"
date: 2026-11-10T21:01:21+08:00
status: implemented
kind: evidence-update
---

# 实施计划：Document remaining implementation boundaries

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要把仍未实现的系统与仅缺验证的项目分开写清，并重排后续工作，避免已有 Verified 项被误读为所有特性均已完成。本提交只更新状态文档，不实现这些边界中的任何功能。

- 对照父提交能力表和 Verified evidence，区分已经验证的替代路径与仍不可用的目标实现。

## 复用与兼容处理

### 复用现有实现

- 沿用 STATUS 的现有小节、表格和验证证据约定，不另建状态存储或索引。

### 兼容、迁移与生命周期

- 既有 Verified evidence 表和状态定义不变，只增加边界说明并调整下一步编号。

## 文件级实施步骤

### 1. 补全边界并重排后续工作

在 STATUS.md 增加六条精确边界，再把实现 HISTORY_SNIP/ReviewArtifact、补 changed-file/cron/LSP 回归置于授权环境验证之前；保留 Cloud/remote 任务和纯 env-less perpetual 的产品条件。

涉及位置：`docs/STATUS.md`

## 风险与处理

- 规划动词容易被误读为实现结果；正文必须使用 still、need 等边界措辞，并避免新增无来源的执行声明。

## 验收顺序

1. 逐行比较父提交与 at-commit STATUS，核对新增六条边界、五项顺序及唯一变更路径。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 剩余实现/验证边界和新的后续顺序已经写入 STATUS。

### 未完成或后续工作

- 文档没有完成所列实现、回归或授权环境验证，也没有新增执行日志。
