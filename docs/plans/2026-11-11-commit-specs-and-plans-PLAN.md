---
commit: 587c466f7e28e4cb59b0c4522857a7110e7b152a
title: 逐提交文档生成体系的实施顺序
date: 2026-11-11
retrospective: true
---

# 逐提交文档生成体系的实施顺序

## 1. 实现 Git 元数据与详情模型

**文件：** `scripts/document-commits.ts`。

定义 Commit/Details，使用 git log --reverse 解析 full/short/date/subject。实现 DETAILS 定制表、fallback、statusFor，以及读取 diff 文件名和 shortstat 的 specFor/planFor。

## 2. 实现 self 与两个索引

用 COMMIT_DOC_ID/SUBJECT 和 SELF_DETAILS 生成 self SPEC/PLAN。buildCommitDocuments 返回 Map<path,content>，同时生成历史、self、INDEX 和 status JSON。writer 只负责逐路径 mkdir/write。

## 3. 实现 checker 与 CI

`check-commit-docs.ts` 调 buildCommitDocuments，将每个期望路径与实际文本比较，报告 missing/outdated。package.json 增加 docs:generate/docs:check，CI 使用完整历史并运行 checker。

## 4. 编写政策与模板

`docs/COMMIT_DOCS.md` 规定历史记录、self、后续固化和 CI；`docs/specs/template.md`、`docs/plans/template.md` 只作为结构参考。

## 5. 验收

```bash
bun scripts/document-commits.ts
bun scripts/check-commit-docs.ts
```

额外抽查根提交 partial、普通提交 metadata、self changeId、INDEX 计数和 JSON 路径；同时审查 DETAILS 未覆盖提交的 fallback，不能把通用正文当成完成内容设计。
