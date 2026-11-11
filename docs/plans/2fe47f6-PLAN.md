---
commit: 2fe47f6e46a3add0a3ee9bdd57bda9feac2220a7
title: "Complete documentation for previous commit"
date: 2026-11-11T11:02:02+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Complete documentation for previous commit

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

7ca78c1 已一次补齐两组历史文档，自己却缺少可发现的身份与范围说明；需要把该六文件提交登记到 Markdown 和 JSON 两套索引，同时保留直接父提交 f251df9 的后续补写位置。

- 区分直接父 f251df9 与实际目标 7ca78c1，并读取目标六文件 diff 和父快照索引。

## 复用与兼容处理

### 复用现有实现

- 沿用既有 SPEC/PLAN frontmatter、INDEX 表格和 status 对象结构，不重排历史条目。

### 兼容、迁移与生命周期

- 既有文档路径和条目顺序不变；self 的 changeId、内容和末尾语义保持原样。

## 文件级实施步骤

### 1. 记录六文件 SPEC

写入 7ca78c1 身份，并逐项列出两组历史 SPEC/PLAN 与两个索引。

涉及位置：`docs/specs/7ca78c1-SPEC.md`

### 2. 记录对应 PLAN

复用相同 frontmatter，概述目标提交的实施、风险和完成状态。

涉及位置：`docs/plans/7ca78c1-PLAN.md`

### 3. 更新表格索引

仅递增 Implemented，在 self 前添加指向 7ca78c1 新文档的一行。

涉及位置：`docs/INDEX.md`

### 4. 更新状态数组

把同一完整 SHA 和路径对象插到原 self 位置，使 self 顺移到数组末尾。

涉及位置：`docs/status/index.json`

## 风险与处理

- 目标六文件与本提交四文件容易混淆，INDEX 与 JSON 的 self 计数口径也可能被错误等同。

## 验证顺序

1. 对照目标 diff 检查六条路径和统计，解析 JSON 并核对 INDEX 计数、链接及 self 末位。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 7ca78c1 的两个新产物及两套索引登记已落盘，目标身份和范围一致。

### 未完成或后续工作

- 没有命令或 CI 执行证据；本记录只验收元数据变更，不为文档中的验证 prose 背书。
