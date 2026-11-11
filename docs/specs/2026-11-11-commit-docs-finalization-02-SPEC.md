---
commit: 17c91967ada4424f164da8e2699e3ee90d587036
title: "固化 `8117aaa` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `8117aaa` 的历史文档

## 迁移对象

当前提交 17c9196（Finalize self record for previous commit）为 `8117aaa` 补写 SPEC/PLAN。直接父提交是 c4e19ce，但文档描述的对象是上述目标提交，不应把父提交、当前提交和目标提交混为同一身份。

目标实现范围：

- **8117aaa81ba58bb7ddae1256712797880a6cdebd**（Finalize self record for current commit）：1 file changed, 1 insertion(+), 1 deletion(-)。代表路径：`scripts/document-commits.ts`。

## 写入与索引设计

新增以下文件：

- `docs/specs/8117aaa-SPEC.md`
- `docs/plans/8117aaa-PLAN.md`

同时修改 `docs/INDEX.md` 和 `docs/status/index.json`，为每个目标提交登记 full SHA、subject、status 与两个路径。历史条目放在 self 前，self 继续表示当前工作；索引数量随新增历史记录更新，而不是只增加 Markdown 文件。

这是元数据迁移，不改变目标提交的产品实现，也不为当前提交虚构产品架构。

## 验收标准

- `8117aaa-SPEC.md` 与 `8117aaa-PLAN.md` 的 frontmatter 使用 8117aaa81ba58bb7ddae1256712797880a6cdebd，正文范围对应上述 diff。
2. INDEX 和 JSON 中的 `8117aaa` 各出现一次，链接与新增文件一致。
3. self 文件与 self 索引仍保留，历史计数与新增目标数量一致。
4. 除新增目标文档和两个索引外，没有产品源码变更。
