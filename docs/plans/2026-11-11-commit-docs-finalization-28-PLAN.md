---
commit: 787b2dcef6629be82036283cc709384b56e6d981
title: "固化 `96283ae` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `96283ae` 的实施步骤

## 1. 核对目标身份与实现范围

命令：

git show --stat 96283aecc10afd0f0269eff9b7a3b0c543191b01

逐项目标确认完整 SHA、subject 和实际变更文件，防止把直接父提交 b6bf982 误写为文档对象。

## 2. 写入目标 SPEC 与 PLAN

为 96283aecc10afd0f0269eff9b7a3b0c543191b01 创建 `docs/specs/96283ae-SPEC.md` 和 `docs/plans/96283ae-PLAN.md`。frontmatter 使用该完整 SHA；正文只覆盖 4 files changed, 78 insertions(+), 1 deletion(-)，代表路径包括 `docs/INDEX.md`、`docs/plans/612cc40-PLAN.md`、`docs/specs/612cc40-SPEC.md`、`docs/status/index.json`。

SPEC 说明该目标提交的实际设计范围；PLAN 按目标 diff 列出文件级实施顺序。不要用当前 finalization 提交的主题替换目标实现内容。

## 3. 同步 INDEX 与 JSON

在 self 前为 `96283ae` 增加历史链接，并同步 `docs/status/index.json` 的 fullSha、date、subject、status、spec、plan 字段。按新增目标数量更新状态计数，保持 self 位于末尾。

## 4. 验收

test -f docs/specs/96283ae-SPEC.md
test -f docs/plans/96283ae-PLAN.md

用 JSON 解析确认 `96283ae` 各有一个对象，spec/plan 路径有效且 fullSha 与上述完整 SHA 一致；再检查 INDEX 链接、self 条目和文件清单。
