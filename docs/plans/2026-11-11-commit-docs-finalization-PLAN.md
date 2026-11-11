---
commit: 8117aaa81ba58bb7ddae1256712797880a6cdebd
title: "Finalize self record for current commit"
date: 2026-11-11T10:43:47+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize self record for current commit

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

最新 HEAD 也进入逐提交文档、索引行和状态计数，提交生成结果后产生的新 SHA 不会与已写入的 HEAD 身份一致，需要把当前 HEAD 排除在历史记录循环之外。

- 确认 commits() 的 --reverse 顺序和当前 HEAD 位于数组末尾，并区分历史提交与 self。

## 复用与兼容处理

### 复用现有实现

- 沿用 commits、specFor、planFor、statusFor 及现有 self 生成函数，不新增文档抽象。

### 兼容、迁移与生命周期

- 除最新 HEAD 外，历史提交仍按原顺序生成；已有 self 路径和 JSON 字段保持不变。

## 文件级实施步骤

### 1. 截断最新历史项

在唯一主循环的数组来源上移除末尾 HEAD，使该提交的全部历史产物和计数同步跳过。

涉及位置：`scripts/document-commits.ts`

### 2. 保留 self 分支

不移动循环后的 self 文件与索引注册，维持其独立身份。

涉及位置：`scripts/document-commits.ts`

## 风险与处理

- 排除 HEAD 后，新提交自身不会立即获得历史文档，需要后续提交补齐；索引不能提前引用尚不存在的文件。

## 验收顺序

1. 可从源码确认数组截断位置，并分别检查主循环和 self 分支；本提交未保存实际生成或测试结果。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- HEAD 排除已落在统一历史循环，diff 未触碰其他生成逻辑。

### 未完成或后续工作

- 没有随提交记录运行生成器、测试、typecheck、build 或 CI 的结果。
