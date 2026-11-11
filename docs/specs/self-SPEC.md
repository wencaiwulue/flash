---
commit: self
changeId: commit-docs-bootstrap
title: "Document commit specifications and plans"
status: implemented
---

# Document commit specifications and plans

## Background and requirements

为每个提交提供独立 SPEC、PLAN 和实现状态，保留真实变更范围、验证证据与未实现边界。

## Actual scope

- scripts/document-commits.ts generates per-commit SPEC and PLAN files.
- scripts/check-commit-docs.ts verifies every record and link.
- .github/workflows/ci.yml uses full history for validation.

## Protocol, dependencies, and security

状态只描述实现，不将 mock 通过冒充 live 验证；文档不得包含凭据或私有配置。

## Acceptance and verification

运行 bun scripts/check-commit-docs.ts、全量测试、typecheck、build 和 CI 完整性检查。

## Remaining / unimplemented boundaries

OAuth/Cloud 与原生桌面验证仍按环境单独记录，不影响 commit 实现状态。
