---
commit: self
changeId: manual-commit-design-rewrite
title: "Rewrite every commit design and implementation document"
date: 2026-11-11
status: implemented
kind: metadata-migration
retrospective: true
---

# 全量重写 commit 设计与实施文档

## 目标与范围

将 95 个历史提交的 SPEC/PLAN 全部改为依据 parent/current revision 独立编写的文档，使用日期+功能命名，并保留当前工作的 self 记录。旧生成正文、结构化 evidence 和通用实施步骤不再作为内容来源。

## 内容原则

真实功能提交描述控制流、接口、失败语义、文件级实施顺序和可执行验收；元数据提交只描述实际身份迁移、索引和 self，不硬套产品架构。大型快照不虚构开发顺序，状态提交只描述文档变化，不保存历史执行结果。

## 索引器设计

`manual.ts` 从人工文档 frontmatter 读取 full SHA、日期、状态和 slug，检查 SPEC/PLAN 配对、日期、序号、self 和禁用套话，再生成 INDEX 与 JSON。writer 只更新索引，不重写人工 SPEC/PLAN；checker 只读比较索引。

head 模式覆盖祖先+self，next 模式额外覆盖当前 HEAD。历史文件采用 `YYYY-MM-DD-feature-slug`，同日同功能使用 -02/-03 等稳定后缀。

## 验收标准

1. 当前 95 个历史提交各有唯一 SPEC/PLAN，self 另有一对，full SHA 无缺失或重复。
2. 文件名、日期、slug、同日序号、frontmatter 和索引路径一致。
3. 文档不含验证证据章节、旧通用步骤或历史执行结果。
4. 索引器不重写正文，next/head 与重复生成保持幂等，语义审查独立于结构检查。
