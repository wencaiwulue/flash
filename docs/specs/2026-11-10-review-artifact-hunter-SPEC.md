---
commit: 0b6806800508a15c7a5f8293c572b8fa5c960d24
title: 独立 ReviewArtifact 与 Hunter 评审设计
date: 2026-11-10
retrospective: true
---

# 独立 ReviewArtifact 与 Hunter 评审设计

## 输入与权限

ReviewArtifact 要求 artifact_path 与 inline content 必须二选一。文件读取复用 FileReadTool.checkPermissions，lstat 要求普通文件；文件和 inline 内容都限制 1 MB。路径相对当前 cwd 解析。

输出 schema 为 summary 和 findings；每个 finding 包含 blocker/warning/nit、title、description、可选 file_path/line/verification，以及默认 unverified 的 status。

## 独立 reviewer

`defaultReviewer()` 使用独立 runAgent，只提供 Read/Grep/Glob，system prompt 明确只读、不得修改文件、只报告有依据的问题，最多 8 turns。最后一段 assistant 文本必须非空，否则抛错。

`parseReviewerOutput()` 从首个 `{` 到最后 `}` 提取 JSON，再由 Zod 校验；无 JSON 或 schema 不符都失败，不能把普通文本包装成评审结论。

prompt 将 artifact 放入 `<artifact>`，并附 focus、intended requirements 和规则：blocker 需要具体依据，未验证项标 unverified，无问题返回空 findings，不能编造通过结果或问题。

## Hunter 技能

`/hunter` 是 user-invocable bundled prompt，要求先收集 artifact 与预期行为，再调用 ReviewArtifact 做独立只读评审。它不让 artifact 作者给自己的实现评分，并把 verified findings 与 unverified concerns 分开；可执行聚焦验证时，报告实际执行范围。

构建添加 `REVIEW_ARTIFACT`，tools registry 与 bundled skills 分别接入。

## 验收标准

1. 两种输入互斥，FileRead 权限、普通文件和 1 MB 限制生效。
2. reviewer 工具集只含 Read/Grep/Glob，prompt 包含 artifact、focus 和 requirements，保持只读。
3. JSON 提取、schema、默认 unverified、空 findings 和空响应错误正确。
4. `/hunter` 注册为用户可调用技能，并明确独立评审与验证边界。
5. `reviewArtifact.test.ts` 覆盖输入、prompt、文件读取、超限、畸形输出和技能注册；feature-profile 覆盖工具与技能。
