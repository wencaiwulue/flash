---
commit: f210ce9c2dc51a30f98514628b07538a969f21aa
title: "Finalize commit documentation for previous change"
date: 2026-11-11T10:50:48+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize commit documentation for previous change

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

本次文档对象是 c4e19ce，不是直接父 17c9196；需要保留 c4e19ce 为 587c466 建立 127 行 SPEC 等造成的 169 行新增规模，避免套用普通 78 行记录。

- 读取直接父 17c9196 的索引状态，并以 c4e19ce 自身 diff 核实 169 行新增的来源。

## 复用与兼容处理

### 复用现有实现

- 复用 c4e19ce 已采用的 SPEC/PLAN 结构和索引 schema，保持 8117aaa 与 self 的相对位置。

### 兼容、迁移与生命周期

- 既有 587c466 与 8117aaa 条目保持不变，新文件沿用原命名和 frontmatter 约定。

## 文件级实施步骤

### 1. 描述 c4e19ce 实际范围

新建 SPEC，列出 587c466 文档对及两个索引，并保存 169/1 统计。

涉及位置：`docs/specs/c4e19ce-SPEC.md`

### 2. 补齐 c4e19ce 计划

以相同提交身份新增 PLAN，不改写历史执行事实。

涉及位置：`docs/plans/c4e19ce-PLAN.md`

### 3. 更新表格入口

在 8117aaa 后登记 c4e19ce，Implemented 单独加一。

涉及位置：`docs/INDEX.md`

### 4. 更新状态对象

在 self 前加入相同 fullSha、implemented 和 spec/plan 路径。

涉及位置：`docs/status/index.json`

## 风险与处理

- 三层提交相互嵌套，最容易误用 17c9196 的 75 行统计或 587c466 的 95 文件统计。

## 验证顺序

1. 以 c4e19ce 的 Git diff 对照 SPEC，再交叉检查新 PLAN、INDEX 计数与 JSON 字段。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- c4e19ce 的文档对和两个索引注册已按 169 行新增的实际范围完成。

### 未完成或后续工作

- 没有可追溯的命令执行或 CI 结果，验证序列仅是文档内容。
