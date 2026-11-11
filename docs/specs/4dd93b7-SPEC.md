---
commit: 4dd93b75220926cefbe9d5d017224238bfd8e0f1
title: "Re-register live validation workflow"
date: 2026-11-11T09:23:48+08:00
status: implemented
---

# Re-register live validation workflow

## Background and requirements

Re-register live validation workflow。保持现有 CLI/SDK 接口、feature gating 与权限边界，完成该提交对应的实现、修复或文档工作。

## Actual scope

- Changed files: 1
- Diff statistics: 1 file changed, 0 insertions(+), 0 deletions(-)

```text
.github/workflows/live-checks.yml
```

## Protocol, dependencies, and security

不引入新的凭据、私有协议或绕过现有权限的行为。

## Acceptance and verification

bun test、bun run typecheck、bun run build 及对应 CI 检查。

## Remaining / unimplemented boundaries

无该提交范围内的未实现项。
