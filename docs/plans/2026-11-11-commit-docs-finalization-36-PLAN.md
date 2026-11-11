---
commit: 8a248e3a57a3121e5e0bfeb7dbdeefb1551ac9b3
title: "固化 `a4edc60` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `a4edc60` 的实施步骤

## 1. 核对目标身份与实现范围

命令：

git show --stat a4edc60de4da2600197f59e1b032d5e4a754e19b

逐项目标确认完整 SHA、subject 和实际变更文件，防止把直接父提交 e0cbbe1 误写为文档对象。

## 2. 写入目标 SPEC 与 PLAN

为 a4edc60de4da2600197f59e1b032d5e4a754e19b 创建 `docs/specs/a4edc60-SPEC.md` 和 `docs/plans/a4edc60-PLAN.md`。frontmatter 使用该完整 SHA；正文只覆盖 4 files changed, 78 insertions(+), 1 deletion(-)，代表路径包括 `docs/INDEX.md`、`docs/plans/dc3f075-PLAN.md`、`docs/specs/dc3f075-SPEC.md`、`docs/status/index.json`。

SPEC 说明该目标提交的实际设计范围；PLAN 按目标 diff 列出文件级实施顺序。不要用当前 finalization 提交的主题替换目标实现内容。

## 3. 同步 INDEX 与 JSON

在 self 前为 `a4edc60` 增加历史链接，并同步 `docs/status/index.json` 的 fullSha、date、subject、status、spec、plan 字段。按新增目标数量更新状态计数，保持 self 位于末尾。

## 4. 验收

test -f docs/specs/a4edc60-SPEC.md
test -f docs/plans/a4edc60-PLAN.md

用 JSON 解析确认 `a4edc60` 各有一个对象，spec/plan 路径有效且 fullSha 与上述完整 SHA 一致；再检查 INDEX 链接、self 条目和文件清单。
