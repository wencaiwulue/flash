---
commit: 587c466f7e28e4cb59b0c4522857a7110e7b152a
title: 建立逐提交 SPEC/PLAN 生成与校验体系
date: 2026-11-11
retrospective: true
---

# 建立逐提交 SPEC/PLAN 生成与校验体系

## 生成模型

`document-commits.ts` 从 `git log --reverse` 读取 full/short SHA、日期和 subject，为每个历史提交生成 SPEC、PLAN、INDEX 行和 JSON 对象。`specFor()`/`planFor()` 同时读取提交 diff 文件名与 shortstat，根提交 `4b9d30f` 标为 partial，其余默认 implemented。

`DETAILS` 为部分提交提供定制 requirements/security/verification/remaining；未定制项使用通用 fallback。这个 fallback 是该设计的已知内容边界：结构完整不等于设计正文充分。

## self 与索引

当前工作使用固定 `self-SPEC.md` 和 `self-PLAN.md`，由 `COMMIT_DOC_ID`、`COMMIT_DOC_SUBJECT` 提供 changeId/title。self 用于回避“在 commit 自身树中写入最终 SHA 会改变 SHA”的递归问题。

`docs/INDEX.md` 汇总 implemented/partial/unimplemented 计数和链接，`docs/status/index.json` 保存 fullSha、日期、subject、status、spec/plan 路径。两个模板规定结构，checker 比较磁盘文件与生成器期望。

## CI 与维护流程

package scripts 提供 docs:generate/docs:check，CI checkout 使用完整历史并运行 checker。`docs/COMMIT_DOCS.md` 规定每 commit 独立 SPEC/PLAN、self 记录和后续固化方式。

## 验收标准

1. 每个选定历史提交都有对应 SPEC/PLAN，frontmatter 与 Git metadata 一致。
2. INDEX、JSON、状态计数和文件路径一致，self 使用 changeId 而非伪造 full SHA。
3. checker 对缺失或过期生成物失败，模板不被当作独立提交内容。
4. DETAILS fallback 的通用性被明确记录，不能仅凭生成数量认定设计质量。
