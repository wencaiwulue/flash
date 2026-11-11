---
commit: be5c03e17428c3a7f85f7c0459b49432e61ccbf4
title: "Complete previous commit documentation"
date: 2026-11-11T11:09:24+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Complete previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

本提交需要补 1bc02bf，而非直接父 1329f79；其 SPEC 还应回看 1bc02bf 为 d472e5c 新建文档的事实，不能把 1329f79 的 3fbabc2 范围复制过来。

- 确认 1329f79 是直接父而非目标，并核对 1bc02bf 创建的 d472e5c 文件。

## 复用与兼容处理

### 复用现有实现

- 沿用 3fbabc2 后的追加位置、历史对象七字段及 self 占位，复用已有 Markdown 模板。

### 兼容、迁移与生命周期

- 3fbabc2 与更早历史项不改，self 内容不变；生成器和现有文档格式均保持父版本。

## 文件级实施步骤

### 1. 记录 1bc02bf 范围

在 SPEC 中写入 d472e5c 两个文档和两个索引及 78/1 统计。

涉及位置：`docs/specs/1bc02bf-SPEC.md`

### 2. 生成 1bc02bf 计划

用相同 frontmatter 添加实施步骤、风险、验证序列和状态。

涉及位置：`docs/plans/1bc02bf-PLAN.md`

### 3. 追加 INDEX 入口

在 3fbabc2 后添加 1bc02bf 行，只递增 Implemented 到 62。

涉及位置：`docs/INDEX.md`

### 4. 追加 JSON 入口

把 1bc02bf 作为第 63 个对象写入，保留 self 为第 64 项。

涉及位置：`docs/status/index.json`

## 风险与处理

- d472e5c 与 3fbabc2 分别是相邻两层范围，复制上一提交 SPEC 而不换路径会造成表面完整但历史错误。

## 验证顺序

1. 比较 1bc02bf 原 diff 与新 SPEC，解析 PLAN 元数据，并核对 INDEX/JSON 的单项增量和 self 位置。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 1bc02bf 的两个文档和两个索引入口已一致落盘。

### 未完成或后续工作

- 未记录任何实际验证命令或 CI 结果，implemented 不代表这些检查已经运行。
