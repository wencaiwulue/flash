---
commit: self
changeId: commit-docs-bootstrap
title: "Document commit specifications and plans"
status: implemented
---

# Implementation plan: Document commit specifications and plans

## Objective

为每个提交提供独立 SPEC、PLAN 和实现状态，保留真实变更范围、验证证据与未实现边界。

## Implementation steps

1. 按 git 历史生成每个提交的 SPEC 与 PLAN。
2. 建立人类可读和机器可读状态索引及 self 约定。
3. 在基础 CI 中检查所有提交文档完整、有效且与 SHA 对齐。

## Risks and mitigations

状态只描述实现，不将 mock 通过冒充 live 验证；文档不得包含凭据或私有配置。

## Verification sequence

运行 bun scripts/check-commit-docs.ts、全量测试、typecheck、build 和 CI 完整性检查。

## Completion status and remaining work

- Status: **implemented**
- Remaining: OAuth/Cloud 与原生桌面验证仍按环境单独记录，不影响 commit 实现状态。
