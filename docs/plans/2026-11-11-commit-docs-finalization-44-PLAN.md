---
commit: c8338e1be21cdc792f1c69a5bf3c0094d3c29261
title: "Complete previous commit documentation"
date: 2026-11-11T11:21:15+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Complete previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

fdffe9e 曾把 f5b097b 纳入文档链，现在需要为 fdffe9e 建立下一代入口。其 Complete 标题与 f5b097b 相同，只有完整 SHA、日期和嵌套的 f5b097b 路径能明确区分。

- 核实 fdffe9e 的完整 metadata，并确认 f5b097b 是其历史文档对象而非本提交新文件。

## 复用与兼容处理

### 复用现有实现

- 保留 e8d8c06 条目和 self 尾部结构，套用相同 SPEC/PLAN 字段。

### 兼容、迁移与生命周期

- 历史对象无需迁移，新增项遵循现有排序和路径格式。

## 文件级实施步骤

### 1. 记录 fdffe9e 规格

以 Complete 标题建立 frontmatter，并列入 f5b097b 两个历史产物。

涉及位置：`docs/specs/fdffe9e-SPEC.md`

### 2. 记录 fdffe9e 计划

生成与 SPEC 同身份的目标、步骤、风险及完成状态说明。

涉及位置：`docs/plans/fdffe9e-PLAN.md`

### 3. 扩展表格到 83

把 fdffe9e 行放到 e8d8c06 之后，不改 Partial 和 Unimplemented。

涉及位置：`docs/INDEX.md`

### 4. 扩展机器状态

写入 fdffe9e 的完整 SHA、日期、subject、状态与两个新路径。

涉及位置：`docs/status/index.json`

## 风险与处理

- Complete 标题在前一代 f5b097b 已出现，单看标题会混淆；链接代际也必须随 SHA 更新。

## 验收顺序

1. 逐项比较 fdffe9e 原 diff 和 SPEC 范围，并检查 current JSON 的新对象及 parent/current 计数差。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- fdffe9e 的两个文档产物和两类索引登记已形成一致集合。

### 未完成或后续工作

- 未记录生成文档所列检查的实际执行，具体步骤也仍为模板。
