---
commit: c8338e1be21cdc792f1c69a5bf3c0094d3c29261
title: "固化 `fdffe9e` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `fdffe9e` 的实施步骤

## 1. 核对目标身份与实现范围

命令：

git show --stat fdffe9e872a6bdf9ef41623b532f512f1846ab3a

逐项目标确认完整 SHA、subject 和实际变更文件，防止把直接父提交 3c4b6f2 误写为文档对象。

## 2. 写入目标 SPEC 与 PLAN

为 fdffe9e872a6bdf9ef41623b532f512f1846ab3a 创建 `docs/specs/fdffe9e-SPEC.md` 和 `docs/plans/fdffe9e-PLAN.md`。frontmatter 使用该完整 SHA；正文只覆盖 4 files changed, 78 insertions(+), 1 deletion(-)，代表路径包括 `docs/INDEX.md`、`docs/plans/f5b097b-PLAN.md`、`docs/specs/f5b097b-SPEC.md`、`docs/status/index.json`。

SPEC 说明该目标提交的实际设计范围；PLAN 按目标 diff 列出文件级实施顺序。不要用当前 finalization 提交的主题替换目标实现内容。

## 3. 同步 INDEX 与 JSON

在 self 前为 `fdffe9e` 增加历史链接，并同步 `docs/status/index.json` 的 fullSha、date、subject、status、spec、plan 字段。按新增目标数量更新状态计数，保持 self 位于末尾。

## 4. 验收

test -f docs/specs/fdffe9e-SPEC.md
test -f docs/plans/fdffe9e-PLAN.md

用 JSON 解析确认 `fdffe9e` 各有一个对象，spec/plan 路径有效且 fullSha 与上述完整 SHA 一致；再检查 INDEX 链接、self 条目和文件清单。
