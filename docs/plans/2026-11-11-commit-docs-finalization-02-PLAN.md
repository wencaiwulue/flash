---
commit: 17c91967ada4424f164da8e2699e3ee90d587036
title: "固化 `8117aaa` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `8117aaa` 的实施步骤

## 1. 核对目标身份与实现范围

命令：

git show --stat 8117aaa81ba58bb7ddae1256712797880a6cdebd

逐项目标确认完整 SHA、subject 和实际变更文件，防止把直接父提交 c4e19ce 误写为文档对象。

## 2. 写入目标 SPEC 与 PLAN

为 8117aaa81ba58bb7ddae1256712797880a6cdebd 创建 `docs/specs/8117aaa-SPEC.md` 和 `docs/plans/8117aaa-PLAN.md`。frontmatter 使用该完整 SHA；正文只覆盖 1 file changed, 1 insertion(+), 1 deletion(-)，代表路径包括 `scripts/document-commits.ts`。

SPEC 说明该目标提交的实际设计范围；PLAN 按目标 diff 列出文件级实施顺序。不要用当前 finalization 提交的主题替换目标实现内容。

## 3. 同步 INDEX 与 JSON

在 self 前为 `8117aaa` 增加历史链接，并同步 `docs/status/index.json` 的 fullSha、date、subject、status、spec、plan 字段。按新增目标数量更新状态计数，保持 self 位于末尾。

## 4. 验收

test -f docs/specs/8117aaa-SPEC.md
test -f docs/plans/8117aaa-PLAN.md

用 JSON 解析确认 `8117aaa` 各有一个对象，spec/plan 路径有效且 fullSha 与上述完整 SHA 一致；再检查 INDEX 链接、self 条目和文件清单。
