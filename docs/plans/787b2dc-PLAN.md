---
commit: 787b2dcef6629be82036283cc709384b56e6d981
title: "Complete previous commit documentation"
date: 2026-11-11T11:12:59+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Complete previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

本提交需为 96283ae 补齐历史文档和入口，同时保留它为 612cc40 建档的实际范围；直接父 b6bf982 的 6c3c1e4 范围不能取而代之。

- 确认祖父 96283ae 为目标，核对其原始 612cc40 文档对和四文件 78/1 统计。

## 复用与兼容处理

### 复用现有实现

- 沿用 6c3c1e4 后的追加顺序、self 占位、JSON 七字段和现有生成文档结构。

### 兼容、迁移与生命周期

- 6c3c1e4 及更早历史项保持原序，self 内容和生成器行为不变，索引 schema 无调整。

## 文件级实施步骤

### 1. 编写 96283ae SPEC

写入完整身份、612cc40 文档路径及 78/1 行统计。

涉及位置：`docs/specs/96283ae-SPEC.md`

### 2. 编写 96283ae PLAN

以相同 frontmatter 保存实施步骤、风险、验证建议和完成状态。

涉及位置：`docs/plans/96283ae-PLAN.md`

### 3. 追加 INDEX 项

在 6c3c1e4 后新增 96283ae，只将 Implemented 改为 69。

涉及位置：`docs/INDEX.md`

### 4. 追加 JSON 项

把 96283ae 插入第 70 位，使 self 成为第 71 项。

涉及位置：`docs/status/index.json`

## 风险与处理

- 96283ae 与当前提交标题相同，若忽略 fullSha 和祖父关系，会把 612cc40 范围挂到错误对象。

## 验证顺序

1. 对照 96283ae 原始提交与新 SPEC/PLAN，并比较父/当前索引计数、路径和 self 下标。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 96283ae 的 SPEC/PLAN 与双索引入口已在四个路径中同步完成。

### 未完成或后续工作

- 没有实际验证或 CI 记录，implemented 不扩大为测试通过声明。
