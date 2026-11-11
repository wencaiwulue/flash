---
commit: self
changeId: date-based-commit-docs
title: "Use date and feature names for commit documentation"
status: implemented
kind: metadata-migration
---

# Use date and feature names for commit documentation

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

历史 SPEC/PLAN 以七位 SHA 命名，结构化记录还包含执行证据字段，渲染器输出验证证据和验证顺序。

需要原子迁移全部记录、输出路径和索引，同时保留设计事实、文件级步骤及验收标准。

## 目标与非目标

### 目标

- 实现日期加功能命名，清理历史执行结果，并迁移所有生成物和链接。

### 非目标

- 不修改产品源码，不重写 Git 历史，不重新执行历史验证。

## 方案架构与数据流

纯命名模块根据 commit date、显式 slug 和 topo 顺序生成路径；记录经校验后由渲染器统一输出 SPEC、PLAN 和索引。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `scripts/commit-docs/naming.ts` | 纯命名与冲突检测。 |
| 变更 | `scripts/commit-docs/schema.ts` | slug 与验收序列契约。 |
| 变更 | `scripts/commit-docs/validate.ts` | 命名、遗留字段与执行结果检查。 |
| 变更 | `scripts/commit-docs/render.ts` | 新路径与验收渲染。 |
| 测试 | `tests/commitDocs.test.ts` | 命名和契约回归。 |

## 关键决策与工程取舍

- 完整 SHA 仍是身份；同日同功能使用序号；writer 与 checker 分离；旧路径在新清单完整后显式删除。

### 备选方案与回溯分析

- 继续用 SHA 文件名不满足可读性；从标题自动推断 slug 或设计正文不可验证。

## 安全与协议边界

- Git 操作只读历史；旧文件删除仅针对已跟踪的七位 SHA 生成物，不处理凭据或产品协议。

## 验收标准

- 全部当前 commit 与 self 均有新命名文档，索引一致、无旧路径、无执行证据、重复生成无差异。

## 实现状态与剩余范围

- 状态：**implemented**
- 无
