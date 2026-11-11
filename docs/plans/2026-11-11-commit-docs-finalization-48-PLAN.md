---
commit: fe2ced6af51deecae060e1729f1b5ebe5f871f27
title: "Complete previous commit documentation"
date: 2026-11-11T11:23:32+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Complete previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

846c130 为 c8338e1 做过补档，现在需要把文档对象提升到 846c130 本身。本提交标题与 846c130 都是 Complete，但真正的识别依据是其完整 SHA、时间和 SPEC 内的 c8338e1 范围。

- 确认实际 parent 0e2559a、被补档 846c130 及其历史对象 c8338e1，避免标题相同造成错认。

## 复用与兼容处理

### 复用现有实现

- 沿用 69d3596 后的尾部追加位置和已有 frontmatter、表格列及 JSON 字段。

### 兼容、迁移与生命周期

- 已有历史项、self changeId 和路径格式均保持，新增内容可沿用现有读取方式。

## 文件级实施步骤

### 1. 编写 846c130 SPEC

固定 Complete 身份，列入 c8338e1 两个历史文档及四路径统计。

涉及位置：`docs/specs/846c130-SPEC.md`

### 2. 编写 846c130 PLAN

使用 846c130 的时间生成计划、风险、验证序列与剩余项。

涉及位置：`docs/plans/846c130-PLAN.md`

### 3. 把汇总推进到 87

在 69d3596 行后添加 846c130 链接，保留 self 为最后一行。

涉及位置：`docs/INDEX.md`

### 4. 添加 846c130 状态

将完整 SHA、Complete subject 和新 SPEC/PLAN 路径写入 self 前对象。

涉及位置：`docs/status/index.json`

## 风险与处理

- 当前提交与被补档提交都使用 Complete 标题；日期、嵌套路径或 fullSha 任一项复制错误都会造成错代。

## 验收顺序

1. 核对 846c130 原始 metadata、diff 路径与 SPEC，再检查 current INDEX 的 87 计数及 JSON 字段。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 846c130 的两个新产物及两个索引入口已在本提交同步建立。

### 未完成或后续工作

- 没有验证执行日志，通用计划也未补充更细的设计说明。
