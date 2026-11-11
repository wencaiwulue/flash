---
commit: 5c5bc03abc666d111ae5e4227224884bbaafd340
title: "固化 `787b2dc` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `787b2dc` 的实施步骤

## 1. 核对目标身份与实现范围

命令：

git show --stat 787b2dcef6629be82036283cc709384b56e6d981

逐项目标确认完整 SHA、subject 和实际变更文件，防止把直接父提交 6b0ce9d 误写为文档对象。

## 2. 写入目标 SPEC 与 PLAN

为 787b2dcef6629be82036283cc709384b56e6d981 创建 `docs/specs/787b2dc-SPEC.md` 和 `docs/plans/787b2dc-PLAN.md`。frontmatter 使用该完整 SHA；正文只覆盖 4 files changed, 78 insertions(+), 1 deletion(-)，代表路径包括 `docs/INDEX.md`、`docs/plans/96283ae-PLAN.md`、`docs/specs/96283ae-SPEC.md`、`docs/status/index.json`。

SPEC 说明该目标提交的实际设计范围；PLAN 按目标 diff 列出文件级实施顺序。不要用当前 finalization 提交的主题替换目标实现内容。

## 3. 同步 INDEX 与 JSON

在 self 前为 `787b2dc` 增加历史链接，并同步 `docs/status/index.json` 的 fullSha、date、subject、status、spec、plan 字段。按新增目标数量更新状态计数，保持 self 位于末尾。

## 4. 验收

test -f docs/specs/787b2dc-SPEC.md
test -f docs/plans/787b2dc-PLAN.md

用 JSON 解析确认 `787b2dc` 各有一个对象，spec/plan 路径有效且 fullSha 与上述完整 SHA 一致；再检查 INDEX 链接、self 条目和文件清单。
