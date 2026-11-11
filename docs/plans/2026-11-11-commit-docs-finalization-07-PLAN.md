---
commit: 7ca78c1a18a7f05e1740f701b256079bb4cc2c2e
title: "固化 `63e138f`、`fe3c177` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `63e138f`、`fe3c177` 的实施步骤

## 1. 核对目标身份与实现范围

命令：

git show --stat 63e138f4eb8ea207a1aeb0806e060275ac55b4a3
git show --stat fe3c177c28b7581e93f7496c58b98bafa10dbb03

逐项目标确认完整 SHA、subject 和实际变更文件，防止把直接父提交 80e6def 误写为文档对象。

## 2. 写入目标 SPEC 与 PLAN

为 63e138f4eb8ea207a1aeb0806e060275ac55b4a3 创建 `docs/specs/63e138f-SPEC.md` 和 `docs/plans/63e138f-PLAN.md`。frontmatter 使用该完整 SHA；正文只覆盖 4 files changed, 78 insertions(+), 1 deletion(-)，代表路径包括 `docs/INDEX.md`、`docs/plans/7740a1d-PLAN.md`、`docs/specs/7740a1d-SPEC.md`、`docs/status/index.json`。

为 fe3c177c28b7581e93f7496c58b98bafa10dbb03 创建 `docs/specs/fe3c177-SPEC.md` 和 `docs/plans/fe3c177-PLAN.md`。frontmatter 使用该完整 SHA；正文只覆盖 4 files changed, 78 insertions(+), 1 deletion(-)，代表路径包括 `docs/INDEX.md`、`docs/plans/f210ce9-PLAN.md`、`docs/specs/f210ce9-SPEC.md`、`docs/status/index.json`。

SPEC 说明该目标提交的实际设计范围；PLAN 按目标 diff 列出文件级实施顺序。不要用当前 finalization 提交的主题替换目标实现内容。

## 3. 同步 INDEX 与 JSON

在 self 前为 `63e138f`、`fe3c177` 增加历史链接，并同步 `docs/status/index.json` 的 fullSha、date、subject、status、spec、plan 字段。按新增目标数量更新状态计数，保持 self 位于末尾。

## 4. 验收

test -f docs/specs/63e138f-SPEC.md
test -f docs/plans/63e138f-PLAN.md
test -f docs/specs/fe3c177-SPEC.md
test -f docs/plans/fe3c177-PLAN.md

用 JSON 解析确认 `63e138f`、`fe3c177` 各有一个对象，spec/plan 路径有效且 fullSha 与上述完整 SHA 一致；再检查 INDEX 链接、self 条目和文件清单。
