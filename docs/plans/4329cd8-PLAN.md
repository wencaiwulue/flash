---
commit: 4329cd8296630e2e5334d4b410cc8fe1cca273b6
title: "Finalize previous commit documentation"
date: 2026-11-11T11:18:31+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

本次要为 e0cbbe1 补齐元数据，其 SPEC 内层对象应为 1fe1430。当前提交标题比目标标题少了 documentation 一词，若按当前 subject 填模板，会造成 frontmatter 和索引主题错误。

- 确认 8a248e3 基线为 77，比较当前与目标标题，并读取 e0cbbe1 为 1fe1430 建文档的原始 diff。

## 复用与兼容处理

### 复用现有实现

- 复用四文件注册布局，frontmatter、表格主题和 JSON subject 全部采用 e0cbbe1 的完整标题。

### 兼容、迁移与生命周期

- 已有 77 项历史记录及 self bootstrap 字段不变，状态计数继续只改变 implemented。

## 文件级实施步骤

### 1. 编写 e0cbbe1 规格

保留 Finalize documentation 标题，列出 1fe1430 两份历史文档作为 Actual scope。

涉及位置：`docs/specs/e0cbbe1-SPEC.md`

### 2. 编写 e0cbbe1 计划

使用目标全 SHA 和带 documentation 的标题创建 PLAN，不沿用当前提交措辞。

涉及位置：`docs/plans/e0cbbe1-PLAN.md`

### 3. 推进人工索引至 78

在 a4edc60 后加入 e0cbbe1 完整主题行，implemented 加一并保留 self 尾行。

涉及位置：`docs/INDEX.md`

### 4. 登记 e0cbbe1 机器状态

把相同 full SHA、长标题、日期和新文件路径写入 self 前的 JSON 对象。

涉及位置：`docs/status/index.json`

## 风险与处理

- 当前与目标标题仅一词之差，校验若忽略标题会漏错；内层 1fe1430 也不能误写成 dc3f075。

## 验证顺序

1. 检查两个 frontmatter 的长标题、e0cbbe1 全 SHA、1fe1430 清单、78/1/0 汇总和 JSON/self 顺序。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- e0cbbe1 的两个文档和双索引入口均按目标元数据落盘，无额外路径。

### 未完成或后续工作

- 提交未记录真实验证执行，完成状态不覆盖测试或 CI 结果。
