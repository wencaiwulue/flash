---
commit: f5b097b742b8e9d68acce71c9b2fa38e19c6088a
title: "Complete previous commit documentation"
date: 2026-11-11T11:18:59+08:00
status: implemented
kind: metadata-migration
---

# 实施计划：Complete previous commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

本提交应补登记 8a248e3，并在新 SPEC 中还原它为 a4edc60 创建文档的四路径范围。目标与当前提交同为 Complete 标题，必须依赖完整 SHA、日期及内层 a4edc60 路径区分。

- 以 4329cd8 的 78 项汇总为基线，读取 8a248e3 metadata，并核对其历史 diff 中的 a4edc60 双文档。

## 复用与兼容处理

### 复用现有实现

- 沿用四文件元数据格式和 self 尾部约定，重新填写 8a248e3 身份与 a4edc60 范围。

### 兼容、迁移与生命周期

- 保留此前 78 个 implemented 项、Partial/Unimplemented 计数和 self 的全部字段，新增路径遵循现有约定。

## 文件级实施步骤

### 1. 编写 8a248e3 规格

将目标完整身份与 a4edc60 两份历史文档范围写入新 SPEC。

涉及位置：`docs/specs/8a248e3-SPEC.md`

### 2. 编写 8a248e3 计划

用目标自身的 Complete 标题和 full SHA 建立 PLAN，保留未执行验证的边界。

涉及位置：`docs/plans/8a248e3-PLAN.md`

### 3. 完成第 79 项人工索引

在 e0cbbe1 后加入 8a248e3 双链接行，将 implemented 更新为 79。

涉及位置：`docs/INDEX.md`

### 4. 完成对应机器索引

把 8a248e3 的日期、主题、完整 SHA 和两项路径登记到 self 前。

涉及位置：`docs/status/index.json`

## 风险与处理

- 相同 Complete 标题和 78 增 1 删统计不能用于识别目标，必须依靠 8a248e3 full SHA 与 a4edc60 范围。

## 验收顺序

1. 在 f5b097b 版本比对 frontmatter、a4edc60 清单、79/1/0 汇总、JSON 新对象和 self 末位，并核对四文件 diff。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 8a248e3 的 SPEC、PLAN、INDEX 行及 status 对象全部落盘，self 未改变。

### 未完成或后续工作

- 没有真实测试或 CI 执行记录，文档中的检查清单仍待独立验证。
