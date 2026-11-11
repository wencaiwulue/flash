---
commit: e8d8c066c1419579fbf8bf6f653760110eaf315a
title: "Finalize previous commit documentation"
date: 2026-11-11T11:19:30+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

4329cd8 已经为 e0cbbe1 建立文档，但 4329cd8 自身仍不可发现。补档时必须区分这两个提交，不能把 SPEC 中引用的 e0cbbe1 文件当成本次新建文件。

- 核对实际 parent f5b097b、被补档提交 4329cd8 与其文档对象 e0cbbe1 的层级。

## 复用与兼容处理

### 复用现有实现

- 沿用已有 frontmatter、INDEX 列结构和 status 对象字段，不重排 self。

### 兼容、迁移与生命周期

- 既有提交行和 JSON 对象保持顺序，新增链接使用既有 ../docs 与 repository-relative 约定。

## 文件级实施步骤

### 1. 说明 4329cd8 的范围

写入其完整身份，并列出 e0cbbe1 两个文档及四项 diff 范围。

涉及位置：`docs/specs/4329cd8-SPEC.md`

### 2. 生成 4329cd8 计划

用相同 frontmatter 组织目标、步骤、风险、验证与剩余工作。

涉及位置：`docs/plans/4329cd8-PLAN.md`

### 3. 更新人类索引

把汇总改为 80，并在既有 8a248e3 行后、self 前插入 4329cd8。

涉及位置：`docs/INDEX.md`

### 4. 更新机器索引

在 8a248e3 对象后登记 4329cd8，保留 self 为最后一个对象。

涉及位置：`docs/status/index.json`

## 风险与处理

- 相同标题容易造成 4329cd8 与 e0cbbe1 对象错位；验证模板也容易被误读为已经执行。

## 验证顺序

1. 对照 4329cd8 的真实 diff 检查 SPEC 范围，并比较 parent/current 的表格、计数和 JSON 新对象。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 4329cd8 的两个新产物及人类、机器索引入口均已落入本提交。

### 未完成或后续工作

- 没有随附测试或 CI 日志，泛化计划也未增加实现细节。
