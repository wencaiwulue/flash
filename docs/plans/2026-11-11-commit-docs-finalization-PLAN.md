---
commit: c4e19cee451ce0a5a43e78475d40f2e079b350df
title: "固化 `587c466` 的历史文档"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 固化 `587c466` 的实施步骤

## 1. 核对目标身份与实现范围

命令：

git show --stat 587c466f7e28e4cb59b0c4522857a7110e7b152a

逐项目标确认完整 SHA、subject 和实际变更文件，防止把直接父提交 8117aaa 误写为文档对象。

## 2. 写入目标 SPEC 与 PLAN

为 587c466f7e28e4cb59b0c4522857a7110e7b152a 创建 `docs/specs/587c466-SPEC.md` 和 `docs/plans/587c466-PLAN.md`。frontmatter 使用该完整 SHA；正文只覆盖 95 files changed, 6620 insertions(+)，代表路径包括 `.github/workflows/ci.yml`、`docs/COMMIT_DOCS.md`、`docs/INDEX.md`、`docs/RELEASE.md`。

SPEC 说明该目标提交的实际设计范围；PLAN 按目标 diff 列出文件级实施顺序。不要用当前 finalization 提交的主题替换目标实现内容。

## 3. 同步 INDEX 与 JSON

在 self 前为 `587c466` 增加历史链接，并同步 `docs/status/index.json` 的 fullSha、date、subject、status、spec、plan 字段。按新增目标数量更新状态计数，保持 self 位于末尾。

## 4. 验收

test -f docs/specs/587c466-SPEC.md
test -f docs/plans/587c466-PLAN.md

用 JSON 解析确认 `587c466` 各有一个对象，spec/plan 路径有效且 fullSha 与上述完整 SHA 一致；再检查 INDEX 链接、self 条目和文件清单。
