---
commit: b6bf9822536793efc08cd9ce4d94f1c066530d1c
title: "固化 `6c3c1e4` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `6c3c1e4` 的历史文档

## 迁移对象

当前提交 b6bf982（Finalize documentation for previous commit）为 `6c3c1e4` 补写 SPEC/PLAN。直接父提交是 96283ae，但文档描述的对象是上述目标提交，不应把父提交、当前提交和目标提交混为同一身份。

目标实现范围：

- **6c3c1e4d3cdd8b1b8279c023575fb7a37e94a14c**（Finalize documentation for previous commit）：4 files changed, 78 insertions(+), 1 deletion(-)。代表路径：`docs/INDEX.md`、`docs/plans/0dabf46-PLAN.md`、`docs/specs/0dabf46-SPEC.md`、`docs/status/index.json`。

## 写入与索引设计

新增以下文件：

- `docs/specs/6c3c1e4-SPEC.md`
- `docs/plans/6c3c1e4-PLAN.md`

同时修改 `docs/INDEX.md` 和 `docs/status/index.json`，为每个目标提交登记 full SHA、subject、status 与两个路径。历史条目放在 self 前，self 继续表示当前工作；索引数量随新增历史记录更新，而不是只增加 Markdown 文件。

这是元数据迁移，不改变目标提交的产品实现，也不为当前提交虚构产品架构。

## 验收标准

- `6c3c1e4-SPEC.md` 与 `6c3c1e4-PLAN.md` 的 frontmatter 使用 6c3c1e4d3cdd8b1b8279c023575fb7a37e94a14c，正文范围对应上述 diff。
2. INDEX 和 JSON 中的 `6c3c1e4` 各出现一次，链接与新增文件一致。
3. self 文件与 self 索引仍保留，历史计数与新增目标数量一致。
4. 除新增目标文档和两个索引外，没有产品源码变更。
