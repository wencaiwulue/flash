---
commit: c4e19cee451ce0a5a43e78475d40f2e079b350df
title: "固化 `587c466` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `587c466` 的历史文档

## 迁移对象

当前提交 c4e19ce（Finalize previous self documentation）为 `587c466` 补写 SPEC/PLAN。直接父提交是 8117aaa，但文档描述的对象是上述目标提交，不应把父提交、当前提交和目标提交混为同一身份。

目标实现范围：

- **587c466f7e28e4cb59b0c4522857a7110e7b152a**（Document every commit with specs and plans）：95 files changed, 6620 insertions(+)。代表路径：`.github/workflows/ci.yml`、`docs/COMMIT_DOCS.md`、`docs/INDEX.md`、`docs/RELEASE.md`。

## 写入与索引设计

新增以下文件：

- `docs/specs/587c466-SPEC.md`
- `docs/plans/587c466-PLAN.md`

同时修改 `docs/INDEX.md` 和 `docs/status/index.json`，为每个目标提交登记 full SHA、subject、status 与两个路径。历史条目放在 self 前，self 继续表示当前工作；索引数量随新增历史记录更新，而不是只增加 Markdown 文件。

这是元数据迁移，不改变目标提交的产品实现，也不为当前提交虚构产品架构。

## 验收标准

- `587c466-SPEC.md` 与 `587c466-PLAN.md` 的 frontmatter 使用 587c466f7e28e4cb59b0c4522857a7110e7b152a，正文范围对应上述 diff。
2. INDEX 和 JSON 中的 `587c466` 各出现一次，链接与新增文件一致。
3. self 文件与 self 索引仍保留，历史计数与新增目标数量一致。
4. 除新增目标文档和两个索引外，没有产品源码变更。
