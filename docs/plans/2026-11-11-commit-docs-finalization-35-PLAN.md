---
commit: 1fe14300c3b0a9eced6c5c3b3bf4615c7ca43361
title: "Finalize previous commit documentation"
date: 2026-11-11T11:16:02+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

本次要把 c771f05 接入文档序列，并在其 SPEC 中还原 c771f05 为 6b0ce9d 创建文档的四路径范围，不能误用 dc3f075 所描述的 787b2dc 范围。

- 确认 dc3f075 基线为 73，读取 c771f05 完整 metadata，并核对其自身涉及 6b0ce9d 文档的四路径 diff。

## 复用与兼容处理

### 复用现有实现

- 复用现有 frontmatter 字段和双索引结构，正文范围改用 c771f05 的 6b0ce9d 关系。

### 兼容、迁移与生命周期

- 既有 73 个 implemented 项及 Partial/Unimplemented 记录保持，self 的 changeId 和链接不受影响。

## 文件级实施步骤

### 1. 编写 c771f05 规格

用 c771f05 身份开篇，把 6b0ce9d 两份文档列作其历史 Actual scope。

涉及位置：`docs/specs/c771f05-SPEC.md`

### 2. 编写 c771f05 计划

以 Finalize previous commit documentation 建立匹配计划，区分计划验证与真实结果。

涉及位置：`docs/plans/c771f05-PLAN.md`

### 3. 加入第 74 个链接

在 5c5bc03 行之后登记 c771f05，保留 self 尾行并同步 implemented 汇总。

涉及位置：`docs/INDEX.md`

### 4. 加入对应 JSON 状态

将 c771f05 的完整 SHA、日期和 spec/plan 映射写入 self 前的数组位置。

涉及位置：`docs/status/index.json`

## 风险与处理

- 6b0ce9d 与 787b2dc 是相邻记录的不同内层对象，混用会造成表面格式正确但历史内容错误。

## 验收顺序

1. 比对 c771f05 frontmatter 和 metadata，检查 6b0ce9d 路径清单、74/1/0 汇总、JSON 链接及 self 末位。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- c771f05 的两个新文档与两个索引变更全部落盘，四路径范围完整。

### 未完成或后续工作

- 没有实际命令输出可审计，完成仅表示元数据与索引同步。
