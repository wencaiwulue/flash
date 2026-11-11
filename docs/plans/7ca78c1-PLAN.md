---
commit: 7ca78c1a18a7f05e1740f701b256079bb4cc2c2e
title: "Complete all commit documentation records"
date: 2026-11-11T10:57:38+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Complete all commit documentation records

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

同一次提交要处理两种历史欠账：为已登记的 fe3c177 补上断链目标，为未登记的 63e138f 同时建立文档与索引，不能把两个文档对误算成两个新增索引状态。

- 分别检查 80e6def 父版本的文件树与两个索引，区分 fe3c177 的缺文件和 63e138f 的全缺状态。

## 复用与兼容处理

### 复用现有实现

- 复用父版本已有的 fe3c177 索引注册，并沿用 SPEC/PLAN frontmatter 与生成文档小节。

### 兼容、迁移与生命周期

- 既有 fe3c177 链接文本与 JSON 路径不变，新文件使其变得可解析；其他历史条目顺序不受影响。

## 文件级实施步骤

### 1. 修复 fe3c177 文档断链

新增其 SPEC/PLAN，并在 SPEC 中保留 f210ce9 文档对的实际历史范围。

涉及位置：`docs/specs/fe3c177-SPEC.md`、`docs/plans/fe3c177-PLAN.md`

### 2. 建立 63e138f 文档对

新增绑定 63e138f 身份的 SPEC/PLAN，Actual scope 指向 7740a1d 文档对。

涉及位置：`docs/specs/63e138f-SPEC.md`、`docs/plans/63e138f-PLAN.md`

### 3. 单量更新人类索引

仅添加 63e138f 行，保留已有 fe3c177 行，Implemented 只加一。

涉及位置：`docs/INDEX.md`

### 4. 单量更新机器索引

在 self 前只插入 63e138f 对象，不重复写入 fe3c177。

涉及位置：`docs/status/index.json`

## 风险与处理

- 最大风险是把新文件数量等同于新增索引数量，或把两对文档错误归到直接父 80e6def。

## 验证顺序

1. 逐个解析四份 frontmatter，对照两个历史提交的 diff 路径，并比较父/当前 INDEX 与 JSON 的新增项。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 两对历史文档和 63e138f 的两个索引条目已按实际差异落盘，fe3c177 未重复注册。

### 未完成或后续工作

- 没有可追溯的生成、测试、typecheck、build 或 CI 执行结果。
