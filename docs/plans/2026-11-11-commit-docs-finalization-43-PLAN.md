---
commit: 3c4b6f2752cee47fd15ead682e6016fe48174bd8
title: "Finalize previous commit documentation"
date: 2026-11-11T11:20:31+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

e8d8c06 刚刚完成的是 4329cd8 的补档，本提交则要为 e8d8c06 自己补档。相同提交标题叠加两层文档关系，最容易把新建 e8d8c06 文件误写成修改 4329cd8 文件。

- 厘清 e8d8c06 是当前文档对象，4329cd8 是其 SPEC 内的历史范围，fdffe9e 才是实际 parent。

## 复用与兼容处理

### 复用现有实现

- 沿用相邻条目的字段顺序与 Markdown 小节，保持 f5b097b 和 self 的相对位置。

### 兼容、迁移与生命周期

- 已有 79 至 81 计数对应的历史行保持原顺序，只追加新一代入口。

## 文件级实施步骤

### 1. 建立 e8d8c06 规格

填写 e8d8c06 身份，并如实抄录其 4329cd8 两文件范围与 78+1 统计。

涉及位置：`docs/specs/e8d8c06-SPEC.md`

### 2. 建立 e8d8c06 计划

使用相同提交日期和 Finalize 标题，生成计划的各个标准小节。

涉及位置：`docs/plans/e8d8c06-PLAN.md`

### 3. 移动汇总到 82

在 f5b097b 行之后加入 e8d8c06，保持 self 行不动。

涉及位置：`docs/INDEX.md`

### 4. 登记 e8d8c06 JSON

让机器条目指向新建 SPEC/PLAN，而不是其内部提到的 4329cd8 文件。

涉及位置：`docs/status/index.json`

## 风险与处理

- 同名 Finalize 提交连续出现，完整 SHA 与嵌套路径若未同时核对，就可能错配一代。

## 验收顺序

1. 检查 e8d8c06 原始 name-status 与 SPEC 路径块，并核对当前 INDEX/JSON 的 82 计数和新对象。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- e8d8c06 自身的两个文档与两个索引入口已经补齐。

### 未完成或后续工作

- 通用计划没有执行证据，也没有更细的生成过程说明。
