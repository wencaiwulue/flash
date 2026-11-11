---
commit: 6c3c1e4d3cdd8b1b8279c023575fb7a37e94a14c
title: "Finalize documentation for previous commit"
date: 2026-11-11T11:11:31+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize documentation for previous commit

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

0dabf46 缺少自己的文档与入口，而其原始工作是为 be5c03e 建档；本提交若误选 612cc40，会把目标的 be5c03e 范围错写为 2a4aa6c。

- 确认祖父 0dabf46 是目标，并核对其原始 be5c03e 文档对及 78/1 统计。

## 复用与兼容处理

### 复用现有实现

- 复用 2a4aa6c 后的顺序、既有生成模板和 JSON 七字段，保留 self 占位内容。

### 兼容、迁移与生命周期

- 2a4aa6c 与更早历史链接不变，self 不改字段；生成器及索引格式没有版本差异。

## 文件级实施步骤

### 1. 建立 0dabf46 SPEC

写入完整目标身份、be5c03e 文档组和四文件统计。

涉及位置：`docs/specs/0dabf46-SPEC.md`

### 2. 建立 0dabf46 PLAN

用相同元数据保存计划步骤、风险、验证建议和完成声明。

涉及位置：`docs/plans/0dabf46-PLAN.md`

### 3. 追加 INDEX 行

在 2a4aa6c 后加入 0dabf46，只把 Implemented 增至 66。

涉及位置：`docs/INDEX.md`

### 4. 追加 JSON 对象

将 0dabf46 作为第 67 项写入，保留 self 为第 68 项。

涉及位置：`docs/status/index.json`

## 风险与处理

- 相同标题在 0dabf46 与更早提交反复出现，必须靠 fullSha 和 be5c03e 路径避免对象混淆。

## 验收顺序

1. 对照 0dabf46 原始提交与 SPEC，核对 PLAN frontmatter、两个计数和 self 最终位置。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 0dabf46 的两个新文档和双索引对象已在四路径 diff 中闭合。

### 未完成或后续工作

- 新文档只列出验收条件，不保存历史命令或 CI 执行结果。
