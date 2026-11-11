---
commit: 17c91967ada4424f164da8e2699e3ee90d587036
title: "Finalize self record for previous commit"
date: 2026-11-11T10:48:19+08:00
status: implemented
kind: metadata-migration
---

# Finalize self record for previous commit

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

直接父提交 c4e19cee451ce0a5a43e78475d40f2e079b350df 已为 587c466 建立 95 文件清单文档，INDEX 为 Implemented 41、Partial 1、Unimplemented 0；祖父提交 8117aaa81ba58bb7ddae1256712797880a6cdebd 的 HEAD 排除代码尚无对应 SPEC/PLAN。

本提交要把 8117aaa 的单行生成器变更记录为文档并注册，而不是继续描述直接父 c4e19ce；其范围只有 scripts/document-commits.ts 的 1 行新增和 1 行删除。

## 目标与非目标

### 目标

- 新建 8117aaa SPEC/PLAN，frontmatter 绑定其完整 SHA，Actual scope 只列生成器脚本。
- 在 INDEX 与 status JSON 中加入 8117aaa，将 Implemented 从 41 更新为 42。

### 非目标

- 不修改 HEAD 排除实现，也不为直接父 c4e19ce 或当前 17c9196 建文档。
- 不把 SPEC/PLAN 的测试、typecheck、build 和 CI 文字视为实际运行记录。

## 方案架构与数据流

被记录的生成器按 git log --reverse 得到正序历史，commits().slice(0, -1) 总是排除当时最新 HEAD；在 c4e19ce 为 HEAD 的位置会纳入 8117aaa，但并非永久排除固定 c4e19ce。

当前提交的四个路径则是纯元数据：8117aaa 的 SPEC 与 PLAN，加上 587c466 后、self 前的 INDEX 行和 JSON 对象；没有生成器源码变化。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/INDEX.md` | Implemented 41 到 42，加入 8117aaa。 |
| 变更 | `docs/plans/8117aaa-PLAN.md` | 新建 HEAD 排除提交的计划文档。 |
| 变更 | `docs/specs/8117aaa-SPEC.md` | 记录 8117aaa 单文件单行生成器变更。 |
| 变更 | `docs/status/index.json` | 新增 8117aaa 的机器可读条目。 |

## 关键决策与工程取舍

- SPEC 保存 1 file changed、1 insertion、1 deletion，脚本路径唯一；不能用 c4e19ce 的 169 行新增或 587c466 的 95 文件统计替代。
- 两个索引仅登记 8117aaa，三类计数成为 42/1/0；self 仍最后，既有 587c466 条目不重复插入。

### 备选方案与回溯分析

- 把 HEAD 排除写成固定过滤某个 SHA 会误解动态数组边界；把本提交对象设为直接父 c4e19ce 又会重复父提交已经完成的文档工作。

## 安全与协议边界

- 本提交不改可执行逻辑，只说明已有的历史遍历边界并添加元数据；没有权限、凭据或网络行为变化。

## 验收标准

- 8117aaa SPEC/PLAN 的身份、日期和 implemented 状态一致，SPEC 只列 scripts/document-commits.ts。
- INDEX 与 JSON 均新增 8117aaa，spec/plan 字段指向实际新文件，计数为 42/1/0。

## 实现状态与剩余范围

- 状态：**implemented**
- 直接父 c4e19ce 的文档留待后续提交；新 PLAN 仍使用概括性模板，未记录 HEAD 排除行为的实测输出。
