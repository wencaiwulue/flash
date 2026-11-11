---
commit: 7ca78c1a18a7f05e1740f701b256079bb4cc2c2e
title: "Complete all commit documentation records"
date: 2026-11-11T10:57:38+08:00
status: implemented
kind: metadata-migration
---

# Complete all commit documentation records

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

直接父提交 80e6defe99a3ce09a3d2b4229458fed0fbde5dbc 的 INDEX 已有 fe3c177，Implemented 为 47，但 fe3c177 的 SPEC/PLAN 尚不存在；63e138f 则连文档和两个索引条目都缺失。

同一次提交要处理两种历史欠账：为已登记的 fe3c177 补上断链目标，为未登记的 63e138f 同时建立文档与索引，不能把两个文档对误算成两个新增索引状态。

## 目标与非目标

### 目标

- 新建 fe3c177 与 63e138f 两对 SPEC/PLAN，各自 frontmatter 绑定完整历史 SHA。
- 只补 63e138f 的 INDEX/status 条目，复用 80e6def 已有的 fe3c177 注册。

### 非目标

- 不修改 scripts/document-commits.ts、checker、测试或 CI 配置。
- 不把生成 PLAN 中的验证命令和完成声明当作实际执行证据，也不补写 80e6def 的文档。

## 方案架构与数据流

六个变更路径分为两层：四个新 Markdown 文件分别描述 fe3c177 和 63e138f；INDEX 与 status JSON 只新增 63e138f，因为 fe3c177 的注册已在父版本存在。

两份 SPEC 都记录各自历史提交的四文件、78 行新增和 1 行删除范围：fe3c177 指向 f210ce9 文档对，63e138f 指向 7740a1d 文档对。两份 PLAN 保留生成模板的目标、步骤、风险、验证和完成小节。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/INDEX.md` | 只为 63e138f 增加入口，Implemented 47 到 48。 |
| 变更 | `docs/plans/63e138f-PLAN.md` | 新建 63e138f 的计划文档。 |
| 变更 | `docs/plans/fe3c177-PLAN.md` | 补建已被索引引用的 fe3c177 计划。 |
| 变更 | `docs/specs/63e138f-SPEC.md` | 记录 63e138f 为 7740a1d 补文档的四文件范围。 |
| 变更 | `docs/specs/fe3c177-SPEC.md` | 记录 fe3c177 为 f210ce9 补文档的四文件范围。 |
| 变更 | `docs/status/index.json` | 只新增 63e138f 的完整状态和文档路径。 |

## 关键决策与工程取舍

- fe3c177 只补文件、不重复插入索引；63e138f 的两个新条目放在 self 前，Implemented 从 47 到 48，Partial 1 与 Unimplemented 0 不动。
- 历史对象不按直接父提交收缩：本提交直接父是 80e6def，但实际落盘对象是更早的 fe3c177 和 63e138f，记录必须保持这三层身份清晰。

### 备选方案与回溯分析

- 若机械地为每个新 SPEC/PLAN 都新增索引，会重复登记 fe3c177 并把计数写成 49；若只处理直接父提交，又会漏掉本 diff 实际补齐的两对历史文件。

## 安全与协议边界

- 全部变更都是文档与提交元数据，没有可执行产品逻辑、凭据或权限边界调整。

## 验收标准

- 四个新文件分别以 fe3c177、63e138f 的 fullSha、标题、日期和 implemented 状态作为 frontmatter。
- 两份 Actual scope 的路径分别指向 f210ce9 与 7740a1d 的文档对，不能互换。
- INDEX/JSON 只新增 63e138f，fe3c177 的既有注册现在能对应实际新文件，self 仍在末尾。

## 实现状态与剩余范围

- 状态：**implemented**
- 生成的 PLAN 内容仍是通用模板，未保存实际验证轨迹；直接父 80e6def 的 SPEC/PLAN 留待下一提交。
