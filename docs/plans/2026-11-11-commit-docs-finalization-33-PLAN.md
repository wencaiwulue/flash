---
commit: c771f05fa4971b361de9a9b1dbfc880972154583
title: "Finalize previous commit documentation"
date: 2026-11-11T11:15:03+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

要把 6b0ce9d 纳入文档链，并保留其特殊范围：它补的是祖父提交 b6bf982，而新 SPEC 的 Actual scope 因而应列出 b6bf982 两个文档，而非 5c5bc03 刚登记的 787b2dc。

- 以 5c5bc03 的 71 项索引为基线，确认 6b0ce9d 是本次目标祖父提交，并核对其自身的 b6bf982 四文件范围。

## 复用与兼容处理

### 复用现有实现

- 沿用现有 Markdown 双文件和双索引布局，复用格式而不复制 787b2dc 的 96283ae 内容。

### 兼容、迁移与生命周期

- 保留既有 b6bf982、787b2dc 条目及 self 的 changeId/spec/plan，新增路径命名沿用短 SHA 约定。

## 文件级实施步骤

### 1. 描述 6b0ce9d 规格

把 6b0ce9d 的身份与其为 b6bf982 建文档的历史范围分开书写。

涉及位置：`docs/specs/6b0ce9d-SPEC.md`

### 2. 描述 6b0ce9d 计划

建立同身份 PLAN，使用 Finalize 标题并保留验证与剩余工作的独立段落。

涉及位置：`docs/plans/6b0ce9d-PLAN.md`

### 3. 推进索引到 72

将 6b0ce9d 作为 787b2dc 后的新历史行，implemented 增一且不动其他两类计数。

涉及位置：`docs/INDEX.md`

### 4. 写入第 72 项状态

把 6b0ce9d 的完整 SHA 和新文件路径登记在 JSON self 对象之前。

涉及位置：`docs/status/index.json`

## 风险与处理

- 本提交与前后提交都增删 78/1 行，若只比对统计会漏掉 b6bf982 与 96283ae 的语义差别。

## 验收顺序

1. 读取 c771f05 版本中的四个路径，核对 6b0ce9d 全 SHA、b6bf982 范围、72/1/0 汇总及 self 末位。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 6b0ce9d 的 SPEC、PLAN 和两类索引注册已经加入，且未出现第五个变更文件。

### 未完成或后续工作

- 文档声明的命令没有输出存档，本记录不补造运行时或 CI 结论。
