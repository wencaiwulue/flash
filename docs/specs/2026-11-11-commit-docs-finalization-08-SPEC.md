---
commit: f251df9151d7a7c054fa662c4b50f0d09c1bf305
title: "固化 `80e6def` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `80e6def` 的历史文档

## 迁移对象

当前提交 f251df9（Finalize previous commit documentation records）为 `80e6def` 补写 SPEC/PLAN。直接父提交是 7ca78c1，但文档描述的对象是上述目标提交，不应把父提交、当前提交和目标提交混为同一身份。

目标实现范围：

- **80e6defe99a3ce09a3d2b4229458fed0fbde5dbc**（Finalize self record to previous SHA on next commit）：3 files changed, 22 insertions(+), 1 deletion(-)。代表路径：`docs/INDEX.md`、`docs/status/index.json`、`scripts/document-commits.ts`。

## 写入与索引设计

新增以下文件：

- `docs/specs/80e6def-SPEC.md`
- `docs/plans/80e6def-PLAN.md`

同时修改 `docs/INDEX.md` 和 `docs/status/index.json`，为每个目标提交登记 full SHA、subject、status 与两个路径。历史条目放在 self 前，self 继续表示当前工作；索引数量随新增历史记录更新，而不是只增加 Markdown 文件。

这是元数据迁移，不改变目标提交的产品实现，也不为当前提交虚构产品架构。

## 验收标准

- `80e6def-SPEC.md` 与 `80e6def-PLAN.md` 的 frontmatter 使用 80e6defe99a3ce09a3d2b4229458fed0fbde5dbc，正文范围对应上述 diff。
2. INDEX 和 JSON 中的 `80e6def` 各出现一次，链接与新增文件一致。
3. self 文件与 self 索引仍保留，历史计数与新增目标数量一致。
4. 除新增目标文档和两个索引外，没有产品源码变更。
