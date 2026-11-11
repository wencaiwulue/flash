---
commit: e0cbbe14182f93a59bd7e28a4dcd0776e05831f0
title: "Finalize documentation for previous commit"
date: 2026-11-11T11:17:15+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize documentation for previous commit

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

本提交需登记 1fe1430，而且其标题是 Finalize previous commit documentation，并非本提交的 Finalize documentation for previous commit。新 SPEC 的内层对象应是 c771f05，不能误用 dc3f075 的 5c5bc03。

- 确认 a4edc60 基线为 75，分别读取 e0cbbe1 与 1fe1430 的标题，并核对目标提交的 c771f05 范围。

## 复用与兼容处理

### 复用现有实现

- 复用双 Markdown 与双索引格式，目标 frontmatter 采用 1fe1430 自身标题而不是当前提交标题。

### 兼容、迁移与生命周期

- 保留旧条目和 self 顺序，当前提交标题只用于 Git subject，不覆盖目标文档的元数据。

## 文件级实施步骤

### 1. 编写 1fe1430 规格

保留目标 Finalize previous 标题，同时把 c771f05 两个文档列入其历史范围。

涉及位置：`docs/specs/1fe1430-SPEC.md`

### 2. 编写 1fe1430 计划

用同一 frontmatter 和标题创建 PLAN，避免误用 e0cbbe1 的 Finalize documentation 措辞。

涉及位置：`docs/plans/1fe1430-PLAN.md`

### 3. 更新 76 项人工索引

将 1fe1430 行追加到 dc3f075 之后，链接两个新文件并调整 implemented 汇总。

涉及位置：`docs/INDEX.md`

### 4. 更新 1fe1430 机器状态

在 self 前插入目标 full SHA、准确标题、日期以及 spec/plan 文件字段。

涉及位置：`docs/status/index.json`

## 风险与处理

- Finalize previous 与 Finalize documentation 两种近似标题最容易混写；内层 c771f05 与相邻 5c5bc03 也需分别核验。

## 验证顺序

1. 检查 e0cbbe1 版本中两个 frontmatter、1fe1430 表格标题、c771f05 清单、76/1/0 和 self 末位。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 1fe1430 的文档及索引入口均按目标自身标题创建，四路径无遗漏。

### 未完成或后续工作

- 没有可复核的运行日志或 CI 状态，元数据之外的验证仍无记录。
