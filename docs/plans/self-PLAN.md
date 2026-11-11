---
commit: self
changeId: date-based-commit-docs
title: "Use date and feature names for commit documentation"
status: implemented
kind: metadata-migration
---

# 实施计划：Use date and feature names for commit documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要原子迁移全部记录、输出路径和索引，同时保留设计事实、文件级步骤及验收标准。

- 已批准设计存在，当前 HEAD 和全部历史可读。

## 复用与兼容处理

### 复用现有实现

- 复用现有 Git、加载、校验、渲染和 head/next 入口。

### 兼容、迁移与生命周期

- 记录身份、head/next 模式和 self 文件位置保持兼容。

## 文件级实施步骤

### 1. 实现命名与数据契约

先测试命名，再调整 schema、validate 和 render。

涉及位置：`scripts/commit-docs/naming.ts`、`scripts/commit-docs/schema.ts`、`scripts/commit-docs/validate.ts`、`scripts/commit-docs/render.ts`

### 2. 迁移全部结构化记录

补齐当前 HEAD 记录，添加显式 slug，删除证据字段并清理历史执行陈述。

涉及位置：`scripts/commit-docs/records`

### 3. 迁移生成物和链接

生成日期加功能文档，更新索引和政策，再删除七位 SHA 旧文件。

涉及位置：`docs/specs`、`docs/plans`、`docs/INDEX.md`、`docs/status/index.json`

## 风险与处理

- 同日冲突、动态 HEAD 遗漏和误删新文件必须通过路径清单与精确七位 SHA 匹配控制。

## 验收顺序

1. 先运行命名与契约测试，再检查 next 全量清单、重复生成、全量测试、typecheck、build 和提交后的 head 模式。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 日期加功能命名、冲突检测和结构化记录契约已经落地。
- 全部历史记录、生成文档、索引、政策和模板已经迁移。
- 旧七位 SHA 生成物已经移除，self 继续承接当前提交。

### 未完成或后续工作

- 无
