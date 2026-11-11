---
commit: 80e6defe99a3ce09a3d2b4229458fed0fbde5dbc
title: "Finalize self record to previous SHA on next commit"
date: 2026-11-11T10:56:11+08:00
status: implemented
kind: metadata-migration
---

# Finalize self record to previous SHA on next commit

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交 63e138f4eb8ea207a1aeb0806e060275ac55b4a3 留下 Implemented 46、Partial 1、Unimplemented 0，索引止于 7740a1d 和 self。生成器已经排除 HEAD，但尚无 previousHead 分支，fe3c177 与 63e138f 的 SPEC/PLAN 均未落盘。

需要登记尚未建文件的 fe3c177，并让生成器额外输出 previous HEAD 的 SPEC/PLAN；文档文件生成与索引注册在此 diff 中并不同步。

## 目标与非目标

### 目标

- 在 INDEX 和 status/index.json 的 self 前注册 fe3c177 及其两个预期文档路径。
- 为 commits().at(-2) 增加 SPEC/PLAN 输出，同时保留 HEAD 排除主循环。

### 非目标

- 本提交不直接新增 fe3c177、63e138f 或 80e6def 的 Markdown 文档。
- 不把 previousHead 代码能力写成已生成文件，也不补测试或记录 CI 结果。

## 方案架构与数据流

主循环仍以 commits().slice(0, -1) 生成历史文档、索引和计数；新增 previousHead 逻辑位于该循环之后，只向 documents Map 写入两个路径。

previousHead 分支调用 specFor/planFor，但不追加 indexRows、jsonCommits 或 counts；fe3c177 的两个索引项则在本提交实际落盘，63e138f 的文件并未随代码一并出现。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/INDEX.md` | Implemented 从 46 调到 47，并在 self 前加入 fe3c177。 |
| 变更 | `docs/status/index.json` | 在 self 前新增 fe3c177 的机器可读条目。 |
| 变更 | `scripts/document-commits.ts` | 新增 at(-2) previousHead 的 SPEC/PLAN Map 输出。 |

## 关键决策与工程取舍

- previousHead 明确定义为正序提交数组的倒数第二项；按本提交历史位置它对应 63e138f，而不是当前 HEAD 80e6def。
- INDEX 仅新增 fe3c177 行，Implemented 46 增至 47；Partial 1、Unimplemented 0 不变，机器索引使用同一 fullSha 和 spec/plan 路径。

### 备选方案与回溯分析

- 把 previousHead 也塞回主循环会混淆“排除 HEAD”和“补前一 HEAD”两种边界；本实现采用独立 Map 写入，但也留下索引与文件可分离的状态。

## 安全与协议边界

- 变更只处理 Git 提交元数据与文档 Map，不增加外部输入、凭据处理或执行权限。

## 验收标准

- at(-2) 仅在存在 previousHead 时设置 SPEC/PLAN，空历史不会访问不存在的对象。
- fe3c177 的 INDEX 行与 JSON 对象位于 self 前，状态为 implemented，链接字段彼此一致。
- previousHead 分支不改变状态计数，且本提交实际变更路径仅为两个索引和生成器。

## 实现状态与剩余范围

- 状态：**implemented**
- fe3c177 的索引已先于文件出现，63e138f 的文档和索引仍待后续补齐；80e6def 自身也未在此提交建文档。
