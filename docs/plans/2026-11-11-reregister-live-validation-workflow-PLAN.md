---
commit: 4dd93b75220926cefbe9d5d017224238bfd8e0f1
title: "Re-register live validation workflow"
date: 2026-11-11T09:23:48+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Re-register live validation workflow

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

提交主题指向重新注册，但可观察实现只有 workflow 文件换名；外部注册故障和结果都没有记录，设计范围不能扩展到平台行为。

- 读取父版本旧路径内容，作为零内容变化比较基准。

## 复用与兼容处理

### 复用现有实现

- 完整复用 workflow_dispatch、cron、permissions、两个 job 及其环境映射。

### 兼容、迁移与生命周期

- 手动触发、17 6 * * * schedule 和两条验证命令保持原样；仅依赖文件名的外部消费者需要识别新路径。

## 文件级实施步骤

### 1. 纯重命名 workflow

把旧路径移动到 live-checks.yml，不编辑任何 YAML 行。

涉及位置：`.github/workflows/live-validation.yml`、`.github/workflows/live-checks.yml`

### 2. 核对 blob 身份

比较父版本旧路径与提交版本新路径，确认 R100 且内部名称未变。

涉及位置：`.github/workflows/live-checks.yml`

## 风险与处理

- 显示名与文件名不同，且路径变化本身不能证明平台注册结果。

## 验收顺序

1. 用 rename-aware diff 检查唯一变更，再比较两个 revision 的 workflow blob。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 新旧路径替换及零内容变化均可由提交直接确认。

### 未完成或后续工作

- 换名后的注册、dispatch 和 schedule 执行情况未记录。
