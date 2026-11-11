---
commit: 55f7c7e66db7653d2afaa546162a6dc486c547d7
title: "固化 `2fe47f6` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `2fe47f6` 的实施步骤

## 1. 核对目标身份与实现范围

命令：

git show --stat 2fe47f6e46a3add0a3ee9bdd57bda9feac2220a7

逐项目标确认完整 SHA、subject 和实际变更文件，防止把直接父提交 f355de1 误写为文档对象。

## 2. 写入目标 SPEC 与 PLAN

为 2fe47f6e46a3add0a3ee9bdd57bda9feac2220a7 创建 `docs/specs/2fe47f6-SPEC.md` 和 `docs/plans/2fe47f6-PLAN.md`。frontmatter 使用该完整 SHA；正文只覆盖 4 files changed, 80 insertions(+), 1 deletion(-)，代表路径包括 `docs/INDEX.md`、`docs/plans/7ca78c1-PLAN.md`、`docs/specs/7ca78c1-SPEC.md`、`docs/status/index.json`。

SPEC 说明该目标提交的实际设计范围；PLAN 按目标 diff 列出文件级实施顺序。不要用当前 finalization 提交的主题替换目标实现内容。

## 3. 同步 INDEX 与 JSON

在 self 前为 `2fe47f6` 增加历史链接，并同步 `docs/status/index.json` 的 fullSha、date、subject、status、spec、plan 字段。按新增目标数量更新状态计数，保持 self 位于末尾。

## 4. 验收

test -f docs/specs/2fe47f6-SPEC.md
test -f docs/plans/2fe47f6-PLAN.md

用 JSON 解析确认 `2fe47f6` 各有一个对象，spec/plan 路径有效且 fullSha 与上述完整 SHA 一致；再检查 INDEX 链接、self 条目和文件清单。
