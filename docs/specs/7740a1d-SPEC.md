---
commit: 7740a1d28b70629f41d49116a8e6007eb46c72aa
title: "Finalize self documentation for current commit"
date: 2026-11-11T10:51:16+08:00
status: implemented
kind: metadata-migration
---

# Finalize self documentation for current commit

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

直接父提交 f210ce9c2dc51a30f98514628b07538a969f21aa 已为 c4e19ce 建文档，INDEX 为 Implemented 43、Partial 1、Unimplemented 0；祖父提交 17c91967ada4424f164da8e2699e3ee90d587036 的 SPEC/PLAN 尚未生成。

本次实际定稿 17c9196，需要保存其为 8117aaa 建文档的 75 行新增范围；不能把直接父 f210ce9 的 78 行统计或 c4e19ce 文档路径带入新 SPEC。

## 目标与非目标

### 目标

- 新建 17c9196 SPEC/PLAN，Actual scope 精确列出 8117aaa 文档对及两个索引。
- 为 17c9196 增加 INDEX/status 注册，将 Implemented 从 43 更新到 44。

### 非目标

- 不处理直接父 f210ce9 或当前 7740a1d 的文档，也不修改 HEAD 排除代码。
- 不增加验证日志，不把 PLAN 中的测试与 CI 序列当成已通过。

## 方案架构与数据流

17c9196 SPEC 将四个历史路径和 75 insertions、1 deletion 固化，清单中的 8117aaa-SPEC/PLAN 标识了它与其他四文件文档提交的区别。

当前提交自身仍是四个元数据路径：17c9196 的 SPEC/PLAN，加上 c4e19ce 后、self 前的 INDEX 行和 JSON 对象；生成器 blob 没有变化。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/INDEX.md` | Implemented 43 到 44，加入 17c9196。 |
| 变更 | `docs/plans/17c9196-PLAN.md` | 新建 17c9196 的计划文档。 |
| 变更 | `docs/specs/17c9196-SPEC.md` | 记录 17c9196 为 8117aaa 建文档的 75/1 范围。 |
| 变更 | `docs/status/index.json` | 注册 17c9196 的机器可读元数据。 |

## 关键决策与工程取舍

- 新文档 frontmatter 使用 17c91967ada4424f164da8e2699e3ee90d587036，而非直接父 f210ce9；统计采用 75/1。
- INDEX 三类计数变为 44/1/0，JSON 只新增 17c9196 对象，并保持 fullSha、shortSha、date、subject、status、spec、plan 字段顺序。

### 备选方案与回溯分析

- 仅按相同标题和四文件结构复制相邻记录会留下 78/1 或 c4e19ce 路径；把动态 HEAD 排除当作本提交新功能也会超出实际 diff。

## 安全与协议边界

- 变更仅为历史说明和链接注册，没有新增可执行代码、认证材料或权限行为。

## 验收标准

- SPEC 记录 4 files、75 insertions、1 deletion，并同时列出 8117aaa-SPEC 与 8117aaa-PLAN。
- PLAN 与 SPEC 的 17c9196 身份一致，INDEX/JSON 链接可对应本次新文件，self 仍在末尾。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | 新 SPEC 保存 17c9196 的 4 文件、75 行新增和 1 行删除统计。 | `docs/specs/17c9196-SPEC.md`，符号 `- Diff statistics: 4 files changed, 75 insertions(+), 1 deletion(-)`，revision `commit` |
| diff-observed | 新 PLAN 以 17c9196 完整 SHA 建立并含实现步骤小节。 | `docs/plans/17c9196-PLAN.md`，符号 `commit: 17c91967ada4424f164da8e2699e3ee90d587036`，revision `commit` |
| diff-observed | INDEX 新增 17c9196 行，Implemented 从 43 到 44。 | `docs/INDEX.md`，符号 `- Implemented: 44`，revision `commit` |
| diff-observed | status JSON 在 self 前加入 17c9196 及其 SPEC/PLAN 路径。 | `docs/status/index.json`，符号 `"fullSha": "17c91967ada4424f164da8e2699e3ee90d587036"`，revision `commit` |
| not-recorded | 文档中的 bun test、typecheck、build 和 CI 仅为计划文本，未附执行证据。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**implemented**
- f210ce9 的文档由后续提交补齐；17c9196 的 PLAN 仍是概括模板，没有新的行为验证记录。
