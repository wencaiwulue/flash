---
commit: 80e6defe99a3ce09a3d2b4229458fed0fbde5dbc
title: "Finalize self record to previous SHA on next commit"
date: 2026-11-11T10:56:11+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize self record to previous SHA on next commit

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要登记尚未建文件的 fe3c177，并让生成器额外输出 previous HEAD 的 SPEC/PLAN；文档文件生成与索引注册在此 diff 中并不同步。

- 核对父版本索引尚无 fe3c177，确认正序 commits 数组中 HEAD 与 previous HEAD 的位置。

## 复用与兼容处理

### 复用现有实现

- 复用 specFor、planFor 和 documents Map；索引条目沿用现有 fullSha、status、spec、plan 字段。

### 兼容、迁移与生命周期

- 既有 HEAD 排除与 self 末尾位置不变；新增 previousHead 写操作不声明新的索引字段。

## 文件级实施步骤

### 1. 输出前一 HEAD 文档

在主循环后读取 at(-2)，存在时只生成该提交的 SPEC 和 PLAN 内容。

涉及位置：`scripts/document-commits.ts`

### 2. 登记 fe3c177 人类入口

在 self 前增加文档链接行，并只递增 Implemented 计数。

涉及位置：`docs/INDEX.md`

### 3. 登记 fe3c177 机器入口

写入完整身份、implemented 状态及同一对 SPEC/PLAN 路径。

涉及位置：`docs/status/index.json`

## 风险与处理

- previousHead 文件输出没有同步索引副作用，而 fe3c177 索引又先于 Markdown 落盘，短暂断链必须如实保留。

## 验收顺序

1. 逐项比较代码分支和实际 diff，并核对两个索引中的 fe3c177；不能由源码推导执行成功。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- previousHead 代码与 fe3c177 双重索引登记已进入版本树，三项变更均可直接观察。

### 未完成或后续工作

- 本提交未落盘任何新增历史 SPEC/PLAN，也没有生成器运行日志或自动化验证记录。
