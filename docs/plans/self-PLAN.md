---
commit: self
changeId: manual-commit-design-rewrite
title: "Rewrite every commit design and implementation document"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 全量重写文档的实施计划

## 1. 独立撰写历史文档

按基础恢复、运行时工具、CI/状态和元数据分组，逐提交读取 parent/current diff、实现和测试。文件命名使用提交日期+显式功能 slug，同日同功能按 topo 顺序编号。

根快照只还原单根 tree 的形成方式；功能提交写具体实现与验收；finalization 提交写真实目标 SHA、目标 diff 和索引迁移。

## 2. 实现人工文档索引器

创建 `scripts/commit-docs/manual.ts`：读取 SPEC/PLAN frontmatter，校验 full SHA、日期、slug、配对、序号、self 和禁用套话，再输出 INDEX/status JSON。重写 `document-commits.ts` 仅写索引，`check-commit-docs.ts` 仅做只读比较。

## 3. 替换旧正文与过期结构

用独立撰写的 95 对文档替换旧 SHA 文件，并加入本 self。删除旧结构化 records、schema/load/validate/render 及旧测试，防止旧生成器恢复通用正文；保留 git.ts 的只读历史功能。

## 4. 更新维护契约与验收

更新 COMMIT_DOCS、SPEC/PLAN 模板和 commitDocs 测试。验证历史覆盖、同日序号、错误日期/SHA/配对、孤儿文档、head/next 和索引幂等，再运行 typecheck、全量测试、build 和 diff 检查。

## 5. 交付

人工抽查各类型代表文档，确认没有批量套话或虚构设计后原子提交。推送前再次检查工作树和文档清单，再创建 PR。
