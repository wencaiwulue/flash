---
commit: 2ff078cf60517f6aafe5e8fd542e2369334c17e3
title: "Document remote control and Cloud verification"
date: 2026-11-10T15:56:54+08:00
status: implemented
---

# Document remote control and Cloud verification

## Background and requirements

Document remote control and Cloud verification。保持现有 CLI/SDK 接口、feature gating 与权限边界，完成该提交对应的实现、修复或文档工作。

## Actual scope

- Changed files: 1
- Diff statistics: 1 file changed, 5 insertions(+)

```text
docs/RELEASE.md
```

## Protocol, dependencies, and security

不引入新的凭据、私有协议或绕过现有权限的行为。

## Acceptance and verification

bun test、bun run typecheck、bun run build 及对应 CI 检查。

## Remaining / unimplemented boundaries

无该提交范围内的未实现项。
