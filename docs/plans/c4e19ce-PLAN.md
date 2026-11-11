---
commit: c4e19cee451ce0a5a43e78475d40f2e079b350df
title: "Finalize previous self documentation"
date: 2026-11-11T10:45:50+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Finalize previous self documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

本次实际补齐的是 587c466，而非直接父 8117aaa；其初始文档体系涉及 95 个路径，若只登记短 SHA 或省略实际清单，无法准确保存这次元数据迁移的范围。

- 区分直接父 8117aaa 与实际文档对象 587c466，并读取后者完整的 95 文件 diff。

## 复用与兼容处理

### 复用现有实现

- 沿用已有 frontmatter、INDEX 表格和 status JSON 结构，不改动 self 的字段。

### 兼容、迁移与生命周期

- 既有 beee034 及更早条目不重排，self 仍收尾；新增链接使用既有相对路径约定。

## 文件级实施步骤

### 1. 保存初始化 SPEC

写入 587c466 身份、95 文件统计和逐路径清单，覆盖脚本、CI 与历史文档。

涉及位置：`docs/specs/587c466-SPEC.md`

### 2. 保存初始化 PLAN

以同一 frontmatter 新建计划，保留目标、步骤、风险、验证和完成小节。

涉及位置：`docs/plans/587c466-PLAN.md`

### 3. 增加人类索引

在 beee034 与 self 之间登记 587c466，只递增 Implemented。

涉及位置：`docs/INDEX.md`

### 4. 增加机器索引

在 self 前写入完整 SHA、原日期、implemented 和两个新路径。

涉及位置：`docs/status/index.json`

## 风险与处理

- 长清单容易被缩成普通四文件描述，或直接父与祖父身份错位；两种错误都会破坏历史可追溯性。

## 验证顺序

1. 核对 SPEC 清单与 587c466 diff，解析 JSON 并检查 INDEX 计数和链接；验证散文不作为执行证据。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 587c466 的大范围 SPEC、对应 PLAN 及两个索引项已完整落盘。

### 未完成或后续工作

- 本提交没有记录文档生成、测试或 CI 的实际运行轨迹。
