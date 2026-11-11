---
commit: 6b0ce9d6834a125567ec0121caa531f5b8341101
title: "Finalize previous commit documentation"
date: 2026-11-11T11:13:50+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要补登记文档链中较早的 b6bf982，同时让它自己的 SPEC 正确描述 b6bf982 为 6c3c1e4 建文档的四路径变更；若按通常的直接父提交模板处理，会同时错置两层提交。

- 先确认 787b2dc 是直接父版本、b6bf982 是目标祖父提交，并核对 b6bf982 自身的 6c3c1e4 四路径 diff。

## 复用与兼容处理

### 复用现有实现

- 沿用 INDEX 的既有列结构、status 对象字段以及 SPEC/PLAN frontmatter，不重排 self。

### 兼容、迁移与生命周期

- 保留前 69 个 implemented 条目及 self 字段；新增 Markdown 链接和 JSON repository-relative 路径遵循现有格式。

## 文件级实施步骤

### 1. 补写祖父提交规格

以 b6bf982 为 frontmatter 主体，单独列出其面向 6c3c1e4 的四个历史路径。

涉及位置：`docs/specs/b6bf982-SPEC.md`

### 2. 补写祖父提交计划

复用相同身份和 implemented 标记，为 b6bf982 添加计划、风险及边界段落。

涉及位置：`docs/plans/b6bf982-PLAN.md`

### 3. 更新第 70 项索引

把计数推进到 70，并将 b6bf982 链接行追加在既有历史项之后、self 之前。

涉及位置：`docs/INDEX.md`

### 4. 登记祖父提交状态

在 JSON 的 self 对象之前写入 b6bf982 完整 SHA、日期、主题和两项文档路径。

涉及位置：`docs/status/index.json`

## 风险与处理

- 主要风险是把直接父版本 787b2dc 与目标祖父 b6bf982 混用，或把 SPEC 内 6c3c1e4 的范围当成本提交 diff。

## 验证顺序

1. 比较两个 frontmatter 与 b6bf982 metadata，核对 6c3c1e4 路径清单，并检查 70/1/0 汇总、JSON 对象及 self 末位。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- b6bf982 的两个新产物与双索引入口已落盘，四处变更均有对应身份和路径。

### 未完成或后续工作

- 没有可归属于该提交的测试日志或 CI 结果，文档验证清单仍只是声明。
