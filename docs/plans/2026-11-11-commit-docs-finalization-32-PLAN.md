---
commit: 5c5bc03abc666d111ae5e4227224884bbaafd340
title: "Complete previous commit documentation"
date: 2026-11-11T11:14:17+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Complete previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

本次对象为 787b2dc，而不是父版本刚登记的 b6bf982。新规格还必须如实呈现 787b2dc 当时为 96283ae 新建两份文档的范围，不能沿用上一提交的 6c3c1e4 内容。

- 确认父版本计数为 70，读取 787b2dc 的完整 metadata，并核对其 SPEC 应描述的 96283ae 两个文件。

## 复用与兼容处理

### 复用现有实现

- 复用刚由 6b0ce9d 建立的四文件注册形式，但替换所有身份、日期、内层路径和计数，而非沿用正文。

### 兼容、迁移与生命周期

- 不清空或重排历史对象；现有 b6bf982 链接、self changeId 以及索引格式均原样保留。

## 文件级实施步骤

### 1. 登记目标祖父提交规格

在 787b2dc 规格中写清 96283ae 的 SPEC/PLAN 才是该历史提交创建的文档。

涉及位置：`docs/specs/787b2dc-SPEC.md`

### 2. 生成对应计划

用 Complete previous commit documentation 的准确标题建立 787b2dc 计划并保留验证边界。

涉及位置：`docs/plans/787b2dc-PLAN.md`

### 3. 扩展人工导航

在 b6bf982 行之后添加 787b2dc 行，同时把 implemented 汇总改为 71。

涉及位置：`docs/INDEX.md`

### 4. 扩展状态数组

为 787b2dc 写入 fullSha、时间、主题和 spec/plan 路径，插入点固定在 self 前。

涉及位置：`docs/status/index.json`

## 风险与处理

- 相邻提交都采用相同文件数与 diff 统计，最容易误复制 b6bf982 的身份或 6c3c1e4 的范围，验证命令也可能被误读。

## 验收顺序

1. 逐项比对 787b2dc metadata 与 frontmatter，检查 96283ae 范围、71/1/0 计数、两个索引链接和 self 的位置。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 目标祖父提交 787b2dc 已具备 SPEC、PLAN、INDEX 行和 status 对象，四个实际路径全部覆盖。

### 未完成或后续工作

- 未留下可核验的命令执行或持续集成记录，完成状态仅指元数据迁移已写入。
