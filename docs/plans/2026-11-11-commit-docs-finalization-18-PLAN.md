---
commit: 2f55f199acfd26b90c81c5de3c5ca6fcfe167dfc
title: "Finalize previous commit documentation"
date: 2026-11-11T11:05:45+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

0640471 的主题声称处理 current and previous commits，实际却只登记 d802331。现在为 0640471 自己补文档时，需要保留这个特殊主题，同时把它的真实四文件范围写清楚。

- 读取 0640471 元数据与真实 diff，区分其 current/previous 主题和唯一 d802331 目标。

## 复用与兼容处理

### 复用现有实现

- 沿用 335b217 后的索引位置和通用文档结构，保留 self 占位不变。

### 兼容、迁移与生命周期

- 目标主题原样保留，既有路径、条目顺序、self 文档和 changeId 均不变。

## 文件级实施步骤

### 1. 编写 0640471 SPEC

完整保留目标特殊主题，Actual scope 只列 d802331 两个产物和两个索引。

涉及位置：`docs/specs/0640471-SPEC.md`

### 2. 编写 0640471 PLAN

使用同一主题与身份，补齐目标实施、风险、验证建议和完成状态。

涉及位置：`docs/plans/0640471-PLAN.md`

### 3. 增加特殊主题表格行

在 335b217 后添加 0640471，只将 Implemented 调整为 57。

涉及位置：`docs/INDEX.md`

### 4. 增加对应 JSON 对象

把完整 0640471 对象插入 self 前，使数组总数达到 59。

涉及位置：`docs/status/index.json`

## 风险与处理

- 特殊主题容易诱导记录者写出不存在的一组文档，必须让 frontmatter 忠实与 Actual scope 忠实同时成立。

## 验收顺序

1. 比对目标主题与 frontmatter，核对范围仅四条路径，检查索引计数和 self 末位。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 0640471 的新 SPEC/PLAN 和双索引登记已完成，四个变更路径全部覆盖。

### 未完成或后续工作

- 未记录任何命令或 CI 执行结果，implemented 不被解释为验证通过。
