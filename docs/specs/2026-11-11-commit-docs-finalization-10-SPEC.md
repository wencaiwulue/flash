---
commit: f251df9151d7a7c054fa662c4b50f0d09c1bf305
title: "Finalize previous commit documentation records"
date: 2026-11-11T10:59:48+08:00
status: implemented
kind: metadata-migration
---

# Finalize previous commit documentation records

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

直接父提交 7ca78c1a18a7f05e1740f701b256079bb4cc2c2e 已补齐 fe3c177 与 63e138f 两对文档，INDEX 为 Implemented 48、Partial 1、Unimplemented 0；祖父提交 80e6defe99a3ce09a3d2b4229458fed0fbde5dbc 尚无自己的 SPEC/PLAN。

需要为 80e6def 建文档，准确保存其两个索引加生成器的三文件、22 行新增范围，并解释 previousHead 只生成文档而主循环负责索引的分工。

## 目标与非目标

### 目标

- 新建 80e6def SPEC/PLAN，Actual scope 列出 INDEX、status JSON 和 scripts/document-commits.ts。
- 在 self 前注册 80e6def，将 Implemented 从 48 增至 49，其余状态计数不变。

### 非目标

- 不修改 previousHead 代码，也不补直接父 7ca78c1 或当前 f251df9 的文档。
- 不把生成器行为描述当作本提交再次执行生成器的证据，只列出验收条件。

## 方案架构与数据流

80e6def 的主循环用 slice(0, -1) 排除 HEAD并负责计数、INDEX 行和 JSON；其后 previousHead = commits().at(-2) 只通过 documents.set 输出前一 HEAD 的 SPEC/PLAN，不直接注册索引。

在生成当前变更前的历史位置，HEAD 为 7ca78c1、at(-2) 为 80e6def；提交后重跑则 at(-2) 会改变，不能将该表达式解释为永久指向 80e6def。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/INDEX.md` | Implemented 48 到 49，加入 80e6def。 |
| 变更 | `docs/plans/80e6def-PLAN.md` | 新建 previousHead 变更提交的计划。 |
| 变更 | `docs/specs/80e6def-SPEC.md` | 记录 80e6def 三文件、22/1 的实际范围。 |
| 变更 | `docs/status/index.json` | 注册 80e6def 的机器可读条目。 |

## 关键决策与工程取舍

- 新 SPEC 使用 80e6def 自身的 3 files、22 insertions、1 deletion，而不是直接父 7ca78c1 的六文件、145 行新增。
- 80e6def 的 INDEX/JSON 注册在本提交各新增一次，位于 63e138f 后、self 前；previousHead 代码不追加索引，因此不会带来额外计数。

### 备选方案与回溯分析

- 把 previousHead 当成完整注册循环会错误推导计数和 JSON 副作用；把本提交对象设为直接父 7ca78c1 又会漏掉其实际三文件生成器范围。

## 安全与协议边界

- 本提交仅添加文档和索引，未改变生成器、CI 或运行时代码；历史代码说明不构成新的权限或执行行为。

## 验收标准

- 80e6def SPEC/PLAN 使用相同 fullSha、标题、日期和 implemented，SPEC 统计为 22/1。
- INDEX 为 49/1/0，JSON 的 spec/plan 字段指向新文件；previousHead 不被描述为额外索引来源。

## 实现状态与剩余范围

- 状态：**implemented**
- 直接父 7ca78c1 的文档仍未建立；80e6def 的 PLAN 继续使用概括模板，previousHead 行为没有随附运行日志。
